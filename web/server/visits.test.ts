import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ACTIVE_MS, MIN_BEAT_MS, SESSION_MS, createVisits, memoryStore, type VisitStore } from './visits.ts'
import { sqliteStore } from './sqliteStore.ts'
import { d1Store, type D1Like, type D1Statement } from './d1Store.ts'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36'
const URL_ = 'http://pixelhyd.test/api/visits'

const beat = (headers: Record<string, string> = {}) =>
  new Request(URL_, {
    method: 'POST',
    headers: { 'user-agent': UA, 'content-type': 'application/json', origin: 'http://pixelhyd.test', 'sec-fetch-site': 'same-origin', ...headers },
  })

function setup(store: VisitStore = memoryStore()) {
  let t = Date.UTC(2026, 10, 20, 10)
  const visits = createVisits(store, { now: () => t })
  return {
    send: async (req: Request, ip = '203.0.113.7') => (await visits.handle(req, ip)).json() as Promise<{ active: number; total: number }>,
    wait: (ms: number) => (t += ms),
  }
}

const tmp = mkdtempSync(join(tmpdir(), 'pixelhyd-visits-'))
const opened: { close: () => void }[] = []
afterAll(() => {
  opened.forEach((db) => db.close())
  rmSync(tmp, { recursive: true, force: true })
})
const tmpDb = () => {
  const db = sqliteStore(join(tmp, `${opened.length}.sqlite`))
  opened.push(db)
  return db
}

/** D1's API over node:sqlite, with the real migration applied: enough to exercise d1Store. */
function fakeD1(): D1Like {
  const db = new DatabaseSync(':memory:')
  db.exec(readFileSync(new URL('../migrations/0001_visits.sql', import.meta.url), 'utf8'))
  const statement = (sql: string, args: unknown[] = []): D1Statement => ({
    bind: (...values) => statement(sql, values),
    first: async <T,>() => (db.prepare(sql).get(...(args as never[])) ?? null) as T | null,
    run: async () => db.prepare(sql).run(...(args as never[])),
  })
  return {
    prepare: (sql) => statement(sql),
    batch: async (list) => {
      db.exec('BEGIN')
      const out = []
      for (const s of list) out.push(await s.run())
      db.exec('COMMIT')
      return out
    },
  }
}

describe.each([
  ['memory', () => memoryStore()],
  ['sqlite', tmpDb],
  ['d1', () => d1Store(fakeD1())],
])('visit counter (%s store)', (_, makeStore) => {
  it('counts a visit once, however often the page is refreshed', async () => {
    const s = setup(makeStore())
    expect(await s.send(beat())).toEqual({ active: 1, total: 1 })
    for (let i = 0; i < 5; i++) {
      s.wait(MIN_BEAT_MS)
      expect(await s.send(beat())).toEqual({ active: 1, total: 1 })
    }
  })

  it('counts different people separately, and a return after 30 minutes as a new visit', async () => {
    const s = setup(makeStore())
    await s.send(beat())
    expect(await s.send(beat(), '198.51.100.2')).toEqual({ active: 2, total: 2 })
    s.wait(SESSION_MS + 1)
    expect(await s.send(beat())).toEqual({ active: 1, total: 3 })
  })

  it('drops people from "now" after 5 minutes without a heartbeat', async () => {
    const s = setup(makeStore())
    await s.send(beat())
    s.wait(ACTIVE_MS + 1)
    expect(await s.send(new Request(URL_))).toEqual({ active: 0, total: 1 })
  })

  it('ignores bots, scripts and other sites, but still answers them', async () => {
    const s = setup(makeStore())
    const ignored = [
      beat({ 'user-agent': 'Googlebot/2.1 (+http://www.google.com/bot.html)' }),
      beat({ 'user-agent': 'curl/8.4.0' }),
      beat({ 'user-agent': 'Mozilla/5.0 HeadlessChrome/140' }),
      beat({ origin: 'https://elsewhere.example' }),
      beat({ 'sec-fetch-site': 'cross-site' }),
      beat({ 'content-type': 'text/plain' }),
      new Request(URL_, { method: 'POST', headers: { 'user-agent': UA, 'content-type': 'application/json' } }), // no origin
    ]
    for (const r of ignored) expect(await s.send(r)).toEqual({ active: 0, total: 0 })
  })
})

describe('visit counter on serverless (D1)', () => {
  it('counts one person once even when separate instances answer their heartbeats', async () => {
    const store = d1Store(fakeD1())
    let t = Date.UTC(2026, 10, 20, 10)
    // Two instances, as Cloudflare may run: each has its own memory, they share the database.
    const a = createVisits(store, { now: () => t, dailySalt: store.dailySalt })
    const b = createVisits(store, { now: () => t, dailySalt: store.dailySalt })
    await a.handle(beat(), '203.0.113.7')
    t += MIN_BEAT_MS
    const r = await (await b.handle(beat(), '203.0.113.7')).json()
    expect(r).toEqual({ active: 1, total: 1 })
  })

  it("keeps only today's salt", async () => {
    const store = d1Store(fakeD1())
    const first = await store.dailySalt('2026-11-20')
    expect(await store.dailySalt('2026-11-20')).toBe(first)
    const next = await store.dailySalt('2026-11-21')
    expect(next).not.toBe(first)
    expect(await store.dailySalt('2026-11-20')).not.toBe(first) // yesterday's is gone for good
  })
})

describe('visit counter privacy', () => {
  it('stores only salted hashes, never addresses or browser names, and forgets them after the visit window', async () => {
    const inner = memoryStore()
    const keys: string[] = []
    const store: VisitStore = { ...inner, touch: (key, t, v) => (keys.push(key), inner.touch(key, t, v)) }
    const s = setup(store)
    await s.send(beat())
    s.wait(SESSION_MS + 1)
    await s.send(beat(), '198.51.100.2')
    for (const k of keys) {
      expect(k).toMatch(/^[0-9a-f]{32}$/)
      expect(k).not.toContain('203.0.113.7')
    }
    expect((await store.counts(0)).active).toBe(1) // the first visitor's key is gone
  })

  it('cannot link the same person across days (the salt changes)', async () => {
    const inner = memoryStore()
    const keys: string[] = []
    const store: VisitStore = { ...inner, touch: (key, t, v) => (keys.push(key), inner.touch(key, t, v)) }
    const s = setup(store)
    await s.send(beat())
    s.wait(24 * 3600_000)
    await s.send(beat())
    expect(keys[0]).not.toBe(keys[1])
  })

  it('answers only its own path and methods', async () => {
    const visits = createVisits(memoryStore())
    expect((await visits.handle(new Request('http://x.test/api/other'), '')).status).toBe(404)
    expect((await visits.handle(new Request(URL_, { method: 'DELETE' }), '')).status).toBe(405)
  })
})
