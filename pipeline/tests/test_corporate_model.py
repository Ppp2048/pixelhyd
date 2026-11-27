"""B1/B2: the company/site/lead model, computed confidence and validation (docs/corporate-model-plan.md)."""

from copy import deepcopy
from datetime import date

import pytest

from hitec_pipeline import corporate_model as cm

TODAY = date(2026, 11, 27)
OFFICIAL = {
    "url": "https://www.example.com/locations",
    "type": "official",
    "publisher": "Example",
    "retrieved": "2026-11-20",
    "supports": ["presence", "address"],
    "note": None,
}


def company(cid="acme", name="Acme Technologies", aliases=()):
    return {"id": cid, "name": name, "aliases": list(aliases), "sector": None, "notes": None}


def site(sid="acme-hitec", presence="unverified", basis="none", checked="2026-11-20", evidence=(), **kw):
    fp = {"basis": basis, "note": None}
    if basis == "campus":
        fp["campus"] = {"osm_id": "w1", "expect_name": "Acme"}
    if basis == "building":
        fp["buildings"] = [{"osm_id": "w2", "expect_name": "Tower"}]
    s = {
        "id": sid,
        "company_id": "acme",
        "entity": None,
        "property": "Acme Park",
        "building_name": None,
        "address": "Plot 1, HITEC City",
        "city_area": "HITEC City",
        "association_type": "office",
        "operational_status": {"value": "active", "as_of": "2026-11-20"},
        "presence": presence,
        "footprint": fp,
        "evidence": [deepcopy(e) for e in evidence],
        "evidence_summary": None,
        "source_note": None,
        "last_checked": checked,
        "history": [],
    }
    s.update(kw)
    return s


def lead(lid="lead-acme-gachibowli", **kw):
    out = {
        "id": lid,
        "kind": "candidate_site",
        "company_id": "acme",
        "osm": [{"osm_id": "w9", "name": "Acme Gachibowli"}],
        "found": "2026-11-19",
        "why_not_a_site": "Named on OSM only; no source places the company there.",
        "source": "osm",
    }
    out.update(kw)
    return out


def check(sites=(), leads=(), companies=None):
    return cm.validate(companies if companies is not None else [company()], list(sites), list(leads), TODAY)


# ---------------------------------------------------------------- months and confidence
@pytest.mark.parametrize(
    "d,months",
    [("2026-11-27", 0), ("2026-10-28", 0), ("2026-10-27", 1), ("2025-11-27", 12), ("2025-11-28", 11), ("2027-01-01", 0)],
)
def test_months_since_counts_whole_months(d, months):
    assert cm.months_since(date.fromisoformat(d), TODAY) == months


@pytest.mark.parametrize(
    "presence,basis,checked,expected",
    [
        ("closed", "campus", "2026-11-20", None),  # rule 1
        ("confirmed", "campus", None, "low"),  # rule 2: never checked
        ("confirmed", "campus", "2024-10-27", "low"),  # rule 2: 25 months
        ("confirmed", "campus", "2026-11-20", "high"),  # rule 3
        ("confirmed", "building", "2025-11-27", "high"),  # rule 3: exactly 12 months
        ("confirmed", "campus", "2025-10-26", "medium"),  # rule 4: 13 whole months, not yet 24
        ("confirmed", "address_only", "2026-11-20", "medium"),  # rule 4: confirmed, not mapped
        ("confirmed", "campus", "2024-11-27", "medium"),  # 24 months is still within rule 2's limit
        ("probable", "building", "2026-11-20", "medium"),  # rule 4
        ("probable", "building", "2025-06-01", "low"),  # rule 5: probable and stale
        ("probable", "none", "2026-11-20", "low"),  # rule 5: probable, not mapped
        ("unverified", "campus", "2026-11-20", "low"),  # rule 5
    ],
)
def test_confidence_follows_the_first_rule_that_applies(presence, basis, checked, expected):
    assert cm.confidence(site(presence=presence, basis=basis, checked=checked), TODAY) == expected


def test_stale_after_twelve_months():
    assert not cm.is_stale(site(checked="2025-11-27"), TODAY)
    assert not cm.is_stale(site(checked="2025-11-26"), TODAY)  # 12 whole months and a day
    assert cm.is_stale(site(checked="2025-10-26"), TODAY)
    assert not cm.is_stale(site(checked=None), TODAY)


def test_only_mapped_open_sites_are_published():
    assert cm.published(site(basis="campus"))
    assert cm.published(site(basis="building"))
    assert not cm.published(site(basis="address_only"))
    assert not cm.published(site(presence="closed", basis="campus"))


# ---------------------------------------------------------------- what evidence supports
def ev(type_, supports=("presence",), **kw):
    return {**OFFICIAL, "type": type_, "supports": list(supports), **kw}


@pytest.mark.parametrize(
    "types,expected",
    [
        ((), "unverified"),
        (("official",), "confirmed"),
        (("annual_report",), "confirmed"),
        (("regulatory",), "confirmed"),
        (("press",), "probable"),
        (("property_owner",), "probable"),
        (("listing",), "unverified"),
        (("third_party",), "unverified"),
        (("osm",), "unverified"),
        (("press", "official"), "confirmed"),
    ],
)
def test_supported_presence(types, expected):
    assert cm.supported_presence(site(evidence=[ev(t) for t in types])) == expected


def test_a_source_that_only_supports_the_address_does_not_support_presence():
    assert cm.supported_presence(site(evidence=[ev("official", supports=["address"])])) == "unverified"


# ---------------------------------------------------------------- validation: valid data
def test_a_valid_dataset_has_no_errors_or_warnings():
    sites = [
        site(presence="confirmed", basis="campus", evidence=[OFFICIAL]),
        site("acme-kokapet", property="Acme Kokapet", address="Kokapet"),
    ]
    assert check(sites, [lead()]) == ([], [])


# ---------------------------------------------------------------- validation: no upgrades without evidence
@pytest.mark.parametrize(
    "presence,evidence",
    [
        ("confirmed", []),
        ("confirmed", [ev("press")]),
        ("confirmed", [ev("official", supports=["address"])]),
        ("probable", []),
        ("probable", [ev("listing")]),
        ("probable", [ev("third_party")]),
    ],
)
def test_presence_above_its_evidence_is_an_error(presence, evidence):
    errors, _ = check([site(presence=presence, basis="campus", evidence=evidence)])
    assert any("not supported by its evidence" in e for e in errors)


def test_presence_below_its_evidence_is_allowed():
    assert check([site(presence="unverified", evidence=[OFFICIAL])]) == ([], [])


def test_osm_can_never_support_presence():
    errors, _ = check([site(evidence=[ev("osm")])])
    assert any("OSM source cannot support presence" in e for e in errors)
    assert check([site(evidence=[ev("osm", supports=["building"])])]) == ([], [])


def test_closed_needs_a_source_for_the_status():
    assert any("closed needs" in e for e in check([site(presence="closed")])[0])
    assert check([site(presence="closed", evidence=[ev("press", supports=["status"])])]) == ([], [])


# ---------------------------------------------------------------- validation: sources and dates
@pytest.mark.parametrize(
    "url",
    [
        "https://www.google.com/maps/place/Acme",
        "https://google.co.in/maps?q=acme",
        "https://maps.google.com/?cid=1",
        "https://maps.app.goo.gl/abc",
        "https://goo.gl/maps/abc",
    ],
)
def test_google_maps_is_rejected(url):
    errors, _ = check([site(evidence=[ev("third_party", url=url)])])
    assert any("Google Maps" in e for e in errors)


def test_other_google_pages_are_not_google_maps():
    assert not cm.is_google_maps("https://www.google.com/about/locations/")
    assert not cm.is_google_maps("https://blog.google/maps-of-india/")


def test_urls_must_be_https():
    errors, _ = check([site(evidence=[ev("press", url="http://example.com/news")])])
    assert any("https" in e for e in errors)


def test_evidence_cannot_be_newer_than_the_check():
    errors, _ = check([site(checked="2026-11-01", evidence=[OFFICIAL])])  # retrieved 2026-11-20
    assert any("retrieved after last_checked" in e for e in errors)


@pytest.mark.parametrize("checked", ["2026-12-01", "27/11/2026", "2026-02-30"])
def test_last_checked_must_be_a_real_past_iso_date(checked):
    assert check([site(checked=checked)])[0]


def test_unknown_enums_are_errors():
    bad = [
        site(presence="maybe"),
        site(basis="street"),
        site(operational_status={"value": "open", "as_of": "2026-11-20"}),
        site(evidence=[ev("blog")]),
        site(evidence=[ev("official", supports=["vibes"])]),
    ]
    for s in bad:
        assert check([s])[0], s


# ---------------------------------------------------------------- validation: footprints and coordinates
def test_hand_entered_coordinates_are_rejected():
    errors, _ = check([site(lat=17.45, lon=78.38)])
    assert any("'lat'" in e for e in errors) and any("'lon'" in e for e in errors)


@pytest.mark.parametrize(
    "fp",
    [
        {"basis": "campus", "note": None},
        {"basis": "building", "buildings": [], "note": None},
        {"basis": "address_only", "buildings": [{"osm_id": "w2", "expect_name": "Tower"}], "note": None},
        {"basis": "building", "buildings": [{"osm_id": "2", "expect_name": "Tower"}], "note": None},
        {"basis": "building", "buildings": [{"osm_id": "w2", "expect_name": ""}], "note": None},
    ],
)
def test_footprint_refs_must_match_the_basis(fp):
    assert check([site(footprint=fp)])[0]


# ---------------------------------------------------------------- validation: ids and duplicates
def test_ids_are_unique_lowercase_slugs():
    assert check([site("Acme HITEC")])[0]
    assert check([site(), site()])[0]
    assert check(companies=[company(), company()])[0]
    assert check(companies=[company("Acme")])[0]


def test_a_site_needs_a_known_company():
    assert any("unknown company" in e for e in check([site(company_id="globex")])[0])


def test_company_names_and_aliases_cannot_collide():
    errors, _ = check(companies=[company(), company("acme-2", "ACME Technologies.")])
    assert any("collides" in e for e in errors)
    errors, _ = check(companies=[company(aliases=["Acme & Co"]), company("acme-co", "Acme and Co")])
    assert any("collides" in e for e in errors)


def test_the_same_company_cannot_map_one_footprint_twice():
    errors, _ = check([site(basis="campus"), site("acme-b", basis="campus", property="Other", address="Elsewhere")])
    assert any("footprint w1" in e for e in errors)


def test_the_same_company_cannot_list_one_place_twice():
    errors, _ = check([site(), site("acme-b", property="ACME park", address="plot 1 hitec city")])
    assert any("same property and address" in e for e in errors)


def test_several_companies_in_one_building_are_fine_but_a_shared_campus_warns():
    companies = [company(), company("globex", "Globex")]
    a = site(basis="building")
    b = site("globex-hitec", basis="building", company_id="globex")
    assert check([a, b], companies=companies) == ([], [])
    a, b = site(basis="campus"), site("globex-hitec", basis="campus", company_id="globex")
    errors, warnings = check([a, b], companies=companies)
    assert errors == [] and any("several companies" in w for w in warnings)


# ---------------------------------------------------------------- validation: freshness
def test_freshness_warnings():
    assert check([site(checked="2025-11-27")]) == ([], [])
    assert any("stale" in w for w in check([site(checked="2025-06-01")])[1])
    assert any("confidence low" in w for w in check([site(checked="2024-06-01")])[1])


# ---------------------------------------------------------------- validation: leads
def test_leads_need_a_reason_a_source_and_their_own_id():
    assert any("why_not_a_site" in e for e in check(leads=[lead(why_not_a_site="")])[0])
    assert any("no source" in e for e in check(leads=[lead(source=None)])[0])
    assert any("already used" in e for e in check([site()], [lead("acme-hitec")])[0])
    assert any("already used" in e for e in check(leads=[lead(), lead()])[0])
    assert any("kind" in e for e in check(leads=[lead(kind="rumour")])[0])
    assert any("future" in e for e in check(leads=[lead(found="2027-01-01")])[0])


def test_property_inventory_leads_need_no_company_but_candidates_do():
    assert check(leads=[lead(kind="property_inventory", company_id=None)]) == ([], [])
    assert any("needs a company" in e for e in check(leads=[lead(company_id=None)])[0])
    assert any("unknown company" in e for e in check(leads=[lead(company_id="globex")])[0])


def test_validation_is_pure():
    s = site(presence="confirmed", basis="campus", evidence=[OFFICIAL])
    before = deepcopy(s)
    check([s])
    assert s == before


# ---------------------------------------------------------------- context-only sources (supports = [])
CONTEXT = {**OFFICIAL, "type": "regulatory", "supports": []}


def test_a_context_only_source_is_valid_and_kept():
    s = site(evidence=[CONTEXT])
    assert check([s]) == ([], [])
    assert s["evidence"][0]["url"] == OFFICIAL["url"]


@pytest.mark.parametrize("type_", cm.SOURCE_TYPES)
def test_a_context_only_source_cannot_establish_presence(type_):
    s = site(evidence=[{**CONTEXT, "type": type_}])
    assert cm.supported_presence(s) == "unverified"
    for presence in ("confirmed", "probable"):
        errors, _ = check([site(presence=presence, basis="campus", evidence=[{**CONTEXT, "type": type_}])])
        assert any("not supported by its evidence" in e for e in errors)


def test_a_context_only_source_cannot_close_a_site():
    assert any("closed needs" in e for e in check([site(presence="closed", evidence=[CONTEXT])])[0])


def test_a_context_only_source_does_not_raise_confidence_or_publish():
    bare = site(basis="none")
    with_context = site(basis="none", evidence=[CONTEXT, {**CONTEXT, "type": "official"}])
    assert cm.confidence(with_context, TODAY) == cm.confidence(bare, TODAY) == "low"
    assert not cm.published(with_context)
    mapped = site(basis="campus", evidence=[CONTEXT])
    assert cm.confidence(mapped, TODAY) == "low"


def test_non_empty_supports_are_still_checked():
    assert check([site(evidence=[{**CONTEXT, "supports": ["context"]}])])[0]
    assert check([site(evidence=[{**CONTEXT, "supports": "presence"}])])[0]
    assert check([site(evidence=[{**CONTEXT, "supports": None}])])[0]
