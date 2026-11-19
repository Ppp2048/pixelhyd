/**
 * Production server: the built site (web/dist) plus the visit counter, with no dependencies.
 *   node server/main.ts        (Node 24+; run `npm run build` first)
 * Environment: PORT (default 8080), HOST (default 0.0.0.0), VISITS_DB (SQLite file, default
 * ../data/stats/visits.sqlite — put it on a persistent disk), TRUST_PROXY=1 behind a reverse proxy/CDN.
 * Map tiles are not served here; they come from VITE_TILES_URL (see docs/deploy.md).
 */
import { readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { visitsMiddleware } from './node.ts'
import { sqliteStore } from './sqliteStore.ts'
import { createVisits } from './visits.ts'

const DIST = fileURLToPath(new URL('../dist', import.meta.url))
const PORT = Number(process.env.PORT ?? 8080)
const HOST = process.env.HOST ?? '0.0.0.0'
const DB = process.env.VISITS_DB ?? fileURLToPath(new URL('../../data/stats/visits.sqlite', import.meta.url))

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}
const COMPRESS = new Set(['.html', '.js', '.css', '.json', '.svg'])

/** Hashed build assets never change; data files change on rebuild; the page itself is always revalidated. */
const cacheControl = (path: string) =>
  path.startsWith(`assets${sep}`) ? 'public, max-age=31536000, immutable' : path.startsWith(`data${sep}`) ? 'public, max-age=3600' : 'no-cache'

type Entry = { body: Buffer; gzip: Buffer | null; mtime: number }
const cache = new Map<string, Entry>()

function load(path: string): Entry | null {
  const file = join(DIST, path)
  let mtime: number
  try {
    const s = statSync(file)
    if (!s.isFile()) return null
    mtime = s.mtimeMs
  } catch {
    return null
  }
  const hit = cache.get(path)
  if (hit && hit.mtime === mtime) return hit
  const body = readFileSync(file)
  const entry = { body, gzip: COMPRESS.has(extname(path)) ? gzipSync(body, { level: 9 }) : null, mtime }
  cache.set(path, entry)
  return entry
}

const visits = visitsMiddleware(createVisits(sqliteStore(DB)), { trustProxy: process.env.TRUST_PROXY === '1' })

createServer((req, res) => {
  res.setHeader('x-content-type-options', 'nosniff')
  res.setHeader('referrer-policy', 'strict-origin-when-cross-origin')
  visits(req, res, () => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return res.writeHead(405).end()
    let path: string
    try {
      path = normalize(decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)).replace(/^[/\\]+/, '')
    } catch {
      return res.writeHead(400).end()
    }
    if (path.split(sep).includes('..')) return res.writeHead(400).end()
    if (path === '' || path === '.') path = 'index.html'
    const entry = load(path)
    if (!entry) return res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found')
    const gzip = entry.gzip && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))
    const body = gzip ? entry.gzip! : entry.body
    res.writeHead(200, {
      'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
      'content-length': body.length,
      'cache-control': cacheControl(path),
      vary: 'accept-encoding',
      ...(gzip ? { 'content-encoding': 'gzip' } : {}),
    })
    res.end(req.method === 'HEAD' ? undefined : body)
  })
}).listen(PORT, HOST, () => console.log(`Pixelhyd on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`))
