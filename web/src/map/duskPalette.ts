/**
 * Dusk look: what each art colour is, what it becomes, and the tileable textures.
 *
 * Art tiles are lossless and drawn from the fixed palette in
 * pipeline/src/hitec_pipeline/style.py, so a pixel's exact colour says what it is: ground,
 * a road, a wall face (and which way it faces), a roof, a window. A ground-level shadow is
 * that colour times SHADOW_TINT. Zoomed-out tiles are averages; their colours go through a
 * smooth grade built from the same anchors, so the look does not jump between zoom levels.
 *
 * All colours here are ours.
 */

export type RGB = [number, number, number]
/** What an art pixel is. */
export const Surface = {
  Other: 0,
  Ground: 1,
  Veg: 2,
  Water: 3,
  Tree: 4,
  Window: 5,
  Wall: 6,
  Roof: 7,
  Glass: 8,
  Road: 9, // asphalt
  Edge: 10, // asphalt edge strip
  Mark: 11, // lane marking
  Path: 12, // paving, tracks
  Lot: 13, // parking
  Ink: 14, // building outline
} as const
export type Surface = (typeof Surface)[keyof typeof Surface]
/** Surfaces at ground level: tiny people, cars and lamps may stand on them. */
export const GROUND_LEVEL = new Set<number>([Surface.Ground, Surface.Veg, Surface.Road, Surface.Edge, Surface.Mark, Surface.Path, Surface.Lot])

export const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]
/** Python's round(): half to even, as the pipeline uses when it scales colours. */
const roundEven = (v: number) => {
  const f = Math.floor(v)
  const d = v - f
  return d > 0.5 || (d === 0.5 && f % 2 === 1) ? f + 1 : f
}
export const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v)
/** style.scale(): what the pipeline does to make face tones, shadows and outlines. */
const artScale = (c: RGB, f: number): RGB => c.map((v) => clamp(roundEven(v * f))) as RGB
const mul = (c: RGB, f: RGB | number): RGB => c.map((v, i) => clamp(Math.round(v * (typeof f === 'number' ? f : f[i])))) as RGB
const mix = (a: RGB, b: RGB, t: number): RGB => a.map((v, i) => Math.round(v + (b[i] - v) * t)) as RGB

// ---------------------------------------------------------------- must match style.py
const SHADOW_TINT: RGB = [0.66, 0.69, 0.8]
const TONES = [1.0, 0.82, 0.64] // lit (south, screen right), mid, dark (west, screen left)
const OUTLINE_FACTOR = 0.45
const WINDOW = hex('#4b5a6b')
const GLASS = hex('#79b3c4')
const GLASS_FRAME = hex('#d9dfe0')
const TANK = hex('#2e3133')
const AC_UNIT = hex('#d7d9d6')
/** (wall, roof) colour families, as in style.FACADES_BY_USE. */
const FAMILIES: [string, string][] = [
  ['#e9dcc4', '#cdbfa8'], ['#e7c9b4', '#c9b29d'], ['#d9e0c8', '#bcc3ad'], ['#f0e3c0', '#d1c3a0'],
  ['#e3e1da', '#bfc0bb'], ['#d8d2c4', '#b8b2a6'], ['#cfd8dd', '#aeb8be'],
  ['#e6c8a4', '#c4a788'], ['#ead9b5', '#c8b896'],
  ['#e6dccb', '#c7bcab'], ['#ddd5c6', '#bdb5a7'], ['#e8d5c0', '#c9b6a2'],
]

// ---------------------------------------------------------------- the dusk palette
/** Shadows at dusk: deeper and bluer than the art's. */
export const DUSK_SHADOW: RGB = [0.62, 0.66, 0.8]
/** Face tones at dusk: the shaded faces pick up a cool sky tint. */
const DUSK_TONES: RGB[] = [[1, 1, 1], [0.8, 0.8, 0.86], [0.6, 0.62, 0.72]]
/** Plain surfaces: art colour → dusk colour. Muted, earthy and calm. */
const SURFACES: [string, string, Surface][] = [
  ['#d8c9a8', '#8f7a5a', Surface.Ground],
  ['#d6c8a6', '#8c785a', Surface.Ground],
  ['#d2c6ad', '#857a69', Surface.Ground],
  ['#c9ad82', '#94744c', Surface.Ground],
  ['#c2a776', '#917550', Surface.Ground],
  ['#b7aa96', '#76705f', Surface.Ground],
  ['#b8b1a3', '#66645f', Surface.Lot],
  ['#93b45c', '#4d7d36', Surface.Veg],
  ['#a9b866', '#667f38', Surface.Veg],
  ['#5e8f45', '#2d5629', Surface.Veg],
  ['#86ad55', '#457633', Surface.Veg],
  ['#5f9e4f', '#33703a', Surface.Veg],
  ['#97a35c', '#5c6b36', Surface.Veg],
  ['#4d9db0', '#1d5c70', Surface.Water],
  ['#3f6e33', '#1f4524', Surface.Tree],
  ['#5a8a3c', '#2f6230', Surface.Tree],
  ['#7aa64c', '#5c8f3e', Surface.Tree],
  ['#6b5139', '#4a3526', Surface.Other], // trunk
  ['#5d6168', '#3b3f48', Surface.Road],
  ['#43464c', '#292c33', Surface.Edge],
  ['#ece4cf', '#c9bfa3', Surface.Mark],
  ['#c7b593', '#8a7a5f', Surface.Path],
  ['#b39b75', '#7f6847', Surface.Path],
]
/** Wall families at dusk (lit face): limewash, terracotta, sage, ochre, concrete, sandstone, powder blue… */
const WALLS_DUSK: Record<string, string> = {
  '#e9dcc4': '#c7b28e', '#e7c9b4': '#c48a6d', '#d9e0c8': '#9cad88', '#f0e3c0': '#d0ab5c',
  '#e3e1da': '#b0b1ad', '#d8d2c4': '#a99b84', '#cfd8dd': '#8aa1b0',
  '#e6c8a4': '#c09665', '#ead9b5': '#c9af82',
  '#e6dccb': '#bca991', '#ddd5c6': '#a69e90', '#e8d5c0': '#c0a088',
}
const ROOF_CONCRETE = hex('#86837c')
const WINDOW_DUSK = hex('#27303d')
const GLASS_DUSK = hex('#3c6576')
const FRAME_DUSK = hex('#8f9a9e')
const TANK_DUSK = hex('#1e2023')
const AC_DUSK = hex('#a3a6a4')
export const FOAM = hex('#a9d3cf')
const GLINT = hex('#8cc7cf')
export const WINDOW_LIT = hex('#f1bf68') // the one warm accent

/** Everything without an anchor (blended pixels, pillars, decks): gently richer, darker mids. */
function baseGrade(r: number, g: number, b: number): RGB {
  const l = 0.299 * r + 0.587 * g + 0.114 * b
  const f = (c: number) => clamp(Math.pow(clamp(l + (c - l) * 1.15) / 255, 1.12) * 0.84 * 255)
  return [f(r), f(g), f(b)]
}

interface Pair {
  art: RGB
  dusk: RGB
  s: Surface
  shadowed: boolean
}
function pairs(): Pair[] {
  const out: Pair[] = []
  const add = (art: RGB, dusk: RGB, s: Surface, shadowed = false) => out.push({ art, dusk, s, shadowed })
  for (const [a, t, s] of SURFACES) {
    add(hex(a), hex(t), s)
    add(hex(a).map((v, i) => roundEven(v * SHADOW_TINT[i])) as RGB, mul(hex(t), DUSK_SHADOW), s, true)
  }
  for (const [w, r] of FAMILIES) {
    const wall = hex(w)
    const dusk = hex(WALLS_DUSK[w])
    TONES.forEach((t, i) => add(artScale(wall, t), mul(dusk, DUSK_TONES[i]), Surface.Wall))
    add(artScale(wall, OUTLINE_FACTOR), mul(dusk, [0.4, 0.4, 0.47]), Surface.Ink)
    add(hex(r), mul(mix(dusk, ROOF_CONCRETE, 0.55), 0.92), Surface.Roof)
  }
  TONES.forEach((t, i) => {
    add(artScale(GLASS, t), mul(GLASS_DUSK, DUSK_TONES[i]), Surface.Glass)
    add(artScale(GLASS_FRAME, t), mul(FRAME_DUSK, DUSK_TONES[i]), Surface.Other)
    add(artScale(WINDOW, 0.9 + 0.2 * t), mul(WINDOW_DUSK, 0.9 + 0.2 * t), Surface.Window)
    add(artScale(TANK, t), mul(TANK_DUSK, DUSK_TONES[i]), Surface.Other)
    add(artScale(AC_UNIT, t), mul(AC_DUSK, DUSK_TONES[i]), Surface.Other)
  })
  add(artScale(GLASS, OUTLINE_FACTOR), mul(GLASS_DUSK, 0.45), Surface.Ink)
  add(artScale(TANK, 1.25), mul(TANK_DUSK, 1.3), Surface.Other)
  add(artScale(AC_UNIT, 1.05), mul(AC_DUSK, 1.05), Surface.Other)
  return out
}

// ---------------------------------------------------------------- colour tables
const SLOTS = 4096 // open-addressing table for the ~200 exact palette colours
export interface Tables {
  keys: Int32Array // colour key per slot, -1 = empty
  entry: Int16Array // slot → entry index
  colour: Uint8Array // entry → dusk RGB
  surface: Uint8Array // entry → Surface
  shadowed: Uint8Array // entry → 1 if a ground shadow pixel
  lut: Uint8Array // 64³ smooth grade for colours without an exact entry
}
export const slotOf = (k: number) => (Math.imul(k, 0x9e3779b1) >>> 20) & (SLOTS - 1)
export const SLOT_MASK = SLOTS - 1

export function buildTables(): Tables {
  const list = pairs()
  const keys = new Int32Array(SLOTS).fill(-1)
  const entry = new Int16Array(SLOTS)
  const colour = new Uint8Array(list.length * 3)
  const surface = new Uint8Array(list.length)
  const shadowed = new Uint8Array(list.length)
  list.forEach(({ art, dusk, s, shadowed: sh }, i) => {
    const k = (art[0] << 16) | (art[1] << 8) | art[2]
    let slot = slotOf(k)
    while (keys[slot] !== -1 && keys[slot] !== k) slot = (slot + 1) & SLOT_MASK
    if (keys[slot] === k) return // first anchor wins on a collision
    keys[slot] = k
    entry[slot] = i
    colour.set(dusk, i * 3)
    surface[i] = s
    shadowed[i] = sh ? 1 : 0
  })

  // Smooth grade: base grade plus the anchors' corrections, blended by colour distance, so a
  // zoomed-out pixel averaged from dusk-mapped colours lands near the average of their targets.
  const SIGMA2 = 2 * 16 * 16
  const REACH = 9 * SIGMA2
  const n = list.length
  const ar = new Float32Array(n)
  const ag = new Float32Array(n)
  const ab = new Float32Array(n)
  const dr = new Float32Array(n)
  const dg = new Float32Array(n)
  const db = new Float32Array(n)
  list.forEach(({ art, dusk }, i) => {
    const g = baseGrade(...art)
    ;[ar[i], ag[i], ab[i]] = art
    ;[dr[i], dg[i], db[i]] = [dusk[0] - g[0], dusk[1] - g[1], dusk[2] - g[2]]
  })
  const lut = new Uint8Array(64 * 64 * 64 * 3)
  for (let ri = 0; ri < 64; ri++)
    for (let gi = 0; gi < 64; gi++)
      for (let bi = 0; bi < 64; bi++) {
        const r = ri * 4 + 2
        const g = gi * 4 + 2
        const b = bi * 4 + 2
        const base = baseGrade(r, g, b)
        let w = 0
        let cr = 0
        let cg = 0
        let cb = 0
        for (let i = 0; i < n; i++) {
          const e = (r - ar[i]) ** 2 + (g - ag[i]) ** 2 + (b - ab[i]) ** 2
          if (e > REACH) continue
          const k = Math.exp(-e / SIGMA2)
          w += k
          cr += k * dr[i]
          cg += k * dg[i]
          cb += k * db[i]
        }
        const d = Math.max(1, w)
        const o = ((ri << 12) | (gi << 6) | bi) * 3
        lut[o] = clamp(Math.round(base[0] + cr / d))
        lut[o + 1] = clamp(Math.round(base[1] + cg / d))
        lut[o + 2] = clamp(Math.round(base[2] + cb / d))
      }
  return { keys, entry, colour, surface, shadowed, lut }
}

// ---------------------------------------------------------------- textures (tileable, world-anchored)
export const P = 1024 // texture period in art px (256 m); patterns wrap seamlessly
export const MASK = P - 1
/** Texture codes: 0 = special colour (glint / lit window), otherwise brightness factor = code / 128. */
export const SPECIAL = 0
const f = (factor: number) => Math.round(factor * 128)

export function hash(x: number, y: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1)
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}
/** Value noise with lattice cells sx × sy art px that wraps every P px (sx, sy divide P). */
function noise(X: number, Y: number, sx: number, sy: number): number {
  const nx = P / sx
  const ny = P / sy
  const x = X / sx
  const y = Y / sy
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const u = (x - xi) ** 2 * (3 - 2 * (x - xi))
  const v = (y - yi) ** 2 * (3 - 2 * (y - yi))
  const h = (a: number, b: number) => hash(((a % nx) + nx) % nx, ((b % ny) + ny) % ny)
  const top = h(xi, yi) + (h(xi + 1, yi) - h(xi, yi)) * u
  const bottom = h(xi, yi + 1) + (h(xi + 1, yi + 1) - h(xi, yi + 1)) * u
  return top + (bottom - top) * v
}
// 4 × 4 ordered (Bayer) dither: two flat tones per material mixed by pattern, not by gradient.
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16)
export const bayer = (x: number, y: number) => BAYER[((y & 3) << 2) | (x & 3)]

/** One surface's pattern. Ground dither cells are 2 art px so it stays legible at zoom 18–19. */
function buildTexture(s: Surface): Uint8Array {
  const t = new Uint8Array(P * P).fill(f(1))
  for (let Y = 0; Y < P; Y++)
    for (let X = 0; X < P; X++) {
      const cx = X >> 1
      const cy = Y >> 1
      let v = f(1)
      switch (s) {
        case Surface.Ground: {
          const n = noise(X, Y, 32, 16) * 0.75 + noise(X, Y, 8, 4) * 0.25 // iso ground: squashed 2:1
          v = hash(cx & (P / 2 - 1), cy) < 0.005 ? f(0.84) : n > bayer(cx, cy) * 0.5 + 0.35 ? f(1.035) : f(0.965)
          break
        }
        case Surface.Veg:
          v = hash(cx, Y) < 0.035 ? f(1.15) : noise(X, Y, 16, 8) > bayer(cx, cy) ? f(1.05) : f(0.94)
          break
        case Surface.Water:
          v = noise(X, Y, 128, 64) > bayer(cx, cy) * 0.6 + 0.2 ? f(1.03) : f(0.96)
          break
        case Surface.Tree: {
          const h = hash(cx, cy)
          v = h < 0.18 ? f(0.88) : h > 0.86 ? f(1.12) : f(1)
          break
        }
        case Surface.Window:
          v = hash(X >> 3, Y >> 2) < 0.12 ? SPECIAL : f(1)
          break
        case Surface.Wall: {
          // Plaster grain (1 px dither) and thin monsoon streaks running down the walls.
          // Both are vertical or point-like, so they read right on a wall of any direction.
          const streak = hash(X, 77) < 0.06 && noise(X, Y, 8, 32) > 0.55
          v = streak ? f(0.92) : noise(X, Y, 4, 4) > bayer(X, Y) ? f(1.02) : f(0.98)
          break
        }
        case Surface.Roof: {
          // Weathered concrete terraces: soft blotches and specks.
          const n = noise(X, Y, 64, 32) * 0.7 + noise(X, Y, 8, 4) * 0.3
          v = hash(X, Y) < 0.008 ? f(0.88) : n > bayer(cx, cy) * 0.5 + 0.42 ? f(0.95) : f(1.02)
          break
        }
        case Surface.Glass: {
          // Sky reflections: soft vertical bands.
          const n = noise(X, Y, 16, 1024) + (bayer(X, Y) - 0.5) * 0.15
          v = n > 0.66 ? f(1.1) : n < 0.3 ? f(0.93) : f(1)
          break
        }
        case Surface.Road: {
          const n = noise(X, Y, 64, 32)
          v = hash(X, Y) < 0.006 ? f(0.9) : n > 0.72 + bayer(cx, cy) * 0.1 ? f(0.95) : noise(X, Y, 8, 4) > bayer(cx, cy) * 0.4 + 0.5 ? f(1.03) : f(1)
          break
        }
        case Surface.Path:
        case Surface.Lot:
          v = noise(X, Y, 8, 4) > bayer(cx, cy) ? f(1.03) : f(0.97)
          break
      }
      t[(Y << 10) | X] = v
    }
  if (s === Surface.Water) {
    // Calm water: sparse short horizontal glints, one per few 32 × 12 px cells.
    for (let gy = 0; gy < P / 12; gy++)
      for (let gx = 0; gx < P / 32; gx++) {
        if (hash(gx + 7919, gy) > 0.3) continue
        const x0 = gx * 32 + Math.floor(hash(gx, gy + 104729) * 24)
        const y0 = gy * 12 + Math.floor(hash(gx + 31, gy) * 10)
        const len = 3 + Math.floor(hash(gy, gx) * 5)
        for (let k = 0; k < len; k++) t[(y0 << 10) | ((x0 + k) & MASK)] = SPECIAL
      }
  }
  return t
}

const TEXTURED: Surface[] = [Surface.Ground, Surface.Veg, Surface.Water, Surface.Tree, Surface.Window, Surface.Wall, Surface.Roof, Surface.Glass, Surface.Road, Surface.Path, Surface.Lot]
const textures: (Uint8Array | null)[] = []
/** The pattern for a surface, or null if it has none. Built on first use. */
export function texture(s: number): Uint8Array | null {
  if (textures[s] !== undefined) return textures[s]
  return (textures[s] = TEXTURED.includes(s as Surface) ? buildTexture(s as Surface) : null)
}
export const SPECIAL_COLOUR: Partial<Record<number, RGB>> = { [Surface.Water]: GLINT, [Surface.Window]: WINDOW_LIT }

let tables: Tables | null = null
export const getTables = () => (tables ??= buildTables())
/** Build everything up front (in a worker, before the first tile arrives). */
export function warm(): void {
  getTables()
  for (const s of TEXTURED) texture(s)
}
