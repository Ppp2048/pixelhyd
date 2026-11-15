"""Exact projections used by the art and the web app.

1. Ground (UTM 44N metres, plus height z) → isometric art pixels, a
   2:1 dimetric projection:
       x = k·(e − n) + ox
       y = −(k/2)·(e + n) − v·z + oy,   v = k·√6/2
   where e, n are metres relative to the area's south-west corner.
   One metre east moves (+k, −k/2) px; one metre north (−k, −k/2) px.

2. Art pixels ↔ "image-space" lon/lat for MapLibre. MapLibre only renders
   Web Mercator, so the art is placed with its top-left corner at lon 0,
   lat 0 of a Mercator world whose size at zoom `zmax` equals 256·2^zmax
   art pixels. The mapping uses the exact Mercator formulas, so overlays
   align with tiles to floating-point precision.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass

import numpy as np

V_FACTOR = math.sqrt(6) / 2  # vertical px per metre of height, per unit k (exact 2:1 dimetric)
TILE = 256


@dataclass(frozen=True)
class IsoProjection:
    k: float  # art px per metre along the screen x axis
    e0: float  # UTM easting of the area's south-west corner
    n0: float  # UTM northing of the area's south-west corner
    size_m: float
    ox: float
    oy: float
    width: int
    height: int
    zmax: int

    @property
    def v(self) -> float:
        return self.k * V_FACTOR

    @classmethod
    def for_square(cls, square: tuple[float, float, float, float], k: float, max_height_m: float, pad: int = 8, zmax: int = 20) -> "IsoProjection":
        e0, n0, e1, n1 = square
        size = e1 - e0
        top = k * size + k * V_FACTOR * max_height_m  # room above the far corner for tall buildings
        ox = k * size + pad
        oy = top + pad
        width = math.ceil(2 * k * size + 2 * pad)
        height = math.ceil(oy + pad + k * 2)  # a little room below the near corner
        return cls(k, e0, n0, size, ox, oy, width, height, zmax)

    # --- ground → art px
    def to_px(self, e, n, z=0.0):
        de = np.asarray(e, dtype=float) - self.e0
        dn = np.asarray(n, dtype=float) - self.n0
        x = self.k * (de - dn) + self.ox
        y = -(self.k / 2) * (de + dn) - self.v * np.asarray(z, dtype=float) + self.oy
        return x, y

    def ground_from_px(self, x, y):
        """Inverse at z = 0."""
        a = (np.asarray(x, dtype=float) - self.ox) / self.k  # de − dn
        b = -2 * (np.asarray(y, dtype=float) - self.oy) / self.k  # de + dn
        return (a + b) / 2 + self.e0, (b - a) / 2 + self.n0

    # --- art px ↔ image-space lon/lat (Web Mercator)
    @property
    def world(self) -> float:
        return TILE * 2**self.zmax

    @property
    def origin_world(self) -> float:
        return self.world / 2  # art (0, 0) sits at lon 0, lat 0

    def px_to_lonlat(self, x, y):
        wx = self.origin_world + np.asarray(x, dtype=float)
        wy = self.origin_world + np.asarray(y, dtype=float)
        lon = wx / self.world * 360.0 - 180.0
        lat = np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * wy / self.world))))
        return lon, lat

    def lonlat_to_px(self, lon, lat):
        wx = (np.asarray(lon, dtype=float) + 180.0) / 360.0 * self.world
        s = np.sin(np.radians(np.asarray(lat, dtype=float)))
        wy = (0.5 - np.log((1 + s) / (1 - s)) / (4 * np.pi)) * self.world
        return wx - self.origin_world, wy - self.origin_world

    def to_dict(self) -> dict:
        d = asdict(self)
        d.update(v=self.v, tile=TILE, origin_world=self.origin_world, utm_epsg=32644)
        return d
