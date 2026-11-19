/** Company sites: loading, the building → sites index, and the search entries. */
import type { CorporateData, CorporateSite } from '../types'
import type { SearchItem } from './search'

export interface Corporate {
  sites: CorporateSite[]
  byId: Map<string, CorporateSite>
  /** Map building id → the sites in it (a building can house several companies). */
  byBuilding: Map<string, CorporateSite[]>
  /** Building ids of confirmed sites: the only ones highlighted on the map. */
  confirmedBuildings: string[]
  searchItems: SearchItem<CorporateSite>[]
  attribution: string
}

export function indexCorporate(data: CorporateData): Corporate {
  const byBuilding = new Map<string, CorporateSite[]>()
  for (const s of data.sites)
    for (const b of s.buildings) byBuilding.set(b.id, [...(byBuilding.get(b.id) ?? []), s])
  return {
    sites: data.sites,
    byId: new Map(data.sites.map((s) => [s.id, s])),
    byBuilding,
    confirmedBuildings: data.sites.filter((s) => s.status === 'confirmed').flatMap((s) => s.buildings.map((b) => b.id)),
    searchItems: data.sites.map((s) => ({
      terms: [s.company_name, s.brand_or_entity, s.campus_or_property, s.campus?.name, ...s.buildings.map((b) => b.name)]
        .filter((t): t is string => !!t),
      // "microsoft gachibowli" finds the site; "gachibowli" alone shows the area first.
      weak: s.city_area ? [`${siteTitle(s)} ${s.city_area}`, s.city_area] : [],
      value: s,
    })),
    attribution: data.attribution,
  }
}

export async function loadCorporate(): Promise<Corporate | null> {
  try {
    const r = await fetch('/data/corporate.json')
    return r.ok ? indexCorporate((await r.json()) as CorporateData) : null
  } catch {
    return null // the map works without company data
  }
}

export const siteTitle = (s: CorporateSite) => s.company_name ?? s.campus_or_property ?? 'Company site'
export const sitePlace = (s: CorporateSite) =>
  [s.campus?.name && s.campus.name !== s.company_name ? s.campus.name : s.campus_or_property, s.city_area].filter(Boolean).join(' · ')
