"""Scene → art → tiles (PMTiles) + overlay GeoJSON + metadata, with metrics."""

from __future__ import annotations

import ctypes
import io
import json
import math
import shutil
import sys
import time
from ctypes import wintypes
from pathlib import Path

import numpy as np
from PIL import Image
from pmtiles.tile import Compression, TileType, zxy_to_tileid
from pmtiles.writer import write as pmtiles_write
from shapely.geometry import LineString, Polygon, mapping
from shapely.ops import unary_union

from .area import Area, to_wgs
from .iso import TILE
from .render import render_canvas
from .scene import Building, Scene, build_scene

WEB_PUBLIC = Path(__file__).resolve().parents[3] / "web" / "public" / "tiles"


# ---------------------------------------------------------------- metrics
def peak_memory_mb() -> float | None:
    if sys.platform != "win32":
        import resource

        return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024

    class PMC(ctypes.Structure):
        _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD), ("PeakWorkingSetSize", ctypes.c_size_t),
                    ("WorkingSetSize", ctypes.c_size_t), ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPagedPoolUsage", ctypes.c_size_t), ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaNonPagedPoolUsage", ctypes.c_size_t), ("PagefileUsage", ctypes.c_size_t),
                    ("PeakPagefileUsage", ctypes.c_size_t)]

    pmc = PMC()
    pmc.cb = ctypes.sizeof(PMC)
    get_proc = ctypes.windll.kernel32.GetCurrentProcess
    get_proc.restype = wintypes.HANDLE
    info = ctypes.windll.psapi.GetProcessMemoryInfo
    info.argtypes = [wintypes.HANDLE, ctypes.POINTER(PMC), wintypes.DWORD]
    info.restype = wintypes.BOOL
    ok = info(get_proc(), ctypes.byref(pmc), pmc.cb)
    return round(pmc.PeakWorkingSetSize / 1048576, 1) if ok else None


# ---------------------------------------------------------------- tiles
def _encode(tile: Image.Image) -> bytes:
    buf = io.BytesIO()
    # Lossless keeps pixel art exact; method 2 trades a little size for ~10× faster encoding.
    tile.save(buf, "WEBP", lossless=True, quality=60, method=2)
    return buf.getvalue()


def write_pmtiles(img: Image.Image, scene: Scene, path: Path) -> dict:
    proj = scene.proj
    zmax = proj.zmax
    origin_tile = int(proj.origin_world // TILE)
    W, H = img.size
    levels: dict[int, dict[tuple[int, int], Image.Image]] = {zmax: {}}
    for ty in range(math.ceil(H / TILE)):
        for tx in range(math.ceil(W / TILE)):
            t = Image.new("RGBA", (TILE, TILE), (0, 0, 0, 0))
            t.paste(img.crop((tx * TILE, ty * TILE, min(W, (tx + 1) * TILE), min(H, (ty + 1) * TILE))), (0, 0))
            if t.getbbox() is not None:
                levels[zmax][(origin_tile + tx, origin_tile + ty)] = t
    z = zmax
    while len(levels[z]) > 1:
        parents: dict[tuple[int, int], Image.Image] = {}
        for (x, y), t in levels[z].items():
            key = (x // 2, y // 2)
            canvas = parents.setdefault(key, Image.new("RGBA", (TILE * 2, TILE * 2), (0, 0, 0, 0)))
            canvas.paste(t, ((x % 2) * TILE, (y % 2) * TILE))
        z -= 1
        levels[z] = {k: v.reduce(2) for k, v in parents.items()}
    zmin = z

    entries = sorted(((zxy_to_tileid(zz, x, y), t) for zz, tiles in levels.items() for (x, y), t in tiles.items()), key=lambda e: e[0])
    stats = {"tiles": len(entries), "bytes": 0, "min_zoom": zmin, "max_zoom": zmax}
    lon0, lat1 = proj.px_to_lonlat(0, 0)
    lon1, lat0 = proj.px_to_lonlat(W, H)
    with pmtiles_write(str(path)) as writer:
        for tid, t in entries:
            data = _encode(t)
            stats["bytes"] += len(data)
            writer.write_tile(tid, data)
        writer.finalize(
            {
                "tile_type": TileType.WEBP, "tile_compression": Compression.NONE,
                "min_zoom": zmin, "max_zoom": zmax,
                "min_lon_e7": int(math.floor(float(lon0) * 1e7)), "min_lat_e7": int(math.floor(float(lat0) * 1e7)),
                "max_lon_e7": int(math.ceil(float(lon1) * 1e7)), "max_lat_e7": int(math.ceil(float(lat1) * 1e7)),
                "center_zoom": zmax - 2,
            },
            {"name": "HITEC City isometric art", "attribution": "© OpenStreetMap contributors · Overture Maps Foundation", "type": "overlay"},
        )
    return stats


# ---------------------------------------------------------------- overlay
def _lonlat_ring(scene: Scene, xs, ys) -> list[list[float]]:
    lon, lat = scene.proj.px_to_lonlat(np.asarray(xs), np.asarray(ys))
    return [[round(float(a), 9), round(float(b), 9)] for a, b in zip(lon, lat)]


def _clean(props: dict) -> dict:
    """JSON-safe values: pandas NaN/None → null, numpy scalars → Python numbers."""
    out = {}
    for k, v in props.items():
        if v is None or (isinstance(v, float) and math.isnan(v)):
            out[k] = None
        elif isinstance(v, np.generic):
            v = v.item()
            out[k] = None if isinstance(v, float) and math.isnan(v) else v
        else:
            out[k] = v
    return out


def building_silhouette(scene: Scene, b: Building) -> Polygon:
    p = scene.proj
    ring = b.ring
    x0, y0 = p.to_px(ring[:, 0], ring[:, 1], 0)
    x1, y1 = p.to_px(ring[:, 0], ring[:, 1], b.height)
    parts = [Polygon(zip(x0, y0)), Polygon(zip(x1, y1))]
    for i in range(len(ring) - 1):
        quad = Polygon([(x0[i], y0[i]), (x0[i + 1], y0[i + 1]), (x1[i + 1], y1[i + 1]), (x1[i], y1[i])])
        if quad.is_valid and quad.area > 0:
            parts.append(quad)
    return unary_union(parts).buffer(0)


def write_overlay(scene: Scene, features: Path, path: Path) -> int:
    import geopandas as gpd

    buildings = gpd.read_file(features, layer="buildings").set_index("id")
    feats = []
    for obj in scene.objects:
        b = obj.item
        if not isinstance(b, Building):
            continue
        sil = building_silhouette(scene, b)
        geoms = [sil] if isinstance(sil, Polygon) else list(sil.geoms)
        r = buildings.loc[b.id]
        props = _clean({
            "id": b.id, "name": r["name"], "use": r["use"], "levels": r["levels"],
            "height_m": r["height_m"], "height_source": r["height_source"], "height_confidence": r["height_confidence"],
            "footprint_source": r["footprint_source"], "osm_id": r["osm_id"], "area_m2": r["area_m2"],
            "depth": obj.depth,
        })
        for g in geoms:
            feats.append({"type": "Feature", "properties": {"layer": "building", **props},
                          "geometry": {"type": "Polygon", "coordinates": [_lonlat_ring(scene, *np.asarray(g.exterior.coords).T)]}})
    # Debug alignment layer: OSM road centrelines at ground level (z = 0).
    roads = gpd.read_file(features, layer="roads")
    for row in roads.itertuples():
        g = row.geometry.intersection(scene.core)
        for line in (getattr(g, "geoms", None) or [g]):
            if not isinstance(line, LineString) or line.is_empty:
                continue
            c = np.asarray(line.coords)
            x, y = scene.proj.to_px(c[:, 0], c[:, 1], 0)
            feats.append({"type": "Feature", "properties": _clean({"layer": "road_centreline", "highway": row.highway, "name": row.name, "bridge": bool(row.bridge)}),
                          "geometry": {"type": "LineString", "coordinates": _lonlat_ring(scene, x, y)}})
    pois = gpd.read_file(features, layer="pois")
    for row in pois.itertuples():
        if row.kind == "tree" or not scene.core.contains(row.geometry):
            continue
        x, y = scene.proj.to_px(row.geometry.x, row.geometry.y, 0)
        lon, lat = scene.proj.px_to_lonlat(x, y)
        feats.append({"type": "Feature", "properties": _clean({"layer": "poi", "kind": row.kind, "name": row.name, "osm_id": row.osm_id}),
                      "geometry": {"type": "Point", "coordinates": [float(lon), float(lat)]}})
    c = np.asarray(scene.core.exterior.coords)
    x, y = scene.proj.to_px(c[:, 0], c[:, 1], 0)
    feats.append({"type": "Feature", "properties": {"layer": "core"}, "geometry": {"type": "Polygon", "coordinates": [_lonlat_ring(scene, x, y)]}})
    path.write_text(json.dumps({"type": "FeatureCollection", "features": feats}, ensure_ascii=False, allow_nan=False))
    return len(feats)


# ---------------------------------------------------------------- orchestration
def build(area: Area, data_root: Path, k: float = 4.0, chunk: int = 0) -> Path:
    features = data_root / "work" / area.name / "features.gpkg"
    tag = f"{area.name}-k{k:g}"
    out = data_root / "out" / tag
    out.mkdir(parents=True, exist_ok=True)
    metrics: dict = {"k": k, "chunk": chunk}

    t = time.perf_counter()
    scene = build_scene(area, features, k)
    metrics["scene_s"] = round(time.perf_counter() - t, 2)
    metrics["objects"] = len(scene.objects)

    t = time.perf_counter()
    img = render_canvas(scene, chunk)
    metrics["render_s"] = round(time.perf_counter() - t, 2)
    metrics["canvas_px"] = list(img.size)
    rgb = np.asarray(img)
    opaque = rgb[..., 3] > 0
    metrics["unique_colours"] = int(len(np.unique(rgb[opaque][:, :3], axis=0)))
    img.save(out / "art.png", optimize=True)

    t = time.perf_counter()
    metrics["tiles"] = write_pmtiles(img, scene, out / "art.pmtiles")
    metrics["tiles_s"] = round(time.perf_counter() - t, 2)

    t = time.perf_counter()
    metrics["overlay_features"] = write_overlay(scene, features, out / "overlay.geojson")
    metrics["overlay_bytes"] = (out / "overlay.geojson").stat().st_size
    metrics["overlay_s"] = round(time.perf_counter() - t, 2)
    metrics["peak_memory_mb"] = peak_memory_mb()

    clon, clat = to_wgs(*area.centre_utm)
    cx, cy = scene.proj.to_px(*area.centre_utm, 0)
    meta = {
        "area": area.name, "k": k, "projection": scene.proj.to_dict(),
        "centre": {"lat": clat, "lon": clon, "art_px": [float(cx), float(cy)]},
        "core_square_utm": list(area.core), "zoom": {"min": metrics["tiles"]["min_zoom"], "max": metrics["tiles"]["max_zoom"]},
        "attribution": "© OpenStreetMap contributors (ODbL) · Overture Maps Foundation (ODbL) · art generated by this project",
        "metrics": metrics,
    }
    (out / "meta.json").write_text(json.dumps(meta, indent=2))

    web = WEB_PUBLIC / tag
    web.mkdir(parents=True, exist_ok=True)
    for name in ("art.pmtiles", "overlay.geojson", "meta.json"):
        shutil.copy2(out / name, web / name)
    print(json.dumps(metrics, indent=1))
    return out
