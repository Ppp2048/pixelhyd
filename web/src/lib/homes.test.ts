import { describe, expect, it } from 'vitest'
import {
  assess,
  assessAll,
  bhkOf,
  distance,
  indexCommute,
  indexHomes,
  listPlaces,
  litPlaces,
  markAt,
  METRO,
  NO_PREFERENCES,
  ruledOut,
  tally,
  worst,
  type CommuteFile,
  type Context,
  type NearbyPlace,
  type Preferences,
  type ResidentialData,
  type Society,
} from './homes'
import { utmToWgs } from './projection'

const SRC = 'https://example.com/developer-page'

const society = (id: string, extra: Partial<Society> = {}): Society => ({
  id, name: id, developer: null, neighbourhood: 'gachibowli', neighbourhood_m: 500, research: 'mapped', match: 'site',
  site: null, location_source: null, lat: 17.44, lon: 78.35, buildings: [], facts: {}, configurations: [], note: null,
  last_checked: null, nearby: {}, metro: null, ...extra,
})

const researched = society('researched', {
  research: 'researched',
  facts: { bhk: { value: [2, 3], source: SRC } },
  nearby: {
    cafe: { count: 3, nearest: { id: 'c1', name: 'Corner Cafe', m: 120, source: 'osm' } },
    park: { count: 0, nearest: { id: 'p1', name: 'Far Park', m: 1160, source: 'osm' } },
  },
  metro: { id: 'm1', name: 'Raidurg', m: 820, drive_min: 2 },
})
const large = society('large', {
  neighbourhood: 'kokapet',
  configurations: [{ label: 'A', bhk: 3.5, source: SRC }, { label: 'B', bhk: 4.5, source: SRC }],
  metro: { id: 'm1', name: 'Raidurg', m: 4700, drive_min: 13 },
})
const mapped = society('mapped', { neighbourhood: null })

const data: ResidentialData = {
  generated_at: '',
  attribution: '',
  amenities: { categories: { cafe: 'Cafés', park: 'Parks' }, radius_m: 1000, measure: '', places_file: '' },
  commute: { file: '', kind: '', metro: '' },
  benchmarks: [{
    id: 'b', area: 'Gachibowli', neighbourhood: 'gachibowli', bhk: 2, size_sqft: 1000, rent_month: 36600,
    period: 'Q2 2025', publisher: 'ANAROCK Research', via: '', source: 'https://example.com/benchmark',
  }],
  neighbourhoods: [
    { id: 'gachibowli', name: 'Gachibowli', lat: 17.44, lon: 78.35, osm_id: 'n1' },
    { id: 'kokapet', name: 'Kokapet', lat: 17.39, lon: 78.34, osm_id: 'n2' },
  ],
  societies: [mapped, large, researched],
}

// A 3 × 2 grid of 250 m cells; cell i = row * 3 + col, rows counted from the south.
const ORIGIN_E = 219000
const ORIGIN_N = 1928000
const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes))
const u16le = (xs: number[]) => xs.flatMap((x) => [x & 0xff, x >> 8])
const commuteFile: CommuteFile = {
  generated_at: '',
  attribution: '',
  method: { missing: { minutes: 255, hm: 65535 } },
  grid: { crs: 'EPSG:32644', origin_e: ORIGIN_E, origin_n: ORIGIN_N, cell_m: 250, cols: 3, rows: 2, order: '' },
  graph: { nodes: 0, main_network: 0, edges: 0 },
  stations: [],
  societies: {
    researched: { minutes: b64([5, 8, 12, 20, 35, 255]), hm: b64(u16le([20, 40, 300, 100, 65535, 65535])), gates: 3 },
    large: { minutes: b64([25, 30, 40, 50, 60, 255]), hm: b64(u16le([90, 120, 160, 200, 240, 65535])), gates: 2 },
  },
}
/** The centre of grid cell (col, row) as lon/lat. */
const at = (col: number, row: number, de = 125, dn = 125) => {
  const [lon, lat] = utmToWgs(ORIGIN_E + col * 250 + de, ORIGIN_N + row * 250 + dn)
  return { lon, lat }
}

const commute = indexCommute(commuteFile)
const ctx = (workplace = at(2, 0)): Context => ({ data, commute, workplace })
const prefs = (p: Partial<Preferences>): Preferences => ({ ...NO_PREFERENCES, ...p })
const check = (s: Society, p: Partial<Preferences>, c = ctx()) => {
  const checks = assess(s, prefs(p), c).checks
  expect(checks).toHaveLength(1)
  return checks[0]
}

describe('verdicts', () => {
  it('takes the weakest verdict, and nothing to judge never passes', () => {
    expect(worst(['match', 'likely', 'match'])).toBe('likely')
    expect(worst(['likely', 'unknown'])).toBe('unknown')
    expect(worst(['unknown', 'no', 'match'])).toBe('no')
    expect(worst([])).toBe('unknown')
  })
})

describe('commute grid', () => {
  it('finds cells row-major from the south-west corner', () => {
    expect(commute.cell(at(0, 0, 1, 1))).toBe(0)
    expect(commute.cell(at(2, 0))).toBe(2)
    expect(commute.cell(at(0, 1))).toBe(3)
    expect(commute.cell(at(2, 1, 249, 249))).toBe(5)
  })

  it('has no cell outside the grid', () => {
    expect(commute.cell(at(0, 0, -5, 125))).toBeNull()
    expect(commute.cell(at(0, 0, 125, -5))).toBeNull()
    expect(commute.cell(at(3, 0, 5, 125))).toBeNull()
    expect(commute.cell(at(0, 2, 125, 5))).toBeNull()
  })

  it('decodes minutes and little-endian hectometres', () => {
    expect(commute.drive('researched', at(0, 0))).toEqual({ minutes: 5, km: 2 })
    expect(commute.drive('researched', at(2, 0))).toEqual({ minutes: 12, km: 30 })
    expect(commute.drive('large', at(1, 1))).toEqual({ minutes: 60, km: 24 })
  })

  it('reports missing values as no estimate', () => {
    expect(commute.drive('researched', at(1, 1))).toEqual({ minutes: 35, km: null })
    expect(commute.drive('researched', at(2, 1))).toBeNull()
    expect(commute.drive('mapped', at(0, 0))).toBeNull()
    expect(commute.drive('researched', at(5, 5))).toBeNull()
  })

  it('treats a truncated array as no estimates', () => {
    const short = indexCommute({
      ...commuteFile,
      societies: { researched: { ...commuteFile.societies.researched, hm: b64(u16le([20, 40])) } },
    })
    expect(short.drive('researched', at(0, 0))).toBeNull()
  })

  it('refuses a grid in another projection', () => {
    expect(() => indexCommute({ ...commuteFile, grid: { ...commuteFile.grid, crs: 'EPSG:32643' } })).toThrow()
  })
})

describe('budget', () => {
  it('is likely at best: rent is only published per area', () => {
    const c = check(researched, { budget: 40000 })
    expect(c.verdict).toBe('likely')
    expect(c.why).toContain('₹36,600')
    expect(c.why).toContain("rents aren't published")
    expect(c.source).toBe('https://example.com/benchmark')
  })

  it('is never no, even below the area average', () => {
    const c = check(researched, { budget: 20000 })
    expect(c.verdict).toBe('unknown')
    expect(c.why).toContain('above your ₹20,000')
  })

  it('is unknown without a benchmark for the area or for the chosen BHK', () => {
    expect(check(large, { budget: 90000 }).verdict).toBe('unknown')
    expect(check(large, { budget: 90000 }).why).toBe('No published rent for Kokapet.')
    const threeBhk = assess(researched, prefs({ budget: 90000, bhk: [3] }), ctx()).checks[0]
    expect(threeBhk.verdict).toBe('unknown')
    expect(assess(researched, prefs({ budget: 90000, bhk: [2, 3] }), ctx()).checks[0].verdict).toBe('likely')
  })
})

describe('BHK', () => {
  it('merges published BHK types and unit configurations', () => {
    expect(bhkOf(researched)).toEqual([2, 3])
    expect(bhkOf(society('x', { facts: { bhk: { value: [3, 2], source: SRC } }, configurations: [{ bhk: 2.5, source: SRC }] })))
      .toEqual([2, 2.5, 3])
  })

  it('matches a published type, counting 2.5 as 2 and 4 as 4 or more', () => {
    expect(check(researched, { bhk: [3] }).verdict).toBe('match')
    expect(check(researched, { bhk: [3] }).why).toBe('Has 2 and 3 BHK homes.')
    expect(check(large, { bhk: [4] }).verdict).toBe('match')
    expect(check(large, { bhk: [3] }).verdict).toBe('match')
    expect(check(society('x', { configurations: [{ bhk: 2.5, source: SRC }] }), { bhk: [2] }).verdict).toBe('match')
  })

  it('says no only when the published types exclude it, else unknown', () => {
    expect(check(researched, { bhk: [1] })).toMatchObject({ verdict: 'no', why: 'Only 2 and 3 BHK homes.', source: SRC })
    expect(check(mapped, { bhk: [2] }).verdict).toBe('unknown')
  })
})

describe('furnishing', () => {
  it('is always unknown: there is no furnishing data', () => {
    expect(check(researched, { furnishing: 'furnished' }).verdict).toBe('unknown')
    expect(assess(researched, prefs({}), ctx()).checks).toEqual([])
  })
})

describe('commute', () => {
  it('is likely within the limit: the estimate has no traffic', () => {
    const c = check(researched, { maxCommute: 15 })
    expect(c.verdict).toBe('likely')
    expect(c.why).toBe('≈12 min drive (30.0 km) with no traffic, an estimate.')
  })

  it('is no over the limit', () => {
    expect(check(researched, { maxCommute: 10 })).toMatchObject({ verdict: 'no' })
    expect(check(researched, { maxCommute: 10 }).why).toContain('over your 10 min')
  })

  it('is unknown without a workplace, an estimate, or a workplace inside the grid', () => {
    expect(check(researched, { maxCommute: 30 }, { data, commute, workplace: null }).why).toBe('No workplace chosen.')
    expect(check(researched, { maxCommute: 30 }, ctx(at(2, 1))).verdict).toBe('unknown')
    expect(check(researched, { maxCommute: 30 }, ctx(at(9, 9))).verdict).toBe('unknown')
    expect(check(mapped, { maxCommute: 30 }).verdict).toBe('unknown')
    expect(check(researched, { maxCommute: 30 }, { data, commute: null, workplace: at(0, 0) }).verdict).toBe('unknown')
  })

  it('keeps the drive estimate without a commute preference', () => {
    expect(assess(researched, prefs({}), ctx()).drive).toEqual({ minutes: 12, km: 30 })
  })
})

describe('neighbourhood', () => {
  it('matches, excludes, or does not know', () => {
    expect(check(researched, { neighbourhoods: ['gachibowli'] })).toMatchObject({ verdict: 'match', why: 'In Gachibowli.' })
    expect(check(large, { neighbourhoods: ['gachibowli'] }).verdict).toBe('no')
    expect(check(mapped, { neighbourhoods: ['gachibowli'] }).verdict).toBe('unknown')
  })
})

describe('amenities', () => {
  it('matches listed places within the radius', () => {
    expect(check(researched, { amenities: ['cafe'] })).toMatchObject({
      pref: 'amenity', amenity: 'cafe', verdict: 'match', why: '3 listed within 1 km; nearest: Corner Cafe, 120 m.',
    })
  })

  it('is no when none is listed, and unknown without data', () => {
    expect(check(researched, { amenities: ['park'] })).toMatchObject({
      verdict: 'no', why: 'None listed within 1 km; nearest 1.2 km away.',
    })
    expect(check(mapped, { amenities: ['park'] }).verdict).toBe('unknown')
  })

  it('checks the metro station distance', () => {
    expect(check(researched, { amenities: [METRO] })).toMatchObject({ verdict: 'match', why: 'Raidurg station, 820 m away.' })
    expect(check(large, { amenities: [METRO] }).verdict).toBe('no')
    expect(check(mapped, { amenities: [METRO] }).verdict).toBe('unknown')
  })
})

describe('overall', () => {
  it('is the weakest check', () => {
    const v = (p: Partial<Preferences>) => assess(researched, prefs(p), ctx()).verdict
    expect(v({ bhk: [2], amenities: ['cafe', METRO] })).toBe('match')
    expect(v({ bhk: [2], budget: 40000 })).toBe('likely')
    expect(v({ bhk: [2], budget: 40000, furnishing: 'unfurnished' })).toBe('unknown')
    expect(v({ bhk: [2], amenities: ['park'] })).toBe('no')
    expect(v({})).toBe('unknown')
  })

  it('sorts by verdict, then drive time, and counts verdicts', () => {
    const all = assessAll(prefs({ maxCommute: 45 }), ctx())
    // researched drives 12 min and large 40 min to cell (2, 0); mapped has no estimate.
    expect(all.map((a) => [a.society.id, a.verdict])).toEqual([
      ['researched', 'likely'],
      ['large', 'likely'],
      ['mapped', 'unknown'],
    ])
    expect(tally(all)).toEqual({ match: 0, likely: 2, unknown: 1, no: 0 })
  })
})

describe('panel helpers', () => {
  it('counts the societies each preference rules out', () => {
    const all = assessAll(prefs({ bhk: [1], amenities: ['park', METRO], maxCommute: 45 }), ctx())
    // researched: BHK no, park no, metro match; large: BHK no, metro no; mapped: all unknown
    expect(ruledOut(all)).toMatchObject({ budget: 0, bhk: 2, furnishing: 0, commute: 0, neighbourhood: 0, amenity: 2 })
  })

  it('indexes societies by id and by map building', () => {
    const h = indexHomes({ ...data, societies: [society('a', { buildings: ['b1', 'b2'] })] }, null)
    expect(h.byId.get('a')?.id).toBe('a')
    expect(h.byBuilding.get('b2')?.id).toBe('a')
    expect(h.byBuilding.has('b3')).toBe(false)
  })
})

describe('comparison', () => {
  const place = (id: string, name: string): NearbyPlace => ({ id, name, cat: 'cafe', source: 'osm', lat: 17.44, lon: 78.35 })
  const places = new Map(['c1', 'c2', 'c3', 'p1'].map((id) => [id, place(id, id.toUpperCase())]))
  const stations = new Map([['m1', { id: 'm1', name: 'Raidurg', lat: 17.44, lon: 78.38 }]])
  const a = society('a', { nearby: { cafe: { count: 2, ids: ['c1', 'c2'], nearest: { id: 'c1', name: 'C1', m: 80, source: 'osm' } } } })
  const b = society('b', {
    nearby: {
      cafe: { count: 2, ids: ['c2', 'c3'], nearest: { id: 'c2', name: 'C2', m: 300, source: 'osm' } },
      park: { count: 0, ids: [], nearest: { id: 'p1', name: 'P1', m: 1200, source: 'osm' } },
    },
    metro: { id: 'm1', name: 'Raidurg', m: 820, drive_min: 2 },
  })

  it('lights the places of a row once, with the societies they are near', () => {
    expect(litPlaces([a, b], 'cafe', places, stations).map((p) => [p.id, p.near])).toEqual([['c1', [1]], ['c2', [1, 2]], ['c3', [2]]])
  })

  it('falls back to the nearest place when none is within the radius, and skips places it cannot find', () => {
    expect(litPlaces([a, b], 'park', places, stations).map((p) => [p.id, p.near])).toEqual([['p1', [2]]])
    expect(litPlaces([society('x', { nearby: { cafe: { count: 1, ids: ['gone'], nearest: null } } })], 'cafe', places, stations)).toEqual([])
  })

  it('marks a society at the middle of its buildings, else at its point', () => {
    expect(markAt(society('c', { centre: { lat: 17.45, lon: 78.36 } }))).toEqual([78.36, 17.45])
    expect(markAt(society('d', { centre: null }))).toEqual([78.35, 17.44])
  })

  it('lights the nearest metro station', () => {
    expect(litPlaces([a, b], METRO, places, stations)).toEqual([{ id: 'm1', name: 'Raidurg', lon: 78.38, lat: 17.44, near: [2] }])
  })
})

describe('wording', () => {
  it('formats distances', () => {
    expect(distance(0)).toBe('at the site')
    expect(distance(824)).toBe('820 m')
    expect(distance(996)).toBe('1 km')
    expect(distance(4690)).toBe('4.7 km')
  })
})

describe('places file', () => {
  it('reads rows by field name', () => {
    expect(listPlaces({
      generated_at: '', attribution: '', categories: {},
      fields: ['name', 'id', 'cat', 'source', 'lon', 'lat'],
      places: [[null, 'n1', 'park', 'osm', 78.3, 17.4]],
    })).toEqual([{ id: 'n1', name: null, cat: 'park', source: 'osm', lat: 17.4, lon: 78.3 }])
  })
})
