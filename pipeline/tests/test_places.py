"""The search index: what counts as a place, and how duplicates and street pieces merge."""

from hitec_pipeline.places import classify, dedupe, merge_streets


def test_classify():
    assert classify({"place": "suburb"}) == ("locality", "Suburb")
    assert classify({"railway": "station", "station": "subway"}) == ("transit", "Metro station")
    assert classify({"public_transport": "station", "bus": "yes"}) == ("transit", "Bus station")
    assert classify({"tourism": "attraction", "leisure": "nature_reserve"}) == ("landmark", "Attraction")
    assert classify({"office": "company"}) == ("office", "Office")
    assert classify({"highway": "primary"}) == ("street", "Street")
    assert classify({"highway": "footway"}) is None
    assert classify({"building": "yes"}) == ("building", "Building")
    assert classify({"shop": "bakery"}) is None


def row(name, cat, lat, lon, building=False, bbox=None):
    return {"name": name, "cat": cat, "kind": "", "lat": lat, "lon": lon, "bbox": bbox, "osm_id": name, "building": building}


def test_dedupe_keeps_the_outline_over_the_point():
    rows = dedupe([row("City Hospital", "health", 17.4, 78.4), row("City Hospital", "health", 17.4005, 78.4, building=True),
                   row("City Hospital", "health", 17.5, 78.4)])
    assert len(rows) == 2 and any(r["building"] for r in rows)


def test_street_pieces_join_only_when_close():
    near = [row("MG Road", "street", 17.40, 78.40, bbox=[78.40, 17.40, 78.401, 17.401]),
            row("MG Road", "street", 17.402, 78.402, bbox=[78.402, 17.402, 78.403, 17.403])]
    far = [row("MG Road", "street", 17.50, 78.50, bbox=[78.50, 17.50, 78.501, 17.501])]
    out = merge_streets(near + far)
    assert len(out) == 2
    assert max(r["bbox"][2] for r in out if r["lat"] < 17.45) == 78.403
