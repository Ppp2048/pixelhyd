/**
 * The URL always describes what is on screen, in real coordinates:
 *   ?d=<dataset>&lat=<WGS84>&lon=<WGS84>&z=<zoom>&b=<building id>
 * It is written only after camera movement settles and is re-read on
 * back/forward navigation, so shared links always match the view.
 */

export interface ViewState {
  dataset?: string
  lat?: number
  lon?: number
  zoom?: number
  building?: string
}

const num = (v: string | null) => {
  if (v === null || v.trim() === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

export function readUrl(search = window.location.search): ViewState {
  const q = new URLSearchParams(search)
  return {
    dataset: q.get('d') ?? undefined,
    lat: num(q.get('lat')),
    lon: num(q.get('lon')),
    zoom: num(q.get('z')),
    building: q.get('b') ?? undefined,
  }
}

export function writeUrl(s: ViewState): void {
  const q = new URLSearchParams()
  if (s.dataset) q.set('d', s.dataset)
  if (s.lat !== undefined) q.set('lat', s.lat.toFixed(6))
  if (s.lon !== undefined) q.set('lon', s.lon.toFixed(6))
  if (s.zoom !== undefined) q.set('z', s.zoom.toFixed(2))
  if (s.building) q.set('b', s.building)
  const next = `${window.location.pathname}?${q.toString()}`
  if (next !== `${window.location.pathname}${window.location.search}`) {
    window.history.replaceState(null, '', next)
  }
}
