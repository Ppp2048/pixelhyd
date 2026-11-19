import { sitePlace, siteTitle } from '../lib/corporate'
import type { BuildingProps, CorporateSite } from '../types'
import { osmUrl, type Place } from '../lib/places'
import { BuildingIcon, CloseIcon, ExternalIcon } from './icons'

const CONFIDENCE_TEXT: Record<string, string> = {
  verified: 'Measured height from OpenStreetMap/Overture',
  derived: 'Derived from the recorded number of floors',
  modelled: 'Modelled from satellite-derived height data',
  estimated: 'Estimated from building type and footprint size — not measured',
}

const SOURCE_TEXT: Record<string, string> = {
  osm_height: 'OSM height tag',
  overture_height: 'Overture height',
  osm_levels: 'OSM floor count',
  overture_floors: 'Overture floor count',
  estimate_class_area: 'Type + footprint estimate',
}

const STATUS_TEXT: Record<CorporateSite['status'], string> = {
  confirmed: 'Location confirmed',
  unverified: 'Unverified location',
}

const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

function CompanySection({ site, building }: { site: CorporateSite; building: BuildingProps | null }) {
  const here = building ? site.buildings.find((b) => b.id === building.id) : null
  const others = site.buildings.filter((b) => b.id !== here?.id)
  return (
    <section className="company">
      <div className="company-head">
        <span className="monogram large" aria-hidden="true">{siteTitle(site).slice(0, 1)}</span>
        <div>
          <h2>{siteTitle(site)}</h2>
          {site.brand_or_entity && site.brand_or_entity !== site.company_name ? <p className="sub">{site.brand_or_entity}</p> : null}
        </div>
      </div>
      <span className={`chip ${site.status}`}>{STATUS_TEXT[site.status]}</span>
      {site.status === 'unverified' ? (
        <p className="caution">This footprint is a candidate. The company's presence here has not been confirmed.</p>
      ) : null}
      <dl className="facts">
        {site.sector ? (
          <>
            <dt>Industry</dt>
            <dd>{site.sector}</dd>
          </>
        ) : null}
        <dt>{site.match === 'campus' ? 'Campus' : 'Property'}</dt>
        <dd>{sitePlace(site) || '—'}</dd>
        {site.buildings.length ? (
          <>
            <dt>{site.buildings.length > 1 ? 'Buildings' : 'Building'}</dt>
            <dd>
              {here ? <strong>{here.name ?? 'This building'}</strong> : null}
              {here && others.length ? ' · ' : null}
              {others.map((b) => b.name ?? 'Unnamed').join(' · ')}
            </dd>
          </>
        ) : null}
        {site.address ? (
          <>
            <dt>Address</dt>
            <dd>{site.address}</dd>
          </>
        ) : null}
      </dl>
      <details className="evidence">
        <summary>How this location was identified</summary>
        <p>{site.match_note}</p>
        {site.source_note ? <p>{site.source_note}</p> : null}
        <p className="muted small">
          Evidence: {site.evidence_level ?? 'not stated'}
          {site.last_checked ? ` · checked ${site.last_checked}` : ''}
        </p>
      </details>
      {site.sources.length ? (
        <div className="sources">
          {site.sources.map((u) => (
            <a key={u} href={u} target="_blank" rel="noreferrer">
              {host(u)} <ExternalIcon />
            </a>
          ))}
        </div>
      ) : null}
    </section>
  )
}

function BuildingFacts({ building }: { building: BuildingProps }) {
  const osm = osmUrl(building.osm_id)
  return (
    <dl className="facts">
      <dt>Height</dt>
      <dd>
        {building.height_m.toFixed(0)} m <span className={`badge ${building.height_confidence}`}>{building.height_confidence}</span>
        <div className="muted small">
          {CONFIDENCE_TEXT[building.height_confidence]} · {SOURCE_TEXT[building.height_source] ?? building.height_source}
        </div>
      </dd>
      {building.levels ? (
        <>
          <dt>Floors</dt>
          <dd>{building.levels}</dd>
        </>
      ) : null}
      <dt>Footprint</dt>
      <dd>
        {Math.round(building.area_m2).toLocaleString()} m² · {building.footprint_source}
      </dd>
      {osm ? (
        <>
          <dt>Record</dt>
          <dd>
            <a href={osm} target="_blank" rel="noreferrer">
              OpenStreetMap {building.osm_id} <ExternalIcon />
            </a>
          </dd>
        </>
      ) : null}
    </dl>
  )
}

/** A place from the search index: what OpenStreetMap records about it, and nothing more. */
function PlaceSection({ place }: { place: Place }) {
  const osm = osmUrl(place.id)
  return (
    <section>
      <div className="company-head">
        <span className="monogram large plain" aria-hidden="true">
          {place.buildingId ? <BuildingIcon /> : place.name.slice(0, 1).toUpperCase()}
        </span>
        <div>
          <h2>{place.name}</h2>
          <p className="sub">{[place.kind, place.context].filter(Boolean).join(' · ')}</p>
        </div>
      </div>
      {place.cat === 'office' ? (
        <p className="caution">Listed in OpenStreetMap as an office. Who occupies it has not been verified.</p>
      ) : null}
      <dl className="facts">
        <dt>Type</dt>
        <dd>{place.kind}</dd>
        {place.context && place.context !== place.name ? (
          <>
            <dt>Area</dt>
            <dd>Near {place.context}</dd>
          </>
        ) : null}
        {place.alt.length ? (
          <>
            <dt>Also called</dt>
            <dd>{place.alt.join(' · ')}</dd>
          </>
        ) : null}
        {osm ? (
          <>
            <dt>Record</dt>
            <dd>
              <a href={osm} target="_blank" rel="noreferrer">
                OpenStreetMap {place.id} <ExternalIcon />
              </a>
            </dd>
          </>
        ) : null}
      </dl>
      <p className="muted small place-note">
        {place.buildingId ? 'Outlined on the map. Select the building for its details.' : 'Location from OpenStreetMap contributors.'}
      </p>
    </section>
  )
}

/** The selected place: a searched place, then its companies (if any), then the building itself. */
export function Inspector({
  building, place, sites, onClose,
}: { building: BuildingProps | null; place: Place | null; sites: CorporateSite[]; onClose: () => void }) {
  return (
    <aside className="panel card" aria-live="polite" aria-label={sites.length ? 'Company details' : place ? 'Place details' : 'Building details'}>
      <button className="icon-btn ghost card-close" onClick={onClose} aria-label="Close details">
        <CloseIcon size={16} />
      </button>
      {place ? <PlaceSection place={place} /> : null}
      {sites.map((s) => (
        <CompanySection key={s.id} site={s} building={building} />
      ))}
      {building ? (
        sites.length ? (
          <details className="building-more">
            <summary>
              <BuildingIcon size={15} /> Building details
            </summary>
            <BuildingFacts building={building} />
          </details>
        ) : (
          <section>
            <div className="company-head">
              <span className="monogram large plain" aria-hidden="true">
                <BuildingIcon />
              </span>
              <div>
                <h2>{building.name ?? 'Unnamed building'}</h2>
                <p className="sub">{building.use && building.use !== 'unknown' ? building.use : 'Use not recorded'}</p>
              </div>
            </div>
            <BuildingFacts building={building} />
          </section>
        )
      ) : null}
    </aside>
  )
}
