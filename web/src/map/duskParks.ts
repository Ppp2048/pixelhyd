/**
 * Dusk look, pocket parks: some small open plots between buildings become neighbourhood
 * parks with a hedge, a walking path, grass, a sand pit and play equipment (swings, slide,
 * see-saw, roundabout, climbing frame, benches, trees). duskLife.ts draws the equipment and
 * the kids and parents using it.
 *
 * Decoration, not data: OpenStreetMap has no park there. A plot qualifies only if it is
 * plain open ground, lies wholly inside the tile (so it is small and the park never meets a
 * tile edge), borders buildings, and wins a seeded draw, so most plots stay as they are.
 */
import { DUSK_SHADOW, hash, hex, MASK, type RGB, Surface, texture } from './duskPalette'
import { box, h3, polygon, setPx, type Scale, type Solid, type TileCtx } from './duskShared'

const MIN_PX = 1500 // ≈ 95 m² at k = 4 (16 px per m²)
const MAX_PX = 14000 // ≈ 875 m²
const MIN_BUILDING_EDGE = 0.12 // share of the plot's edge that touches buildings
const MAX_ROAD_EDGE = 0.5 // plots mostly ringed by road (traffic islands) stay as they are
const CHANCE = 0.45 // share of qualifying plots that become parks
const BUILDING = new Set<number>([Surface.Wall, Surface.Ink, Surface.Window, Surface.Glass, Surface.Roof])
const ROAD = new Set<number>([Surface.Road, Surface.Edge, Surface.Mark])

const HEDGE = hex('#2c5a2e')
const PATH = hex('#8a7a5f')
const GRASS = hex('#4a7f38')
const SAND = hex('#a38a5e')
const FRAMES = ['#b8483a', '#3f6ea8', '#d4a83a', '#3f8f5a'].map(hex)
const SLIDE = hex('#e0943a')
const STEEL = hex('#8d9196')
const SEAT = hex('#2e3138')
const WOOD = hex('#7a5634')
const WOOD_DARK = hex('#4f3824')

/** Where a kid (or a seated parent) sits on a piece of equipment, in metres from its anchor. */
export interface Seat {
  e: number
  n: number
  z: number
  adult?: boolean
}
export interface ParkItem {
  x: number // anchor, tile px (ground point)
  y: number
  solids: Solid[]
  seats: Seat[]
  tree?: boolean // a small park tree, drawn as a canopy blob
}
export interface Park {
  key: number
  items: ParkItem[]
  play: number[] // grass and sand pixels, where kids run about
  walk: number[] // path pixels
}

const T = 0.26 // thinnest member (≈ 1 px at k = 4)
const post = (e: number, n: number, z1: number, c: RGB): Solid => box(e - T / 2, e + T / 2, n - T / 2, n + T / 2, 0, z1, c)
type Kind = 'swing' | 'slide' | 'seesaw' | 'roundabout' | 'climber' | 'bench' | 'tree'
interface Design {
  solids: Solid[]
  foot: number[][] // ground footprint ring (m)
  seats: Seat[]
  tree?: boolean
}
const rect = (e0: number, e1: number, n0: number, n1: number) => [[e0, n0], [e1, n0], [e1, n1], [e0, n1]]

function design(kind: Kind, c: RGB): Design {
  switch (kind) {
    case 'swing':
      return {
        solids: [
          post(-1.3, -0.5, 2.1, c), post(-1.3, 0.5, 2.1, c), post(1.3, -0.5, 2.1, c), post(1.3, 0.5, 2.1, c),
          box(-1.43, 1.43, -0.13, 0.13, 1.95, 2.2, c),
          box(-0.68, -0.42, -0.13, 0.13, 0.58, 1.95, STEEL), box(0.42, 0.68, -0.13, 0.13, 0.58, 1.95, STEEL),
          box(-0.8, -0.3, -0.18, 0.18, 0.48, 0.58, SEAT), box(0.3, 0.8, -0.18, 0.18, 0.48, 0.58, SEAT),
        ],
        foot: rect(-1.5, 1.5, -0.7, 0.7),
        seats: [{ e: -0.55, n: 0, z: 0.58 }, { e: 0.55, n: 0, z: 0.58 }],
      }
    case 'slide': {
      const chute: Solid[] = []
      for (let i = 0; i < 5; i++) {
        const z = 1.45 - i * 0.3
        chute.push(box(-0.5 - (i + 1) * 0.44, -0.5 - i * 0.44, -0.33, 0.33, z - 0.14, z, SLIDE))
      }
      return {
        solids: [post(-0.5, -0.5, 1.5, c), post(-0.5, 0.5, 1.5, c), post(0.5, -0.5, 1.5, c), post(0.5, 0.5, 1.5, c), box(-0.55, 0.55, -0.55, 0.55, 1.38, 1.55, c), ...chute],
        foot: rect(-2.8, 0.7, -0.7, 0.7),
        seats: [{ e: 0, n: 0, z: 1.55 }, { e: -1.9, n: 0, z: 0.8 }],
      }
    }
    case 'seesaw':
      return {
        solids: [box(-0.2, 0.2, -0.2, 0.2, 0, 0.45, STEEL), box(-1.5, 1.5, -0.16, 0.16, 0.45, 0.58, c)],
        foot: rect(-1.6, 1.6, -0.4, 0.4),
        seats: [{ e: -1.25, n: 0, z: 0.58 }, { e: 1.25, n: 0, z: 0.58 }],
      }
    case 'roundabout': {
      const ring = Array.from({ length: 8 }, (_, i) => {
        const a = ((22.5 + 45 * i) * Math.PI) / 180
        return [Math.cos(a) * 1.0, Math.sin(a) * 1.0]
      })
      return {
        solids: [{ ring, z0: 0.1, z1: 0.3, top: c, side: STEEL }, box(-0.13, 0.13, -0.13, 0.13, 0.3, 0.95, STEEL)],
        foot: ring.map(([e, n]) => [e * 1.3, n * 1.3]),
        seats: [{ e: 0.55, n: -0.35, z: 0.3 }],
      }
    }
    case 'climber': {
      const s = 0.7
      return {
        solids: [
          post(-s, -s, 1.5, c), post(-s, s, 1.5, c), post(s, -s, 1.5, c), post(s, s, 1.5, c),
          box(-s, s, -s - T / 2, -s + T / 2, 1.3, 1.52, c), box(-s, s, s - T / 2, s + T / 2, 1.3, 1.52, c),
          box(-s - T / 2, -s + T / 2, -s, s, 1.3, 1.52, c), box(s - T / 2, s + T / 2, -s, s, 1.3, 1.52, c),
          box(-s, s, -s - T / 2, -s + T / 2, 0.65, 0.85, c), box(-s - T / 2, -s + T / 2, -s, s, 0.65, 0.85, c),
        ],
        foot: rect(-0.9, 0.9, -0.9, 0.9),
        seats: [{ e: s, n: -s, z: 1.52 }],
      }
    }
    case 'bench':
      return {
        solids: [
          box(-0.75, -0.55, -0.2, 0.2, 0, 0.4, WOOD_DARK), box(0.55, 0.75, -0.2, 0.2, 0, 0.4, WOOD_DARK),
          box(-0.85, 0.85, -0.24, 0.24, 0.4, 0.48, WOOD), box(-0.85, 0.85, 0.18, 0.32, 0.48, 0.95, WOOD),
        ],
        foot: rect(-0.95, 0.95, -0.4, 0.45),
        seats: [{ e: 0.3, n: -0.05, z: 0.48, adult: true }],
      }
    case 'tree':
      return { solids: [], foot: rect(-0.7, 0.7, -0.7, 0.7), seats: [], tree: true }
  }
}

/** Find this tile's pocket parks, paint their ground, and lay out their equipment. */
export function layParks(c: TileCtx, s: Scale): Park[] {
  const { px, w, h, cls, shade, bare } = c
  const n = w * h
  const seen = new Uint8Array(n)
  const queue = new Int32Array(n)
  const parks: Park[] = []
  for (let q0 = 0; q0 < n; q0++) {
    if (!bare[q0] || seen[q0]) continue
    let len = 0
    queue[len++] = q0
    seen[q0] = 1
    let edge = false
    let boundary = 0
    let byBuilding = 0
    let byRoad = 0
    let minX = w
    let minY = h
    for (let i = 0; i < len; i++) {
      const q = queue[i]
      const x = q % w
      const y = (q / w) | 0
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) edge = true
      for (let k = 0; k < 4; k++) {
        if ((k === 0 && x === 0) || (k === 1 && x === w - 1) || (k === 2 && y === 0) || (k === 3 && y === h - 1)) continue
        const r = q + (k === 0 ? -1 : k === 1 ? 1 : k === 2 ? -w : w)
        if (bare[r]) {
          if (!seen[r]) {
            seen[r] = 1
            queue[len++] = r
          }
        } else {
          boundary++
          if (BUILDING.has(cls[r])) byBuilding++
          else if (ROAD.has(cls[r])) byRoad++
        }
      }
    }
    if (edge || len < MIN_PX || len > MAX_PX || byBuilding < MIN_BUILDING_EDGE * boundary || byRoad > MAX_ROAD_EDGE * boundary) continue
    const kx = c.x0 + minX
    const ky = c.y0 + minY
    const key = hash(kx, ky)
    if (key > CHANCE) continue
    const park = lay(c, s, queue.slice(0, len), kx, ky)
    if (park) parks.push(park)
  }
  return parks

  function lay(c: TileCtx, s: Scale, members: Int32Array, kx: number, ky: number): Park | null {
    // Distance (px, 4-connected) from the plot's edge.
    const dist = new Map<number, number>()
    let frontier: number[] = []
    for (const q of members) if (!bare[q - 1] || !bare[q + 1] || !bare[q - w] || !bare[q + w]) frontier.push(q)
    for (const q of frontier) dist.set(q, 0)
    for (let d = 1; frontier.length && d < 64; d++) {
      const next: number[] = []
      for (const q of frontier)
        for (const r of [q - 1, q + 1, q - w, q + w])
          if (bare[r] && !dist.has(r)) {
            dist.set(r, d)
            next.push(r)
          }
      frontier = next
    }
    let deepest = members[0]
    for (const q of members) if ((dist.get(q) ?? 0) > (dist.get(deepest) ?? 0)) deepest = q
    if ((dist.get(deepest) ?? 0) < 7) return null // too thin for a park
    // Sand pit around the deepest point (a 3 m circle on the ground: a 2:1 ellipse on screen).
    const sx = deepest % w
    const sy = (deepest / w) | 0
    const rx = Math.SQRT2 * 3 * s.k
    const ry = rx / 2
    const play: number[] = []
    const walk: number[] = []
    const veg = texture(Surface.Veg)!
    const path = texture(Surface.Path)!
    for (const q of members) {
      const d = dist.get(q) ?? 0
      const x = q % w
      const y = (q / w) | 0
      const t = (((c.y0 + y) & MASK) << 10) | ((c.x0 + x) & MASK)
      let col: number[]
      if (d === 0) {
        col = HEDGE
        cls[q] = Surface.Tree // people and equipment stay out of the hedge
      } else if (d <= 2) {
        col = PATH.map((v) => v * (path[t] / 128))
        cls[q] = Surface.Path
        walk.push(q)
      } else if (d >= 4 && ((x + 0.5 - sx) / rx) ** 2 + ((y + 0.5 - sy) / ry) ** 2 < 1) {
        col = SAND.map((v) => v * (path[t] / 128))
        cls[q] = Surface.Lot
        play.push(q)
      } else {
        col = GRASS.map((v) => v * (veg[t] / 128))
        cls[q] = Surface.Veg
        play.push(q)
      }
      if (shade[q]) col = col.map((v, i) => v * DUSK_SHADOW[i])
      setPx(px, q, col)
      bare[q] = 0
    }
    // Equipment: try a jittered grid of spots, each with the next kind that fits.
    const kinds: Kind[] = ['swing', 'slide', 'seesaw', 'roundabout', 'climber', 'bench', 'tree', 'bench', 'tree', 'tree']
    const used = new Set<Kind>()
    const taken = new Uint8Array(w * h)
    const items: ParkItem[] = []
    const max = 2 + Math.floor(members.length / 1500)
    const start = Math.floor(h3(kx, ky, 41) * kinds.length)
    const proj = (e: number, nn: number) => [s.k * (e - nn), -(s.k / 2) * (e + nn)]
    const xs = members.map((q) => q % w)
    const ys = members.map((q) => (q / w) | 0)
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
    const spots: number[][] = []
    for (let gy = y0; gy <= y1; gy += 10) for (let gx = x0; gx <= x1; gx += 16) spots.push([gx, gy, h3(kx + gx, ky + gy, 40)])
    spots.sort((a, b) => a[2] - b[2]) // seeded shuffle, so equipment spreads over the park
    let spot = 0
    for (const [gx, gy] of spots) {
        if (items.length >= max) break
        const x = gx + Math.floor(h3(kx + gx, ky + gy, 42) * 12)
        const y = gy + Math.floor(h3(kx + gx, ky + gy, 43) * 6)
        const q = y * w + x
        if (x >= w || y >= h || (dist.get(q) ?? -1) < 4) continue
        spot++
        for (let j = 0; j < kinds.length; j++) {
          const kind = kinds[(start + spot + j) % kinds.length]
          if (used.has(kind) && kind !== 'bench' && kind !== 'tree') continue
          const d = design(kind, FRAMES[Math.floor(h3(kx + gx, ky + gy, 44) * FRAMES.length)])
          const fp: number[] = []
          if (!polygon(d.foot.map(([e, nn]) => { const [a, b] = proj(e, nn); return [x + 0.5 + a, y + 0.5 + b] }), w, h, fp)) continue
          if (!fp.every((t) => (dist.get(t) ?? -1) >= (kind === 'bench' || kind === 'tree' ? 3 : 4) && !taken[t])) continue
          for (const t of fp) for (const r of [t, t - 1, t + 1, t - w, t + w]) taken[r] = 1
          used.add(kind)
          items.push({ x: x + 0.5, y: y + 0.5, solids: d.solids, seats: d.seats, tree: d.tree })
          break
        }
      }
    return { key: hash(kx + 17, ky), items, play, walk }
  }
}
