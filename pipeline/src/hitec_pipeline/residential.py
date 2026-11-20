"""Residential societies for the home finder.

Inputs (never modified):
  pipeline/residential/societies.json   hand-curated records; every published fact names the page it came from
  the tile features (data/work/...)     society boundaries (OpenStreetMap) and the footprints inside them

Output: web/public/data/residential.json, read by the app, plus two files the app reads only when the
home finder is open: residential_places.json (everyday places near the societies; amenities.py has the
rules) and residential_commute.json (estimated drive times to a workplace grid; commute.py has the rules).

Rules:
- A society's buildings are the map footprints whose representative point lies inside its named
  OpenStreetMap boundary; the boundary's name is checked when the data is built ("site" match).
- Without a boundary a society is an approximate point and claims no buildings ("approximate" match).
- Facts are copied, never estimated. A missing fact stays missing, and every fact carries an https source.
- `research` says how much is known: "researched" (facts read from the developer's pages or RERA) or
  "mapped" (only the OpenStreetMap name and boundary).
- A society belongs to the nearest neighbourhood centre (an OpenStreetMap place point) within
  NEAR_M; developers' own locality names are marketing and are not used.
"""

from __future__ import annotations

import json
import sys
from concurrent.futures import ProcessPoolExecutor
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SEED = ROOT / "residential" / "societies.json"
OUT = ROOT.parent / "web" / "public" / "data" / "residential.json"
PLACES_OUT_NAME = "residential_places.json"
COMMUTE_OUT_NAME = "residential_commute.json"

RESEARCH = ("researched", "mapped")
STATUS = ("completed", "under_construction")
AREA_TYPES = ("carpet", "built_up", "super_built_up", "unspecified")  # as the source labels it; never converted
FACTS = ("status", "land_acres", "open_space_pct", "towers", "floors", "units", "rera", "bhk", "size_range_sqft",
         "clubhouse_sqft", "amenities")
NEAR_M = 3000.0
BENCH_KEYS = ("id", "area", "bhk", "size_sqft", "rent_month", "period", "publisher", "source")


def _is_source(v) -> bool:
    return isinstance(v, str) and v.startswith("https://")


def check(rec: dict) -> list[str]:
    """Problems with one society record (empty when it can be published)."""
    sid = rec.get("id", "?")
    out = []
    for key in ("id", "name", "research"):
        if not rec.get(key):
            out.append(f"{sid}: missing {key}")
    if rec.get("research") not in RESEARCH:
        out.append(f"{sid}: research must be one of {RESEARCH}")
    site, loc = rec.get("site"), rec.get("location")
    if not site and not loc:
        out.append(f"{sid}: needs an OSM site boundary or an approximate location")
    if site and not (str(site.get("osm_id", ""))[:1] in "wr" and site.get("expect_name")):
        out.append(f"{sid}: site needs a way/relation osm_id and expect_name")
    if loc and not (_is_source(loc.get("source")) and isinstance(loc.get("lat"), float) and isinstance(loc.get("lon"), float)):
        out.append(f"{sid}: location needs lat, lon and a source")
    facts = rec.get("facts") or {}
    for key, fact in facts.items():
        if key not in FACTS:
            out.append(f"{sid}: unknown fact {key!r}")
        elif not (isinstance(fact, dict) and "value" in fact and _is_source(fact.get("source"))):
            out.append(f"{sid}: fact {key} needs a value and an https source")
    if "status" in facts and facts["status"].get("value") not in STATUS:
        out.append(f"{sid}: status must be one of {STATUS}")
    for i, c in enumerate(rec.get("configurations") or []):
        where = f"{sid}: configuration {i + 1}"
        if not isinstance(c.get("bhk"), (int, float)) or not _is_source(c.get("source")):
            out.append(f"{where} needs bhk and an https source")
        area = c.get("area_sqft")
        if area is not None:
            if not (isinstance(area, list) and len(area) == 2 and 150 <= area[0] <= area[1] <= 15000):
                out.append(f"{where}: area_sqft must be [min, max] in square feet")
            if c.get("area_type") not in AREA_TYPES:
                out.append(f"{where}: area_type must be one of {AREA_TYPES}")
        for room in c.get("bedrooms_ft") or []:
            if not (isinstance(room, list) and len(room) == 2 and all(6 <= x <= 40 for x in room)):
                out.append(f"{where}: bedrooms_ft entries are [short, long] sides in feet")
    if rec.get("research") == "researched" and not (facts or rec.get("configurations")):
        out.append(f"{sid}: a researched record needs at least one sourced fact")
    if rec.get("research") == "mapped" and (facts or rec.get("configurations")):
        out.append(f"{sid}: a mapped record carries no facts; mark it researched")
    return out


def _inside(args: tuple[str, list[tuple[str, bytes]]]) -> list[tuple[str, str, str | None, str | None]]:
    """(society, building id, name, use) for each footprint of one tile that stands inside a society boundary."""
    from shapely import wkb

    from . import tiles as T
    from .scene import read_layers

    tid, polys = args
    f = T._features(tid)
    if not f.exists():
        return []
    b = read_layers(f).get("buildings")
    if b is None or b.empty:
        return []
    pts = b.geometry.representative_point()
    out = []
    for sid, blob in polys:
        poly = wkb.loads(blob)
        hit = b[pts.within(poly)]
        out += [(sid, r["id"], r.get("name"), r.get("use"), r.geometry.centroid.x, r.geometry.centroid.y, r.geometry.area)
                for _, r in hit.iterrows()]
    return out


def buildings_in(boundaries: dict[str, dict], workers: int = 6) -> dict[str, list[dict]]:
    """Footprints inside each boundary (UTM GeoJSON-like geometry), once each, in a stable order, with each
    footprint's centroid (x, y) and area in UTM."""
    from shapely.geometry import shape

    from . import tiles as T

    jobs: dict[str, list[tuple[str, bytes]]] = {}
    for sid, geom in boundaries.items():
        poly = shape(geom)
        for tid in T.tiles_in(poly):
            jobs.setdefault(tid, []).append((sid, poly.wkb))
    found: dict[str, dict[str, dict]] = {sid: {} for sid in boundaries}
    with ProcessPoolExecutor(workers) as ex:
        for rows in ex.map(_inside, list(jobs.items()), chunksize=4):
            for sid, bid, name, use, x, y, a in rows:
                found[sid].setdefault(bid, {"id": bid, "name": name or None, "use": use or None, "x": x, "y": y, "area": a})
    return {sid: sorted(v.values(), key=lambda b: b["id"]) for sid, v in found.items()}


def nearest(lat: float, lon: float, hoods: list[dict]) -> tuple[str | None, float | None]:
    """The closest neighbourhood centre within NEAR_M, and the distance to it in metres."""
    import math

    best, best_m = None, None
    for h in hoods:
        dy = (h["lat"] - lat) * 111_320.0
        dx = (h["lon"] - lon) * 111_320.0 * math.cos(math.radians(lat))
        m = math.hypot(dx, dy)
        if m <= NEAR_M and (best_m is None or m < best_m):
            best, best_m = h["id"], m
    return best, round(best_m, -1) if best_m is not None else None


def _load_places(problems: list[str]) -> list[dict]:
    from . import amenities

    need = (amenities.RAW / "overture_places.parquet", amenities.RAW / "osm_leisure.json")
    missing = [f.name for f in need if not f.exists()]
    if missing:
        problems.append(f"amenities: {', '.join(missing)} not downloaded; run `hitec-pipeline residential fetch`")
        return []
    return amenities.load_places()


def _commute(areas: dict, problems: list[str]) -> dict:
    from pyproj import Transformer

    from . import amenities, commute

    if not commute.PLACES_OSM.exists() or not any(amenities.BLOCKS.glob("*/osm.json")):
        problems.append("commute: the map's OpenStreetMap download (data/raw/hitec-city) is missing")
        return {"societies": {}, "file": None}
    to_utm = Transformer.from_crs("EPSG:4326", amenities.UTM, always_xy=True).transform
    stations = commute.metro_stations(bbox=amenities.BBOX)
    return commute.compute(areas, amenities._osm_elements(), to_utm, stations, amenities.BBOX)


def centre(blds: list[dict], to_wgs) -> dict | None:
    """The middle of a society's buildings (area-weighted footprint centroids, UTM in), where the map marks it."""
    parts = [(b["x"], b["y"], b["area"]) for b in blds if b.get("area")]
    if not parts:
        return None
    total = sum(a for _, _, a in parts)
    lon, lat = to_wgs(sum(x * a for x, _, a in parts) / total, sum(y * a for _, y, a in parts) / total)
    return {"lat": round(lat, 6), "lon": round(lon, 6)}


def build(seed_path: Path = SEED, out_path: Path = OUT, locate=None, inside=None, places=None, route=None,
          pgs_seed: Path | None = None, pg_rows=None, pg_grounds=None, pg_areas_osm=None) -> dict:
    """Validate the curated records, attach map footprints, nearby places and commute estimates, and
    write the app's files. With `pgs_seed`, PGs (pgs.py) get the same nearby places and commute
    estimates, written to files of their own so the societies' files do not change.

    For tests: `places` replaces the downloaded places (dicts with id, name, cat, source, lat, lon and a
    UTM shapely `geom`); `route(areas)` replaces the commute computation (commute.compute's result);
    `pg_rows`, `pg_grounds` and `pg_areas_osm` replace the Overture rows, campus polygons and suburb points
    pgs reads.
    Returns a report.
    """
    from pyproj import Transformer
    from shapely.geometry import Point, shape

    from . import amenities
    from .corporate import locate as locate_osm

    locate = locate or locate_osm
    inside = inside or buildings_in
    seed = json.loads(seed_path.read_text(encoding="utf-8"))
    hoods = {h["id"]: h for h in seed["neighbourhoods"]}
    problems: list[str] = []
    for b in seed.get("benchmarks", []):
        missing = [k for k in BENCH_KEYS if b.get(k) in (None, "")]
        if missing or not _is_source(b.get("source")):
            problems.append(f"benchmark {b.get('id', '?')}: needs {', '.join(missing) or 'an https source'}")
    for h in hoods.values():
        if not (h.get("name") and isinstance(h.get("lat"), float) and isinstance(h.get("lon"), float) and h.get("osm_id")):
            problems.append(f"neighbourhood {h['id']}: needs name, lat, lon and the OSM place it is centred on")
    ids = [r.get("id") for r in seed["societies"]]
    problems += [f"{i}: duplicate id" for i in sorted({i for i in ids if ids.count(i) > 1})]

    records = []
    for rec in seed["societies"]:
        p = check(rec)
        problems += p
        if not p:
            records.append(rec)

    found = locate({r["site"]["osm_id"] for r in records if r.get("site")})
    boundaries, anchors = {}, {}
    for r in records:
        site = r.get("site")
        if not site:
            continue
        f = found.get(site["osm_id"])
        if f is None or f["layer"] != "areas":
            problems.append(f"{r['id']}: boundary {site['osm_id']} not found among map areas")
        elif site["expect_name"].casefold() not in str(f["name"]).casefold():
            problems.append(f"{r['id']}: boundary {site['osm_id']} is named {f['name']!r}, expected {site['expect_name']!r}")
        else:
            boundaries[r["id"]] = f["geom"]
            anchors[r["id"]] = (f["lat"], f["lon"], f["name"])
    footprints = inside(boundaries) if boundaries else {}

    societies, areas = [], {}
    to_utm = Transformer.from_crs("EPSG:4326", amenities.UTM, always_xy=True).transform
    to_wgs = Transformer.from_crs(amenities.UTM, "EPSG:4326", always_xy=True).transform
    for r in records:
        if r.get("site") and r["id"] not in boundaries:
            continue  # its problem is already reported
        site = r["id"] in boundaries
        blds = footprints.get(r["id"], []) if site else []
        if site and not blds:
            problems.append(f"{r['id']}: no building footprints inside its boundary")
            continue
        lat, lon = (anchors[r["id"]][0], anchors[r["id"]][1]) if site else (r["location"]["lat"], r["location"]["lon"])
        hood, hood_m = nearest(lat, lon, list(hoods.values()))
        areas[r["id"]] = shape(boundaries[r["id"]]) if site else Point(*to_utm(lon, lat))
        societies.append({
            "id": r["id"],
            "name": r["name"],
            "developer": r.get("developer"),
            "neighbourhood": hood,
            "neighbourhood_m": hood_m,
            "research": r["research"],
            "match": "site" if site else "approximate",
            "site": {"osm_id": r["site"]["osm_id"], "name": anchors[r["id"]][2]} if site else None,
            "location_source": None if site else r["location"]["source"],
            "lat": lat,
            "lon": lon,
            "centre": centre(blds, to_wgs),
            "buildings": [b["id"] for b in blds],
            "facts": r.get("facts") or {},
            "configurations": r.get("configurations") or [],
            "note": r.get("note"),
            "last_checked": r.get("last_checked"),
        })

    pg_seed, pg_recs, pg_areas = None, [], {}
    if pgs_seed is not None:
        from . import pgs

        pg_seed = pgs.load_seed(pgs_seed)
        grounds = pgs.campuses(amenities._osm_elements(), to_utm) if pg_grounds is None else pg_grounds
        pg_recs, pg_problems, pg_notes = pgs.records(pg_seed, pgs.load_rows() if pg_rows is None else pg_rows, to_utm, grounds)
        problems += pg_problems
        problems += [f"{s['id']}: a society id may not start with 'pg-'" for s in societies if s["id"].startswith("pg-")]
        pg_areas = {r["id"]: Point(*to_utm(r["lon"], r["lat"])) for r in pg_recs}
        # the societies' neighbourhoods first, so one spot gets one name; suburbs and towns beyond them
        extra = pgs.osm_areas(set(hoods)) if pg_areas_osm is None else pg_areas_osm
        for r in pg_recs:
            hood, hood_m = nearest(r["lat"], r["lon"], list(hoods.values()))
            if hood is None:
                hood, hood_m = nearest(r["lat"], r["lon"], extra)
            r["neighbourhood"], r["neighbourhood_m"] = hood, hood_m
        pg_hoods = [h for h in extra if h["id"] in {r["neighbourhood"] for r in pg_recs}]

    places = _load_places(problems) if places is None else places
    places = amenities.drop_overture_inside(areas, places)
    near = amenities.nearby(areas, places)
    for s in societies:
        s["nearby"] = near.get(s["id"], {})
    kept = amenities.near_any(areas, places)
    trips = route(areas | pg_areas) if route else _commute(areas | pg_areas, problems)  # one road graph for both
    for s in societies:
        s["metro"] = (trips["societies"].get(s["id"]) or {}).get("metro")
    trip_file = None
    if trips["file"] is not None:
        packed = trips["file"]["societies"]
        trip_file = trips["file"] | {"societies": {k: v for k, v in packed.items() if k in areas}}

    generated = datetime.now(UTC).isoformat(timespec="seconds")
    places_attribution = ("Places: © OpenStreetMap contributors (ODbL); Overture Maps Foundation places "
                          "(CDLA-Permissive-2.0, some sources Apache-2.0 or CC0-1.0).")
    out = {
        "generated_at": generated,
        "attribution": "Society facts: Pixelhyd research (a source per fact). Boundaries and footprints: © OpenStreetMap "
                       "contributors (ODbL), Overture Maps Foundation. Rent benchmarks: as cited. " + places_attribution,
        "amenities": {"categories": amenities.CATEGORIES, "radius_m": amenities.RADIUS_M,
                      "measure": "straight-line distance from the society boundary", "places_file": PLACES_OUT_NAME},
        "commute": {"file": COMMUTE_OUT_NAME, "kind": "estimated drive with assumed road speeds and no traffic data",
                    "metro": "nearest Hyderabad Metro station from OpenStreetMap; ride times not included"},
        "benchmarks": seed.get("benchmarks", []),
        "neighbourhoods": list(hoods.values()),
        "societies": societies,
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    fields = ["id", "name", "cat", "source", "lat", "lon"]
    compact = {"generated_at": generated, "attribution": places_attribution, "categories": amenities.CATEGORIES,
               "fields": fields, "places": [[p[f] for f in fields] for p in kept]}
    (out_path.parent / PLACES_OUT_NAME).write_text(
        json.dumps(compact, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    roads_attribution = "Roads and metro stations: © OpenStreetMap contributors (ODbL)."
    if trip_file is not None:
        (out_path.parent / COMMUTE_OUT_NAME).write_text(
            json.dumps({"generated_at": generated, "attribution": roads_attribution} | trip_file,
                       ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    report = {
        "societies": len(societies),
        "site": sum(s["match"] == "site" for s in societies),
        "approximate": sum(s["match"] == "approximate" for s in societies),
        "researched": sum(s["research"] == "researched" for s in societies),
        "buildings": sum(len(s["buildings"]) for s in societies),
        "places_nearby": len(kept),
        "problems": problems,
    }
    if pg_seed is not None:
        from . import pgs

        near_pg = amenities.nearby(pg_areas, places)
        for r in pg_recs:
            r["nearby"] = near_pg.get(r["id"], {})
            r["metro"] = (trips["societies"].get(r["id"]) or {}).get("metro")
        pg_trips = None
        if trips["file"] is not None:
            pg_trips = trips["file"] | {"societies": {k: v for k, v in trips["file"]["societies"].items() if k in pg_areas}}
        report["pgs"] = pgs.write(out_path.parent, generated, pg_seed, pg_recs, amenities.near_any(pg_areas, places),
                                  pg_trips, places_attribution, roads_attribution, pg_hoods) | {"notes": pg_notes}
    return report


def cli(argv: list[str]) -> None:
    if argv[:1] == ["fetch"]:  # download the everyday places (Overture, OpenStreetMap) for the strip
        from . import amenities

        print(amenities.fetch_overture_places())
        print(amenities.fetch_osm_leisure())
        return
    from .pgs import SEED as PG_SEED

    report = build(pgs_seed=PG_SEED)
    print(json.dumps(report, indent=1))
    if report["problems"]:
        sys.exit(1)
