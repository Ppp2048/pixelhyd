"""Progressive generation of the city map as a grid of 1 km ground tiles.

Grid
    The original 5 km UTM square (`area.HITEC_CITY`) is split into 5 × 5 tiles
    of 1 km, ids `r{row}c{col}` with row 0 in the south and col 0 in the west.
    The grid keeps that alignment and grows outward over the city box
    `CITY_WSEN` (≈ the Outer Ring Road); rows/cols outside 0..4 are negative or
    ≥ 5 (e.g. `r-1c7`). The 5 km tiles' ids, data and art never move.

Continuity
    * One global isometric projection (the 5 km square's), so every tile lands
      in the same art-pixel space; art pixels may be negative beyond it.
    * Features are fetched with a buffer and merged across tiles by stable ids
      (Overture building id, OSM id) from a pinned Overture release.
    * A building is drawn by exactly one tile: the tile containing its
      representative point (no duplicates, no buildings cut in half).
    * Ground (land use, roads) is clipped to the union of completed tiles, and
      roads are buffered from full OSM geometry, so they continue across edges.
    * Rendering happens in fixed 1024 px art chunks with the seam-safe renderer.
      Each chunk is drawn from the data of every tile its pixels, tall buildings
      and shadows can come from, so a chunk renders the same whichever batch
      draws it.

Data
    Raw data is downloaded once per 5 km block (one Overpass and one Overture
    request for 25 tiles, which keeps us well within Overpass usage limits) and
    split per tile before normalisation.

Speed
    `batch.py` runs many tiles at once: data preparation, chunk rendering,
    overlays, the zoom pyramid and vector tiles all run in worker processes, and
    the archives are updated incrementally (only changed tiles are re-encoded).

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
import os
import shutil
import time
from datetime import UTC, datetime
from functools import lru_cache
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
from PIL import Image
from pmtiles.reader import MmapSource, Reader, all_tiles
from pmtiles.tile import Compression, TileType, zxy_to_tileid
from pmtiles.writer import write as pmtiles_write
from shapely.geometry import LineString, Polygon, box
from shapely.ops import unary_union

from . import DATA_ROOT
from .area import HITEC_CITY, PROTOTYPE, Square, to_utm, to_wgs
from .build import WEB_PUBLIC, _clean, _encode, building_silhouette, peak_memory_mb
from .fetch import fetch_all
from .iso import TILE, IsoProjection
from .normalise import normalise
from .render import render_region
from .scene import LAYERS, Building, Scene, build_scene_from_layers, read_layers

AREA = HITEC_CITY
TILE_M = 1000.0
GRID = int(AREA.size_m // TILE_M)  # 5: the original 5 km square
CITY_WSEN = (78.22, 17.20, 78.70, 17.60)  # west, south, east, north: how far the grid may grow
BLOCK = 5  # tiles per block side; raw data is downloaded per block
BUFFER_M = 200.0  # data fetched around each tile (roads/areas/buildings crossing the edge)
REACH_M = 220.0  # ground distance a tile's buildings/shadows can affect pixels beyond its edge
K = 4.0  # art px per metre (decision D3)
HEADROOM_M = 200.0  # fixed vertical room in the global canvas, independent of data
CHUNK = 1024  # render unit in art px (4 × 4 output tiles)
GROUP = 4  # chunks per render job side (4 × 4 chunks ≈ 1 km of screen)
OVERTURE_RELEASE = "2026-10-21.0"  # pinned so building ids stay stable across tiles
DATASET = f"{AREA.name}-k{K:g}"

INDEX_PATH = DATA_ROOT / "tiles" / AREA.name / "index.json"
OUT = DATA_ROOT / "out" / DATASET
STAGE = OUT / "stage"  # changed output tiles of the running batch (z/x_y.webp; empty file = delete)
OVERLAYS = OUT / "overlay"  # per ground tile overlay features (source of the vector tiles)
ART, VECTOR = "art", "overlay"  # archive kinds; files are versioned, see `current`

# Interactive overlay as vector tiles (image-space Web Mercator, same tiling as the art).
VT_MIN_ZOOM, VT_MAX_ZOOM = 14, 18  # MapLibre overzooms past 18; 18 keeps ≤ 0.25 art px precision
VT_EXTENT, VT_BUFFER = 4096, 64  # tile units; the buffer hides clip edges under MapLibre's tile stencil
VT_LAYERS = ("building", "road_centreline", "poi")
VT_FIELDS = {"building": {"id": "String", "name": "String", "use": "String", "height_m": "Number", "height_source": "String",
                          "height_confidence": "String", "footprint_source": "String", "osm_id": "String", "levels": "Number",
                          "area_m2": "Number", "depth": "Number", "tile": "String"},
             "road_centreline": {"highway": "String", "name": "String", "bridge": "Boolean", "tile": "String"},
             "poi": {"kind": "String", "name": "String", "osm_id": "String", "tile": "String"}}
ATTRIBUTION = "© OpenStreetMap contributors · Overture Maps Foundation"

DONE = ("rendered", "validated")
TODO = ("pending", "fetched", "failed", "stale")
KEYS = {"buildings": "id", "roads": "osm_id", "rail": "osm_id", "areas": "osm_id", "pois": "osm_id"}


# ---------------------------------------------------------------- grid
def tid_of(r: int, c: int) -> str:
    return f"r{r}c{c}"


def rc(tid: str) -> tuple[int, int]:
    r, c = tid[1:].split("c")
    return int(r), int(c)


def _city_range() -> tuple[range, range]:
    w, s, e, n = CITY_WSEN
    pts = [to_utm(lon, lat) for lon in (w, e) for lat in (s, n)]
    es, ns = [p[0] for p in pts], [p[1] for p in pts]
    row = lambda v: math.floor((v - AREA.core[1]) / TILE_M)  # noqa: E731
    col = lambda v: math.floor((v - AREA.core[0]) / TILE_M)  # noqa: E731
    return range(row(min(ns)), row(max(ns)) + 1), range(col(min(es)), col(max(es)) + 1)


CITY_ROWS, CITY_COLS = _city_range()


def in_city(r: int, c: int) -> bool:
    return r in CITY_ROWS and c in CITY_COLS


def tile_ids() -> list[str]:
    """The original 5 × 5 tiles."""
    return [tid_of(r, c) for r in range(GRID) for c in range(GRID)]


def city_tile_ids() -> list[str]:
    return [tid_of(r, c) for r in CITY_ROWS for c in CITY_COLS]


def tile_bounds(tid: str) -> tuple[float, float, float, float]:
    r, c = rc(tid)
    e0, n0 = AREA.core[0], AREA.core[1]
    return (e0 + c * TILE_M, n0 + r * TILE_M, e0 + (c + 1) * TILE_M, n0 + (r + 1) * TILE_M)


def tile_square(tid: str) -> Square:
    return Square(f"{AREA.name}/{tid}", tile_bounds(tid), BUFFER_M)


def owner_of(e: float, n: float) -> str | None:
    c = math.floor((e - AREA.core[0]) / TILE_M)
    r = math.floor((n - AREA.core[1]) / TILE_M)
    return tid_of(r, c) if in_city(r, c) else None


def neighbours(tid: str, ring: int = 1) -> list[str]:
    r, c = rc(tid)
    return [tid_of(rr, cc) for rr in range(r - ring, r + ring + 1) for cc in range(c - ring, c + ring + 1) if in_city(rr, cc)]


def tiles_in(geom) -> list[str]:
    """City tiles whose square intersects `geom` (UTM)."""
    e0, n0, e1, n1 = geom.bounds
    r0, r1 = math.floor((n0 - AREA.core[1]) / TILE_M), math.floor((n1 - AREA.core[1]) / TILE_M)
    c0, c1 = math.floor((e0 - AREA.core[0]) / TILE_M), math.floor((e1 - AREA.core[0]) / TILE_M)
    return [tid_of(r, c) for r in range(r0, r1 + 1) for c in range(c0, c1 + 1)
            if in_city(r, c) and geom.intersects(box(*tile_bounds(tid_of(r, c))))]


def ring_of(tid: str) -> int:
    """0 for the 5 km square, 1 for the tiles around it, and so on."""
    r, c = rc(tid)
    return max(max(0, -r, r - (GRID - 1)), max(0, -c, c - (GRID - 1)))


def global_projection() -> IsoProjection:
    return IsoProjection.for_square(AREA.core, K, HEADROOM_M)


def canvas(proj: IsoProjection) -> tuple[int, int, int, int]:
    """Art-pixel box (x0, y0, x1, y1) of the whole city grid, chunk-aligned; may be negative."""
    e0 = AREA.core[0] + CITY_COLS.start * TILE_M
    e1 = AREA.core[0] + CITY_COLS.stop * TILE_M
    n0 = AREA.core[1] + CITY_ROWS.start * TILE_M
    n1 = AREA.core[1] + CITY_ROWS.stop * TILE_M
    es, ns = np.array([e0, e1, e1, e0]), np.array([n0, n0, n1, n1])
    x, y = proj.to_px(es, ns, 0)
    _, top = proj.to_px(es, ns, HEADROOM_M)
    return (math.floor(x.min() / CHUNK) * CHUNK, math.floor(top.min() / CHUNK) * CHUNK,
            math.ceil(x.max() / CHUNK) * CHUNK, math.ceil(y.max() / CHUNK) * CHUNK)


# ---------------------------------------------------------------- index
def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _entry(tid: str) -> dict:
    b = tile_bounds(tid)
    w, s = to_wgs(b[0], b[1])
    e, n = to_wgs(b[2], b[3])
    pe0, pn0, pe1, pn1 = PROTOTYPE.core
    contains_proto = b[0] <= pe0 and pe1 <= b[2] and b[1] <= pn0 and pn1 <= b[3]
    return {"status": "pending", "bounds_utm": [round(v, 3) for v in b],
            "approx_wgs_sw_ne": [round(s, 6), round(w, 6), round(n, 6), round(e, 6)],
            "contains_prototype": contains_proto, "history": []}


def load_index() -> dict:
    if INDEX_PATH.exists():
        idx = json.loads(INDEX_PATH.read_text(encoding="utf-8"))
        idx.setdefault("city_wsen", list(CITY_WSEN))
        return idx
    idx = {
        "area": AREA.name, "crs": "EPSG:32644", "area_square_utm": list(AREA.core), "tile_m": TILE_M, "grid": GRID,
        "city_wsen": list(CITY_WSEN), "buffer_m": BUFFER_M, "k": K, "headroom_m": HEADROOM_M, "chunk_px": CHUNK,
        "overture_release": OVERTURE_RELEASE, "tiles": {tid: _entry(tid) for tid in tile_ids()},
    }
    save_index(idx)
    return idx


def ensure_tile(idx: dict, tid: str) -> dict:
    """Index entry of a city tile, created (pending) the first time the grid grows to it."""
    if tid not in idx["tiles"]:
        if not in_city(*rc(tid)):
            raise SystemExit(f"{tid} is outside the city box {CITY_WSEN}")
        idx["tiles"][tid] = _entry(tid)
    return idx["tiles"][tid]


def save_index(idx: dict) -> None:
    INDEX_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = INDEX_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(idx, indent=1), encoding="utf-8")
    tmp.replace(INDEX_PATH)  # atomic: a crash never leaves a half-written index


def _set(idx: dict, tid: str, status: str, save: bool = True, **info) -> None:
    t = ensure_tile(idx, tid)
    t["status"] = status
    t.update(info)
    t["history"].append({"at": _now(), "status": status, **{k: v for k, v in info.items() if k == "error"}})
    if save:
        save_index(idx)


def done_tiles(idx: dict) -> set[str]:
    return {t for t, v in idx["tiles"].items() if v["status"] in DONE}


def frontier(idx: dict, count: int) -> list[str]:
    """Next tiles to generate: the 5 km square first (prototype tile first), then ring by ring outward."""
    centre = (GRID - 1) / 2
    todo = [t for t in city_tile_ids() if idx["tiles"].get(t, {"status": "pending"})["status"] in TODO]
    todo.sort(key=lambda t: (ring_of(t), math.hypot(rc(t)[0] - centre, rc(t)[1] - centre), t))
    return todo[:count]


def next_tile(idx: dict) -> str | None:
    nxt = frontier(idx, 1)
    return nxt[0] if nxt else None


# ---------------------------------------------------------------- data
def _features(tid: str) -> Path:
    return DATA_ROOT / "work" / AREA.name / tid / "features.gpkg"


def _raw(name: str) -> Path:
    return DATA_ROOT / "raw" / name


def has_raw(path: Path) -> bool:
    return (path / "osm.json").exists() and (path / "overture_buildings.parquet").exists()


def block_of(tid: str) -> tuple[int, int]:
    r, c = rc(tid)
    return math.floor(r / BLOCK), math.floor(c / BLOCK)


def block_square(block: tuple[int, int]) -> Square:
    br, bc = block
    e0, n0 = AREA.core[0] + bc * BLOCK * TILE_M, AREA.core[1] + br * BLOCK * TILE_M
    side = BLOCK * TILE_M
    return Square(f"{AREA.name}/blocks/b{br}_{bc}", (e0, n0, e0 + side, n0 + side), BUFFER_M)


def fetch_block(block: tuple[int, int], force: bool = False) -> Path:
    """One Overture + one Overpass download for a 5 km block (plus buffer); tiles are cut from it."""
    sq = block_square(block)
    if force or not has_raw(_raw(sq.name)):
        fetch_all(sq, DATA_ROOT, OVERTURE_RELEASE, osm_timeout=900)
    return _raw(sq.name)


def split_block(tid: str) -> Path:
    """Write the tile's raw inputs as the subset of its block's downloads within the tile's fetch box."""
    sq = tile_square(tid)
    src, out = _raw(block_square(block_of(tid)).name), _raw(sq.name)
    out.mkdir(parents=True, exist_ok=True)
    w, s, e, n = sq.wgs_bbox()

    def hit(el: dict) -> bool:
        if el["type"] == "node":
            return s <= el["lat"] <= n and w <= el["lon"] <= e
        b = el.get("bounds")
        return b is not None and not (b["maxlat"] < s or b["minlat"] > n or b["maxlon"] < w or b["minlon"] > e)

    osm = json.loads((src / "osm.json").read_text(encoding="utf-8"))
    osm["elements"] = [el for el in osm["elements"] if hit(el)]
    (out / "osm.json").write_text(json.dumps(osm), encoding="utf-8")
    ov = gpd.read_parquet(src / "overture_buildings.parquet")
    bb = ov.geometry.bounds
    ov[(bb.maxx >= w) & (bb.minx <= e) & (bb.maxy >= s) & (bb.miny <= n)].to_parquet(out / "overture_buildings.parquet")
    manifest = json.loads((src / "manifest.json").read_text(encoding="utf-8"))
    for d in manifest["downloads"]:
        d["subset_of"] = f"{sq.name.rsplit('/', 1)[0]}/blocks/{src.name}/{d['file']} (clipped to this tile's fetch box)"
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return out


def prepare_tile(tid: str, force: bool = False) -> dict:
    """Worker: cut the tile's raw data from its block (unless it has its own download) and normalise it."""
    t0 = time.perf_counter()
    sq = tile_square(tid)
    raw = _raw(sq.name)
    split = force or not has_raw(raw)
    if split:
        split_block(tid)
    work = normalise(sq, DATA_ROOT)
    if split:  # the block download stays; the per-tile copy is redundant once normalised
        for name in ("osm.json", "overture_buildings.parquet"):
            (raw / name).unlink(missing_ok=True)
    rep = json.loads((work / "report.json").read_text(encoding="utf-8"))
    data = {k: rep.get(k) for k in ("buildings_count", "footprint_sources", "height_sources", "height_confidence",
                                    "roads_count", "rail_count", "areas_count", "pois_count", "invalid_fixed",
                                    "duplicates_dropped", "overlaps_dropped")}
    data["osm_base"] = next((d.get("osm_base") for d in rep.get("inputs", []) if d.get("osm_base")), None)
    return {"tid": tid, "data": data, "fetch_s": round(time.perf_counter() - t0, 1)}


@lru_cache(maxsize=24)
def _tile_layers(tid: str, mtime: float) -> dict[str, gpd.GeoDataFrame]:
    return read_layers(_features(tid))


def merged_layers(tids: list[str]) -> dict[str, gpd.GeoDataFrame]:
    """Union of the given tiles' features; duplicates (same id) keep the owner tile's copy."""
    parts: dict[str, list[gpd.GeoDataFrame]] = {k: [] for k in LAYERS}
    for tid in sorted(tids):
        f = _features(tid)
        if not f.exists():
            continue
        for name, gdf in _tile_layers(tid, f.stat().st_mtime).items():
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


def drawn_scene(proj: IsoProjection, tids: list[str], drawn: frozenset[str] | set[str], region=None):
    """Scene from the tiles' data: buildings owned by drawn tiles, ground clipped to drawn tiles (and `region`)."""
    layers = merged_layers([t for t in tids if _features(t).exists()])
    if not layers:
        return None, layers, {}
    if "buildings" not in layers:  # open country: still draw its ground, roads and water
        crs = next(iter(layers.values())).crs
        layers["buildings"] = gpd.GeoDataFrame({"id": pd.Series(dtype="object")}, geometry=gpd.GeoSeries([], crs=crs), crs=crs)
    if region is not None:
        layers = {k: g[g.intersects(region)].reset_index(drop=True) for k, g in layers.items()}
    owner: dict[str, str | None] = {}

    def owns(row) -> bool:
        p = row.geometry.representative_point()
        o = owner_of(p.x, p.y)
        owner[row.id] = o
        return o in drawn

    clip = unary_union([box(*tile_bounds(t)) for t in tids if t in drawn])
    if clip.is_empty:
        return None, layers, owner
    return build_scene_from_layers(layers, proj, clip, owns=owns, shadow_all=False), layers, owner


# ---------------------------------------------------------------- chunks
def affected_chunks(proj: IsoProjection, tid: str) -> list[tuple[int, int]]:
    """Chunks a tile's ground, buildings and shadows can change."""
    e0, n0, e1, n1 = tile_bounds(tid)
    e0, n0, e1, n1 = e0 - REACH_M, n0 - REACH_M, e1 + REACH_M, n1 + REACH_M
    es, ns = np.array([e0, e1, e1, e0]), np.array([n0, n0, n1, n1])
    x, y_low = proj.to_px(es, ns, 0)
    _, y_high = proj.to_px(es, ns, HEADROOM_M)
    cx0, cy0, cx1, cy1 = canvas(proj)
    x0, x1 = max(cx0, x.min()), min(cx1, x.max())
    y0, y1 = max(cy0, y_high.min()), min(cy1, y_low.max())
    return [(cx, cy) for cy in range(math.floor(y0 / CHUNK), math.ceil(y1 / CHUNK))
            for cx in range(math.floor(x0 / CHUNK), math.ceil(x1 / CHUNK))]


def chunk_region(proj: IsoProjection, chunks: list[tuple[int, int]]):
    """Ground (UTM) whose features can paint into the chunks: their footprint, plus room below for
    buildings rising into them, plus shadow reach."""
    rise = proj.v * HEADROOM_M
    polys = []
    for cx, cy in chunks:
        x0, y0, x1, y1 = cx * CHUNK, cy * CHUNK, (cx + 1) * CHUNK, (cy + 1) * CHUNK + rise
        e, n = proj.ground_from_px([x0, x1, x1, x0], [y0, y0, y1, y1])
        polys.append(Polygon(zip(e, n)))
    return unary_union(polys).buffer(REACH_M)


def group_chunks(chunks: list[tuple[int, int]], size: int = GROUP) -> list[list[tuple[int, int]]]:
    groups: dict[tuple[int, int], list] = {}
    for cx, cy in sorted(chunks, key=lambda c: (c[1], c[0])):
        groups.setdefault((cy // size, cx // size), []).append((cx, cy))
    return [groups[k] for k in sorted(groups)]


def _stage_path(z: int, x: int, y: int) -> Path:
    return STAGE / str(z) / f"{x}_{y}.webp"


def stage_chunk(proj: IsoProjection, img: Image.Image, cx: int, cy: int) -> list[tuple[int, int]]:
    """Cut a chunk into max-zoom output tiles in the stage (an empty file marks a tile to delete)."""
    origin = int(proj.origin_world // TILE)
    per = CHUNK // TILE
    out = []
    for j in range(per):
        for i in range(per):
            t = img.crop((i * TILE, j * TILE, (i + 1) * TILE, (j + 1) * TILE))
            x, y = origin + cx * per + i, origin + cy * per + j
            path = _stage_path(proj.zmax, x, y)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"" if t.getbbox() is None else _encode(t))
            out.append((x, y))
    return out


def render_job(chunks: list[tuple[int, int]], drawn: frozenset[str]) -> dict:
    """Worker: render a group of chunks from all data that can reach them and stage the output tiles."""
    t0 = time.perf_counter()
    proj = global_projection()
    region = chunk_region(proj, chunks)
    scene, _, _ = drawn_scene(proj, tiles_in(region), drawn, region)
    changed = []
    for cx, cy in chunks:
        img = render_region(scene, cx * CHUNK, cy * CHUNK, CHUNK, CHUNK) if scene else Image.new("RGBA", (CHUNK, CHUNK))
        changed.extend(stage_chunk(proj, img, cx, cy))
    return {"changed": changed, "objects": len(scene.objects) if scene else 0,
            "seconds": round(time.perf_counter() - t0, 1), "peak_memory_mb": peak_memory_mb()}


# ---------------------------------------------------------------- zoom pyramid and archives
def _archives() -> Path:
    return OUT / "archives.json"


def current(kind: str) -> Path:
    """The current version of an archive (`art` or `overlay`).

    Every update writes a new file name, so a file the dev server is reading is never
    replaced in place (Windows forbids that), and browsers never see a stale cache."""
    if _archives().exists():
        name = json.loads(_archives().read_text(encoding="utf-8")).get(kind)
        if name:
            return OUT / name
    return OUT / f"{kind}.pmtiles"  # written before archives were versioned


def _new_version(kind: str) -> Path:
    return OUT / f"{kind}.{datetime.now(UTC).strftime('%Y%m%d%H%M%S%f')}.pmtiles"


def _set_current(kind: str, path: Path) -> None:
    data = json.loads(_archives().read_text(encoding="utf-8")) if _archives().exists() else {}
    data[kind] = path.name
    _archives().write_text(json.dumps(data), encoding="utf-8")


def migrate_archives() -> None:
    """Give unversioned archives from earlier runs a version name."""
    for kind in (ART, VECTOR):
        legacy = OUT / f"{kind}.pmtiles"
        if legacy.exists() and current(kind) == legacy:
            new = _new_version(kind)
            os.replace(legacy, new)
            _set_current(kind, new)


def zoom_range(proj: IsoProjection) -> tuple[int, int]:
    x0, y0, x1, y1 = canvas(proj)
    n = math.ceil(max(x1 - x0, y1 - y0) / TILE)
    return proj.zmax - math.ceil(math.log2(n)), proj.zmax


class _Base:
    """Read access to the current (previous batch's) archive."""

    def __init__(self, path: Path):
        self.f = open(path, "rb") if path.exists() else None
        self.reader = Reader(MmapSource(self.f)) if self.f else None

    def get(self, z: int, x: int, y: int) -> bytes | None:
        return self.reader.get(z, x, y) if self.reader else None

    def close(self) -> None:
        if self.f:
            self.reader = None
            self.f.close()


def _staged_or_base(base: _Base, z: int, x: int, y: int) -> bytes | None:
    p = _stage_path(z, x, y)
    if p.exists():
        data = p.read_bytes()
        return data or None
    return base.get(z, x, y)


def ancestors_job(z: int, parents: list[tuple[int, int]]) -> int:
    """Worker: rebuild output tiles at zoom z from their four children (staged or in the archive)."""
    base = _Base(current(ART))
    written = 0
    try:
        for px, py in parents:
            canvas_img = Image.new("RGBA", (TILE * 2, TILE * 2), (0, 0, 0, 0))
            for dy in (0, 1):
                for dx in (0, 1):
                    data = _staged_or_base(base, z + 1, px * 2 + dx, py * 2 + dy)
                    if data:
                        canvas_img.paste(Image.open(io.BytesIO(data)).convert("RGBA"), (dx * TILE, dy * TILE))
            out = canvas_img.reduce(2)
            path = _stage_path(z, px, py)
            path.parent.mkdir(parents=True, exist_ok=True)
            if out.getbbox() is None:
                path.write_bytes(b"")
            else:
                path.write_bytes(_encode(out))
                written += 1
    finally:
        base.close()
    return written


def base_tiles_at(z: int) -> set[tuple[int, int]]:
    """All tiles of the current archive at zoom z (used when the pyramid gains lower zooms)."""
    path = current(ART)
    if not path.exists():
        return set()
    with open(path, "rb") as f:
        src = MmapSource(f)
        return {(x, y) for (zz, x, y), _ in all_tiles(src) if zz == z}


def archive_header(path: Path) -> dict | None:
    if not path.exists():
        return None
    with open(path, "rb") as f:
        return Reader(MmapSource(f)).header()


def _bounds_e7(proj: IsoProjection) -> dict:
    x0, y0, x1, y1 = canvas(proj)
    lon0, lat1 = proj.px_to_lonlat(x0, y0)
    lon1, lat0 = proj.px_to_lonlat(x1, y1)
    return {"min_lon_e7": int(math.floor(float(lon0) * 1e7)), "min_lat_e7": int(math.floor(float(lat0) * 1e7)),
            "max_lon_e7": int(math.ceil(float(lon1) * 1e7)), "max_lat_e7": int(math.ceil(float(lat1) * 1e7))}


def merge_archive(kind: str, staged: dict[int, bytes | None], header: dict, metadata: dict, keep_base: bool = True) -> dict:
    """Write a new version of an archive: the previous version's tiles, replaced or deleted by `staged`."""
    path = current(kind) if keep_base else OUT / "-"
    new = _new_version(kind)
    OUT.mkdir(parents=True, exist_ok=True)
    count = size = 0
    with pmtiles_write(str(new)) as w:
        def put(tid: int, data: bytes) -> None:
            nonlocal count, size
            w.write_tile(tid, data)
            count += 1
            size += len(data)

        fresh = sorted((t, d) for t, d in staged.items() if d)
        i = 0
        if path.exists():
            with open(path, "rb") as f:
                for (z, x, y), data in all_tiles(MmapSource(f)):
                    tid = zxy_to_tileid(z, x, y)
                    while i < len(fresh) and fresh[i][0] < tid:
                        put(*fresh[i])
                        i += 1
                    if tid not in staged:
                        put(tid, data)
        while i < len(fresh):
            put(*fresh[i])
            i += 1
        w.finalize(header, metadata)
    old = current(kind)
    _set_current(kind, new)
    if old.exists() and old != new:
        try:
            old.unlink()
        except OSError:
            pass  # still open somewhere; publish() retries the clean-up
    return {"tiles": count, "bytes": size}


def pack_art(proj: IsoProjection) -> dict:
    """Merge the staged output tiles into art.pmtiles."""
    zmin, zmax = zoom_range(proj)
    staged = {}
    for z in range(zmin, zmax + 1):
        d = STAGE / str(z)
        for p in d.glob("*.webp") if d.exists() else []:
            x, y = map(int, p.stem.split("_"))
            staged[zxy_to_tileid(z, x, y)] = p.read_bytes() or None
    header = {"tile_type": TileType.WEBP, "tile_compression": Compression.NONE, "min_zoom": zmin, "max_zoom": zmax,
              **_bounds_e7(proj), "center_zoom": zmax - 2}
    info = merge_archive(ART, staged, header, {"name": "Hyderabad isometric art", "attribution": ATTRIBUTION, "type": "overlay"})
    return {**info, "changed": len(staged), "min_zoom": zmin, "max_zoom": zmax}


# ---------------------------------------------------------------- overlay
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


def seam_problems(scene: Scene, tid: str) -> list[str]:
    """Chunks on the tile's edges must render identically as one region and as four quarters."""
    proj = scene.proj
    x0c, y0c, x1c, y1c = canvas(proj)
    e0, n0, e1, n1 = tile_bounds(tid)
    problems = []
    for x, y in (proj.to_px(e1, (n0 + n1) / 2, 0),):  # one edge chunk per tile; the renderer itself is unit-tested
        cx, cy = math.floor(x / CHUNK), math.floor(y / CHUNK)
        if not (x0c <= cx * CHUNK < x1c and y0c <= cy * CHUNK < y1c):
            continue
        whole = np.asarray(render_region(scene, cx * CHUNK, cy * CHUNK, CHUNK, CHUNK))
        quarters = np.zeros_like(whole)
        h = CHUNK // 2
        for qx in (0, h):
            for qy in (0, h):
                quarters[qy:qy + h, qx:qx + h] = np.asarray(render_region(scene, cx * CHUNK + qx, cy * CHUNK + qy, h, h))
        diff = int(np.any(whole != quarters, axis=2).sum())
        if diff:
            problems.append(f"seam check failed in chunk {cx},{cy}: {diff} px differ")
    return problems


def tile_job(tid: str, drawn: frozenset[str]) -> dict:
    """Worker: a tile's interactive overlay (building silhouettes, road centrelines, POIs) and its checks."""
    t0 = time.perf_counter()
    proj = global_projection()
    # Only the tile's own features: silhouettes, their depth order and the seam probe need nothing else.
    scene, layers, owner = drawn_scene(proj, neighbours(tid, 1), drawn, box(*tile_bounds(tid)).buffer(1.0))
    scene_s = time.perf_counter() - t0
    problems: list[str] = []
    owned: list[str] = []
    conf: dict = {}
    if scene is None:
        problems.append("no data for this tile")
    else:
        OVERLAYS.mkdir(parents=True, exist_ok=True)
        feats = tile_overlay(scene, layers, tid, owner)
        (OVERLAYS / f"{tid}.json").write_text(json.dumps(feats, ensure_ascii=False, allow_nan=False), encoding="utf-8")
        owned = [b for b, o in owner.items() if o == tid]
        b = layers["buildings"].set_index("id")
        if owned:
            conf = b.loc[owned, "height_confidence"].value_counts().to_dict()
            missing = [i for i in owned if pd.isna(b.loc[i, "height_source"]) or pd.isna(b.loc[i, "height_confidence"])]
            if missing:
                problems.append(f"{len(missing)} buildings without height source")
        problems += seam_problems(scene, tid)
    return {"tid": tid, "owned": owned, "problems": problems, "metrics": {
        "scene_s": round(scene_s, 1), "overlay_and_checks_s": round(time.perf_counter() - t0 - scene_s, 1),
        "objects": len(scene.objects) if scene else 0, "buildings_owned": len(owned), "height_confidence": conf,
        "peak_memory_mb": peak_memory_mb()}}


def overlay_ids(tid: str) -> set[str]:
    p = OVERLAYS / f"{tid}.json"
    if not p.exists():
        return set()
    return {f["properties"]["id"] for f in json.loads(p.read_text(encoding="utf-8")) if f["properties"].get("layer") == "building"}


# ---------------------------------------------------------------- vector tiles
def _to_world(proj: IsoProjection):
    def f(c: np.ndarray) -> np.ndarray:
        """Image-space lon/lat → world pixels at zmax (exact inverse of the art placement)."""
        x, y = proj.lonlat_to_px(c[:, 0], c[:, 1])
        return np.column_stack([x + proj.origin_world, y + proj.origin_world])
    return f


def _prepare(proj: IsoProjection, feats: list[dict]) -> tuple[list, np.ndarray]:
    from shapely import transform
    from shapely.geometry import shape

    to_world = _to_world(proj)
    prepared = []
    for f in feats:
        layer = f["properties"].get("layer")
        if layer not in VT_LAYERS:
            continue
        g = transform(shape(f["geometry"]), to_world)
        prepared.append((layer, g, {k: v for k, v in f["properties"].items() if k != "layer" and v is not None}))
    bounds = np.array([g.bounds for _, g, _ in prepared]).reshape(-1, 4)
    return prepared, bounds


def _encode_vt(prepared: list, bounds: np.ndarray, z: int, x: int, y: int, zmax: int) -> bytes | None:
    import gzip

    import mapbox_vector_tile
    from shapely import clip_by_rect
    from shapely.affinity import affine_transform

    span = TILE * 2 ** (zmax - z)  # world px (at zmax) per tile at zoom z
    buf = span * VT_BUFFER / VT_EXTENT
    ox, oy = x * span, y * span
    hit = np.nonzero((bounds[:, 2] >= ox - buf) & (bounds[:, 0] <= ox + span + buf)
                     & (bounds[:, 3] >= oy - buf) & (bounds[:, 1] <= oy + span + buf))[0]
    layers: dict[str, list] = {}
    s = VT_EXTENT / span
    for i in hit:
        layer, g, props = prepared[i]
        part = clip_by_rect(g, ox - buf, oy - buf, ox + span + buf, oy + span + buf)
        if part.is_empty:
            continue
        layers.setdefault(layer, []).append({"geometry": affine_transform(part, [s, 0, 0, s, -ox * s, -oy * s]), "properties": props})
    if not layers:
        return None
    data = mapbox_vector_tile.encode([{"name": n, "features": fs} for n, fs in layers.items()],
                                     default_options={"y_coord_down": True, "extents": VT_EXTENT})
    return gzip.compress(data, mtime=0)


def _vt_range(proj: IsoProjection, bbox_px: tuple[float, float, float, float], z: int) -> list[tuple[int, int]]:
    span = TILE * 2 ** (proj.zmax - z)
    buf = span * VT_BUFFER / VT_EXTENT
    x0, y0, x1, y1 = (v + proj.origin_world for v in bbox_px)
    return [(x, y) for y in range(math.floor((y0 - buf) / span), math.floor((y1 + buf) / span) + 1)
            for x in range(math.floor((x0 - buf) / span), math.floor((x1 + buf) / span) + 1)]


def ground_bbox_px(proj: IsoProjection, tid: str) -> tuple[float, float, float, float]:
    """Art-pixel box of everything a tile's overlay can contain (silhouettes rise up to the headroom)."""
    e0, n0, e1, n1 = tile_bounds(tid)
    es, ns = np.array([e0, e1, e1, e0]), np.array([n0, n0, n1, n1])
    x, y = proj.to_px(es, ns, 0)
    _, top = proj.to_px(es, ns, HEADROOM_M)
    return float(x.min()), float(top.min()), float(x.max()), float(y.max())


def vt_jobs(proj: IsoProjection, changed: list[str], done: set[str]) -> list[tuple[list, list[str]]]:
    """Vector tiles to re-encode (grouped by their zoom-14 ancestor) and the ground tiles feeding each group."""
    groups: dict[tuple[int, int], set] = {}
    for t in changed:
        bb = ground_bbox_px(proj, t)
        for z in range(VT_MIN_ZOOM, VT_MAX_ZOOM + 1):
            for x, y in _vt_range(proj, bb, z):
                sh = z - VT_MIN_ZOOM
                groups.setdefault((x >> sh, y >> sh), set()).add((z, x, y))
    boxes = {t: ground_bbox_px(proj, t) for t in done}
    jobs = []
    span = TILE * 2 ** (proj.zmax - VT_MIN_ZOOM)
    buf = span * VT_BUFFER / VT_EXTENT
    for (gx, gy), tiles in sorted(groups.items()):
        x0, y0 = gx * span - proj.origin_world - buf, gy * span - proj.origin_world - buf
        x1, y1 = x0 + span + 2 * buf, y0 + span + 2 * buf
        src = [t for t, b in boxes.items() if b[2] >= x0 and b[0] <= x1 and b[3] >= y0 and b[1] <= y1]
        jobs.append((sorted(tiles), sorted(src)))
    return jobs


def vt_job(tiles: list[tuple[int, int, int]], sources: list[str]) -> dict[int, bytes | None]:
    """Worker: encode a group of vector tiles from the overlays of the ground tiles that reach them."""
    proj = global_projection()
    feats = []
    for t in sources:
        p = OVERLAYS / f"{t}.json"
        if p.exists():
            feats.extend(json.loads(p.read_text(encoding="utf-8")))
    prepared, bounds = _prepare(proj, feats)
    return {zxy_to_tileid(z, x, y): _encode_vt(prepared, bounds, z, x, y, proj.zmax) for z, x, y in tiles}


def _vt_header_meta(proj: IsoProjection) -> tuple[dict, dict]:
    header = {"tile_type": TileType.MVT, "tile_compression": Compression.GZIP, "min_zoom": VT_MIN_ZOOM, "max_zoom": VT_MAX_ZOOM,
              **_bounds_e7(proj), "center_zoom": VT_MAX_ZOOM}
    meta = {"name": "Hyderabad overlay", "format": "pbf", "attribution": ATTRIBUTION,
            "vector_layers": [{"id": n, "fields": VT_FIELDS[n], "minzoom": VT_MIN_ZOOM, "maxzoom": VT_MAX_ZOOM} for n in VT_LAYERS]}
    return header, meta


def pack_vector(proj: IsoProjection, staged: dict[int, bytes | None], keep_base: bool = True) -> dict:
    header, meta = _vt_header_meta(proj)
    info = merge_archive(VECTOR, staged, header, meta, keep_base)
    return {"vector_tiles": info["tiles"], "bytes": info["bytes"], "changed": len(staged)}


def write_vector_overlay(proj: IsoProjection, feats: list[dict]) -> dict:
    """Encode overlay features (image-space lon/lat GeoJSON) from scratch as overlay.pmtiles."""
    prepared, bounds = _prepare(proj, feats)
    tiles: dict[int, bytes | None] = {}
    for z in range(VT_MIN_ZOOM, VT_MAX_ZOOM + 1):
        keys = set()
        for i in range(len(prepared)):
            x0, y0, x1, y1 = bounds[i] - proj.origin_world
            keys.update(_vt_range(proj, (x0, y0, x1, y1), z))
        for x, y in keys:
            tiles[zxy_to_tileid(z, x, y)] = _encode_vt(prepared, bounds, z, x, y, proj.zmax)
    info = pack_vector(proj, tiles, keep_base=False)
    return {"vector_tiles": info["vector_tiles"], "bytes": info["bytes"], "features": len(prepared)}


# ---------------------------------------------------------------- publish
def _link(src: Path, dst: Path) -> None:
    """Expose a file to the web app without a second copy (hard link; copy if linking is impossible)."""
    if dst.exists():
        return
    try:
        os.link(src, dst)
    except OSError:
        shutil.copy2(src, dst)


def publish(idx: dict, proj: IsoProjection) -> dict:
    """Write meta.json and expose the archives to the web app."""
    done = done_tiles(idx)
    if done:
        b = np.array([tile_bounds(t) for t in done])
        ce, cn = (b[:, 0].min() + b[:, 2].max()) / 2, (b[:, 1].min() + b[:, 3].max()) / 2
    else:
        ce, cn = AREA.centre_utm
    clon, clat = to_wgs(ce, cn)
    cx, cy = proj.to_px(ce, cn, 0)
    zmin, zmax = zoom_range(proj)
    migrate_archives()
    art_path, vec_path = current(ART), current(VECTOR)
    art, vec = archive_header(art_path) or {}, archive_header(vec_path) or {}
    meta = {
        "area": AREA.name, "k": K, "projection": proj.to_dict(), "canvas": list(canvas(proj)),
        "centre": {"lat": clat, "lon": clon, "art_px": [float(cx), float(cy)]},
        "core_square_utm": list(AREA.core), "zoom": {"min": zmin, "max": zmax},
        "attribution": "© OpenStreetMap contributors (ODbL) · Overture Maps Foundation (ODbL) · art generated by this project",
        "metrics": {"tiles_done": len(done), "art_tiles": art.get("addressed_tiles_count"),
                    "art_bytes": art_path.stat().st_size if art_path.exists() else 0,
                    "overlay_bytes": vec_path.stat().st_size if vec_path.exists() else 0,
                    "overlay_tiles": vec.get("addressed_tiles_count")},
        "art": art_path.name,
        "overlay": {"type": "vector", "url": vec_path.name, "layers": list(VT_LAYERS), "minzoom": VT_MIN_ZOOM, "maxzoom": VT_MAX_ZOOM},
        "grid": {"tile_m": TILE_M, "city_wsen": list(CITY_WSEN), "done": sorted(done, key=rc)},
    }
    (OUT / "meta.json").write_text(json.dumps(meta, indent=1), encoding="utf-8")
    web = WEB_PUBLIC / DATASET
    web.mkdir(parents=True, exist_ok=True)
    for stale in ("overlay.geojson", "grid.geojson"):
        (web / stale).unlink(missing_ok=True)
        (OUT / stale).unlink(missing_ok=True)
    live = {art_path.name, vec_path.name}
    for path in (art_path, vec_path):
        if path.exists():
            _link(path, web / path.name)
    shutil.copy2(OUT / "meta.json", web / "meta.json")
    for folder in (OUT, web):  # earlier versions; one still being read is removed next time
        for old in folder.glob("*.pmtiles"):
            if old.name not in live:
                try:
                    old.unlink()
                except OSError:
                    pass
    return meta["metrics"]


# ---------------------------------------------------------------- CLI
def status_table(idx: dict) -> str:
    sym = {"pending": "·", "fetched": "f", "rendered": "r", "validated": "✓", "failed": "✗", "stale": "s"}
    known = [rc(t) for t in idx["tiles"]]
    r0, r1 = min(r for r, _ in known), max(r for r, _ in known)
    c0, c1 = min(c for _, c in known), max(c for _, c in known)
    rows = []
    for r in range(r1, r0 - 1, -1):
        rows.append(f"r{r:<3}" + "".join(sym[idx["tiles"].get(tid_of(r, c), {"status": "pending"})["status"]] for c in range(c0, c1 + 1)))
    rows.append(f"     cols {c0}…{c1} west→east, rows south→north; city grid rows {CITY_ROWS.start}…{CITY_ROWS.stop - 1}, "
                f"cols {CITY_COLS.start}…{CITY_COLS.stop - 1} ({len(CITY_ROWS) * len(CITY_COLS)} tiles)")
    counts = pd.Series([v["status"] for v in idx["tiles"].values()]).value_counts().to_dict()
    return "\n".join(rows) + f"\n{counts}"


def cli(argv: list[str]) -> None:
    from . import batch

    p = argparse.ArgumentParser(prog="hitec-pipeline tiles")
    p.add_argument("action", choices=["index", "status", "next", "run", "batch", "mark-stale", "publish"])
    p.add_argument("tiles", nargs="*", help="tile ids (default: the next tiles outward)")
    p.add_argument("--count", type=int, default=24, help="batch: how many tiles")
    p.add_argument("--step", type=int, default=batch.DEFAULT_STEP,
                   help="batch: publish every STEP tiles (strips of neighbours); 0 = one batch")
    p.add_argument("--workers", type=int, default=batch.DEFAULT_WORKERS, help="parallel worker processes")
    p.add_argument("--force", action="store_true", help="re-prepare data and re-render even if done")
    p.add_argument("--rerender", action="store_true", help="re-render done tiles without touching their data")
    a = p.parse_args(argv)
    idx = load_index()
    if a.action in ("index", "status"):
        print(status_table(idx))
        print("next:", next_tile(idx))
    elif a.action == "next":
        print(next_tile(idx))
    elif a.action in ("run", "batch"):
        tids = a.tiles or (frontier(idx, 1 if a.action == "run" else a.count))
        if not tids:
            print("all city tiles done")
            return
        parts = [tids] if a.action == "run" else batch.strips(tids, a.step)
        if (left := batch.interrupted()) and not (a.force or a.rerender):  # finish a stopped batch first
            parts = [left] + [q for q in ([t for t in part if t not in left] for part in parts) if q]
        ok = True
        for i, part in enumerate(parts, 1):
            if len(parts) > 1:
                print(f"--- part {i}/{len(parts)}: {len(part)} tiles", flush=True)
            ok = batch.run_batch(part, workers=a.workers, force=a.force, rerender=a.rerender) and ok
        print(status_table(load_index()))
        raise SystemExit(0 if ok else 1)
    elif a.action == "publish":
        print(json.dumps(publish(idx, global_projection()), indent=1))
    elif a.action == "mark-stale":
        if not a.tiles:
            raise SystemExit("mark-stale needs tile ids")
        for t in a.tiles:
            _set(idx, t, "stale")
        print(status_table(idx))
