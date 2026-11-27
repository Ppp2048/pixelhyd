import { describe, expect, it } from 'vitest'
import { ageText, daysSince, monthsBetween, periodEnd, pgCheckAge, rentAge } from './freshness'

const d = (iso: string) => new Date(`${iso}T00:00:00Z`)

describe('freshness', () => {
  it('reads the end of a published period', () => {
    expect(periodEnd('Q2 2025')).toEqual(d('2025-06-30'))
    expect(periodEnd('Q4 2024')).toEqual(d('2024-12-31'))
    expect(periodEnd('H1 2025')).toEqual(d('2025-06-30'))
    expect(periodEnd('June 2025')).toEqual(d('2025-06-30'))
    expect(periodEnd('Feb 2024')).toEqual(d('2024-02-29'))
    expect(periodEnd('2025-03')).toEqual(d('2025-03-31'))
    expect(periodEnd('2025-03-14')).toEqual(d('2025-03-14'))
    expect(periodEnd('2025')).toEqual(d('2025-12-31'))
    expect(periodEnd('recently')).toBeNull()
    expect(periodEnd('Q5 2025')).toBeNull()
    expect(periodEnd('2025-13')).toBeNull()
  })

  it('counts whole months and days', () => {
    expect(monthsBetween(d('2025-06-30'), d('2026-11-26'))).toBe(16)
    expect(monthsBetween(d('2025-06-30'), d('2026-06-30'))).toBe(12)
    expect(monthsBetween(d('2027-01-01'), d('2026-01-01'))).toBe(0)
    expect(daysSince('2026-11-20', d('2026-11-26'))).toBe(6)
    expect(daysSince('not a date', d('2026-11-26'))).toBeNull()
  })

  it('grades rent benchmarks: current to a year, dated to two, then expired; undated counts as expired', () => {
    expect(rentAge('Q2 2025', d('2026-06-01')).freshness).toBe('current')
    expect(rentAge('Q2 2025', d('2026-11-26'))).toEqual({ freshness: 'dated', months: 16 })
    expect(rentAge('Q2 2025', d('2027-07-31')).freshness).toBe('expired')
    expect(rentAge('soon', d('2026-11-26'))).toEqual({ freshness: 'expired', months: null })
  })

  it('grades PG page checks: current to 90 days, dated to a year, then expired; never checked is null', () => {
    expect(pgCheckAge('2026-11-20', d('2026-11-26'))).toEqual({ freshness: 'current', days: 6 })
    expect(pgCheckAge('2026-11-20', d('2027-02-18'))?.freshness).toBe('current') // day 90
    expect(pgCheckAge('2026-11-20', d('2027-02-19'))?.freshness).toBe('dated') // day 91
    expect(pgCheckAge('2026-11-20', d('2027-11-21'))?.freshness).toBe('expired')
    expect(pgCheckAge(null, d('2026-11-26'))).toBeNull()
  })

  it('words ages', () => {
    expect(ageText(1, 'month')).toBe('1 month')
    expect(ageText(16, 'month')).toBe('16 months')
    expect(ageText(0, 'day')).toBe('today')
    expect(ageText(6, 'day')).toBe('6 days ago')
  })
})
