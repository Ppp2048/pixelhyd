/// <reference lib="webworker" />
/**
 * Dusk look worker: decodes one art tile, grades and textures it, and hands back an
 * ImageBitmap, so the map's main thread never does per-pixel work.
 */
import { applyDusk, TEXTURE_MIN_ZOOM } from './duskCore'
import { warm } from './duskPalette'

export interface DuskJob {
  id: number
  data: ArrayBuffer
  z: number
  x: number
  y: number
  maxZoom: number
  /** Art projection: px per metre along screen x and per metre of height. */
  k: number
  v: number
}
export type DuskResult = { id: number; bitmap: ImageBitmap; ms: number } | { id: number; error: string }

self.onmessage = async (ev: MessageEvent<DuskJob | 'warm'>) => {
  if (ev.data === 'warm') return warm() // build colour tables and textures before the first tile
  const { id, data, z, x, y, maxZoom, k, v } = ev.data
  const t0 = performance.now()
  try {
    const bmp = await createImageBitmap(new Blob([data]))
    const { width, height } = bmp
    const ctx = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true })!
    ctx.drawImage(bmp, 0, 0)
    bmp.close()
    const img = ctx.getImageData(0, 0, width, height)
    const step = 2 ** Math.max(0, maxZoom - z)
    applyDusk(img.data, width, height, x * width * step, y * height * step, step, z >= TEXTURE_MIN_ZOOM, { k, v })
    const bitmap = await createImageBitmap(img)
    ;(self as unknown as DedicatedWorkerGlobalScope).postMessage({ id, bitmap, ms: performance.now() - t0 } satisfies DuskResult, [bitmap])
  } catch (e) {
    ;(self as unknown as DedicatedWorkerGlobalScope).postMessage({ id, error: String(e) } satisfies DuskResult)
  }
}
