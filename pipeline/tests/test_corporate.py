"""The corporate.json build: sites reach the map only through named footprints; v1 output fields are kept."""

import json
from copy import deepcopy
from datetime import date

from shapely.geometry import box, mapping

from hitec_pipeline import corporate, corporate_migrate

TODAY = date(2026, 11, 27)
V1_FIELDS = ["id", "status", "match", "match_note", "company_name", "brand_or_entity", "sector", "campus_or_property",
             "building_name", "address", "city_area", "association_type", "evidence_level", "verification_status",
             "source_note", "last_checked", "sources", "campus", "buildings", "lat", "lon"]
V2_FIELDS = ["company_id", "presence", "footprint_basis", "confidence", "operational_status", "evidence", "stale"]
OFFICIAL = {"url": "https://example.org/acme", "type": "official", "publisher": "Acme", "retrieved": "2026-11-20",
            "supports": ["presence"], "note": None}
CONTEXT = {"url": "https://example.org/context", "type": "regulatory", "publisher": None, "retrieved": "2026-11-20",
           "supports": [], "note": "context only"}


def feature(layer, osm_id, name, geom, id=None):
    return {"layer": layer, "osm_id": osm_id, "id": id, "name": name, "tile": "r0c0", "lat": 17.4, "lon": 78.3, "geom": mapping(geom)}


CAMPUS = {
    "w1": feature("areas", "w1", "Acme", box(0, 0, 100, 100)),
    "w2": feature("buildings", "w2", "Acme Building 1", box(10, 10, 20, 20), id="b-2"),
    "w3": feature("buildings", "w3", "Acme Building 2", box(30, 30, 40, 40), id="b-3"),
}


def company(cid="acme", name="Acme"):
    return {"id": cid, "name": name, "aliases": [], "sector": "Software", "notes": None}


def site(sid="acme-hitec", presence="unverified", basis="none", evidence=(), company_id="acme", **kw):
    fp = {"basis": basis, "note": "how it was linked"}
    if basis == "campus":
        fp |= {"campus": {"osm_id": "w1", "expect_name": "Acme"},
               "buildings": [{"osm_id": "w2", "expect_name": "Acme Building 1"}, {"osm_id": "w3", "expect_name": "Acme Building 2"}]}
    if basis == "building":
        fp |= {"buildings": [{"osm_id": "w2", "expect_name": "Acme Building 1"}]}
    s = {"id": sid, "company_id": company_id, "entity": "Acme India", "property": f"Park {sid}", "building_name": None,
         "address": f"Plot {sid}", "city_area": "HITEC City", "association_type": "office",
         "operational_status": {"value": "unknown", "as_of": "2026-11-20"}, "presence": presence, "footprint": fp,
         "evidence": list(evidence), "evidence_summary": "strong", "source_note": "note",
         "legacy": {"verification_status": "needs_check"}, "last_checked": "2026-11-20", "history": []}
    return s | kw


def run(tmp_path, monkeypatch, sites, found=CAMPUS, companies=None, leads=()):
    paths = {n: tmp_path / f"{n}.json" for n in ("companies", "sites", "leads")}
    for n, rows in (("companies", companies or [company()]), ("sites", sites), ("leads", list(leads))):
        paths[n].write_text(json.dumps({n: rows}), encoding="utf-8")
    seen = []
    monkeypatch.setattr(corporate, "locate", lambda ids: seen.append(set(ids)) or {k: v for k, v in found.items() if k in ids})
    out = tmp_path / "out.json"
    report = corporate.build(paths["companies"], paths["sites"], paths["leads"], out, today=TODAY)
    return report, (json.loads(out.read_text(encoding="utf-8")) if out.exists() else None), seen


# ---------------------------------------------------------------- ported from the matches.json build
def test_links_named_footprints_and_keeps_evidence(tmp_path, monkeypatch):
    report, out, _ = run(tmp_path, monkeypatch, [
        site(presence="confirmed", basis="campus", evidence=[OFFICIAL, CONTEXT]), site("lead-like", basis="none")])
    assert report["problems"] == []
    (s,) = out["sites"]
    assert [b["id"] for b in s["buildings"]] == ["b-2", "b-3"]  # one site, several buildings
    assert s["status"] == "confirmed" and s["evidence_level"] == "strong"
    assert s["sources"] == [OFFICIAL["url"], CONTEXT["url"]]  # context-only sources are kept
    assert [p["id"] for p in report["pending"]] == ["lead-like"]  # no footprint: reported, not published
    assert "pending" not in out


def test_rejects_a_footprint_whose_name_does_not_match(tmp_path, monkeypatch):
    found = {"w2": feature("buildings", "w2", "Someone Else Tower", box(0, 0, 10, 10), id="b-2")}
    report, out, _ = run(tmp_path, monkeypatch, [site(basis="building")], found)
    assert out["sites"] == []
    assert any("expected 'Acme Building 1'" in p for p in report["problems"])


def test_flags_a_building_outside_its_campus(tmp_path, monkeypatch):
    found = CAMPUS | {"w3": feature("buildings", "w3", "Acme Building 2", box(500, 500, 510, 510), id="b-3")}
    report, out, _ = run(tmp_path, monkeypatch, [site(presence="confirmed", basis="campus", evidence=[OFFICIAL])], found)
    assert any("outside campus" in p for p in report["problems"])
    assert out["sites"][0]["status"] == "unverified"  # a failed link never yields confirmed


# ---------------------------------------------------------------- output shape
def test_v1_fields_keep_their_order_and_v2_fields_are_added(tmp_path, monkeypatch):
    _, out, _ = run(tmp_path, monkeypatch, [site(presence="confirmed", basis="campus", evidence=[OFFICIAL])])
    (s,) = out["sites"]
    assert list(s) == V1_FIELDS + V2_FIELDS
    assert (s["company_id"], s["presence"], s["footprint_basis"], s["confidence"], s["stale"]) == (
        "acme", "confirmed", "campus", "high", False)
    assert s["company_name"] == "Acme" and s["brand_or_entity"] == "Acme India" and s["match"] == "campus"
    assert out["schema_version"] == 2 and list(out)[:3] == ["generated_at", "dataset", "attribution"]


def test_one_company_with_two_published_sites(tmp_path, monkeypatch):
    found = CAMPUS | {"w9": feature("buildings", "w9", "Acme Tower", box(900, 900, 910, 910), id="b-9")}
    other = site("acme-kokapet", basis="building", footprint={
        "basis": "building", "buildings": [{"osm_id": "w9", "expect_name": "Acme Tower"}], "note": None})
    _, out, _ = run(tmp_path, monkeypatch, [site(presence="confirmed", basis="campus", evidence=[OFFICIAL]), other], found)
    assert [s["id"] for s in out["sites"]] == ["acme-hitec", "acme-kokapet"]
    assert {s["company_id"] for s in out["sites"]} == {"acme"}
    assert out["companies"] == [{"id": "acme", "name": "Acme", "aliases": [], "sector": "Software",
                                 "sites": ["acme-hitec", "acme-kokapet"]}]


def test_companies_without_a_published_site_are_not_listed(tmp_path, monkeypatch):
    companies = [company(), company("globex", "Globex")]
    _, out, _ = run(tmp_path, monkeypatch, [site(basis="building"), site("globex-1", company_id="globex")], companies=companies)
    assert [c["id"] for c in out["companies"]] == ["acme"]


# ---------------------------------------------------------------- publication and evidence rules
def test_closed_and_unmapped_sites_are_not_published(tmp_path, monkeypatch):
    closed = site("acme-old", presence="closed", basis="campus",
                  evidence=[{**OFFICIAL, "supports": ["status"]}], property="Old", address="Old")
    _, out, seen = run(tmp_path, monkeypatch, [closed, site("acme-addr", basis="address_only")])
    assert out["sites"] == []
    assert seen == [set()]  # nothing to look up


def test_context_only_sources_raise_nothing(tmp_path, monkeypatch):
    _, out, _ = run(tmp_path, monkeypatch, [site(basis="building", evidence=[CONTEXT, {**CONTEXT, "type": "official"}])])
    (s,) = out["sites"]
    assert (s["status"], s["presence"], s["confidence"]) == ("unverified", "unverified", "low")


def test_a_validation_error_writes_nothing(tmp_path, monkeypatch):
    report, out, _ = run(tmp_path, monkeypatch, [site(presence="confirmed", basis="campus", evidence=[CONTEXT])])
    assert out is None and not report["written"]
    assert any("not supported by its evidence" in p for p in report["problems"])


def test_stale_and_old_sites(tmp_path, monkeypatch):
    old = site(presence="confirmed", basis="campus", evidence=[{**OFFICIAL, "retrieved": "2025-06-01"}], last_checked="2025-06-01")
    report, out, _ = run(tmp_path, monkeypatch, [old])
    assert out["sites"][0]["stale"] and out["sites"][0]["confidence"] == "medium"
    assert report["warnings"]


def test_lead_osm_ids_are_checked_against_the_map(tmp_path, monkeypatch):
    leads = [{"id": "lead-acme", "kind": "candidate_site", "company_id": "acme", "osm": [{"osm_id": "w2"}, {"osm_id": "w404"}],
              "found": "2026-11-19", "why_not_a_site": "OSM only", "source": "test"}]
    report, out, _ = run(tmp_path, monkeypatch, [], leads=leads)
    assert report["leads"][0]["osm"][0] == {"osm_id": "w2", "layer": "buildings", "name": "Acme Building 1"}
    assert any("w404 not found" in p for p in report["problems"])
    assert out["sites"] == []  # leads are never published


# ---------------------------------------------------------------- the real data
def test_the_build_reads_the_migrated_files_and_not_matches_json():
    assert corporate.COMPANIES.parent == corporate_migrate.CORP
    assert not (corporate_migrate.CORP / "matches.json").exists()  # retired: legacy/matches-2026-11.json
    assert "matches" not in json.dumps([str(p) for p in (corporate.COMPANIES, corporate.SITES, corporate.LEADS)])


def test_the_real_sites_publish_as_before(tmp_path, monkeypatch):
    """Golden: with today's map features for their footprints, the real files publish the same two sites."""
    sites = json.loads(corporate.SITES.read_text(encoding="utf-8"))["sites"]
    found = {}
    for s in sites:
        fp = s["footprint"]
        if fp.get("campus"):
            found[fp["campus"]["osm_id"]] = feature("areas", fp["campus"]["osm_id"], fp["campus"]["expect_name"], box(-1e4, -1e4, 1e4, 1e4))
        for b in fp.get("buildings") or []:
            found[b["osm_id"]] = feature("buildings", b["osm_id"], b["expect_name"], box(0, 0, 10, 10), id=f"id-{b['osm_id']}")
    paths = (corporate.COMPANIES, corporate.SITES, corporate.LEADS)
    monkeypatch.setattr(corporate, "locate", lambda ids: {k: v for k, v in found.items() if k in ids})
    report = corporate.build(*paths, tmp_path / "out.json", today=TODAY)
    out = json.loads((tmp_path / "out.json").read_text(encoding="utf-8"))
    got = [(s["id"], s["status"], s["match"], s["confidence"]) for s in out["sites"]]
    assert got == [("microsoft_india_development_center", "confirmed", "campus", "high"),
                   ("wells_fargo_divyasree_orion", "unverified", "building", "low")]
    assert len(report["pending"]) == 7 and len(report["leads"]) == 5
    assert out["dataset"] == "pixelhyd_hyderabad_corporate_seed_dataset.json"
    assert deepcopy(out["sites"][0]["sources"]) == [e["url"] for e in sites[0]["evidence"]]
