"""PG accommodation (paying guest, hostel and co-living homes) for the home finder.

Inputs (never modified):
  pipeline/residential/pgs.json                  operators, details read from operators' own pages, rejected listings
  data/raw/residential/overture_places.parquet   the Overture download amenities.py already uses

residential.build publishes the records with their nearby places and drive times in files of their own
(residential_pgs.json and friends), which the app reads only when PGs are shown.

Rules (so every listing can be checked):
- A candidate is an Overture place with confidence >= amenities.MIN_CONFIDENCE whose name says PG, paying
  guest, hostel or co-living (_PG), or that links a known operator's property page. Names with institutional
  words (_INSTITUTION: college, government, blind ...) and university or government websites are left out,
  and so are operators' flat-rental pages (`flat_paths`).
- One PG listed several times is one record: listings that link the same operator page, or whose names
  match within NEAR_M once PG words, operator names and "house" are set aside. Its point is the most
  confident listing's. A PG is never moved onto a building.
- status:
    confirmed   the operator's own page, read on `checked`, lists the property and its address
    probable    the listing links the operator's page for this property, which was not read
    unverified  open data only
    closed      a dated source says it has closed
- Facts (address, rent, deposit, services) come only from curated details with an https source and a date.
  Gender may also come from the operator link (paths like /female/) or the listing name ("Boys Hostel");
  `from` says which. Anything else is not published.
- Operators whose robots.txt or terms forbid automated reading or reuse (`read: false`) are not read, and
  details may not cite their pages; their PGs carry the link only.
- Contact is the operator page only. Phone numbers in listings are not published: many are personal mobiles.
- A PG's neighbourhood follows the societies' rule (nearest curated centre within 3 km), so one spot gets one
  name whatever is there; beyond those, the nearest OpenStreetMap suburb or town point within 3 km (osm_areas).
- A PG whose listings disagree on where it is keeps the other listings' points (`location.others`).
"""

from __future__ import annotations

import json
import math
import re
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]
SEED = ROOT / "residential" / "pgs.json"
OUT_NAME, COMMUTE_OUT_NAME, PLACES_OUT_NAME = "residential_pgs.json", "residential_pg_commute.json", "residential_pg_places.json"

STATUS = ("confirmed", "probable", "unverified", "closed")
GENDER = ("men", "women", "mixed")
KIND = ("pg", "co-living")
SHARING = ("single", "double", "triple", "other")
SERVICES = ("food", "wifi", "ac", "laundry", "housekeeping")
NEAR_M = 80.0
SPREAD_NOTE_M = 250.0  # listings of one PG further apart than this are reported

_PG = re.compile(r"\b(p\.?\s?g|paying\s+guests?|co-?\s?living|hostels?)\b", re.I)
_INSTITUTION = re.compile(
    r"\b(colleges?|universit(y|ies)|schools?|institutes?|government|govt|blind|orphan\w*|welfare|ashram|tribal|police|"
    r"hospitals?|nursing|campus|iiit|mission|madrasa|seminary|mbbs|diploma|degree)\b", re.I)
CAMPUS = {("amenity", "university"), ("amenity", "college"), ("amenity", "school"), ("landuse", "education")}
_INSTITUTION_WEB = re.compile(r"\.(ac|edu|gov|nic)\.in\b|\.edu\b", re.I)
_MIXED = re.compile(
    r"\b(unisex|co-?\s?ed|(ladies|girls|women|females?)\s*(&|and|/)\s*(gents|boys|men|males?)|"
    r"(gents|boys|men|males?)\s*(&|and|/)\s*(ladies|girls|women|females?))\b", re.I)
_WOMEN = re.compile(r"\b(ladies|women|womens|women['’]s|girls|girls['’]|girl['’]s|girl|female|females)\b", re.I)
_MEN = re.compile(r"\b(gents|men|mens|men['’]s|boys|boys['’]|boy['’]s|boy|male|males)\b", re.I)
_SET_ASIDE = {"pg", "p", "g", "hostel", "hostels", "paying", "guest", "guests", "co", "living", "coliving", "boys", "boy",
              "girls", "girl", "men", "mens", "women", "womens", "ladies", "gents", "male", "female", "for", "near",
              "house", "stay", "stays", "luxury", "unisex", "ed", "the", "and", "in", "of", "s", "hyderabad"}
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _https(v) -> bool:
    return isinstance(v, str) and v.startswith("https://")


def page_key(url: str | None) -> str | None:
    """A link without query, fragment or trailing slash, lower-cased, for grouping listings."""
    if not url:
        return None
    u = urlsplit(url.strip())
    host = u.netloc.lower().removeprefix("www.")
    return f"{host}{u.path.rstrip('/')}".lower() if host else None


def clean_link(url: str) -> str:
    """The link as published, without query or fragment (tracking parameters; some robots.txt files disallow them)."""
    u = urlsplit(url.strip())
    scheme = "https" if u.scheme in ("http", "https") else u.scheme
    return f"{scheme}://{u.netloc}{u.path}"


def clean_name(name: str) -> str:
    """Listing names carry advertising after a bar or a spaced dash: 'Zolo Bourbon - PG in Gachibowli | Coliving PG'.
    Gender and co-living are read from the full name before this."""
    return re.sub(r"\s+", " ", re.split(r"\s+[-–|]\s+|\|", name)[0]).strip(" -,")


def gender_from_name(name: str) -> str | None:
    if _MIXED.search(name):
        return "mixed"
    w, m = bool(_WOMEN.search(name)), bool(_MEN.search(name))
    return "women" if w and not m else "men" if m and not w else None


def operator_for(url: str | None, operators: list[dict]) -> dict | None:
    host = (urlsplit(url).netloc.lower().removeprefix("www.") if url else "")
    for op in operators:
        if any(host == d or host.endswith("." + d) for d in op["domains"]):
            return op
    return None


def link_facts(url: str, op: dict) -> dict:
    """What the operator's own link says, read from the address only: property page or not, flat or not, gender."""
    path = urlsplit(url).path.lower()
    gender = next((g for p, g in (op.get("gender_paths") or {}).items() if p in path), None)
    return {
        "property": any(p in path for p in op.get("property_paths") or []),
        "flat": any(p in path for p in op.get("flat_paths") or []),
        "gender": gender,
    }


def _tokens(name: str, operators: list[dict]) -> set[str]:
    words = set(re.findall(r"[a-z0-9]+", name.lower())) - _SET_ASIDE
    for op in operators:
        words -= set(re.findall(r"[a-z0-9]+", op["name"].lower()))
    return words


def _same_name(a: set[str], b: set[str]) -> bool:
    return bool(a and b) and (a <= b or b <= a or len(a & b) / len(a | b) >= 0.5)


def candidate(row: dict, operators: list[dict], forced: bool = False) -> dict | None:
    """One Overture row as a PG listing, or None. `forced` keeps a row a curated detail names."""
    from shapely import wkb

    from .amenities import MIN_CONFIDENCE

    full = (row.get("names") or {}).get("primary") or ""
    name = clean_name(full)
    brand = ((row.get("brand") or {}).get("names") or {}).get("primary") or ""
    web = next((w for w in row.get("websites") or [] if w), None)
    op = operator_for(web, operators)
    link = link_facts(web, op) if op else {"property": False, "flat": False, "gender": None}
    if not forced:
        if not name or (row.get("confidence") or 0) < MIN_CONFIDENCE:
            return None
        if row.get("operating_status") in ("permanently_closed", "temporarily_closed"):
            return None
        if link["flat"] or _INSTITUTION.search(name) or (web and _INSTITUTION_WEB.search(web)):
            return None
        if not (_PG.search(full) or _PG.search(brand) or link["property"]):
            return None
    pt = wkb.loads(row["geometry"])
    return {
        "overture": row["id"], "name": name or brand, "confidence": round(row.get("confidence") or 0, 2),
        "lat": round(pt.y, 6), "lon": round(pt.x, 6),
        "operator": op["id"] if op else None,
        "page": clean_link(web) if op and link["property"] else None,
        "web": clean_link(web) if web else None,
        "link_gender": link["gender"], "name_gender": gender_from_name(full),
        "coliving": bool(re.search(r"co-?\s?living", full, re.I)) or bool(op and op.get("kind") == "co-living"),
    }


def group(cands: list[dict], operators: list[dict], to_utm) -> list[list[dict]]:
    """Listings of the same PG: the same operator page, or matching names within NEAR_M (union-find)."""
    parent = list(range(len(cands)))

    def root(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def join(i, j):
        parent[root(i)] = root(j)

    by_page: dict[str, int] = {}
    for i, c in enumerate(cands):
        key = page_key(c["page"])
        if key:
            if key in by_page:
                join(i, by_page[key])
            else:
                by_page[key] = i
    xy = [to_utm(c["lon"], c["lat"]) for c in cands]
    toks = [_tokens(c["name"], operators) for c in cands]
    grid: dict[tuple[int, int], list[int]] = {}
    for i, (x, y) in enumerate(xy):
        gx, gy = int(x // NEAR_M), int(y // NEAR_M)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for j in grid.get((gx + dx, gy + dy), ()):
                    if math.dist(xy[i], xy[j]) <= NEAR_M and _same_name(toks[i], toks[j]):
                        # different operator pages are different PGs, whatever their names
                        if not (cands[i]["page"] and cands[j]["page"] and page_key(cands[i]["page"]) != page_key(cands[j]["page"])):
                            join(i, j)
        grid.setdefault((gx, gy), []).append(i)
    groups: dict[int, list[dict]] = {}
    for i, c in enumerate(cands):
        groups.setdefault(root(i), []).append(c | {"x": xy[i][0], "y": xy[i][1]})
    return list(groups.values())


def campuses(elements, to_utm) -> list:
    """University, college and school grounds mapped in OpenStreetMap, as UTM polygons. Hostels inside them
    belong to the institution, not to the rental market."""
    from shapely.geometry import LineString, Polygon
    from shapely.ops import polygonize, transform, unary_union

    out = []
    for el in elements:
        t = el.get("tags") or {}
        if not any(t.get(k) == v for k, v in CAMPUS):
            continue
        rings = []
        if el["type"] == "way" and len(el.get("geometry") or []) >= 4:
            rings = [[(p["lon"], p["lat"]) for p in el["geometry"]]]
        elif el["type"] == "relation":
            rings = [[(p["lon"], p["lat"]) for p in m["geometry"]] for m in el.get("members") or []
                     if m.get("role") in ("outer", "") and len(m.get("geometry") or []) >= 2]
        if not rings:
            continue
        if el["type"] == "way":
            if rings[0][0] != rings[0][-1]:
                continue
            geom = Polygon(rings[0])
        else:
            geom = unary_union(list(polygonize(unary_union([LineString(r) for r in rings]))))
        if geom.is_empty or not geom.is_valid:
            geom = geom.buffer(0)
        if not geom.is_empty:
            out.append(transform(lambda x, y, z=None: to_utm(x, y), geom))
    return out


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:48].strip("-")


def check(d: dict, operators: dict[str, dict]) -> list[str]:
    """Problems with one curated detail record (empty when it can be published)."""
    pid = d.get("id", "?")
    out = []
    if not (isinstance(d.get("id"), str) and d["id"].startswith("pg-") and d.get("name")):
        out.append(f"{pid}: needs an id starting 'pg-' and a name")
    if d.get("status") not in STATUS:
        out.append(f"{pid}: status must be one of {STATUS}")
    if not (d.get("overture") or d.get("location")):
        out.append(f"{pid}: needs the Overture listing(s) it describes or a sourced location")
    loc = d.get("location")
    if loc and not (_https(loc.get("source")) and isinstance(loc.get("lat"), float) and isinstance(loc.get("lon"), float)):
        out.append(f"{pid}: location needs lat, lon and an https source")
    op = operators.get(d.get("operator")) if d.get("operator") else None
    if d.get("operator") and op is None:
        out.append(f"{pid}: unknown operator {d['operator']!r}")
    if d.get("checked") is not None and not (isinstance(d["checked"], str) and _DATE.match(d["checked"])):
        out.append(f"{pid}: checked must be a YYYY-MM-DD date")
    if d.get("status") == "confirmed" and not (_https(d.get("page")) and d.get("address") and d.get("checked")):
        out.append(f"{pid}: confirmed needs the operator page, the address it gives and the date it was read")
    if d.get("gone") is not None:  # the operator's page no longer lists the property, as of this date
        if not (isinstance(d["gone"], str) and _DATE.match(d["gone"])) or d.get("status") not in ("unverified", "closed"):
            out.append(f"{pid}: gone is a YYYY-MM-DD date, and the status is then unverified or closed")
    sources = []
    for key in ("address", "deposit", "gender"):
        f = d.get(key)
        if f is not None:
            if not (isinstance(f, dict) and f.get("value") not in (None, "") and _https(f.get("source"))):
                out.append(f"{pid}: {key} needs a value and an https source")
            else:
                sources.append(f["source"])
    if d.get("gender") and d["gender"].get("value") not in GENDER:
        out.append(f"{pid}: gender must be one of {GENDER}")
    if d.get("kind") is not None and d["kind"] not in KIND:
        out.append(f"{pid}: kind must be one of {KIND}")
    for i, r in enumerate(d.get("rent") or []):
        where = f"{pid}: rent {i + 1}"
        if r.get("sharing") not in SHARING or not r.get("label"):
            out.append(f"{where} needs sharing (one of {SHARING}) and the page's own label")
        if not (isinstance(r.get("from_inr"), int) and 1000 <= r["from_inr"] <= 200_000):
            out.append(f"{where}: from_inr must be whole rupees")
        if r.get("period", "?") not in ("month", None) or not isinstance(r.get("starting"), bool):
            out.append(f"{where}: period is 'month' or null (the page states none), and starting is true/false")
        if not _https(r.get("source")):
            out.append(f"{where} needs an https source")
        else:
            sources.append(r["source"])
    for key, f in (d.get("services") or {}).items():
        if key not in SERVICES:
            out.append(f"{pid}: unknown service {key!r}")
        elif not (isinstance(f, dict) and isinstance(f.get("value"), bool) and _https(f.get("source"))):
            out.append(f"{pid}: service {key} needs true/false and an https source")
        else:
            sources.append(f["source"])
    if sources and not d.get("checked"):
        out.append(f"{pid}: facts need the date they were read (checked)")
    for s in sources:
        sop = operator_for(s, list(operators.values()))
        if sop and not sop.get("read"):
            out.append(f"{pid}: {sop['name']} pages may not be read or reused ({sop.get('basis', 'see operators')})")
    return out


def load_rows(path: Path | None = None) -> list[dict]:
    import pyarrow.parquet as pq

    from .amenities import RAW

    cols = ["id", "geometry", "confidence", "names", "brand", "websites", "operating_status"]
    return pq.read_table(path or RAW / "overture_places.parquet", columns=cols).to_pylist()


def records(seed: dict, rows: list[dict], to_utm, grounds: list = ()) -> tuple[list[dict], list[str], list[str]]:
    """The PGs to publish from the seed and the Overture rows; `grounds` are campus polygons (UTM) whose
    hostels are left out. Returns (records, problems, notes)."""
    operators = seed.get("operators", [])
    ops = {o["id"]: o for o in operators}
    problems, notes = [], []
    details = []
    for d in seed.get("details", []):
        p = check(d, ops)
        problems += p
        if not p:
            details.append(d)
    ids = [d["id"] for d in seed.get("details", [])]
    problems += [f"{i}: duplicate id" for i in sorted({i for i in ids if ids.count(i) > 1})]
    rejected = {r["overture"] for r in seed.get("rejected", [])}
    named = {o: d for d in details for o in d.get("overture") or []}
    by_id = {r["id"]: r for r in rows}
    for o in named:
        if o not in by_id:
            problems.append(f"{named[o]['id']}: Overture listing {o} is not in the download")
    cands = [c for r in rows if r["id"] not in rejected
             for c in [candidate(r, operators, forced=r["id"] in named)] if c]
    if grounds:
        import shapely

        pts = shapely.points([to_utm(c["lon"], c["lat"]) for c in cands])
        on_campus = shapely.STRtree(list(grounds)).query(pts, predicate="within")[0]
        # operators' own property pages stay: some run hostels next to or for a college
        drop = {i for i in set(on_campus.tolist()) if cands[i]["overture"] not in named and not cands[i]["page"]}
        if drop:
            notes.append(f"left out, on university, college or school grounds: {', '.join(sorted(cands[i]['name'] for i in drop))}")
        cands = [c for i, c in enumerate(cands) if i not in drop]

    out, used = [], set()
    for g in group(cands, operators, to_utm):
        # the point: a curated listing, else a named one that most other listings agree with, else the most confident
        support = {c["overture"]: sum(math.dist((c["x"], c["y"]), (o["x"], o["y"])) <= SPREAD_NOTE_M for o in g) for c in g}
        g.sort(key=lambda c: (c["overture"] not in named, not _tokens(c["name"], operators), -support[c["overture"]],
                              -c["confidence"], c["overture"]))
        best = g[0]
        detail = next((named[c["overture"]] for c in g if c["overture"] in named), None)
        if detail and detail["id"] in used:
            problems.append(f"{detail['id']}: its listings fall in two groups; list them once")
            continue
        spread = max(math.dist((best["x"], best["y"]), (c["x"], c["y"])) for c in g)
        named_listings = [c for c in g if _tokens(c["name"], operators)]
        gone = (detail or {}).get("gone")
        page = None if gone else (detail or {}).get("page") or next((c["page"] for c in g if c["page"]), None)
        op = (detail or {}).get("operator") or next((c["operator"] for c in g if c["operator"]), None)
        if (detail or {}).get("name"):
            name = detail["name"]
        elif named_listings or not (page and op):
            name = max(named_listings or g, key=lambda c: (c["confidence"], len(c["name"])))["name"]
        else:  # listings named only after the operator: the page address names the house ('.../raleigh-house')
            name = f"{ops[op]['name']} {urlsplit(page).path.rstrip('/').rsplit('/', 1)[-1].replace('-', ' ').title()}"
        if detail and detail.get("gender"):
            gender = {"value": detail["gender"]["value"], "from": "page", "source": detail["gender"]["source"]}
        elif detail and detail.get("status") == "confirmed":
            gender = None  # the page was read and is the authority; it does not say (or contradicts itself)
        elif any(c["link_gender"] for c in g):
            gender = {"value": next(c["link_gender"] for c in g if c["link_gender"]), "from": "link"}
        else:
            values = {c["name_gender"] for c in g if c["name_gender"]}
            gender = {"value": values.pop(), "from": "name"} if len(values) == 1 else None
        status = (detail or {}).get("status") or ("probable" if page else "unverified")
        # ids stay put when listings come and go: an operator page names one PG; otherwise the name and first listing
        pid = (detail or {}).get("id") or (f"pg-{_slug(name)}" if page else f"pg-{_slug(name)}-{min(c['overture'] for c in g)[:6]}")
        location = {"from": "overture", "listings": len(g), "spread_m": int(round(spread, -1)),
                    "listings_agree": spread <= SPREAD_NOTE_M}
        if spread > SPREAD_NOTE_M:
            notes.append(f"{pid}: its {len(g)} listings are up to {round(spread, -1):.0f} m apart; location uncertain")
            # the listings that disagree with the chosen point, so the map can show where else it may be
            location["others"] = [{"lat": c["lat"], "lon": c["lon"]} for c in g[1:]
                                  if math.dist((best["x"], best["y"]), (c["x"], c["y"])) > SPREAD_NOTE_M]
        used.add(pid)
        out.append({
            "id": pid,
            "name": name,
            "operator": op,
            "kind": (detail or {}).get("kind") or ("co-living" if any(c["coliving"] for c in g) else "pg"),
            "gender": gender,
            "status": status,
            "lat": best["lat"],
            "lon": best["lon"],
            "location": location,
            "page": page,
            "page_gone": gone,
            "address": (detail or {}).get("address"),
            "rent": (detail or {}).get("rent") or [],
            "deposit": (detail or {}).get("deposit"),
            "services": (detail or {}).get("services") or {},
            "checked": (detail or {}).get("checked"),
            "note": (detail or {}).get("note"),
            "overture": sorted(c["overture"] for c in g),
        })
    for d in details:
        if d["id"] not in used and not d.get("overture"):  # a PG known from a visit or a page, not from open data
            loc = d["location"]
            out.append({"id": d["id"], "name": d["name"], "operator": d.get("operator"), "kind": d.get("kind") or "pg",
                        "gender": ({"value": d["gender"]["value"], "from": "page", "source": d["gender"]["source"]}
                                   if d.get("gender") else None),
                        "status": d["status"], "lat": loc["lat"], "lon": loc["lon"],
                        "location": {"from": "source", "source": loc["source"]}, "page": d.get("page"), "page_gone": d.get("gone"),
                        "address": d.get("address"), "rent": d.get("rent") or [], "deposit": d.get("deposit"),
                        "services": d.get("services") or {}, "checked": d.get("checked"), "note": d.get("note"),
                        "overture": []})
    pids = [r["id"] for r in out]
    problems += [f"{i}: two PGs share this id" for i in sorted({i for i in pids if pids.count(i) > 1})]
    out.sort(key=lambda r: r["id"])
    return out, problems, notes


def osm_areas(taken: set[str], path: Path | None = None) -> list[dict]:
    """Suburb and town centres (OpenStreetMap place points from the search download), for PGs beyond the
    societies' neighbourhoods. Ids already `taken` by those neighbourhoods are skipped."""
    from . import places

    path = path or places._raw() / "places_osm.json"
    if not path.exists():
        return []
    out: dict[str, dict] = {}
    for e in sorted(json.loads(path.read_text(encoding="utf-8"))["elements"], key=lambda e: e.get("id", 0)):
        t = e.get("tags") or {}
        if e.get("type") != "node" or t.get("place") not in places.MAJOR_AREAS or not t.get("name"):
            continue
        hid = _slug(t["name"])
        if hid in taken:
            continue
        if hid in out:  # two places of one name: the second keeps its OSM id
            hid = f"{hid}-n{e['id']}"
        out[hid] = {"id": hid, "name": t["name"], "lat": e["lat"], "lon": e["lon"], "osm_id": f"n{e['id']}", "place": t["place"]}
    return list(out.values())


def operators_public(seed: dict) -> list[dict]:
    keep = ("id", "name", "site", "kind", "read", "basis", "terms", "checked")
    return [{k: o.get(k) for k in keep} for o in seed.get("operators", [])]


STATUS_TEXT = {
    "confirmed": "The operator's own page, read on the date given, lists this PG and its address.",
    "probable": "An open-data listing links the operator's page for this PG; the page was not read.",
    "unverified": "Known only from open-data listings.",
    "closed": "A dated source says it has closed.",
}


def write(out_dir: Path, generated: str, seed: dict, recs: list[dict], kept: list[dict], trips: dict | None,
          places_attribution: str, roads_attribution: str, hoods: list[dict] = ()) -> dict:
    """Write the PG files next to the societies' files. `recs` already carry `nearby`, `metro` and their
    neighbourhood; `hoods` are the neighbourhoods they use that the societies' file does not list."""
    from .amenities import CATEGORIES, RADIUS_M

    out = {
        "generated_at": generated,
        "attribution": "PG listings: Overture Maps Foundation places (CDLA-Permissive-2.0). Details: each operator's own "
                       "page, cited per fact with the date read. " + places_attribution,
        "statuses": STATUS_TEXT,
        "operators": operators_public(seed),
        "amenities": {"categories": CATEGORIES, "radius_m": RADIUS_M,
                      "measure": "straight-line distance from the PG's listed point", "places_file": PLACES_OUT_NAME},
        "commute": {"file": COMMUTE_OUT_NAME if trips else None,
                    "kind": "estimated drive with assumed road speeds and no traffic data",
                    "metro": "nearest Hyderabad Metro station from OpenStreetMap; ride times not included"},
        "neighbourhoods": list(hoods),
        "pgs": recs,
    }
    (out_dir / OUT_NAME).write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    fields = ["id", "name", "cat", "source", "lat", "lon"]
    compact = {"generated_at": generated, "attribution": places_attribution, "categories": CATEGORIES,
               "fields": fields, "places": [[p[f] for f in fields] for p in kept]}
    (out_dir / PLACES_OUT_NAME).write_text(json.dumps(compact, ensure_ascii=False, separators=(",", ":")) + "\n",
                                           encoding="utf-8")
    if trips:
        body = {k: v for k, v in trips.items() if k != "societies"} | {"pgs": trips["societies"]}
        (out_dir / COMMUTE_OUT_NAME).write_text(
            json.dumps({"generated_at": generated, "attribution": roads_attribution} | body,
                       ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    count = lambda key: {v: sum(r[key] == v for r in recs) for v in sorted({r[key] for r in recs}, key=str)}  # noqa: E731
    return {
        "pgs": len(recs),
        "status": count("status"),
        "with_rent": sum(bool(r["rent"]) for r in recs),
        "location_disputed": sum(not r["location"].get("listings_agree", True) for r in recs),
        "no_neighbourhood": sum(not r.get("neighbourhood") for r in recs),
        "places_nearby": len(kept),
    }


def load_seed(path: Path = SEED) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))
