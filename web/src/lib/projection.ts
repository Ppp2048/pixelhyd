/**
 * Coordinate maths shared with the Python pipeline (pipeline/src/hitec_pipeline/iso.py).
 *
 * WGS84 lat/lon ⇄ UTM 44N metres ⇄ isometric art pixels ⇄ image-space lon/lat.
 * The art is displayed by MapLibre (Web Mercator only), so art pixels are placed
 * in a tiny Mercator patch at lon 0 / lat 0; "image-space" lon/lat are those
 * placement coordinates, not real geography.
 */

export interface ProjectionMeta {
  k: number
  v: number
  e0: number
  n0: number
  ox: number
  oy: number
  width: number
  height: number
  zmax: number
  tile: number
  origin_world: number
  utm_epsg: number
}

// ---------------------------------------------------------------- UTM (WGS84, Krüger series)
const A = 6378137
const F = 1 / 298.257223563
const K0 = 0.9996
const E2 = F * (2 - F)
const EP2 = E2 / (1 - E2)
const ZONE = 44
const LON0 = ((ZONE - 1) * 6 - 180 + 3) * (Math.PI / 180)

export function wgsToUtm(lon: number, lat: number): [number, number] {
  const phi = (lat * Math.PI) / 180
  const lam = (lon * Math.PI) / 180
  const sin = Math.sin(phi)
  const cos = Math.cos(phi)
  const tan = Math.tan(phi)
  const N = A / Math.sqrt(1 - E2 * sin * sin)
  const T = tan * tan
  const C = EP2 * cos * cos
  const Aa = cos * (lam - LON0)
  const M =
    A *
    ((1 - E2 / 4 - (3 * E2 ** 2) / 64 - (5 * E2 ** 3) / 256) * phi -
      ((3 * E2) / 8 + (3 * E2 ** 2) / 32 + (45 * E2 ** 3) / 1024) * Math.sin(2 * phi) +
      ((15 * E2 ** 2) / 256 + (45 * E2 ** 3) / 1024) * Math.sin(4 * phi) -
      ((35 * E2 ** 3) / 3072) * Math.sin(6 * phi))
  const e =
    K0 * N * (Aa + ((1 - T + C) * Aa ** 3) / 6 + ((5 - 18 * T + T * T + 72 * C - 58 * EP2) * Aa ** 5) / 120) + 500000
  const n =
    K0 *
    (M +
      N *
        tan *
        ((Aa * Aa) / 2 +
          ((5 - T + 9 * C + 4 * C * C) * Aa ** 4) / 24 +
          ((61 - 58 * T + T * T + 600 * C - 330 * EP2) * Aa ** 6) / 720))
  return [e, n]
}

export function utmToWgs(e: number, n: number): [number, number] {
  const x = e - 500000
  const M = n / K0
  const mu = M / (A * (1 - E2 / 4 - (3 * E2 ** 2) / 64 - (5 * E2 ** 3) / 256))
  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2))
  const phi1 =
    mu +
    ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) +
    ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu)
  const sin = Math.sin(phi1)
  const cos = Math.cos(phi1)
  const tan = Math.tan(phi1)
  const C1 = EP2 * cos * cos
  const T1 = tan * tan
  const N1 = A / Math.sqrt(1 - E2 * sin * sin)
  const R1 = (A * (1 - E2)) / (1 - E2 * sin * sin) ** 1.5
  const D = x / (N1 * K0)
  const phi =
    phi1 -
    ((N1 * tan) / R1) *
      ((D * D) / 2 -
        ((5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * EP2) * D ** 4) / 24 +
        ((61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * EP2 - 3 * C1 * C1) * D ** 6) / 720)
  const lam =
    LON0 +
    (D - ((1 + 2 * T1 + C1) * D ** 3) / 6 + ((5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * EP2 + 24 * T1 * T1) * D ** 5) / 120) /
      cos
  return [(lam * 180) / Math.PI, (phi * 180) / Math.PI]
}

// ---------------------------------------------------------------- ground ⇄ art pixels
export function groundToArt(p: ProjectionMeta, e: number, n: number, z = 0): [number, number] {
  const de = e - p.e0
  const dn = n - p.n0
  return [p.k * (de - dn) + p.ox, -(p.k / 2) * (de + dn) - p.v * z + p.oy]
}

/** Inverse at ground level (z = 0). */
export function artToGround(p: ProjectionMeta, x: number, y: number): [number, number] {
  const a = (x - p.ox) / p.k
  const b = (-2 * (y - p.oy)) / p.k
  return [(a + b) / 2 + p.e0, (b - a) / 2 + p.n0]
}

// ---------------------------------------------------------------- art pixels ⇄ image-space lon/lat
const world = (p: ProjectionMeta) => p.tile * 2 ** p.zmax

export function artToLngLat(p: ProjectionMeta, x: number, y: number): [number, number] {
  const W = world(p)
  const wx = p.origin_world + x
  const wy = p.origin_world + y
  const lon = (wx / W) * 360 - 180
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * wy) / W))) * 180) / Math.PI
  return [lon, lat]
}

export function lngLatToArt(p: ProjectionMeta, lon: number, lat: number): [number, number] {
  const W = world(p)
  const s = Math.sin((lat * Math.PI) / 180)
  const wx = ((lon + 180) / 360) * W
  const wy = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * W
  return [wx - p.origin_world, wy - p.origin_world]
}

// ---------------------------------------------------------------- composites
export function realToImage(p: ProjectionMeta, lon: number, lat: number): [number, number] {
  const [e, n] = wgsToUtm(lon, lat)
  const [x, y] = groundToArt(p, e, n)
  return artToLngLat(p, x, y)
}

export function imageToReal(p: ProjectionMeta, lon: number, lat: number): [number, number] {
  const [x, y] = lngLatToArt(p, lon, lat)
  const [e, n] = artToGround(p, x, y)
  return utmToWgs(e, n)
}

/** MapLibre zoom at which one art pixel equals one CSS pixel (raster tileSize 256 → world 512·2^z). */
export const nativeZoom = (p: ProjectionMeta) => p.zmax - 1

/**
 * Ground point under a building drawn as a silhouette (footprint at ground level joined to its roof):
 * the middle of the silhouette's art-pixel box, lowered by half the roof's rise. [lon, lat]
 */
export function silhouetteGround(p: ProjectionMeta, box: [number, number, number, number], height: number): [number, number] {
  const [x0, y0, x1, y1] = box
  const [e, n] = artToGround(p, (x0 + x1) / 2, (y0 + y1) / 2 + (p.v * height) / 2)
  return utmToWgs(e, n)
}
