"""B3: the seed + matches.json → companies/sites/leads migration (docs/corporate-model-plan.md §6)."""

import hashlib
import json
from copy import deepcopy
from datetime import date

import pytest

from hitec_pipeline import corporate_migrate as mig
from hitec_pipeline import corporate_model as cm

TODAY = date(2026, 11, 27)
SEED = json.loads(mig.SEED.read_text(encoding="utf-8"))
MATCHES = json.loads(mig.MATCHES.read_text(encoding="utf-8"))
AVANCE = "avance_business_hub_building_inventory"


@pytest.fixture(scope="module")
def out():
    return mig.migrate(deepcopy(SEED), deepcopy(MATCHES))


def test_the_preserved_inputs_are_the_ones_migrated():
    assert hashlib.sha256(mig.SEED.read_bytes()).hexdigest() == mig.SEED_SHA256
    assert hashlib.sha256(mig.MATCHES.read_bytes()).hexdigest() == mig.MATCHES_SHA256
    assert mig.MATCHES.parent.name == "legacy"


def test_the_archived_inputs_still_give_the_recorded_output(out):
    texts = mig.render(*out[:3])
    assert {n: hashlib.sha256(t.encode("utf-8")).hexdigest() for n, t in texts.items()} == mig.MIGRATED_SHA256


def test_the_command_is_retired_and_writes_nothing(capsys):
    before = {n: (mig.CORP / n).read_bytes() for n in mig.OUTPUTS}
    with pytest.raises(SystemExit) as e:
        mig.cli(["--force"])
    assert e.value.code == 2 and "retired" in capsys.readouterr().err
    assert {n: (mig.CORP / n).read_bytes() for n in mig.OUTPUTS} == before


def test_run_never_defaults_to_the_live_files():
    with pytest.raises(TypeError):
        mig.run()  # out_dir is required


def test_nine_companies_nine_sites_five_leads(out):
    companies, sites, leads, _ = out
    assert [c["id"] for c in companies] == [
        "microsoft", "google", "amazon", "cognizant", "cyient", "deloitte", "wells-fargo", "jpmorgan-chase", "ey"]
    assert len(sites) == 9 and len(leads) == 5


def test_every_id_is_kept_and_none_is_new(out):
    _, sites, leads, _ = out
    seed_ids = [r["company_id"] for r in SEED]
    assert [s["id"] for s in sites] == [i for i in seed_ids if i != AVANCE]
    assert AVANCE in {lead["id"] for lead in leads}
    new = {lead["id"] for lead in leads} - set(seed_ids)
    assert new == set(mig.CANDIDATE_LEADS)


def test_the_output_validates(out):
    companies, sites, leads, _ = out
    assert cm.validate(companies, sites, leads, TODAY) == ([], [])


def test_statuses_are_mapped_never_raised(out):
    _, sites, _, _ = out
    got = {s["id"]: (s["presence"], s["footprint"]["basis"], cm.published(s), cm.confidence(s, TODAY)) for s in sites}
    assert got.pop("microsoft_india_development_center") == ("confirmed", "campus", True, "high")
    assert got.pop("wells_fargo_divyasree_orion") == ("unverified", "building", True, "low")
    assert set(got.values()) == {("unverified", "none", False, "low")}
    for s in sites:
        assert s["legacy"]["matches_status"] == MATCHES["records"][s["id"]]["status"]


def test_every_seed_field_is_copied_verbatim(out):
    companies, sites, leads, _ = out
    by_company = {c["id"]: c for c in companies}
    rows = {r["company_id"]: r for r in SEED}
    for s in sites:
        r, c = rows[s["id"]], by_company[s["company_id"]]
        assert (c["name"], c["sector"]) == (r["company_name"], r["sector"])
        assert (s["entity"], s["property"], s["building_name"], s["address"], s["city_area"], s["association_type"]) == (
            r["brand_or_entity"], r["campus_or_property"], r["building_name"], r["address"], r["city_area"], r["association_type"])
        assert (s["evidence_summary"], s["source_note"], s["last_checked"]) == (r["evidence_level"], r["source_note"], r["last_checked"])
        assert s["legacy"]["verification_status"] == r["verification_status"]
        assert [e["url"] for e in s["evidence"]] == [u for u in (r["source_url"], r["supporting_source_url"]) if u]
        assert all(e["retrieved"] == r["last_checked"] for e in s["evidence"])
        assert not {"lat", "lon", "latitude", "longitude"} & set(s)
    avance = next(lead for lead in leads if lead["id"] == AVANCE)
    assert avance["seed_record"] == rows[AVANCE] and avance["kind"] == "property_inventory"


def test_footprints_come_from_matches(out):
    _, sites, _, _ = out
    for s in sites:
        m, fp = MATCHES["records"][s["id"]], s["footprint"]
        if m["status"] in mig.MAPPED_STATUSES:
            assert fp.get("campus") == m.get("campus") and fp["buildings"] == m["buildings"]
            assert fp["note"] == m["match_note"]
        else:
            assert "campus" not in fp and "buildings" not in fp and fp["note"] == m["reason"]


def test_context_only_sources_are_kept_and_count_for_nothing(out):
    _, sites, _, _ = out
    context = sorted((s["id"], e["url"].split("/")[2]) for s in sites for e in s["evidence"] if e["supports"] == [])
    assert context == [
        ("amazon_development_centre_hyderabad", "www.capitaland.com"),
        ("deloitte_meenakshi_techpark", "www.hmda.gov.in"),
        ("google_hyderabad", "www.hmda.gov.in"),
        ("jpmorgan_sattva_knowledge_city", "www.mindspaceindia.com"),
        ("microsoft_india_development_center", "www.hmda.gov.in"),
        ("wells_fargo_divyasree_orion", "www.nsearchives.nseindia.com"),
    ]
    for s in sites:
        bare = {**s, "evidence": [e for e in s["evidence"] if e["supports"]]}
        assert cm.supported_presence(bare) == cm.supported_presence(s)


def test_candidate_leads_name_the_ways_in_matches(out):
    _, _, leads, _ = out
    for lid, (rid, way) in mig.CANDIDATE_LEADS.items():
        lead = next(x for x in leads if x["id"] == lid)
        assert lead["osm"] == [{"osm_id": f"w{way}"}]
        assert lead["why_not_a_site"] == MATCHES["records"][rid]["reason"]


def test_every_record_is_traced(out):
    _, _, _, trace = out
    assert {t["record"] for t in trace} >= {r["company_id"] for r in SEED}
    assert len(trace) == len(SEED) + len(mig.CANDIDATE_LEADS)


# ---------------------------------------------------------------- determinism and safety
def test_running_twice_gives_identical_files(tmp_path):
    a = mig.run(out_dir=tmp_path, today=TODAY, report_path=tmp_path / "r.md")
    first = {n: (tmp_path / n).read_bytes() for n in mig.OUTPUTS}
    b = mig.run(out_dir=tmp_path, today=TODAY, report_path=tmp_path / "r.md")
    assert {n: (tmp_path / n).read_bytes() for n in mig.OUTPUTS} == first
    assert a["sha256"] == b["sha256"]
    assert b["replaced"] == []


def test_research_edits_are_not_overwritten_without_force(tmp_path):
    mig.run(out_dir=tmp_path, today=TODAY, report_path=None)
    (tmp_path / "sites.json").write_text("{}", encoding="utf-8")
    with pytest.raises(mig.MigrationError, match="not overwritten"):
        mig.run(out_dir=tmp_path, today=TODAY, report_path=None)
    assert (tmp_path / "sites.json").read_text(encoding="utf-8") == "{}"
    assert mig.run(out_dir=tmp_path, today=TODAY, report_path=None, force=True)["replaced"] == ["sites.json"]


def test_check_writes_nothing(tmp_path):
    mig.run(out_dir=tmp_path, today=TODAY, check=True, report_path=tmp_path / "r.md")
    assert list(tmp_path.iterdir()) == []


def write_inputs(tmp_path, seed, matches):
    (tmp_path / "seed.json").write_text(json.dumps(seed), encoding="utf-8")
    (tmp_path / "matches.json").write_text(json.dumps(matches), encoding="utf-8")
    return dict(seed_path=tmp_path / "seed.json", matches_path=tmp_path / "matches.json", out_dir=tmp_path / "out",
                today=TODAY, report_path=None)


def test_a_validation_failure_writes_nothing(tmp_path):
    matches = deepcopy(MATCHES)
    matches["records"]["deloitte_meenakshi_techpark"] = {**MATCHES["records"]["microsoft_india_development_center"]}
    with pytest.raises(mig.MigrationError, match="not supported by its evidence"):
        mig.run(**write_inputs(tmp_path, SEED, matches))
    assert not (tmp_path / "out").exists()


def test_an_untyped_source_stops_the_migration():
    seed = deepcopy(SEED)
    seed[1]["supporting_source_url"] = "https://example.com/new"
    with pytest.raises(mig.MigrationError, match="no row in the reviewed EVIDENCE table"):
        mig.migrate(seed, MATCHES)


def test_a_dropped_source_stops_the_migration():
    seed = deepcopy(SEED)
    seed[0]["supporting_source_url"] = ""
    with pytest.raises(mig.MigrationError, match="no seed source"):
        mig.migrate(seed, MATCHES)


def test_hand_entered_coordinates_stop_the_migration():
    seed = deepcopy(SEED)
    seed[2]["latitude"] = "17.45"
    with pytest.raises(mig.MigrationError, match="latitude"):
        mig.migrate(seed, MATCHES)


def test_seed_and_matches_must_cover_the_same_records():
    matches = deepcopy(MATCHES)
    del matches["records"]["ey_skyview_10"]
    with pytest.raises(mig.MigrationError, match="differ"):
        mig.migrate(SEED, matches)
