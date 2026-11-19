import { describe, expect, it } from 'vitest'
import { buildIndex, countGroups, groupHits, hitTitle, type Hit } from './discover'
import type { Corporate } from './corporate'
import type { Place, Places } from './places'
import type { CorporateSite } from '../types'

const place = (name: string, cat: string, extra: Partial<Place> = {}): Place => ({
  id: `n${name.length}${cat}`, name, cat, kind: cat, lat: 17.4, lon: 78.4, bbox: null, buildingId: null, context: null, alt: [], ...extra,
})
const places: Places = {
  attribution: '',
  categories: { locality: 'Localities', street: 'Streets', health: 'Hospitals', office: 'Offices' },
  places: [
    place('Microsoft Road', 'street'),
    place('Gachibowli Stadium Road', 'street'),
    place('Gachibowli', 'locality'),
    place('Apollo Hospital', 'health', { context: 'Jubilee Hills' }),
    place('Apollo Hospital', 'health', { id: 'other', context: 'Secunderabad' }),
  ],
}
const site = { id: 'ms', company_name: 'Microsoft', status: 'confirmed', buildings: [] } as unknown as CorporateSite
const corporate = {
  searchItems: [{ terms: ['Microsoft'], weak: ['Microsoft Gachibowli', 'Gachibowli'], value: site }],
} as unknown as Corporate

describe('unified search', () => {
  const index = buildIndex(corporate, places)

  it('ranks a curated company above a street sharing its name', () => {
    const hits = index.search('microsoft')
    expect(hits[0]).toMatchObject({ type: 'site' })
    expect(hits.map(hitTitle)).toContain('Microsoft Road')
  })

  it('ranks an area above longer names that start with it, and above companies located in it', () => {
    const hits = index.search('gachibowli')
    expect(hitTitle(hits[0])).toBe('Gachibowli')
    expect(hits.findIndex((h) => h.type === 'site')).toBeGreaterThan(hits.findIndex((h) => hitTitle(h) === 'Gachibowli Stadium Road'))
    expect(index.search('microsoft gachibowli')[0]).toMatchObject({ type: 'site' })
  })

  it('tells same-named places apart by their area', () => {
    const [first] = index.search('apollo jubilee') as Extract<Hit, { type: 'place' }>[]
    expect(first.place.context).toBe('Jubilee Hills')
    expect(index.search('apollo jubilee')).toHaveLength(1)
  })

  it('groups by kind in rank order, and filters to one kind', () => {
    const hits = index.search('road', 50)
    expect(countGroups(hits).get('street')).toBe(2)
    const groups = groupHits(index.search('road', 50), { companies: 'Companies', ...places.categories }, null, 1)
    expect(groups.reduce((n, g) => n + g.hits.length, 0)).toBe(1)
    expect(groups[0].label).toBe('Streets')
    const only = groupHits(index.search('gachibowli', 50), {}, 'street')
    expect(only.map((g) => g.id)).toEqual(['street'])
  })
})
