"""Company records reach the map only through named footprints listed in matches.json."""

import json

from shapely.geometry import box, mapping

from hitec_pipeline import corporate


def feature(layer, osm_id, name, geom, id=None):
    return {"layer": layer, "osm_id": osm_id, "id": id, "name": name, "tile": "r0c0", "lat": 17.4, "lon": 78.3, "geom": mapping(geom)}


def run(tmp_path, monkeypatch, records, matches, found):
    seed, m, out = tmp_path / "seed.json", tmp_path / "matches.json", tmp_path / "out.json"
    seed.write_text(json.dumps(records), encoding="utf-8")
    m.write_text(json.dumps({"records": matches}), encoding="utf-8")
    monkeypatch.setattr(corporate, "locate", lambda ids: {k: v for k, v in found.items() if k in ids})
    report = corporate.build(seed, m, out)
    return report, json.loads(out.read_text(encoding="utf-8"))


def record(cid, **kw):
    base = {k: "" for k in corporate.KEEP} | {"company_id": cid, "company_name": cid.title(), "source_url": "https://example.org/src",
                                              "supporting_source_url": "", "verification_status": "needs_check"}
    return base | kw


def test_links_named_footprints_and_keeps_evidence(tmp_path, monkeypatch):
    campus = box(0, 0, 100, 100)
    found = {
        "w1": feature("areas", "w1", "Acme", campus),
        "w2": feature("buildings", "w2", "Acme Building 1", box(10, 10, 20, 20), id="b-2"),
        "w3": feature("buildings", "w3", "Acme Building 2", box(30, 30, 40, 40), id="b-3"),
    }
    matches = {
        "acme": {"status": "confirmed", "match": "campus", "match_note": "named", "campus": {"osm_id": "w1", "expect_name": "Acme"},
                 "buildings": [{"osm_id": "w2", "expect_name": "Acme Building 1"}, {"osm_id": "w3", "expect_name": "Acme Building 2"}]},
        "lead": {"status": "needs_manual_verification", "reason": "no named footprint"},
    }
    report, out = run(tmp_path, monkeypatch, [record("acme", evidence_level="strong"), record("lead")], matches, found)
    assert report["problems"] == []
    (site,) = out["sites"]
    assert [b["id"] for b in site["buildings"]] == ["b-2", "b-3"]  # one company, several buildings
    assert site["evidence_level"] == "strong" and site["sources"] == ["https://example.org/src"]
    assert [p["id"] for p in report["pending"]] == ["lead"]  # no footprint: reported, not published
    assert "pending" not in out


def test_rejects_a_footprint_whose_name_does_not_match(tmp_path, monkeypatch):
    found = {"w2": feature("buildings", "w2", "Someone Else Tower", box(0, 0, 10, 10), id="b-2")}
    matches = {"acme": {"status": "unverified", "match": "building", "match_note": "",
                        "buildings": [{"osm_id": "w2", "expect_name": "Acme Tower"}]}}
    report, out = run(tmp_path, monkeypatch, [record("acme")], matches, found)
    assert out["sites"] == []
    assert any("expected 'Acme Tower'" in p for p in report["problems"])


def test_flags_a_building_outside_its_campus(tmp_path, monkeypatch):
    found = {
        "w1": feature("areas", "w1", "Acme", box(0, 0, 100, 100)),
        "w2": feature("buildings", "w2", "Acme Building 9", box(500, 500, 510, 510), id="b-2"),
    }
    matches = {"acme": {"status": "confirmed", "match": "campus", "match_note": "", "campus": {"osm_id": "w1", "expect_name": "Acme"},
                        "buildings": [{"osm_id": "w2", "expect_name": "Acme Building"}]}}
    report, _ = run(tmp_path, monkeypatch, [record("acme")], matches, found)
    assert any("outside campus" in p for p in report["problems"])
