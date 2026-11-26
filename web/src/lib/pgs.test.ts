import { describe, expect, it } from 'vitest'
import { indexCommute, NO_PREFERENCES, type CommuteFile, type Preferences } from './homes'
import { assessPg, byFit, cheapestRoom, indexPgs, isPg, type Pg, type PgContext, type PgData, type PgRent } from './pgs'
import { utmToWgs } from './projection'

const PAGE = 'https://zolostays.com/pg-hostel-near-gachibowli-in-hyderabad-zolo_test-zt01'

const room = (sharing: PgRent['sharing'], from_inr: number, period: PgRent['period'] = null, label: string = sharing): PgRent => ({
  sharing, label, from_inr, period, starting: true, source: PAGE,
})

const pg = (id: string, extra: Partial<Pg> = {}): Pg => ({
  id, name: id, operator: null, kind: 'pg', gender: null, status: 'unverified', lat: 17.44, lon: 78.35,
  location: { from: 'overture', listings: 1, spread_m: 0, listings_agree: true }, page: null, page_gone: null,
  address: null, rent: [], deposit: null, services: {}, checked: null, note: null, overture: ['o'],
  neighbourhood: 'kphb-colony', neighbourhood_m: 900, nearby: {}, metro: null, ...extra,
})

const confirmed = pg('pg-zolo-test', {
  operator: 'zolo', status: 'confirmed', page: PAGE, checked: '2026-11-20',
  gender: { value: 'mixed', from: 'page', source: PAGE },
  rent: [room('single', 15996, null, 'Private Room'), room('double', 8428, null, 'Two Sharing')],
  services: { food: { value: false, source: PAGE }, wifi: { value: true, source: PAGE } },
})
const monthly = pg('pg-monthly', {
  operator: 'hw', status: 'confirmed', page: PAGE, gender: { value: 'women', from: 'page', source: PAGE },
  rent: [room('double', 9000, 'month', 'Two Sharing'), room('triple', 7000, 'month', 'Three Sharing')],
})
const stanza = pg('pg-stanza-living-x-house', {
  operator: 'stanza', status: 'probable', page: 'https://www.stanzaliving.com/hyderabad/x/female/x-house',
  gender: { value: 'women', from: 'link' },
})
const named = pg('pg-sri-sai-boys-hostel-abc123', { gender: { value: 'men', from: 'name' } })

const data: PgData = {
  generated_at: '', attribution: '',
  statuses: { confirmed: 'Confirmed.', probable: 'Probable.', unverified: 'Known only from open-data listings.', closed: 'Closed.' },
  operators: [
    { id: 'zolo', name: 'Zolo', site: '', kind: 'pg', read: true, basis: '', terms: null, checked: '' },
    { id: 'hw', name: 'HelloWorld', site: '', kind: 'pg', read: true, basis: '', terms: null, checked: '' },
    { id: 'stanza', name: 'Stanza Living', site: '', kind: 'pg', read: false, basis: '', terms: null, checked: '' },
  ],
  amenities: { categories: { cafe: 'Cafés' }, radius_m: 1000, measure: '', places_file: '' },
  commute: { file: null, kind: '', metro: '' },
  neighbourhoods: [{ id: 'kphb-colony', name: 'KPHB Colony', lat: 17.49, lon: 78.39, osm_id: 'n1' }],
  pgs: [confirmed, monthly, stanza, named],
}

// One 250 m cell; the confirmed PG is 12 minutes away.
const commute = indexCommute({
  generated_at: '', attribution: '', method: { missing: { minutes: 255, hm: 65535 } },
  grid: { crs: 'EPSG:32644', origin_e: 219000, origin_n: 1928000, cell_m: 250, cols: 1, rows: 1, order: '' },
  graph: { nodes: 0, main_network: 0, edges: 0 }, stations: [],
  societies: { 'pg-zolo-test': { minutes: btoa(String.fromCharCode(12)), hm: btoa(String.fromCharCode(40, 0)), gates: 1 } },
} as CommuteFile)
const [wlon, wlat] = utmToWgs(219125, 1928125)
// A fixed day, so verdicts don't change as page checks age: 6 days after the confirmed PG's check.
const NOW = new Date('2026-11-26T00:00:00Z')
const ctx: PgContext = { pgs: indexPgs(data, commute), hoods: data.neighbourhoods, workplace: { lon: wlon, lat: wlat }, now: NOW }

const prefs = (p: Partial<Preferences>): Preferences => ({ ...NO_PREFERENCES, show: 'pgs', ...p })
const checks = (x: Pg, p: Partial<Preferences>) => assessPg(x, prefs(p), ctx).checks.map((c) => [c.pref, c.verdict])

describe('PG rent', () => {
  it('is likely within budget when the page gives no period, a match when it says a month', () => {
    expect(checks(confirmed, { budget: 10000 })).toEqual([['budget', 'likely']])
    expect(checks(monthly, { budget: 10000 })).toEqual([['budget', 'match']])
  })

  it('over budget is "no" per month, unknown without a period', () => {
    expect(checks(monthly, { budget: 6000 })).toEqual([['budget', 'no']])
    expect(checks(confirmed, { budget: 6000 })).toEqual([['budget', 'unknown']])
  })

  it('uses the cheapest room of the sharing chosen', () => {
    expect(cheapestRoom(monthly, prefs({ sharing: ['double'] }))?.from_inr).toBe(9000)
    expect(cheapestRoom(monthly, prefs({}))?.from_inr).toBe(7000)
    expect(checks(monthly, { budget: 8000, sharing: ['double'] })).toEqual([['budget', 'no'], ['sharing', 'match']])
  })

  it('is unknown when nothing is published, saying when the operator may not be read', () => {
    const [c] = assessPg(stanza, prefs({ budget: 12000 }), ctx).checks
    expect(c.verdict).toBe('unknown')
    expect(c.why).toContain("Stanza Living's terms")
  })
})

describe('PG sharing, who can stay, services and listing', () => {
  it('rules out sharing only where a confirmed page lists other rooms', () => {
    expect(checks(confirmed, { sharing: ['triple'] })).toEqual([['sharing', 'no']])
    expect(checks(stanza, { sharing: ['triple'] })).toEqual([['sharing', 'unknown']])
    const classic = pg('pg-c', { status: 'confirmed', rent: [room('other', 9000, null, 'Classic sharing')] })
    expect(checks(classic, { sharing: ['triple'] })).toEqual([['sharing', 'unknown']])
  })

  it('takes who can stay from the page or link as a match, and from a name only as likely', () => {
    expect(checks(stanza, { gender: ['women'] })).toEqual([['gender', 'match']])
    expect(checks(named, { gender: ['men'] })).toEqual([['gender', 'likely']])
    expect(checks(named, { gender: ['women', 'mixed'] })).toEqual([['gender', 'no']])
    expect(checks(confirmed, { gender: ['women'] })).toEqual([['gender', 'no']])
    expect(checks(pg('pg-silent'), { gender: ['women'] })).toEqual([['gender', 'unknown']])
  })

  it('checks each service: included, not included, or not published', () => {
    expect(checks(confirmed, { services: ['wifi', 'food', 'ac'] })).toEqual([['service', 'match'], ['service', 'no'], ['service', 'unknown']])
  })

  it('keeps only confirmed PGs when asked, and always rules out a closed one', () => {
    expect(checks(confirmed, { confirmed: true })).toEqual([['listing', 'match']])
    expect(checks(stanza, { confirmed: true })).toEqual([['listing', 'no']])
    expect(assessPg(pg('pg-shut', { status: 'closed' }), prefs({}), ctx).verdict).toBe('no')
  })

  it('ignores the society-only choices', () => {
    expect(checks(confirmed, { bhk: [2], furnishing: 'furnished' })).toEqual([])
  })
})

describe('PG drive, area and ordering', () => {
  it('uses the PG drive grid and its own neighbourhood names', () => {
    const a = assessPg(confirmed, prefs({ maxCommute: 15, neighbourhoods: ['kphb-colony'] }), ctx)
    expect(a.drive).toEqual({ minutes: 12, km: 4 })
    expect(a.checks.map((c) => [c.pref, c.verdict, c.why])).toEqual([
      ['commute', 'likely', '≈12 min drive (4.0 km) with no traffic, an estimate.'],
      ['neighbourhood', 'match', 'In KPHB Colony.'],
    ])
  })

  it('orders by verdict, then drive, then name', () => {
    const all = data.pgs.map((p) => assessPg(p, prefs({ budget: 10000 }), ctx)).sort(byFit)
    expect(all.map((a) => [a.pg.id, a.verdict])).toEqual([
      ['pg-monthly', 'match'],
      ['pg-zolo-test', 'likely'],
      ['pg-sri-sai-boys-hostel-abc123', 'unknown'],
      ['pg-stanza-living-x-house', 'unknown'],
    ])
    expect(isPg(all[0])).toBe(true)
  })
})

describe('age of the page check', () => {
  const at = (iso: string): PgContext => ({ ...ctx, now: new Date(iso) })
  const fresh = pg('pg-fresh', { ...monthly, id: 'pg-fresh', checked: '2026-11-20', services: { wifi: { value: true, source: PAGE } } })
  const all = (when: string) =>
    assessPg(fresh, prefs({ budget: 9000, sharing: ['double'], gender: ['women'], services: ['wifi'], confirmed: true }), at(when))
  const pagePrefs = ['budget', 'sharing', 'gender', 'service', 'listing']

  it('keeps page facts as read while the check is recent', () => {
    const a = all('2026-11-26T00:00:00Z')
    expect(a.verdict).toBe('match')
    expect(a.checks.some((c) => c.why.includes('was checked'))).toBe(false)
  })

  it('makes a page match only likely once the check is dated, and says how old it is', () => {
    const a = all('2027-03-01T00:00:00Z') // 101 days
    expect(a.verdict).toBe('likely')
    const rent = a.checks.find((c) => c.pref === 'budget')!
    expect(rent.verdict).toBe('likely')
    expect(rent.why).toContain("The operator's page was checked 101 days ago (2026-11-20); it may have changed since.")
    expect(a.checks.filter((c) => pagePrefs.includes(c.pref)).every((c) => c.verdict === 'likely')).toBe(true)
  })

  it('cannot decide page facts from a check over a year old', () => {
    const a = all('2028-01-01T00:00:00Z')
    expect(a.checks.filter((c) => pagePrefs.includes(c.pref)).map((c) => c.verdict)).toEqual(Array(5).fill('unknown'))
    // An over-budget price from that old page no longer hides the PG either.
    expect(assessPg(fresh, prefs({ budget: 5000 }), at('2028-01-01T00:00:00Z')).checks[0].verdict).toBe('unknown')
  })

  it('leaves facts that are not from a page alone', () => {
    const old = at('2028-01-01T00:00:00Z')
    expect(assessPg({ ...named, checked: '2026-11-20' }, prefs({ gender: ['men'] }), old).checks[0].verdict).toBe('likely')
    expect(assessPg({ ...stanza, checked: '2026-11-20' }, prefs({ confirmed: true }), old).checks[0].verdict).toBe('no')
    expect(assessPg(pg('pg-shut', { status: 'closed', checked: '2026-11-20' }), prefs({}), old).verdict).toBe('no')
  })
})
