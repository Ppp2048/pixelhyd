/**
 * Visit counts in Cloudflare D1 (SQLite), for the Pages Function in functions/api/visits.ts.
 * Schema: migrations/0001_visits.sql. Also keeps the shared daily salt, deleted when the day changes.
 */
import { randomSalt, type VisitStore } from './visits.ts'

/** The part of D1's API used here (avoids a dependency on Cloudflare's type package). */
export interface D1Statement {
  bind(...values: unknown[]): D1Statement
  first<T = Record<string, unknown>>(): Promise<T | null>
  run(): Promise<unknown>
}
export interface D1Like {
  prepare(sql: string): D1Statement
  batch(statements: D1Statement[]): Promise<unknown[]>
}

export function d1Store(db: D1Like): VisitStore & { dailySalt: (day: string) => Promise<string> } {
  return {
    lastSeen: async (key) => (await db.prepare('SELECT last FROM seen WHERE key = ?').bind(key).first<{ last: number }>())?.last ?? null,
    touch: async (key, t, newVisit) => {
      const upsert = db
        .prepare('INSERT INTO seen (key, last) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET last = excluded.last')
        .bind(key, t)
      await db.batch(newVisit ? [upsert, db.prepare("UPDATE totals SET n = n + 1 WHERE name = 'visits'")] : [upsert])
    },
    counts: async (since) => {
      const row = await db
        .prepare("SELECT (SELECT COUNT(*) FROM seen WHERE last >= ?) AS active, (SELECT n FROM totals WHERE name = 'visits') AS total")
        .bind(since)
        .first<{ active: number; total: number | null }>()
      return { active: Number(row?.active ?? 0), total: Number(row?.total ?? 0) }
    },
    prune: async (before) => {
      await db.prepare('DELETE FROM seen WHERE last < ?').bind(before).run()
    },
    dailySalt: async (day) => {
      // Every instance agrees: the first to ask today creates it; older days' salts are deleted.
      await db.batch([
        db.prepare('INSERT OR IGNORE INTO salts (day, value) VALUES (?, ?)').bind(day, randomSalt()),
        db.prepare('DELETE FROM salts WHERE day <> ?').bind(day),
      ])
      const row = await db.prepare('SELECT value FROM salts WHERE day = ?').bind(day).first<{ value: string }>()
      return row!.value
    },
  }
}
