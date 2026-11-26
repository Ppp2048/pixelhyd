"""Company office sites for the web app (docs/corporate-model-plan.md).

Inputs (never modified):
  pipeline/corporate/companies.json   who: one record per company
  pipeline/corporate/sites.json       where: each office, its map footprint links, presence and evidence
  pipeline/corporate/leads.json       unpublished research leads (validated; their OSM ids are checked)
  the tile features (data/work/...)   where each linked OSM footprint is

Output: web/public/data/corporate.json, read by the app. Its v1 fields keep their names and meaning (?s= links
use the site id); schema_version 2 adds company_id, presence, footprint_basis, confidence, operational_status,
evidence, stale and companies[]. A site reaches the map only through a named footprint whose OSM name is
checked here, never by proximity, and only when its presence is not closed. Sites without a mapped footprint
are listed in the build report, not published. Confidence is computed (corporate_model.confidence).
"""

from __future__ import annotations

import json
import sys
from concurrent.futures import ProcessPoolExecutor
from datetime import UTC, date, datetime
from pathlib import Path

from . import corporate_model as cm

CORP = Path(__file__).resolve().parents[2] / "corporate"
COMPANIES, SITES, LEADS = CORP / "companies.json", CORP / "sites.json", CORP / "leads.json"
OUT = Path(__file__).resolve().parents[3] / "web" / "public" / "data" / "corporate.json"
# The research dataset every current record was migrated from (pipeline/corporate/legacy/); v1 field kept.
DATASET = "pixelhyd_hyderabad_corporate_seed_dataset.json"
ATTRIBUTION = "Company records: Pixelhyd research (sources per record). Footprints and names: © OpenStreetMap contributors (ODbL)."


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


def _rows(path: Path, key: str) -> list[dict]:
    return json.loads(path.read_text(encoding="utf-8"))[key]


def build(companies_path: Path = COMPANIES, sites_path: Path = SITES, leads_path: Path = LEADS,
          out_path: Path = OUT, today: date | None = None) -> dict:
    """Validate, resolve footprints, write corporate.json. A validation error writes nothing."""
    from shapely.geometry import shape

    now = datetime.now(UTC)
    today = today or now.date()
    companies, sites, leads = _rows(companies_path, "companies"), _rows(sites_path, "sites"), _rows(leads_path, "leads")
    errors, warnings = cm.validate(companies, sites, leads, today)
    if errors:
        return {"sites": 0, "confirmed": 0, "unverified": 0, "pending": [], "leads": [], "warnings": warnings,
                "problems": errors, "written": False}
    by_company = {c["id"]: c for c in companies}

    wanted = {i for s in sites if cm.published(s) for i in cm.footprint_ids(s)}
    wanted |= {o["osm_id"] for lead in leads for o in lead.get("osm") or []}
    found = locate(wanted)

    problems: list[str] = []
    out_sites, pending = [], []
    for s in sites:
        sid, fp, co = s["id"], s["footprint"], by_company[s["company_id"]]
        if not cm.published(s):
            pending.append({"id": sid, "company": co["name"], "property": s["property"], "presence": s["presence"],
                            "footprint_basis": fp["basis"], "verification_status": (s.get("legacy") or {}).get("verification_status"),
                            "reason": fp.get("note")})
            continue
        failed = []

        def get(ref: dict, layer: str) -> dict | None:
            f = found.get(ref["osm_id"])
            if f is None or f["layer"] != layer:
                failed.append(f"{sid}: {ref['osm_id']} not found among map {layer}")
                return None
            if ref["expect_name"].casefold() not in str(f["name"]).casefold():
                failed.append(f"{sid}: {ref['osm_id']} is named {f['name']!r}, expected {ref['expect_name']!r}")
                return None
            return f

        campus = get(fp["campus"], "areas") if fp.get("campus") else None
        buildings = [b for b in (get(ref, "buildings") for ref in fp.get("buildings") or []) if b]
        if campus:
            area = shape(campus["geom"]).buffer(5)
            for b in buildings:
                if not area.contains(shape(b["geom"]).representative_point()):
                    failed.append(f"{sid}: building {b['osm_id']} lies outside campus {campus['osm_id']}")
        problems += failed
        if not buildings:
            problems.append(f"{sid}: no building footprint resolved; left off the map")
            continue
        anchor = campus or buildings[0]
        legacy = s.get("legacy") or {}
        out_sites.append({
            # v1 fields, same names, order and meaning
            "id": sid,
            # confirmed = confirmed presence and every footprint link checked against its OSM name (plan §5)
            "status": "confirmed" if s["presence"] == "confirmed" and not failed else "unverified",
            "match": fp["basis"],
            "match_note": fp.get("note"),
            "company_name": co["name"],
            "brand_or_entity": s.get("entity"),
            "sector": co.get("sector"),
            "campus_or_property": s.get("property"),
            "building_name": s.get("building_name"),
            "address": s.get("address"),
            "city_area": s.get("city_area"),
            "association_type": s.get("association_type"),
            "evidence_level": s.get("evidence_summary"),
            "verification_status": legacy.get("verification_status") or s["presence"],
            "source_note": s.get("source_note"),
            "last_checked": s.get("last_checked"),
            "sources": [e["url"] for e in s["evidence"]],  # every source, context-only ones included
            "campus": {"osm_id": campus["osm_id"], "name": campus["name"]} if campus else None,
            "buildings": [{"id": b["id"], "osm_id": b["osm_id"], "name": b["name"], "lat": b["lat"], "lon": b["lon"]} for b in buildings],
            "lat": anchor["lat"],
            "lon": anchor["lon"],
            # v2 additions (optional for the app)
            "company_id": s["company_id"],
            "presence": s["presence"],
            "footprint_basis": fp["basis"],
            "confidence": cm.confidence(s, today),
            "operational_status": s["operational_status"],
            "evidence": s["evidence"],
            "stale": cm.is_stale(s, today),
        })

    lead_report = []
    for lead in leads:
        osm = []
        for o in lead.get("osm") or []:
            f = found.get(o["osm_id"])
            if f is None:
                problems.append(f"lead {lead['id']}: {o['osm_id']} not found in the map data")
            osm.append({"osm_id": o["osm_id"], "layer": f and f["layer"], "name": f and f["name"]})
        lead_report.append({"id": lead["id"], "kind": lead["kind"], "company_id": lead.get("company_id"), "osm": osm})

    published_by_company: dict[str, list[str]] = {}
    for s in out_sites:
        published_by_company.setdefault(s["company_id"], []).append(s["id"])
    out = {
        "generated_at": now.isoformat(timespec="seconds"),
        "dataset": DATASET,
        "attribution": ATTRIBUTION,
        "schema_version": 2,
        # companies with at least one published site; identity only, each office is a site
        "companies": [{"id": c["id"], "name": c["name"], "aliases": c["aliases"], "sector": c["sector"],
                       "sites": published_by_company[c["id"]]} for c in companies if c["id"] in published_by_company],
        "sites": out_sites,  # sites without a mapped footprint stay out of the public file (see the report)
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    return {"sites": len(out_sites), "confirmed": sum(s["status"] == "confirmed" for s in out_sites),
            "unverified": sum(s["status"] == "unverified" for s in out_sites), "pending": pending,
            "leads": lead_report, "warnings": warnings, "problems": problems, "written": True}


def cli(argv: list[str]) -> None:
    out = Path(argv[argv.index("--out") + 1]) if "--out" in argv else OUT
    report = build(out_path=out)
    print(json.dumps(report, indent=1, ensure_ascii=False))
    if report["problems"]:
        sys.exit(1)
