/**
 * Dusk look (the default), the MapLibre side: a `dusk://` protocol that serves the same art
 * archive as `pmtiles://`, with each tile graded and textured in a small pool of web
 * workers (see duskCore.ts for what is done to the pixels).
 */
import type { addProtocol } from 'maplibre-gl'
import type { Protocol } from 'pmtiles'
import type { DuskJob, DuskResult } from './duskWorker'

export const DUSK = 'dusk'
const TILE = /\/(\d+)\/(\d+)\/(\d+)$/
let art = { maxZoom: 20, k: 4, v: 4 * Math.sqrt(1.5) }
/** The art archive's native zoom (textures are anchored to its pixels) and projection scale. */
export const setArtGeometry = (maxZoom: number, k: number, v: number) => {
  art = { maxZoom, k, v }
}

// Worker pool: each worker builds its colour tables and textures once, then reuses them.
const POOL = Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 4) / 2)))
let workers: Worker[] = []
let next = 0
let lastId = 0
const pending = new Map<number, { resolve: (r: DuskResult) => void }>()
/** Worker time per tile (ms) of the last 200 tiles, for checking the cost: window.__duskMs. */
const timings: number[] = []

function pool(): Worker[] {
  if (workers.length) return workers
  workers = Array.from({ length: POOL }, () => {
    const w = new Worker(new URL('./duskWorker.ts', import.meta.url), { type: 'module' })
    w.onmessage = (ev: MessageEvent<DuskResult>) => {
      pending.get(ev.data.id)?.resolve(ev.data)
      pending.delete(ev.data.id)
    }
    w.postMessage('warm')
    return w
  })
  return workers
}

function process(job: Omit<DuskJob, 'id'>): Promise<DuskResult> {
  const id = ++lastId
  const w = pool()[next++ % POOL]
  return new Promise((resolve) => {
    pending.set(id, { resolve })
    w.postMessage({ ...job, id } satisfies DuskJob, [job.data])
  })
}

type Handler = Parameters<typeof addProtocol>[1]
type Response = Awaited<ReturnType<Handler>>

/** `dusk://…pmtiles` serves the same archive as `pmtiles://`, graded and textured. */
export function duskProtocol(pm: Protocol): Handler {
  return async (params, abort) => {
    const inner = { ...params, url: params.url.replace(/^dusk:\/\//, 'pmtiles://') }
    const res = await pm.tilev4(inner, abort)
    if (params.type === 'json') {
      const tj = res.data as { tiles: string[] }
      return { ...res, data: { ...tj, tiles: tj.tiles.map((t) => t.replace(/^pmtiles:\/\//, `${DUSK}://`)) } } as Response
    }
    const m = TILE.exec(params.url)
    const bytes = res.data as Uint8Array | null
    if (!m || !bytes || bytes.byteLength === 0) return res as Response
    const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    const out = await process({ data, z: Number(m[1]), x: Number(m[2]), y: Number(m[3]), maxZoom: art.maxZoom, k: art.k, v: art.v })
    if ('error' in out) throw new Error(`dusk tile ${params.url}: ${out.error}`)
    if (abort.signal.aborted) {
      out.bitmap.close()
      throw new DOMException('aborted', 'AbortError')
    }
    timings.push(out.ms)
    if (timings.length > 200) timings.shift()
    ;(window as unknown as { __duskMs: number[] }).__duskMs = timings
    return { data: out.bitmap, cacheControl: res.cacheControl, expires: res.expires }
  }
}
