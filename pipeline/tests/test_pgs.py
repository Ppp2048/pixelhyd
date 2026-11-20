"""PGs: listings come from open data by stated rules, facts only from readable operator pages, nothing estimated."""

import json

from pyproj import Transformer
from shapely import wkb
from shapely.geometry import Point, box

from hitec_pipeline import pgs, residential

PAGE = "https://zolostays.com/pg-hostel-near-gachibowli-in-hyderabad-zolo_test-zt01"
OPS = [
    {"id": "zolo", "name": "Zolo", "domains": ["zolostays.com"], "kind": "pg", "read": True, "property_paths": ["/pg-hostel-near-"]},
    {"id": "stanza", "name": "Stanza Living", "domains": ["stanzaliving.com"], "kind": "pg", "read": False, "basis": "terms",
     "property_paths": ["/hyderabad/"], "flat_paths": ["/apartments/"], "gender_paths": {"/female/": "women", "/male/": "men"}},
]


def to_utm(lon, lat):  # metres near the test points; good enough for distances of a few hundred metres
    return lon * 106_000.0, lat * 110_600.0


def row(oid, name, lon=78.36, lat=17.44, conf=0.85, web=None, brand=None):
    return {"id": oid, "geometry": wkb.dumps(Point(lon, lat)), "confidence": conf, "names": {"primary": name},
            "brand": {"names": {"primary": brand}} if brand else None, "websites": [web] if web else None,
            "operating_status": None}


def recs(rows, details=(), rejected=(), grounds=()):
    seed = {"operators": OPS, "details": list(details), "rejected": list(rejected)}
    return pgs.records(seed, rows, to_utm, list(grounds))


def test_a_listing_counts_only_when_its_name_or_operator_page_says_pg():
    out, problems, _ = recs([row("a", "Sri Sai Boys Hostel"), row("b", "Sai Residency", lon=78.37),
                             row("c", "Stanza Living", lon=78.38, web="https://www.stanzaliving.com/hyderabad/pg-in-x/male/rome-house")])
    assert problems == []
    assert sorted(r["name"] for r in out) == ["Sri Sai Boys Hostel", "Stanza Living Rome House"]


def test_low_confidence_institutions_degrees_and_flats_are_left_out():
    out, _, _ = recs([row("a", "Good PG", conf=0.4), row("b", "Govt Welfare Hostel", lon=78.37),
                      row("c", "Pragnya Degree and PG Colleges", lon=78.38),
                      row("d", "Stanza Living - Flat", lon=78.39, web="https://www.stanzaliving.com/apartments/x")])
    assert out == []


def test_hostels_on_campus_grounds_are_left_out_unless_an_operator_page_lists_them():
    campus = box(*to_utm(78.355, 17.435), *to_utm(78.365, 17.445))
    out, _, notes = recs([row("a", "Old Boys Hostel"),
                          row("b", "Stanza Living Kent House", web="https://www.stanzaliving.com/hyderabad/pg-in-x/male/kent-house")],
                         grounds=[campus])
    assert [r["name"] for r in out] == ["Stanza Living Kent House"]
    assert "Old Boys Hostel" in notes[0]


def test_listings_of_one_page_are_one_pg_and_far_apart_listings_mark_the_location_disputed():
    page = "https://www.stanzaliving.com/hyderabad/pg-in-x/female/kent-house?utm_source=gmb"
    out, _, notes = recs([row("a", "Stanza Living Kent House", web=page), row("b", "Stanza Living Kent House", lat=17.4405, web=page),
                          row("c", "Stanza Living", lon=78.40, conf=0.9, web=page)])
    assert len(out) == 1
    r = out[0]
    assert r["status"] == "probable" and r["gender"] == {"value": "women", "from": "link"}
    assert r["page"] == "https://www.stanzaliving.com/hyderabad/pg-in-x/female/kent-house"  # tracking query dropped
    assert (r["lon"], r["lat"]) == (78.36, 17.44)  # a named listing others agree with, not the stray brand pin
    assert r["location"]["listings_agree"] is False and "location uncertain" in notes[0]
    assert r["location"]["others"] == [{"lat": 17.44, "lon": 78.40}]  # the stray pin is kept, as another possible spot


def test_two_different_houses_of_one_operator_next_door_stay_apart():
    out, _, _ = recs([row("a", "Stanza Living Kent House PG"), row("b", "Stanza Living Rome House PG", lon=78.3601)])
    assert len(out) == 2


def test_gender_from_the_name_only_when_it_is_unambiguous():
    assert pgs.gender_from_name("Zolo Fortuna - PG | Ladies & Gents PG") == "mixed"
    assert pgs.gender_from_name("Harini Men’s Hostel B") == "men"
    assert pgs.gender_from_name("Sravanthi women's hostel") == "women"
    assert pgs.gender_from_name("Sri Kruthi Hostel and PG") is None
    assert pgs.clean_name("Zolo Bourbon - PG in Gachibowli | Coliving PG") == "Zolo Bourbon"


def detail(**kw):
    return {"id": "pg-zolo-test", "name": "Zolo Test", "operator": "zolo", "overture": ["a"], "status": "confirmed",
            "page": PAGE, "checked": "2026-11-20", "address": {"value": "1 Main Road, Gachibowli", "source": PAGE},
            "rent": [{"sharing": "double", "label": "Two Sharing", "from_inr": 8428, "period": None, "starting": True, "source": PAGE}],
            "services": {"food": {"value": False, "source": PAGE}}} | kw


def test_a_confirmed_pg_carries_the_pages_facts_and_its_silence_on_gender():
    out, problems, _ = recs([row("a", "Zolo Test - PG | Ladies & Gents PG", web=PAGE)], [detail()])
    assert problems == []
    r = out[0]
    assert r["id"] == "pg-zolo-test" and r["status"] == "confirmed" and r["rent"][0]["from_inr"] == 8428
    assert r["gender"] is None  # the page was read and says nothing; the listing name is not used


def test_facts_need_sources_whole_rupees_and_a_readable_operator():
    stanza = "https://www.stanzaliving.com/hyderabad/pg-in-x/female/kent-house"
    bad = detail(rent=[{"sharing": "double", "label": "Two Sharing", "from_inr": 84.5, "period": "week", "starting": True, "source": PAGE}],
                 services={"ac": {"value": "yes", "source": PAGE}}, deposit={"value": "1 month", "source": stanza})
    _, problems, _ = recs([row("a", "Zolo Test", web=PAGE)], [bad])
    text = " ".join(problems)
    assert "whole rupees" in text and "period" in text and "service ac" in text and "Stanza Living pages may not be read" in text


def test_a_page_that_is_gone_drops_the_link_and_cannot_be_probable():
    gone = {"id": "pg-zolo-test", "name": "Zolo Test", "operator": "zolo", "overture": ["a"], "status": "unverified",
            "gone": "2026-11-20", "checked": "2026-11-20", "note": "page now says Page Not Found"}
    out, problems, _ = recs([row("a", "Zolo Test", web=PAGE)], [gone])
    assert problems == [] and out[0]["page"] is None and out[0]["page_gone"] == "2026-11-20" and out[0]["status"] == "unverified"
    _, problems, _ = recs([row("a", "Zolo Test", web=PAGE)], [gone | {"status": "probable"}])
    assert any("gone" in p for p in problems)


def test_rejected_listings_and_unknown_overture_ids():
    out, problems, _ = recs([row("a", "Some PG")], [detail(overture=["zz"])], rejected=[{"overture": "a", "reason": "a shop"}])
    assert out == []
    assert any("zz is not in the download" in p for p in problems)


def test_the_build_writes_pg_files_and_leaves_the_societies_alone(tmp_path):
    seed_s, out_s, seed_p = tmp_path / "s.json", tmp_path / "residential.json", tmp_path / "pgs.json"
    near = {"id": "gachibowli", "name": "Gachibowli", "lat": 17.4436, "lon": 78.3520, "osm_id": "n1"}
    seed_s.write_text(json.dumps({"neighbourhoods": [near], "benchmarks": [], "societies": []}), encoding="utf-8")
    seed_p.write_text(json.dumps({"operators": OPS, "details": [], "rejected": []}), encoding="utf-8")
    utm = Transformer.from_crs("EPSG:4326", "EPSG:32644", always_xy=True).transform  # what the build uses
    cafe = {"id": "c1", "name": "Cafe", "cat": "cafe", "source": "osm", "lat": 17.44, "lon": 78.3601,
            "geom": Point(*utm(78.3601, 17.44))}
    no_route = lambda areas: {"societies": {}, "file": None}  # noqa: E731
    suburb = {"id": "kphb-colony", "name": "KPHB Colony", "lat": 17.4405, "lon": 78.3601, "osm_id": "n2", "place": "suburb"}
    report = residential.build(seed_s, out_s, locate=lambda ids: {}, inside=lambda b: {}, places=[cafe], route=no_route,
                               pgs_seed=seed_p, pg_rows=[row("a", "Sri Sai Boys Hostel"), row("b", "Lake PG", lon=78.385)],
                               pg_grounds=[], pg_areas_osm=[suburb, {**suburb, "id": "far", "lat": 17.60}])
    assert report["problems"] == [] and report["pgs"]["pgs"] == 2
    data = json.loads((tmp_path / pgs.OUT_NAME).read_text(encoding="utf-8"))
    pg, lake = sorted(data["pgs"], key=lambda r: r["lon"])  # the lake PG is 3.5 km from Gachibowli, 2.6 km from the suburb
    assert pg["nearby"]["cafe"]["count"] == 1 and pg["metro"] is None
    # the societies' neighbourhood wins where there is one, though the suburb point is nearer
    assert pg["neighbourhood"] == "gachibowli" and lake["neighbourhood"] == "kphb-colony"
    assert data["neighbourhoods"] == [suburb]  # only the extra ones the PGs use
    assert json.loads(out_s.read_text(encoding="utf-8"))["societies"] == []


def test_suburb_and_town_points_name_the_areas_beyond_the_societies(tmp_path):
    f = tmp_path / "places_osm.json"
    node = lambda i, place, name: {"type": "node", "id": i, "lat": 17.5, "lon": 78.3, "tags": {"place": place, "name": name}}  # noqa: E731
    f.write_text(json.dumps({"elements": [node(1, "suburb", "KPHB Colony"), node(2, "neighbourhood", "Phase 5"),
                                          node(3, "suburb", "Gachibowli"), node(4, "town", "KPHB Colony")]}), encoding="utf-8")
    got = pgs.osm_areas({"gachibowli"}, f)
    assert [(h["id"], h["osm_id"]) for h in got] == [("kphb-colony", "n1"), ("kphb-colony-n4", "n4")]
    assert pgs.osm_areas(set(), tmp_path / "missing.json") == []
