"""One-off migration: research seed + matches.json → companies.json, sites.json, leads.json (plan §6).

RETIRED 2026-11-27 (B5). The migration ran once; companies.json, sites.json and leads.json are now the source of
truth and are edited directly. Its inputs are kept byte for byte in pipeline/corporate/legacy/ (the seed and
matches-2026-11.json), and this module stays as the record of how the files were made: tests re-run it on those
inputs and check the result against MIGRATED_SHA256. The `hitec-pipeline corporate migrate` command only prints
this notice, so a re-run can never overwrite later research edits.

Nothing is invented, merged or upgraded:
- every text field is copied verbatim from the seed or matches.json;
- presence is mapped from matches.json status and never raised;
- each source URL is typed by the reviewed table EVIDENCE below, and the migration fails if a seed URL has
  no row there or a row has no URL in the seed;
- the four Financial District leads come from the `way N` ids written in matches.json reasons.

Deterministic and idempotent: the outputs depend only on the two inputs (no clock), and an existing output
that differs is not overwritten without --force (it may hold research edits made after the migration).
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
from datetime import date
from pathlib import Path
from urllib.parse import urlsplit

from . import corporate_model as cm

CORP = Path(__file__).resolve().parents[2] / "corporate"
SEED = CORP / "legacy" / "seed-2026-11-19.json"
SEED_SHA256 = "be6c23550ba66f8c05e8f79487fef35ee0549b19c61fd4fc667b7fc9a924d521"  # plan §9
MATCHES = CORP / "legacy" / "matches-2026-11.json"  # was pipeline/corporate/matches.json
MATCHES_SHA256 = "42832153bbcb20ae40f9056175e40fa4c7f807517c0a99f001be9fb50fb4e1db"
# What the migration produced on 2026-11-27 (migration-report.md); later edits to the live files do not change it.
MIGRATED_SHA256 = {
    "companies.json": "7b8109d675c011330d4984f90532f9fbdfd2215c5d0af8c3b5282c04b8f72e91",
    "sites.json": "1b9a6d71dc6ecb09a1f1e3e2150c0e50314666a1df5da7abb19074e2c71b4d32",
    "leads.json": "dedadb57da1d2f55b11a92c5964b0f742b909f52ba9737ea957a8656dbd18234",
}
OUTPUTS = ("companies.json", "sites.json", "leads.json")
REPORT = CORP / "migration-report.md"

# Seed columns that hold map links or coordinates. Empty in every row; a value would need review, so the
# migration stops instead of copying hand-entered positions (plan §7, "Coordinates").
MAP_COLUMNS = ("building_osm_id", "building_overture_id", "latitude", "longitude")

PUBLISHERS = {
    "www.microsoft.com": "Microsoft",
    "www.hmda.gov.in": "Hyderabad Metropolitan Development Authority (HMDA)",
    "www.capitaland.com": "CapitaLand",
    "www.mindspaceindia.com": "Mindspace",
    "www.cyient.com": "Cyient",
    "www.nsearchives.nseindia.com": "National Stock Exchange of India (NSE)",
}

# Reviewed typing of every seed source, one row per (site, url), from the seed's own source_note.
# supports = what the source says about the company at THIS site; [] = retained context-only source.
EVIDENCE: dict[tuple[str, str], tuple[str, list[str], str]] = {
    ("microsoft_india_development_center", "https://www.microsoft.com/en-in/msidc/hyderabad-campus"): (
        "official", ["presence"], "Microsoft's own page describes its Hyderabad campus (seed source_note)."),
    ("microsoft_india_development_center", "https://www.hmda.gov.in/wp-content/uploads/2020/07/Kokapet.pdf"): (
        "regulatory", [], "Context only: the seed does not say what this document states about this site."),
    ("google_hyderabad", "https://www.hmda.gov.in/wp-content/uploads/2020/07/Kokapet.pdf"): (
        "regulatory", [], "Context only: names Google among Hyderabad's IT/ITeS companies, not at this address (seed source_note)."),
    ("amazon_development_centre_hyderabad", "https://www.capitaland.com/en/about-capitaland/newsroom/news-releases/international/2021/feb/a-iTrust-entered-definitive-agreements-proposed-acquisition-aVance-6-Hyderabad.html"): (
        "property_owner", ["presence"], "Reported aVance 6 about 98.3% leased to Amazon in 2021; current occupancy unconfirmed (seed source_note)."),
    ("amazon_development_centre_hyderabad", "https://www.capitaland.com/en/find-a-property/global-property-listing/businesspark-industrial-logistics/avance-hitec-cityhyderabad.html"): (
        "property_owner", [], "Context only: the property listing; the seed takes the address from a separate business listing and does not say this page names aVance 6."),
    ("cognizant_mindspace_hyderabad", "https://www.mindspaceindia.com/madhapur/"): (
        "property_owner", ["building"], "Confirms the Mindspace campus, not Cognizant as a tenant (seed source_note)."),
    ("cyient_infocity_madhapur", "https://www.cyient.com/hubfs/2027/Investors/Financial-Information/annual-report/35th%20Annual%20Report%20FY%202025-26.pdf"): (
        "annual_report", ["presence", "address"], "Lists this address as Cyient's registered office (seed source_note)."),
    ("deloitte_meenakshi_techpark", "https://www.hmda.gov.in/wp-content/uploads/2020/07/Kokapet.pdf"): (
        "regulatory", [], "Context only: lists Deloitte among Hyderabad services-sector companies, not at this address (seed source_note)."),
    ("wells_fargo_divyasree_orion", "https://www.nsearchives.nseindia.com/corporate/MINDSPACE_24072025083436_AcquisitionofQCity.pdf"): (
        "regulatory", [], "Context only: the seed's location claim comes from a search result; it does not say what this filing states about Wells Fargo."),
    ("jpmorgan_sattva_knowledge_city", "https://hyderabadoffices.blogspot.com/"): (
        "third_party", ["presence"], "A third-party office directory names JP Morgan Towers at Sattva Knowledge City (seed source_note)."),
    ("jpmorgan_sattva_knowledge_city", "https://www.mindspaceindia.com/clients/"): (
        "property_owner", [], "Context only: JPMorganChase on Mindspace's Hyderabad client roster; the building relationship is unverified (seed source_note)."),
    ("ey_skyview_10", "https://www.cyient.com/hubfs/2027/Investors/Financial-Information/annual-report/35th%20Annual%20Report%20FY%202025-26.pdf"): (
        "annual_report", ["address"], "Gives The Skyview 10 as the address of Cyient's statutory auditor; not evidence that EY occupies it (seed source_note)."),
}

# Financial District discoveries (plan §6.4): the record whose matches.json reason names the way, and the way.
CANDIDATE_LEADS = {
    "lead-amazon-financial-district": ("amazon_development_centre_hyderabad", "782009439"),
    "lead-google-financial-district": ("google_hyderabad", "1247721916"),
    "lead-cognizant-financial-district": ("cognizant_mindspace_hyderabad", "342243558"),
    "lead-cyient-financial-district": ("cyient_infocity_madhapur", "879132633"),
}

MAPPED_STATUSES = ("confirmed", "unverified")  # matches.json statuses that carry a footprint


class MigrationError(Exception):
    pass


def slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.casefold()).strip("-")


def migrate(seed: list[dict], matches: dict) -> tuple[list[dict], list[dict], list[dict], list[dict]]:
    """Companies, sites, leads and one trace row per source record. Raises MigrationError on anything
    the reviewed tables do not cover; never fills a gap."""
    records = matches["records"]
    ids = [r["company_id"] for r in seed]
    if len(set(ids)) != len(ids):
        raise MigrationError("duplicate company_id in the seed")
    if set(records) != set(ids):
        raise MigrationError(f"seed and matches.json differ: {sorted(set(ids) ^ set(records))}")

    companies: dict[str, dict] = {}
    sites: list[dict] = []
    leads: list[dict] = []
    trace: list[dict] = []
    used_evidence: set[tuple[str, str]] = set()

    for row in seed:
        rid, m = row["company_id"], records[row["company_id"]]
        for col in MAP_COLUMNS:
            if row.get(col):
                raise MigrationError(f"{rid}: seed column {col} has a value; review it by hand")
        urls = [u for u in (row["source_url"], row["supporting_source_url"]) if u]

        if not row["company_name"]:  # a property's building list, not a company (the aVance row)
            if m["status"] in MAPPED_STATUSES:
                raise MigrationError(f"{rid}: a row without a company has a map link")
            leads.append({
                "id": rid,  # keeps the seed id
                "kind": "property_inventory",
                "company_id": None,
                "osm": [],
                "found": row["last_checked"],
                "why_not_a_site": m["reason"],
                "source": f"pipeline/corporate/legacy/seed-2026-11-19.json row {rid}; matches.json reason",
                "seed_record": row,
            })
            trace.append({"record": rid, "to": f"leads.json {rid} (property_inventory)", "sources": urls})
            continue

        cid = slug(row["company_name"])
        company = companies.setdefault(cid, {
            "id": cid, "name": row["company_name"], "aliases": [], "sector": row["sector"], "notes": None,
        })
        if company["name"] != row["company_name"] or company["sector"] != row["sector"]:
            raise MigrationError(f"{rid}: company {cid} appears with a different name or sector")
        if row["brand_or_entity"] and row["brand_or_entity"] != row["company_name"] \
                and row["brand_or_entity"] not in company["aliases"]:
            company["aliases"].append(row["brand_or_entity"])

        evidence = []
        for u in urls:
            key = (rid, u)
            if key not in EVIDENCE:
                raise MigrationError(f"{rid}: source {u} has no row in the reviewed EVIDENCE table")
            used_evidence.add(key)
            kind, supports, note = EVIDENCE[key]
            evidence.append({
                "url": u, "type": kind, "publisher": PUBLISHERS.get(urlsplit(u).hostname or ""),
                "retrieved": row["last_checked"], "supports": list(supports), "note": note,
            })

        status = m["status"]
        mapped = status in MAPPED_STATUSES
        footprint: dict = {"basis": m["match"] if mapped else "none"}
        if mapped:
            if m.get("campus"):
                footprint["campus"] = dict(m["campus"])
            footprint["buildings"] = [dict(b) for b in m.get("buildings", [])]
        footprint["note"] = m.get("match_note") if mapped else m.get("reason")

        sites.append({
            "id": rid,
            "company_id": cid,
            "entity": row["brand_or_entity"] or None,
            "property": row["campus_or_property"] or None,
            "building_name": row["building_name"] or None,
            "address": row["address"] or None,
            "city_area": row["city_area"] or None,
            "association_type": row["association_type"] or None,
            "operational_status": {"value": "unknown", "as_of": row["last_checked"]},
            "presence": "confirmed" if status == "confirmed" else "unverified",  # mapped, never raised
            "footprint": footprint,
            "evidence": evidence,
            "evidence_summary": row["evidence_level"] or None,
            "source_note": row["source_note"] or None,
            "legacy": {"verification_status": row["verification_status"], "matches_status": status},
            "last_checked": row["last_checked"] or None,
            "history": [],
        })
        trace.append({"record": rid, "to": f"sites.json {rid} (company {cid})", "sources": urls})

    unused = set(EVIDENCE) - used_evidence
    if unused:
        raise MigrationError(f"reviewed EVIDENCE rows with no seed source: {sorted(unused)}")

    for lid, (rid, way) in CANDIDATE_LEADS.items():
        reason = records[rid].get("reason", "")
        if f"way {way}" not in reason:
            raise MigrationError(f"{lid}: matches.json reason for {rid} does not name way {way}")
        row = next(r for r in seed if r["company_id"] == rid)
        leads.append({
            "id": lid,
            "kind": "candidate_site",
            "company_id": slug(row["company_name"]),
            "osm": [{"osm_id": f"w{way}"}],
            "found": row["last_checked"],
            "why_not_a_site": reason,
            "source": f"pipeline/corporate/matches.json reason for {rid}",
        })
        trace.append({"record": f"matches.json {rid} (way {way})", "to": f"leads.json {lid} (candidate_site)", "sources": []})

    return list(companies.values()), sites, leads, trace


ABOUT = {
    "companies.json": "Companies (who). One per company; offices are in sites.json. Migrated from the 2026-11-19 research seed (docs/corporate-model-plan.md).",
    "sites.json": "Office sites (where): place, map footprint, presence and evidence. Confidence is computed by the build, never stored. Replaces matches.json (docs/corporate-model-plan.md).",
    "leads.json": "Unpublished research leads: candidate sites and property inventories. Never published (docs/corporate-model-plan.md).",
}


def render(companies: list[dict], sites: list[dict], leads: list[dict]) -> dict[str, str]:
    """The three files' exact text (same JSON style as corporate.json)."""
    bodies = {"companies.json": ("companies", companies), "sites.json": ("sites", sites), "leads.json": ("leads", leads)}
    return {
        name: json.dumps({"_about": ABOUT[name], "schema_version": 2, key: rows}, indent=1, ensure_ascii=False) + "\n"
        for name, (key, rows) in bodies.items()
    }


def report_md(seed_sha: str, texts: dict[str, str], companies, sites, leads, trace, warnings, today: date) -> str:
    sha = {n: hashlib.sha256(t.encode("utf-8")).hexdigest() for n, t in texts.items()}
    by_site = {s["id"]: s for s in sites}
    out = [
        "# Corporate migration report",
        "",
        f"Seed: `pipeline/corporate/legacy/seed-2026-11-19.json` (SHA-256 `{seed_sha}`) and `pipeline/corporate/matches.json`.",
        f"Validated with `corporate_model.validate` at {today.isoformat()}: no errors, {len(warnings)} warnings.",
        "",
        f"{len(companies)} companies, {len(sites)} sites, {len(leads)} leads.",
        "",
        "| Output | SHA-256 |",
        "|---|---|",
        *[f"| `{n}` | `{h}` |" for n, h in sha.items()],
        "",
        "## Every source record and its destination",
        "",
        "| Source record | Destination | Presence | Basis | Published | Confidence |",
        "|---|---|---|---|---|---|",
    ]
    for t in trace:
        rid = t["record"]
        s = by_site.get(rid)
        if s:
            conf = cm.confidence(s, today)
            out.append(f"| `{rid}` | {t['to']} | {s['presence']} | {s['footprint']['basis']} | "
                       f"{'yes' if cm.published(s) else 'no'} | {conf} |")
        else:
            out.append(f"| {rid} | {t['to']} | | | no (lead) | |")
    out += ["", "## Evidence typing", "", "| Site | Type | Supports | URL |", "|---|---|---|---|"]
    for s in sites:
        for e in s["evidence"]:
            out.append(f"| `{s['id']}` | {e['type']} | {', '.join(e['supports']) or '[] context only'} | {e['url']} |")
    out += ["", "## Seed fields", "",
            "company_id → site id (lead id for the aVance row); company_name, sector → company; brand_or_entity → site entity "
            "and company alias; campus_or_property → property; building_name, address, city_area, association_type, "
            "source_note, last_checked → site; evidence_level → evidence_summary; verification_status → "
            "legacy.verification_status; source_url, supporting_source_url → evidence; building_osm_id, "
            "building_overture_id, latitude, longitude → empty in every row, not copied. The aVance row is kept whole "
            "in its lead's seed_record. matches.json status → legacy.matches_status and presence; match, campus, "
            "buildings → footprint; match_note or reason → footprint.note.", ""]
    if warnings:
        out += ["## Warnings", "", *[f"- {w}" for w in warnings], ""]
    return "\n".join(out)


def run(seed_path: Path = SEED, matches_path: Path = MATCHES, *, out_dir: Path,
        today: date | None = None, check: bool = False, force: bool = False, report_path: Path | None = None) -> dict:
    """Migrate, validate, then write (unless check). Returns a summary; raises MigrationError."""
    today = today or date.today()
    raw = seed_path.read_bytes()
    seed_sha = hashlib.sha256(raw).hexdigest()
    if seed_path == SEED and seed_sha != SEED_SHA256:
        raise MigrationError(f"{seed_path} is not the preserved seed (SHA-256 {seed_sha})")
    seed = json.loads(raw.decode("utf-8"))
    if matches_path == MATCHES and hashlib.sha256(matches_path.read_bytes()).hexdigest() != MATCHES_SHA256:
        raise MigrationError(f"{matches_path} is not the preserved matches.json")
    matches = json.loads(matches_path.read_text(encoding="utf-8"))

    companies, sites, leads, trace = migrate(seed, matches)
    errors, warnings = cm.validate(companies, sites, leads, today)
    if errors:
        raise MigrationError("validation failed, nothing written:\n  " + "\n  ".join(errors))
    texts = render(companies, sites, leads)

    differs = [n for n, t in texts.items() if (out_dir / n).exists() and (out_dir / n).read_text(encoding="utf-8") != t]
    if differs and not force:
        raise MigrationError(f"existing {differs} differ from a fresh migration; not overwritten (use --force after review)")
    if not check:
        out_dir.mkdir(parents=True, exist_ok=True)
        for n, t in texts.items():
            (out_dir / n).write_bytes(t.encode("utf-8"))
        if report_path:
            report_path.write_bytes(report_md(seed_sha, texts, companies, sites, leads, trace, warnings, today).encode("utf-8"))
    return {
        "companies": len(companies), "sites": len(sites), "leads": len(leads), "warnings": warnings,
        "sha256": {n: hashlib.sha256(t.encode("utf-8")).hexdigest() for n, t in texts.items()},
        "written": not check, "replaced": differs if force else [],
    }


RETIRED = (
    "corporate migrate was retired on 2026-11-27 after the one-off migration (docs/corporate-model-plan.md §6).\n"
    "Edit pipeline/corporate/companies.json, sites.json and leads.json directly, then run `hitec-pipeline corporate`.\n"
    "The migration's inputs are in pipeline/corporate/legacy/ and its record in pipeline/corporate/migration-report.md."
)


def cli(argv: list[str]) -> None:
    print(RETIRED, file=sys.stderr)
    sys.exit(2)
