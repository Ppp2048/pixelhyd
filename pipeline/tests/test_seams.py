"""Chunked rendering must be pixel-identical to a single whole-canvas render."""

import numpy as np
import pytest

from hitec_pipeline import DATA_ROOT
from hitec_pipeline.area import PROTOTYPE
from hitec_pipeline.render import render_canvas, render_region
from hitec_pipeline.scene import build_scene

FEATURES = DATA_ROOT / "work" / PROTOTYPE.name / "features.gpkg"


@pytest.mark.skipif(not FEATURES.exists(), reason="run `hitec-pipeline fetch normalise` first")
@pytest.mark.parametrize("chunk", [256, 333, 700])
def test_chunked_render_has_no_seams(chunk):
    scene = build_scene(PROTOTYPE, FEATURES, k=4.0)
    whole = np.asarray(render_canvas(scene, chunk=0))
    pieces = np.asarray(render_canvas(scene, chunk=chunk))
    diff = np.argwhere(np.any(whole != pieces, axis=2))
    assert len(diff) == 0, f"{len(diff)} differing pixels, first at {diff[:5].tolist()}"


def test_lines_crossing_region_edges_are_identical():
    """Regression: long 1 px lines crossing a region border must not shift (Pillow clips and re-steps)."""
    from hitec_pipeline.render import Painter

    scene = build_scene(PROTOTYPE, FEATURES, k=4.0) if FEATURES.exists() else None
    if scene is None:
        pytest.skip("no prototype data")
    lines = [[(3, 5), (997, 611)], [(10, 900), (980, 7)], [(500, 2), (503, 990)], [(-300, 40), (1300, 777)]]
    def draw(x0, y0, w, h):
        p = Painter(scene, x0, y0, w, h)
        for ln in lines:
            p.line(np.array(ln), (255, 0, 0, 255))
        return np.asarray(p.img)
    whole = draw(0, 0, 1000, 1000)
    for x0, y0 in ((0, 0), (333, 0), (0, 333), (333, 333), (666, 666)):
        part = draw(x0, y0, 334, 334)
        assert np.array_equal(part, whole[y0:y0 + 334, x0:x0 + 334])


TILE_FEATURES = DATA_ROOT / "work" / "hitec-city" / "r2c3" / "features.gpkg"


@pytest.mark.skipif(not TILE_FEATURES.exists(), reason="tile r2c3 not fetched")
def test_dense_tile_chunk_whole_vs_quarters():
    """Regression: chunk (21, 7) of tile r2c3 once differed by 1 px between a whole and a quartered render."""
    from shapely.geometry import box
    from shapely.ops import unary_union

    from hitec_pipeline import tiles as T
    from hitec_pipeline.scene import build_scene_from_layers

    drawn = {"r2c2", "r2c3"}
    layers = T.merged_layers([t for t in T.neighbours("r2c3") if T._features(t).exists()])
    def owns(row):
        p = row.geometry.representative_point()
        return T.owner_of(p.x, p.y) in drawn
    proj = T.global_projection()
    scene = build_scene_from_layers(layers, proj, unary_union([box(*T.tile_bounds(t)) for t in drawn]), owns=owns, shadow_all=False)
    x0, y0, s = 21 * 1024, 7 * 1024, 1024
    whole = np.asarray(render_region(scene, x0, y0, s, s))
    for qx in (0, 512):
        for qy in (0, 512):
            part = np.asarray(render_region(scene, x0 + qx, y0 + qy, 512, 512))
            assert np.array_equal(part, whole[qy:qy + 512, qx:qx + 512])
