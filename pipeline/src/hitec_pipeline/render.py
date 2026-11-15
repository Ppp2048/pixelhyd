"""Rasterise a scene into any rectangle of the art canvas.

All drawing uses aliased Pillow primitives (crisp pixel edges) and
coordinates translated by an integer chunk offset, so a chunk is
pixel-identical to the same region of a whole-canvas render.
"""

from __future__ import annotations

import numpy as np
from PIL import Image, ImageDraw
from shapely.geometry import MultiPolygon, Polygon, box

from . import style as S
from .scene import Building, Deck, Obj, Pillar, Scene, Tree


def _area2(pts) -> int:
    """Twice the signed area of a snapped polygon (integer, exact)."""
    return sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(pts, pts[1:] + pts[:1]))


def draw_poly(draw: ImageDraw.ImageDraw, pts, fill) -> None:
    """Draw a polygon unless it is degenerate after snapping.

    Pillow rasterises zero-area polygons inconsistently at the image border,
    which would break chunk seams; they contain no area to draw anyway.
    """
    if len(pts) >= 3 and _area2(pts) != 0:
        draw.polygon(pts, fill=fill)


class Painter:
    def __init__(self, scene: Scene, x0: int, y0: int, w: int, h: int):
        self.scene, self.proj = scene, scene.proj
        self.x0, self.y0, self.w, self.h = x0, y0, w, h
        self.img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        self.draw = ImageDraw.Draw(self.img)

    # ---- coordinates
    def px(self, e, n, z=0.0) -> list[tuple[int, int]]:
        """Project and snap to the *global* pixel grid, then shift into this region.

        Pillow rounds vertices to integers itself, but not symmetrically for
        negative coordinates, so a vertex left of/above a region would snap
        differently than in a whole-canvas render. Snapping first (round half
        up on global coordinates) makes every region pixel-identical.
        """
        x, y = self.proj.to_px(e, n, z)
        x = np.floor(np.atleast_1d(x) + 0.5).astype(np.int64) - self.x0
        y = np.floor(np.atleast_1d(y) + 0.5).astype(np.int64) - self.y0
        return list(zip(x.tolist(), y.tolist()))

    def visible(self, b: tuple[float, float, float, float]) -> bool:
        return not (b[2] < self.x0 or b[0] > self.x0 + self.w or b[3] < self.y0 or b[1] > self.y0 + self.h)

    # ---- polygons with holes, via a cropped mask
    def fill_geom(self, geom, colour, target: Image.Image | None = None, z: float = 0.0) -> None:
        target = target or self.img
        polys = geom.geoms if isinstance(geom, MultiPolygon) else [geom] if isinstance(geom, Polygon) else [
            g for g in getattr(geom, "geoms", []) if isinstance(g, Polygon)]
        for poly in polys:
            if poly.is_empty:
                continue
            ext = self.px(*np.asarray(poly.exterior.coords).T, z)
            if not poly.interiors:
                draw_poly(ImageDraw.Draw(target), ext, colour)
                continue
            xs = [p[0] for p in ext]
            ys = [p[1] for p in ext]
            bx0, by0 = max(0, int(min(xs)) - 1), max(0, int(min(ys)) - 1)
            bx1, by1 = min(self.w, int(max(xs)) + 2), min(self.h, int(max(ys)) + 2)
            if bx1 <= bx0 or by1 <= by0:
                continue
            # Draw the mask in full-chunk coordinates (crop afterwards) to keep rasterisation identical.
            mask = Image.new("L", (self.w, self.h), 0)
            md = ImageDraw.Draw(mask)
            draw_poly(md, ext, 255)
            for ring in poly.interiors:
                draw_poly(md, self.px(*np.asarray(ring.coords).T, z), 0)
            region = (bx0, by0, bx1, by1)
            target.paste(Image.new(target.mode, (bx1 - bx0, by1 - by0), colour), region, mask.crop(region))

    # ---- layers
    def ground(self) -> None:
        for geom, colour in self.scene.ground:
            self.fill_geom(geom, colour + (255,))
        for seg in self.scene.markings:
            pts = self.px(seg[:, 0], seg[:, 1])
            self.draw.line(pts, fill=S.MARKING + (255,), width=1)

    def shadows(self) -> None:
        if self.scene.shadow is None or self.scene.shadow.is_empty:
            return
        mask = Image.new("L", (self.w, self.h), 0)
        self.fill_geom(self.scene.shadow, 255, target=mask)
        m = np.asarray(mask) > 0
        arr = np.asarray(self.img).copy()
        tint = np.array(S.SHADOW_TINT)
        arr[m, :3] = np.round(arr[m, :3] * tint).astype(np.uint8)
        self.img = Image.fromarray(arr, "RGBA")
        self.draw = ImageDraw.Draw(self.img)

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

    # ---- primitives
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

    def prism(self, ring, z0, z1, wall, roof, outline=True):
        faces = self._faces(ring)
        for _, a, b, normal, _ in faces:
            tone = S.face_tone(normal)
            quad = self.px([a[0], b[0], b[0], a[0]], [a[1], b[1], b[1], a[1]], [z0, z0, z1, z1])
            draw_poly(self.draw, quad, S.scale(wall, tone) + (255,))
        top = self.px(ring[:, 0], ring[:, 1], z1)
        draw_poly(self.draw, top, roof + (255,))
        if outline:
            ink = S.scale(wall, S.OUTLINE_FACTOR) + (255,)
            self.draw.line(top + [top[0]], fill=ink, width=1)
            for _, a, b, _, _ in faces:
                for p in (a, b):
                    self.draw.line(self.px([p[0], p[0]], [p[1], p[1]], [z0, z1]), fill=ink, width=1)
        return faces

    def building(self, b: Building) -> None:
        faces = self._faces(b.ring)
        k = self.proj.k
        ink = S.scale(b.wall if not b.glass else S.GLASS, S.OUTLINE_FACTOR) + (255,)
        for _, a, c, normal, length in faces:
            self._wall(b, a, c, normal, length, k)
            # Corner lines belong to their wall, so nearer walls and the roof can cover them.
            for p in (a, c):
                self.draw.line(self.px([p[0], p[0]], [p[1], p[1]], [0, b.height]), fill=ink, width=1)
        top = self.px(b.ring[:, 0], b.ring[:, 1], b.height)
        draw_poly(self.draw, top, b.roof + (255,))
        self.draw.line(top + [top[0]], fill=ink, width=1)
        for e, n, kind in b.roof_items:
            if kind == "tank":
                self.prism(_square(e, n, 0.8), b.height, b.height + 1.4, S.TANK, S.scale(S.TANK, 1.25), outline=False)
            else:
                self.prism(_square(e, n, 0.7), b.height, b.height + 0.8, S.AC_UNIT, S.scale(S.AC_UNIT, 1.05), outline=False)

    def _wall(self, b: Building, a, c, normal, length, k) -> None:
        tone = S.face_tone(normal)
        quad = self.px([a[0], c[0], c[0], a[0]], [a[1], c[1], c[1], a[1]], [0, 0, b.height, b.height])
        if b.glass:
            draw_poly(self.draw, quad, S.scale(S.GLASS, tone) + (255,))
            frame = S.scale(S.GLASS_FRAME, tone) + (255,)
            for z in np.arange(b.floor_h, b.height - 0.5, b.floor_h):
                self.draw.line(self.px([a[0], c[0]], [a[1], c[1]], [z, z]), fill=frame, width=1)
            if length > 8:
                for t in np.arange(6.0, length - 2, 6.0):
                    p = a + (c - a) * (t / length)
                    self.draw.line(self.px([p[0], p[0]], [p[1], p[1]], [0.6, b.height]), fill=frame, width=1)
        else:
            draw_poly(self.draw, quad, S.scale(b.wall, tone) + (255,))
            if length < 2.5 or b.height < 2.8 or k < 1.5:
                return
            win = S.scale(S.WINDOW, 0.9 + 0.2 * tone) + (255,)
            ww = 1.2 if b.family == "residential" else 1.6
            cols = max(1, int((length - 1.0) // 3.2))
            spacing = (length - 1.0) / cols
            floors = max(1, int((b.height - 1.2) // b.floor_h))
            for f in range(floors):
                z0 = f * b.floor_h + 0.9
                z1 = min(z0 + 1.7, b.height - 0.4)
                for j in range(cols):
                    t0 = 0.5 + spacing * j + (spacing - ww) / 2
                    p0 = a + (c - a) * (t0 / length)
                    p1 = a + (c - a) * ((t0 + ww) / length)
                    pts = self.px([p0[0], p1[0], p1[0], p0[0]], [p0[1], p1[1], p1[1], p0[1]], [z0, z0, z1, z1])
                    draw_poly(self.draw, pts, win)

    def deck(self, d: Deck) -> None:
        z0, z1 = max(0.0, d.z - d.thickness), d.z
        faces = self._faces(d.ring)
        for _, a, c, normal, _ in faces:
            quad = self.px([a[0], c[0], c[0], a[0]], [a[1], c[1], c[1], a[1]], [z0, z0, z1, z1])
            draw_poly(self.draw, quad, S.scale(d.fascia, S.face_tone(normal)) + (255,))
        draw_poly(self.draw, self.px(d.ring[:, 0], d.ring[:, 1], z1), d.top + (255,))
        if d.kind == "rail":
            a, c = d.centre_line
            v = c - a
            nrm = np.array([-v[1], v[0]]) / (np.hypot(*v) or 1)
            for off in (-2.2, -0.8, 0.8, 2.2):
                p, q = a + nrm * off, c + nrm * off
                self.draw.line(self.px([p[0], q[0]], [p[1], q[1]], [z1, z1]), fill=S.scale(d.top, 0.62) + (255,), width=1)

    def tree(self, t: Tree) -> None:
        trunk_top = t.height - t.radius
        self.draw.line(self.px([t.e, t.e], [t.n, t.n], [0, trunk_top]), fill=S.TRUNK + (255,), width=max(1, int(self.proj.k * 0.4)))
        cx, cy = self.px([t.e], [t.n], [trunk_top + t.radius * 0.6])[0]
        r = t.radius * self.proj.k * 0.95
        ry = r * 0.8
        base = S.TREE_MID if t.seed > 0.4 else S.TREE_DARK
        self.draw.ellipse([cx - r, cy - ry, cx + r, cy + ry], fill=S.TREE_DARK + (255,))
        self.draw.ellipse([cx - r * 0.9, cy - ry * 1.05, cx + r * 0.6, cy + ry * 0.5], fill=base + (255,))
        self.draw.ellipse([cx - r * 0.1, cy - ry * 0.95, cx + r * 0.55, cy - ry * 0.25], fill=S.TREE_LIGHT + (255,))


def _square(e: float, n: float, half: float) -> np.ndarray:
    return np.array([[e - half, n - half], [e + half, n - half], [e + half, n + half], [e - half, n + half], [e - half, n - half]])


# Pillow truncates polygon span ends toward zero, so a primitive reaching left of
# (or above) a region can paint one stray pixel at column/row 0. Rendering with a
# small margin and cropping it off removes that; together with grid snapping in
# Painter.px this makes chunks pixel-identical to a whole-canvas render.
SEAM_MARGIN = 8


def render_region(scene: Scene, x0: int, y0: int, w: int, h: int, margin: int = SEAM_MARGIN) -> Image.Image:
    p = Painter(scene, x0 - margin, y0 - margin, w + 2 * margin, h + 2 * margin)
    p.ground()
    p.shadows()
    p.objects()
    return p.img.crop((margin, margin, margin + w, margin + h))


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
