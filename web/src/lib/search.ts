/**
 * Small, dependency-free search: normalised text, prefix and substring matches, and one or
 * two typos per word (Damerau-Levenshtein), ranked so exact and early matches come first.
 * Items are normalised once (`createIndex`), so a query over ~15 000 places stays well under
 * a frame.
 */

export interface SearchItem<T> {
  /** Text people may type: names, aliases, area names. The first is the main name. */
  terms: string[]
  value: T
  /** Added to the score (lower ranks higher): lets companies and localities beat a same-named street. */
  boost?: number
  /**
   * Looser matches, such as a name plus its area ("Apollo Hospital Jubilee Hills"): found, but
   * ranked after anything whose own name matches.
   */
  weak?: string[]
}

interface Prepared<T> {
  words: string[][]
  /** How many of `words` are proper terms; the rest are weak. */
  strong: number
  value: T
  boost: number
}

const ALIAS = 0.5
const WEAK = 3

export const normalise = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

/** Edit distance with adjacent swaps, stopping early once it exceeds `max`. */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  let prev2: number[] = []
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    let best = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1)
      cur[j] = v
      best = Math.min(best, v)
    }
    prev2 = prev
    prev = cur
    if (best > max) return max + 1
  }
  return prev[b.length]
}

const allowed = (len: number) => (len <= 3 ? 0 : len <= 6 ? 1 : 2)

/** Score of one query word against one term's words (lower is better); null if no word matches. */
function wordScore(q: string, words: string[]): number | null {
  let best: number | null = null
  const max = allowed(q.length)
  for (const w of words) {
    let s: number | null = null
    if (w === q) s = 0
    else if (w.startsWith(q)) s = 1
    else if (q.length >= 3 && w.includes(q)) s = 3
    else if (max && (w[0] === q[0] || w[1] === q[1])) {
      // A typo in a whole word, or in the part typed so far (cheap check first: most words share no start).
      const d = Math.min(editDistance(q, w, max), editDistance(q, w.slice(0, q.length), max))
      if (d <= max) s = 4 + d * 2
    }
    if (s !== null && (best === null || s < best)) {
      best = s
      if (s === 0) break
    }
  }
  return best
}

function prepare<T>(items: SearchItem<T>[]): Prepared<T>[] {
  return items.map((it) => ({
    words: [...it.terms, ...(it.weak ?? [])].map((t) => normalise(t).split(' ')),
    strong: it.terms.length,
    value: it.value,
    boost: it.boost ?? 0,
  }))
}

function run<T>(items: Prepared<T>[], query: string, limit: number, accept?: (v: T) => boolean): T[] {
  const words = normalise(query).split(' ').filter(Boolean)
  if (!words.length) return []
  const scored: { value: T; score: number }[] = []
  for (const item of items) {
    if (accept && !accept(item.value)) continue
    let best: number | null = null
    for (let t = 0; t < item.words.length; t++) {
      let total = t === 0 ? 0 : t < item.strong ? ALIAS : WEAK // the main name beats an alias, an alias a weak term
      for (const q of words) {
        const s = wordScore(q, item.words[t])
        if (s === null) {
          total = -1 // every query word must match this term
          break
        }
        total += s
      }
      if (total >= 0 && (best === null || total < best)) best = total
    }
    // Shorter names win ties: "Gachibowli" before "Gachibowli Stadium Road".
    if (best !== null) scored.push({ value: item.value, score: best + item.boost + item.words[0].length * 0.05 })
  }
  return scored.sort((a, b) => a.score - b.score).slice(0, limit).map((s) => s.value)
}

export interface SearchIndex<T> {
  search: (query: string, limit?: number, accept?: (v: T) => boolean) => T[]
}

export function createIndex<T>(items: SearchItem<T>[]): SearchIndex<T> {
  const prepared = prepare(items)
  return { search: (query, limit = 8, accept) => run(prepared, query, limit, accept) }
}

/** One-off search over unprepared items (tests, small lists). */
export function search<T>(items: SearchItem<T>[], query: string, limit = 8): T[] {
  return run(prepare(items), query, limit)
}
