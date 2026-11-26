"""Companies, their office sites and research leads: structures, confidence and validation.

The design is docs/corporate-model-plan.md (approved 2026-11-27). Pure functions, no I/O: the build
(corporate.py) and the migration read the files and pass the records in. OSM map links (ids resolve,
names match, buildings inside the campus) are checked by the build, which has the map data.

Source of truth, pipeline/corporate/:
  companies.json  who: id, canonical name, aliases, sector, notes
  sites.json      each office: company, place, footprint links, presence, evidence, history
  leads.json      unpublished research leads (candidate sites, property inventories)
"""

from __future__ import annotations

import re
import unicodedata
from datetime import date
from typing import Literal, NotRequired, TypedDict
from urllib.parse import urlsplit

# ---------------------------------------------------------------- fixed values
PRESENCE = ("confirmed", "probable", "unverified", "closed")
BASIS = ("campus", "building", "property_only", "address_only", "none")
MAPPED = ("campus", "building")  # bases that carry OSM refs and can be published
OPERATIONAL = ("active", "under_construction", "closed", "unknown")
SOURCE_TYPES = ("official", "annual_report", "regulatory", "property_owner", "press", "listing", "osm", "third_party")
SUPPORTS = ("presence", "address", "building", "status")
LEAD_KINDS = ("candidate_site", "property_inventory")
CONFIDENCE = ("high", "medium", "low")

CONFIRMS = ("official", "annual_report", "regulatory")  # can make presence "confirmed"
SUGGESTS = ("press", "property_owner")  # can make presence at most "probable"

STALE_MONTHS = 12  # older: a warning, `stale` in the output, confidence at most medium
EXPIRED_MONTHS = 24  # older: confidence low (= web/src/lib/freshness.ts RENT_*_MONTHS)

ID = re.compile(r"^[a-z0-9]+(?:[_-][a-z0-9]+)*$")
ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


# ---------------------------------------------------------------- structures
class Company(TypedDict):
    id: str
    name: str
    aliases: list[str]  # only names found in a cited source or the seed
    sector: str | None
    notes: str | None


class OsmRef(TypedDict):
    osm_id: str  # e.g. "w159299918"
    expect_name: str  # must be contained (case-insensitive) in the OSM name


class Footprint(TypedDict):
    basis: Literal["campus", "building", "property_only", "address_only", "none"]
    campus: NotRequired[OsmRef | None]
    buildings: NotRequired[list[OsmRef]]
    note: str | None  # how the link was made (was matches.json match_note / reason)


class Evidence(TypedDict):
    url: str
    type: str  # SOURCE_TYPES
    publisher: str | None
    retrieved: str  # ISO date the source was read
    supports: list[str]  # SUPPORTS: what the source says, not what we infer; [] = context only
    note: str | None


class Operational(TypedDict):
    value: str  # OPERATIONAL
    as_of: str  # ISO date


class HistoryEntry(TypedDict):
    date: str
    change: str
    by: str
    reason: str


class Site(TypedDict):
    id: str  # never reused; a closed site keeps its id
    company_id: str
    entity: str | None
    property: str | None
    building_name: str | None
    address: str | None
    city_area: str | None
    association_type: str | None
    operational_status: Operational
    presence: str  # PRESENCE
    footprint: Footprint
    evidence: list[Evidence]
    evidence_summary: str | None
    source_note: str | None
    legacy: NotRequired[dict]  # verbatim seed fields kept for the output contract
    last_checked: str | None
    history: list[HistoryEntry]


class Lead(TypedDict):
    id: str
    kind: str  # LEAD_KINDS
    company_id: NotRequired[str | None]
    osm: NotRequired[list[dict]]
    found: str
    why_not_a_site: str
    source: str
    seed_record: NotRequired[dict]  # the research row it came from, verbatim (migrated leads)


# ---------------------------------------------------------------- dates and confidence
def parse_date(s: object) -> date | None:
    """An ISO date (YYYY-MM-DD), or None when missing or unreadable."""
    if not isinstance(s, str) or not ISO_DATE.match(s):
        return None
    try:
        return date.fromisoformat(s)
    except ValueError:
        return None


def months_since(d: date, today: date) -> int:
    """Whole months from `d` to `today` (0 when `d` is later)."""
    months = (today.year - d.year) * 12 + today.month - d.month - (1 if today.day < d.day else 0)
    return max(0, months)


def age_months(site: Site, today: date) -> int | None:
    d = parse_date(site.get("last_checked"))
    return None if d is None else months_since(d, today)


def confidence(site: Site, today: date) -> str | None:
    """docs/corporate-model-plan.md §4.4, first rule that applies. Computed, never stored."""
    presence, basis, age = site["presence"], site["footprint"]["basis"], age_months(site, today)
    if presence == "closed":
        return None
    if age is None or age > EXPIRED_MONTHS:
        return "low"
    mapped = basis in MAPPED
    if presence == "confirmed" and mapped and age <= STALE_MONTHS:
        return "high"
    if presence == "confirmed" or (presence == "probable" and mapped and age <= STALE_MONTHS):
        return "medium"
    return "low"


def is_stale(site: Site, today: date) -> bool:
    age = age_months(site, today)
    return age is not None and age > STALE_MONTHS


def supports(e: Evidence) -> list[str]:
    """What a source supports; anything but a list (a validation error) supports nothing."""
    s = e.get("supports")
    return s if isinstance(s, list) else []


def supported_presence(site: Site) -> str:
    """The strongest presence the site's evidence allows (§4.3); OSM never supports presence."""
    kinds = {e["type"] for e in site.get("evidence") or [] if "presence" in supports(e)}
    if kinds & set(CONFIRMS):
        return "confirmed"
    if kinds & set(SUGGESTS):
        return "probable"
    return "unverified"


def published(site: Site) -> bool:
    """Whether a site can reach corporate.json (its OSM refs must also resolve, checked by the build)."""
    return site["presence"] != "closed" and site["footprint"]["basis"] in MAPPED


# ---------------------------------------------------------------- normalising
def norm_name(s: str) -> str:
    """For duplicate checks: case, accents, '&' and punctuation do not make a name different."""
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().casefold().replace("&", " and ")
    return re.sub(r"[^a-z0-9]+", "", s)


def footprint_ids(site: Site) -> set[str]:
    fp = site["footprint"]
    ids = {b["osm_id"] for b in fp.get("buildings") or []}
    if fp.get("campus"):
        ids.add(fp["campus"]["osm_id"])
    return ids


def is_google_maps(url: str) -> bool:
    """CLAUDE.md rule 3: Google Maps content is not a data source."""
    u = urlsplit(url)
    host, path = (u.hostname or "").lower(), u.path.lower()
    if host in ("maps.app.goo.gl",) or host.startswith("maps.google.") or (host == "goo.gl" and path.startswith("/maps")):
        return True
    return bool(re.match(r"^(www\.)?google\.[a-z.]+$", host)) and path.startswith("/maps")


# ---------------------------------------------------------------- validation
RANK = {"unverified": 0, "probable": 1, "confirmed": 2}


def validate(companies: list[Company], sites: list[Site], leads: list[Lead], today: date) -> tuple[list[str], list[str]]:
    """Errors (the build fails) and warnings, per docs/corporate-model-plan.md §7. Map links are the build's."""
    errors: list[str] = []
    warnings: list[str] = []
    err, warn = errors.append, warnings.append

    # ---- companies
    by_company: dict[str, Company] = {}
    names: dict[str, str] = {}  # normalised name or alias → company id
    for c in companies:
        cid = c.get("id")
        if not isinstance(cid, str) or not ID.match(cid):
            err(f"company {cid!r}: id must be a lowercase slug")
            continue
        if cid in by_company:
            err(f"company {cid}: duplicate id")
            continue
        by_company[cid] = c
        if not c.get("name"):
            err(f"company {cid}: no name")
            continue
        for n in {norm_name(x) for x in [c["name"], *c.get("aliases", [])] if x}:
            other = names.setdefault(n, cid)
            if other != cid:
                err(f"company {cid}: name or alias collides with company {other}")

    # ---- sites
    site_ids: set[str] = set()
    footprints: dict[tuple[str, str], str] = {}  # (company, osm id) → site
    places: dict[tuple[str, str, str], str] = {}  # (company, property, address) → site
    campuses: dict[str, list[tuple[str, str]]] = {}  # campus osm id → [(company, site)]
    for s in sites:
        sid = s.get("id")
        if not isinstance(sid, str) or not ID.match(sid):
            err(f"site {sid!r}: id must be a lowercase slug")
            continue
        if sid in site_ids:
            err(f"site {sid}: duplicate id")
            continue
        site_ids.add(sid)
        problems = _site_problems(s, by_company, today)
        errors.extend(f"site {sid}: {p}" for p in problems)
        if problems:
            continue

        # duplicates within one company; shared buildings across companies are fine (multi-tenant)
        co = s["company_id"]
        for oid in footprint_ids(s):
            other = footprints.setdefault((co, oid), sid)
            if other != sid:
                err(f"site {sid}: footprint {oid} is already site {other} of the same company")
        if s.get("property") and s.get("address"):
            key = (co, norm_name(s["property"]), norm_name(s["address"]))
            other = places.setdefault(key, sid)
            if other != sid:
                err(f"site {sid}: same property and address as site {other} of the same company")
        if (campus := s["footprint"].get("campus")) and s["presence"] != "closed":
            campuses.setdefault(campus["osm_id"], []).append((co, sid))

        # freshness
        age = age_months(s, today)
        if age is not None and age > EXPIRED_MONTHS:
            warn(f"site {sid}: last checked {age} months ago (confidence low)")
        elif age is not None and age > STALE_MONTHS:
            warn(f"site {sid}: last checked {age} months ago (stale)")

    for oid, claims in campuses.items():
        if len({co for co, _ in claims}) > 1:
            warn(f"campus {oid} is claimed whole by sites of several companies: {', '.join(s for _, s in claims)}")

    # ---- leads
    lead_ids: set[str] = set()
    for lead in leads:
        lid = lead.get("id")
        if not isinstance(lid, str) or not ID.match(lid):
            err(f"lead {lid!r}: id must be a lowercase slug")
            continue
        if lid in lead_ids or lid in site_ids:
            err(f"lead {lid}: id already used by another lead or a site")
            continue
        lead_ids.add(lid)
        if lead.get("kind") not in LEAD_KINDS:
            err(f"lead {lid}: kind must be one of {LEAD_KINDS}")
        if lead.get("company_id") is not None and lead["company_id"] not in by_company:
            err(f"lead {lid}: unknown company {lead['company_id']!r}")
        if lead.get("kind") == "candidate_site" and not lead.get("company_id"):
            err(f"lead {lid}: a candidate site needs a company")
        for k in ("why_not_a_site", "source"):
            if not lead.get(k):
                err(f"lead {lid}: no {k}")
        found = parse_date(lead.get("found"))
        if found is None or found > today:
            err(f"lead {lid}: found must be an ISO date, not in the future")

    return errors, warnings


def _site_problems(s: Site, companies: dict[str, Company], today: date) -> list[str]:
    """Structure, footprint, evidence and date rules for one site."""
    out: list[str] = []
    if s.get("company_id") not in companies:
        out.append(f"unknown company {s.get('company_id')!r}")
    if s.get("presence") not in PRESENCE:
        return out + [f"presence must be one of {PRESENCE}"]
    for k in ("lat", "lon", "latitude", "longitude"):
        if k in s:
            out.append(f"has {k!r}: published coordinates come only from resolved footprints")
    op = s.get("operational_status") or {}
    if op.get("value") not in OPERATIONAL:
        out.append(f"operational_status.value must be one of {OPERATIONAL}")
    if (d := parse_date(op.get("as_of"))) is None or d > today:
        out.append("operational_status.as_of must be an ISO date, not in the future")

    # footprint
    fp = s.get("footprint") or {}
    basis = fp.get("basis")
    refs = ([fp["campus"]] if fp.get("campus") else []) + list(fp.get("buildings") or [])
    if basis not in BASIS:
        out.append(f"footprint.basis must be one of {BASIS}")
    elif basis == "campus" and not fp.get("campus"):
        out.append("footprint basis campus needs a campus ref")
    elif basis == "building" and not fp.get("buildings"):
        out.append("footprint basis building needs at least one building ref")
    elif basis not in MAPPED and refs:
        out.append(f"footprint basis {basis} cannot carry OSM refs")
    for r in refs:
        if not re.match(r"^[nwr]\d+$", str(r.get("osm_id"))) or not r.get("expect_name"):
            out.append(f"footprint ref {r!r} needs an OSM id (n/w/r + digits) and an expect_name")

    # dates
    checked = parse_date(s.get("last_checked"))
    if s.get("last_checked") is not None and checked is None:
        out.append("last_checked must be an ISO date")
    if checked and checked > today:
        out.append("last_checked is in the future")

    # evidence
    for i, e in enumerate(s.get("evidence") or []):
        where = f"evidence[{i}]"
        url = e.get("url") or ""
        if urlsplit(url).scheme != "https":
            out.append(f"{where}: url must be https")
        if is_google_maps(url):
            out.append(f"{where}: Google Maps is not a data source")
        if e.get("type") not in SOURCE_TYPES:
            out.append(f"{where}: type must be one of {SOURCE_TYPES}")
        sup = e.get("supports")
        # [] is a retained context-only source: it backs no claim about the site (plan §4.2)
        if not isinstance(sup, list) or any(x not in SUPPORTS for x in sup):
            out.append(f"{where}: supports must be a list of {SUPPORTS} ([] for a context-only source)")
        elif e.get("type") == "osm" and "presence" in sup:
            out.append(f"{where}: an OSM source cannot support presence")
        retrieved = parse_date(e.get("retrieved"))
        if retrieved is None:
            out.append(f"{where}: retrieved must be an ISO date")
        elif (checked and retrieved > checked) or retrieved > today:
            out.append(f"{where}: retrieved after last_checked or in the future")

    # presence needs evidence
    p = s["presence"]
    if p == "closed":
        if not any("status" in supports(e) for e in s.get("evidence") or []):
            out.append("presence closed needs a source supporting status")
    elif RANK[p] > RANK[supported_presence(s)]:
        out.append(f"presence {p} is not supported by its evidence (at most {supported_presence(s)})")

    for i, h in enumerate(s.get("history") or []):
        if parse_date(h.get("date")) is None or not all(h.get(k) for k in ("change", "by", "reason")):
            out.append(f"history[{i}] needs date, change, by and reason")
    return out
