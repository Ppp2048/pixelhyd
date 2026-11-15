"""Visual rules: palette, light and per-class styling.

All colours are ours. Ramps are derived from a base colour with fixed
multipliers, so every face of every building uses the same tonal steps.
"""

from __future__ import annotations

import math

RGB = tuple[int, int, int]


def hex_rgb(h: str) -> RGB:
    h = h.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def scale(c: RGB, f: float) -> RGB:
    return tuple(max(0, min(255, round(v * f))) for v in c)  # type: ignore[return-value]


def mix(a: RGB, b: RGB, t: float) -> RGB:
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))  # type: ignore[return-value]


# ---------------------------------------------------------------- light
# Low winter sun from the south-south-east (azimuth 160°, elevation 42°):
# south faces (screen right) are lit, west faces (screen left) are in shade,
# and shadows fall towards screen left. Chosen for legibility and to differ
# from common isometric conventions.
SUN_AZIMUTH_DEG = 160.0
SUN_ELEVATION_DEG = 42.0
_az = math.radians(SUN_AZIMUTH_DEG)
SUN_DIR = (math.sin(_az), math.cos(_az))  # horizontal unit vector (east, north) towards the sun
SHADOW_PER_M = 1.0 / math.tan(math.radians(SUN_ELEVATION_DEG))  # shadow length per metre of height
SHADOW_VEC = (-SUN_DIR[0] * SHADOW_PER_M, -SUN_DIR[1] * SHADOW_PER_M)
SHADOW_TINT = (0.66, 0.69, 0.80)  # multiply; slightly blue

# ---------------------------------------------------------------- ground
GROUND = hex_rgb("#d8c9a8")  # dusty Deccan ground inside the area
AREA_FILL: dict[str, RGB] = {
    "landuse:commercial": hex_rgb("#d2c6ad"),
    "landuse:retail": hex_rgb("#d2c6ad"),
    "landuse:residential": hex_rgb("#d6c8a6"),
    "landuse:construction": hex_rgb("#c9ad82"),
    "landuse:grass": hex_rgb("#93b45c"),
    "landuse:meadow": hex_rgb("#a9b866"),
    "landuse:forest": hex_rgb("#5e8f45"),
    "leisure:park": hex_rgb("#86ad55"),
    "leisure:garden": hex_rgb("#86ad55"),
    "leisure:pitch": hex_rgb("#5f9e4f"),
    "leisure:playground": hex_rgb("#c2a776"),
    "natural:water": hex_rgb("#4d9db0"),
    "natural:scrub": hex_rgb("#97a35c"),
    "natural:bare_rock": hex_rgb("#b7aa96"),
    "natural:grassland": hex_rgb("#a9b866"),
    "amenity:parking": hex_rgb("#b8b1a3"),
}
AREA_ORDER = ["landuse", "natural", "leisure", "amenity"]  # drawn bottom → top

# ---------------------------------------------------------------- roads
ASPHALT = hex_rgb("#5d6168")
ASPHALT_EDGE = hex_rgb("#43464c")
MARKING = hex_rgb("#ece4cf")
PAVING = hex_rgb("#c7b593")
TRACK = hex_rgb("#b39b75")
ROAD_FILL = {"footway": PAVING, "path": PAVING, "pedestrian": PAVING, "steps": PAVING, "cycleway": PAVING, "track": TRACK}
MARKED_CLASSES = {"motorway", "trunk", "primary", "secondary", "tertiary"}

# ---------------------------------------------------------------- buildings
# (base wall colour, roof colour) families; picked per building from its id.
FACADES_BY_USE: dict[str, list[tuple[str, str]]] = {
    "residential": [("#e9dcc4", "#cdbfa8"), ("#e7c9b4", "#c9b29d"), ("#d9e0c8", "#bcc3ad"), ("#f0e3c0", "#d1c3a0")],
    "commercial": [("#e3e1da", "#bfc0bb"), ("#d8d2c4", "#b8b2a6"), ("#cfd8dd", "#aeb8be")],
    "office": [("#e3e1da", "#bfc0bb"), ("#cfd8dd", "#aeb8be"), ("#d8d2c4", "#b8b2a6")],
    "civic": [("#e6c8a4", "#c4a788"), ("#ead9b5", "#c8b896")],
    "default": [("#e6dccb", "#c7bcab"), ("#ddd5c6", "#bdb5a7"), ("#e8d5c0", "#c9b6a2")],
}
GLASS = hex_rgb("#79b3c4")
GLASS_FRAME = hex_rgb("#d9dfe0")
WINDOW = hex_rgb("#4b5a6b")
WINDOW_LIT = hex_rgb("#8fb3c9")
TANK = hex_rgb("#2e3133")
AC_UNIT = hex_rgb("#d7d9d6")
OUTLINE_FACTOR = 0.45

# Face tones: multiplier applied to the base wall colour by orientation.
TONE_LIGHT, TONE_MID, TONE_DARK = 1.0, 0.82, 0.64


def face_tone(normal: tuple[float, float]) -> float:
    d = normal[0] * SUN_DIR[0] + normal[1] * SUN_DIR[1]
    return TONE_LIGHT if d > 0.35 else TONE_MID if d > -0.15 else TONE_DARK


def use_family(use: str) -> str:
    if use in ("residential", "apartments", "house", "dormitory", "terrace"):
        return "residential"
    if use in ("office",):
        return "office"
    if use in ("commercial", "retail", "industrial", "warehouse", "hotel"):
        return "commercial"
    if use in ("hospital", "school", "university", "college", "civic", "public", "government", "religious", "temple"):
        return "civic"
    return "default"


# ---------------------------------------------------------------- elevated structures
METRO_DECK = hex_rgb("#c9c4ba")
METRO_FASCIA = hex_rgb("#a39d92")
METRO_PILLAR = hex_rgb("#b5afa4")
FLYOVER_FASCIA = hex_rgb("#9e9a92")
ELEVATED_HEIGHT = {"rail": 13.0, "road": 7.0}  # metres per OSM layer group; estimated

# ---------------------------------------------------------------- trees
TREE_DARK = hex_rgb("#3f6e33")
TREE_MID = hex_rgb("#5a8a3c")
TREE_LIGHT = hex_rgb("#7aa64c")
TRUNK = hex_rgb("#6b5139")
