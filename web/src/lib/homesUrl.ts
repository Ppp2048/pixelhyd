/**
 * Residential mode in the URL, so a shared link reopens the same search. Every parameter starts
 * with "h" and is present only while the mode is on:
 *   hw=<lat,lon of the workplace>  hl=<its name>  hs=<open society>  hx=<compared societies, in order>
 *   hb=<budget ₹/month>  hk=<BHK list>  hf=<furnishing>  hn=<neighbourhoods>  hc=<max drive min>  ha=<amenities>
 *   ht=pg|both (absent: societies)  hr=<sharing>  hg=<who can stay>  hi=<included services>  hv=1 (confirmed PGs only)
 */
import { MAX_COMPARE, type Furnishing, type Gender, type Preferences, type Service, type Sharing, type Show } from './homes'

export interface Workplace {
  lat: number
  lon: number
  label: string
}

export interface HomesUrl {
  workplace: Workplace
  prefs: Preferences
  society: string | null
  /** Societies compared side by side (at most MAX_COMPARE), numbered on the map in this order. */
  compare: string[]
}

const FURNISHING: Furnishing[] = ['furnished', 'semi-furnished', 'unfurnished']
const SHOW: Record<string, Show> = { pg: 'pgs', both: 'both' }
const SHOW_PARAM: Partial<Record<Show, string>> = { pgs: 'pg', both: 'both' }
const SHARING: Sharing[] = ['single', 'double', 'triple']
const GENDER: Gender[] = ['men', 'women', 'mixed']
const SERVICES: Service[] = ['food', 'wifi', 'ac', 'laundry', 'housekeeping']
/** The listed values among `allowed`, once each. */
const only = <T extends string>(v: string | null, allowed: T[]) => [...new Set(list(v))].filter((x): x is T => (allowed as string[]).includes(x))
const list = (v: string | null) => (v ? v.split(',').filter(Boolean) : [])
const positive = (v: string | null) => {
  const n = v === null ? NaN : Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

export function decodeHomes(q: URLSearchParams): HomesUrl | undefined {
  const [lat, lon] = (q.get('hw') ?? '').split(',').map(Number)
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return undefined
  const furnishing = q.get('hf') as Furnishing | null
  return {
    workplace: { lat, lon, label: q.get('hl') || 'Chosen workplace' },
    society: q.get('hs') || null,
    compare: [...new Set(list(q.get('hx')))].slice(0, MAX_COMPARE),
    prefs: {
      show: SHOW[q.get('ht') ?? ''] ?? 'societies',
      budget: positive(q.get('hb')),
      bhk: list(q.get('hk')).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 4),
      furnishing: furnishing && FURNISHING.includes(furnishing) ? furnishing : null,
      neighbourhoods: list(q.get('hn')),
      maxCommute: positive(q.get('hc')),
      amenities: list(q.get('ha')),
      sharing: only(q.get('hr'), SHARING),
      gender: only(q.get('hg'), GENDER),
      services: only(q.get('hi'), SERVICES),
      confirmed: q.get('hv') === '1',
    },
  }
}

export function encodeHomes(h: HomesUrl): [string, string][] {
  const p = h.prefs
  const out: [string, string][] = [['hw', `${h.workplace.lat.toFixed(6)},${h.workplace.lon.toFixed(6)}`], ['hl', h.workplace.label]]
  if (p.budget !== null) out.push(['hb', String(p.budget)])
  if (p.bhk.length) out.push(['hk', p.bhk.join(',')])
  if (p.furnishing) out.push(['hf', p.furnishing])
  if (p.neighbourhoods.length) out.push(['hn', p.neighbourhoods.join(',')])
  if (p.maxCommute !== null) out.push(['hc', String(p.maxCommute)])
  if (p.amenities.length) out.push(['ha', p.amenities.join(',')])
  if (SHOW_PARAM[p.show]) out.push(['ht', SHOW_PARAM[p.show]!])
  if (p.sharing.length) out.push(['hr', p.sharing.join(',')])
  if (p.gender.length) out.push(['hg', p.gender.join(',')])
  if (p.services.length) out.push(['hi', p.services.join(',')])
  if (p.confirmed) out.push(['hv', '1'])
  if (h.society) out.push(['hs', h.society])
  if (h.compare.length) out.push(['hx', h.compare.join(',')])
  return out
}
