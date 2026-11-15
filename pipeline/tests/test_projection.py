import numpy as np
import pytest

from hitec_pipeline.area import PROTOTYPE, to_utm, to_wgs
from hitec_pipeline.iso import V_FACTOR, IsoProjection


@pytest.fixture
def proj():
    return IsoProjection.for_square(PROTOTYPE.core, k=4.0, max_height_m=60)


def test_utm_round_trip_under_1cm():
    lon, lat = 78.3822, 17.4499
    e, n = to_utm(lon, lat)
    lon2, lat2 = to_wgs(e, n)
    e2, n2 = to_utm(lon2, lat2)
    assert abs(e - e2) < 0.01 and abs(n - n2) < 0.01


def test_dimetric_axes(proj):
    x0, y0 = proj.to_px(proj.e0, proj.n0)
    xe, ye = proj.to_px(proj.e0 + 1, proj.n0)
    xn, yn = proj.to_px(proj.e0, proj.n0 + 1)
    xz, yz = proj.to_px(proj.e0, proj.n0, 1)
    assert (xe - x0, ye - y0) == pytest.approx((4.0, -2.0))  # east: right and up, 2:1
    assert (xn - x0, yn - y0) == pytest.approx((-4.0, -2.0))  # north: left and up, 2:1
    assert (xz - x0, yz - y0) == pytest.approx((0.0, -4.0 * V_FACTOR))


def test_ground_inverse(proj):
    e = proj.e0 + np.array([0, 13.2, 250])
    n = proj.n0 + np.array([0, 101.7, 250])
    x, y = proj.to_px(e, n)
    e2, n2 = proj.ground_from_px(x, y)
    assert np.allclose(e, e2, atol=1e-6) and np.allclose(n, n2, atol=1e-6)


def test_image_space_lonlat_round_trip(proj):
    x = np.array([0, 517.25, proj.width])
    y = np.array([0, 999.5, proj.height])
    lon, lat = proj.px_to_lonlat(x, y)
    x2, y2 = proj.lonlat_to_px(lon, lat)
    assert np.allclose(x, x2, atol=1e-4) and np.allclose(y, y2, atol=1e-4)


def test_canvas_contains_core(proj):
    e0, n0, e1, n1 = PROTOTYPE.core
    xs, ys = proj.to_px([e0, e1, e1, e0], [n0, n0, n1, n1])
    assert xs.min() >= 0 and xs.max() <= proj.width
    assert ys.min() >= 0 and ys.max() <= proj.height
