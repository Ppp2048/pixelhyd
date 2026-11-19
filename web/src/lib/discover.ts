/** Unified search: company sites (curated, with evidence) and the citywide place index (OpenStreetMap). */
import type { CorporateSite } from '../types'
import { sitePlace, siteTitle, type Corporate } from './corporate'
import type { Place, Places } from './places'
import { createIndex, type SearchIndex, type SearchItem } from './search'

export type Hit = { type: 'site'; site: CorporateSite } | { type: 'place'; place: Place }

/** Results group / filter id: "companies" or a place category. */
export const hitGroup = (h: Hit) => (h.type === 'site' ? 'companies' : h.place.cat)
export const hitKey = (h: Hit) => (h.type === 'site' ? `s:${h.site.id}` : `p:${h.place.id}`)
export const hitTitle = (h: Hit) => (h.type === 'site' ? siteTitle(h.site) : h.place.name)
export const hitSub = (h: Hit) =>
  h.type === 'site' ? sitePlace(h.site) : [h.place.kind, h.place.context].filter(Boolean).join(' · ')

/**
 * Ranking nudges (lower ranks higher), added to the text score. Curated companies come first;
 * areas and landmarks people navigate by beat the many streets, offices and buildings that
 * share a word with them.
 */
const BOOST: Record<string, number> = {
  locality: 0, landmark: 0, transit: 0.3, campus: 0.3, park: 0.4, shopping: 0.5, education: 0.6,
  health: 0.6, civic: 0.6, worship: 0.7, street: 0.8, office: 1, building: 1.1,
}
/** Named housing complexes are localities in OpenStreetMap, but rank below suburbs and landmarks. */
const RESIDENTIAL = 0.9

export function buildIndex(corporate: Corporate | null, places: Places | null): SearchIndex<Hit> {
  const items: SearchItem<Hit>[] = (corporate?.searchItems ?? []).map((it) => ({
    terms: it.terms,
    weak: it.weak,
    value: { type: 'site', site: it.value },
    boost: -1.5,
  }))
  for (const p of places?.places ?? []) {
    // "apollo jubilee" finds Apollo Hospital in Jubilee Hills: the name plus its area is a weak term.
    const weak = p.context && p.context !== p.name ? [`${p.name} ${p.context}`] : []
    const boost = p.kind === 'Residential area' ? RESIDENTIAL : BOOST[p.cat] ?? 1
    items.push({ terms: [p.name, ...p.alt], weak, value: { type: 'place', place: p }, boost })
  }
  return createIndex(items)
}

export interface Group {
  id: string
  label: string
  hits: Hit[]
}

/** Labels for the result groups and filter chips, in the place index's order after companies. */
export function groupLabels(places: Places | null): Record<string, string> {
  return { companies: 'Companies', ...(places?.categories ?? {}) }
}

/**
 * Ranked hits → groups in order of their best hit, at most `limit` hits shown in all.
 * With a filter, only that group (up to `limit`).
 */
export function groupHits(hits: Hit[], labels: Record<string, string>, filter: string | null, limit = 10): Group[] {
  const groups = new Map<string, Group>()
  let shown = 0
  for (const h of hits) {
    const id = hitGroup(h)
    if (filter && id !== filter) continue
    if (shown >= limit) break
    if (!groups.has(id)) groups.set(id, { id, label: labels[id] ?? id, hits: [] })
    groups.get(id)!.hits.push(h)
    shown++
  }
  return [...groups.values()]
}

/** How many hits each group has, for the filter chips (only groups with matches get a chip). */
export function countGroups(hits: Hit[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const h of hits) counts.set(hitGroup(h), (counts.get(hitGroup(h)) ?? 0) + 1)
  return counts
}
