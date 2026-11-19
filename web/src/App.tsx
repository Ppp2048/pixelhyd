import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MapView, type Highlight, type Look, type MapApi } from './map/MapView'
import { readUrl, writeUrl } from './lib/urlState'
import { loadCorporate, type Corporate } from './lib/corporate'
import { loadPlaces, type Place } from './lib/places'
import { trackVisits, type VisitCounts } from './lib/visits'
import type { Hit } from './lib/discover'
import { Inspector } from './ui/Inspector'
import { MapControls } from './ui/MapControls'
import { SearchBox } from './ui/SearchBox'
import { SettingsPanel } from './ui/SettingsPanel'
import { VisitCounter } from './ui/VisitCounter'
import { CloseIcon } from './ui/icons'
import { DATASETS, type BuildingProps, type CorporateSite, type DatasetMeta } from './types'

/**
 * What the details card shows: a clicked building (maybe with companies), a company site, or a
 * place picked in search (which may be a building with companies in it).
 */
type Selection = { building: BuildingProps | null; siteId: string | null; place?: Place } | null

/** Desktop width of the details card plus its margin; flights keep the target clear of it. */
const CARD_INSET = 372

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
  const [corporate, setCorporate] = useState<Corporate | null>(null)
  const [selection, setSelection] = useState<Selection>(null)
  const [cursor, setCursor] = useState<[number, number] | null>(null)
  const [busy, setBusy] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [showRoads, setShowRoads] = useState(false)
  const [showCoords, setShowCoords] = useState(false)
  // Dusk is the map's look; untick to see the original art.
  const [look, setLook] = useState<Look>('dusk')
  const api = useRef<MapApi | null>(null)
  const [visits, setVisits] = useState<VisitCounts | null>(null)
  const [tileError, setTileError] = useState(false)
  const onTileError = useCallback(() => setTileError(true), [])

  useEffect(() => trackVisits(setVisits), [])

  useEffect(() => {
    let cancelled = false
    fetch(`${dataset.base}/meta.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status} ${r.statusText}`))))
      .then((m: DatasetMeta) => !cancelled && setLoaded({ id: dataset.id, meta: m }))
      .catch((e: Error) => !cancelled && setLoaded({ id: dataset.id, error: `The map could not be loaded (${e.message}).` }))
    return () => {
      cancelled = true
    }
  }, [dataset])

  useEffect(() => {
    let cancelled = false
    loadCorporate().then((c) => {
      if (cancelled || !c) return
      setCorporate(c)
      const s = readUrl().site // a shared link to a company site
      if (s && c.byId.has(s)) setSelection({ building: null, siteId: s })
    })
    const p = readUrl().place // a shared link to a searched place
    if (p)
      loadPlaces().then((d) => {
        const place = d?.places.find((x) => x.id === p)
        if (!cancelled && place) setSelection((cur) => cur ?? { building: null, siteId: null, place })
      })
    return () => {
      cancelled = true
    }
  }, [])

  // The card's companies: those in the clicked (or searched) building, or the one picked in search.
  const sites: CorporateSite[] = useMemo(() => {
    if (!selection || !corporate) return []
    if (selection.building) return corporate.byBuilding.get(selection.building.id) ?? []
    if (selection.place) return selection.place.buildingId ? corporate.byBuilding.get(selection.place.buildingId) ?? [] : []
    const s = selection.siteId ? corporate.byId.get(selection.siteId) : undefined
    return s ? [s] : []
  }, [selection, corporate])

  const highlight: Highlight = useMemo(() => {
    const unverifiedOnly = sites.length > 0 && sites.every((s) => s.status === 'unverified')
    if (selection?.building) return { ids: [selection.building.id], unverified: unverifiedOnly }
    if (selection?.place) return { ids: selection.place.buildingId ? [selection.place.buildingId] : [], unverified: unverifiedOnly }
    if (sites.length) return { ids: sites.flatMap((s) => s.buildings.map((b) => b.id)), unverified: sites[0].status === 'unverified' }
    return { ids: [], unverified: false }
  }, [selection, sites])

  // A searched place that is not a building gets a pin.
  const place = selection?.place
  const pin: [number, number] | null = place && !place.buildingId ? [place.lon, place.lat] : null

  // Keep the selection in the URL so a shared link opens the same card.
  useEffect(() => {
    const url = readUrl()
    if (!corporate && url.site) return // wait for company data before touching a shared site link
    if (!selection && url.place) return // ...and for the place index before touching a shared place link
    const site = !selection?.building && !selection?.place && sites.length ? sites[0].id : undefined
    writeUrl({ ...url, building: selection?.building?.id, site, place: selection?.place?.id })
  }, [selection, sites, corporate])

  const selectBuilding = useCallback((b: BuildingProps | null) => setSelection(b ? { building: b, siteId: null } : null), [])
  const selectSite = useCallback((s: CorporateSite) => {
    setSelection({ building: null, siteId: s.id })
    api.current?.flyToSite(s)
  }, [])
  const pick = useCallback(
    (h: Hit) => {
      if (h.type === 'site') return selectSite(h.site)
      setSelection({ building: null, siteId: null, place: h.place })
      api.current?.flyToPlace(h.place)
    },
    [selectSite],
  )
  const onReady = useCallback((a: MapApi) => {
    api.current = a
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement).tagName)) return
      if (settingsOpen) setSettingsOpen(false)
      else setSelection(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [settingsOpen])

  const cardOpen = !!selection && (!!selection.building || !!selection.place || sites.length > 0)

  return (
    <div className={`app look-${look}${cardOpen ? ' has-card' : ''}`}>
      {meta ? (
        <MapView
          key={dataset.id}
          dataset={dataset}
          meta={meta}
          look={look}
          showRoads={showRoads}
          corporate={corporate}
          highlight={highlight}
          pin={pin}
          leftInset={cardOpen ? CARD_INSET : 0}
          onSelectBuilding={selectBuilding}
          onSelectSite={selectSite}
          onCursor={setCursor}
          onLoading={setBusy}
          onTileError={onTileError}
          onReady={onReady}
        />
      ) : null}

      <div className={`progress${busy || !meta ? ' on' : ''}`} aria-hidden="true" />

      <header className="topbar">
        <div className="brand" aria-label="Pixelhyd, an isometric map of Hyderabad">
          <svg className="brand-mark" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 2.5 20.5 7.4v9.2L12 21.5 3.5 16.6V7.4Z" fill="currentColor" opacity=".18" />
            <path d="M12 2.5 20.5 7.4 12 12.3 3.5 7.4Z" fill="currentColor" />
            <path d="M12 12.3v9.2M12 12.3l8.5-4.9M12 12.3 3.5 7.4" stroke="currentColor" strokeWidth="1.2" fill="none" opacity=".6" />
          </svg>
          <span className="brand-name">Pixelhyd</span>
          <span className="brand-city">Hyderabad</span>
        </div>
        <SearchBox corporate={corporate} onPick={pick} />
      </header>

      {cardOpen ? <Inspector building={selection!.building} place={selection!.place ?? null} sites={sites} onClose={() => setSelection(null)} /> : null}

      <MapControls
        onZoomIn={() => api.current?.zoomIn()}
        onZoomOut={() => api.current?.zoomOut()}
        onReset={() => api.current?.resetView()}
        settingsOpen={settingsOpen}
        onSettings={() => setSettingsOpen((o) => !o)}
      />
      {settingsOpen ? (
        <SettingsPanel
          look={look}
          onLook={setLook}
          showRoads={showRoads}
          onShowRoads={setShowRoads}
          showCoords={showCoords}
          onShowCoords={setShowCoords}
          datasetId={datasetId}
          onDataset={(id) => {
            setSelection(null)
            setDatasetId(id)
          }}
          onClose={() => setSettingsOpen(false)}
          visits={visits}
        />
      ) : null}

      {visits && meta ? <VisitCounter counts={visits} /> : null}

      {tileError ? (
        <p className="panel notice" role="status">
          Some parts of the map could not be loaded. Check your connection, then reload.
          <button className="icon-btn ghost" aria-label="Dismiss" onClick={() => setTileError(false)}>
            <CloseIcon size={14} />
          </button>
        </p>
      ) : null}

      {showCoords && cursor ? (
        <div className="coords" aria-hidden="true">
          {cursor[1].toFixed(5)}° N · {cursor[0].toFixed(5)}° E
        </div>
      ) : null}

      {!meta && !error ? (
        <div className="splash" role="status">
          <span className="spinner" aria-hidden="true" />
          Loading Hyderabad…
        </div>
      ) : null}
      {error ? (
        <p className="panel error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}
