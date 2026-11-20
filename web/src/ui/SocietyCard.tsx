import type { ReactNode } from 'react'
import { bhkOf, distance, formatBhk, MAX_COMPARE, type Assessment, type Homes, type Society } from '../lib/homes'
import type { Workplace } from '../lib/homesUrl'
import { host, osmUrl } from '../lib/places'
import { BackIcon, CompareIcon, ExternalIcon } from './icons'
import { checkLabel, rupees, VERDICT_TEXT } from './homesText'

const AREA_TYPE: Record<string, string> = {
  carpet: 'carpet area',
  built_up: 'built-up area',
  super_built_up: 'super built-up area',
  unspecified: 'area type not stated',
}

const sqft = (r: [number, number]) => (r[0] === r[1] ? `${r[0].toLocaleString('en-IN')} sq ft` : `${r[0].toLocaleString('en-IN')}–${r[1].toLocaleString('en-IN')} sq ft`)
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </>
  )
}

/** Every distinct page a society's facts came from. */
const sourcesOf = (s: Society) =>
  [...new Set([...Object.values(s.facts).map((f) => f?.source), ...s.configurations.map((c) => c.source)].filter((u): u is string => !!u))]

interface Props {
  assessment: Assessment
  homes: Homes
  workplace: Workplace
  /** Its place in the comparison (0-based), or -1 when it is not compared. */
  compareAt: number
  /** How many societies are compared already. */
  comparing: number
  onCompare: () => void
  onBack: () => void
}

/** A society in residential mode: why it fits, its published facts, drive and nearby places, with sources. */
export function SocietyCard({ assessment, homes, workplace, compareAt, comparing, onCompare, onBack }: Props) {
  const { society: s, drive } = assessment
  const { data } = homes
  const f = s.facts
  const hood = data.neighbourhoods.find((h) => h.id === s.neighbourhood)?.name
  const bench = data.benchmarks.find((b) => b.neighbourhood === s.neighbourhood)
  const bhk = bhkOf(s)
  const rooms = s.configurations.filter((c) => c.bedrooms_ft?.length)
  const sources = sourcesOf(s)
  const osm = s.site ? osmUrl(s.site.osm_id) : null

  return (
    <aside className="panel card homes" aria-label="Society details">
      <button className="icon-btn ghost card-close" onClick={onBack} aria-label="Back to home search">
        <BackIcon size={16} />
      </button>
      <div className="company-head">
        <span className="monogram large" aria-hidden="true">
          {s.name.slice(0, 1)}
        </span>
        <div>
          <h2>{s.name}</h2>
          <p className="sub">{[s.developer, hood].filter(Boolean).join(' · ') || 'Developer not recorded'}</p>
        </div>
      </div>
      <p className="tally">
        <span className={`chip ${s.research === 'researched' ? 'confirmed' : 'unverified'}`}>{s.research === 'researched' ? 'Researched' : 'Mapped only'}</span>
        <span className={`chip v-${assessment.verdict}`}>{VERDICT_TEXT[assessment.verdict]}</span>
      </p>
      {s.research === 'mapped' ? <p className="caution">Located on the map only. Nothing about its homes has been researched yet.</p> : null}

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
          {bench ? (
            <>
              {bench.area} averages {rupees(bench.rent_month)} a month for a {bench.size_sqft.toLocaleString('en-IN')} sq ft {bench.bhk}BHK
              <div className="muted small">
                {bench.publisher}, {bench.period}. An area average, not this society's rent.
              </div>
            </>
          ) : (
            'No published rent'
          )}
        </Fact>
        <Fact term="BHK">{bhk.length ? formatBhk(bhk) : 'Not published'}</Fact>
        {s.configurations.some((c) => c.area_sqft) ? (
          <Fact term="Unit sizes">
            {s.configurations
              .filter((c) => c.area_sqft)
              .map((c) => `${c.bhk} BHK ${sqft(c.area_sqft!)}`)
              .join(' · ')}
            <div className="muted small">{AREA_TYPE[s.configurations.find((c) => c.area_sqft)?.area_type ?? 'unspecified']}</div>
          </Fact>
        ) : f.size_range_sqft ? (
          <Fact term="Unit sizes">
            {sqft(f.size_range_sqft.value)}
            <div className="muted small">{AREA_TYPE[f.size_range_sqft.area_type]}</div>
          </Fact>
        ) : null}
        <Fact term="Bedrooms">
          {rooms.length
            ? rooms.map((c) => `${c.bhk} BHK: ${c.bedrooms_ft!.map(([a, b]) => `${a}×${b} ft`).join(', ')}`).join(' · ')
            : 'Sizes not published'}
        </Fact>
        {f.status ? <Fact term="Status">{sentence(f.status.value)}</Fact> : null}
        {f.towers || f.floors ? (
          <Fact term="Towers">{[f.towers ? `${f.towers.value} towers` : null, f.floors ? `${f.floors.value} floors` : null].filter(Boolean).join(' · ')}</Fact>
        ) : null}
        {f.land_acres ? (
          <Fact term="Land">
            {f.land_acres.value} acres{f.open_space_pct ? ` · ${f.open_space_pct.value}% open space` : ''}
          </Fact>
        ) : null}
        {f.amenities ? <Fact term="Amenities">{f.amenities.value.join(' · ')}</Fact> : null}
        {f.rera ? (
          <Fact term="RERA">
            {f.rera.value}
            <div className="muted small">As printed on the developer's page; check it on TG-RERA.</div>
          </Fact>
        ) : null}
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
          {s.metro ? (
            <>
              {s.metro.name}, {distance(s.metro.m)}
              <div className="muted small">
                Straight line{s.metro.drive_min !== null ? ` · ≈${s.metro.drive_min} min drive` : ''}
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
            const n = s.nearby[cat]
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
        {s.note ? <p>{s.note}</p> : null}
        <p className="muted small">
          {s.research === 'researched' ? 'Facts from the pages below' : 'No facts researched'}
          {s.last_checked ? ` · checked ${s.last_checked}` : ''}. Boundary from OpenStreetMap; nearby places from OpenStreetMap and Overture.
        </p>
        <div className="sources">
          {sources.map((u) => (
            <a key={u} href={u} target="_blank" rel="noreferrer">
              {host(u)} <ExternalIcon />
            </a>
          ))}
          {bench ? (
            <a href={bench.source} target="_blank" rel="noreferrer">
              Rent: {host(bench.source)} <ExternalIcon />
            </a>
          ) : null}
          {osm ? (
            <a href={osm} target="_blank" rel="noreferrer">
              OpenStreetMap <ExternalIcon />
            </a>
          ) : null}
        </div>
      </details>
    </aside>
  )
}
