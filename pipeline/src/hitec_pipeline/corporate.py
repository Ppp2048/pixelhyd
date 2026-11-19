"""Company-to-building links for the web app.

Inputs (never modified):
  data/corporate/pixelhyd_hyderabad_corporate_seed_dataset.json   researched records, one per company/site
  pipeline/corporate/matches.json                                  hand-curated footprint links per record
  the tile features (data/work/...)                                where each linked OSM footprint is

Output: web/public/data/corporate.json, read by the app (confirmed and unverified sites only;
records that still need manual verification are listed in the build report, not published). A record reaches the map only through a
named footprint listed in matches.json (checked against its OSM name here), never by proximity.
"""

from __future__ import annotations

import json
import sys
from concurrent.futures import ProcessPoolExecutor
from datetime import UTC, datetime
from pathlib import Path

from . import DATA_ROOT

SEED = DATA_ROOT / "corporate" / "pixelhyd_hyderabad_corporate_seed_dataset.json"
MATCHES = Path(__file__).resolve().parents[2] / "corporate" / "matches.json"
OUT = Path(__file__).resolve().parents[3] / "web" / "public" / "data" / "corporate.json"
ON_MAP = ("confirmed", "unverified")
# Seed fields carried through unchanged, so every claim keeps its evidence.
KEEP = ("company_name", "brand_or_entity", "sector", "campus_or_property", "building_name", "address", "city_area",
        "association_type", "evidence_level", "verification_status", "source_note", "last_checked")


def _find(args: tuple[str, frozenset[str]]) -> list[dict]:
    """The wanted OSM features stored in one tile's data (buildings with their map ids, and areas)."""
    from shapely.geometry import mapping

    from . import tiles as T
    from .scene import read_layers

    tid, want = args
    f = T._features(tid)
    if not f.exists():
        return []
    out = []
    for layer, g in read_layers(f).items():
        if layer not in ("buildings", "areas") or "osm_id" not in g:
            continue
        hit = g[g["osm_id"].isin(want)]
        for (_, r), p in zip(hit.iterrows(), hit.to_crs(4326).geometry.representative_point()):
            out.append({"layer": layer, "osm_id": r["osm_id"], "id": r.get("id"), "name": r.get("name"),
                        "tile": tid, "lat": round(p.y, 6), "lon": round(p.x, 6), "geom": mapping(r.geometry)})
    return out


def locate(osm_ids: set[str], workers: int = 6) -> dict[str, dict]:
    """Find OSM features across the city grid; a feature that crosses tiles is kept once (its owner's copy)."""
    from . import tiles as T

    found: dict[str, dict] = {}
    with ProcessPoolExecutor(workers) as ex:
        for rows in ex.map(_find, [(t, frozenset(osm_ids)) for t in T.city_tile_ids()], chunksize=16):
            for r in rows:
                own = T.owner_of(*_utm(r["geom"]))
                if r["osm_id"] not in found or own == r["tile"]:
                    found[r["osm_id"]] = r
    return found


def _utm(geom: dict) -> tuple[float, float]:
    from shapely.geometry import shape

    p = shape(geom).representative_point()
    return p.x, p.y


def build(seed_path: Path = SEED, matches_path: Path = MATCHES, out_path: Path = OUT) -> dict:
    from shapely.geometry import shape

    seed = {r["company_id"]: r for r in json.loads(seed_path.read_text(encoding="utf-8-sig"))}
    matches = json.loads(matches_path.read_text(encoding="utf-8"))["records"]
    problems = [f"{cid}: in matches.json but not in the dataset" for cid in matches if cid not in seed]
    problems += [f"{cid}: no entry in matches.json" for cid in seed if cid not in matches]

    wanted = {f["osm_id"] for m in matches.values() for f in [m.get("campus") or {}, *m.get("buildings", [])] if f}
    found = locate(wanted)

    sites, pending = [], []
    for cid, rec in seed.items():
        m = matches.get(cid)
        if not m:
            continue
        if m["status"] not in ON_MAP:
            pending.append({"id": cid, "company": rec["company_name"] or None, "property": rec["campus_or_property"],
                            "verification_status": rec["verification_status"], "reason": m["reason"]})
            continue

        def get(ref: dict, layer: str) -> dict | None:
            f = found.get(ref["osm_id"])
            if f is None or f["layer"] != layer:
                problems.append(f"{cid}: {ref['osm_id']} not found among map {layer}")
                return None
            if ref["expect_name"].casefold() not in str(f["name"]).casefold():
                problems.append(f"{cid}: {ref['osm_id']} is named {f['name']!r}, expected {ref['expect_name']!r}")
                return None
            return f

        campus = get(m["campus"], "areas") if m.get("campus") else None
        buildings = [b for b in (get(ref, "buildings") for ref in m.get("buildings", [])) if b]
        if campus:
            area = shape(campus["geom"]).buffer(5)
            for b in buildings:
                if not area.contains(shape(b["geom"]).representative_point()):
                    problems.append(f"{cid}: building {b['osm_id']} lies outside campus {campus['osm_id']}")
        if not buildings:
            problems.append(f"{cid}: no building footprint resolved; left off the map")
            continue
        anchor = campus or buildings[0]
        sites.append({
            "id": cid,
            "status": m["status"],
            "match": m["match"],
            "match_note": m["match_note"],
            **{k: rec.get(k) or None for k in KEEP},
            "sources": [u for u in (rec.get("source_url"), rec.get("supporting_source_url")) if u],
            "campus": {"osm_id": campus["osm_id"], "name": campus["name"]} if campus else None,
            "buildings": [{"id": b["id"], "osm_id": b["osm_id"], "name": b["name"], "lat": b["lat"], "lon": b["lon"]} for b in buildings],
            "lat": anchor["lat"],
            "lon": anchor["lon"],
        })

    out = {
        "generated_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "dataset": seed_path.name,
        "attribution": "Company records: Pixelhyd research (sources per record). Footprints and names: © OpenStreetMap contributors (ODbL).",
        "sites": sites,  # records awaiting verification stay out of the public file (see the report)
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    return {"sites": len(sites), "confirmed": sum(s["status"] == "confirmed" for s in sites),
            "unverified": sum(s["status"] == "unverified" for s in sites), "pending": pending, "problems": problems}


def cli(argv: list[str]) -> None:
    report = build()
    print(json.dumps(report, indent=1))
    if report["problems"]:
        sys.exit(1)
