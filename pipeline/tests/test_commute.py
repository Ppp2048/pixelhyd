"""Commute estimates: our own road graph, one-way streets, private roads, gates and the workplace grid."""

import base64
import json
import math

from shapely.geometry import box

from hitec_pipeline import commute

IDENTITY = lambda xs, ys: (list(xs), list(ys))  # noqa: E731  (coordinates are already metres)


def way(wid, pts, **tags):
    """An Overpass-style way; pts are (node id, x, y) with x/y in metres."""
    return {"type": "way", "id": wid, "nodes": [p[0] for p in pts],
            "geometry": [{"lon": p[1], "lat": p[2]} for p in pts], "tags": tags}


SQUARE = [
    way(1, [(1, 0, 0), (2, 1000, 0)], highway="primary", oneway="yes"),
    way(2, [(2, 1000, 0), (3, 1000, 1000), (4, 0, 1000), (1, 0, 0)], highway="residential"),
]


def test_only_public_roads_a_car_may_use_are_routed():
    assert commute.drivable({"highway": "residential"}) == 18
    assert commute.drivable({"highway": "residential", "access": "private"}) is None
    assert commute.drivable({"highway": "service", "access": "private", "motor_vehicle": "yes"}) == 12
    assert commute.drivable({"highway": "track"}) is None
    assert commute.drivable({"highway": "service", "service": "parking_aisle"}) is None


def test_one_way_rules():
    assert commute.direction({"highway": "primary", "oneway": "yes"}) == 1
    assert commute.direction({"highway": "primary", "oneway": "-1"}) == -1
    assert commute.direction({"highway": "tertiary", "junction": "roundabout"}) == 1
    assert commute.direction({"highway": "motorway"}) == 1
    assert commute.direction({"highway": "motorway", "oneway": "no"}) == 0


def test_a_one_way_street_forces_the_long_way_round():
    g = commute.build_graph(SQUARE, IDENTITY)
    a, b = g.index[1], g.index[2]
    t, d = commute.dijkstra(g, [a])
    assert math.isclose(t[b], 1000 / (35 / 3.6)) and math.isclose(d[b], 1000)
    t, d = commute.dijkstra(g, [b])
    assert math.isclose(t[a], 3000 / (18 / 3.6)) and math.isclose(d[a], 3000)


def test_trips_start_from_public_roads_by_the_boundary_but_not_from_a_motorway():
    roads = SQUARE + [way(3, [(5, 0, -40), (6, 1000, -40)], highway="motorway")]
    g = commute.build_graph(roads, IDENTITY)
    idx = commute.NodeIndex(g)
    society = box(-20, -30, 30, 20)  # by node 1; node 5 on the motorway is just as close
    found = commute.gates(g, idx, society)
    assert g.index[1] in found and g.index[5] not in found
    assert all(g.y[n] != -40 for n in found)  # nothing on the motorway


def test_the_grid_gives_each_cell_the_time_to_its_nearest_reachable_road_point():
    g = commute.build_graph(SQUARE, IDENTITY)
    idx = commute.NodeIndex(g)
    t, d = commute.dijkstra(g, [g.index[1]])
    near_b = [[(100.0, g.index[2])]]
    nowhere = [[]]
    mins, hm = commute.cell_times(t, d, near_b + nowhere)
    expected = math.ceil((1000 / (35 / 3.6) + 100 / (10 / 3.6)) / 60)
    assert list(mins) == [expected, commute.NONE_MIN]
    assert int.from_bytes(hm[:2], "little") == 11 and int.from_bytes(hm[2:], "little") == commute.NONE_HM
    snapped = commute.snap_cells(g, idx, {"rows": 1, "cols": 1, "origin_e": 750, "origin_n": -125, "cell_m": 250})[0][0][1]
    assert g.y[snapped] == 0 and abs(g.x[snapped] - 875) <= commute.MAX_SEG_M / 2


def test_metro_stations_come_once_each_from_openstreetmap(tmp_path):
    els = [
        {"type": "node", "id": 1, "lat": 17.44, "lon": 78.38, "tags": {"railway": "station", "station": "subway", "network": "Hyderabad Metro", "name": "Raidurg"}},
        {"type": "way", "id": 2, "center": {"lat": 17.4401, "lon": 78.3801}, "tags": {"railway": "station", "station": "subway", "name": "Raidurg Metro Station"}},
        {"type": "node", "id": 3, "lat": 17.47, "lon": 78.38, "tags": {"railway": "station", "network": "IR", "name": "HITEC City"}},
    ]
    p = tmp_path / "places.json"
    p.write_text(json.dumps({"elements": els}), encoding="utf-8")
    assert commute.metro_stations(p) == [{"id": "n1", "name": "Raidurg", "lat": 17.44, "lon": 78.38}]


def test_compute_packs_minutes_per_cell_and_names_the_nearest_station():
    stations = [{"id": "n9", "name": "Far End", "lat": 1000.0, "lon": 1000.0}]
    out = commute.compute({"s": box(-20, -20, 20, 20)}, SQUARE, IDENTITY, stations, (0, 0, 1000, 1000))
    grid, packed = out["file"]["grid"], out["file"]["societies"]["s"]
    mins = base64.b64decode(packed["minutes"])
    assert len(mins) == grid["rows"] * grid["cols"] and packed["gates"] >= 1 and commute.NONE_MIN not in mins
    metro = out["societies"]["s"]["metro"]
    assert metro["name"] == "Far End" and metro["m"] == round(math.hypot(980, 980), -1) and metro["drive_min"] is not None


def test_a_road_passing_the_boundary_is_found_even_when_its_nodes_are_far_away():
    long_road = [way(1, [(1, -1000, 0), (2, 1000, 0)], highway="tertiary")]
    g = commute.build_graph(long_road, IDENTITY)
    idx = commute.NodeIndex(g)
    society = box(-50, 20, 50, 120)  # 20 m from the road, 1 km from either OSM node
    assert len(commute.gates(g, idx, society)) >= 3


def test_stray_islands_of_road_are_left_out_of_the_network():
    island = [way(9, [(90, 5000, 5000), (91, 5100, 5000)], highway="residential")]
    g = commute.build_graph(SQUARE + island, IDENTITY)
    main = commute.main_network(g)
    assert main[g.index[1]] and main[g.index[3]] and not main[g.index[90]]
