"""Chunked rendering must be pixel-identical to a single whole-canvas render."""

import numpy as np
import pytest

from hitec_pipeline import DATA_ROOT
from hitec_pipeline.area import PROTOTYPE
from hitec_pipeline.render import render_canvas
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
