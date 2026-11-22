/**
 * A PMTiles byte source for hosts that cannot answer HTTP range requests.
 *
 * Cloudflare Pages answers a range request with the whole file, so the deploy build cuts each
 * .pmtiles archive into fixed-size chunk files (pipeline: `hitec-pipeline deploy`). This source
 * reads any byte range by fetching the whole chunks that cover it and slicing out the bytes asked
 * for. The chunks of an archive, joined in order, are the archive byte for byte, so the PMTiles
 * reader works unchanged on top of it.
 */
import type { RangeResponse, Source } from 'pmtiles'

/** How one archive is cut: its size, the chunk size, and where chunk `i` is published. */
export interface ChunkLayout {
  size: number
  chunk: number
  url: (index: number) => string
}

/** The chunks covering bytes [offset, offset + length), clipped to the archive; null if none. */
export function chunkSpan(offset: number, length: number, size: number, chunk: number) {
  const start = Math.max(0, offset)
  const end = Math.min(size, offset + length)
  if (end <= start) return null
  return { first: Math.floor(start / chunk), last: Math.floor((end - 1) / chunk), start, end }
}

/** Bytes in chunk `index`: a full chunk, or what is left for the last one. */
export const chunkLength = (index: number, size: number, chunk: number) => Math.min(chunk, size - index * chunk)

/** Copy bytes [start, end) of the archive out of consecutive chunks beginning at chunk `first`. */
export function sliceChunks(parts: Uint8Array[], first: number, chunk: number, start: number, end: number): ArrayBuffer {
  const out = new Uint8Array(end - start)
  let pos = 0
  parts.forEach((part, k) => {
    const base = (first + k) * chunk
    const from = Math.max(start, base) - base
    const to = Math.min(end, base + part.byteLength) - base
    if (to > from) {
      out.set(part.subarray(from, to), pos)
      pos += to - from
    }
  })
  if (pos !== out.byteLength) throw new Error(`Chunks cover ${pos} of ${out.byteLength} requested bytes`)
  return out.buffer
}

const abortError = (signal: AbortSignal) => signal.reason ?? new DOMException('Aborted', 'AbortError')

/** A chunk being downloaded, shared by every read that needs it. */
interface Pending {
  promise: Promise<Uint8Array>
  controller: AbortController
  /** Reads still waiting; the download is cancelled when the last of them is aborted. */
  waiting: number
}

export class ChunkedSource implements Source {
  readonly key: string
  readonly layout: ChunkLayout
  private readonly cacheLimit: number
  private readonly fetcher: typeof fetch
  /** Recently used chunks, oldest first (a Map keeps insertion order). */
  private readonly cache = new Map<number, Uint8Array>()
  private cachedBytes = 0
  private readonly pending = new Map<number, Pending>()

  /**
   * @param key the archive's absolute URL; the PMTiles protocol finds this source by it, so it must
   *   match the URL in the map style (`pmtiles://<key>`).
   * @param cacheBytes how many bytes of chunks to keep in memory for reuse (default 48 MB).
   */
  constructor(key: string, layout: ChunkLayout, options: { cacheBytes?: number; fetch?: typeof fetch } = {}) {
    this.key = key
    this.layout = layout
    this.cacheLimit = options.cacheBytes ?? 48 * 1024 * 1024
    this.fetcher = options.fetch ?? ((input, init) => fetch(input, init))
  }

  getKey() {
    return this.key
  }

  async getBytes(offset: number, length: number, signal?: AbortSignal): Promise<RangeResponse> {
    const { size, chunk } = this.layout
    const span = chunkSpan(offset, length, size, chunk)
    if (!span) return { data: new ArrayBuffer(0) }
    const reads = []
    for (let i = span.first; i <= span.last; i++) reads.push(this.read(i, signal))
    const parts = await Promise.all(reads)
    signal?.throwIfAborted()
    return { data: sliceChunks(parts, span.first, chunk, span.start, span.end) }
  }

  /** Chunk `index`, from memory, from a download already under way, or from a new download. */
  private read(index: number, signal?: AbortSignal): Promise<Uint8Array> {
    const hit = this.cache.get(index)
    if (hit) {
      this.cache.delete(index) // move to the newest end
      this.cache.set(index, hit)
      return Promise.resolve(hit)
    }
    let entry = this.pending.get(index)
    if (!entry) {
      const controller = new AbortController()
      const created: Pending = {
        controller,
        waiting: 0,
        promise: this.download(index, controller.signal).then(
          (bytes) => {
            if (this.pending.get(index) === created) this.pending.delete(index)
            this.remember(index, bytes)
            return bytes
          },
          (error) => {
            if (this.pending.get(index) === created) this.pending.delete(index)
            throw error
          },
        ),
      }
      this.pending.set(index, created)
      entry = created
    }
    return this.wait(index, entry, signal)
  }

  /** Wait for a shared download; aborting `signal` stops this wait, and the download once nobody waits. */
  private wait(index: number, entry: Pending, signal?: AbortSignal): Promise<Uint8Array> {
    entry.waiting++
    if (!signal) return entry.promise
    const release = () => {
      if (--entry.waiting <= 0 && this.pending.get(index) === entry) {
        this.pending.delete(index)
        entry.controller.abort()
      }
    }
    if (signal.aborted) {
      release()
      return Promise.reject(abortError(signal))
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        release()
        reject(abortError(signal))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      entry.promise.then(
        (bytes) => {
          signal.removeEventListener('abort', onAbort)
          resolve(bytes)
        },
        (error) => {
          signal.removeEventListener('abort', onAbort)
          reject(error)
        },
      )
    })
  }

  private async download(index: number, signal: AbortSignal): Promise<Uint8Array> {
    const url = this.layout.url(index)
    const response = await this.fetcher(url, { signal })
    if (!response.ok) throw new Error(`Tile chunk ${url}: HTTP ${response.status}`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    // A host that does not have the file may answer with the app's index.html instead of a 404.
    const expected = chunkLength(index, this.layout.size, this.layout.chunk)
    if (bytes.byteLength !== expected) throw new Error(`Tile chunk ${url}: ${bytes.byteLength} bytes, expected ${expected}`)
    return bytes
  }

  private remember(index: number, bytes: Uint8Array) {
    if (this.cache.has(index)) return
    this.cache.set(index, bytes)
    this.cachedBytes += bytes.byteLength
    for (const [old, data] of this.cache) {
      if (this.cachedBytes <= this.cacheLimit || old === index) break
      this.cache.delete(old)
      this.cachedBytes -= data.byteLength
    }
  }
}
