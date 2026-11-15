import { useEffect, useState } from 'react'
import { MapView } from './map/MapView'
import { readUrl } from './lib/urlState'
import { Inspector } from './ui/Inspector'
import { DATASETS, type BuildingProps, type DatasetMeta } from './types'

export default function App() {
  const [datasetId, setDatasetId] = useState(() => {
    const d = readUrl().dataset
    return DATASETS.some((x) => x.id === d) ? d! : DATASETS[0].id
  })
  const dataset = DATASETS.find((d) => d.id === datasetId)!
  // Result of loading a dataset's metadata, tagged with the dataset it belongs to.
  const [loaded, setLoaded] = useState<{ id: string; meta?: DatasetMeta; error?: string } | null>(null)
  const meta = loaded?.id === datasetId ? loaded.meta ?? null : null
  const error = loaded?.id === datasetId ? loaded.error ?? null : null
  const [selected, setSelected] = useState<BuildingProps | null>(null)
  const [cursor, setCursor] = useState<[number, number] | null>(null)
  const [showRoads, setShowRoads] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch(`${dataset.base}/meta.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status} ${r.statusText}`))))
      .then((m: DatasetMeta) => !cancelled && setLoaded({ id: dataset.id, meta: m }))
      .catch((e: Error) => !cancelled && setLoaded({ id: dataset.id, error: `Could not load map data (${e.message}). Run the pipeline first.` }))
    return () => {
      cancelled = true
    }
  }, [dataset])

  return (
    <div className="app">
      <header className="bar">
        <div className="brand">
          <strong>HITEC City</strong>
          <span className="muted">isometric map</span>
        </div>
        <div className="controls">
          <label>
            <span className="sr-only">Art resolution</span>
            <select value={datasetId} onChange={(e) => { setSelected(null); setDatasetId(e.target.value) }}>
              {DATASETS.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>
          <label className="toggle">
            <input type="checkbox" checked={showRoads} onChange={(e) => setShowRoads(e.target.checked)} />
            OSM road centrelines
          </label>
        </div>
      </header>
      <main>
        {error ? <p className="error" role="alert">{error}</p> : null}
        {meta ? (
          <MapView
            key={dataset.id}
            dataset={dataset}
            meta={meta}
            showRoads={showRoads}
            selectedId={selected?.id ?? null}
            onSelect={setSelected}
            onCursor={setCursor}
          />
        ) : null}
        {selected ? <Inspector building={selected} onClose={() => setSelected(null)} /> : null}
        <div className="status" aria-hidden="true">
          {cursor ? `${cursor[1].toFixed(5)}° N, ${cursor[0].toFixed(5)}° E (ground level)` : 'Move over the map'}
        </div>
      </main>
    </div>
  )
}
