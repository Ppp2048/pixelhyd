/**
 * Residential discovery: the files the pipeline writes (residential.json, residential_places.json,
 * residential_commute.json), the workplace drive-time grid, and the match rules. Pure functions only.
 *
 * Each preference gets a verdict that says how far the data supports it:
 *   match   – a published or mapped fact (developer page, listed place, metro station)
 *   likely  – an estimate fits: an area rent benchmark, or a drive time without traffic
 *   unknown – no data; never counts as a pass
 *   no      – the data says it fails
 * A society's overall verdict is its weakest check.
 */
import { wgsToUtm } from './projection'
import { ageText, rentAge } from './freshness'

// ---------------------------------------------------------------- data files

export type AreaType = 'carpet' | 'built_up' | 'super_built_up' | 'unspecified'

/** A fact with the page it was taken from. */
export interface Sourced<T> {
  value: T
  source: string
}

export interface SocietyFacts {
  status?: Sourced<string>
  land_acres?: Sourced<number>
  open_space_pct?: Sourced<number>
  towers?: Sourced<number>
  floors?: Sourced<string>
  units?: Sourced<number>
  rera?: Sourced<string>
  bhk?: Sourced<number[]>
  size_range_sqft?: Sourced<[number, number]> & { area_type: AreaType }
  clubhouse_sqft?: Sourced<number>
  amenities?: Sourced<string[]>
}

export interface UnitConfiguration {
  label?: string | null
  bhk: number
  /** [min, max] in the area type the source uses (most pages don't say which). */
  area_sqft?: [number, number] | null
  area_type?: AreaType
  /** Bedroom [short, long] sides in feet, only where a source publishes them. */
  bedrooms_ft?: [number, number][]
  source: string
}

/** Listed places of one category within the radius, measured in a straight line from the society boundary. */
export interface NearbyCount {
  count: number
  /** The places counted, nearest first (ids in the places file). */
  ids?: string[]
  /** The nearest listed place, kept up to 1.5 km away even when none is within the radius. */
  nearest: { id: string; name: string | null; m: number; source: string } | null
}

export interface Society {
  id: string
  name: string
  developer: string | null
  neighbourhood: string | null
  neighbourhood_m: number | null
  /** researched: facts copied from cited pages; mapped: only located on the map. */
  research: 'researched' | 'mapped'
  match: string
  site: { osm_id: string; name: string | null } | null
  location_source: string | null
  lat: number
  lon: number
  /** The middle of its mapped buildings (area-weighted footprints), where the map marks it; null without them. */
  centre?: { lat: number; lon: number } | null
  /** Map building ids inside the society. */
  buildings: string[]
  facts: SocietyFacts
  configurations: UnitConfiguration[]
  note: string | null
  last_checked: string | null
  nearby: Record<string, NearbyCount>
  /** Nearest metro station, straight line from the boundary; drive_min is an estimate without traffic. */
  metro: { id: string; name: string; m: number; drive_min: number | null } | null
}

/** A published average rent for an area (not for any one society). */
export interface RentBenchmark {
  id: string
  area: string
  neighbourhood: string
  bhk: number
  size_sqft: number
  rent_month: number
  period: string
  publisher: string
  via: string
  source: string
}

export interface Neighbourhood {
  id: string
  name: string
  lat: number
  lon: number
  osm_id: string
}

export interface ResidentialData {
  generated_at: string
  attribution: string
  amenities: { categories: Record<string, string>; radius_m: number; measure: string; places_file: string }
  commute: { file: string; kind: string; metro: string }
  benchmarks: RentBenchmark[]
  neighbourhoods: Neighbourhood[]
  societies: Society[]
}

export interface PlacesFile {
  generated_at: string
  attribution: string
  categories: Record<string, string>
  /** Column names of each row in `places`. */
  fields: string[]
  places: (string | number | null)[][]
}

export interface NearbyPlace {
  id: string
  name: string | null
  cat: string
  source: string
  lat: number
  lon: number
}

/** A Hyderabad Metro station (OpenStreetMap). */
export interface Station {
  id: string
  name: string
  lat: number
  lon: number
}

export interface CommuteGrid {
  crs: string
  origin_e: number
  origin_n: number
  cell_m: number
  cols: number
  rows: number
  order: string
}

export interface CommuteFile {
  generated_at: string
  attribution: string
  method: { missing: { minutes: number; hm: number } } & Record<string, unknown>
  grid: CommuteGrid
  graph: { nodes: number; main_network: number; edges: number }
  stations: Station[]
  /** Per society, base64 of one value per grid cell: minutes (uint8) and route hectometres (uint16 LE). */
  societies: Record<string, { minutes: string; hm: string; gates: number }>
}

/** Rows of residential_places.json as objects. */
export function listPlaces(file: PlacesFile): NearbyPlace[] {
  const col = (f: string) => {
    const i = file.fields.indexOf(f)
    if (i < 0) throw new Error(`places file has no "${f}" field`)
    return i
  }
  const [id, name, cat, source, lat, lon] = ['id', 'name', 'cat', 'source', 'lat', 'lon'].map(col)
  return file.places.map((r) => ({
    id: String(r[id]),
    name: r[name] === null ? null : String(r[name]),
    cat: String(r[cat]),
    source: String(r[source]),
    lat: Number(r[lat]),
    lon: Number(r[lon]),
  }))
}

// ---------------------------------------------------------------- commute grid

export interface LonLat {
  lon: number
  lat: number
}

/** An estimated drive: assumed free-flow speeds per road class, no traffic data. */
export interface Drive {
  minutes: number
  km: number | null
}

export interface Commute {
  /** The grid cell holding a point (row-major from the south-west corner), or null outside the grid. */
  cell(p: LonLat): number | null
  /** Estimated drive from a society to the workplace's cell, or null where there is no estimate. */
  drive(societyId: string, workplace: LonLat): Drive | null
}

const UTM_44N = 'EPSG:32644' // the zone wgsToUtm projects to

export function indexCommute(file: CommuteFile): Commute {
  const g = file.grid
  if (g.crs !== UTM_44N) throw new Error(`commute grid is in ${g.crs}, expected ${UTM_44N}`)
  const cells = g.cols * g.rows
  const none = file.method.missing
  const decoded = new Map<string, { minutes: Uint8Array; hm: DataView } | null>()
  const packed = (sid: string) => {
    if (!decoded.has(sid)) {
      const s = file.societies[sid]
      const minutes = s ? bytes(s.minutes) : null
      const hm = s ? bytes(s.hm) : null
      // A missing or short array means no estimates for that society, rather than wrong ones.
      const ok = minutes && hm && minutes.length === cells && hm.length === 2 * cells
      decoded.set(sid, ok ? { minutes, hm: new DataView(hm.buffer) } : null)
    }
    return decoded.get(sid) ?? null
  }
  const cell = ({ lon, lat }: LonLat) => {
    const [e, n] = wgsToUtm(lon, lat)
    const col = Math.floor((e - g.origin_e) / g.cell_m)
    const row = Math.floor((n - g.origin_n) / g.cell_m)
    return col >= 0 && col < g.cols && row >= 0 && row < g.rows ? row * g.cols + col : null
  }
  return {
    cell,
    drive(sid, workplace) {
      const i = cell(workplace)
      const p = packed(sid)
      if (i === null || !p || p.minutes[i] === none.minutes) return null
      const hm = p.hm.getUint16(2 * i, true)
      return { minutes: p.minutes[i], km: hm === none.hm ? null : hm / 10 }
    },
  }
}

function bytes(b64: string): Uint8Array {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

// ---------------------------------------------------------------- preferences and verdicts

export type Verdict = 'match' | 'likely' | 'unknown' | 'no'
/** Best first. */
export const VERDICTS: Verdict[] = ['match', 'likely', 'unknown', 'no']
const rank = (v: Verdict) => VERDICTS.indexOf(v)

/** The weakest of several verdicts. With nothing to judge it is unknown, which never passes. */
export function worst(vs: Verdict[]): Verdict {
  return vs.length ? vs.reduce((a, b) => (rank(b) > rank(a) ? b : a)) : 'unknown'
}

export type Furnishing = 'furnished' | 'semi-furnished' | 'unfurnished'

/** The amenity "a metro station within METRO_M"; every other amenity is a place category. */
export const METRO = 'metro'
export const METRO_M = 1000

/** Which homes the search shows: housing societies, PGs and co-living (pgs.ts), or both. */
export type Show = 'societies' | 'pgs' | 'both'
export type Sharing = 'single' | 'double' | 'triple'
export type Gender = 'men' | 'women' | 'mixed'
export type Service = 'food' | 'wifi' | 'ac' | 'laundry' | 'housekeeping'

export interface Preferences {
  show: Show
  /** Monthly rent in rupees; null: no limit. */
  budget: number | null
  /** Bedrooms wanted, 1–4 where 4 means 4 or more; empty: any. A 2.5 BHK counts as 2. */
  bhk: number[]
  furnishing: Furnishing | null
  /** Neighbourhood ids; empty: anywhere. */
  neighbourhoods: string[]
  /** Longest acceptable drive to the workplace, in minutes; null: no limit. */
  maxCommute: number | null
  /** Place categories that must be listed nearby, and/or METRO. */
  amenities: string[]
  // PGs only (societies ignore them, as PGs ignore BHK and furnishing)
  /** Room sharing wanted; empty: any. A private room counts as single. */
  sharing: Sharing[]
  /** Which PGs would suit: men's, women's and/or mixed; empty: any. */
  gender: Gender[]
  /** Services that must be included. */
  services: Service[]
  /** Only PGs confirmed on the operator's own page. */
  confirmed: boolean
}

export const NO_PREFERENCES: Preferences = {
  show: 'societies',
  budget: null,
  bhk: [],
  furnishing: null,
  neighbourhoods: [],
  maxCommute: null,
  amenities: [],
  sharing: [],
  gender: [],
  services: [],
  confirmed: false,
}

/** Where a new search starts: one preference, so the map shows something to act on. */
export const DEFAULT_PREFERENCES: Preferences = { ...NO_PREFERENCES, maxCommute: 30 }

export type Preference =
  | 'budget' | 'bhk' | 'furnishing' | 'commute' | 'neighbourhood' | 'amenity'
  | 'sharing' | 'gender' | 'service' | 'listing'

export interface Check {
  pref: Preference
  /** For amenity checks: the place category, or METRO. */
  amenity?: string
  /** For service checks (PGs): the service. */
  service?: Service
  verdict: Verdict
  /** Plain-language reason for the society card. */
  why: string
  /** The page the deciding fact came from, where there is one. */
  source?: string
}

export interface Assessment {
  society: Society
  verdict: Verdict
  /** One per preference that is set, in the order of Preferences. */
  checks: Check[]
  /** Estimated drive to the workplace, kept even without a commute preference. */
  drive: Drive | null
}

export interface Context {
  data: ResidentialData
  commute: Commute | null
  workplace: LonLat | null
  /** Today, for the age of published figures (default: the clock). */
  now?: Date
}

export function assess(s: Society, prefs: Preferences, ctx: Context): Assessment {
  const drive = ctx.commute && ctx.workplace ? ctx.commute.drive(s.id, ctx.workplace) : null
  const checks = [
    budgetCheck(s, prefs, ctx.data, ctx.now ?? new Date()),
    bhkCheck(s, prefs),
    furnishingCheck(prefs),
    commuteCheck(prefs, ctx.workplace, drive),
    neighbourhoodCheck(s.neighbourhood, prefs, ctx.data.neighbourhoods),
    ...nearbyChecks(s, prefs, ctx.data.amenities.radius_m),
  ].filter((c): c is Check => c !== null)
  return { society: s, verdict: worst(checks.map((c) => c.verdict)), checks, drive }
}

/** Every society, best verdict first, then shortest drive, then name. */
export function assessAll(prefs: Preferences, ctx: Context): Assessment[] {
  const minutes = (a: Assessment) => a.drive?.minutes ?? Infinity
  return ctx.data.societies
    .map((s) => assess(s, prefs, ctx))
    .sort(
      (a, b) =>
        rank(a.verdict) - rank(b.verdict) || minutes(a) - minutes(b) || a.society.name.localeCompare(b.society.name),
    )
}

export function tally(assessments: { verdict: Verdict }[]): Record<Verdict, number> {
  const out: Record<Verdict, number> = { match: 0, likely: 0, unknown: 0, no: 0 }
  for (const a of assessments) out[a.verdict]++
  return out
}

/** How many homes each preference rules out (a "no"), to show which choice is filtering. */
export function ruledOut(assessments: { checks: Check[] }[]): Record<Preference, number> {
  const out: Record<Preference, number> = {
    budget: 0, bhk: 0, furnishing: 0, commute: 0, neighbourhood: 0, amenity: 0, sharing: 0, gender: 0, service: 0, listing: 0,
  }
  for (const a of assessments)
    for (const p of new Set(a.checks.filter((c) => c.verdict === 'no').map((c) => c.pref))) out[p]++
  return out
}

/** BHK types a society has, from its published facts and unit configurations. */
export function bhkOf(s: Society): number[] {
  return [...new Set([...(s.facts.bhk?.value ?? []), ...s.configurations.map((c) => c.bhk)])].sort((a, b) => a - b)
}

const wants = (pref: number[], bhk: number) => pref.some((p) => (p >= 4 ? bhk >= 4 : Math.floor(bhk) === p))

/** How old an area rent figure is, in words, or null while it is current (see freshness.ts). */
export function rentAgeNote(b: RentBenchmark, now: Date): string | null {
  const { freshness, months } = rentAge(b.period, now)
  if (freshness === 'current') return null
  if (months === null) return `The figure's date (${b.period}) is unclear, so it can't decide a budget.`
  const old = `The figure is for ${b.period}, ${ageText(months, 'month')} old`
  return freshness === 'dated'
    ? `${old}; rents may have changed since.`
    : `${old}, too old to decide a budget.`
}

/**
 * Rent is only published per area, so a budget can at best make a society "likely", never "no". A figure
 * older than a year (freshness.RENT_DATED_MONTHS) is marked; one too old (or undated) can't decide a budget at all.
 */
function budgetCheck(s: Society, prefs: Preferences, data: ResidentialData, now: Date): Check | null {
  if (prefs.budget === null) return null
  const check = (verdict: Verdict, why: string, source?: string): Check => ({ pref: 'budget', verdict, why, source })
  const b = data.benchmarks.find((x) => x.neighbourhood === s.neighbourhood)
  if (!b) return check('unknown', `No published rent for ${hoodName(s, data) ?? 'this area'}.`)
  const average =
    `${b.area} averages ${rupees(b.rent_month)} a month for a ${b.size_sqft.toLocaleString('en-IN')} sq ft ` +
    `${b.bhk}BHK (${b.publisher}, ${b.period})`
  const own = "This society's rents aren't published."
  const age = rentAgeNote(b, now)
  const aged = age ? ` ${age}` : ''
  if (prefs.bhk.length && !wants(prefs.bhk, b.bhk))
    return check('unknown', `${average}; no rent is published for the BHK you chose.${aged}`, b.source)
  if (rentAge(b.period, now).freshness === 'expired') return check('unknown', `${average}. ${own}${aged}`, b.source)
  return prefs.budget >= b.rent_month
    ? check('likely', `${average}, within your budget. ${own}${aged}`, b.source)
    : check('unknown', `${average}, above your ${rupees(prefs.budget)}. ${own}${aged}`, b.source)
}

function bhkCheck(s: Society, prefs: Preferences): Check | null {
  if (!prefs.bhk.length) return null
  const has = bhkOf(s)
  if (!has.length) return { pref: 'bhk', verdict: 'unknown', why: 'BHK types are not published.' }
  const source = s.facts.bhk?.source ?? s.configurations[0]?.source
  return has.some((b) => wants(prefs.bhk, b))
    ? { pref: 'bhk', verdict: 'match', why: `Has ${formatBhk(has)} homes.`, source }
    : { pref: 'bhk', verdict: 'no', why: `Only ${formatBhk(has)} homes.`, source }
}

function furnishingCheck(prefs: Preferences): Check | null {
  return prefs.furnishing === null
    ? null
    : { pref: 'furnishing', verdict: 'unknown', why: 'No furnishing data for any society yet.' }
}

/** Drive times have no traffic, so a fit is only "likely"; traffic only lengthens a drive, so over the limit is "no". */
export function commuteCheck(prefs: Preferences, workplace: LonLat | null, drive: Drive | null): Check | null {
  if (prefs.maxCommute === null) return null
  const check = (verdict: Verdict, why: string): Check => ({ pref: 'commute', verdict, why })
  if (!workplace) return check('unknown', 'No workplace chosen.')
  if (!drive) return check('unknown', 'No drive estimate to this workplace.')
  const km = drive.km === null ? '' : ` (${drive.km.toFixed(1)} km)`
  const estimate = `≈${drive.minutes} min drive${km} with no traffic, an estimate`
  return drive.minutes <= prefs.maxCommute
    ? check('likely', `${estimate}.`)
    : check('no', `${estimate}; over your ${prefs.maxCommute} min.`)
}

/** `hood` is the home's neighbourhood id; `hoods` names them. */
export function neighbourhoodCheck(hood: string | null, prefs: Preferences, hoods: Neighbourhood[]): Check | null {
  if (!prefs.neighbourhoods.length) return null
  const name = hoods.find((h) => h.id === hood)?.name
  if (!hood || !name) return { pref: 'neighbourhood', verdict: 'unknown', why: 'Neighbourhood not known.' }
  return prefs.neighbourhoods.includes(hood)
    ? { pref: 'neighbourhood', verdict: 'match', why: `In ${name}.` }
    : { pref: 'neighbourhood', verdict: 'no', why: `In ${name}, not one you picked.` }
}

/** What nearby-place checks need of a home (a society or a PG). */
export interface NearbyHome {
  nearby: Record<string, NearbyCount>
  metro: { id: string; name: string; m: number; drive_min: number | null } | null
}

/** One check per wanted place category, or METRO. */
export const nearbyChecks = (home: NearbyHome, prefs: Preferences, radiusM: number): Check[] =>
  prefs.amenities.map((a) => (a === METRO ? metroCheck(home) : amenityCheck(home, a, radiusM)))

/** Listed places only: OpenStreetMap and Overture can miss a place, which the reason says. */
function amenityCheck(s: NearbyHome, cat: string, radiusM: number): Check {
  const check = (verdict: Verdict, why: string): Check => ({ pref: 'amenity', amenity: cat, verdict, why })
  const n = s.nearby[cat]
  const within = `within ${distance(radiusM)}`
  if (!n) return check('unknown', 'No data.')
  if (n.count > 0) {
    const nearest = n.nearest ? `; nearest: ${n.nearest.name ?? 'unnamed'}, ${distance(n.nearest.m)}` : ''
    return check('match', `${n.count} listed ${within}${nearest}.`)
  }
  return check('no', `None listed ${within}${n.nearest ? `; nearest ${distance(n.nearest.m)} away` : ''}.`)
}

function metroCheck(s: NearbyHome): Check {
  const check = (verdict: Verdict, why: string): Check => ({ pref: 'amenity', amenity: METRO, verdict, why })
  const m = s.metro
  if (!m) return check('unknown', 'No metro station data.')
  return m.m <= METRO_M
    ? check('match', `${m.name} station, ${distance(m.m)} away.`)
    : check('no', `Nearest station: ${m.name}, ${distance(m.m)} away.`)
}

// ---------------------------------------------------------------- loading

export interface Homes {
  data: ResidentialData
  /** Null when the drive-time file is missing or unusable: commute checks are then unknown. */
  commute: Commute | null
  byId: Map<string, Society>
  /** Map building id → the society it belongs to. */
  byBuilding: Map<string, Society>
  /** Metro stations by id (from the drive-time file; empty without it). */
  stations: Map<string, Station>
}

export function indexHomes(data: ResidentialData, commute: Commute | null, stations: Station[] = []): Homes {
  return {
    data,
    commute,
    byId: new Map(data.societies.map((s) => [s.id, s])),
    byBuilding: new Map(data.societies.flatMap((s) => s.buildings.map((b) => [b, s] as const))),
    stations: new Map(stations.map((x) => [x.id, x])),
  }
}

let pending: Promise<Homes | null> | null = null

/** Loaded on first use of residential mode (about 100 KB of societies and 270 KB of drive times). */
export function loadHomes(): Promise<Homes | null> {
  pending ??= (async () => {
    const r = await fetch('/data/residential.json')
    if (!r.ok) throw new Error(`${r.status}`)
    const data = (await r.json()) as ResidentialData
    let commute: Commute | null = null
    let stations: Station[] = []
    try {
      const c = await fetch(`/data/${data.commute.file}`)
      if (c.ok) {
        const file = (await c.json()) as CommuteFile
        commute = indexCommute(file)
        stations = file.stations ?? []
      }
    } catch {
      // societies still show without drive times
    }
    return indexHomes(data, commute, stations)
  })().catch(() => {
    pending = null // try again next time
    return null
  })
  return pending
}

/** Where the map marks a society: the middle of its buildings, else its recorded point. [lon, lat] */
export const markAt = (s: Society): [number, number] => (s.centre ? [s.centre.lon, s.centre.lat] : [s.lon, s.lat])

const placesPending = new Map<string, Promise<Map<string, NearbyPlace> | null>>()

/**
 * Listed places by id from a places file (the societies' is about 150 KB, the PGs' about 120 KB gzipped),
 * loaded the first time a comparison needs them.
 */
export function loadNearbyPlaces(file: string): Promise<Map<string, NearbyPlace> | null> {
  let p = placesPending.get(file)
  if (!p) {
    p = (async () => {
      const r = await fetch(`/data/${file}`)
      if (!r.ok) throw new Error(`${r.status}`)
      return new Map(listPlaces((await r.json()) as PlacesFile).map((x) => [x.id, x]))
    })().catch(() => {
      placesPending.delete(file) // try again next time
      return null
    })
    placesPending.set(file, p)
  }
  return p
}

// ---------------------------------------------------------------- comparison

/** At most this many societies side by side. */
export const MAX_COMPARE = 3

/** A place lit on the map while a comparison row is hovered; `near` lists the compared societies (1-based). */
export interface LitPlace {
  id: string
  name: string | null
  lon: number
  lat: number
  near: number[]
}

/**
 * The places behind one comparison row, for each compared society in order: the listed places of a
 * category within the radius (or the nearest one when none is), or the nearest metro station.
 */
export function litPlaces(societies: NearbyHome[], row: string, places: Map<string, NearbyPlace>, stations: Map<string, Station>): LitPlace[] {
  const out = new Map<string, LitPlace>()
  societies.forEach((s, i) => {
    let ids: string[]
    if (row === METRO) ids = s.metro ? [s.metro.id] : []
    else {
      const n = s.nearby[row]
      ids = n?.ids?.length ? n.ids : n?.nearest ? [n.nearest.id] : []
    }
    for (const id of ids) {
      const p = row === METRO ? stations.get(id) : places.get(id)
      if (!p) continue
      const lit = out.get(id) ?? { id, name: p.name, lon: p.lon, lat: p.lat, near: [] }
      lit.near.push(i + 1)
      out.set(id, lit)
    }
  })
  return [...out.values()]
}

// ---------------------------------------------------------------- wording

const hoodName = (s: Society, data: ResidentialData) =>
  data.neighbourhoods.find((h) => h.id === s.neighbourhood)?.name ?? null

const rupees = (n: number) => `₹${n.toLocaleString('en-IN')}`

export { rupees }

/** Metres as "820 m" or "4.7 km"; 0 (touching or inside the boundary) as "at the site". */
export function distance(m: number): string {
  const r = Math.round(m / 10) * 10
  if (r === 0) return 'at the site'
  return r < 1000 ? `${r} m` : `${(r / 1000).toFixed(1).replace(/\.0$/, '')} km`
}

/** [2, 2.5, 3] as "2, 2.5 and 3 BHK". */
export const formatBhk = (xs: number[]) =>
  `${xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`} BHK`
