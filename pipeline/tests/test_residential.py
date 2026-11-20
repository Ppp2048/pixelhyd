"""Residential societies: facts need sources, buildings come only from a named boundary, nothing is estimated."""

import json

from shapely.geometry import box, mapping

from hitec_pipeline import residential

SRC = "https://developer.example/project"
HOODS = [{"id": "gachibowli", "name": "Gachibowli", "lat": 17.44, "lon": 78.35, "osm_id": "n1"}]


def society(sid, **kw):
    return {"id": sid, "name": sid.title(), "research": "mapped",
            "site": {"osm_id": "w1", "expect_name": "Green Acres"}} | kw


def run(tmp_path, societies, areas, footprints, benchmarks=(), places=()):
    seed, out = tmp_path / "seed.json", tmp_path / "out.json"
    seed.write_text(json.dumps({"neighbourhoods": HOODS, "benchmarks": list(benchmarks), "societies": societies}), encoding="utf-8")
    locate = lambda ids: {k: v for k, v in areas.items() if k in ids}  # noqa: E731
    inside = lambda b: {sid: footprints.get(sid, []) for sid in b}  # noqa: E731
    no_route = lambda areas: {"societies": {}, "file": None}  # noqa: E731
    report = residential.build(seed, out, locate=locate, inside=inside, places=list(places), route=no_route)
    return report, json.loads(out.read_text(encoding="utf-8"))


def area(osm_id, name):
    return {"layer": "areas", "osm_id": osm_id, "name": name, "lat": 17.44, "lon": 78.35, "geom": mapping(box(0, 0, 100, 100))}


def test_a_named_boundary_brings_its_buildings(tmp_path):
    report, out = run(tmp_path, [society("green")], {"w1": area("w1", "Green Acres Phase 1")},
                      {"green": [{"id": "b1"}, {"id": "b2"}]})
    assert report["problems"] == []
    s = out["societies"][0]
    assert s["match"] == "site" and s["buildings"] == ["b1", "b2"] and s["site"]["name"] == "Green Acres Phase 1"


def test_the_marker_sits_at_the_middle_of_the_buildings_weighted_by_footprint_area(tmp_path):
    from pyproj import Transformer

    from hitec_pipeline import amenities

    blds = [{"id": "b1", "x": 300000.0, "y": 1930000.0, "area": 100.0}, {"id": "b2", "x": 300400.0, "y": 1930000.0, "area": 300.0}]
    report, out = run(tmp_path, [society("green")], {"w1": area("w1", "Green Acres")}, {"green": blds})
    lon, lat = Transformer.from_crs(amenities.UTM, "EPSG:4326", always_xy=True).transform(300300.0, 1930000.0)
    assert report["problems"] == [] and out["societies"][0]["centre"] == {"lat": round(lat, 6), "lon": round(lon, 6)}
    # Without footprint geometry there is no centre; the app falls back to the society's point.
    _, out = run(tmp_path, [society("green")], {"w1": area("w1", "Green Acres")}, {"green": [{"id": "b1"}]})
    assert out["societies"][0]["centre"] is None


def test_a_boundary_with_another_name_is_refused(tmp_path):
    report, out = run(tmp_path, [society("green")], {"w1": area("w1", "Blue Towers")}, {"green": [{"id": "b1"}]})
    assert out["societies"] == [] and "expected 'Green Acres'" in report["problems"][0]


def test_without_a_boundary_a_society_is_an_approximate_point_with_no_buildings(tmp_path):
    rec = society("green", site=None, location={"lat": 17.45, "lon": 78.36, "source": SRC})
    report, out = run(tmp_path, [rec], {}, {})
    assert report["problems"] == []
    assert out["societies"][0]["match"] == "approximate" and out["societies"][0]["buildings"] == []


def test_every_fact_needs_a_source_and_nothing_unsourced_is_published(tmp_path):
    bad = society("green", research="researched", facts={"towers": {"value": 10}})
    report, out = run(tmp_path, [bad], {"w1": area("w1", "Green Acres")}, {"green": [{"id": "b1"}]})
    assert out["societies"] == [] and any("towers needs a value and an https source" in p for p in report["problems"])


def test_configurations_keep_the_area_type_the_source_uses(tmp_path):
    good = {"bhk": 3, "area_sqft": [1650, 1820], "area_type": "super_built_up", "source": SRC}
    unlabelled = {"bhk": 2, "area_sqft": [1200, 1300], "source": SRC}
    rec = society("green", research="researched", configurations=[good])
    report, out = run(tmp_path, [rec], {"w1": area("w1", "Green Acres")}, {"green": [{"id": "b1"}]})
    assert report["problems"] == [] and out["societies"][0]["configurations"] == [good]
    rec = society("green", research="researched", configurations=[unlabelled])
    report, _ = run(tmp_path, [rec], {"w1": area("w1", "Green Acres")}, {"green": [{"id": "b1"}]})
    assert any("area_type" in p for p in report["problems"])


def test_research_level_matches_what_the_record_carries(tmp_path):
    mapped_with_facts = society("green", facts={"towers": {"value": 4, "source": SRC}})
    researched_empty = society("blue", research="researched")
    report, out = run(tmp_path, [mapped_with_facts, researched_empty], {"w1": area("w1", "Green Acres")}, {})
    assert out["societies"] == []
    assert any("mark it researched" in p for p in report["problems"])
    assert any("at least one sourced fact" in p for p in report["problems"])


def test_benchmarks_need_their_publisher_period_and_source(tmp_path):
    bench = {"id": "x", "area": "Gachibowli", "bhk": 2, "size_sqft": 1000, "rent_month": 30000, "period": "Q1", "publisher": "", "source": SRC}
    report, _ = run(tmp_path, [], {}, {}, benchmarks=[bench])
    assert report["problems"] == ["benchmark x: needs publisher"]


def test_a_society_belongs_to_the_nearest_neighbourhood_centre_within_reach():
    hoods = HOODS + [{"id": "kondapur", "name": "Kondapur", "lat": 17.46, "lon": 78.37, "osm_id": "n2"}]
    assert residential.nearest(17.441, 78.351, hoods)[0] == "gachibowli"
    assert residential.nearest(17.459, 78.369, hoods)[0] == "kondapur"
    assert residential.nearest(17.60, 78.60, hoods) == (None, None)
