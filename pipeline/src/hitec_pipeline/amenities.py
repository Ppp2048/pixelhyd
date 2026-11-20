"""Everyday places around each society for the home finder.

Sources (each download is recorded in data/raw/residential/manifest.json):
- Overture Maps places theme (GeoParquet via the official `overturemaps` CLI, pinned release).
- OpenStreetMap: the features already downloaded for the map (data/raw/hitec-city; see
  fetch.osm_downloads) plus leisure points (gyms, parks) that the map download did not include.

Rules (what counts, so the numbers can be checked):
- Each place gets at most one category from CATEGORIES, by its OSM tags or its Overture category.
- Overture places need confidence >= MIN_CONFIDENCE and must not be marked closed. Overture files
  clinics, dentists and similar under "hospital", so an Overture place counts as a hospital only when
  its name says hospital. Groceries need one of the grocery types in _GROCERY.
- Parks come from OpenStreetMap only (Overture files housing societies named "... Park" as parks).
  They must be public (no access=private) and, when unnamed, at least MIN_PARK_M2 (small unnamed
  polygons are mostly traffic islands and verges). Playgrounds are not counted: most are inside
  gated societies.
- Overture listings inside a society boundary are dropped: they are mostly home businesses
  registered at a flat. OpenStreetMap features inside one (a mapped supermarket) are kept.
- The same place listed twice (OSM and Overture, or two Overture listings) is counted once: same
  category and either within SAME_M metres or within NEAR_NAME_M metres with matching names.
  OpenStreetMap is kept first, then Overture by confidence.
- Distances are straight lines from the society boundary in metres; they are not walking routes.
  A park inside the society's own boundary is the society's grounds, not a nearby park.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

from . import DATA_ROOT

RAW = DATA_ROOT / "raw" / "residential"
BLOCKS = DATA_ROOT / "raw" / "hitec-city" / "blocks"
RELEASE = "2026-10-21.0"  # the release the map's buildings come from
BBOX = (78.30, 17.37, 78.43, 17.50)  # west, south, east, north: the residential prototype strip plus a margin
UTM = "EPSG:32644"

CATEGORIES = {
    "cafe": "Cafés",
    "restaurant": "Restaurants",
    "hospital": "Hospitals",
    "pharmacy": "Pharmacies",
    "gym": "Gyms",
    "grocery": "Supermarkets & groceries",
    "park": "Parks",
    "school": "Schools",
}
MIN_CONFIDENCE = 0.6
MIN_PARK_M2 = 1000.0
SAME_M, NEAR_NAME_M = 25.0, 80.0
RADIUS_M = 1000.0  # "nearby" means within this distance of the boundary
KEEP_M = 1500.0  # places published for the map: within this distance of any society

_OSM = {
    ("amenity", "cafe"): "cafe",
    ("amenity", "restaurant"): "restaurant", ("amenity", "fast_food"): "restaurant", ("amenity", "food_court"): "restaurant",
    ("amenity", "hospital"): "hospital", ("healthcare", "hospital"): "hospital",
    ("amenity", "pharmacy"): "pharmacy", ("healthcare", "pharmacy"): "pharmacy",
    ("leisure", "fitness_centre"): "gym", ("amenity", "gym"): "gym",
    ("shop", "supermarket"): "grocery", ("shop", "convenience"): "grocery", ("shop", "greengrocer"): "grocery",
    ("leisure", "park"): "park", ("leisure", "garden"): "park",
    ("amenity", "school"): "school",
}
_OVERTURE = {
    "cafe": "cafe", "coffee_shop": "cafe",
    "restaurant": "restaurant", "casual_eatery": "restaurant", "fast_food_restaurant": "restaurant", "food_court": "restaurant",
    "hospital": "hospital", "specialty_hospital": "hospital",
    "pharmacy_and_drug_store": "pharmacy",
    "gym": "gym", "fitness_studio": "gym",
    "convenience_store": "grocery",
    "elementary_school": "school", "middle_school": "school", "high_school": "school",
}
# Overture taxonomy names. Not the specialty grocers: in this area they are mostly other shops misfiled.
_GROCERY = ("grocery_store", "indian_grocery_store", "supermarket", "hypermarket", "produce_store")
_GENERIC = {"the", "and", "of", "by", "at", "in", "a", "hyderabad", "telangana", "india", "pvt", "ltd", "private", "limited",
            "cafe", "coffee", "restaurant", "hospital", "hospitals", "clinic", "pharmacy", "medical", "gym", "fitness",
            "supermarket", "mart", "store", "park", "garden", "school", "high", "public"}


def osm_category(tags: dict) -> str | None:
    if tags.get("access") in ("private", "no", "customers"):
        return None
    for key in ("amenity", "healthcare", "leisure", "shop"):
        cat = _OSM.get((key, tags.get(key)))
        if cat:
            if (key, tags[key]) == ("leisure", "garden") and not tags.get("name"):
                return None  # unnamed gardens are mostly private lawns
            return cat
    return None


def overture_category(basic: str | None, primary: str | None, name: str | None) -> str | None:
    cat = _OVERTURE.get(basic or "")
    if cat is None and primary in _GROCERY:
        cat = "grocery"
    if cat == "hospital" and "hospital" not in (name or "").lower():
        return None
    return cat


def _tokens(name: str | None) -> set[str]:
    return set(re.findall(r"[a-z0-9]+", (name or "").lower())) - _GENERIC


def same_name(a: str | None, b: str | None) -> bool:
    ta, tb = _tokens(a), _tokens(b)
    if not ta or not tb:
        return False
    return ta <= tb or tb <= ta or len(ta & tb) / len(ta | tb) >= 0.5


def dedupe(places: list[dict]) -> list[dict]:
    """Keep the first of each duplicate group; `places` must be in priority order and carry UTM `x`, `y`."""
    cell = NEAR_NAME_M
    grid: dict[tuple, list[dict]] = {}
    kept = []
    for p in places:
        gx, gy = int(p["x"] // cell), int(p["y"] // cell)
        dup = False
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for q in grid.get((p["cat"], gx + dx, gy + dy), ()):
                    d = ((p["x"] - q["x"]) ** 2 + (p["y"] - q["y"]) ** 2) ** 0.5
                    if d <= SAME_M or (d <= NEAR_NAME_M and same_name(p["name"], q["name"])):
                        dup = True
                        break
                if dup:
                    break
            if dup:
                break
        if not dup:
            kept.append(p)
            grid.setdefault((p["cat"], gx, gy), []).append(p)
    return kept


def _osm_elements(bbox=BBOX):
    """Unique OSM elements from the map's raw downloads that overlap `bbox`, then the extra leisure points."""
    from .fetch import osm_downloads

    seen = set()
    files = osm_downloads(BLOCKS.parent, bbox)
    leisure = RAW / "osm_leisure.json"
    if leisure.exists():
        files.append(leisure)
    for f in files:
        for el in json.loads(f.read_text(encoding="utf-8"))["elements"]:
            key = (el["type"], el["id"])
            if key not in seen and el.get("tags"):
                seen.add(key)
                yield el


def load_osm(to_utm, bbox=BBOX) -> list[dict]:
    from shapely.geometry import Point, Polygon

    w0, s0, e0, n0 = bbox
    out = []
    for el in _osm_elements(bbox):
        t = el["tags"]
        cat = osm_category(t)
        if not cat:
            continue
        geom = None
        if el["type"] == "node":
            lon, lat = el["lon"], el["lat"]
        elif el["type"] == "way" and el.get("geometry"):
            pts = [to_utm(g["lon"], g["lat"]) for g in el["geometry"] if g]
            if len(pts) >= 4 and pts[0] == pts[-1]:
                geom = Polygon(pts).buffer(0)
            ys = [g["lat"] for g in el["geometry"] if g]
            xs = [g["lon"] for g in el["geometry"] if g]
            lon, lat = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
        elif "bounds" in el:
            b = el["bounds"]
            lon, lat = (b["minlon"] + b["maxlon"]) / 2, (b["minlat"] + b["maxlat"]) / 2
        else:
            continue
        if not (w0 <= lon <= e0 and s0 <= lat <= n0):
            continue
        name = t.get("name:en") or t.get("name")
        if cat == "park" and not name and (geom is None or geom.area < MIN_PARK_M2):
            continue
        x, y = to_utm(lon, lat)
        if geom is not None and not geom.is_empty:
            rp = geom.representative_point()
            x, y = rp.x, rp.y
            lon, lat = to_utm(x, y, direction="INVERSE")
        out.append({"id": f"{el['type'][0]}{el['id']}", "name": name, "cat": cat, "source": "osm",
                    "lat": round(lat, 6), "lon": round(lon, 6), "x": x, "y": y, "geom": geom or Point(x, y)})
    return out


def load_overture(to_utm, path: Path | None = None, bbox=BBOX) -> list[dict]:
    import pyarrow.parquet as pq
    from shapely import wkb
    from shapely.geometry import Point

    path = path or RAW / "overture_places.parquet"
    cols = ["id", "geometry", "confidence", "names", "operating_status", "basic_category", "taxonomy"]
    w0, s0, e0, n0 = bbox
    out = []
    for r in pq.read_table(path, columns=cols).to_pylist():
        if (r["confidence"] or 0) < MIN_CONFIDENCE or r["operating_status"] in ("permanently_closed", "temporarily_closed"):
            continue
        name = (r["names"] or {}).get("primary")
        cat = overture_category(r["basic_category"], (r["taxonomy"] or {}).get("primary"), name)
        if not cat:
            continue
        pt = wkb.loads(r["geometry"])
        if not (w0 <= pt.x <= e0 and s0 <= pt.y <= n0):
            continue
        x, y = to_utm(pt.x, pt.y)
        out.append({"id": r["id"], "name": name, "cat": cat, "source": "overture", "confidence": round(r["confidence"], 2),
                    "lat": round(pt.y, 6), "lon": round(pt.x, 6), "x": x, "y": y, "geom": Point(x, y)})
    return out


def load_places(bbox=BBOX) -> list[dict]:
    """All categorised places in the strip, OSM first, duplicates removed."""
    from pyproj import Transformer

    to_utm = Transformer.from_crs("EPSG:4326", UTM, always_xy=True).transform
    osm = load_osm(to_utm, bbox)
    ovt = sorted(load_overture(to_utm, bbox=bbox), key=lambda p: -p["confidence"])
    return dedupe(osm + ovt)


def drop_overture_inside(areas: dict[str, object], places: list[dict]) -> list[dict]:
    """Remove Overture listings that stand inside a society boundary (UTM geometries)."""
    import numpy as np
    import shapely

    if not places or not areas:
        return places
    geoms = np.array([p["geom"] for p in places], dtype=object)
    inside = np.zeros(len(places), dtype=bool)
    for area in areas.values():
        inside |= shapely.intersects(area, geoms)
    return [p for p, i in zip(places, inside) if not (i and p["source"] == "overture")]


def nearby(areas: dict[str, object], places: list[dict], radius: float = RADIUS_M) -> dict[str, dict]:
    """Per society (UTM geometry): for each category, the places within `radius` (ids, nearest first) and the
    nearest one at any distance."""
    import numpy as np
    import shapely

    geoms = np.array([p["geom"] for p in places], dtype=object)
    cats = np.array([p["cat"] for p in places])
    out = {}
    for sid, area in areas.items():
        d = shapely.distance(area, geoms) if len(places) else np.array([])
        res = {}
        for cat in CATEGORIES:
            idx = np.where((cats == cat) & ~((cat == "park") & (d == 0)))[0] if len(places) else []
            if len(idx) == 0:
                res[cat] = {"count": 0, "ids": [], "nearest": None}
                continue
            order = idx[np.argsort(d[idx], kind="stable")]
            within = [places[i]["id"] for i in order if d[i] <= radius]
            p = places[order[0]]
            res[cat] = {"count": len(within), "ids": within,
                        "nearest": {"id": p["id"], "name": p["name"], "m": int(round(d[order[0]], -1)), "source": p["source"]}}
        out[sid] = res
    return out


def near_any(areas: dict[str, object], places: list[dict], within: float = KEEP_M) -> list[dict]:
    """The places within `within` metres of any society, in the compact form the app reads."""
    import numpy as np
    import shapely

    if not places or not areas:
        return []
    geoms = np.array([p["geom"] for p in places], dtype=object)
    keep = np.zeros(len(places), dtype=bool)
    for area in areas.values():
        keep |= shapely.distance(area, geoms) <= within
    fields = ("id", "name", "cat", "source", "lat", "lon")
    return [{f: p[f] for f in fields} for p, near in zip(places, keep) if near]


def fetch_overture_places(out_dir: Path = RAW, release: str = RELEASE, bbox=BBOX) -> Path:
    """Download Overture places for the prototype strip and record the download."""
    from .fetch import _record, _sha256

    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / "overture_places.parquet"
    exe = shutil.which("overturemaps", path=str(Path(sys.executable).parent))
    box = ",".join(f"{v:.6f}" for v in bbox)
    cmd = [exe or "overturemaps", "download", f"--bbox={box}", "-f", "geoparquet", "--type=place", "-o", str(out),
           "--release", release]
    subprocess.run(cmd, check=True)
    _record(out_dir / "manifest.json", {
        "file": out.name,
        "source": f"Overture Maps Foundation — places theme (release {release})",
        "licence": "CDLA-Permissive-2.0, with some sources under Apache-2.0 or CC0-1.0 (per-feature sources listed in `sources`)",
        "query": " ".join(cmd[1:]),
        "fetched_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "sha256": _sha256(out),
        "bytes": out.stat().st_size,
    })
    return out


def fetch_osm_leisure(out_dir: Path = RAW, bbox=BBOX) -> Path:
    """Gym and park points from OpenStreetMap (the map's download only took leisure areas)."""
    from .fetch import _overpass, _record, _sha256

    w, s, e, n = bbox
    query = f'[out:json][timeout:180];\nnode[leisure~"^(fitness_centre|park|garden)$"]({s},{w},{n},{e});\nout qt;'
    data = _overpass(query, timeout=300)
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / "osm_leisure.json"
    out.write_bytes(data)
    _record(out_dir / "manifest.json", {
        "file": out.name,
        "source": "OpenStreetMap contributors via Overpass API",
        "licence": "ODbL 1.0",
        "query": query,
        "osm_base": json.loads(data).get("osm3s", {}).get("timestamp_osm_base"),
        "fetched_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "sha256": _sha256(out),
        "bytes": out.stat().st_size,
    })
    return out
