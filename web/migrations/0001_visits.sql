-- Anonymous visit counter (see web/server/visits.ts). Nothing here identifies a person:
-- hashed keys live for 30 minutes, the salt for one day, and the total is a single number.
CREATE TABLE IF NOT EXISTS seen (key TEXT PRIMARY KEY, last INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS seen_last ON seen (last);
CREATE TABLE IF NOT EXISTS totals (name TEXT PRIMARY KEY, n INTEGER NOT NULL);
INSERT OR IGNORE INTO totals (name, n) VALUES ('visits', 0);
CREATE TABLE IF NOT EXISTS salts (day TEXT PRIMARY KEY, value TEXT NOT NULL);
