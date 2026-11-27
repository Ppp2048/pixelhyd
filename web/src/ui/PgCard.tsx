import { useState, type ReactNode } from 'react'
import { distance, MAX_COMPARE, type Neighbourhood, type Service } from '../lib/homes'
import type { Workplace } from '../lib/homesUrl'
import { host } from '../lib/places'
import { GENDER_TEXT, genderFrom, pgAgeNote, SERVICE_TEXT, type PgAssessment, type PgHomes, type PgRent, type PgStatus } from '../lib/pgs'
import { ageText, pgCheckAge } from '../lib/freshness'
import { BackIcon, CompareIcon, ExternalIcon } from './icons'
import { checkLabel, rupees, VERDICT_TEXT } from './homesText'

/** The listing status as a chip: confirmed is green; the rest are amber, dashed. */
export const STATUS_CHIP: Record<PgStatus, { cls: string; text: string }> = {
  confirmed: { cls: 'confirmed', text: "Confirmed on operator's page" },
  probable: { cls: 'unverified', text: 'Probable' },
  unverified: { cls: 'unverified', text: 'Open data only' },
  closed: { cls: 'unverified', text: 'Closed' },
}

const SHARING_ORDER = ['single', 'double', 'triple', 'other']
const price = (r: PgRent) => `${r.starting ? 'from ' : ''}${rupees(r.from_inr)}${r.period === 'month' ? ' a month' : ''}`

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </>
  )
}

interface Props {
  assessment: PgAssessment
  pgs: PgHomes
  hoods: Neighbourhood[]
  workplace: Workplace
  /** Its place in the comparison (0-based), or -1 when it is not compared. */
  compareAt: number
  /** How many homes are compared already. */
  comparing: number
  onCompare: () => void
  onBack: () => void
}

/**
 * A PG in residential mode: why it fits, what its operator's page publishes (each fact with its source and
 * date), drive and nearby places. Nothing is shown that the page doesn't say.
 */
export function PgCard({ assessment, pgs, hoods, workplace, compareAt, comparing, onCompare, onBack }: Props) {
  const { pg: p, drive } = assessment
  const { data, operators } = pgs
  const op = p.operator ? operators.get(p.operator) : undefined
  const hood = hoods.find((h) => h.id === p.neighbourhood)?.name
  const unread = op && !op.read
  const rooms = [...p.rent].sort((a, b) => SHARING_ORDER.indexOf(a.sharing) - SHARING_ORDER.indexOf(b.sharing))
  const services = Object.entries(SERVICE_TEXT) as [Service, string][]
  const included = services.filter(([k]) => p.services[k]?.value === true).map(([, v]) => v)
  const excluded = services.filter(([k]) => p.services[k]?.value === false).map(([, v]) => v)
  const unstated = services.filter(([k]) => !p.services[k]).map(([, v]) => v)
  const loc = p.location
  const [now] = useState(() => new Date()) // today, once per card
  const age = pgCheckAge(p.checked, now)
  const checkedWhen = p.checked ? `${p.checked}${age ? ` (${ageText(age.days, 'day')})` : ''}` : null
  const cautions = [
    p.page_gone ? `${op?.name ?? 'The operator'}'s page no longer lists it (checked ${p.page_gone}). It may have closed.` : null,
    loc.from === 'overture' && !loc.listings_agree
      ? `Location uncertain: its ${loc.listings} open-data listings are up to ${distance(loc.spread_m)} apart. The map shows the one most others agree with; the others are dotted.`
      : null,
    p.status === 'unverified' && !p.page_gone ? 'Known only from an open-data listing. Nothing about its rooms has been checked.' : null,
    p.status === 'closed' ? data.statuses.closed : null,
    pgAgeNote(p, now),
  ].filter((c): c is string => !!c)
  const sources = [...new Set([p.page, p.address?.source, p.deposit?.source, ...p.rent.map((r) => r.source)].filter((u): u is string => !!u))]

  return (
    <aside className="panel card homes" aria-label="PG details">
      <button className="icon-btn ghost card-close" onClick={onBack} aria-label="Back to home search">
        <BackIcon size={16} />
      </button>
      <div className="company-head">
        <span className="monogram large" aria-hidden="true">
          {p.name.slice(0, 1)}
        </span>
        <div>
          <h2>{p.name}</h2>
          <p className="sub">{[op?.name, p.kind === 'co-living' ? 'Co-living' : 'PG', hood].filter(Boolean).join(' · ')}</p>
        </div>
      </div>
      <p className="tally">
        <span className={`chip ${STATUS_CHIP[p.status].cls}`} title={data.statuses[p.status]}>
          {STATUS_CHIP[p.status].text}
        </span>
        <span className={`chip v-${assessment.verdict}`}>{VERDICT_TEXT[assessment.verdict]}</span>
      </p>
      {cautions.map((c) => (
        <p key={c} className="caution">
          {c}
        </p>
      ))}

      {assessment.checks.length ? (
        <ul className="why" aria-label="How it fits your preferences">
          {assessment.checks.map((c, i) => (
            <li key={i}>
              <span className={`dot v-${c.verdict}`} title={VERDICT_TEXT[c.verdict]} aria-label={VERDICT_TEXT[c.verdict]} />
              <span className="muted">{checkLabel(c, data.amenities.categories)}</span>
              <span>{c.why}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <button className="action" aria-pressed={compareAt >= 0} disabled={compareAt < 0 && comparing >= MAX_COMPARE} onClick={onCompare}>
        <CompareIcon size={16} />
        {compareAt >= 0 ? `Comparing as ${compareAt + 1} · remove` : comparing >= MAX_COMPARE ? `Comparing ${MAX_COMPARE} already` : 'Compare'}
      </button>

      <dl className="facts">
        <Fact term="Rent">
          {rooms.length ? (
            <>
              {rooms.map((r) => (
                <div key={`${r.sharing}-${r.label}`}>
                  {r.label} · {price(r)}
                </div>
              ))}
              <div className="muted small">
                {rooms.some((r) => r.period === null) ? 'The page gives no period. ' : ''}Starting prices as published
                {checkedWhen ? `, checked ${checkedWhen}` : ''}; not an offer.
              </div>
            </>
          ) : unread ? (
            <>
              Not shown
              <div className="muted small">{op.name}'s terms don't allow reading its pages; see prices there.</div>
            </>
          ) : (
            <span className="muted">Not published</span>
          )}
        </Fact>
        <Fact term="Deposit">{p.deposit ? p.deposit.value : <span className="muted">Not published</span>}</Fact>
        <Fact term="Who can stay">
          {p.gender ? (
            <>
              {GENDER_TEXT[p.gender.value]}
              <div className="muted small">From {genderFrom(p, operators)}</div>
            </>
          ) : (
            <span className="muted">Not stated</span>
          )}
        </Fact>
        <Fact term="Included">
          {included.length || excluded.length ? (
            <>
              {included.join(' · ') || '—'}
              {excluded.length ? <div className="small">Not included: {excluded.join(', ')}</div> : null}
              {unstated.length ? <div className="muted small">Not published: {unstated.join(', ')}</div> : null}
            </>
          ) : (
            <span className="muted">Not published</span>
          )}
        </Fact>
        <Fact term="Address">
          {p.address ? (
            <>
              {p.address.value}
              <div className="muted small">As printed on {host(p.address.source)}</div>
            </>
          ) : (
            <span className="muted">Not published</span>
          )}
        </Fact>
        <Fact term="Drive">
          {drive ? (
            <>
              ≈{drive.minutes} min{drive.km !== null ? ` (${drive.km.toFixed(1)} km)` : ''} to {workplace.label}
              <div className="muted small">No traffic · estimate</div>
            </>
          ) : (
            'No estimate for this workplace'
          )}
        </Fact>
        <Fact term="Metro">
          {p.metro ? (
            <>
              {p.metro.name}, {distance(p.metro.m)}
              <div className="muted small">
                Straight line{p.metro.drive_min !== null ? ` · ≈${p.metro.drive_min} min drive` : ''}
              </div>
            </>
          ) : (
            'No data'
          )}
        </Fact>
      </dl>

      <details className="evidence" open>
        <summary>Listed within {distance(data.amenities.radius_m)}</summary>
        <dl className="facts">
          {Object.entries(data.amenities.categories).map(([cat, label]) => {
            const n = p.nearby[cat]
            return (
              <Fact key={cat} term={label}>
                {!n ? 'No data' : n.count ? `${n.count} · nearest ${distance(n.nearest?.m ?? 0)}` : `None${n.nearest ? ` · nearest ${distance(n.nearest.m)}` : ''}`}
              </Fact>
            )
          })}
        </dl>
      </details>

      <details className="evidence">
        <summary>Sources</summary>
        {p.note ? <p>{p.note}</p> : null}
        <p className="muted small">
          {data.statuses[p.status]}
          {checkedWhen ? ` Checked ${checkedWhen}.` : ''} Location:{' '}
          {loc.from === 'overture' ? `Overture Maps listing${loc.listings > 1 ? `s (${loc.listings})` : ''}` : 'as cited'}. Nearby places from
          OpenStreetMap and Overture.
        </p>
        <div className="sources">
          {sources.map((u) => (
            <a key={u} href={u} target="_blank" rel="noreferrer">
              {host(u)}
              {unread && u === p.page ? ' (not read)' : ''} <ExternalIcon />
            </a>
          ))}
          {loc.from === 'source' ? (
            <a href={loc.source} target="_blank" rel="noreferrer">
              Location: {host(loc.source)} <ExternalIcon />
            </a>
          ) : null}
        </div>
      </details>
    </aside>
  )
}
