"""Airports: runways, taxiways and aprons come from OSM aeroway tags and are drawn as paving.

Regression for the airport (Rajiv Gandhi International, Shamshabad) showing its runways as bare ground
between grass strips, because aeroways were never downloaded or drawn.
"""

import json

import geopandas as gpd
import numpy as np
from shapely.geometry import LineString, Point, box

from hitec_pipeline import style as S
from hitec_pipeline.normalise import _osm_frames, aeroway_width
from hitec_pipeline.render import render_region
from hitec_pipeline.scene import Tree, build_scene_from_layers
from hitec_pipeline.tiles import global_projection

# A small synthetic airfield near the airport (positions only matter relative to each other).
LON, LAT = 78.43, 17.24
D = 0.004  # ≈ 420 m


def _way(i, tags, pts):
    return {"type": "way", "id": i, "tags": tags, "geometry": [{"lon": x, "lat": y} for x, y in pts],
            "bounds": {"minlon": min(p[0] for p in pts), "maxlon": max(p[0] for p in pts),
                       "minlat": min(p[1] for p in pts), "maxlat": max(p[1] for p in pts)}}


RUNWAY = _way(1, {"aeroway": "runway", "ref": "09/27"}, [(LON - D, LAT), (LON + D, LAT)])
TAXI_LOOP = _way(2, {"aeroway": "taxiway", "width": "30"},
                 [(LON - D / 2, LAT + D / 4), (LON + D / 2, LAT + D / 4), (LON + D / 2, LAT + D / 2), (LON - D / 2, LAT + D / 4)])
APRON = _way(3, {"aeroway": "apron"}, [(LON, LAT + D / 2), (LON + D / 2, LAT + D / 2), (LON + D / 2, LAT + D), (LON, LAT + D), (LON, LAT + D / 2)])
GRASS = _way(4, {"landuse": "grass"}, [(LON - D, LAT - D / 4), (LON + D, LAT - D / 4), (LON + D, LAT + D / 4), (LON - D, LAT + D / 4), (LON - D, LAT - D / 4)])
TERMINAL_AREA = _way(5, {"aeroway": "aerodrome"}, [(LON - D, LAT - D), (LON + D, LAT - D), (LON + D, LAT + D), (LON - D, LAT - D)])


def _write(tmp_path, name, elements):
    path = tmp_path / name
    path.write_text(json.dumps({"elements": elements}), encoding="utf-8")
    return path


def test_width_is_osm_or_an_estimated_icao_minimum():
    assert aeroway_width({"aeroway": "runway", "width": "60"}) == (60.0, "osm_width")
    assert aeroway_width({"aeroway": "runway"}) == (45.0, "estimated_icao_minimum")
    assert aeroway_width({"aeroway": "taxiway", "width": "nonsense"}) == (23.0, "estimated_icao_minimum")


def test_aeroways_are_parsed_and_the_supplement_merges_without_duplicates(tmp_path):
    main = _write(tmp_path, "osm.json", [GRASS, RUNWAY])  # a newer download may already hold a runway
    extra = _write(tmp_path, "osm_aeroway.json", [RUNWAY, TAXI_LOOP, APRON, TERMINAL_AREA])
    f = _osm_frames(main, [extra])
    lines = f["aeroway"]
    assert sorted(lines["osm_id"]) == ["w1", "w2"]  # the runway once; the aerodrome boundary is not paving
    taxi = lines[lines["osm_id"] == "w2"].iloc[0]
    assert taxi.geometry.geom_type == "LineString"  # a closed taxiway loop is a line, not a paved polygon
    assert (taxi["width_m"], taxi["width_source"]) == (30.0, "osm_width")
    rw = lines[lines["osm_id"] == "w1"].iloc[0]
    assert rw["width_source"] == "estimated_icao_minimum"
    assert lines.crs.to_epsg() == 32644
    kinds = dict(zip(f["areas"]["osm_id"], f["areas"]["kind"]))
    assert kinds == {"w4": "landuse:grass", "w3": "aeroway:apron"}


def test_without_a_supplement_nothing_changes(tmp_path):
    main = _write(tmp_path, "osm.json", [GRASS])
    f = _osm_frames(main)
    assert f["aeroway"] is None
    assert list(f["areas"]["kind"]) == ["landuse:grass"]


def _airfield(tmp_path):
    main = _write(tmp_path, "osm.json", [GRASS])
    extra = _write(tmp_path, "osm_aeroway.json", [RUNWAY, TAXI_LOOP, APRON])
    f = _osm_frames(main, [extra])
    empty = gpd.GeoDataFrame({"id": [], "height_m": []}, geometry=[], crs=f["areas"].crs)
    layers = {"buildings": empty, "areas": f["areas"], "aeroway": f["aeroway"]}
    core = f["areas"].geometry.union_all().envelope.buffer(50)
    return layers, core, f


def test_runway_is_paved_over_grass_with_centreline_stripes(tmp_path):
    layers, core, f = _airfield(tmp_path)
    scene = build_scene_from_layers(layers, global_projection(), core)
    colours = [c for _, c in scene.ground]
    grass, apron = S.AREA_FILL["landuse:grass"], S.AREA_FILL["aeroway:apron"]
    # Drawn bottom → top: grass, apron, taxiway, runway, its stripes.
    order = [colours.index(c) for c in (grass, apron, S.TAXIWAY, S.RUNWAY, S.RUNWAY_MARK)]
    assert order == sorted(order)
    stripes = next(g for g, c in scene.ground if c == S.RUNWAY_MARK)
    runway = f["aeroway"][f["aeroway"]["osm_id"] == "w1"].geometry.iloc[0]
    n = len(getattr(stripes, "geoms", [stripes]))
    expected = int((runway.length - 2 * S.RUNWAY_GAP_M - S.RUNWAY_DASH_M) // (S.RUNWAY_DASH_M + S.RUNWAY_GAP_M)) + 1
    assert abs(n - expected) <= 1
    assert stripes.buffer(-0.1).within(runway.buffer(S.RUNWAY_MARK_W_M))  # on the centreline


def test_no_generated_trees_on_runways_or_taxiways(tmp_path):
    layers, core, f = _airfield(tmp_path)
    scene = build_scene_from_layers(layers, global_projection(), core)
    trees = [o.item for o in scene.objects if isinstance(o.item, Tree)]
    assert trees  # the grass beside the runway still has its trees
    paved = f["aeroway"].apply(lambda r: r.geometry.buffer(r.width_m / 2), axis=1).union_all()
    assert not any(paved.contains(Point(t.e, t.n)) for t in trees)


def test_airfield_renders_the_same_in_pieces(tmp_path):
    """Seam safety for the new ground layers: a region drawn whole equals it drawn in quarters."""
    layers, core, f = _airfield(tmp_path)
    proj = global_projection()
    scene = build_scene_from_layers(layers, proj, core)
    mid = f["aeroway"][f["aeroway"]["osm_id"] == "w1"].geometry.iloc[0].centroid  # the runway's middle
    e, n = mid.x, mid.y
    x, y = proj.to_px(e, n, 0)
    x0, y0, s = int(x) - 256, int(y) - 256, 512
    whole = np.asarray(render_region(scene, x0, y0, s, s))
    assert (whole[..., :3] == S.RUNWAY).all(axis=-1).any()
    for qx in (0, 256):
        for qy in (0, 256):
            part = np.asarray(render_region(scene, x0 + qx, y0 + qy, 256, 256))
            assert np.array_equal(part, whole[qy:qy + 256, qx:qx + 256])
