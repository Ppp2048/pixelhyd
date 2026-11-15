import { describe, expect, it } from 'vitest'
import fixtures from './__fixtures__/utm44n.json'
import {
  artToGround,
  artToLngLat,
  groundToArt,
  imageToReal,
  lngLatToArt,
  realToImage,
  utmToWgs,
  wgsToUtm,
  type ProjectionMeta,
} from './projection'

const meta: ProjectionMeta = {
  k: 4,
  v: 4 * (Math.sqrt(6) / 2),
  e0: 221821.39753848035,
  n0: 1931107.066319207,
  ox: 1008,
  oy: 1272,
  width: 2016,
  height: 1300,
  zmax: 20,
  tile: 256,
  origin_world: 256 * 2 ** 19,
  utm_epsg: 32644,
}

describe('UTM 44N', () => {
  it('matches pyproj within 1 mm (forward)', () => {
    for (const f of fixtures) {
      const [e, n] = wgsToUtm(f.lon, f.lat)
      expect(Math.abs(e - f.e)).toBeLessThan(0.001)
      expect(Math.abs(n - f.n)).toBeLessThan(0.001)
    }
  })
  it('round-trips within 1 cm', () => {
    for (const f of fixtures) {
      const [lon, lat] = utmToWgs(f.e, f.n)
      const [e, n] = wgsToUtm(lon, lat)
      expect(Math.abs(e - f.e)).toBeLessThan(0.01)
      expect(Math.abs(n - f.n)).toBeLessThan(0.01)
    }
  })
})

describe('isometric art space', () => {
  it('uses 2:1 dimetric axes', () => {
    const [x0, y0] = groundToArt(meta, meta.e0, meta.n0)
    const [xe, ye] = groundToArt(meta, meta.e0 + 1, meta.n0)
    expect(xe - x0).toBeCloseTo(4)
    expect(ye - y0).toBeCloseTo(-2)
  })
  it('inverts ground ⇄ art', () => {
    const [x, y] = groundToArt(meta, meta.e0 + 123.4, meta.n0 + 56.7)
    const [e, n] = artToGround(meta, x, y)
    expect(e - meta.e0).toBeCloseTo(123.4, 6)
    expect(n - meta.n0).toBeCloseTo(56.7, 6)
  })
  it('inverts art ⇄ image-space lon/lat', () => {
    const [lon, lat] = artToLngLat(meta, 517.25, 999.5)
    const [x, y] = lngLatToArt(meta, lon, lat)
    expect(x).toBeCloseTo(517.25, 4)
    expect(y).toBeCloseTo(999.5, 4)
  })
  it('round-trips real → image → real within 1 cm', () => {
    const [ilon, ilat] = realToImage(meta, 78.3822, 17.4499)
    const [lon, lat] = imageToReal(meta, ilon, ilat)
    const [e1, n1] = wgsToUtm(78.3822, 17.4499)
    const [e2, n2] = wgsToUtm(lon, lat)
    expect(Math.hypot(e1 - e2, n1 - n2)).toBeLessThan(0.01)
  })
})
