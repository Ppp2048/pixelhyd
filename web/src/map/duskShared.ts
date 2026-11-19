/**
 * Dusk look: what the close-up passes share — the tile context, the sun, a convex polygon
 * rasteriser and a tiny iso renderer for boxes and prisms (vehicles, play equipment).
 */
import { clamp, hash, type RGB } from './duskPalette'

export interface TileCtx {
  px: Uint8ClampedArray // RGBA, already graded
  w: number
  h: number
  x0: number // world art px of the top-left pixel
  y0: number
  step: number // art px per tile pixel
  cls: Uint8Array // Surface per pixel, from the original art colours
  shade: Uint8Array // 1 where the art has a ground shadow
  bare: Uint8Array // 1 on plain ground with no land use drawn (open plots)
}
/** Art projection: px per metre along screen x (k) and per metre of height (v). */
export interface Scale {
  k: number
  v: number
}

export const h3 = (x: number, y: number, salt: number) => hash(x + Math.imul(salt, 0x3c6ef35f), y - salt * 7919)
export const pack = (c: RGB | number[]) => (clamp(Math.round(c[0])) << 16) | (clamp(Math.round(c[1])) << 8) | clamp(Math.round(c[2]))
export function scalePx(px: Uint8ClampedArray, q: number, f: number) {
  const p = q * 4
  px[p] = clamp(px[p] * f)
  px[p + 1] = clamp(px[p + 1] * f)
  px[p + 2] = clamp(px[p + 2] * f)
}
export function setPx(px: Uint8ClampedArray, q: number, c: RGB | number[]) {
  const p = q * 4
  px[p] = c[0]
  px[p + 1] = c[1]
  px[p + 2] = c[2]
}

// ---------------------------------------------------------------- the sun (style.py)
export const SUN = [Math.sin((160 * Math.PI) / 180), Math.cos((160 * Math.PI) / 180)] // azimuth 160°
const SHADOW_PER_M = 1 / Math.tan((42 * Math.PI) / 180) // elevation 42°
/** Ground offset (e, n) of the shadow of a point 1 m up. */
export const SHADOW_VEC = [-SUN[0] * SHADOW_PER_M, -SUN[1] * SHADOW_PER_M]
/** Face tone by outward normal: lit, mid or dark, with the dusk tint on shaded faces. */
export function tone(ne: number, nn: number): number[] {
  const d = ne * SUN[0] + nn * SUN[1]
  return d > 0.35 ? [1, 1, 1] : d > -0.15 ? [0.8, 0.8, 0.86] : [0.6, 0.62, 0.72]
}

/** Pixels whose centres lie inside a convex polygon (tile px); false if any falls outside the tile. */
export function polygon(pts: number[][], w: number, h: number, out: number[]): boolean {
  let x0 = Infinity
  let x1 = -Infinity
  let y0 = Infinity
  let y1 = -Infinity
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x)
    x1 = Math.max(x1, x)
    y0 = Math.min(y0, y)
    y1 = Math.max(y1, y)
  }
  const n = pts.length
  for (let y = Math.floor(y0); y <= Math.ceil(y1); y++)
    for (let x = Math.floor(x0); x <= Math.ceil(x1); x++) {
      const cx = x + 0.5
      const cy = y + 0.5
      let pos = false
      let neg = false
      for (let i = 0; i < n; i++) {
        const [ax, ay] = pts[i]
        const [bx, by] = pts[(i + 1) % n]
        const c = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
        if (c > 1e-9) pos = true
        else if (c < -1e-9) neg = true
      }
      if (pos && neg) continue
      if (x < 0 || y < 0 || x >= w || y >= h) return false
      out.push(y * w + x)
    }
  return true
}

/** A vertical prism: a convex counter-clockwise ring of (e, n) offsets in metres, from z0 to z1 m. */
export interface Solid {
  ring: number[][]
  z0: number
  z1: number
  top: RGB
  side: RGB
}
/** An axis-aligned box in metres. */
export const box = (e0: number, e1: number, n0: number, n1: number, z0: number, z1: number, top: RGB, side: RGB = top): Solid => ({
  ring: [[e0, n0], [e1, n0], [e1, n1], [e0, n1]],
  z0,
  z1,
  top,
  side,
})

/**
 * Draw solids standing on the ground at screen point `base` (tile px): visible faces with the
 * map's three tones, then tops; plus the pixels their shadows cover. Null if any part leaves the tile.
 * Solids are drawn far to near (the camera looks towards +e +n).
 */
export function renderSolids(solids: Solid[], base: number[], s: Scale, w: number, h: number): { pix: Map<number, number>; shadow: number[] } | null {
  const { k, v } = s
  const scr = (e: number, n: number, z: number) => [base[0] + k * (e - n), base[1] - (k / 2) * (e + n) - v * z]
  const pix = new Map<number, number>()
  const shadow = new Set<number>()
  const tmp: number[] = []
  const fill = (pts: number[][], col: number) => {
    tmp.length = 0
    if (!polygon(pts, w, h, tmp)) return false
    for (const t of tmp) pix.set(t, col)
    return true
  }
  const depth = (sd: Solid) => sd.ring.reduce((a, [e, n]) => a + e + n, 0) / sd.ring.length
  const order = [...solids].sort((a, b) => depth(b) - depth(a) || a.z0 - b.z0)
  for (const sd of order) {
    const r = sd.ring
    for (let i = 0; i < r.length; i++) {
      const [a, b] = [r[i], r[(i + 1) % r.length]]
      const de = b[0] - a[0]
      const dn = b[1] - a[1]
      const ln = Math.hypot(de, dn)
      if (ln < 1e-9) continue
      const ne = dn / ln
      const nn = -de / ln
      if (ne + nn >= 0) continue // faces away from the camera
      const tn = tone(ne, nn)
      if (!fill([scr(a[0], a[1], sd.z0), scr(b[0], b[1], sd.z0), scr(b[0], b[1], sd.z1), scr(a[0], a[1], sd.z1)], pack(sd.side.map((c, j) => c * tn[j])))) return null
    }
    if (!fill(r.map(([e, n]) => scr(e, n, sd.z1)), pack(sd.top))) return null
    // Shadow: the footprint dragged from the shadow of its bottom to that of its top.
    for (let z = sd.z0; z <= sd.z1 + 1e-9; z += Math.max(0.3, (sd.z1 - sd.z0) / 4)) {
      tmp.length = 0
      polygon(r.map(([e, n]) => scr(e + SHADOW_VEC[0] * z, n + SHADOW_VEC[1] * z, 0)), w, h, tmp)
      for (const t of tmp) shadow.add(t)
    }
  }
  return { pix, shadow: [...shadow] }
}
