import type { Look } from '../map/MapView'
import { DATASETS } from '../types'
import { CloseIcon } from './icons'
import type { VisitCounts } from '../lib/visits'
import { VisitCounter } from './VisitCounter'

interface Props {
  look: Look
  onLook: (l: Look) => void
  showRoads: boolean
  onShowRoads: (v: boolean) => void
  showCoords: boolean
  onShowCoords: (v: boolean) => void
  datasetId: string
  onDataset: (id: string) => void
  onClose: () => void
  /** Shown here on phones, where the corner counter is hidden. */
  visits: VisitCounts | null
}

/** Optional settings and the honest small print about what is data and what is illustration. */
export function SettingsPanel(p: Props) {
  return (
    <section className="panel settings" aria-label="Map settings">
      <header className="panel-head">
        <h2>Map settings</h2>
        <button className="icon-btn ghost" onClick={p.onClose} aria-label="Close settings">
          <CloseIcon size={16} />
        </button>
      </header>
      <label className="switch">
        <input type="checkbox" checked={p.look === 'dusk'} onChange={(e) => p.onLook(e.target.checked ? 'dusk' : 'day')} />
        <span className="switch-track" aria-hidden="true" />
        <span>
          Dusk light
          <small>People, vehicles, lamps and park equipment are illustrative, not data.</small>
        </span>
      </label>
      <label className="switch">
        <input type="checkbox" checked={p.showRoads} onChange={(e) => p.onShowRoads(e.target.checked)} />
        <span className="switch-track" aria-hidden="true" />
        <span>
          Road centrelines
          <small>OpenStreetMap road lines drawn over the art.</small>
        </span>
      </label>
      <label className="switch">
        <input type="checkbox" checked={p.showCoords} onChange={(e) => p.onShowCoords(e.target.checked)} />
        <span className="switch-track" aria-hidden="true" />
        <span>
          Coordinates
          <small>Latitude and longitude under the pointer, at ground level.</small>
        </span>
      </label>
      {import.meta.env.DEV ? (
        <label className="field">
          <span>Art build (development)</span>
          <select value={p.datasetId} onChange={(e) => p.onDataset(e.target.value)}>
            {DATASETS.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {p.visits ? <VisitCounter counts={p.visits} inline /> : null}
      <p className="fine">
        Buildings, roads, water and parks come from OpenStreetMap, Overture Maps and Google Open Buildings. Heights marked
        <em> estimated</em> are modelled, not measured. Company locations are shown only where a named footprint backs them.
      </p>
      <p className="fine">
        Map data ©{' '}
        <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
          OpenStreetMap contributors
        </a>{' '}
        and Overture Maps Foundation. The building, road and place data this site serves (overlay tiles and the files
        under /data) is derived from OpenStreetMap and available under the{' '}
        <a href="https://opendatacommons.org/licenses/odbl/1-0/" target="_blank" rel="noreferrer">
          Open Database License
        </a>
        .
      </p>
      <p className="fine">
        The visitor count uses no cookies and stores no IP addresses: a visitor is recognised for 30 minutes by a hash
        salted afresh each day, and only the running total is kept.
      </p>
    </section>
  )
}
