import { describe, expect, test } from 'vitest'
import { applyDusk } from './duskCore'

const W = 256
const SCALE = { k: 4, v: 4 * Math.sqrt(1.5) }
const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))

/** A synthetic art tile: dusty ground with a 12 m asphalt road running east (screen slope −1/2). */
function roadTile(): Uint8ClampedArray {
  const px = new Uint8ClampedArray(W * W * 4)
  const [ground, asphalt, edge] = [hex('#d8c9a8'), hex('#5d6168'), hex('#43464c')]
  for (let y = 0; y < W; y++)
    for (let x = 0; x < W; x++) {
      const d = Math.abs(y - (200 - x / 2)) * (2 / Math.sqrt(5)) // px across the road
      const c = d < 22 ? asphalt : d < 24 ? edge : ground
      px.set([...c, 255], (y * W + x) * 4)
    }
  return px
}

describe('dusk look', () => {
  test('maps exact palette colours and keeps transparency', () => {
    const px = new Uint8ClampedArray([0xd8, 0xc9, 0xa8, 255, 1, 2, 3, 0])
    applyDusk(px, 2, 1, 0, 0, 1, false)
    expect([...px.slice(0, 3)]).toEqual(hex('#8f7a5a'))
    expect([...px.slice(4)]).toEqual([1, 2, 3, 0])
  })

  // This test builds the street-life tables and paints three tiles (≈1.2 s alone). Under heavy CPU
  // load (e.g. the pipeline's tests running at the same time) it exceeded vitest's 5 s default and
  // was reported as a failure at this line, so it gets a budget that fits a busy laptop.
  test('street life is deterministic for a place and drawn only at native zoom', { timeout: 30_000 }, () => {
    const a = roadTile()
    const b = roadTile()
    const plain = roadTile()
    applyDusk(a, W, W, 512 * W, 512 * W, 1, true, SCALE)
    applyDusk(b, W, W, 512 * W, 512 * W, 1, true, SCALE)
    applyDusk(plain, W, W, 512 * W, 512 * W, 1, true) // no projection scale: no life
    expect(a).toEqual(b)
    const changed = a.reduce((n, v, i) => n + (v !== plain[i] ? 1 : 0), 0)
    expect(changed).toBeGreaterThan(200) // vehicles, people, lamps and their shadows
  })

  test('airside paving gets its dusk colour and no street life', { timeout: 30_000 }, () => {
    // Left half runway with a centreline stripe, right half apron, a taxiway band at the bottom.
    const [runway, stripe, apron, taxiway] = ['#575b61', '#e6e3da', '#aaa79f', '#676b70'].map(hex)
    const tile = () => {
      const px = new Uint8ClampedArray(W * W * 4)
      for (let y = 0; y < W; y++)
        for (let x = 0; x < W; x++) {
          const c = y >= 200 ? taxiway : x >= 128 ? apron : y >= 60 && y < 63 ? stripe : runway
          px.set([...c, 255], (y * W + x) * 4)
        }
      return px
    }
    const lively = tile()
    const plain = tile()
    applyDusk(lively, W, W, 512 * W, 512 * W, 1, true, SCALE)
    applyDusk(plain, W, W, 512 * W, 512 * W, 1, true)
    expect(lively).toEqual(plain) // no cars, people or lamps on a runway or apron
    const at = (x: number, y: number) => [...lively.slice((y * W + x) * 4, (y * W + x) * 4 + 3)]
    expect(at(10, 10)).toEqual(hex('#363a42'))
    expect(at(10, 61)).toEqual(hex('#bdb8aa'))
    expect(at(200, 10)).toEqual(hex('#5e5d58'))
    expect(at(10, 230)).toEqual(hex('#41454d'))
  })

  test('some, not all, small open plots between buildings become parks', () => {
    // Walls all round, with a 60 × 60 px open plot in the middle.
    const plot = () => {
      const px = new Uint8ClampedArray(W * W * 4)
      const [wall, ground] = [hex('#e9dcc4'), hex('#d8c9a8')]
      for (let y = 0; y < W; y++)
        for (let x = 0; x < W; x++) px.set([...(x >= 98 && x < 158 && y >= 98 && y < 158 ? ground : wall), 255], (y * W + x) * 4)
      return px
    }
    const green = (px: Uint8ClampedArray) => {
      let n = 0
      for (let i = 0; i < px.length; i += 4) if (px[i + 1] > px[i] + 30 && px[i + 1] > px[i + 2] + 30) n++
      return n
    }
    const parks = Array.from({ length: 24 }, (_, i) => {
      const px = plot()
      applyDusk(px, W, W, (600 + i) * W, 600 * W, 1, true, SCALE)
      return green(px) > 1000
    })
    expect(parks.some(Boolean)).toBe(true)
    expect(parks.every(Boolean)).toBe(false)
  })
})
