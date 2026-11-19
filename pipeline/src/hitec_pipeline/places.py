"""The citywide place index for search: localities, landmarks, transit, campuses, streets, named
buildings and more, from OpenStreetMap.

Inputs: every block's osm.json (already downloaded for the art) plus one extra download of the
features the art does not need (place names, tourism, historic sites, stations): places_osm.json.
Named OSM buildings are tied to the map's own building ids, so search can outline them.

Output: web/public/data/places.json, compact rows the app loads when search is first used.
"""

from __future__ import annotations

import glob
import json
import re
import sys
from datetime import UTC, datetime
from pathlib import Path

import numpy as np

from . import DATA_ROOT
from .area import to_utm

OUT = Path(__file__).resolve().parents[3] / "web" / "public" / "data" / "places.json"

CATEGORIES = {
    "locality": "Localities",
    "landmark": "Landmarks",
    "transit": "Transit",
    "campus": "Business areas",
    "office": "Offices (OpenStreetMap)",
    "education": "Education",
    "health": "Hospitals",
    "shopping": "Shopping",
    "park": "Parks & lakes",
    "civic": "Government & civic",
    "worship": "Places of worship",
    "street": "Streets",
    "building": "Buildings",
}
PLACE_TYPES = {"city", "town", "suburb", "neighbourhood", "quarter", "village", "hamlet", "locality"}
CONTEXT_TYPES = {"town", "suburb", "neighbourhood", "quarter", "village"}  # what "· Banjara Hills" refers to
MAJOR_AREAS = {"town", "suburb"}  # preferred over the nearest small neighbourhood
TOURISM = {"attraction", "museum", "viewpoint", "zoo", "theme_park", "gallery", "aquarium"}
ALT_KEYS = ("alt_name", "short_name", "official_name", "old_name", "name:en")  # other names people search by
NO_STREET = {"footway", "path", "steps", "cycleway", "track", "bridleway", "corridor", "platform", "proposed",
             "construction", "service", "pedestrian", "elevator"}


def _raw() -> Path:
    from .tiles import AREA

    return DATA_ROOT / "raw" / AREA.name


def fetch_extra(force: bool = False) -> Path:
    """Place names, landmarks and stations for the whole city box (not needed by the art)."""
    from .fetch import _overpass, _record, _sha256
    from .tiles import CITY_WSEN

    out = _raw() / "places_osm.json"
    if out.exists() and not force:
        return out
    w, s, e, n = CITY_WSEN
    bb = f"({s},{w},{n},{e})"
    query = f"""[out:json][timeout:300];
(
  node[place~"^({'|'.join(sorted(PLACE_TYPES))})$"]{bb};
  nwr[tourism~"^({'|'.join(sorted(TOURISM))})$"]{bb};
  nwr[historic][name]{bb};
  nwr[railway~"^(station|halt)$"]{bb};
  nwr[public_transport=station]{bb};
  nwr[aeroway=aerodrome]{bb};
);
out center tags qt;"""
    data = _overpass(query, timeout=420)
    out.write_bytes(data)
    _record(_raw() / "manifest.json", {
        "file": out.name, "source": "OpenStreetMap contributors via Overpass API", "licence": "ODbL 1.0",
        "query": query, "fetched_at": datetime.now(UTC).isoformat(timespec="seconds"), "sha256": _sha256(out),
        "bytes": out.stat().st_size,
    })
    return out


def classify(tags: dict) -> tuple[str, str] | None:
    """(category, kind label) of a named OSM feature, or None if search should skip it."""
    t = tags.get
    if t("place") in PLACE_TYPES:
        return "locality", t("place").capitalize()
    if t("aeroway") == "aerodrome":
        return "transit", "Airport"
    if t("amenity") == "bus_station" or (t("public_transport") == "station" and t("bus") == "yes" and not t("railway")):
        return "transit", "Bus station"
    if t("railway") in ("station", "halt") or t("public_transport") == "station":
        metro = t("station") in ("subway", "light_rail") or "metro" in (t("name") or "").lower()
        return "transit", "Metro station" if metro else "Railway station" if t("railway") or t("train") == "yes" else "Station"
    if t("tourism") in TOURISM:
        return "landmark", t("tourism").replace("_", " ").capitalize()
    if t("historic"):
        return "landmark", "Historic site"
    if t("leisure") == "stadium":
        return "landmark", "Stadium"
    if t("leisure") in ("park", "garden", "nature_reserve"):
        return "park", "Park" if t("leisure") != "nature_reserve" else "Nature reserve"
    if t("natural") == "water":
        return "park", "Lake" if t("water") in (None, "lake", "reservoir", "pond") else t("water").capitalize()
    if t("shop") == "mall":
        return "shopping", "Mall"
    if t("amenity") in ("marketplace", "cinema"):
        return "shopping", "Market" if t("amenity") == "marketplace" else "Cinema"
    if t("amenity") in ("university", "college", "school"):
        return "education", t("amenity").capitalize()
    if t("amenity") == "hospital":
        return "health", "Hospital"
    if t("office") == "government" or t("amenity") in ("townhall", "courthouse", "police", "post_office"):
        return "civic", {"police": "Police station", "post_office": "Post office", "courthouse": "Court"}.get(t("amenity"), "Government office")
    if t("office"):
        return "office", "Office"
    if t("amenity") == "place_of_worship":
        return "worship", "Place of worship"
    if t("landuse") in ("commercial", "industrial", "retail"):
        return "campus", {"commercial": "Business area", "industrial": "Industrial area", "retail": "Retail area"}[t("landuse")]
    if t("landuse") == "residential":
        return "locality", "Residential area"
    if t("highway") and t("highway") not in NO_STREET:
        return "street", "Street"
    if t("building"):
        return "building", "Building"
    return None


def _where(el: dict) -> tuple[float, float, list[float] | None] | None:
    """(lat, lon, bbox [w, s, e, n] or None) of a node, way or relation as Overpass returns it."""
    if el["type"] == "node":
        return el["lat"], el["lon"], None
    b = el.get("bounds")
    if b:
        return (b["minlat"] + b["maxlat"]) / 2, (b["minlon"] + b["maxlon"]) / 2, [b["minlon"], b["minlat"], b["maxlon"], b["maxlat"]]
    c = el.get("center")
    return (c["lat"], c["lon"], None) if c else None


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()


def collect() -> tuple[list[dict], list[dict]]:
    """Named features worth searching (one per OSM element) and named street pieces."""
    from .tiles import owner_of

    files = sorted(glob.glob(str(_raw() / "blocks" / "*" / "osm.json")))
    extra = _raw() / "places_osm.json"
    if extra.exists():
        files.append(str(extra))
    seen: set[str] = set()
    feats, streets = [], []
    for f in files:
        for el in json.loads(Path(f).read_text(encoding="utf-8"))["elements"]:
            tags = el.get("tags") or {}
            name = tags.get("name") or tags.get("name:en")
            oid = f"{el['type'][0]}{el['id']}"
            if not name or oid in seen:
                continue
            seen.add(oid)
            c = classify(tags)
            w = _where(el)
            if not c or not w:
                continue
            lat, lon, bbox = w
            if owner_of(*to_utm(lon, lat)) is None:  # outside the city grid
                continue
            alt = {tags[k].strip() for k in ALT_KEYS if tags.get(k)} - {name.strip()}
            row = {"name": name.strip(), "cat": c[0], "kind": c[1], "lat": lat, "lon": lon, "bbox": bbox, "osm_id": oid,
                   "building": "building" in tags and el["type"] != "node", "alt": ";".join(sorted(alt)) or None}
            (streets if c[0] == "street" else feats).append(row)
    return feats, streets


def merge_streets(pieces: list[dict], gap_m: float = 300) -> list[dict]:
    """One entry per street: pieces with the same name whose boxes lie within `gap_m` join up."""
    by_name: dict[str, list[dict]] = {}
    for p in pieces:
        by_name.setdefault(_norm(p["name"]), []).append(p)
    out = []
    pad = gap_m / 111_000
    for group in by_name.values():
        boxes = [p["bbox"] or [p["lon"], p["lat"], p["lon"], p["lat"]] for p in group]
        parent = list(range(len(group)))

        def find(i: int) -> int:
            while parent[i] != i:
                parent[i] = parent[parent[i]]
                i = parent[i]
            return i

        for i in range(len(group)):
            for j in range(i + 1, len(group)):
                a, b = boxes[i], boxes[j]
                if a[0] - pad <= b[2] and b[0] - pad <= a[2] and a[1] - pad <= b[3] and b[1] - pad <= a[3]:
                    parent[find(i)] = find(j)
        clusters: dict[int, list[int]] = {}
        for i in range(len(group)):
            clusters.setdefault(find(i), []).append(i)
        for members in clusters.values():
            bb = [min(boxes[i][0] for i in members), min(boxes[i][1] for i in members),
                  max(boxes[i][2] for i in members), max(boxes[i][3] for i in members)]
            longest = max(members, key=lambda i: (boxes[i][2] - boxes[i][0]) + (boxes[i][3] - boxes[i][1]))
            p = group[longest]
            out.append(p | {"bbox": bb, "lat": p["lat"], "lon": p["lon"]})
    return out


def dedupe(rows: list[dict], near_m: float = 200) -> list[dict]:
    """The same name and category twice within `near_m` (say a node and its building) is one place."""
    keep: dict[tuple[str, str], list[dict]] = {}
    rank = lambda r: (not r["building"], r["bbox"] is None)  # noqa: E731  prefer outlines over points
    for r in sorted(rows, key=rank):
        k = (r["cat"], _norm(r["name"]))
        if any(abs(o["lat"] - r["lat"]) * 111_000 < near_m and abs(o["lon"] - r["lon"]) * 106_000 < near_m for o in keep.get(k, [])):
            continue
        keep.setdefault(k, []).append(r)
    return [r for rs in keep.values() for r in rs]


def add_context(rows: list[dict]) -> None:
    """Name the area each place is in, for the result's second line: the nearest suburb or town
    within 2.5 km (the names people know, like Madhapur), else the nearest neighbourhood or
    village within 1.5 km."""
    for kinds, reach in ((MAJOR_AREAS, 2500), (CONTEXT_TYPES - MAJOR_AREAS, 1500)):
        locs = [r for r in rows if r["cat"] == "locality" and r["kind"].lower() in kinds]
        if not locs:
            continue
        la = np.array([r["lat"] for r in locs])
        lo = np.array([r["lon"] for r in locs])
        for r in rows:
            if r.get("context") or (r["cat"] == "locality" and r["kind"].lower() in MAJOR_AREAS):
                continue  # already placed, or a suburb itself
            d2 = ((la - r["lat"]) * 111_000) ** 2 + ((lo - r["lon"]) * 106_000) ** 2
            i = int(np.argmin(d2))
            r["context"] = locs[i]["name"] if d2[i] < reach**2 and locs[i]["name"] != r["name"] else None


def build(out_path: Path = OUT, fetch: bool = True) -> dict:
    from .corporate import locate

    if fetch:
        fetch_extra()
    feats, pieces = collect()
    rows = dedupe(feats) + merge_streets(pieces)
    # Named OSM buildings → the map's building ids, so search can outline them.
    found = locate({r["osm_id"] for r in rows if r["building"]})
    for r in rows:
        f = found.get(r["osm_id"]) if r["building"] else None
        r["building_id"] = f["id"] if f and f["layer"] == "buildings" else None
    add_context(rows)
    order = list(CATEGORIES)
    rows.sort(key=lambda r: (order.index(r["cat"]), r["name"].lower()))
    r5 = lambda v: round(v, 5)  # noqa: E731  ~1 m
    out = {
        "generated_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "attribution": "Places: © OpenStreetMap contributors (ODbL)",
        "categories": CATEGORIES,
        "fields": ["name", "cat", "kind", "lat", "lon", "bbox", "building_id", "context", "osm_id", "alt"],
        "places": [[r["name"], r["cat"], r["kind"], r5(r["lat"]), r5(r["lon"]), [r5(v) for v in r["bbox"]] if r["bbox"] else None,
                    r["building_id"], r.get("context"), r["osm_id"], r.get("alt")] for r in rows],
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    counts: dict[str, int] = {}
    for r in rows:
        counts[r["cat"]] = counts.get(r["cat"], 0) + 1
    return {"places": len(rows), "by_category": counts, "buildings_linked": sum(1 for r in rows if r["building_id"]),
            "bytes": out_path.stat().st_size}


def cli(argv: list[str]) -> None:
    print(json.dumps(build(fetch="--no-fetch" not in argv), indent=1))
    sys.exit(0)
