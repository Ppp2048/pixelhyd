"""Build a renderable scene (in metres) from normalised features.

The scene is a pure description: ground layers, a shadow geometry and a list
of depth-sorted objects. Rendering any rectangle of the canvas from the same
scene produces identical pixels, which is what makes chunked rendering
seamless.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import geopandas as gpd
import numpy as np
from shapely import affinity
from shapely.geometry import LineString, MultiPolygon, Point, Polygon, box
from shapely.geometry.polygon import orient
from shapely.ops import substring, unary_union

from . import style as S
from .area import Area
from .iso import IsoProjection
from .normalise import seeded_unit

RGB = S.RGB


@dataclass
class Building:
    id: str
    ring: np.ndarray  # (n, 2) exterior ring in metres, counter-clockwise, closed
    height: float
    wall: RGB
    roof: RGB
    glass: bool
    floor_h: float
    family: str
    roof_items: list[tuple[float, float, str]]  # (e, n, kind)


@dataclass
class Deck:
    """A short piece of an elevated structure (metro viaduct or flyover)."""

    ring: np.ndarray
    z: float
    thickness: float
    top: RGB
    fascia: RGB
    kind: str  # "rail" | "road"
    centre_line: np.ndarray  # (2, 2) along the piece, for rails/markings


@dataclass
class Pillar:
    ring: np.ndarray
    height: float
    colour: RGB


@dataclass
class Tree:
    e: float
    n: float
    height: float
    radius: float
    seed: float


@dataclass
class Obj:
    depth: float  # e + n of the nearest ground point; larger = farther (drawn first)
    tie: str
    bounds: tuple[float, float, float, float]  # art px (x0, y0, x1, y1)
    item: Building | Deck | Pillar | Tree


@dataclass
class Scene:
    proj: IsoProjection
    core: Polygon
    ground: list[tuple[Polygon | MultiPolygon, RGB]] = field(default_factory=list)
    markings: list[np.ndarray] = field(default_factory=list)  # dashed line pieces (2, 2) in metres
    shadow: Polygon | MultiPolygon | None = None
    objects: list[Obj] = field(default_factory=list)


# ---------------------------------------------------------------- helpers
def _ring(poly: Polygon) -> np.ndarray:
    return np.asarray(orient(poly, sign=1.0).exterior.coords)


def _bounds_px(proj: IsoProjection, ring: np.ndarray, z_low: float, z_high: float) -> tuple[float, float, float, float]:
    xs, ys_low = proj.to_px(ring[:, 0], ring[:, 1], z_low)
    _, ys_high = proj.to_px(ring[:, 0], ring[:, 1], z_high)
    return (float(xs.min()) - 2, float(ys_high.min()) - 2, float(xs.max()) + 2, float(ys_low.max()) + 2)


def _shadow_of(poly: Polygon, height: float, z_base: float = 0.0) -> Polygon:
    """Ground shadow of a prism from z_base to z_base+height (parallel sun)."""
    dx, dy = S.SHADOW_VEC
    top = affinity.translate(poly, dx * (z_base + height), dy * (z_base + height))
    if z_base == 0:
        parts = [poly, top]
        ring = np.asarray(poly.exterior.coords)
        for (a, b) in zip(ring[:-1], ring[1:]):
            quad = Polygon([a, b, (b[0] + dx * height, b[1] + dy * height), (a[0] + dx * height, a[1] + dy * height)])
            if quad.is_valid and quad.area > 0:
                parts.append(quad)
        return unary_union(parts)
    return top  # elevated slab: its own outline displaced


# ---------------------------------------------------------------- builders
def _buildings(gdf: gpd.GeoDataFrame, core: Polygon, proj: IsoProjection, scene: Scene, shadows: list,
               owns=None, shadow_all: bool = True) -> None:
    """Add drawable buildings. `owns(row)` decides which buildings this scene draws
    (default: representative point inside `core`); `shadow_all` also casts shadows
    of buildings that are not drawn (prototype behaviour)."""
    for row in gdf.itertuples():
        poly: Polygon = row.geometry
        if not isinstance(poly, Polygon) or poly.is_empty:
            continue
        h = float(row.height_m)
        draw = owns(row) if owns else core.contains(poly.representative_point())
        if draw or shadow_all:
            shadows.append(_shadow_of(poly, h))
        if not draw:
            continue  # not drawn here: at most its shadow matters
        family = S.use_family(row.use or "")
        options = S.FACADES_BY_USE[family]
        wall_hex, roof_hex = options[int(seeded_unit(row.id, "facade") * len(options))]
        glass = family in ("office", "commercial", "default") and h >= 18 and seeded_unit(row.id, "glass") < 0.55
        floor_h = 3.2 if family == "residential" else 3.8
        items: list[tuple[float, float, str]] = []
        inner = poly.buffer(-1.4)
        if not inner.is_empty and inner.area > 12:
            count = min(6, int(inner.area / 90))
            minx, miny, maxx, maxy = inner.bounds
            for i in range(count * 4):
                if len(items) >= count:
                    break
                e = minx + (maxx - minx) * seeded_unit(row.id, f"rx{i}")
                n = miny + (maxy - miny) * seeded_unit(row.id, f"ry{i}")
                if inner.contains(Point(e, n)):
                    kind = "tank" if family in ("residential", "default") or seeded_unit(row.id, f"rk{i}") < 0.3 else "ac"
                    items.append((e, n, kind))
        ring = _ring(poly)
        b = Building(row.id, ring, h, S.hex_rgb(wall_hex), S.hex_rgb(roof_hex), glass, floor_h, family, items)
        depth = float((ring[:, 0] + ring[:, 1]).min())
        scene.objects.append(Obj(depth, row.id, _bounds_px(proj, ring, 0, h + 3), b))


def _elevated(lines: gpd.GeoDataFrame, kind: str, core: Polygon, proj: IsoProjection, scene: Scene, shadows: list,
              shadow_all: bool = True) -> None:
    """Split elevated ways into short deck pieces with a ramp where a way doesn't continue."""
    if lines is None or lines.empty:
        return
    width = 9.0 if kind == "rail" else None
    z_full = S.ELEVATED_HEIGHT[kind]
    endpoints = [tuple(np.round(c, 1)) for g in lines.geometry for c in (g.coords[0], g.coords[-1])]
    for row in lines.itertuples():
        line: LineString = row.geometry
        L = line.length
        if L < 1:
            continue
        w = width or float(row.width_m)
        start_connected = endpoints.count(tuple(np.round(line.coords[0], 1))) > 1
        end_connected = endpoints.count(tuple(np.round(line.coords[-1], 1))) > 1
        ramp = 45.0
        n_pieces = max(1, int(np.ceil(L / 6.0)))
        for i in range(n_pieces):
            s0, s1 = L * i / n_pieces, L * (i + 1) / n_pieces
            piece = substring(line, s0, s1)
            mid = (s0 + s1) / 2
            f = 1.0
            if not start_connected:
                f = min(f, mid / ramp)
            if not end_connected:
                f = min(f, (L - mid) / ramp)
            z = z_full * max(0.0, min(1.0, f))
            deck = piece.buffer(w / 2, cap_style="flat", join_style="mitre")
            if deck.is_empty or not isinstance(deck, Polygon):
                continue
            drawn = core.intersects(deck)
            if z > 0.5 and (drawn or shadow_all):
                shadows.append(_shadow_of(deck, 0.0, z))
            if not drawn:
                continue
            ring = _ring(deck)
            coords = np.asarray(piece.coords)
            centre = np.array([coords[0], coords[-1]])
            top = S.METRO_DECK if kind == "rail" else S.ASPHALT
            fascia = S.METRO_FASCIA if kind == "rail" else S.FLYOVER_FASCIA
            d = Deck(ring, z, 1.6 if kind == "rail" else 1.1, top, fascia, kind, centre)
            depth = float((ring[:, 0] + ring[:, 1]).min())
            scene.objects.append(Obj(depth, f"{row.osm_id}:{i}", _bounds_px(proj, ring, max(0, z - 2), z + 1), d))
        # Pillars every ~28 m (metro) / 24 m (flyover) where the deck is high enough.
        spacing = 28.0 if kind == "rail" else 24.0
        for s in np.arange(spacing / 2, L, spacing):
            f = 1.0
            if not start_connected:
                f = min(f, s / ramp)
            if not end_connected:
                f = min(f, (L - s) / ramp)
            z = z_full * max(0.0, min(1.0, f))
            if z < 4:
                continue
            p = line.interpolate(s)
            if not core.contains(p):
                continue
            size = 2.2 if kind == "rail" else 1.6
            sq = box(p.x - size / 2, p.y - size / 2, p.x + size / 2, p.y + size / 2)
            ring = _ring(sq)
            shadows.append(_shadow_of(sq, z - 1.5))
            scene.objects.append(Obj(float(p.x + p.y - size), f"{row.osm_id}:p{s:.0f}", _bounds_px(proj, ring, 0, z), Pillar(ring, z - 1.5, S.METRO_PILLAR)))


def _trees(areas: gpd.GeoDataFrame | None, pois: gpd.GeoDataFrame | None, core: Polygon, proj: IsoProjection, scene: Scene) -> None:
    pts: list[tuple[float, float, str]] = []
    if pois is not None:
        for row in pois[pois["kind"] == "tree"].itertuples():
            pts.append((row.geometry.x, row.geometry.y, row.osm_id))
    green = {"leisure:park", "leisure:garden", "landuse:grass", "landuse:meadow", "landuse:forest", "natural:scrub", "natural:wood", "natural:grassland"}
    cell = 9.0  # global grid → identical placement in every chunk and run
    if areas is not None:
        for row in areas[areas["kind"].isin(green)].itertuples():
            poly = row.geometry.intersection(core)
            if poly.is_empty:
                continue
            density = 0.35 if row.kind in ("landuse:meadow", "natural:grassland") else 0.6
            minx, miny, maxx, maxy = poly.bounds
            for gx in np.arange(np.floor(minx / cell) * cell, maxx, cell):
                for gy in np.arange(np.floor(miny / cell) * cell, maxy, cell):
                    key = f"{gx:.0f},{gy:.0f}"
                    if seeded_unit(key, "tree") > density:
                        continue
                    e = gx + cell * seeded_unit(key, "tx")
                    n = gy + cell * seeded_unit(key, "ty")
                    if poly.contains(Point(e, n)):
                        pts.append((e, n, key))
    for e, n, key in pts:
        if not core.contains(Point(e, n)):
            continue
        u = seeded_unit(key, "size")
        t = Tree(e, n, 6 + 4 * u, 2.0 + 1.4 * u, seeded_unit(key, "shade"))
        r = t.radius
        ring = np.array([[e - r, n - r], [e + r, n - r], [e + r, n + r], [e - r, n + r], [e - r, n - r]])
        scene.objects.append(Obj(e + n, f"t{key}", _bounds_px(proj, ring, 0, t.height + r), t))


LAYERS = ("buildings", "roads", "rail", "areas", "pois")


def read_layers(features: Path) -> dict[str, gpd.GeoDataFrame]:
    import pyogrio

    present = set(pyogrio.list_layers(features)[:, 0])
    return {name: gpd.read_file(features, layer=name) for name in LAYERS if name in present}


def build_scene(area: Area, features: Path, k: float) -> Scene:
    """Single-area scene with a projection fitted to the area (the prototype)."""
    layers = read_layers(features)
    buildings = layers["buildings"]
    core = box(*area.core)
    in_core = buildings[buildings.representative_point().within(core)]
    max_h = float(in_core["height_m"].max()) if len(in_core) else 30.0
    proj = IsoProjection.for_square(area.core, k, max_h + 6)
    return build_scene_from_layers(layers, proj, core)


def build_scene_from_layers(layers: dict, proj: IsoProjection, core, owns=None, shadow_all: bool = True) -> Scene:
    """Scene for any region `core` (Polygon/MultiPolygon in UTM metres) in a given projection.

    Used by the prototype (fitted projection, defaults) and by the tile grid
    (one global projection, explicit building ownership, shadows only from
    drawn features so partial maps never show shadows of missing buildings).
    """
    buildings = layers["buildings"]
    scene = Scene(proj, core)
    shadows: list = []

    # Ground: base, then areas by key order, then roads.
    scene.ground.append((core, S.GROUND))
    areas = layers.get("areas")
    if areas is not None:
        areas = areas.assign(group=areas["kind"].str.split(":").str[0])
        for group in S.AREA_ORDER:
            sub = areas[areas["group"] == group].copy()
            sub["a"] = sub.geometry.area
            for row in sub.sort_values("a", ascending=False).itertuples():
                colour = S.AREA_FILL.get(row.kind)
                if colour is None:
                    continue
                g = row.geometry.intersection(core)
                if not g.is_empty:
                    scene.ground.append((g, colour))

    roads = layers.get("roads")
    if roads is not None:
        ground_roads = roads[~roads["bridge"].astype(bool) & ~roads["tunnel"].astype(bool)]
        paved = ground_roads[~ground_roads["highway"].isin(list(S.ROAD_FILL))]
        minor = ground_roads[ground_roads["highway"].isin(list(S.ROAD_FILL))]
        for sub in (minor,):
            for hw, grp in sub.groupby("highway"):
                shape = unary_union([g.buffer(w / 2, cap_style="round", join_style="round") for g, w in zip(grp.geometry, grp["width_m"])])
                scene.ground.append((shape.intersection(core), S.ROAD_FILL[hw]))
        if not paved.empty:
            edge = unary_union([g.buffer(w / 2 + 0.6, join_style="round") for g, w in zip(paved.geometry, paved["width_m"])])
            fill = unary_union([g.buffer(w / 2, join_style="round") for g, w in zip(paved.geometry, paved["width_m"])])
            scene.ground.append((edge.intersection(core), S.ASPHALT_EDGE))
            scene.ground.append((fill.intersection(core), S.ASPHALT))
            # Dashed centre lines on marked classes (3 m dash, 5 m gap).
            for row in paved[paved["highway"].isin(S.MARKED_CLASSES)].itertuples():
                line = row.geometry
                for s in np.arange(0, line.length - 3, 8.0):
                    seg = substring(line, s, s + 3)
                    if core.contains(seg.centroid):
                        c = np.asarray(seg.coords)
                        scene.markings.append(np.array([c[0], c[-1]]))
        bridges = roads[roads["bridge"].astype(bool)]
        _elevated(bridges, "road", core, proj, scene, shadows, shadow_all)
    rail = layers.get("rail")
    if rail is not None:
        _elevated(rail[rail["bridge"].astype(bool)], "rail", core, proj, scene, shadows, shadow_all)

    _buildings(buildings, core, proj, scene, shadows, owns, shadow_all)
    _trees(areas, layers.get("pois"), core, proj, scene)

    scene.shadow = unary_union(shadows).intersection(core) if shadows else None
    scene.objects = order_objects(scene.objects)
    return scene


# ---------------------------------------------------------------- draw order
def _footprint(item) -> tuple[Polygon, float]:
    """Ground footprint and top height of a drawable object."""
    if isinstance(item, (Building, Deck, Pillar)):
        top = item.height if isinstance(item, (Building, Pillar)) else item.z
        return Polygon(item.ring), top
    r = item.radius * 0.6
    return box(item.e - r, item.n - r, item.e + r, item.n + r), item.height


def _w_interval(poly_uw: Polygon, u: float) -> tuple[float, float] | None:
    minx, miny, maxx, maxy = poly_uw.bounds
    cut = poly_uw.intersection(LineString([(u, miny - 1), (u, maxy + 1)]))
    if cut.is_empty:
        return None
    _, w0, _, w1 = cut.bounds
    return w0, w1


def order_objects(objects: list[Obj]) -> list[Obj]:
    """Painter's order from pairwise occlusion tests, then a topological sort.

    The camera looks along +w (w = e + n); screen x follows u = e − n. For two
    objects whose screen boxes overlap, sample the shared u-range: the one whose
    footprint starts nearer the camera (smaller w) on that column is in front.
    Footprints that overlap on the ground (an elevated deck over a building) are
    ordered by height instead. Falls back to the nearest-point key on cycles.
    """
    from shapely import affinity, STRtree

    base = sorted(objects, key=lambda o: (-o.depth, o.tie))
    n = len(base)
    uw, tops = [], []
    for o in base:
        poly, top = _footprint(o.item)
        # (e, n) → (u, w) = (e − n, e + n)
        uw.append(affinity.affine_transform(poly, [1, -1, 1, 1, 0, 0]))
        tops.append(top)
    screen = [box(*o.bounds) for o in base]
    tree = STRtree(screen)
    after: list[set[int]] = [set() for _ in range(n)]  # after[i]: objects that must be drawn after i
    indeg = [0] * n
    for i in range(n):
        for j in tree.query(screen[i], predicate="intersects"):
            j = int(j)
            if j <= i:
                continue
            a, b = uw[i], uw[j]
            if a.intersects(b) and a.intersection(b).area > 0.5:
                front = j if tops[j] >= tops[i] else i  # taller/higher drawn later
            else:
                lo = max(a.bounds[0], b.bounds[0])
                hi = min(a.bounds[2], b.bounds[2])
                if hi <= lo:
                    continue  # no shared screen column → no occlusion
                front = None
                for t in (0.5, 0.25, 0.75, 0.1, 0.9):
                    u = lo + (hi - lo) * t
                    ia, ib = _w_interval(a, u), _w_interval(b, u)
                    if ia and ib:
                        front = i if ia[0] < ib[0] else j
                        break
                if front is None:
                    continue
            back = j if front == i else i
            if front not in after[back]:
                after[back].add(front)
                indeg[front] += 1
    # Kahn's algorithm, preferring the base (nearest-point) order among ready objects.
    import heapq

    ready = [k for k in range(n) if indeg[k] == 0]
    heapq.heapify(ready)
    order: list[int] = []
    while ready:
        k = heapq.heappop(ready)
        order.append(k)
        for m in after[k]:
            indeg[m] -= 1
            if indeg[m] == 0:
                heapq.heappush(ready, m)
    if len(order) < n:  # cycle: append the rest in base order
        seen = set(order)
        order += [k for k in range(n) if k not in seen]
    return [base[k] for k in order]
