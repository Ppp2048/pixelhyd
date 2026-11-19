"""Scattered trees stand only where green land is the visible ground."""

import geopandas as gpd
from shapely.geometry import Point, box

from hitec_pipeline.scene import Scene, Tree, _area_stack, _trees
from hitec_pipeline.tiles import global_projection


import pytest


@pytest.mark.parametrize("green", ["landuse:forest", "natural:wood"])  # wood has no ground colour
def test_no_trees_on_a_pond_inside_a_forest(green):
    proj = global_projection()
    e0, n0 = proj.e0 + 500, proj.n0 + 500
    core = box(e0, n0, e0 + 200, n0 + 200)
    pond = box(e0 + 50, n0 + 50, e0 + 150, n0 + 150)
    areas = gpd.GeoDataFrame({"kind": [green, "natural:water"]}, geometry=[core, pond])
    scene = Scene(proj, core)
    _trees(_area_stack(areas, core), None, core, proj, scene)
    trees = [o.item for o in scene.objects if isinstance(o.item, Tree)]
    assert len(trees) > 100  # the forest around the pond is still wooded
    assert not any(pond.contains(Point(t.e, t.n)) for t in trees)
