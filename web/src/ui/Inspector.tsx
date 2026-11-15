import type { BuildingProps } from '../types'

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

function osmUrl(osmId: string | null) {
  if (!osmId) return null
  const type = { w: 'way', r: 'relation', n: 'node' }[osmId[0]]
  return type ? `https://www.openstreetmap.org/${type}/${osmId.slice(1)}` : null
}

export function Inspector({ building, onClose }: { building: BuildingProps; onClose: () => void }) {
  const osm = osmUrl(building.osm_id)
  return (
    <aside className="inspector" aria-live="polite" aria-label="Building details">
      <header>
        <div>
          <h2>{building.name ?? 'Unnamed building'}</h2>
          <p className="muted">{building.use && building.use !== 'unknown' ? building.use : 'Use not recorded'}</p>
        </div>
        <button className="icon" onClick={onClose} aria-label="Close details">
          ✕
        </button>
      </header>
      <dl>
        <dt>Height</dt>
        <dd>
          {building.height_m.toFixed(0)} m{' '}
          <span className={`badge ${building.height_confidence}`}>{building.height_confidence}</span>
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
            <dt>Source record</dt>
            <dd>
              <a href={osm} target="_blank" rel="noreferrer">
                OpenStreetMap {building.osm_id}
              </a>
            </dd>
          </>
        ) : null}
      </dl>
    </aside>
  )
}
