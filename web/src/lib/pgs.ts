/**
 * PGs and co-living in the home search: the files the pipeline writes (residential_pgs.json and its places
 * and drive-time files, loaded only when PGs are shown) and their match rules. Pure functions, apart from loading.
 *
 * The verdicts mean what they mean for societies (homes.ts):
 *   rent      the cheapest published starting price for the sharing chosen: within budget is a match when the
 *             page says "a month", likely when it gives no period; over budget is "no" per month, unknown
 *             without a period; unpublished is unknown
 *   sharing   offered is a match; a confirmed page listing only other room types is "no"; else unknown
 *   gender    from the operator's page or link, match or "no"; from the listing name, likely or "no"
 *   services  included is a match, "not included" is "no", unstated is unknown
 *   listing   (confirmed only) confirmed is a match, anything else "no"
 * Drive, neighbourhood, nearby places and metro use the societies' rules.
 */
import {
  commuteCheck,
  indexCommute,
  nearbyChecks,
  neighbourhoodCheck,
  rupees,
  worst,
  VERDICTS,
  type Assessment,
  type Check,
  type Commute,
  type CommuteFile,
  type Drive,
  type Gender,
  type LonLat,
  type NearbyCount,
  type Neighbourhood,
  type Preferences,
  type Service,
  type Sourced,
  type Station,
  type Verdict,
} from './homes'

export type PgStatus = 'confirmed' | 'probable' | 'unverified' | 'closed'

export interface Operator {
  id: string
  name: string
  site: string
  kind: string
  /** False when its robots.txt or terms forbid automated reading: nothing is taken from its pages. */
  read: boolean
  basis: string
  terms: string | null
  checked: string
}

/** One room type's published starting price. */
export interface PgRent {
  sharing: 'single' | 'double' | 'triple' | 'other'
  /** The page's own words, e.g. "Two Sharing". */
  label: string
  from_inr: number
  /** "month" when the page says so; null when it gives no period. */
  period: 'month' | null
  starting: boolean
  source: string
}

export interface Pg {
  id: string
  name: string
  operator: string | null
  kind: 'pg' | 'co-living'
  /** page: the operator's page says; link: the operator's page address says (/female/); name: the listing name says. */
  gender: { value: Gender; from: 'page' | 'link' | 'name'; source?: string } | null
  status: PgStatus
  lat: number
  lon: number
  location:
    | { from: 'overture'; listings: number; spread_m: number; listings_agree: boolean; others?: LonLat[] }
    | { from: 'source'; source: string }
  /** The operator's page for it (contact); null when unknown or gone. */
  page: string | null
  /** The date its page was found no longer listing it. */
  page_gone: string | null
  address: Sourced<string> | null
  rent: PgRent[]
  deposit: Sourced<string> | null
  services: Partial<Record<Service, Sourced<boolean>>>
  checked: string | null
  note: string | null
  overture: string[]
  neighbourhood: string | null
  neighbourhood_m: number | null
  nearby: Record<string, NearbyCount>
  metro: { id: string; name: string; m: number; drive_min: number | null } | null
}

export interface PgData {
  generated_at: string
  attribution: string
  statuses: Record<PgStatus, string>
  operators: Operator[]
  amenities: { categories: Record<string, string>; radius_m: number; measure: string; places_file: string }
  commute: { file: string | null; kind: string; metro: string }
  /** Neighbourhoods PGs use that the societies' file does not list (OpenStreetMap suburbs and towns). */
  neighbourhoods: Neighbourhood[]
  pgs: Pg[]
}

export interface PgHomes {
  data: PgData
  /** Null when the drive-time file is missing or unusable. */
  commute: Commute | null
  byId: Map<string, Pg>
  operators: Map<string, Operator>
  stations: Station[]
}

export const isPgId = (id: string) => id.startsWith('pg-') // the pipeline keeps society ids from starting so

export function indexPgs(data: PgData, commute: Commute | null, stations: Station[] = []): PgHomes {
  return {
    data,
    commute,
    byId: new Map(data.pgs.map((p) => [p.id, p])),
    operators: new Map(data.operators.map((o) => [o.id, o])),
    stations,
  }
}

let pending: Promise<PgHomes | null> | null = null

/** Loaded the first time PGs are shown (about 220 KB of PGs and 690 KB of drive times, gzipped). */
export function loadPgs(): Promise<PgHomes | null> {
  pending ??= (async () => {
    const r = await fetch('/data/residential_pgs.json')
    if (!r.ok) throw new Error(`${r.status}`)
    const data = (await r.json()) as PgData
    let commute: Commute | null = null
    let stations: Station[] = []
    try {
      const c = data.commute.file ? await fetch(`/data/${data.commute.file}`) : null
      if (c?.ok) {
        const file = (await c.json()) as Omit<CommuteFile, 'societies'> & { pgs: CommuteFile['societies'] }
        commute = indexCommute({ ...file, societies: file.pgs })
        stations = file.stations ?? []
      }
    } catch {
      // PGs still show without drive times
    }
    return indexPgs(data, commute, stations)
  })().catch(() => {
    pending = null // try again next time
    return null
  })
  return pending
}

// ---------------------------------------------------------------- assessment

export interface PgAssessment {
  pg: Pg
  verdict: Verdict
  checks: Check[]
  drive: Drive | null
}

export interface PgContext {
  pgs: PgHomes
  /** Every neighbourhood name: the societies' and the PGs' own. */
  hoods: Neighbourhood[]
  workplace: LonLat | null
}

export const GENDER_TEXT: Record<Gender, string> = { men: "Men's", women: "Women's", mixed: 'Men and women' }

/** Where a PG's gender came from, in words. */
export function genderFrom(p: Pg, ops: Map<string, Operator>): string {
  const op = p.operator ? ops.get(p.operator)?.name : null
  if (!p.gender) return ''
  if (p.gender.from === 'page') return `${op ?? 'the operator'}'s page`
  if (p.gender.from === 'link') return `${op ?? 'the operator'}'s page link`
  return "the listing's name"
}

/** Why nothing is published for a PG: its operator's pages may not be read, or nothing is known. */
function silence(p: Pg, ops: Map<string, Operator>): string {
  const op = p.operator ? ops.get(p.operator) : undefined
  if (op && !op.read) return `Not read: ${op.name}'s terms don't allow reading its pages.`
  if (p.status === 'confirmed') return "Not on the operator's page."
  return 'Not published.'
}

const SHARING_ORDER = ['single', 'double', 'triple', 'other']
const roomList = (rooms: PgRent[]) =>
  [...rooms].sort((a, b) => SHARING_ORDER.indexOf(a.sharing) - SHARING_ORDER.indexOf(b.sharing)).map((r) => r.label).join(', ')

/** The cheapest published starting price among the room types chosen (all of them when none is). */
export function cheapestRoom(p: Pg, prefs: Preferences): PgRent | null {
  const rooms = prefs.sharing.length ? p.rent.filter((r) => (prefs.sharing as string[]).includes(r.sharing)) : p.rent
  return rooms.length ? rooms.reduce((a, b) => (b.from_inr < a.from_inr ? b : a)) : null
}

function rentCheck(p: Pg, prefs: Preferences, ops: Map<string, Operator>): Check | null {
  if (prefs.budget === null) return null
  const check = (verdict: Verdict, why: string, source?: string): Check => ({ pref: 'budget', verdict, why, source })
  if (!p.rent.length) return check('unknown', silence(p, ops))
  const r = cheapestRoom(p, prefs)
  if (!r) return check('unknown', 'No price published for the sharing you chose.')
  const price = `${r.label} ${r.starting ? 'from ' : ''}${rupees(r.from_inr)}${r.period === 'month' ? ' a month' : ''}`
  if (r.from_inr <= prefs.budget)
    return r.period === 'month'
      ? check('match', `${price}, within your ${rupees(prefs.budget)}.`, r.source)
      : check('likely', `${price}, within your ${rupees(prefs.budget)}; the page gives no period.`, r.source)
  return r.period === 'month'
    ? check('no', `${price}, over your ${rupees(prefs.budget)}.`, r.source)
    : check('unknown', `${price}, over your ${rupees(prefs.budget)}, but the page gives no period.`, r.source)
}

function sharingCheck(p: Pg, prefs: Preferences, ops: Map<string, Operator>): Check | null {
  if (!prefs.sharing.length) return null
  const check = (verdict: Verdict, why: string, source?: string): Check => ({ pref: 'sharing', verdict, why, source })
  const offered = p.rent.filter((r) => (prefs.sharing as string[]).includes(r.sharing))
  if (offered.length) return check('match', `Offers ${roomList(offered)}.`, offered[0].source)
  if (!p.rent.length) return check('unknown', silence(p, ops))
  // A page's "Classic sharing" doesn't say how many share, so it can't rule a choice out.
  if (p.status === 'confirmed' && !p.rent.some((r) => r.sharing === 'other'))
    return check('no', `Lists only ${roomList(p.rent)}.`, p.rent[0].source)
  return check('unknown', `Lists ${roomList(p.rent)}; how many share is not stated.`, p.rent[0].source)
}

function genderCheck(p: Pg, prefs: Preferences, ops: Map<string, Operator>): Check | null {
  if (!prefs.gender.length) return null
  const check = (verdict: Verdict, why: string): Check => ({ pref: 'gender', verdict, why, source: p.gender?.source })
  if (!p.gender) return check('unknown', p.status === 'confirmed' ? "Not stated on the operator's page." : 'Not stated.')
  const said = `${GENDER_TEXT[p.gender.value]}, from ${genderFrom(p, ops)}`
  if (!prefs.gender.includes(p.gender.value)) return check('no', `${said}; not one you chose.`)
  return check(p.gender.from === 'name' ? 'likely' : 'match', `${said}.`)
}

export const SERVICE_TEXT: Record<Service, string> = { food: 'Food', wifi: 'Wi-Fi', ac: 'AC', laundry: 'Laundry', housekeeping: 'Housekeeping' }

function serviceCheck(p: Pg, service: Service, ops: Map<string, Operator>): Check {
  const s = p.services[service]
  const check = (verdict: Verdict, why: string): Check => ({ pref: 'service', service, verdict, why, source: s?.source })
  if (!s) return check('unknown', silence(p, ops))
  return s.value ? check('match', 'Included.') : check('no', 'Not included.')
}

function listingCheck(p: Pg, prefs: Preferences, data: PgData): Check | null {
  const check = (verdict: Verdict, why: string): Check => ({ pref: 'listing', verdict, why })
  if (p.status === 'closed') return check('no', data.statuses.closed)
  if (!prefs.confirmed) return null
  return p.status === 'confirmed'
    ? check('match', `Confirmed on the operator's page${p.checked ? `, ${p.checked}` : ''}.`)
    : check('no', `Not confirmed on the operator's page. ${data.statuses[p.status]}`)
}

export function assessPg(p: Pg, prefs: Preferences, ctx: PgContext): PgAssessment {
  const { data, commute, operators: ops } = ctx.pgs
  const drive = commute && ctx.workplace ? commute.drive(p.id, ctx.workplace) : null
  const checks = [
    listingCheck(p, prefs, data),
    rentCheck(p, prefs, ops),
    sharingCheck(p, prefs, ops),
    genderCheck(p, prefs, ops),
    ...prefs.services.map((s) => serviceCheck(p, s, ops)),
    commuteCheck(prefs, ctx.workplace, drive),
    neighbourhoodCheck(p.neighbourhood, prefs, ctx.hoods),
    ...nearbyChecks(p, prefs, data.amenities.radius_m),
  ].filter((c): c is Check => c !== null)
  return { pg: p, verdict: worst(checks.map((c) => c.verdict)), checks, drive }
}

export function assessAllPgs(prefs: Preferences, ctx: PgContext): PgAssessment[] {
  return ctx.pgs.data.pgs.map((p) => assessPg(p, prefs, ctx))
}

// ---------------------------------------------------------------- societies and PGs together

/** A society's or a PG's assessment. */
export type Found = Assessment | PgAssessment

export const isPg = (a: Found): a is PgAssessment => 'pg' in a
export const idOf = (a: Found) => (isPg(a) ? a.pg.id : a.society.id)
export const nameOf = (a: Found) => (isPg(a) ? a.pg.name : a.society.name)

/** Best verdict first, then shortest drive, then name. */
export function byFit(a: Found, b: Found): number {
  const minutes = (x: Found) => x.drive?.minutes ?? Infinity
  return VERDICTS.indexOf(a.verdict) - VERDICTS.indexOf(b.verdict) || minutes(a) - minutes(b) || nameOf(a).localeCompare(nameOf(b))
}
