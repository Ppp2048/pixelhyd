/**
 * Anonymous visitor counts: how many people are exploring now (seen in the last 5 minutes) and
 * how many visits there have been in total.
 *
 * Privacy: no cookies and nothing stored in the browser. A visitor is recognised for at most 30
 * minutes by a hash of their IP address and browser name with a random salt that changes every
 * day and is deleted when it does, so a hash cannot be traced back or linked across days. (In one
 * long-running server the salt stays in memory; serverless runs keep it in the database so every
 * instance agrees.) The IP address and browser name themselves are never stored; hashes are
 * deleted after 30 minutes. What persists is one number: the total.
 *
 * Inflation: a visit is counted once per 30 minutes of activity, so refreshing does not add
 * visits. Only browsers running the page count: requests must come from the page's own origin
 * with a JSON content type (cross-site scripts are stopped by CORS), and known bots and scripted
 * clients are ignored. Heartbeats closer than 20 seconds apart are ignored.
 *
 * Written against Web-standard Request/Response so the same handler can run in Node (see
 * node.ts) or a serverless runtime with a different store.
 */

export const ACTIVE_MS = 5 * 60_000
export const SESSION_MS = 30 * 60_000
export const MIN_BEAT_MS = 20_000

export interface Counts {
  active: number
  total: number
}

/** Where counts live. Async so a database or key-value service can implement it. */
export interface VisitStore {
  /** When this visitor key was last seen, or null. */
  lastSeen(key: string): Promise<number | null>
  /** Record a heartbeat; a new visit also adds one to the total. */
  touch(key: string, now: number, newVisit: boolean): Promise<void>
  counts(activeSince: number): Promise<Counts>
  /** Forget visitor keys not seen since `before`. */
  prune(before: number): Promise<void>
}

/** Clients that are not people looking at the map. */
const NOT_A_PERSON =
  /bot|crawl|spider|slurp|headless|lighthouse|pagespeed|preview|facebookexternalhit|embedly|curl|wget|python|httpclient|okhttp|java\/|go-http|node-fetch|undici|axios|monitor|uptime|phantom/i

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')

export interface VisitsOptions {
  /** Origins allowed to count visits besides the request's own (e.g. a separate site domain). */
  allowedOrigins?: string[]
  now?: () => number
  /**
   * The salt for a UTC day ("2026-11-20"), shared by every instance and discarded when the day
   * changes. Default: random and in memory, right for a single long-running process.
   */
  dailySalt?: (day: string) => Promise<string>
}

export const randomSalt = () => hex(crypto.getRandomValues(new Uint8Array(16)).buffer)

export function createVisits(store: VisitStore, opts: VisitsOptions = {}) {
  const now = opts.now ?? Date.now
  let salt = { day: '', value: '' }
  const dailySalt = opts.dailySalt ?? (async () => salt.value)

  /** Today's salt, replaced at midnight UTC. */
  const todaysSalt = async (t: number) => {
    const day = new Date(t).toISOString().slice(0, 10)
    if (salt.day !== day) salt = { day, value: randomSalt() }
    return dailySalt(day)
  }

  const visitorKey = async (ip: string, ua: string, t: number) =>
    hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${await todaysSalt(t)}|${ip}|${ua}`))).slice(0, 32)

  /** Is this heartbeat from a person's browser on our own page? */
  function countable(req: Request): boolean {
    const ua = req.headers.get('user-agent') ?? ''
    if (!ua || NOT_A_PERSON.test(ua)) return false
    if (!(req.headers.get('content-type') ?? '').startsWith('application/json')) return false
    const origin = req.headers.get('origin')
    if (!origin) return false
    // Compare hosts: behind a TLS proxy the request may arrive as http while the page is https.
    let host: string
    try {
      host = new URL(origin).host
    } catch {
      return false
    }
    if (host !== new URL(req.url).host && !opts.allowedOrigins?.includes(origin)) return false
    const site = req.headers.get('sec-fetch-site')
    return !site || site === 'same-origin' || !!opts.allowedOrigins?.includes(origin)
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    })

  /** GET /api/visits → counts; POST /api/visits → heartbeat, then counts. */
  async function handle(req: Request, clientIp: string): Promise<Response> {
    if (new URL(req.url).pathname !== '/api/visits') return json({ error: 'not found' }, 404)
    const t = now()
    if (req.method === 'POST') {
      if (countable(req)) {
        const key = await visitorKey(clientIp, req.headers.get('user-agent')!, t)
        const last = await store.lastSeen(key)
        if (last === null || t - last >= MIN_BEAT_MS) await store.touch(key, t, last === null || t - last > SESSION_MS)
        await store.prune(t - SESSION_MS)
      }
    } else if (req.method !== 'GET') {
      return json({ error: 'method not allowed' }, 405)
    }
    return json(await store.counts(t - ACTIVE_MS))
  }

  return { handle }
}

/** A store in memory: for tests, and for running without a database (counts reset on restart). */
export function memoryStore(): VisitStore {
  const seen = new Map<string, number>()
  let total = 0
  return {
    lastSeen: async (key) => seen.get(key) ?? null,
    touch: async (key, t, newVisit) => {
      seen.set(key, t)
      if (newVisit) total++
    },
    counts: async (since) => ({ active: [...seen.values()].filter((t) => t >= since).length, total }),
    prune: async (before) => {
      for (const [k, t] of seen) if (t < before) seen.delete(k)
    },
  }
}
