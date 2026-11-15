"""Turn raw downloads into clean, projected feature layers.

Output: data/work/<area>/features.gpkg (EPSG:32644, metres) with layers
`buildings`, `roads`, `rail`, `areas`, `pois`, plus report.json.

Rules:
- Overture is the single footprint source (it already conflates OSM and ML
  footprints). OSM tags are joined through the OSM ids Overture keeps in
  `sources[].record_id`, so no building is counted twice.
- Every building carries `height_m`, `height_source` and `height_confidence`.
  Nothing estimated is presented as verified.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import geopandas as gpd
import numpy as np
from shapely import make_valid
from shapely.geometry import LineString, MultiPolygon, Point, Polygon
from shapely.ops import polygonize, unary_union

from .area import UTM44N, Area

# ---------------------------------------------------------------- heights
FLOOR_HEIGHT = {"residential": 3.2, "apartments": 3.2, "house": 3.2, "office": 3.8, "commercial": 3.8}
DEFAULT_FLOOR = 3.5
ROOF_ALLOWANCE = 1.2  # parapet / roof structures

MIN_AREA_M2 = 8.0


def seeded_unit(key: str, salt: str = "") -> float:
    """Deterministic number in [0, 1) from a feature id (stable across runs and chunks)."""
    h = hashlib.blake2b(f"{key}|{salt}".encode(), digest_size=8).digest()
    return int.from_bytes(h, "big") / 2**64


def _parse_float(value) -> float | None:
    if value is None:
        return None
    try:
        return float(str(value).split(";")[0].replace("m", "").strip())
    except ValueError:
        return None


def estimate_height(fid: str, use: str, area_m2: float, tags: dict, ov_height, ov_floors) -> tuple[float, str, str]:
    """Return (height_m, source, confidence) using the documented priority chain."""
    for value, src in ((tags.get("height"), "osm_height"), (ov_height, "overture_height")):
        h = _parse_float(value)
        if h and 2 <= h <= 400:
            return h, src, "verified"
    floor_h = FLOOR_HEIGHT.get(use, DEFAULT_FLOOR)
    for value, src in ((tags.get("building:levels"), "osm_levels"), (ov_floors, "overture_floors")):
        n = _parse_float(value)
        if n and 1 <= n <= 120:
            return n * floor_h + ROOF_ALLOWANCE, src, "derived"
    # Estimate (Open Buildings 2.5D will replace most of these in phase 2).
    if use in ("house", "residential", "apartments") and area_m2 < 250:
        floors = 2 + round(seeded_unit(fid, "floors") * 2)  # 2–4 floors
    elif area_m2 < 150:
        floors = 2 + round(seeded_unit(fid, "floors"))
    elif area_m2 < 600:
        floors = 3 + round(seeded_unit(fid, "floors") * 3)
    elif area_m2 < 2000:
        floors = 5 + round(seeded_unit(fid, "floors") * 5)
    else:
        floors = 8 + round(seeded_unit(fid, "floors") * 8)
    return floors * floor_h + ROOF_ALLOWANCE, "estimate_class_area", "estimated"


# ---------------------------------------------------------------- roads
ROAD_WIDTH = {  # metres, used only when the way has no `lanes`/`width` tag
    "motorway": 24, "trunk": 20, "primary": 16, "primary_link": 7, "secondary": 12, "secondary_link": 6,
    "tertiary": 9, "tertiary_link": 5, "residential": 6, "unclassified": 6, "living_street": 5,
    "service": 4, "track": 3, "footway": 2, "path": 1.5, "pedestrian": 4, "cycleway": 2, "steps": 2,
}
LANE_WIDTH = 3.5


def road_width(tags: dict) -> tuple[float, str]:
    w = _parse_float(tags.get("width"))
    if w and 1 <= w <= 60:
        return w, "osm_width"
    lanes = _parse_float(tags.get("lanes"))
    if lanes and 1 <= lanes <= 12:
        return lanes * LANE_WIDTH, "osm_lanes"
    return ROAD_WIDTH.get(tags.get("highway", ""), 4), "estimated_class"


# ---------------------------------------------------------------- OSM parsing
AREA_KEYS = ("landuse", "leisure", "natural", "amenity")


def _way_geom(el: dict):
    coords = [(p["lon"], p["lat"]) for p in el.get("geometry", []) if p]
    if len(coords) < 2:
        return None
    if len(coords) >= 4 and coords[0] == coords[-1]:
        return Polygon(coords)
    return LineString(coords)


def _relation_geom(el: dict):
    outers, inners = [], []
    for m in el.get("members", []):
        if m.get("type") != "way" or not m.get("geometry"):
            continue
        line = LineString([(p["lon"], p["lat"]) for p in m["geometry"]])
        (inners if m.get("role") == "inner" else outers).append(line)
    polys = list(polygonize(unary_union(outers))) if outers else []
    if not polys:
        return None
    shape = unary_union(polys)
    holes = list(polygonize(unary_union(inners))) if inners else []
    return shape.difference(unary_union(holes)) if holes else shape


def _osm_frames(osm_path: Path) -> dict[str, gpd.GeoDataFrame]:
    data = json.loads(osm_path.read_text(encoding="utf-8"))
    rows: dict[str, list] = {k: [] for k in ("building_tags", "roads", "rail", "areas", "pois")}
    for el in data["elements"]:
        tags = el.get("tags", {})
        oid = f"{el['type'][0]}{el['id']}"
        if el["type"] == "node":
            if tags.get("natural") == "tree":
                rows["pois"].append({"osm_id": oid, "kind": "tree", "name": None, "geometry": Point(el["lon"], el["lat"])})
            elif any(k in tags for k in ("amenity", "shop", "office")):
                kind = tags.get("amenity") or (f"shop:{tags['shop']}" if "shop" in tags else f"office:{tags['office']}")
                rows["pois"].append({"osm_id": oid, "kind": kind, "name": tags.get("name"), "name_te": tags.get("name:te"), "geometry": Point(el["lon"], el["lat"])})
            continue
        geom = _way_geom(el) if el["type"] == "way" else _relation_geom(el)
        if geom is None:
            continue
        if "building" in tags:
            rows["building_tags"].append({"osm_id": oid, "tags": json.dumps(tags, ensure_ascii=False)})
        elif "highway" in tags and isinstance(geom, LineString | Polygon):
            line = geom if isinstance(geom, LineString) else geom.exterior
            width, wsrc = road_width(tags)
            rows["roads"].append({
                "osm_id": oid, "highway": tags["highway"], "name": tags.get("name"), "name_te": tags.get("name:te"),
                "width_m": width, "width_source": wsrc, "bridge": tags.get("bridge") not in (None, "no"),
                "tunnel": tags.get("tunnel") not in (None, "no"), "layer": int(_parse_float(tags.get("layer")) or 0),
                "oneway": tags.get("oneway") == "yes", "geometry": line,
            })
        elif "railway" in tags and isinstance(geom, LineString):
            rows["rail"].append({
                "osm_id": oid, "railway": tags["railway"], "name": tags.get("name"),
                "bridge": tags.get("bridge") not in (None, "no"), "layer": int(_parse_float(tags.get("layer")) or 0),
                "geometry": geom,
            })
        elif any(k in tags for k in AREA_KEYS) and isinstance(geom, Polygon | MultiPolygon):
            key = next(k for k in AREA_KEYS if k in tags)
            rows["areas"].append({"osm_id": oid, "kind": f"{key}:{tags[key]}", "name": tags.get("name"), "geometry": geom})
    frames = {}
    for name, items in rows.items():
        if name == "building_tags":
            frames[name] = items
            continue
        frames[name] = gpd.GeoDataFrame(items, geometry="geometry", crs="EPSG:4326").to_crs(UTM44N) if items else None
    return frames


# ---------------------------------------------------------------- buildings
def _building_use(ov_class, ov_subtype, tags: dict) -> str:
    b = tags.get("building")
    if b and b not in ("yes",):
        return b
    return ov_class or ov_subtype or ("office" if "office" in tags else "unknown")


def _buildings(overture_path: Path, osm_tags: list[dict], report: dict) -> gpd.GeoDataFrame:
    # `class` is a Python keyword, which itertuples() can't expose as an attribute.
    ov = gpd.read_parquet(overture_path).to_crs(UTM44N).rename(columns={"class": "bclass"})
    tag_by_id = {row["osm_id"]: json.loads(row["tags"]) for row in osm_tags}
    records, seen_hash = [], set()
    report.update(invalid_fixed=0, slivers_dropped=0, duplicates_dropped=0)
    for row in ov.itertuples():
        geom = row.geometry
        if not geom.is_valid:
            geom = make_valid(geom)
            report["invalid_fixed"] += 1
        if isinstance(geom, MultiPolygon):
            geom = max(geom.geoms, key=lambda p: p.area)
        if not isinstance(geom, Polygon) or geom.area < MIN_AREA_M2:
            report["slivers_dropped"] += 1
            continue
        geom = geom.simplify(0.25, preserve_topology=True)
        ghash = hashlib.sha1(np.round(np.asarray(geom.exterior.coords), 2).tobytes()).hexdigest()
        if ghash in seen_hash:
            report["duplicates_dropped"] += 1
            continue
        seen_hash.add(ghash)
        sources = list(row.sources) if row.sources is not None else []
        dataset = sources[0]["dataset"] if sources else "unknown"
        osm_id, tags = None, {}
        for s in sources:
            rid = s.get("record_id") or ""
            if s.get("dataset") == "OpenStreetMap" and rid[:1] in "wr":
                osm_id = rid.split("@")[0]
                tags = tag_by_id.get(osm_id, {})
        use = _building_use(row.bclass, row.subtype, tags)
        names = row.names if isinstance(row.names, dict) else {}
        name = tags.get("name") or (names.get("primary") if names else None)
        h, hsrc, hconf = estimate_height(row.id, use, geom.area, tags, row.height, row.num_floors)
        records.append({
            "id": row.id, "osm_id": osm_id, "footprint_source": dataset, "name": name,
            "name_te": tags.get("name:te"), "use": use, "levels": _parse_float(tags.get("building:levels")) or row.num_floors,
            "height_m": round(float(h), 1), "height_source": hsrc, "height_confidence": hconf,
            "area_m2": round(geom.area, 1), "geometry": geom,
        })
    gdf = gpd.GeoDataFrame(records, geometry="geometry", crs=UTM44N)
    # Flag heavy overlaps (typically an ML footprint duplicating an OSM one): keep the higher-priority source.
    priority = {"OpenStreetMap": 0, "Esri Community Maps": 1, "Google Open Buildings": 2, "Microsoft ML Buildings": 3}
    gdf["prio"] = gdf["footprint_source"].map(priority).fillna(9)
    drop = set()
    sindex = gdf.sindex
    for i, geom in enumerate(gdf.geometry):
        for j in sindex.query(geom, predicate="intersects"):
            if j <= i or j in drop or i in drop:
                continue
            inter = geom.intersection(gdf.geometry.iloc[j]).area
            if inter > 0.5 * min(geom.area, gdf.geometry.iloc[j].area):
                drop.add(j if gdf.prio.iloc[j] >= gdf.prio.iloc[i] else i)
    report["overlaps_dropped"] = len(drop)
    gdf = gdf.drop(index=gdf.index[list(drop)]).drop(columns="prio").reset_index(drop=True)
    return gdf


def normalise(area: Area, data_root: Path) -> Path:
    raw = data_root / "raw" / area.name
    out_dir = data_root / "work" / area.name
    out_dir.mkdir(parents=True, exist_ok=True)
    report: dict = {"area": area.name, "crs": UTM44N, "core_square_m": area.core, "fetch_square_m": area.fetch}

    frames = _osm_frames(raw / "osm.json")
    buildings = _buildings(raw / "overture_buildings.parquet", frames["building_tags"], report)

    fetch_box = Polygon.from_bounds(*area.fetch)
    out = out_dir / "features.gpkg"
    if out.exists():
        out.unlink()
    buildings.to_file(out, layer="buildings", driver="GPKG")
    for name in ("roads", "rail", "areas", "pois"):
        gdf = frames[name]
        if gdf is None or gdf.empty:
            continue
        gdf = gdf[gdf.intersects(fetch_box)].copy()
        gdf.to_file(out, layer=name, driver="GPKG")
        report[f"{name}_count"] = len(gdf)

    report["buildings_count"] = len(buildings)
    report["footprint_sources"] = buildings["footprint_source"].value_counts().to_dict()
    report["height_sources"] = buildings["height_source"].value_counts().to_dict()
    report["height_confidence"] = buildings["height_confidence"].value_counts().to_dict()
    report["osm_tag_joined"] = int(buildings["osm_id"].notna().sum())
    if frames["roads"] is not None:
        report["road_width_sources"] = frames["roads"]["width_source"].value_counts().to_dict()
    manifest = raw / "manifest.json"
    report["inputs"] = json.loads(manifest.read_text(encoding="utf-8"))["downloads"] if manifest.exists() else []
    for d in report["inputs"]:
        d.pop("query", None)
    (out_dir / "report.json").write_text(json.dumps(report, indent=2, default=str), encoding="utf-8")
    return out_dir
