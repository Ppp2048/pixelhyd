import { describe, expect, it } from 'vitest'
import { indexCorporate, type Corporate } from './corporate'
import { readUrl } from './urlState'
import type { CorporateData, CorporateSite } from '../types'
import v1Raw from '../../../pipeline/corporate/legacy/corporate-v1-2026-11.json?raw'

// The last v1 file (tracked, byte for byte), and the published file when it has been built: it lives under
// the git-ignored web/public/data/, so a fresh clone skips those checks (like pipeline/tests/test_seams.py).
const v1 = JSON.parse(v1Raw) as CorporateData
const built = Object.values(
  import.meta.glob<string>('../../public/data/corporate.json', { query: '?raw', import: 'default', eager: true }),
)[0]
const v2 = built ? (JSON.parse(built) as CorporateData) : undefined
const V2_SITE = ['company_id', 'presence', 'footprint_basis', 'confidence', 'operational_status', 'evidence', 'stale'] as const
const SITES = ['microsoft_india_development_center', 'wells_fargo_divyasree_orion']

const view = (c: Corporate) => ({
  byId: [...c.byId.keys()],
  byBuilding: [...c.byBuilding].map(([b, sites]) => [b, sites.map((s) => s.id)]),
  confirmedBuildings: c.confirmedBuildings,
  dots: c.sites.filter((s) => s.status === 'confirmed').map((s) => [s.id, s.lat, s.lon]),
  search: c.searchItems.map((i) => [i.value.id, i.terms, i.weak]),
  attribution: c.attribution,
})

describe('corporate.json v1 (2026-11 baseline)', () => {
  it('still loads and indexes', () => {
    expect(v1.schema_version).toBeUndefined()
    const c = indexCorporate(v1)
    expect([...c.byId.keys()]).toEqual(SITES)
    expect(c.confirmedBuildings.length).toBeGreaterThan(0)
  })

  it('opens shared ?s= links', () => {
    const c = indexCorporate(v1)
    for (const id of SITES) expect(c.byId.get(readUrl(`?lat=17.43&lon=78.37&z=15.00&s=${id}`).site!)?.id).toBe(id)
  })
})

describe.skipIf(!v2)('corporate.json v2 (built by `hitec-pipeline corporate`)', () => {
  const data = v2!

  it('is a v2 file with the same published sites as the baseline', () => {
    expect(data.schema_version).toBe(2)
    expect(data.sites.map((s) => s.id)).toEqual(SITES)
  })

  it('indexes exactly like the v1 baseline, and like itself without the v2 fields', () => {
    const stripped: CorporateData = {
      ...data,
      sites: data.sites.map((s) => Object.fromEntries(Object.entries(s).filter(([k]) => !(V2_SITE as readonly string[]).includes(k))) as CorporateSite),
    }
    expect(view(indexCorporate(data))).toEqual(view(indexCorporate(v1)))
    expect(view(indexCorporate(stripped))).toEqual(view(indexCorporate(v1)))
  })

  it('keeps every source, context-only ones included', () => {
    for (const s of data.sites) expect(s.evidence?.map((e) => e.url)).toEqual(s.sources)
    expect(data.sites.flatMap((s) => s.evidence ?? []).some((e) => e.supports.length === 0)).toBe(true)
  })

  it('lists each company once, separate from its offices', () => {
    const ids = data.companies?.map((c) => c.id) ?? []
    expect(new Set(ids).size).toBe(ids.length)
    for (const s of data.sites) expect(data.companies?.find((c) => c.id === s.company_id)?.sites).toContain(s.id)
  })

  it('opens shared ?s= links to the same sites', () => {
    const c = indexCorporate(data)
    for (const id of SITES) expect(c.byId.get(readUrl(`?lat=17.43&lon=78.37&z=15.00&s=${id}`).site!)?.id).toBe(id)
  })
})
