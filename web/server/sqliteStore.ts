/** Visit counts in a SQLite file, using Node's built-in `node:sqlite` (Node 22.13+; no package). */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { VisitStore } from './visits.ts'

export function sqliteStore(file: string): VisitStore & { close: () => void } {
  mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec(`
    PRAGMA journal_mode = WAL;
    -- Hashed visitor keys, kept only while they are within the 30-minute visit window.
    CREATE TABLE IF NOT EXISTS seen (key TEXT PRIMARY KEY, last INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS seen_last ON seen (last);
    -- The one lasting number.
    CREATE TABLE IF NOT EXISTS totals (name TEXT PRIMARY KEY, n INTEGER NOT NULL);
    INSERT OR IGNORE INTO totals (name, n) VALUES ('visits', 0);
  `)
  const getLast = db.prepare('SELECT last FROM seen WHERE key = ?')
  const upsert = db.prepare('INSERT INTO seen (key, last) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET last = excluded.last')
  const addVisit = db.prepare("UPDATE totals SET n = n + 1 WHERE name = 'visits'")
  const active = db.prepare('SELECT COUNT(*) AS n FROM seen WHERE last >= ?')
  const total = db.prepare("SELECT n FROM totals WHERE name = 'visits'")
  const prune = db.prepare('DELETE FROM seen WHERE last < ?')

  return {
    lastSeen: async (key) => {
      const row = getLast.get(key) as { last: number } | undefined
      return row ? Number(row.last) : null
    },
    touch: async (key, t, newVisit) => {
      db.exec('BEGIN')
      try {
        upsert.run(key, t)
        if (newVisit) addVisit.run()
        db.exec('COMMIT')
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
    },
    counts: async (since) => ({
      active: Number((active.get(since) as { n: number }).n),
      total: Number((total.get() as { n: number }).n),
    }),
    prune: async (before) => {
      prune.run(before)
    },
    close: () => db.close(),
  }
}
