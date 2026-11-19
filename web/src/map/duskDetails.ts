/**
 * Dusk look, close-up details on buildings and trees (zoom ≥ 19): window sunshades
 * (chajjas), sills, curtains, lit windows, AC units, roof parapets, solar panels, contact
 * shadows at wall bases, and tree canopies with species tints, leaf clumps and blossoms.
 * Each is decided from this tile's pixels and world position, so tiles agree at their edges.
 */
import { GROUND_LEVEL, hash, hex, noise, type RGB, Surface } from './duskPalette'
import { h3, polygon, scalePx, setPx, type TileCtx } from './duskShared'

// ================================================================ buildings
const CURTAINS = ['#7a4e3c', '#5d6b4a', '#7b6033', '#5a4a66', '#8a5a5a'].map(hex)
const LIT = ['#f1bf68', '#f1bf68', '#e9d6a6', '#f0a857'].map(hex) // mostly warm amber, a few warm white
const WINDOW_DARK = hex('#27303d')
const AC_TOP = hex('#b6b9b7')
const AC_FRONT = hex('#8b8e8d')
const SOLAR = hex('#2c3b57')
const SOLAR_FRAME = hex('#6f8099')

export function detailBuildings(c: TileCtx): void {
  const { px, w, h, cls, step } = c
  const n = w * h
  const seen = new Uint8Array(n)
  const queue = new Int32Array(n)
  for (let q0 = 0; q0 < n; q0++) {
    if (cls[q0] !== Surface.Window || seen[q0]) continue
    // One window = one 4-connected run of window pixels.
    let len = 0
    queue[len++] = q0
    seen[q0] = 1
    let minX = w
    let maxX = 0
    let minY = h
    let maxY = 0
    for (let i = 0; i < len; i++) {
      const q = queue[i]
      const x = q % w
      const y = (q / w) | 0
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      for (const r of [x > 0 ? q - 1 : -1, x < w - 1 ? q + 1 : -1, y > 0 ? q - w : -1, y < h - 1 ? q + w : -1])
        if (r >= 0 && !seen[r] && cls[r] === Surface.Window) {
          seen[r] = 1
          queue[len++] = r
        }
    }
    windowDetail(c, queue, len, minX, maxX, minY, maxY)
  }
  for (let q = 0; q < n; q++) {
    if (cls[q] !== Surface.Roof) continue
    // Parapet: a light rim just inside the roof outline.
    const x = q % w
    const y = (q / w) | 0
    if ((x > 0 && cls[q - 1] === Surface.Ink) || (x < w - 1 && cls[q + 1] === Surface.Ink) || (y > 0 && cls[q - w] === Surface.Ink) || (y < h - 1 && cls[q + w] === Surface.Ink))
      scalePx(px, q, 1.1)
  }
  if (step === 1) solarPanels(c)
  contactShadows(c)
  detailTrees(c)
}

const WALLISH = new Set<number>([Surface.Wall, Surface.Ink, Surface.Window, Surface.Glass])
/** Ambient occlusion: the ground darkens for a pixel or two where a wall meets it. */
function contactShadows(c: TileCtx) {
  const { px, w, h, cls, step } = c
  for (let q = 2 * w; q < w * h; q++) {
    if (!GROUND_LEVEL.has(cls[q])) continue
    if (WALLISH.has(cls[q - w])) scalePx(px, q, step === 1 ? 0.78 : 0.84)
    else if (step === 1 && WALLISH.has(cls[q - 2 * w]) && GROUND_LEVEL.has(cls[q - w])) scalePx(px, q, 0.9)
  }
}

// ================================================================ trees
/** Flowering trees seen around Hyderabad: gulmohar, amaltas (laburnum), jacaranda, bougainvillea. */
const BLOSSOMS = ['#d4552f', '#e2b93b', '#9a72c8', '#c84a86'].map(hex)
const COOL_GREEN = [0.9, 1.02, 0.96] // neem, tamarind: deep and cool
const WARM_GREEN = [1.08, 1.07, 0.84] // peepal, rain tree: young yellow-green
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/**
 * Tree canopies: a slow world-anchored change of species tint, a lit rim on the sun side and
 * a shaded one underneath, and blossoms where flowering trees cluster. Every rule is a smooth
 * function of world position, so a tree split by a tile edge matches on both sides.
 */
function detailTrees(c: TileCtx) {
  const { px, w, h, cls, step } = c
  const tree = (q: number) => cls[q] === Surface.Tree
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const q = y * w + x
      if (!tree(q)) continue
      const X = c.x0 + x * step
      const Y = c.y0 + y * step
      const t = smooth(0.3, 0.7, noise(X & 1023, Y & 1023, 256, 128))
      const p = q * 4
      for (let i = 0; i < 3; i++) px[p + i] = Math.min(255, px[p + i] * (COOL_GREEN[i] + (WARM_GREEN[i] - COOL_GREEN[i]) * t))
      const under = (y < h - 1 && !tree(q + w)) || (x > 0 && !tree(q - 1))
      const lit = (y > 0 && !tree(q - w)) || (x < w - 1 && !tree(q + 1))
      if (under) scalePx(px, q, 0.8)
      else if (lit) scalePx(px, q, 1.14)
      const bloom = smooth(0.66, 0.84, noise((X + 4096) & 1023, Y & 1023, 128, 64)) * 0.16
      if (!under && bloom > 0 && hash(X >> 1, Y >> 1) < bloom) {
        const b = BLOSSOMS[Math.min(3, Math.floor(noise((X + 300) & 1023, (Y + 700) & 1023, 512, 256) * 4))]
        const f = lit ? 1.1 : 1
        px[p] = Math.min(255, b[0] * f)
        px[p + 1] = Math.min(255, b[1] * f)
        px[p + 2] = Math.min(255, b[2] * f)
      }
    }
}

function windowDetail(c: TileCtx, members: Int32Array, len: number, minX: number, maxX: number, minY: number, maxY: number) {
  const { px, w, h, cls, step } = c
  const key = [(c.x0 + ((minX + maxX) / 2) * step) >> 3, (c.y0 + ((minY + maxY) / 2) * step) >> 3]
  const r = hash(key[0], key[1])
  const r2 = h3(key[0], key[1], 911)
  const lit = r < 0.13 ? LIT[Math.floor(r2 * LIT.length)] : null
  const curtain = !lit && r < 0.3 ? CURTAINS[Math.floor(r2 * CURTAINS.length)] : null
  const mid = Math.round((minX + maxX) / 2)
  for (let i = 0; i < len; i++) {
    const q = members[i]
    const x = q % w
    const y = (q / w) | 0
    if (lit) setPx(px, q, lit)
    else if (curtain) setPx(px, q, x === mid && maxX - minX >= 2 ? WINDOW_DARK : curtain.map((v) => v * 0.8) as RGB)
    // Concrete sunshade over the window: a light ledge above, its shadow on the top row.
    if (y === 0 || cls[q - w] !== Surface.Window) {
      scalePx(px, q, 0.7)
      if (y > 0 && cls[q - w] === Surface.Wall) scalePx(px, q - w, 1.18)
    }
    // Sill below.
    if (y < h - 1 && cls[q + w] === Surface.Wall) scalePx(px, q + w, 1.1)
  }
  // Now and then an AC unit beside the window.
  if (step !== 1 || r2 < 0.86 || maxX - minX < 2) return
  const ax = maxX + 2
  for (let y = maxY - 1; y <= maxY + 1; y++)
    for (let x = ax; x < ax + 3; x++) if (x >= w || y < 0 || y >= h || cls[y * w + x] !== Surface.Wall) return
  for (let x = ax; x < ax + 3; x++) {
    setPx(px, (maxY - 1) * w + x, AC_TOP)
    setPx(px, maxY * w + x, AC_FRONT)
  }
  scalePx(px, (maxY + 1) * w + ax + 1, 0.85) // its drip stain
}

/** Small solar panels on some terraces, laid along the ground grid. */
function solarPanels(c: TileCtx) {
  const { px, w, h, cls } = c
  const pix: number[] = []
  for (let gy = 0; gy < h; gy += 16)
    for (let gx = 0; gx < w; gx += 16) {
      const cx = (c.x0 + gx) >> 4
      const cy = (c.y0 + gy) >> 4
      if (h3(cx, cy, 31) > 0.07) continue
      const ax = gx + 4 + Math.floor(h3(cx, cy, 32) * 8)
      const ay = gy + 6 + Math.floor(h3(cx, cy, 33) * 8)
      pix.length = 0
      // 2 m along east (+8, −4 px) by 1 m along north (−4, −2 px).
      if (!polygon([[ax, ay], [ax + 8, ay - 4], [ax + 4, ay - 6], [ax - 4, ay - 2]], w, h, pix)) continue
      const set = new Set(pix)
      const ok = pix.every((q) => {
        const x = q % w
        return cls[q] === Surface.Roof && x > 0 && x < w - 1 && q >= w && q < w * (h - 1) &&
          [q - 1, q + 1, q - w, q + w].every((r) => cls[r] === Surface.Roof)
      })
      if (!ok) continue
      for (const q of pix) setPx(px, q, set.has(q + w) ? SOLAR : SOLAR_FRAME)
    }
}
