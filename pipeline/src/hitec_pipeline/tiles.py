"""Progressive generation of the full 5 km × 5 km map as a grid of ground tiles.

Grid
    The 5 km UTM square (`area.HITEC_CITY`) is split into 5 × 5 ground tiles of
    1 km, ids `r{row}c{col}` with row 0 in the south and col 0 in the west.

Continuity
    * One global isometric projection for the whole area (fixed origin, scale
      and head-room), so every tile lands in the same art-pixel space.
    * Features are fetched per tile with a buffer and merged across tiles by
      stable ids (Overture building id, OSM id) from a pinned Overture release.
    * A building is drawn by exactly one tile: the tile containing its
      representative point (no duplicates, no buildings cut in half).
    * Ground (land use, roads) is clipped to the union of completed tiles, and
      roads are buffered from full OSM geometry, so they continue across edges.
    * Rendering happens in fixed 1024 px art chunks with the seam-safe renderer;
      when a tile completes, every chunk its footprint (plus shadow/height reach)
      touches is re-rendered from all available data, so neighbours update too.

State
    `data/tiles/hitec-city/index.json` records each tile's status
    (pending → fetched → rendered → validated, or failed / stale), timings,
    counts and errors, so work resumes across sessions and retries are safe.
"""

from __future__ import annotations

import argparse
import io
import json
import math
import shutil
import time
import traceback
from datetime import UTC, datetime
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
from PIL import Image
from pmtiles.tile import Compression, TileType, zxy_to_tileid
from pmtiles.writer import write as pmtiles_write
from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import unary_union

from . import DATA_ROOT
from .area import HITEC_CITY, PROTOTYPE, Square, to_wgs
from .build import WEB_PUBLIC, _clean, _encode, building_silhouette, peak_memory_mb
from .fetch import fetch_all
from .iso import TILE, IsoProjection
from .normalise import normalise
from .render import render_region
from .scene import LAYERS, Building, Scene, build_scene_from_layers, read_layers

AREA = HITEC_CITY
TILE_M = 1000.0
GRID = int(AREA.size_m // TILE_M)  # 5
BUFFER_M = 200.0  # data fetched around each tile (roads/areas/buildings crossing the edge)
REACH_M = 220.0  # ground distance a tile's buildings/shadows can affect pixels beyond its edge
K = 4.0  # art px per metre (decision D3)
HEADROOM_M = 200.0  # fixed vertical room in the global canvas, independent of data
CHUNK = 1024  # render unit in art px (4 × 4 output tiles)
OVERTURE_RELEASE = "2026-10-21.0"  # pinned so building ids stay stable across tiles
DATASET = f"{AREA.name}-k{K:g}"

INDEX_PATH = DATA_ROOT / "tiles" / AREA.name / "index.json"
OUT = DATA_ROOT / "out" / DATASET
CACHE = OUT / "tiles"  # z/x_y.webp output tiles (the pyramid), source for art.pmtiles
OVERLAYS = OUT / "overlay"

# Interactive overlay as vector tiles (image-space Web Mercator, same tiling as the art).
VT_MIN_ZOOM, VT_MAX_ZOOM = 14, 18  # MapLibre overzooms past 18; 18 keeps ≤ 0.25 art px precision
VT_EXTENT, VT_BUFFER = 4096, 64  # tile units; the buffer hides clip edges under MapLibre's tile stencil
VT_LAYERS = ("building", "road_centreline", "poi")

DONE = ("rendered", "validated")
KEYS = {"buildings": "id", "roads": "osm_id", "rail": "osm_id", "areas": "osm_id", "pois": "osm_id"}


# ---------------------------------------------------------------- grid
def tile_ids() -> list[str]:
    return [f"r{r}c{c}" for r in range(GRID) for c in range(GRID)]


def rc(tid: str) -> tuple[int, int]:
    r, c = tid[1:].split("c")
    return int(r), int(c)


def tile_bounds(tid: str) -> tuple[float, float, float, float]:
    r, c = rc(tid)
    e0, n0 = AREA.core[0], AREA.core[1]
    return (e0 + c * TILE_M, n0 + r * TILE_M, e0 + (c + 1) * TILE_M, n0 + (r + 1) * TILE_M)


def tile_square(tid: str) -> Square:
    return Square(f"{AREA.name}/{tid}", tile_bounds(tid), BUFFER_M)


def owner_of(e: float, n: float) -> str | None:
    c = math.floor((e - AREA.core[0]) / TILE_M)
    r = math.floor((n - AREA.core[1]) / TILE_M)
    return f"r{r}c{c}" if 0 <= r < GRID and 0 <= c < GRID else None


def neighbours(tid: str, ring: int = 1) -> list[str]:
    r, c = rc(tid)
    return [f"r{rr}c{cc}" for rr in range(r - ring, r + ring + 1) for cc in range(c - ring, c + ring + 1)
            if 0 <= rr < GRID and 0 <= cc < GRID]


def global_projection() -> IsoProjection:
    return IsoProjection.for_square(AREA.core, K, HEADROOM_M)


# ---------------------------------------------------------------- index
def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def load_index() -> dict:
    if INDEX_PATH.exists():
        return json.loads(INDEX_PATH.read_text(encoding="utf-8"))
    idx = {
        "area": AREA.name, "crs": "EPSG:32644", "area_square_utm": list(AREA.core), "tile_m": TILE_M, "grid": GRID,
        "buffer_m": BUFFER_M, "k": K, "headroom_m": HEADROOM_M, "chunk_px": CHUNK, "overture_release": OVERTURE_RELEASE,
        "tiles": {},
    }
    pe0, pn0, pe1, pn1 = PROTOTYPE.core
    for tid in tile_ids():
        b = tile_bounds(tid)
        w, s = to_wgs(b[0], b[1])
        e, n = to_wgs(b[2], b[3])
        contains_proto = b[0] <= pe0 and pe1 <= b[2] and b[1] <= pn0 and pn1 <= b[3]
        idx["tiles"][tid] = {"status": "pending", "bounds_utm": [round(v, 3) for v in b],
                             "approx_wgs_sw_ne": [round(s, 6), round(w, 6), round(n, 6), round(e, 6)],
                             "contains_prototype": contains_proto, "history": []}
    save_index(idx)
    return idx


def save_index(idx: dict) -> None:
    INDEX_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = INDEX_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(idx, indent=1), encoding="utf-8")
    tmp.replace(INDEX_PATH)  # atomic: a crash never leaves a half-written index


def _set(idx: dict, tid: str, status: str, **info) -> None:
    t = idx["tiles"][tid]
    t["status"] = status
    t.update(info)
    t["history"].append({"at": _now(), "status": status, **{k: v for k, v in info.items() if k == "error"}})
    save_index(idx)


def done_tiles(idx: dict) -> set[str]:
    return {t for t, v in idx["tiles"].items() if v["status"] in DONE}


def next_tile(idx: dict) -> str | None:
    """Prototype's tile first, then pending tiles touching completed ones, nearest the centre first."""
    done = done_tiles(idx)
    todo = [t for t, v in idx["tiles"].items() if v["status"] in ("pending", "fetched", "failed", "stale")]
    if not todo:
        return None
    if not done:
        proto = [t for t in todo if idx["tiles"][t]["contains_prototype"]]
        return proto[0] if proto else todo[0]
    centre = (GRID - 1) / 2
    adjacent = [t for t in todo if any(abs(rc(t)[0] - rc(d)[0]) + abs(rc(t)[1] - rc(d)[1]) == 1 for d in done)]
    pool = adjacent or todo
    return min(pool, key=lambda t: (math.hypot(rc(t)[0] - centre, rc(t)[1] - centre), t))


# ---------------------------------------------------------------- data
def _features(tid: str) -> Path:
    return DATA_ROOT / "work" / AREA.name / tid / "features.gpkg"


def fetch_tile(idx: dict, tid: str, force: bool = False) -> None:
    if not force and _features(tid).exists() and idx["tiles"][tid]["status"] != "pending":
        return
    t0 = time.perf_counter()
    sq = tile_square(tid)
    fetch_all(sq, DATA_ROOT, OVERTURE_RELEASE)
    work = normalise(sq, DATA_ROOT)
    rep = json.loads((work / "report.json").read_text(encoding="utf-8"))
    data = {k: rep.get(k) for k in ("buildings_count", "footprint_sources", "height_sources", "height_confidence",
                                    "roads_count", "rail_count", "areas_count", "pois_count", "invalid_fixed",
                                    "duplicates_dropped", "overlaps_dropped")}
    data["osm_base"] = next((d.get("osm_base") for d in rep.get("inputs", []) if d.get("osm_base")), None)
    status = idx["tiles"][tid]["status"]
    _set(idx, tid, "fetched" if status in ("pending", "failed") else status, data=data,
         fetch_s=round(time.perf_counter() - t0, 1))


def merged_layers(tids: list[str]) -> dict[str, gpd.GeoDataFrame]:
    """Union of the given tiles' features; duplicates (same id) keep the owner tile's copy."""
    parts: dict[str, list[gpd.GeoDataFrame]] = {k: [] for k in LAYERS}
    for tid in sorted(tids):
        if not _features(tid).exists():
            continue
        for name, gdf in read_layers(_features(tid)).items():
            parts[name].append(gdf.assign(_src=tid))
    out = {}
    for name, frames in parts.items():
        if not frames:
            continue
        gdf = pd.concat(frames, ignore_index=True)
        rp = gdf.geometry.representative_point()
        gdf["_own"] = [owner_of(p.x, p.y) == s for p, s in zip(rp, gdf["_src"])]
        gdf = gdf.sort_values(["_own", "_src"], ascending=[False, True]).drop_duplicates(KEYS[name], keep="first")
        out[name] = gpd.GeoDataFrame(gdf.drop(columns=["_own"]), geometry="geometry", crs=frames[0].crs).reset_index(drop=True)
    return out


# ---------------------------------------------------------------- chunks and pyramid
def affected_chunks(proj: IsoProjection, tid: str) -> list[tuple[int, int]]:
    e0, n0, e1, n1 = tile_bounds(tid)
    e0, n0, e1, n1 = e0 - REACH_M, n0 - REACH_M, e1 + REACH_M, n1 + REACH_M
    es, ns = np.array([e0, e1, e1, e0]), np.array([n0, n0, n1, n1])
    x, y_low = proj.to_px(es, ns, 0)
    _, y_high = proj.to_px(es, ns, HEADROOM_M)
    x0, x1 = max(0, x.min()), min(proj.width, x.max())
    y0, y1 = max(0, y_high.min()), min(proj.height, y_low.max())
    return [(cx, cy) for cy in range(int(y0 // CHUNK), int(math.ceil(y1 / CHUNK)))
            for cx in range(int(x0 // CHUNK), int(math.ceil(x1 / CHUNK)))]


def _tile_path(z: int, x: int, y: int) -> Path:
    return CACHE / str(z) / f"{x}_{y}.webp"


def zoom_range(proj: IsoProjection) -> tuple[int, int]:
    n = math.ceil(max(proj.width, proj.height) / TILE)
    return proj.zmax - math.ceil(math.log2(n)), proj.zmax


def write_chunk(proj: IsoProjection, img: Image.Image, cx: int, cy: int) -> list[tuple[int, int]]:
    """Cut a chunk into max-zoom tiles; write non-empty ones, delete ones that became empty."""
    origin = int(proj.origin_world // TILE)
    per = CHUNK // TILE
    changed = []
    for j in range(per):
        for i in range(per):
            t = img.crop((i * TILE, j * TILE, (i + 1) * TILE, (j + 1) * TILE))
            x, y = origin + cx * per + i, origin + cy * per + j
            path = _tile_path(proj.zmax, x, y)
            if t.getbbox() is None:
                if path.exists():
                    path.unlink()
                    changed.append((x, y))
                continue
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(_encode(t))
            changed.append((x, y))
    return changed


def rebuild_ancestors(proj: IsoProjection, changed: set[tuple[int, int]]) -> int:
    zmin, zmax = zoom_range(proj)
    level, written = changed, 0
    for z in range(zmax - 1, zmin - 1, -1):
        parents = {(x // 2, y // 2) for x, y in level}
        for px, py in parents:
            canvas = Image.new("RGBA", (TILE * 2, TILE * 2), (0, 0, 0, 0))
            for dy in (0, 1):
                for dx in (0, 1):
                    p = _tile_path(z + 1, px * 2 + dx, py * 2 + dy)
                    if p.exists():
                        canvas.paste(Image.open(p).convert("RGBA"), (dx * TILE, dy * TILE))
            out = canvas.reduce(2)
            path = _tile_path(z, px, py)
            if out.getbbox() is None:
                path.unlink(missing_ok=True)
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(_encode(out))
                written += 1
        level = parents
    return written


def pack(proj: IsoProjection) -> dict:
    zmin, zmax = zoom_range(proj)
    entries = []
    for z in range(zmin, zmax + 1):
        for p in (CACHE / str(z)).glob("*.webp") if (CACHE / str(z)).exists() else []:
            x, y = map(int, p.stem.split("_"))
            entries.append((zxy_to_tileid(z, x, y), p))
    entries.sort(key=lambda e: e[0])
    lon0, lat1 = proj.px_to_lonlat(0, 0)
    lon1, lat0 = proj.px_to_lonlat(proj.width, proj.height)
    size = 0
    OUT.mkdir(parents=True, exist_ok=True)
    with pmtiles_write(str(OUT / "art.pmtiles")) as w:
        for tid, p in entries:
            data = p.read_bytes()
            size += len(data)
            w.write_tile(tid, data)
        w.finalize(
            {"tile_type": TileType.WEBP, "tile_compression": Compression.NONE, "min_zoom": zmin, "max_zoom": zmax,
             "min_lon_e7": int(math.floor(float(lon0) * 1e7)), "min_lat_e7": int(math.floor(float(lat0) * 1e7)),
             "max_lon_e7": int(math.ceil(float(lon1) * 1e7)), "max_lat_e7": int(math.ceil(float(lat1) * 1e7)),
             "center_zoom": zmax - 2},
            {"name": "HITEC City isometric art", "attribution": "© OpenStreetMap contributors · Overture Maps Foundation", "type": "overlay"},
        )
    return {"tiles": len(entries), "bytes": size, "min_zoom": zmin, "max_zoom": zmax}


# ---------------------------------------------------------------- overlay and metadata
def _ll(proj: IsoProjection, xs, ys) -> list[list[float]]:
    lon, lat = proj.px_to_lonlat(np.asarray(xs), np.asarray(ys))
    return [[round(float(a), 9), round(float(b), 9)] for a, b in zip(lon, lat)]


def tile_overlay(scene: Scene, layers: dict, tid: str, owner: dict[str, str]) -> list[dict]:
    proj = scene.proj
    sq = box(*tile_bounds(tid))
    b_rows = layers["buildings"].set_index("id")
    feats = []
    for obj in scene.objects:
        b = obj.item
        if not isinstance(b, Building) or owner.get(b.id) != tid:
            continue
        r = b_rows.loc[b.id]
        props = _clean({"layer": "building", "tile": tid, "id": b.id, "name": r["name"], "use": r["use"], "levels": r["levels"],
                        "height_m": r["height_m"], "height_source": r["height_source"],
                        "height_confidence": r["height_confidence"], "footprint_source": r["footprint_source"],
                        "osm_id": r["osm_id"], "area_m2": r["area_m2"], "depth": obj.depth})
        sil = building_silhouette(scene, b)
        for g in ([sil] if isinstance(sil, Polygon) else list(sil.geoms)):
            feats.append({"type": "Feature", "properties": props,
                          "geometry": {"type": "Polygon", "coordinates": [_ll(proj, *np.asarray(g.exterior.coords).T)]}})
    for row in layers.get("roads", gpd.GeoDataFrame()).itertuples():
        g = row.geometry.intersection(sq)
        for line in (getattr(g, "geoms", None) or [g]):
            if isinstance(line, LineString) and not line.is_empty:
                c = np.asarray(line.coords)
                x, y = proj.to_px(c[:, 0], c[:, 1], 0)
                feats.append({"type": "Feature", "properties": _clean({"layer": "road_centreline", "tile": tid, "highway": row.highway,
                              "name": row.name, "bridge": bool(row.bridge)}), "geometry": {"type": "LineString", "coordinates": _ll(proj, x, y)}})
    pois = layers.get("pois")
    if pois is not None:
        for row in pois.itertuples():
            if row.kind == "tree" or not sq.contains(row.geometry):
                continue
            x, y = proj.to_px(row.geometry.x, row.geometry.y, 0)
            lon, lat = proj.px_to_lonlat(x, y)
            feats.append({"type": "Feature", "properties": _clean({"layer": "poi", "tile": tid, "kind": row.kind, "name": row.name, "osm_id": row.osm_id}),
                          "geometry": {"type": "Point", "coordinates": [float(lon), float(lat)]}})
    return feats


def _ground_ring(proj: IsoProjection, bounds) -> list[list[float]]:
    e0, n0, e1, n1 = bounds
    x, y = proj.to_px([e0, e1, e1, e0, e0], [n0, n0, n1, n1, n0], 0)
    return _ll(proj, x, y)


def write_vector_overlay(proj: IsoProjection, feats: list[dict]) -> dict:
    """Encode overlay features (image-space lon/lat GeoJSON) as gzip MVT tiles in overlay.pmtiles."""
    import gzip

    import mapbox_vector_tile
    from shapely import clip_by_rect
    from shapely.affinity import affine_transform
    from shapely import transform
    from shapely.geometry import shape

    def to_world(c: np.ndarray) -> np.ndarray:
        """Image-space lon/lat → world pixels at zmax (exact inverse of the art placement)."""
        x, y = proj.lonlat_to_px(c[:, 0], c[:, 1])
        return np.column_stack([x + proj.origin_world, y + proj.origin_world])

    prepared = []
    for f in feats:
        layer = f["properties"].get("layer")
        if layer not in VT_LAYERS:
            continue
        g = transform(shape(f["geometry"]), to_world)
        props = {k: v for k, v in f["properties"].items() if k != "layer" and v is not None}
        prepared.append((layer, g, props))

    tiles: dict[tuple[int, int, int], dict[str, list]] = {}
    for z in range(VT_MIN_ZOOM, VT_MAX_ZOOM + 1):
        span = TILE * 2 ** (proj.zmax - z)  # world px (at zmax) per tile at zoom z
        buf = span * VT_BUFFER / VT_EXTENT
        for layer, g, props in prepared:
            x0, y0, x1, y1 = g.bounds
            for ty in range(int((y0 - buf) // span), int((y1 + buf) // span) + 1):
                for tx in range(int((x0 - buf) // span), int((x1 + buf) // span) + 1):
                    ox, oy = tx * span, ty * span
                    part = clip_by_rect(g, ox - buf, oy - buf, ox + span + buf, oy + span + buf)
                    if part.is_empty:
                        continue
                    s = VT_EXTENT / span
                    local = affine_transform(part, [s, 0, 0, s, -ox * s, -oy * s])
                    tiles.setdefault((z, tx, ty), {}).setdefault(layer, []).append({"geometry": local, "properties": props})

    entries = []
    for (z, x, y), layers in tiles.items():
        data = mapbox_vector_tile.encode([{"name": n, "features": fs} for n, fs in layers.items()],
                                         default_options={"y_coord_down": True, "extents": VT_EXTENT})
        entries.append((zxy_to_tileid(z, x, y), gzip.compress(data, mtime=0)))
    entries.sort(key=lambda e: e[0])
    lon0, lat1 = proj.px_to_lonlat(0, 0)
    lon1, lat0 = proj.px_to_lonlat(proj.width, proj.height)
    fields = {"building": {"id": "String", "name": "String", "use": "String", "height_m": "Number", "height_source": "String",
                          "height_confidence": "String", "footprint_source": "String", "osm_id": "String", "levels": "Number",
                          "area_m2": "Number", "depth": "Number", "tile": "String"},
              "road_centreline": {"highway": "String", "name": "String", "bridge": "Boolean", "tile": "String"},
              "poi": {"kind": "String", "name": "String", "osm_id": "String", "tile": "String"}}
    size = 0
    with pmtiles_write(str(OUT / "overlay.pmtiles")) as w:
        for tid, data in entries:
            size += len(data)
            w.write_tile(tid, data)
        w.finalize(
            {"tile_type": TileType.MVT, "tile_compression": Compression.GZIP, "min_zoom": VT_MIN_ZOOM, "max_zoom": VT_MAX_ZOOM,
             "min_lon_e7": int(math.floor(float(lon0) * 1e7)), "min_lat_e7": int(math.floor(float(lat0) * 1e7)),
             "max_lon_e7": int(math.ceil(float(lon1) * 1e7)), "max_lat_e7": int(math.ceil(float(lat1) * 1e7)),
             "center_zoom": VT_MAX_ZOOM},
            {"name": "HITEC City overlay", "format": "pbf", "attribution": "© OpenStreetMap contributors · Overture Maps Foundation",
             "vector_layers": [{"id": n, "fields": fields[n], "minzoom": VT_MIN_ZOOM, "maxzoom": VT_MAX_ZOOM} for n in VT_LAYERS]},
        )
    return {"vector_tiles": len(entries), "bytes": size, "features": len(prepared)}


def publish(idx: dict, proj: IsoProjection, tiles_info: dict) -> None:
    """Merge per-tile overlays, write meta.json and copy outputs into the web app."""
    done = done_tiles(idx)
    feats = []
    for tid in sorted(done):
        p = OVERLAYS / f"{tid}.json"
        if p.exists():
            feats.extend(json.loads(p.read_text(encoding="utf-8")))
    vt_info = write_vector_overlay(proj, feats)
    # The grid and area outline stay a tiny GeoJSON: they are needed at every zoom.
    grid = [{"type": "Feature", "properties": {"layer": "tile", "id": tid, "status": t["status"]},
             "geometry": {"type": "Polygon", "coordinates": [_ground_ring(proj, tile_bounds(tid))]}}
            for tid, t in idx["tiles"].items()]
    grid.append({"type": "Feature", "properties": {"layer": "core"},
                 "geometry": {"type": "Polygon", "coordinates": [_ground_ring(proj, AREA.core)]}})
    (OUT / "grid.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": grid}), encoding="utf-8")
    (OUT / "overlay.geojson").unlink(missing_ok=True)  # replaced by overlay.pmtiles

    # Start the viewer on the completed tiles.
    if done:
        b = np.array([tile_bounds(t) for t in done])
        ce, cn = (b[:, 0].min() + b[:, 2].max()) / 2, (b[:, 1].min() + b[:, 3].max()) / 2
    else:
        ce, cn = AREA.centre_utm
    clon, clat = to_wgs(ce, cn)
    cx, cy = proj.to_px(ce, cn, 0)
    meta = {
        "area": AREA.name, "k": K, "projection": proj.to_dict(),
        "centre": {"lat": clat, "lon": clon, "art_px": [float(cx), float(cy)]},
        "core_square_utm": list(AREA.core), "zoom": {"min": tiles_info["min_zoom"], "max": tiles_info["max_zoom"]},
        "attribution": "© OpenStreetMap contributors (ODbL) · Overture Maps Foundation (ODbL) · art generated by this project",
        "metrics": {"tiles": tiles_info, "overlay": vt_info},
        "overlay": {"type": "vector", "url": "overlay.pmtiles", "grid": "grid.geojson", "layers": list(VT_LAYERS),
                    "minzoom": VT_MIN_ZOOM, "maxzoom": VT_MAX_ZOOM},
        "grid": {"tile_m": TILE_M, "size": GRID, "done": sorted(done)},
    }
    (OUT / "meta.json").write_text(json.dumps(meta, indent=1), encoding="utf-8")
    web = WEB_PUBLIC / DATASET
    web.mkdir(parents=True, exist_ok=True)
    (web / "overlay.geojson").unlink(missing_ok=True)
    for name in ("art.pmtiles", "overlay.pmtiles", "grid.geojson", "meta.json"):
        shutil.copy2(OUT / name, web / name)


# ---------------------------------------------------------------- render + validate
def render_tile(idx: dict, tid: str) -> dict:
    proj = global_projection()
    drawn = done_tiles(idx) | {tid}
    region = sorted(set(neighbours(tid, 1)))  # data within reach of the affected chunks
    t0 = time.perf_counter()
    layers = merged_layers([t for t in region if _features(t).exists()])
    owner: dict[str, str] = {}

    def owns(row) -> bool:
        p = row.geometry.representative_point()
        o = owner_of(p.x, p.y)
        owner[row.id] = o
        return o in drawn

    clip = unary_union([box(*tile_bounds(t)) for t in drawn])
    scene = build_scene_from_layers(layers, proj, clip, owns=owns, shadow_all=False)
    scene_s = time.perf_counter() - t0

    t0 = time.perf_counter()
    chunks = affected_chunks(proj, tid)
    changed: set[tuple[int, int]] = set()
    for cx, cy in chunks:
        w = min(CHUNK, proj.width - cx * CHUNK)
        h = min(CHUNK, proj.height - cy * CHUNK)
        img = render_region(scene, cx * CHUNK, cy * CHUNK, w, h)
        if (w, h) != (CHUNK, CHUNK):
            full = Image.new("RGBA", (CHUNK, CHUNK), (0, 0, 0, 0))
            full.paste(img, (0, 0))
            img = full
        changed.update(write_chunk(proj, img, cx, cy))
    render_s = time.perf_counter() - t0

    t0 = time.perf_counter()
    rebuilt = rebuild_ancestors(proj, changed)
    OVERLAYS.mkdir(parents=True, exist_ok=True)
    feats = tile_overlay(scene, layers, tid, owner)
    (OVERLAYS / f"{tid}.json").write_text(json.dumps(feats, ensure_ascii=False, allow_nan=False), encoding="utf-8")
    pyramid_s = time.perf_counter() - t0

    owned = [b for b, o in owner.items() if o == tid]
    conf = layers["buildings"].set_index("id").loc[owned, "height_confidence"].value_counts().to_dict() if owned else {}
    return {"scene": scene, "chunks": chunks, "metrics": {
        "scene_s": round(scene_s, 1), "render_s": round(render_s, 1), "pyramid_s": round(pyramid_s, 1),
        "chunks": len(chunks), "max_zoom_tiles_changed": len(changed), "ancestor_tiles_written": rebuilt,
        "objects": len(scene.objects), "buildings_owned": len(owned), "height_confidence": conf,
        "peak_memory_mb": peak_memory_mb()}, "owned": owned}


def validate_tile(idx: dict, tid: str, result: dict) -> list[str]:
    problems = []
    owned = set(result["owned"])
    if not owned:
        problems.append("no buildings owned by this tile")
    # 1. No building drawn by two tiles.
    for other in done_tiles(idx) - {tid}:
        p = OVERLAYS / f"{other}.json"
        if p.exists():
            dup = owned & {f["properties"]["id"] for f in json.loads(p.read_text(encoding="utf-8")) if f["properties"].get("layer") == "building"}
            if dup:
                problems.append(f"{len(dup)} buildings also owned by {other}")
    # 2. Every drawn building states where its height came from.
    b = merged_layers([tid])["buildings"].set_index("id")
    missing = [i for i in owned if i in b.index and (pd.isna(b.loc[i, "height_source"]) or pd.isna(b.loc[i, "height_confidence"]))]
    if missing:
        problems.append(f"{len(missing)} buildings without height source")
    # 3. Seams: chunks crossing the tile edge render identically as one region and as four quarters.
    scene, proj = result["scene"], result["scene"].proj
    e0, n0, e1, n1 = tile_bounds(tid)
    probes = [proj.to_px(e0, (n0 + n1) / 2, 0), proj.to_px(e1, (n0 + n1) / 2, 0), proj.to_px((e0 + e1) / 2, n1, 0)]
    for x, y in probes:
        cx, cy = int(x // CHUNK), int(y // CHUNK)
        if not (0 <= cx * CHUNK < proj.width and 0 <= cy * CHUNK < proj.height):
            continue
        w, h = min(CHUNK, proj.width - cx * CHUNK), min(CHUNK, proj.height - cy * CHUNK)
        whole = np.asarray(render_region(scene, cx * CHUNK, cy * CHUNK, w, h))
        quarters = np.zeros_like(whole)
        hw, hh = w // 2, h // 2
        for qx, qw in ((0, hw), (hw, w - hw)):
            for qy, qh in ((0, hh), (hh, h - hh)):
                quarters[qy:qy + qh, qx:qx + qw] = np.asarray(render_region(scene, cx * CHUNK + qx, cy * CHUNK + qy, qw, qh))
        diff = int(np.any(whole != quarters, axis=2).sum())
        if diff:
            problems.append(f"seam check failed in chunk {cx},{cy}: {diff} px differ")
    return problems


def run_tile(tid: str, force: bool = False) -> bool:
    idx = load_index()
    if tid not in idx["tiles"]:
        raise SystemExit(f"unknown tile {tid}; valid ids r0c0 … r{GRID - 1}c{GRID - 1}")
    status = idx["tiles"][tid]["status"]
    if status == "validated" and not force:
        print(f"{tid} already validated; use --force to regenerate")
        return True
    step = "fetch"
    try:
        fetch_tile(idx, tid, force=force)  # its buffer already covers features crossing into neighbours
        step = "render"
        result = render_tile(idx, tid)
        _set(idx, tid, "rendered", render=result["metrics"], rendered_at=_now())
        step = "validate"
        problems = validate_tile(idx, tid, result)
        proj = result["scene"].proj
        step = "pack"
        info = pack(proj)
        if problems:
            _set(idx, tid, "failed", error="; ".join(problems), step="validate")
        else:
            _set(idx, tid, "validated", validated_at=_now())
        publish(idx, proj, info)
        print(json.dumps({"tile": tid, "status": idx["tiles"][tid]["status"], **result["metrics"], "archive": info}, indent=1))
        return not problems
    except Exception as exc:  # recorded so the tile can be retried
        _set(idx, tid, "failed", error=f"{step}: {exc}", step=step, trace=traceback.format_exc()[-2000:])
        raise


# ---------------------------------------------------------------- CLI
def status_table(idx: dict) -> str:
    sym = {"pending": "·", "fetched": "f", "rendered": "r", "validated": "✓", "failed": "✗", "stale": "s"}
    rows = []
    for r in range(GRID - 1, -1, -1):
        rows.append(f"r{r} " + " ".join(f"{sym[idx['tiles'][f'r{r}c{c}']['status']]}" for c in range(GRID)))
    rows.append("   " + " ".join(f"{c}" for c in range(GRID)) + "   (cols, west→east; rows south→north)")
    counts = pd.Series([v["status"] for v in idx["tiles"].values()]).value_counts().to_dict()
    return "\n".join(rows) + f"\n{counts}"


def cli(argv: list[str]) -> None:
    p = argparse.ArgumentParser(prog="hitec-pipeline tiles")
    p.add_argument("action", choices=["index", "status", "next", "run", "mark-stale", "publish"])
    p.add_argument("tile", nargs="?")
    p.add_argument("--force", action="store_true", help="refetch and re-render even if done")
    a = p.parse_args(argv)
    idx = load_index()
    if a.action in ("index", "status"):
        print(status_table(idx))
        nxt = next_tile(idx)
        print("next:", nxt)
    elif a.action == "next":
        print(next_tile(idx))
    elif a.action == "run":
        tid = a.tile or next_tile(idx)
        if tid is None:
            print("all tiles done")
            return
        ok = run_tile(tid, force=a.force)
        print(status_table(load_index()))
        raise SystemExit(0 if ok else 1)
    elif a.action == "publish":  # rebuild archives and app outputs from existing renders
        proj = global_projection()
        publish(idx, proj, pack(proj))
        print(json.dumps(json.loads((OUT / "meta.json").read_text(encoding="utf-8"))["metrics"], indent=1))
    elif a.action == "mark-stale":
        if not a.tile:
            raise SystemExit("mark-stale needs a tile id")
        _set(idx, a.tile, "stale")
        print(status_table(idx))
