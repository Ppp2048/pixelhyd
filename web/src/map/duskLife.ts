/**
 * Dusk look, street life on native-zoom tiles: tiny cars, auto-rickshaws, buses, bikes,
 * people and street lamps, plus pocket parks on some small open plots (duskParks.ts).
 *
 * All of it is decoration, not data: it is placed by a seeded hash where the art shows
 * open road, footway or ground. Everything is decided from this tile's pixels alone and
 * every sprite (with its shadow and lamp glow) lies wholly inside the tile, so tiles never
 * disagree at their edges and the same place always shows the same scene.
 */
import { bayer, clamp, DUSK_SHADOW, GROUND_LEVEL, hex, type RGB, Surface } from './duskPalette'
import { layParks } from './duskParks'
import { h3, pack, polygon, renderSolids, SHADOW_VEC, tone, type Scale, type TileCtx } from './duskShared'

const CAR_COLOURS = ['#d9d6cf', '#d9d6cf', '#a9adb2', '#6d7178', '#2b2d31', '#9e3b32', '#34507a', '#6b2e33', '#b9a782'].map(hex)
const SHIRTS = ['#d9d6cf', '#4f6d8f', '#a0463c', '#c9a03d', '#5d7a4a', '#7a5a8a', '#3a3d44', '#c77a4a'].map(hex)
const SARIS = ['#b8326a', '#d0782e', '#2f8a85', '#d1aa2a', '#7a3a8f', '#c23b3b'].map(hex)
const PANTS = ['#2e3440', '#3d3a36', '#4a4f5a', '#6b5a45'].map(hex)
const SKIN = ['#8a5a3c', '#a06b48', '#6e4630', '#b47c55'].map(hex)
const KIDS = ['#e04b4b', '#3d8fd9', '#f0c03a', '#5bbf6a', '#e07ac0', '#f08a3a', '#f2efe6'].map(hex)
const HAIR = hex('#1c1a19')
const CANOPY = ['#1f4524', '#2f6230', '#5c8f3e'].map(hex) // dark, mid, light
const TRUNK = hex('#4a3526')
const CAB_GLASS = hex('#26303a')
const HEADLIGHT = hex('#ffe6a6')
const TAILLIGHT = hex('#c8423a')
const POLE = hex('#7a7e86')
const LAMP = hex('#ffe2a0')
const GLOW: RGB = [1.0, 0.78, 0.5] // warm sodium-ish light pool
const GLOW_R = 3.2 // m

interface Sprite {
  foot: number // screen y of the ground contact: farther sprites (smaller y) are drawn first
  pix: Map<number, number> // pixel → packed RGB
  shadow: number[]
  glow?: { x: number; y: number; rx: number; ry: number }
}

/** A vehicle part: a box `len` × `wid` m, centred `along` m ahead of the vehicle centre, from z0 to z1 m. */
interface Part {
  len: number
  wid: number
  along: number
  z0: number
  z1: number
  top: RGB
  side: RGB
}
interface Vehicle {
  len: number
  wid: number
  lights: boolean
  parts: Part[]
}
function vehicle(r: number, roadWidth: number, colour: RGB, rider: RGB): Vehicle {
  if (roadWidth >= 9 && r < 0.06) {
    const body = hex('#a8473b')
    return { len: 10, wid: 2.5, lights: true, parts: [
      { len: 10, wid: 2.5, along: 0, z0: 0, z1: 1.3, top: body, side: body },
      { len: 10, wid: 2.5, along: 0, z0: 1.3, z1: 2.3, top: body, side: CAB_GLASS },
      { len: 10, wid: 2.5, along: 0, z0: 2.3, z1: 2.9, top: hex('#c9c4b8'), side: hex('#d8cfb8') },
    ] }
  }
  if (r < 0.35) {
    const green = hex('#2f6a3a')
    return { len: 2.7, wid: 1.35, lights: true, parts: [
      { len: 2.7, wid: 1.35, along: 0, z0: 0, z1: 0.6, top: green, side: green },
      { len: 2.0, wid: 1.3, along: -0.3, z0: 0.6, z1: 1.6, top: hex('#d8b23a'), side: hex('#1e2426') },
    ] }
  }
  if (r < 0.55) {
    return { len: 1.8, wid: 0.6, lights: false, parts: [
      { len: 1.8, wid: 0.5, along: 0, z0: 0.2, z1: 0.8, top: hex('#2a2a2e'), side: hex('#2a2a2e') },
      { len: 0.5, wid: 0.5, along: -0.15, z0: 0.8, z1: 1.55, top: HAIR, side: rider },
    ] }
  }
  return { len: 4.2, wid: 1.75, lights: true, parts: [
    { len: 4.2, wid: 1.75, along: 0, z0: 0.15, z1: 0.9, top: colour, side: colour },
    { len: 2.1, wid: 1.55, along: -0.25, z0: 0.9, z1: 1.45, top: colour.map((v) => v * 1.06) as RGB, side: CAB_GLASS },
  ] }
}

export function addLife(c: TileCtx, s: Scale): void {
  const { w, h, cls } = c
  const { k, v } = s
  const proj = (de: number, dn: number, z: number) => [k * (de - dn), -(k / 2) * (de + dn) - v * z]
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? -1 : y * w + x)
  const isRoad = (q: number) => q >= 0 && (cls[q] === Surface.Road || cls[q] === Surface.Mark || cls[q] === Surface.Edge)
  const occ = new Uint8Array(w * h)
  const sprites: Sprite[] = []

  /** Road direction at a pixel (world unit vector) from the structure tensor of the asphalt mask. */
  function roadDir(x: number, y: number, R = 10): [number, number] | null {
    let a = 0
    let b = 0
    let d = 0
    const m = (xx: number, yy: number) => (cls[yy * w + xx] === Surface.Road ? 1 : 0)
    for (let yy = Math.max(1, y - R); yy <= Math.min(h - 2, y + R); yy++)
      for (let xx = Math.max(1, x - R); xx <= Math.min(w - 2, x + R); xx++) {
        const gx = m(xx + 1, yy) - m(xx - 1, yy)
        const gy = m(xx, yy + 1) - m(xx, yy - 1)
        a += gx * gx
        b += gx * gy
        d += gy * gy
      }
    if (a + d < 8 || Math.hypot(a - d, 2 * b) / (a + d) < 0.5) return null // no edge nearby, or a junction
    const t = 0.5 * Math.atan2(2 * b, a - d) // across the road
    const [dx, dy] = [-Math.sin(t), Math.cos(t)] // along it, on screen
    const de = (dx - 2 * dy) / (2 * k)
    const dn = (-2 * dy - dx) / (2 * k)
    const l = Math.hypot(de, dn)
    return [de / l, dn / l]
  }
  /** Distance (m) from a road pixel to the road's edge on each side, across direction u. */
  function roadSpan(x: number, y: number, u: number[]): [number, number] | null {
    const p = [-u[1], u[0]]
    const out: number[] = []
    for (const side of [-1, 1]) {
      let s = 0.25
      for (; s <= 14; s += 0.25) {
        const [sx, sy] = proj(p[0] * s * side, p[1] * s * side, 0)
        const q = at(Math.floor(x + 0.5 + sx), Math.floor(y + 0.5 + sy))
        if (q < 0) return null
        if (!isRoad(q)) break
      }
      if (s > 14) return null
      out.push(s)
    }
    return [out[0], out[1]]
  }

  function commit(sp: Sprite, claim = true) {
    if (claim) for (const q of sp.pix.keys()) occ[q] = 1
    sprites.push(sp)
  }
  const free = (pix: Iterable<number>) => {
    for (const q of pix) if (occ[q]) return false
    return true
  }

  // ---- pocket parks first: they turn open plots into grass and paths that people then use
  for (const park of layParks(c, s)) {
    let i = 0
    for (const it of park.items) {
      const foot = it.y
      if (it.tree) {
        parkTree(it.x, it.y, h3(park.key * 1e6, i++, 1))
        continue
      }
      const drawn = renderSolids(it.solids, [it.x, it.y], s, w, h)
      if (!drawn || !free(drawn.pix.keys())) continue
      commit({ foot, pix: drawn.pix, shadow: drawn.shadow })
      for (const seat of it.seats) {
        const r = h3(park.key * 1e6, i++, 2)
        if (r > 0.75) continue // an empty seat now and then
        const [sx, sy] = proj(seat.e, seat.n, seat.z)
        person(Math.floor(it.x + sx) - (seat.adult ? 0 : 1), Math.floor(it.y + sy), r, { kid: !seat.adult, seated: true, foot: foot + 0.5 })
      }
    }
    // Kids running about on the grass and in the sand, a few parents on the path.
    const kids = Math.round(park.play.length / 600)
    for (let j = 0; j < kids && park.play.length; j++) {
      const q = park.play[Math.floor(h3(park.key * 1e6, j, 3) * park.play.length)]
      person(q % w, (q / w) | 0, h3(park.key * 1e6, j, 4), { kid: true })
    }
    for (let j = 0; j < 1 + (park.walk.length > 300 ? 1 : 0) && park.walk.length; j++) {
      const q = park.walk[Math.floor(h3(park.key * 1e6, j, 5) * park.walk.length)]
      person(q % w, (q / w) | 0, h3(park.key * 1e6, j, 6) * 0.9)
    }
  }

  /** A small park tree: trunk and a canopy lit from the south (screen right). */
  function parkTree(x: number, y: number, r: number) {
    const rx = 5 + Math.floor(r * 3)
    const ry = rx - 1
    const lift = 9 + Math.floor(r * 4)
    const cx = x
    const cy = y - lift
    const pix = new Map<number, number>()
    for (let t = 0; t < lift - ry + 2; t++) {
      const q = at(Math.floor(x), Math.floor(y) - t)
      if (q < 0) return
      pix.set(q, pack(TRUNK))
    }
    for (let yy = Math.floor(cy - ry); yy <= Math.ceil(cy + ry); yy++)
      for (let xx = Math.floor(cx - rx); xx <= Math.ceil(cx + rx); xx++) {
        const dx = (xx + 0.5 - cx) / rx
        const dy = (yy + 0.5 - cy) / ry
        if (dx * dx + dy * dy > 1) continue
        const q = at(xx, yy)
        if (q < 0) return
        const lit = dx - dy * 0.8 + (h3(xx + c.x0, yy + c.y0, 7) - 0.5) * 0.5
        pix.set(q, pack(CANOPY[lit > 0.55 ? 2 : lit < -0.45 ? 0 : 1]))
      }
    if (!free(pix.keys())) return
    const [sx, sy] = proj(SHADOW_VEC[0] * lift * 0.2, SHADOW_VEC[1] * lift * 0.2, 0)
    const shadow: number[] = []
    for (let yy = -3; yy <= 3; yy++)
      for (let xx = -rx; xx <= rx; xx++) {
        if ((xx / rx) ** 2 + (yy / 3.5) ** 2 > 1) continue
        const q = at(Math.floor(x + sx + xx), Math.floor(y + sy + yy))
        if (q >= 0) shadow.push(q)
      }
    commit({ foot: y, pix, shadow })
  }

  // ---- vehicles and lamps share road sampling: one 32 px (8 m) cell at a time
  const lamps: number[][] = []
  for (let gy = 0; gy < h; gy += 32)
    for (let gx = 0; gx < w; gx += 32) {
      const cx = (c.x0 + gx) >> 5
      const cy = (c.y0 + gy) >> 5
      for (let attempt = 0; attempt < 4; attempt++) {
        const r = h3(cx, cy, 100 + attempt)
        const isLamp = attempt >= 2
        if (r > (isLamp ? 0.7 : attempt === 0 ? 0.45 : 0.22)) continue
        const x = gx + Math.floor(h3(cx, cy, 200 + attempt) * 32)
        const y = gy + Math.floor(h3(cx, cy, 300 + attempt) * 32)
        if (x >= w || y >= h || cls[y * w + x] !== Surface.Road) continue
        const u = roadDir(x, y) ?? roadDir(x, y, 18) // wide roads: look further for an edge
        const span = u && roadSpan(x, y, u)
        if (!u || !span) continue
        const width = span[0] + span[1]
        const p = [-u[1], u[0]]
        const centre = (span[1] - span[0]) / 2
        const side = h3(cx, cy, 400 + attempt) < 0.5 ? 1 : -1
        const base = [x + 0.5, y + 0.5]
        if (isLamp) {
          if (width >= 6) lamp(base, p, side > 0 ? span[1] : -span[0], side)
        } else if (width >= 3.2) {
          const lane = width >= 5.5 ? (side * width) / 4 : 0
          const heading = side > 0 ? u : [-u[0], -u[1]] // India drives on the left
          const r2 = h3(cx, cy, 500 + attempt)
          const kind = vehicle(r2, width, CAR_COLOURS[Math.floor(h3(cx, cy, 600 + attempt) * CAR_COLOURS.length)], SHIRTS[Math.floor(r2 * 97) % SHIRTS.length])
          drive(base, [p[0] * (centre + lane), p[1] * (centre + lane)], heading, kind)
        }
      }
    }

  function drive(base: number[], off: number[], hd: number[], vh: Vehicle) {
    const q = [-hd[1], hd[0]]
    const scr = (a: number, b: number, z: number) => {
      const [sx, sy] = proj(off[0] + hd[0] * a + q[0] * b, off[1] + hd[1] * a + q[1] * b, z)
      return [base[0] + sx, base[1] + sy]
    }
    const pix = new Map<number, number>()
    const tmp: number[] = []
    const fill = (pts: number[][], col: number) => {
      tmp.length = 0
      if (!polygon(pts, w, h, tmp)) return false
      for (const t of tmp) pix.set(t, col)
      return true
    }
    // Ground footprint: must be open, unclaimed road.
    const L = vh.len / 2
    const W = vh.wid / 2
    const foot: number[] = []
    if (!polygon([scr(L, -W, 0), scr(L, W, 0), scr(-L, W, 0), scr(-L, -W, 0)], w, h, foot)) return
    if (!foot.every((t) => isRoad(t) && !occ[t])) return
    for (const pt of vh.parts) {
      const a0 = pt.along - pt.len / 2
      const a1 = pt.along + pt.len / 2
      const b = pt.wid / 2
      const ring = [[a1, -b], [a1, b], [a0, b], [a0, -b]] // counter-clockwise in (along, across)
      for (let i = 0; i < 4; i++) {
        const [pa, pb] = [ring[i], ring[(i + 1) % 4]]
        // Outward normal in world (e, n) for this edge.
        const ea = [hd[0] * pa[0] + q[0] * pa[1], hd[1] * pa[0] + q[1] * pa[1]]
        const eb = [hd[0] * pb[0] + q[0] * pb[1], hd[1] * pb[0] + q[1] * pb[1]]
        const de = eb[0] - ea[0]
        const dn = eb[1] - ea[1]
        const ln = Math.hypot(de, dn)
        const ne = dn / ln
        const nn = -de / ln
        if (ne + nn >= 0) continue // faces away from the camera
        const tn = tone(ne, nn)
        if (!fill([scr(pa[0], pa[1], pt.z0), scr(pb[0], pb[1], pt.z0), scr(pb[0], pb[1], pt.z1), scr(pa[0], pa[1], pt.z1)], pack(pt.side.map((cv, j) => cv * tn[j])))) return
      }
      if (!fill(ring.map(([a, b2]) => scr(a, b2, pt.z1)), pack(pt.top))) return
    }
    if (vh.lights) {
      const front = hd[0] + hd[1] < 0 // the front face is the one we see
      const a = front ? L - 0.05 : -L + 0.05
      for (const b of [-W + 0.3, W - 0.3]) {
        const [lx, ly] = scr(a, b, 0.55)
        const t = Math.floor(ly) * w + Math.floor(lx)
        if (pix.has(t)) pix.set(t, pack(front ? HEADLIGHT : TAILLIGHT))
      }
    }
    if (!free(pix.keys())) return
    const top = Math.max(...vh.parts.map((pt) => pt.z1))
    const shadow = sweep(foot, SHADOW_VEC[0] * top, SHADOW_VEC[1] * top, [scr(L, -W, 0), scr(L, W, 0), scr(-L, W, 0), scr(-L, -W, 0)])
    commit({ foot: base[1] + proj(off[0], off[1], 0)[1], pix, shadow })
  }

  /** Pixels of a ground polygon dragged along a shadow vector (m). */
  function sweep(start: number[], se: number, sn: number, pts: number[][]): number[] {
    const out = new Set(start)
    const tmp: number[] = []
    for (const t of [0.33, 0.66, 1]) {
      const [sx, sy] = proj(se * t, sn * t, 0)
      tmp.length = 0
      polygon(pts.map(([x, y]) => [x + sx, y + sy]), w, h, tmp)
      for (const q of tmp) out.add(q)
    }
    return [...out]
  }

  function lamp(base: number[], p: number[], edge: number, side: number) {
    const s = edge + side * 0.8 // just off the road
    const [bx0, by0] = proj(p[0] * s, p[1] * s, 0)
    const bx = Math.floor(base[0] + bx0)
    const by = Math.floor(base[1] + by0)
    const b = at(bx, by)
    if (b < 0 || !GROUND_LEVEL.has(cls[b]) || isRoad(b)) return
    if (lamps.some(([x, y]) => Math.hypot(x - bx, (y - by) * 2) < 60)) return
    const H = 8
    const arm = 1.6
    const [hx0, hy0] = proj(p[0] * (s - side * arm), p[1] * (s - side * arm), H)
    const [gx0, gy0] = proj(p[0] * (s - side * arm), p[1] * (s - side * arm), 0)
    const head = [base[0] + hx0, base[1] + hy0]
    const glow = { x: base[0] + gx0, y: base[1] + gy0, rx: Math.SQRT2 * GLOW_R * k, ry: (Math.SQRT2 / 2) * GLOW_R * k }
    if (glow.x - glow.rx < 0 || glow.x + glow.rx >= w || glow.y - glow.ry < 0 || glow.y + glow.ry >= h) return
    const pix = new Map<number, number>()
    const top = Math.round(by - H * v)
    for (let y = by; y >= top; y--) {
      const t = at(bx, y)
      if (t < 0) return
      pix.set(t, pack(POLE))
    }
    // Arm from the pole top to the lamp head, then the head itself.
    const n = Math.ceil(Math.hypot(head[0] - bx, head[1] - top))
    for (let i = 1; i <= n; i++) {
      const t = at(Math.floor(bx + 0.5 + ((head[0] - bx - 0.5) * i) / n), Math.floor(top + 0.5 + ((head[1] - top - 0.5) * i) / n))
      if (t < 0) return
      pix.set(t, pack(POLE))
    }
    const hq = at(Math.floor(head[0]), Math.floor(head[1]) + 1)
    if (hq < 0) return
    pix.set(hq, pack(LAMP))
    if (!free(pix.keys())) return
    lamps.push([bx, by])
    const shadow: number[] = []
    const [sx, sy] = proj(SHADOW_VEC[0] * H, SHADOW_VEC[1] * H, 0)
    for (let i = 1, m = Math.ceil(Math.hypot(sx, sy)); i <= m; i++) {
      const t = at(Math.floor(bx + 0.5 + (sx * i) / m), Math.floor(by + 0.5 + (sy * i) / m))
      if (t >= 0) shadow.push(t)
    }
    commit({ foot: by, pix, shadow, glow })
  }

  // ---- people: 32 px cells, up to 3 tries, more likely on footways and beside roads
  for (let gy = 0; gy < h; gy += 32)
    for (let gx = 0; gx < w; gx += 32) {
      const cx = (c.x0 + gx) >> 5
      const cy = (c.y0 + gy) >> 5
      for (let attempt = 0; attempt < 3; attempt++) {
        const x = gx + Math.floor(h3(cx, cy, 700 + attempt) * 32)
        const y = gy + Math.floor(h3(cx, cy, 800 + attempt) * 32)
        const q = at(x, y)
        if (q < 0) continue
        const sf = cls[q]
        const nearRoad = isRoad(at(x - 5, y)) || isRoad(at(x + 6, y)) || isRoad(at(x, y - 3)) || isRoad(at(x, y + 3))
        const chance = sf === Surface.Path ? 0.55 : sf === Surface.Lot ? 0.3 : sf === Surface.Edge ? 0.3 : sf === Surface.Road || sf === Surface.Mark ? 0.03
          : sf === Surface.Veg ? 0.06 : sf === Surface.Ground ? (nearRoad ? 0.3 : 0.004) : 0
        const r = h3(cx, cy, 900 + attempt)
        if (r > chance) continue
        person(x, y, h3(cx, cy, 1000 + attempt))
        if (r < chance * 0.3) person(x + 3, y + (r < chance * 0.15 ? 1 : 0), h3(cx, cy, 1100 + attempt)) // a companion
      }
    }

  /** A 2 px wide figure standing (or sitting, on equipment) with its feet at (x, y). */
  function person(x: number, y: number, r: number, o: { kid?: boolean; seated?: boolean; foot?: number } = {}) {
    const child = o.kid || r > 0.9
    const rows = (child ? 6 : 8) - (o.seated ? 2 : 0)
    const sari = !o.kid && r < 0.3
    const shirt = o.kid ? KIDS[Math.floor(r * 1000) % KIDS.length] : sari ? SARIS[Math.floor(r * 1000) % SARIS.length] : SHIRTS[Math.floor(r * 1000) % SHIRTS.length]
    const pants = sari ? shirt : PANTS[Math.floor(r * 777) % PANTS.length]
    const skin = SKIN[Math.floor(r * 555) % SKIN.length]
    const legs = o.seated ? 1 : child ? 2 : 3
    const pix = new Map<number, number>()
    for (const [dx, f] of [[0, 0.8], [1, 1]]) {
      // Left column in shade, right column lit (the sun is to the south, screen right).
      const fq = at(x + dx, y)
      if (fq < 0 || (!o.seated && !GROUND_LEVEL.has(cls[fq]))) return
      for (let i = 0; i < rows; i++) {
        const t = at(x + dx, y - i)
        if (t < 0) return
        const col = i === rows - 1 ? HAIR : i === rows - 2 ? skin : i < legs ? pants : shirt
        pix.set(t, pack(col.map((cv) => cv * (i >= rows - 2 ? 1 : f))))
      }
    }
    if (o.seated) return commit({ foot: o.foot ?? y, pix, shadow: [] }, false)
    if (!free(pix.keys())) return
    const hgt = child ? 1.2 : 1.7
    const [sx, sy] = proj(SHADOW_VEC[0] * hgt, SHADOW_VEC[1] * hgt, 0)
    const shadow: number[] = []
    for (let i = 1, m = Math.ceil(Math.hypot(sx, sy)); i <= m; i++) {
      for (const dx of [0, 1]) {
        const t = at(Math.floor(x + dx + 0.5 + (sx * i) / m), Math.floor(y + 0.5 + (sy * i) / m))
        if (t >= 0) shadow.push(t)
      }
    }
    commit({ foot: y, pix, shadow })
  }

  // ---- draw: shadows on open ground, then lamp light, then the sprites far to near
  const { px, shade } = c
  const shaded = new Uint8Array(w * h)
  for (const sp of sprites)
    for (const q of sp.shadow) {
      if (shaded[q] || shade[q] || occ[q] || !GROUND_LEVEL.has(cls[q])) continue
      shaded[q] = 1
      const p = q * 4
      px[p] = px[p] * DUSK_SHADOW[0]
      px[p + 1] = px[p + 1] * DUSK_SHADOW[1]
      px[p + 2] = px[p + 2] * DUSK_SHADOW[2]
    }
  for (const sp of sprites) {
    const g = sp.glow
    if (!g) continue
    for (let y = Math.floor(g.y - g.ry); y <= Math.ceil(g.y + g.ry); y++)
      for (let x = Math.floor(g.x - g.rx); x <= Math.ceil(g.x + g.rx); x++) {
        const q = y * w + x
        if (!GROUND_LEVEL.has(cls[q])) continue
        const d = ((x + 0.5 - g.x) / g.rx) ** 2 + ((y + 0.5 - g.y) / g.ry) ** 2
        if (d >= 1) continue
        // Three flat light bands, dithered into each other: pixel-art light, not a gradient.
        const level = Math.floor((1 - d) ** 1.5 * 3 + bayer(c.x0 + x, c.y0 + y) * 0.999) / 3
        if (level <= 0) continue
        const p = q * 4
        const a = 0.45 * level
        px[p] = clamp(px[p] * (1 + a * GLOW[0]))
        px[p + 1] = clamp(px[p + 1] * (1 + a * GLOW[1]))
        px[p + 2] = clamp(px[p + 2] * (1 + a * GLOW[2]))
      }
  }
  sprites.sort((a, b) => a.foot - b.foot)
  for (const sp of sprites)
    for (const [q, col] of sp.pix) {
      if (cls[q] === Surface.Tree) continue // behind a canopy
      const p = q * 4
      px[p] = col >> 16
      px[p + 1] = (col >> 8) & 255
      px[p + 2] = col & 255
    }
}
