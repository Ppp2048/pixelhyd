"""Area definitions.

Every area is a square defined in metres in UTM zone 44N (EPSG:32644), so a
"250 m" square is exactly 250 m on the ground. Data is fetched for a larger,
buffered square so that buildings, shadows and roads crossing the edge are
complete; rendering is clipped to the core square.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import cached_property

from pyproj import Transformer

WGS84 = "EPSG:4326"
UTM44N = "EPSG:32644"

_to_utm = Transformer.from_crs(WGS84, UTM44N, always_xy=True)
_to_wgs = Transformer.from_crs(UTM44N, WGS84, always_xy=True)


def to_utm(lon: float, lat: float) -> tuple[float, float]:
    return _to_utm.transform(lon, lat)


def to_wgs(e: float, n: float) -> tuple[float, float]:
    return _to_wgs.transform(e, n)


@dataclass(frozen=True)
class Area:
    """A square area centred on a WGS84 point."""

    name: str
    centre_lat: float
    centre_lon: float
    size_m: float
    buffer_m: float

    @cached_property
    def centre_utm(self) -> tuple[float, float]:
        return to_utm(self.centre_lon, self.centre_lat)

    def square(self, extra: float = 0.0) -> tuple[float, float, float, float]:
        """(min_e, min_n, max_e, max_n) of the core square grown by `extra` metres."""
        e, n = self.centre_utm
        h = self.size_m / 2 + extra
        return (e - h, n - h, e + h, n + h)

    @property
    def core(self) -> tuple[float, float, float, float]:
        return self.square()

    @property
    def fetch(self) -> tuple[float, float, float, float]:
        return self.square(self.buffer_m)

    def wgs_bbox(self, extra: float | None = None) -> tuple[float, float, float, float]:
        """(west, south, east, north) enclosing the buffered square (all four corners)."""
        min_e, min_n, max_e, max_n = self.square(self.buffer_m if extra is None else extra)
        corners = [to_wgs(e, n) for e in (min_e, max_e) for n in (min_n, max_n)]
        lons = [c[0] for c in corners]
        lats = [c[1] for c in corners]
        return (min(lons), min(lats), max(lons), max(lats))


# The approved coverage (decision D1): 5 km square centred on the Cyber Towers junction.
HITEC_CITY = Area("hitec-city", 17.4507, 78.3801, 5000.0, 150.0)

# Prototype: 250 m square between Cyber Towers and the HITEC City metro station.
PROTOTYPE = Area("prototype", 17.4499, 78.3822, 250.0, 150.0)

AREAS = {a.name: a for a in (HITEC_CITY, PROTOTYPE)}
