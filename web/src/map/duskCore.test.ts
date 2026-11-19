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

  test('street life is deterministic for a place and drawn only at native zoom', () => {
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
})
