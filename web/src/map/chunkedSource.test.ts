import { describe, expect, test } from 'vitest'
import { PMTiles } from 'pmtiles'
import { ChunkedSource, chunkLength, chunkSpan, sliceChunks } from './chunkedSource'

/** An archive of `size` bytes (byte i = i mod 251) cut into `chunk`-byte files, served by a fake fetch. */
function host(size: number, chunk: number, archive?: Uint8Array) {
  const bytes = archive ?? Uint8Array.from({ length: size }, (_, i) => i % 251)
  const requests: string[] = []
  const gates = new Map<string, () => void>()
  const options = {
    /** When set, downloads wait until `release(url)` is called. */
    hold: false,
    /** Override the body served for a URL (for example an HTML fallback page). */
    bodies: new Map<string, Uint8Array>(),
  }
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    requests.push(url)
    if (options.hold) await new Promise<void>((go) => gates.set(url, go))
    init?.signal?.throwIfAborted()
    const i = Number(url.split('/').pop()!.replace('.bin', ''))
    const body = options.bodies.get(url) ?? bytes.slice(i * chunk, Math.min(bytes.length, (i + 1) * chunk))
    if (i * chunk >= bytes.length) return new Response('Not found', { status: 404 })
    return new Response(body.slice()) // a copy with a plain ArrayBuffer, as Response expects
  }
  const layout = { size: bytes.length, chunk, url: (i: number) => `https://example.test/chunks/a/${i}.bin` }
  return { bytes, requests, options, release: (url: string) => gates.get(url)?.(), fetcher: fetcher as typeof fetch, layout }
}

describe('chunk arithmetic', () => {
  test('a span covers exactly the chunks holding the requested bytes, clipped to the archive', () => {
    expect(chunkSpan(0, 10, 25, 10)).toEqual({ first: 0, last: 0, start: 0, end: 10 })
    expect(chunkSpan(9, 2, 25, 10)).toEqual({ first: 0, last: 1, start: 9, end: 11 })
    expect(chunkSpan(20, 16384, 25, 10)).toEqual({ first: 2, last: 2, start: 20, end: 25 })
    expect(chunkSpan(25, 5, 25, 10)).toBeNull()
    expect(chunkSpan(3, 0, 25, 10)).toBeNull()
  })

  test('the last chunk is shorter', () => {
    expect([0, 1, 2].map((i) => chunkLength(i, 25, 10))).toEqual([10, 10, 5])
  })

  test('slicing joins the right bytes across chunk boundaries', () => {
    const parts = [Uint8Array.of(0, 1, 2, 3), Uint8Array.of(4, 5, 6, 7), Uint8Array.of(8, 9)]
    expect([...new Uint8Array(sliceChunks(parts, 0, 4, 2, 9))]).toEqual([2, 3, 4, 5, 6, 7, 8])
    expect([...new Uint8Array(sliceChunks(parts.slice(1), 1, 4, 5, 6))]).toEqual([5])
  })
})

describe('ChunkedSource', () => {
  test('returns any byte range of the archive, without range requests', async () => {
    const h = host(1000, 64)
    const source = new ChunkedSource('https://example.test/a.pmtiles', h.layout, { fetch: h.fetcher })
    for (const [offset, length] of [[0, 16384], [63, 2], [100, 300], [990, 50], [640, 64]]) {
      const { data } = await source.getBytes(offset, length)
      expect(new Uint8Array(data)).toEqual(h.bytes.slice(offset, offset + length))
    }
    expect(source.getKey()).toBe('https://example.test/a.pmtiles')
  })

  test('downloads each chunk once while it stays in memory, and once for reads at the same time', async () => {
    const h = host(1000, 100)
    const source = new ChunkedSource('k', h.layout, { fetch: h.fetcher })
    await Promise.all([source.getBytes(0, 10), source.getBytes(50, 10), source.getBytes(90, 20)])
    await source.getBytes(5, 5)
    expect(h.requests.sort()).toEqual([h.layout.url(0), h.layout.url(1)])
  })

  test('forgets the least recently used chunks beyond its memory limit', async () => {
    const h = host(1000, 100)
    const source = new ChunkedSource('k', h.layout, { fetch: h.fetcher, cacheBytes: 250 })
    for (const offset of [0, 100, 0, 200]) await source.getBytes(offset, 1) // chunk 1 is now the oldest
    h.requests.length = 0
    await source.getBytes(0, 1)
    await source.getBytes(200, 1)
    await source.getBytes(100, 1)
    expect(h.requests).toEqual([h.layout.url(1)])
  })

  test('rejects a file of the wrong length, such as an HTML page served in place of a missing chunk', async () => {
    const h = host(1000, 100)
    h.options.bodies.set(h.layout.url(3), new TextEncoder().encode('<!doctype html><title>app</title>'))
    const source = new ChunkedSource('k', h.layout, { fetch: h.fetcher })
    await expect(source.getBytes(300, 10)).rejects.toThrow(/expected 100/)
  })

  test('reports HTTP errors and tries again on the next read', async () => {
    const h = host(1000, 100)
    let fail = true
    const fetcher: typeof fetch = async (input, init) => (fail ? new Response('', { status: 503 }) : h.fetcher(input, init))
    const source = new ChunkedSource('k', h.layout, { fetch: fetcher })
    await expect(source.getBytes(0, 1)).rejects.toThrow(/HTTP 503/)
    fail = false
    expect(new Uint8Array((await source.getBytes(0, 1)).data)).toEqual(Uint8Array.of(0))
  })

  test('an aborted read stops waiting, and the download stops once no read needs it', async () => {
    const h = host(1000, 100)
    h.options.hold = true
    const source = new ChunkedSource('k', h.layout, { fetch: h.fetcher })
    const first = new AbortController()
    const second = new AbortController()
    const a = source.getBytes(0, 10, first.signal)
    const b = source.getBytes(20, 10, second.signal)
    await Promise.resolve()
    first.abort()
    await expect(a).rejects.toThrow()
    h.release(h.layout.url(0)) // the shared download continues for the second read
    expect(new Uint8Array((await b).data)).toEqual(h.bytes.slice(20, 30))

    const third = new AbortController()
    const c = source.getBytes(500, 10, third.signal)
    await Promise.resolve()
    third.abort()
    await expect(c).rejects.toThrow()
    h.release(h.layout.url(5))
    h.options.hold = false
    expect(new Uint8Array((await source.getBytes(500, 10)).data)).toEqual(h.bytes.slice(500, 510))
    expect(h.requests.filter((u) => u === h.layout.url(5))).toHaveLength(2) // the abandoned download was not kept
  })

  test('the PMTiles reader reads an archive through it', async () => {
    const archive = tinyArchive()
    const h = host(archive.length, 40, archive)
    const pm = new PMTiles(new ChunkedSource('https://example.test/t.pmtiles', h.layout, { fetch: h.fetcher }))
    const header = await pm.getHeader()
    expect([header.minZoom, header.maxZoom, header.numAddressedTiles]).toEqual([0, 0, 1])
    const tile = await pm.getZxy(0, 0, 0)
    expect(new TextDecoder().decode(tile!.data)).toBe('hello tile')
  })
})

/** A valid one-tile PMTiles v3 archive (uncompressed), built by hand so the test needs no fixture file. */
function tinyArchive(): Uint8Array {
  const tile = new TextEncoder().encode('hello tile')
  const metadata = new TextEncoder().encode('{}')
  // Root directory: 1 entry; tile id delta 0, run length 1, length, offset + 1.
  const root = Uint8Array.of(1, 0, 1, tile.length, 1)
  const header = new Uint8Array(127)
  const view = new DataView(header.buffer)
  header.set([0x50, 0x4d, 0x54, 0x69, 0x6c, 0x65, 0x73, 3]) // "PMTiles", version 3
  const u64 = (at: number, n: number) => view.setBigUint64(at, BigInt(n), true)
  const rootAt = 127
  const metaAt = rootAt + root.length
  const dataAt = metaAt + metadata.length
  u64(8, rootAt)
  u64(16, root.length)
  u64(24, metaAt)
  u64(32, metadata.length)
  u64(40, dataAt) // no leaf directories
  u64(48, 0)
  u64(56, dataAt)
  u64(64, tile.length)
  u64(72, 1)
  u64(80, 1)
  u64(88, 1)
  view.setUint8(96, 1) // clustered
  view.setUint8(97, 1) // internal compression: none
  view.setUint8(98, 1) // tile compression: none
  view.setUint8(99, 1) // tile type: MVT
  view.setUint8(100, 0) // min zoom
  view.setUint8(101, 0) // max zoom
  view.setInt32(110, 1800000000, true) // max lon 180
  view.setInt32(114, 850000000, true) // max lat 85
  view.setInt32(102, -1800000000, true)
  view.setInt32(106, -850000000, true)
  const out = new Uint8Array(dataAt + tile.length)
  out.set(header, 0)
  out.set(root, rootAt)
  out.set(metadata, metaAt)
  out.set(tile, dataAt)
  return out
}
