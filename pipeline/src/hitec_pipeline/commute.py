"""Estimated commute from each society for the home finder.

Everything here is an estimate built from open data, never a prediction:
- Roads: our own graph from the OpenStreetMap ways already downloaded for the map. One-way streets
  are respected; private roads (gated societies, campuses) and tracks are left out. Long segments
  get a point every MAX_SEG_M so a road passing a boundary is found, and only the main connected
  network is used (stray islands of road would give "no time" everywhere).
- Speeds: an assumed free-flow speed per road class (SPEED_KMH). There is no traffic data, so the
  app must call these "no traffic" times.
- Leaving home: we do not know a society's gates, so a trip starts at any public road point within
  GATE_M of its boundary (motorways excluded).
- Workplaces: cells of CELL_M on a UTM grid over the strip. A cell's time is the time to the nearest
  reachable road point within SNAP_M of its centre, plus that last stretch at ACCESS_KMH. Cells with
  no road point that close get no time.
- Metro: station locations from OpenStreetMap (railway=station tagged as Hyderabad Metro). Ride
  times need the official timetable (GTFS), which is not included yet.
"""

from __future__ import annotations

import base64
import heapq
import json
import math
import re
import sys
from array import array
from dataclasses import dataclass, field

from . import DATA_ROOT

SPEED_KMH = {
    "motorway": 60, "motorway_link": 40, "trunk": 45, "trunk_link": 35, "primary": 35, "primary_link": 30,
    "secondary": 30, "secondary_link": 25, "tertiary": 25, "tertiary_link": 20, "unclassified": 20,
    "road": 18, "residential": 18, "living_street": 10, "service": 12,
}
NO_GATE = ("motorway", "motorway_link")
GATE_M, CELL_M, SNAP_M, ACCESS_KMH = 60.0, 250.0, 500.0, 10.0
MAX_SEG_M = 30.0
SNAP_CANDIDATES = 6
NONE_MIN, NONE_HM = 255, 65535  # "no time" / "no distance" in the packed arrays
PLACES_OSM = DATA_ROOT / "raw" / "hitec-city" / "places_osm.json"


def drivable(tags: dict) -> float | None:
    """Assumed speed in km/h for a road a car may use, else None."""
    speed = SPEED_KMH.get(tags.get("highway", ""))
    if speed is None:
        return None
    if tags.get("access") in ("private", "no", "military") and tags.get("motor_vehicle") not in ("yes", "designated"):
        return None
    if tags.get("motor_vehicle") in ("no", "private") or tags.get("motorcar") in ("no", "private"):
        return None
    if tags.get("service") in ("parking_aisle", "drive-through"):
        return None
    return float(speed)


def direction(tags: dict) -> int:
    """1 forward only, -1 backward only, 0 both ways."""
    ow = tags.get("oneway")
    if ow in ("yes", "true", "1"):
        return 1
    if ow == "-1":
        return -1
    if ow == "no":
        return 0
    if tags.get("junction") in ("roundabout", "circular") or tags.get("highway") in ("motorway", "motorway_link"):
        return 1
    return 0


@dataclass
class Graph:
    index: dict[int, int] = field(default_factory=dict)  # OSM node id -> graph index
    x: list[float] = field(default_factory=list)  # UTM metres
    y: list[float] = field(default_factory=list)
    gate: list[bool] = field(default_factory=list)  # on a public road a trip may start from
    adj: list[list[tuple[int, float, float]]] = field(default_factory=list)  # (to, seconds, metres)

    def add(self, x: float, y: float) -> int:
        self.x.append(x)
        self.y.append(y)
        self.gate.append(False)
        self.adj.append([])
        return len(self.x) - 1

    def node(self, osm_id: int, x: float, y: float) -> int:
        i = self.index.get(osm_id)
        if i is None:
            i = self.index[osm_id] = self.add(x, y)
        return i


def build_graph(elements, to_utm) -> Graph:
    """The drivable road graph from OSM ways with `nodes` and `geometry` (as Overpass `out geom` gives)."""
    g = Graph()
    for el in elements:
        if el["type"] != "way" or "highway" not in (el.get("tags") or {}):
            continue
        t = el["tags"]
        kmh = drivable(t)
        geom, ids = el.get("geometry") or [], el.get("nodes") or []
        if kmh is None or len(ids) < 2 or len(ids) != len(geom) or any(p is None for p in geom):
            continue
        xs, ys = to_utm([p["lon"] for p in geom], [p["lat"] for p in geom])
        osm = [g.node(n, x, y) for n, x, y in zip(ids, xs, ys)]
        seq = osm[:1]
        for a, b in zip(osm, osm[1:]):  # a point every MAX_SEG_M along long segments
            k = int(math.hypot(g.x[b] - g.x[a], g.y[b] - g.y[a]) // MAX_SEG_M)
            for j in range(1, k + 1):
                f = j / (k + 1)
                seq.append(g.add(g.x[a] + (g.x[b] - g.x[a]) * f, g.y[a] + (g.y[b] - g.y[a]) * f))
            seq.append(b)
        way = direction(t)
        mps = kmh / 3.6
        for a, b in zip(seq, seq[1:]):
            m = math.hypot(g.x[b] - g.x[a], g.y[b] - g.y[a])
            if way >= 0:
                g.adj[a].append((b, m / mps, m))
            if way <= 0:
                g.adj[b].append((a, m / mps, m))
        if t["highway"] not in NO_GATE:
            for n in seq:
                g.gate[n] = True
    return g


def _reach(adj: list[list[tuple[int, float, float]]], start: int) -> list[bool]:
    seen = [False] * len(adj)
    seen[start] = True
    stack = [start]
    while stack:
        u = stack.pop()
        for v, _, _ in adj[u]:
            if not seen[v]:
                seen[v] = True
                stack.append(v)
    return seen


def main_network(g: Graph) -> list[bool]:
    """Nodes in the largest part of the network where every node can reach every other.

    Found from a well-connected node near the middle: what it reaches and what reaches it.
    """
    if not g.x:
        return []
    cx, cy = sum(g.x) / len(g.x), sum(g.y) / len(g.y)
    order = sorted(range(len(g.x)), key=lambda i: math.hypot(g.x[i] - cx, g.y[i] - cy))
    radj: list[list[tuple[int, float, float]]] = [[] for _ in g.x]
    for u, edges in enumerate(g.adj):
        for v, sec, m in edges:
            radj[v].append((u, sec, m))
    best = [False] * len(g.x)
    for start in order[:50]:
        fwd = _reach(g.adj, start)
        if sum(fwd) * 2 < len(g.x):
            continue
        back = _reach(radj, start)
        both = [a and b for a, b in zip(fwd, back)]
        if sum(both) > sum(best):
            best = both
        if sum(best) * 2 >= len(g.x):
            break
    return best


def dijkstra(g: Graph, sources: list[int]) -> tuple[list[float], list[float]]:
    """Fastest time (s) from any source to every node, and the length (m) of that fastest route."""
    inf = math.inf
    t, d = [inf] * len(g.x), [inf] * len(g.x)
    heap = []
    for s in sources:
        t[s], d[s] = 0.0, 0.0
        heap.append((0.0, s))
    heapq.heapify(heap)
    while heap:
        ts, u = heapq.heappop(heap)
        if ts > t[u]:
            continue
        du = d[u]
        for v, sec, m in g.adj[u]:
            nt = ts + sec
            if nt < t[v]:
                t[v], d[v] = nt, du + m
                heapq.heappush(heap, (nt, v))
    return t, d


class NodeIndex:
    """Bucketed lookup of graph nodes near a point (only the nodes in `keep`, when given)."""

    def __init__(self, g: Graph, keep: list[bool] | None = None, bucket: float = 100.0):
        self.g, self.b = g, bucket
        self.cells: dict[tuple[int, int], list[int]] = {}
        for i, (x, y) in enumerate(zip(g.x, g.y)):
            if keep is None or keep[i]:
                self.cells.setdefault((int(x // bucket), int(y // bucket)), []).append(i)

    def nearest(self, x: float, y: float, k: int, radius: float) -> list[tuple[float, int]]:
        """Up to k nodes within `radius`, nearest first (searching outwards so dense areas stay fast)."""
        r = min(self.b, radius)
        while True:
            found = self.near(x, y, r)
            if len(found) >= k or r >= radius:
                return found[:k]
            r = min(r * 2.5, radius)

    def near(self, x: float, y: float, radius: float) -> list[tuple[float, int]]:
        r = int(radius // self.b) + 1
        cx, cy = int(x // self.b), int(y // self.b)
        out = []
        for i in range(cx - r, cx + r + 1):
            for j in range(cy - r, cy + r + 1):
                for n in self.cells.get((i, j), ()):
                    dist = math.hypot(self.g.x[n] - x, self.g.y[n] - y)
                    if dist <= radius:
                        out.append((dist, n))
        out.sort()
        return out


def gates(g: Graph, idx: NodeIndex, area) -> list[int]:
    """Public road points within GATE_M of a society boundary (the nearest one if none is that close)."""
    import shapely

    c = area.centroid
    reach = math.hypot(area.bounds[2] - area.bounds[0], area.bounds[3] - area.bounds[1]) / 2 + GATE_M
    cand = [n for _, n in idx.near(c.x, c.y, reach) if g.gate[n]]
    if cand:
        pts = shapely.points([g.x[n] for n in cand], [g.y[n] for n in cand])
        dist = shapely.distance(area, pts)
        close = [n for n, dd in zip(cand, dist) if dd <= GATE_M]
        if close:
            return close
    near = [(dd, n) for dd, n in idx.near(c.x, c.y, reach + 500) if g.gate[n]]
    return [near[0][1]] if near else []


def grid_for(bbox, to_utm) -> dict:
    """The workplace grid: UTM cells of CELL_M covering the lon/lat bbox."""
    w, s, e, n = bbox
    xs, ys = to_utm([w, e, w, e], [s, s, n, n])
    e0, n0 = math.floor(min(xs) / CELL_M) * CELL_M, math.floor(min(ys) / CELL_M) * CELL_M
    cols = math.ceil((max(xs) - e0) / CELL_M)
    rows = math.ceil((max(ys) - n0) / CELL_M)
    return {"crs": "EPSG:32644", "origin_e": e0, "origin_n": n0, "cell_m": CELL_M, "cols": cols, "rows": rows,
            "order": "row-major from the south-west corner"}


def snap_cells(g: Graph, idx: NodeIndex, grid: dict) -> list[list[tuple[float, int]]]:
    out = []
    for r in range(grid["rows"]):
        for c in range(grid["cols"]):
            x = grid["origin_e"] + (c + 0.5) * CELL_M
            y = grid["origin_n"] + (r + 0.5) * CELL_M
            out.append(idx.nearest(x, y, SNAP_CANDIDATES, SNAP_M))
    return out


def cell_times(t: list[float], d: list[float], snaps) -> tuple[bytes, bytes]:
    """Packed minutes (uint8) and route length in hectometres (uint16 LE) per cell."""
    mins, hm = array("B"), array("H")
    for cand in snaps:
        best = next(((dd, n) for dd, n in cand if t[n] < math.inf), None)
        if best is None:
            mins.append(NONE_MIN)
            hm.append(NONE_HM)
            continue
        dd, n = best
        sec = t[n] + dd / (ACCESS_KMH / 3.6)
        mins.append(min(NONE_MIN - 1, math.ceil(sec / 60)))
        hm.append(min(NONE_HM - 1, round((d[n] + dd) / 100)))
    if hm.itemsize != 2:
        raise RuntimeError("uint16 array expected")
    if sys.byteorder != "little":
        hm.byteswap()
    return mins.tobytes(), hm.tobytes()


def _norm_station(name: str) -> str:
    return re.sub(r"\b(metro|station|rly|railway)\b", "", name.lower()).strip()


def metro_stations(path=PLACES_OSM, bbox=None) -> list[dict]:
    """Hyderabad Metro stations from OpenStreetMap, one per name (the tagged network wins)."""
    els = json.loads(path.read_text(encoding="utf-8"))["elements"]
    found: dict[str, dict] = {}
    for e in els:
        t = e.get("tags") or {}
        metro = "metro" in (t.get("network") or "").lower() or t.get("station") in ("subway", "Metro") or t.get("subway") == "yes"
        if t.get("railway") != "station" or not metro or not t.get("name"):
            continue
        lat = e.get("lat", (e.get("center") or {}).get("lat"))
        lon = e.get("lon", (e.get("center") or {}).get("lon"))
        if lat is None or (bbox and not (bbox[0] <= lon <= bbox[2] and bbox[1] <= lat <= bbox[3])):
            continue
        key = _norm_station(t["name"])
        tagged = "metro" in (t.get("network") or "").lower()
        rec = {"id": f"{e['type'][0]}{e['id']}", "name": t["name"], "lat": round(lat, 6), "lon": round(lon, 6),
               "tagged": tagged, "node": e["type"] == "node"}
        old = found.get(key)
        if old is None or (tagged, rec["node"]) > (old["tagged"], old["node"]):
            found[key] = rec
    return [{k: v for k, v in s.items() if k not in ("tagged", "node")} for s in sorted(found.values(), key=lambda s: s["name"])]


def compute(areas: dict, elements, to_utm, stations: list[dict], bbox) -> dict:
    """Commute data for the societies (UTM geometries). Returns per-society metro facts and the grid file."""
    import shapely

    g = build_graph(elements, to_utm)
    main = main_network(g)
    idx = NodeIndex(g, main)
    grid = grid_for(bbox, to_utm)
    snaps = snap_cells(g, idx, grid)
    sx, sy = to_utm([s["lon"] for s in stations], [s["lat"] for s in stations]) if stations else ([], [])
    st_snap = [idx.nearest(x, y, SNAP_CANDIDATES, SNAP_M) for x, y in zip(sx, sy)]
    st_pts = shapely.points(list(sx), list(sy)) if stations else None
    per, packed = {}, {}
    for sid, area in areas.items():
        src = gates(g, idx, area)
        t, d = dijkstra(g, src) if src else ([math.inf] * len(g.x), [math.inf] * len(g.x))
        mins, hm = cell_times(t, d, snaps)
        packed[sid] = {"minutes": base64.b64encode(mins).decode(), "hm": base64.b64encode(hm).decode(),
                       "gates": len(src)}
        metro = None
        if stations:
            dist = shapely.distance(area, st_pts)
            k = int(dist.argmin())
            drive = cell_times(t, d, [st_snap[k]])
            m = drive[0][0]
            metro = {"id": stations[k]["id"], "name": stations[k]["name"], "m": int(round(float(dist[k]), -1)),
                     "drive_min": None if m == NONE_MIN else m}
        per[sid] = {"metro": metro}
    return {
        "societies": per,
        "file": {
            "method": {"speeds_kmh": SPEED_KMH, "gate_m": GATE_M, "snap_m": SNAP_M, "access_kmh": ACCESS_KMH,
                       "traffic": "none: assumed free-flow speeds per road class",
                       "missing": {"minutes": NONE_MIN, "hm": NONE_HM}},
            "grid": grid,
            "graph": {"nodes": len(g.x), "main_network": sum(main), "edges": sum(len(a) for a in g.adj)},
            "stations": stations,
            "societies": packed,
        },
    }
