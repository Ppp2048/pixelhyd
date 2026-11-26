/**
 * How old a published figure or a check is, and what that age does to a verdict. Pure functions.
 *
 * Rent benchmarks (area averages, dated by the period they describe, e.g. "Q2 2025"):
 *   up to RENT_DATED_MONTHS old   current: no note
 *   up to RENT_EXPIRED_MONTHS     dated: the check says how old it is; a fit stays at most "likely"
 *   older, or no readable date    too old (or undated) to decide a budget: "unknown"
 * PG facts read from an operator's page (rent, sharing, who can stay, services, the listing itself),
 * dated by the day the page was checked:
 *   up to PG_DATED_DAYS old       as read
 *   up to PG_EXPIRED_DAYS         dated: a "match" becomes "likely"
 *   older                         too old to decide: "unknown"
 * Nothing is extrapolated: an old figure is never adjusted, only marked and given less weight.
 */

export const RENT_DATED_MONTHS = 12
export const RENT_EXPIRED_MONTHS = 24
export const PG_DATED_DAYS = 90
export const PG_EXPIRED_DAYS = 365

export type Freshness = 'current' | 'dated' | 'expired'

const DAY_MS = 86_400_000
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/**
 * The last day a period describes (UTC), or null when it can't be read. Accepts "Q2 2025", "H1 2025",
 * "Jun 2025" / "June 2025", "2025-06", "2025-06-30" and "2025".
 */
export function periodEnd(period: string): Date | null {
  const p = period.trim().toLowerCase()
  const end = (y: number, month: number) => new Date(Date.UTC(y, month, 0)) // day 0 of the next month
  let m: RegExpMatchArray | null
  if ((m = p.match(/^q([1-4])\s+(\d{4})$/))) return end(+m[2], +m[1] * 3)
  if ((m = p.match(/^h([12])\s+(\d{4})$/))) return end(+m[2], +m[1] * 6)
  if ((m = p.match(/^([a-z]{3})[a-z]*\.?\s+(\d{4})$/)) && MONTHS.includes(m[1])) return end(+m[2], MONTHS.indexOf(m[1]) + 1)
  if ((m = p.match(/^(\d{4})-(\d{2})-(\d{2})$/))) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
  if ((m = p.match(/^(\d{4})-(\d{2})$/)) && +m[2] >= 1 && +m[2] <= 12) return end(+m[1], +m[2])
  if ((m = p.match(/^(\d{4})$/))) return end(+m[1], 12)
  return null
}

/** Whole months from `from` to `now` (0 when `from` is in the future). */
export function monthsBetween(from: Date, now: Date): number {
  const months = (now.getUTCFullYear() - from.getUTCFullYear()) * 12 + (now.getUTCMonth() - from.getUTCMonth())
  return Math.max(0, now.getUTCDate() < from.getUTCDate() ? months - 1 : months)
}

/** Whole days from an ISO date ("2026-11-20") to `now`, or null when it can't be read. */
export function daysSince(iso: string, now: Date): number | null {
  const t = Date.parse(iso.length === 10 ? `${iso}T00:00:00Z` : iso)
  return Number.isNaN(t) ? null : Math.max(0, Math.floor((now.getTime() - t) / DAY_MS))
}

export interface RentAge {
  freshness: Freshness
  /** Null when the period can't be read (then it counts as expired: nothing says it is recent). */
  months: number | null
}

export function rentAge(period: string, now: Date): RentAge {
  const end = periodEnd(period)
  if (!end) return { freshness: 'expired', months: null }
  const months = monthsBetween(end, now)
  return { freshness: months > RENT_EXPIRED_MONTHS ? 'expired' : months > RENT_DATED_MONTHS ? 'dated' : 'current', months }
}

/** A PG page check's age; null when it was never checked (nothing was read from a page then). */
export function pgCheckAge(checked: string | null, now: Date): { freshness: Freshness; days: number } | null {
  const days = checked ? daysSince(checked, now) : null
  if (days === null) return null
  return { freshness: days > PG_EXPIRED_DAYS ? 'expired' : days > PG_DATED_DAYS ? 'dated' : 'current', days }
}

/** "17 months", "1 month", "6 days", "today". */
export function ageText(n: number, unit: 'month' | 'day'): string {
  if (unit === 'day' && n === 0) return 'today'
  return `${n} ${unit}${n === 1 ? '' : 's'}${unit === 'day' ? ' ago' : ''}`
}
