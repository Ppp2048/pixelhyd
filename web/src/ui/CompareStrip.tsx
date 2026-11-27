import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import { bhkOf, distance, formatBhk, MAX_COMPARE, METRO, type Homes, type Preferences } from '../lib/homes'
import { cheapestRoom, GENDER_TEXT, genderFrom, idOf, isPg, nameOf, type Found, type PgAssessment, type PgHomes } from '../lib/pgs'
import { ChevronDownIcon, CloseIcon, CompareIcon, ExtentIcon } from './icons'
import { rupees, VERDICT_TEXT } from './homesText'
import { STATUS_CHIP } from './PgCard'
import { rentAge } from '../lib/freshness'

interface Props {
  /** The compared homes, in marker order (1, 2, 3). */
  compared: Found[]
  homes: Homes
  /** Needed (and loaded) once a PG is compared. */
  pgs: PgHomes | null
  prefs: Preferences
  /** Light up the places behind a row (a category, or METRO), or clear them with null. */
  onLit: (row: string | null) => void
  /** A row was pressed: bring its places into view. */
  onShowRow: (row: string) => void
  onOpen: (societyId: string) => void
  /** Fit the compared societies (and the workplace) into view. */
  onShowAll: () => void
  onRemove: (societyId: string) => void
  onClear: () => void
  /** Height of the strip on screen (px), so map flights keep their target above it; 0 once it closes. */
  onHeight: (px: number) => void
}

// Phones (the same width as the stylesheet's narrow layout) get a folded bar and a sheet instead of the strip.
const phone = window.matchMedia('(max-width: 720px)')
const onPhoneChange = (cb: () => void) => {
  phone.addEventListener('change', cb)
  return () => phone.removeEventListener('change', cb)
}
const useNarrow = () => useSyncExternalStore(onPhoneChange, () => phone.matches)

/** A value, then optional detail in small muted text. */
const Value = ({ main, sub, missing }: { main: ReactNode; sub?: ReactNode; missing?: boolean }) => (
  <>
    <span className={missing ? 'muted' : undefined}>{main}</span>
    {sub ? <span className="muted cmp-sub"> · {sub}</span> : null}
  </>
)

const SHARING_ORDER = ['single', 'double', 'triple', 'other']
const DASH = <Value main="—" missing />

/**
 * Residential mode's comparison: up to three homes side by side, in a glass strip along the bottom
 * (on phones, a bar under the search box that opens into a sheet). Hovering or pressing a nearby-places
 * row lights those places on the map for each society.
 */
export function CompareStrip({ compared, homes, pgs, prefs, onLit, onShowRow, onOpen, onShowAll, onRemove, onClear, onHeight }: Props) {
  const { data } = homes
  const ref = useRef<HTMLElement>(null)
  // A pressed row stays lit (touch screens have no hover); hovering another row shows it meanwhile.
  const [pinned, setPinned] = useState<string | null>(null)
  const narrow = useNarrow()
  const [open, setOpen] = useState(false) // phones only: the sheet is open
  const folded = narrow && !open

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => onHeight(el.offsetHeight))
    ro.observe(el)
    return () => {
      ro.disconnect()
      onHeight(0)
      onLit(null)
    }
  }, [onHeight, onLit])

  const [now] = useState(() => new Date()) // today, once per strip
  const benches = compared.map((a) => (isPg(a) ? undefined : data.benchmarks.find((b) => b.neighbourhood === a.society.neighbourhood)))
  const cols = compared.length
  // With a PG among them, rows for both kinds; societies alone keep their own rows.
  const mixed = compared.some(isPg)
  const homeOf = (a: Found) => (isPg(a) ? a.pg : a.society)
  const unread = (a: PgAssessment) => {
    const op = a.pg.operator ? pgs?.operators.get(a.pg.operator) : undefined
    return op && !op.read ? op : null
  }
  const fits = (rent: number) => (prefs.budget === null ? '' : prefs.budget >= rent ? ' · within budget' : ' · above budget')
  const rowName = (row: string) => (row === METRO ? 'Metro' : data.amenities.categories[row] ?? row)

  /** One comparison row: a cell per home; `light` makes it light up its places on the map. */
  const row = (label: string, cell: (a: Found, i: number) => ReactNode, light?: string) => {
    const on = light && pinned === light
    return (
      <tr
        key={label}
        className={light ? `lightable${on ? ' lit' : ''}` : undefined}
        onMouseEnter={light ? () => onLit(light) : undefined}
        onMouseLeave={light ? () => onLit(pinned) : undefined}
      >
        <th scope="row">
          {light ? (
            <button
              className="row-btn"
              aria-pressed={!!on}
              title="Show these places on the map"
              onFocus={() => onLit(light)}
              onBlur={() => onLit(pinned)}
              onClick={() => {
                const next = on ? null : light
                setPinned(next)
                onLit(next ?? light)
                if (next) {
                  onShowRow(next)
                  setOpen(false) // on a phone, fold the sheet so the map shows the places
                }
              }}
            >
              {label}
            </button>
          ) : (
            label
          )}
        </th>
        {compared.map((a, i) => (
          <td key={idOf(a)}>{cell(a, i)}</td>
        ))}
      </tr>
    )
  }

  const close = (
    <button className="icon-btn ghost" onClick={onClear} aria-label="Close the comparison" title="Close the comparison">
      <CloseIcon size={14} />
    </button>
  )

  return (
    <section
      ref={ref}
      className={`panel compare${folded ? ' folded' : narrow ? ' sheet' : ''}`}
      aria-label={mixed ? 'Compare homes' : 'Compare societies'}
      style={{ '--cols': cols } as CSSProperties}
    >
      {folded ? (
        <>
          <button className="cmp-open" onClick={() => setOpen(true)} aria-expanded={false}>
            <CompareIcon size={16} />
            Compare
            {compared.map((a, i) => (
              <span key={idOf(a)} className="cmp-num small-num" aria-hidden="true">
                {i + 1}
              </span>
            ))}
          </button>
          {pinned ? (
            <button
              className="filter"
              aria-pressed="true"
              aria-label={`Stop showing ${rowName(pinned)} on the map`}
              onClick={() => {
                setPinned(null)
                onLit(null)
              }}
            >
              {rowName(pinned)} <CloseIcon size={12} />
            </button>
          ) : null}
          {close}
        </>
      ) : (
        <>
          <div className="panel-head">
            <h2>
              Compare{' '}
              <span className="muted small">
                {cols} of {MAX_COMPARE}
              </span>
            </h2>
            <span className="cmp-tools">
              {narrow ? (
                <button className="icon-btn ghost" onClick={() => setOpen(false)} aria-expanded={true} aria-label="Fold the comparison" title="Fold the comparison">
                  <ChevronDownIcon />
                </button>
              ) : (
                <button className="icon-btn ghost" onClick={onShowAll} aria-label="Show them on the map" title="Show them on the map">
                  <ExtentIcon />
                </button>
              )}
              {close}
            </span>
          </div>
          <div className="compare-scroll">
            <table>
              <thead>
                <tr>
                  <td />
                  {compared.map((a, i) => (
                    <th scope="col" key={idOf(a)}>
                      <div className="cmp-head">
                        <span className="cmp-num" aria-label={`Number ${i + 1} on the map`}>
                          {i + 1}
                        </span>
                        <button className="cmp-name" onClick={() => onOpen(idOf(a))} title={`Open ${nameOf(a)}`}>
                          {nameOf(a)}
                        </button>
                        <button className="icon-btn ghost cmp-remove" onClick={() => onRemove(idOf(a))} aria-label={`Remove ${nameOf(a)} from the comparison`}>
                          <CloseIcon size={12} />
                        </button>
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {row('Fit', (a) => <span className={`chip v-${a.verdict}`}>{VERDICT_TEXT[a.verdict]}</span>)}
                {mixed
                  ? row('Type', (a) =>
                      isPg(a) ? (
                        <Value
                          main={a.pg.kind === 'co-living' ? 'Co-living' : 'PG'}
                          sub={[a.pg.operator ? pgs?.operators.get(a.pg.operator)?.name : null, STATUS_CHIP[a.pg.status].text.toLowerCase()].filter(Boolean).join(' · ')}
                        />
                      ) : (
                        <Value
                          main="Society"
                          sub={[a.society.developer, a.society.research === 'researched' ? 'researched' : 'mapped only'].filter(Boolean).join(' · ')}
                        />
                      ),
                    )
                  : null}
                {row('Drive', (a) =>
                  a.drive ? (
                    <Value main={`≈${a.drive.minutes} min`} sub={a.drive.km !== null ? `${a.drive.km.toFixed(1)} km` : undefined} />
                  ) : (
                    <Value main="No estimate" missing />
                  ),
                )}
                {row(
                  'Metro',
                  (a) => {
                    const m = homeOf(a).metro
                    return m ? <Value main={distance(m.m)} sub={m.name} /> : <Value main="No data" missing />
                  },
                  METRO,
                )}
                {mixed ? (
                  <>
                    {row('Rent', (a, i) => {
                      if (!isPg(a)) {
                        const b = benches[i]
                        return b ? <Value main={rupees(b.rent_month)} sub={`${b.bhk}BHK area average${fits(b.rent_month)}`} /> : <Value main="Not published" missing />
                      }
                      const r = cheapestRoom(a.pg, prefs)
                      if (!r) return unread(a) ? <Value main="Not shown" sub="operator's terms" missing /> : <Value main="Not published" missing />
                      const per = r.period === 'month' ? 'a month' : 'no period given'
                      return <Value main={`${r.starting ? 'from ' : ''}${rupees(r.from_inr)}`} sub={`${r.label.toLowerCase()} · ${per}${fits(r.from_inr)}`} />
                    })}
                    {row('Rooms', (a) => {
                      if (!isPg(a)) {
                        const bhk = bhkOf(a.society)
                        return bhk.length ? <Value main={formatBhk(bhk)} /> : <Value main="Not published" missing />
                      }
                      const rooms = [...a.pg.rent].sort((x, y) => SHARING_ORDER.indexOf(x.sharing) - SHARING_ORDER.indexOf(y.sharing))
                      if (rooms.length) return <Value main={rooms.map((r) => r.label).join(', ')} />
                      return <Value main={unread(a) ? 'Not shown' : 'Not published'} missing />
                    })}
                    {row('Who can stay', (a) =>
                      !isPg(a) ? DASH : a.pg.gender ? (
                        <Value main={GENDER_TEXT[a.pg.gender.value]} sub={pgs ? genderFrom(a.pg, pgs.operators) : undefined} />
                      ) : (
                        <Value main="Not stated" missing />
                      ),
                    )}
                    {row('Food', (a) => {
                      if (!isPg(a)) return DASH
                      const f = a.pg.services.food
                      if (f) return <Value main={f.value ? 'Included' : 'Not included'} />
                      return <Value main={unread(a) ? 'Not shown' : 'Not published'} missing />
                    })}
                  </>
                ) : (
                  <>
                    {/* Rent only where a published area benchmark exists for at least one of them. */}
                    {benches.some(Boolean)
                      ? row('Area rent', (_, i) => {
                          const b = benches[i]
                          if (!b) return <Value main="Not published" missing />
                          const dated = rentAge(b.period, now).freshness === 'current' ? '' : ` · ${b.period}, dated`
                          return <Value main={rupees(b.rent_month)} sub={`${b.bhk}BHK area average${fits(b.rent_month)}${dated}`} />
                        })
                      : null}
                    {row('BHK', (a) => {
                      const bhk = isPg(a) ? [] : bhkOf(a.society)
                      return bhk.length ? <Value main={formatBhk(bhk)} /> : <Value main="Not published" missing />
                    })}
                    {row('Facts', (a) => (!isPg(a) && a.society.research === 'researched' ? <Value main="Researched" /> : <Value main="Mapped only" missing />))}
                  </>
                )}
                {Object.entries(data.amenities.categories).map(([cat, label]) =>
                  row(
                    label,
                    (a) => {
                      const n = homeOf(a).nearby[cat]
                      if (!n) return <Value main="No data" missing />
                      const near = n.nearest ? `nearest ${distance(n.nearest.m)}` : undefined
                      return n.count ? <Value main={n.count} sub={near} /> : <Value main="None" sub={near} missing />
                    },
                    cat,
                  ),
                )}
              </tbody>
            </table>
          </div>
          <p className="cmp-note muted small">
            {mixed ? "Rows that don't apply to a home show —. Society rents are area averages; PG rents are operators' starting prices as published. " : ''}
            Rows with a dot light their places on the map. Drives assume no traffic; places are those listed in OpenStreetMap
            and Overture within {distance(data.amenities.radius_m)} in a straight line.
            {cols < MAX_COMPARE ? ` To add a ${mixed ? 'home' : 'society'}, open it and choose Compare.` : ''}
          </p>
        </>
      )}
    </section>
  )
}
