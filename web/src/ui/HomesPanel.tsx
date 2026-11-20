import { useMemo, type ReactNode } from 'react'
import {
  METRO,
  METRO_M,
  distance,
  ruledOut,
  tally,
  type Furnishing,
  type Gender,
  type Homes,
  type Neighbourhood,
  type Preferences,
  type Service,
  type Sharing,
  type Show,
} from '../lib/homes'
import { cheapestRoom, idOf, isPg, nameOf, SERVICE_TEXT, type Found, type PgHomes } from '../lib/pgs'
import type { Workplace } from '../lib/homesUrl'
import { CloseIcon, HomeIcon } from './icons'
import { rupees } from './homesText'

const SOCIETY_BUDGETS = [25000, 30000, 35000, 40000, 50000, 60000, 80000, 100000]
const PG_BUDGETS = [6000, 8000, 10000, 12000, 15000, 20000, 25000]
const DRIVES = [10, 15, 20, 30, 45, 60]
const FURNISHING: { value: Furnishing; label: string }[] = [
  { value: 'furnished', label: 'Furnished' },
  { value: 'semi-furnished', label: 'Semi-furnished' },
  { value: 'unfurnished', label: 'Unfurnished' },
]
const SHOW: { value: Show; label: string }[] = [
  { value: 'societies', label: 'Societies' },
  { value: 'pgs', label: 'PGs & co-living' },
  { value: 'both', label: 'Both' },
]
const SHARING: { value: Sharing; label: string }[] = [
  { value: 'single', label: 'Single' },
  { value: 'double', label: 'Double' },
  { value: 'triple', label: 'Triple' },
]
const GENDER: { value: Gender; label: string }[] = [
  { value: 'men', label: "Men's" },
  { value: 'women', label: "Women's" },
  { value: 'mixed', label: 'Mixed' },
]

interface Props {
  workplace: Workplace
  /** Null while loading (or after a failed load). */
  homes: Homes | null
  failed: boolean
  /** PGs, loaded when first shown; null until then (or after a failed load). */
  pgs: PgHomes | null
  pgsFailed: boolean
  /** Every neighbourhood name, the societies' and the PGs'. */
  hoods: Neighbourhood[]
  prefs: Preferences
  onPrefs: (p: Preferences) => void
  /** The homes of the kinds shown, best fit first. */
  found: Found[]
  onOpen: (id: string) => void
  /** Compared home ids, in their map numbers' order. */
  compare: string[]
  onClose: () => void
}

const toggle = <T,>(xs: T[], x: T) => (xs.includes(x) ? xs.filter((y) => y !== x) : [...xs, x])

/** A preference's heading, with how many homes it rules out. */
function Field({ label, out, children, note }: { label: string; out?: number; children: ReactNode; note?: string }) {
  return (
    <div className="field" role="group" aria-label={label}>
      <span className="field-head">
        {label}
        {out ? <span className="out">rules out {out}</span> : null}
      </span>
      {children}
      {note ? <small>{note}</small> : null}
    </div>
  )
}

/** Residential mode's panel, in the card's place: what to show, preferences, the verdict count and the homes shown. */
export function HomesPanel({ workplace, homes, failed, pgs, pgsFailed, hoods: allHoods, prefs, onPrefs, found, onOpen, compare, onClose }: Props) {
  const set = (p: Partial<Preferences>) => onPrefs({ ...prefs, ...p })
  const counts = tally(found)
  const out = ruledOut(found)
  const shown = found.filter((a) => a.verdict !== 'no')
  const data = homes?.data
  const showSocieties = prefs.show !== 'pgs'
  const showPgs = prefs.show !== 'societies'
  const both = prefs.show === 'both'
  // Neighbourhoods that have at least one home of the kinds shown, in name order.
  const hoods = useMemo(() => {
    const used = new Set([
      ...(showSocieties ? (data?.societies ?? []).map((s) => s.neighbourhood) : []),
      ...(showPgs ? (pgs?.data.pgs ?? []).map((p) => p.neighbourhood) : []),
    ])
    return allHoods.filter((h) => used.has(h.id)).sort((a, b) => a.name.localeCompare(b.name))
  }, [data, pgs, allHoods, showSocieties, showPgs])
  const outside = homes?.commute ? homes.commute.cell(workplace) === null : false
  const budgets = useMemo(() => {
    const xs = new Set([...(showSocieties ? SOCIETY_BUDGETS : []), ...(showPgs ? PG_BUDGETS : [])])
    if (prefs.budget !== null) xs.add(prefs.budget) // a budget kept from the other kind of home
    return [...xs].sort((a, b) => a - b)
  }, [showSocieties, showPgs, prefs.budget])
  const kind = both ? 'Homes' : showPgs ? 'PGs' : 'Societies'
  const pgNote = (note: string) => (both ? `PGs only. ${note}` : note)

  return (
    <aside className="panel card homes" aria-label="Find homes">
      <button className="icon-btn ghost card-close" onClick={onClose} aria-label="Close home search">
        <CloseIcon size={16} />
      </button>
      <div className="company-head">
        <span className="monogram large" aria-hidden="true">
          <HomeIcon />
        </span>
        <div>
          <p className="sub">Homes near</p>
          <h2>{workplace.label}</h2>
        </div>
      </div>

      {!data ? (
        failed ? (
          <p className="caution">Residential data could not be loaded. Close this and try again.</p>
        ) : (
          <p className="muted">Loading societies…</p>
        )
      ) : (
        <>
          <p className="tally" aria-live="polite">
            <span className="chip v-match">{counts.match} match</span>
            <span className="chip v-likely">{counts.likely} likely</span>
            <span className="chip v-unknown">{counts.unknown} unknown</span>
            {counts.no ? <span className="muted small">{counts.no} hidden</span> : null}
          </p>
          {outside ? <p className="caution">Drive times cover west Hyderabad only, and this workplace is outside them.</p> : null}

          <Field
            label="Show"
            note={showPgs ? "PG locations come from open-data listings; rents and services only from operators' own pages." : undefined}
          >
            <div className="chips">
              {SHOW.map((s) => (
                <button key={s.value} className="filter" aria-pressed={prefs.show === s.value} onClick={() => set({ show: s.value })}>
                  {s.label}
                </button>
              ))}
            </div>
          </Field>
          {showPgs && !pgs ? (
            pgsFailed ? (
              <p className="caution">PG data could not be loaded. Choose Societies, or close this and try again.</p>
            ) : (
              <p className="muted small">Loading PGs…</p>
            )
          ) : null}

          <label className="field">
            <span className="field-head">
              Monthly rent
              {out.budget ? <span className="out">rules out {out.budget}</span> : null}
            </span>
            <select value={prefs.budget ?? ''} onChange={(e) => set({ budget: e.target.value ? Number(e.target.value) : null })}>
              <option value="">Any</option>
              {budgets.map((b) => (
                <option key={b} value={b}>
                  Up to {rupees(b)}
                </option>
              ))}
            </select>
            <small>
              {both
                ? `Societies: area averages (${data.benchmarks.map((b) => b.area).join(', ')}), never per society. PGs: the operator's published starting price for the sharing you choose.`
                : showPgs
                  ? "The operator's published starting price for the sharing you choose. Where a page gives no period, a fit is only likely."
                  : `Rents are published only as area averages (${data.benchmarks.map((b) => b.area).join(', ')}), never per society.`}
            </small>
          </label>

          {showSocieties ? (
            <>
              <Field label="BHK" out={out.bhk} note={both ? 'Societies only.' : undefined}>
                <div className="chips">
                  {[1, 2, 3, 4].map((n) => (
                    <button key={n} className="filter" aria-pressed={prefs.bhk.includes(n)} onClick={() => set({ bhk: toggle(prefs.bhk, n) })}>
                      {n === 4 ? '4+' : n} BHK
                    </button>
                  ))}
                </div>
              </Field>

              <label className="field">
                <span className="field-head">Furnishing</span>
                <select value={prefs.furnishing ?? ''} onChange={(e) => set({ furnishing: (e.target.value || null) as Furnishing | null })}>
                  <option value="">Any</option>
                  {FURNISHING.map((f) => (
                    <option key={f.value} value={f.value}>
                      {f.label}
                    </option>
                  ))}
                </select>
                <small>
                  {both ? 'Societies only. ' : ''}No society has furnishing data yet, so any choice leaves every society unknown.
                </small>
              </label>
            </>
          ) : null}

          {showPgs ? (
            <>
              <Field label="Sharing" out={out.sharing} note={pgNote('A private room counts as single.')}>
                <div className="chips">
                  {SHARING.map((s) => (
                    <button key={s.value} className="filter" aria-pressed={prefs.sharing.includes(s.value)} onClick={() => set({ sharing: toggle(prefs.sharing, s.value) })}>
                      {s.label}
                    </button>
                  ))}
                </div>
              </Field>
              <Field label="Who can stay" out={out.gender} note={pgNote("From the operator's page or its link; a listing's name alone makes it likely.")}>
                <div className="chips">
                  {GENDER.map((g) => (
                    <button key={g.value} className="filter" aria-pressed={prefs.gender.includes(g.value)} onClick={() => set({ gender: toggle(prefs.gender, g.value) })}>
                      {g.label}
                    </button>
                  ))}
                </div>
              </Field>
              <Field label="Included" out={out.service} note={both ? 'PGs only.' : undefined}>
                <div className="chips">
                  {(Object.entries(SERVICE_TEXT) as [Service, string][]).map(([s, label]) => (
                    <button key={s} className="filter" aria-pressed={prefs.services.includes(s)} onClick={() => set({ services: toggle(prefs.services, s) })}>
                      {label}
                    </button>
                  ))}
                </div>
              </Field>
              <Field label="Listing" out={out.listing} note={both ? 'PGs only.' : undefined}>
                <div className="chips">
                  <button className="filter" aria-pressed={prefs.confirmed} onClick={() => set({ confirmed: !prefs.confirmed })}>
                    Confirmed on the operator's page
                  </button>
                </div>
              </Field>
            </>
          ) : null}

          <label className="field">
            <span className="field-head">
              Longest drive
              {out.commute ? <span className="out">rules out {out.commute}</span> : null}
            </span>
            <select value={prefs.maxCommute ?? ''} onChange={(e) => set({ maxCommute: e.target.value ? Number(e.target.value) : null })}>
              <option value="">Any</option>
              {DRIVES.map((m) => (
                <option key={m} value={m}>
                  {m} min
                </option>
              ))}
            </select>
            <small>An estimate from road types and assumed speeds, with no traffic.</small>
          </label>

          <Field label="Neighbourhoods" out={out.neighbourhood}>
            <div className="chips">
              {hoods.map((h) => (
                <button key={h.id} className="filter" aria-pressed={prefs.neighbourhoods.includes(h.id)} onClick={() => set({ neighbourhoods: toggle(prefs.neighbourhoods, h.id) })}>
                  {h.name}
                </button>
              ))}
            </div>
          </Field>

          <Field label={`Within ${distance(data.amenities.radius_m)}`} out={out.amenity} note="Places listed in OpenStreetMap and Overture, which can miss some.">
            <div className="chips">
              {Object.entries(data.amenities.categories).map(([cat, label]) => (
                <button key={cat} className="filter" aria-pressed={prefs.amenities.includes(cat)} onClick={() => set({ amenities: toggle(prefs.amenities, cat) })}>
                  {label}
                </button>
              ))}
              <button className="filter" aria-pressed={prefs.amenities.includes(METRO)} onClick={() => set({ amenities: toggle(prefs.amenities, METRO) })}>
                Metro station{METRO_M === data.amenities.radius_m ? '' : ` (${distance(METRO_M)})`}
              </button>
            </div>
          </Field>

          <Field label={`${kind} shown (${shown.length} of ${found.length})`}>
            {shown.length ? (
              <ul className="home-list">
                {shown.map((a) => {
                  const id = idOf(a)
                  const room = isPg(a) ? cheapestRoom(a.pg, prefs) : null
                  const detail = [room ? `from ${rupees(room.from_inr)}` : null, a.drive ? `≈${a.drive.minutes} min` : null].filter(Boolean).join(' · ')
                  return (
                    <li key={id}>
                      <button onClick={() => onOpen(id)}>
                        <span className={`dot v-${a.verdict}${isPg(a) ? ' pg' : ''}`} aria-hidden="true" />
                        <span className="name">{nameOf(a)}</span>
                        {both && isPg(a) ? <span className="type-tag">{a.pg.kind === 'co-living' ? 'Co-living' : 'PG'}</span> : null}
                        {compare.includes(id) ? (
                          <span className="cmp-num small-num" aria-label={`Compared as ${compare.indexOf(id) + 1}`}>
                            {compare.indexOf(id) + 1}
                          </span>
                        ) : null}
                        <span className="muted small">{detail}</span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            ) : (
              <p className="muted small">
                {both ? 'Nothing fits' : showPgs ? 'No PG fits' : 'No society fits'} every preference. Loosen one above.
              </p>
            )}
          </Field>

          {showSocieties ? (
            <p className="fine">
              Societies are located from OpenStreetMap; their facts come from developer pages, each with a source. Nothing here
              is a listing or says a home is available.
            </p>
          ) : null}
          {showPgs ? (
            <p className="fine">
              PGs are located from Overture Maps listings, which can be misplaced; their facts come only from operators' own
              pages, each with a source and date. Nothing here says a bed is available.
            </p>
          ) : null}
        </>
      )}
    </aside>
  )
}
