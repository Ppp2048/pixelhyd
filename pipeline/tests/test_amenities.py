"""Everyday places near societies: what counts, duplicates counted once, distances from the boundary."""

import json

from shapely.geometry import Point, box

from hitec_pipeline import amenities, residential
from test_residential import area, run, society


def place(pid, cat, x, y, name=None, source="overture"):
    return {"id": pid, "name": name, "cat": cat, "source": source, "lat": 17.44, "lon": 78.35, "x": x, "y": y,
            "geom": Point(x, y)}


def test_osm_tags_decide_the_category_and_private_or_unnamed_gardens_do_not_count():
    assert amenities.osm_category({"amenity": "hospital", "name": "Care"}) == "hospital"
    assert amenities.osm_category({"leisure": "park", "access": "private"}) is None
    assert amenities.osm_category({"leisure": "garden"}) is None
    assert amenities.osm_category({"leisure": "garden", "name": "Rose Garden"}) == "park"
    assert amenities.osm_category({"leisure": "playground"}) is None


def test_an_overture_hospital_counts_only_when_its_name_says_hospital():
    assert amenities.overture_category("hospital", "hospital", "Apollo White Dental") is None
    assert amenities.overture_category("hospital", "hospital", "Premier Hospital") == "hospital"
    assert amenities.overture_category("food_and_beverage_store", "indian_grocery_store", "Ratnadeep") == "grocery"
    assert amenities.overture_category("food_and_beverage_store", "korean_grocery_store", "Health & Glow") is None
    assert amenities.overture_category("real_estate_service", None, "Homes") is None


def test_parks_come_only_from_openstreetmap():
    assert amenities.overture_category("park", "park", "Ektha Highland Park") is None


def test_overture_listings_inside_a_society_are_dropped_but_mapped_osm_shops_stay():
    site = box(0, 0, 100, 100)
    places = [place("home-kitchen", "restaurant", 50, 50, "Kinnus Kitchen"),
              place("ratnadeep", "grocery", 60, 60, "Ratnadeep", "osm"), place("outside", "cafe", 150, 50)]
    kept = amenities.drop_overture_inside({"s": site}, places)
    assert [p["id"] for p in kept] == ["ratnadeep", "outside"]


def test_the_same_place_listed_twice_is_counted_once():
    osm = place("n1", "hospital", 0, 0, "Yashoda Hospitals", "osm")
    listing = place("o1", "hospital", 60, 0, "Expert Liver Specialist | Yashoda Hospital")
    other_cafe = [place("o2", "cafe", 0, 0, "Chai Point"), place("o3", "cafe", 60, 0, "Third Wave Coffee")]
    same_spot = place("o4", "hospital", 10, 0, "Some Other Name")
    other_cat = place("o5", "pharmacy", 5, 0, "Apollo Pharmacy")
    kept = amenities.dedupe([osm, listing, *other_cafe, same_spot, other_cat])
    assert [p["id"] for p in kept] == ["n1", "o2", "o3", "o5"]


def test_nearby_counts_within_the_radius_from_the_boundary_and_skips_the_societys_own_park():
    site = box(0, 0, 100, 100)
    places = [place("p-in", "park", 50, 50), place("p-out", "park", 400, 50), place("c1", "cafe", 150, 50),
              place("c2", "cafe", 1200, 50), place("c3", "cafe", 1050, 50)]
    near = amenities.nearby({"s": site}, places)["s"]
    assert near["park"] == {"count": 1, "ids": ["p-out"], "nearest": {"id": "p-out", "name": None, "m": 300, "source": "overture"}}
    assert near["cafe"]["count"] == 2 and near["cafe"]["nearest"]["m"] == 50
    assert near["cafe"]["ids"] == ["c1", "c3"]  # nearest first; c2 is past the radius
    assert near["gym"] == {"count": 0, "ids": [], "nearest": None}


def test_the_build_attaches_nearby_places_and_publishes_only_places_near_a_society(tmp_path):
    places = [place("c1", "cafe", 150, 50, "Chai Point"), place("far", "cafe", 9000, 9000, "Far Away")]
    report, out = run(tmp_path, [society("green")], {"w1": area("w1", "Green Acres")}, {"green": [{"id": "b1"}]},
                      places=places)
    assert report["problems"] == [] and report["places_nearby"] == 1
    assert out["societies"][0]["nearby"]["cafe"]["nearest"]["name"] == "Chai Point"
    published = json.loads((tmp_path / residential.PLACES_OUT_NAME).read_text(encoding="utf-8"))
    assert [row[0] for row in published["places"]] == ["c1"] and published["fields"][0] == "id"
