/** The citywide place index (web/public/data/places.json, built by `hitec-pipeline places`). */

export interface Place {
  /** OSM id, e.g. w28268610: stable across rebuilds. */
  id: string
  name: string
  cat: string
  kind: string
  lat: number
  lon: number
  /** [west, south, east, north] for areas and streets. */
  bbox: [number, number, number, number] | null
  /** The map's building id when the place is a named building. */
  buildingId: string | null
  /** The nearest locality, for a second line ("Hospital · Banjara Hills"). */
  context: string | null
  alt: string[]
}

export interface Places {
  places: Place[]
  categories: Record<string, string>
  attribution: string
}

type Row = [string, string, string, number, number, Place['bbox'], string | null, string | null, string, string | null]

let pending: Promise<Places | null> | null = null

/** Loaded once, on first use of search (about 0.6 MB compressed). */
export function loadPlaces(): Promise<Places | null> {
  pending ??= fetch('/data/places.json')
    .then((r) => (r.ok ? r.json() : null))
    .then((d: { places: Row[]; categories: Record<string, string>; attribution: string } | null) =>
      d
        ? {
            categories: d.categories,
            attribution: d.attribution,
            places: d.places.map(([name, cat, kind, lat, lon, bbox, buildingId, context, id, alt]) => ({
              id, name, cat, kind, lat, lon, bbox, buildingId, context, alt: alt ? alt.split(';') : [],
            })),
          }
        : null,
    )
    .catch(() => {
      pending = null // try again next time
      return null
    })
  return pending
}

export const osmUrl = (osmId: string | null) => {
  if (!osmId) return null
  const type = { w: 'way', r: 'relation', n: 'node' }[osmId[0]]
  return type ? `https://www.openstreetmap.org/${type}/${osmId.slice(1)}` : null
}

/** A source link's label: its host name without "www.". */
export const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}
