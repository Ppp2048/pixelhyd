"""Rasterise a scene into any rectangle of the art canvas.

Every pixel decision is made from *global* integer art coordinates by our own
small NumPy rasteriser (polygons: even-odd rule sampled at pixel centres;
lines: stepping from global endpoints; ellipses: centre test). Nothing depends
on where a region's border falls, so any chunking of the canvas produces
exactly the same pixels as a whole-canvas render.

(Pillow's polygon/line drawing was used before; its rounding and clipping
depend on the image border, which caused occasional 1 px seams between chunks.)
"""

from __future__ import annotations

import math

import numpy as np
from PIL import Image
from shapely.geometry import MultiPolygon, Polygon

from . import style as S
from .scene import Building, Deck, Pillar, Scene, Tree

_ROW_BATCH = 128  # rows processed together when intersecting polygon edges


class Painter:
    def __init__(self, scene: Scene, x0: int, y0: int, w: int, h: int):
        self.scene, self.proj = scene, scene.proj
        self.x0, self.y0, self.w, self.h = x0, y0, w, h
        self.a = np.zeros((h, w, 4), dtype=np.uint8)

    @property
    def img(self) -> Image.Image:
        return Image.fromarray(self.a, "RGBA")

    # ---- coordinates
    def px(self, e, n, z=0.0) -> np.ndarray:
        """Project to art pixels and snap to the global integer grid (round half up). Returns (N, 2) int64."""
        x, y = self.proj.to_px(e, n, z)
        x = np.floor(np.atleast_1d(x) + 0.5).astype(np.int64)
        y = np.floor(np.atleast_1d(y) + 0.5).astype(np.int64)
        return np.stack([x, y], axis=1)

    def visible(self, b: tuple[float, float, float, float]) -> bool:
        return not (b[2] < self.x0 or b[0] > self.x0 + self.w or b[3] < self.y0 or b[1] > self.y0 + self.h)

    # ---- primitives (all inputs in global integer pixels)
    def fill(self, rings: list[np.ndarray], colour, target: np.ndarray | None = None) -> None:
        """Even-odd fill of one or more closed rings; a pixel is in if its centre is inside."""
        target = self.a if target is None else target
        ex0, ey0, ex1, ey1 = [], [], [], []
        ymin, ymax = math.inf, -math.inf
        xmin, xmax = math.inf, -math.inf
        for r in rings:
            if len(r) < 3:
                continue
            a = r
            b = np.roll(r, -1, axis=0)
            keep = a[:, 1] != b[:, 1]  # horizontal edges never cross a centre row
            ex0.append(a[keep, 0]); ey0.append(a[keep, 1]); ex1.append(b[keep, 0]); ey1.append(b[keep, 1])
            ymin, ymax = min(ymin, int(r[:, 1].min())), max(ymax, int(r[:, 1].max()))
            xmin, xmax = min(xmin, int(r[:, 0].min())), max(xmax, int(r[:, 0].max()))
        if not ex0:
            return
        X0 = np.concatenate(ex0).astype(np.float64); Y0 = np.concatenate(ey0).astype(np.float64)
        X1 = np.concatenate(ex1).astype(np.float64); Y1 = np.concatenate(ey1).astype(np.float64)
        if X0.size == 0 or xmax < self.x0 or xmin >= self.x0 + self.w:
            return
        r0, r1 = max(ymin, self.y0), min(ymax, self.y0 + self.h - 1)
        if r1 < r0:
            return
        slope = (X1 - X0) / (Y1 - Y0)
        lo, hi = np.minimum(Y0, Y1), np.maximum(Y0, Y1)
        if len(rings) == 1 and _convex(rings[0]) and r1 - r0 < 4 * _ROW_BATCH:
            # Convex: every centre row crosses the boundary 0 or 2 times (half-open edge rule),
            # so the span is [min, max) — identical to the general even-odd pairing below.
            rows = np.arange(r0, r1 + 1)
            yc = rows[:, None] + 0.5
            hit = (lo <= yc) & (yc < hi)
            xs = np.where(hit, X0 + (yc - Y0) * slope, np.nan)
            ok = hit.any(axis=1)
            if not ok.any():
                return
            with np.errstate(all="ignore"):
                left = np.nanmin(np.where(ok[:, None], xs, 0.0), axis=1)
                right = np.nanmax(np.where(ok[:, None], xs, 0.0), axis=1)
            start = np.where(ok, np.ceil(left - 0.5), 0).astype(np.int64) - self.x0
            end = np.where(ok, np.ceil(right - 0.5), 0).astype(np.int64) - self.x0
            c0, c1 = max(int(start[ok].min()), 0), min(int(end[ok].max()), self.w)
            if c1 <= c0:
                return
            cols = np.arange(c0, c1)
            inside = ok[:, None] & (cols >= start[:, None]) & (cols < end[:, None])
            target[r0 - self.y0:r1 - self.y0 + 1, c0:c1][inside] = colour
            return
        for b0 in range(r0, r1 + 1, _ROW_BATCH):
            rows = np.arange(b0, min(b0 + _ROW_BATCH, r1 + 1))
            yc = rows[:, None] + 0.5
            hit = (lo <= yc) & (yc < hi)
            if not hit.any():
                continue
            xs = X0 + (yc - Y0) * slope
            for i in np.nonzero(hit.any(axis=1))[0]:
                xi = np.sort(xs[i, hit[i]])
                starts = np.ceil(xi[0::2] - 0.5).astype(np.int64) - self.x0
                ends = np.ceil(xi[1::2] - 0.5).astype(np.int64) - self.x0  # exclusive
                ly = rows[i] - self.y0
                for s, e in zip(starts, ends):
                    s, e = max(s, 0), min(e, self.w)
                    if e > s:
                        target[ly, s:e] = colour

    def poly(self, pts: np.ndarray, colour) -> None:
        self.fill([pts], colour)

    def line(self, pts: np.ndarray, colour, width: int = 1) -> None:
        """1 px polyline stepped from its global endpoints."""
        xs, ys = [], []
        for (ax, ay), (bx, by) in zip(pts[:-1], pts[1:]):
            n = int(max(abs(bx - ax), abs(by - ay)))
            t = np.arange(n + 1) / max(n, 1)
            lx = np.floor(ax + (bx - ax) * t + 0.5).astype(np.int64)
            ly = np.floor(ay + (by - ay) * t + 0.5).astype(np.int64)
            for dx in range(width):
                xs.append(lx + dx)
                ys.append(ly)
        if not xs:
            return
        x = np.concatenate(xs) - self.x0
        y = np.concatenate(ys) - self.y0
        keep = (x >= 0) & (x < self.w) & (y >= 0) & (y < self.h)
        self.a[y[keep], x[keep]] = colour

    def ellipse(self, cx: float, cy: float, rx: float, ry: float, colour) -> None:
        """Filled axis-aligned ellipse: pixel centres inside (global coordinates)."""
        if rx <= 0 or ry <= 0:
            return
        gx0, gx1 = max(math.floor(cx - rx), self.x0), min(math.ceil(cx + rx), self.x0 + self.w - 1)
        gy0, gy1 = max(math.floor(cy - ry), self.y0), min(math.ceil(cy + ry), self.y0 + self.h - 1)
        if gx1 < gx0 or gy1 < gy0:
            return
        gx = np.arange(gx0, gx1 + 1) + 0.5
        gy = np.arange(gy0, gy1 + 1)[:, None] + 0.5
        inside = ((gx - cx) / rx) ** 2 + ((gy - cy) / ry) ** 2 <= 1.0
        sub = self.a[gy0 - self.y0:gy1 - self.y0 + 1, gx0 - self.x0:gx1 - self.x0 + 1]
        sub[inside] = colour

    def fill_geom(self, geom, colour, target: np.ndarray | None = None, z: float = 0.0) -> None:
        polys = geom.geoms if isinstance(geom, MultiPolygon) else [geom] if isinstance(geom, Polygon) else [
            g for g in getattr(geom, "geoms", []) if isinstance(g, Polygon)]
        for poly in polys:
            if poly.is_empty:
                continue
            rings = [self.px(*np.asarray(poly.exterior.coords).T, z)]
            rings += [self.px(*np.asarray(r.coords).T, z) for r in poly.interiors]
            self.fill(rings, colour, target)

    # ---- layers
    def ground(self) -> None:
        for geom, colour in self.scene.ground:
            self.fill_geom(geom, colour + (255,))
        for seg in self.scene.markings:
            self.line(self.px(seg[:, 0], seg[:, 1]), S.MARKING + (255,))

    def shadows(self) -> None:
        if self.scene.shadow is None or self.scene.shadow.is_empty:
            return
        mask = np.zeros((self.h, self.w), dtype=bool)
        self.fill_geom(self.scene.shadow, True, target=mask)
        tint = np.array(S.SHADOW_TINT)
        self.a[mask, :3] = np.round(self.a[mask, :3] * tint).astype(np.uint8)

    def objects(self) -> None:
        for obj in self.scene.objects:
            if not self.visible(obj.bounds):
                continue
            it = obj.item
            if isinstance(it, Building):
                self.building(it)
            elif isinstance(it, Deck):
                self.deck(it)
            elif isinstance(it, Pillar):
                self.prism(it.ring, 0.0, it.height, it.colour, S.scale(it.colour, 1.06), outline=False)
            elif isinstance(it, Tree):
                self.tree(it)

    # ---- scene objects
    def _faces(self, ring: np.ndarray):
        """Visible wall faces (camera looks towards +e+n), far ones first."""
        faces = []
        for a, b in zip(ring[:-1], ring[1:]):
            d = b - a
            length = float(np.hypot(*d))
            if length < 1e-6:
                continue
            normal = (d[1] / length, -d[0] / length)  # outward for a counter-clockwise ring
            if normal[0] + normal[1] < 0:
                faces.append((float((a + b).sum() / 2), a, b, normal, length))
        faces.sort(key=lambda f: -f[0])
        return faces

    def _quad(self, a, c, z0, z1) -> np.ndarray:
        return self.px([a[0], c[0], c[0], a[0]], [a[1], c[1], c[1], a[1]], [z0, z0, z1, z1])

    def prism(self, ring, z0, z1, wall, roof, outline=True):
        faces = self._faces(ring)
        for _, a, b, normal, _ in faces:
            self.poly(self._quad(a, b, z0, z1), S.scale(wall, S.face_tone(normal)) + (255,))
        top = self.px(ring[:, 0], ring[:, 1], z1)
        self.poly(top, roof + (255,))
        if outline:
            ink = S.scale(wall, S.OUTLINE_FACTOR) + (255,)
            self.line(np.vstack([top, top[:1]]), ink)
            for _, a, b, _, _ in faces:
                for p in (a, b):
                    self.line(self.px([p[0], p[0]], [p[1], p[1]], [z0, z1]), ink)
        return faces

    def building(self, b: Building) -> None:
        faces = self._faces(b.ring)
        k = self.proj.k
        ink = S.scale(b.wall if not b.glass else S.GLASS, S.OUTLINE_FACTOR) + (255,)
        for _, a, c, normal, length in faces:
            self._wall(b, a, c, normal, length, k)
            # Corner lines belong to their wall, so nearer walls and the roof can cover them.
            for p in (a, c):
                self.line(self.px([p[0], p[0]], [p[1], p[1]], [0, b.height]), ink)
        top = self.px(b.ring[:, 0], b.ring[:, 1], b.height)
        self.poly(top, b.roof + (255,))
        self.line(np.vstack([top, top[:1]]), ink)
        for e, n, kind in b.roof_items:
            if kind == "tank":
                self.prism(_square(e, n, 0.8), b.height, b.height + 1.4, S.TANK, S.scale(S.TANK, 1.25), outline=False)
            else:
                self.prism(_square(e, n, 0.7), b.height, b.height + 0.8, S.AC_UNIT, S.scale(S.AC_UNIT, 1.05), outline=False)

    def _wall(self, b: Building, a, c, normal, length, k) -> None:
        tone = S.face_tone(normal)
        quad = self._quad(a, c, 0, b.height)
        if b.glass:
            self.poly(quad, S.scale(S.GLASS, tone) + (255,))
            frame = S.scale(S.GLASS_FRAME, tone) + (255,)
            for z in np.arange(b.floor_h, b.height - 0.5, b.floor_h):
                self.line(self.px([a[0], c[0]], [a[1], c[1]], [z, z]), frame)
            if length > 8:
                for t in np.arange(6.0, length - 2, 6.0):
                    p = a + (c - a) * (t / length)
                    self.line(self.px([p[0], p[0]], [p[1], p[1]], [0.6, b.height]), frame)
            return
        self.poly(quad, S.scale(b.wall, tone) + (255,))
        if length < 2.5 or b.height < 2.8 or k < 1.5:
            return
        self._windows(b, a, c, length, quad, S.scale(S.WINDOW, 0.9 + 0.2 * tone) + (255,))

    def _windows(self, b: Building, a, c, length: float, quad: np.ndarray, colour) -> None:
        """Window grid as a wall-space texture, in one vectorised pass.

        Each pixel centre (global coordinates) inside the wall's box is mapped back to
        (t metres along the wall, z metres up) with the exact projection, then tested
        against the window grid — no per-window polygons, and region-independent.
        """
        gx0, gy0 = quad.min(axis=0)
        gx1, gy1 = quad.max(axis=0)
        gx0, gy0 = max(int(gx0), self.x0), max(int(gy0), self.y0)
        gx1, gy1 = min(int(gx1), self.x0 + self.w - 1), min(int(gy1), self.y0 + self.h - 1)
        if gx1 < gx0 or gy1 < gy0:
            return
        k, v = self.proj.k, self.proj.v
        d = (c - a) / length  # unit direction (e, n)
        ux, uy = k * (d[0] - d[1]), -(k / 2) * (d[0] + d[1])  # screen px per metre along the wall
        ax, ay = (float(q) for q in self.proj.to_px(a[0], a[1], 0.0))
        X = np.arange(gx0, gx1 + 1) + 0.5 - ax
        Y = np.arange(gy0, gy1 + 1)[:, None] + 0.5 - ay
        t = X / ux if abs(ux) > 1e-9 else np.full_like(X, np.nan)  # x depends on t only (vertical walls)
        z = (uy * t - Y) / v
        ww = 1.2 if b.family == "residential" else 1.6
        cols = max(1, int((length - 1.0) // 3.2))
        spacing = (length - 1.0) / cols
        floors = max(1, int((b.height - 1.2) // b.floor_h))
        tt = t - 0.5
        j = np.floor(tt / spacing)
        in_col = (j >= 0) & (j < cols) & (np.abs(tt - j * spacing - spacing / 2) < ww / 2)
        zz = z - 0.9
        f = np.floor(zz / b.floor_h)
        in_floor = (f >= 0) & (f < floors) & (zz - f * b.floor_h < np.minimum(1.7, b.height - 0.4 - (f * b.floor_h + 0.9)))
        mask = in_col & in_floor
        if mask.any():
            self.a[gy0 - self.y0:gy1 - self.y0 + 1, gx0 - self.x0:gx1 - self.x0 + 1][mask] = colour

    def deck(self, d: Deck) -> None:
        z0, z1 = max(0.0, d.z - d.thickness), d.z
        for _, a, c, normal, _ in self._faces(d.ring):
            self.poly(self._quad(a, c, z0, z1), S.scale(d.fascia, S.face_tone(normal)) + (255,))
        self.poly(self.px(d.ring[:, 0], d.ring[:, 1], z1), d.top + (255,))
        if d.kind == "rail":
            a, c = d.centre_line
            v = c - a
            nrm = np.array([-v[1], v[0]]) / (np.hypot(*v) or 1)
            for off in (-2.2, -0.8, 0.8, 2.2):
                p, q = a + nrm * off, c + nrm * off
                self.line(self.px([p[0], q[0]], [p[1], q[1]], [z1, z1]), S.scale(d.top, 0.62) + (255,))

    def tree(self, t: Tree) -> None:
        trunk_top = t.height - t.radius
        self.line(self.px([t.e, t.e], [t.n, t.n], [0, trunk_top]), S.TRUNK + (255,), width=max(1, int(self.proj.k * 0.4)))
        cx, cy = (float(v) for v in self.px([t.e], [t.n], [trunk_top + t.radius * 0.6])[0])
        r = t.radius * self.proj.k * 0.95
        ry = r * 0.8
        base = S.TREE_MID if t.seed > 0.4 else S.TREE_DARK
        self.ellipse(cx, cy, r, ry, S.TREE_DARK + (255,))
        self.ellipse(cx - r * 0.15, cy - ry * 0.28, r * 0.75, ry * 0.78, base + (255,))
        self.ellipse(cx + r * 0.22, cy - ry * 0.6, r * 0.33, ry * 0.35, S.TREE_LIGHT + (255,))


def _convex(r: np.ndarray) -> bool:
    """True if a closed integer ring is convex (zero turns allowed)."""
    if len(r) < 3:
        return False
    a = r[:-1] if np.array_equal(r[0], r[-1]) else r
    d = np.roll(a, -1, axis=0) - a
    cross = d[:, 0] * np.roll(d[:, 1], -1) - d[:, 1] * np.roll(d[:, 0], -1)
    return bool((cross >= 0).all() or (cross <= 0).all())


def _square(e: float, n: float, half: float) -> np.ndarray:
    return np.array([[e - half, n - half], [e + half, n - half], [e + half, n + half], [e - half, n + half], [e - half, n - half]])


def render_region(scene: Scene, x0: int, y0: int, w: int, h: int) -> Image.Image:
    p = Painter(scene, x0, y0, w, h)
    p.ground()
    p.shadows()
    p.objects()
    return p.img


def render_canvas(scene: Scene, chunk: int = 0) -> Image.Image:
    """Whole canvas, optionally assembled from chunk × chunk renders."""
    W, H = scene.proj.width, scene.proj.height
    if chunk <= 0:
        return render_region(scene, 0, 0, W, H)
    out = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    for cy in range(0, H, chunk):
        for cx in range(0, W, chunk):
            out.paste(render_region(scene, cx, cy, min(chunk, W - cx), min(chunk, H - cy)), (cx, cy))
    return out
