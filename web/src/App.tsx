import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MapView, type Highlight, type HomesLayer, type Look, type MapApi } from './map/MapView'
import { readUrl, writeUrl } from './lib/urlState'
import { loadCorporate, siteTitle, type Corporate } from './lib/corporate'
import {
  assessAll,
  DEFAULT_PREFERENCES,
  litPlaces,
  loadHomes,
  markAt,
  loadNearbyPlaces,
  MAX_COMPARE,
  type Homes,
  type NearbyPlace,
  type Preferences,
} from './lib/homes'
import { assessAllPgs, byFit, idOf, isPg, isPgId, loadPgs, nameOf, type Found, type PgHomes } from './lib/pgs'
import type { Workplace } from './lib/homesUrl'
import { loadPlaces, type Place } from './lib/places'
import { trackVisits, type VisitCounts } from './lib/visits'
import type { Hit } from './lib/discover'
import { Inspector } from './ui/Inspector'
import { HomesPanel } from './ui/HomesPanel'
import { SocietyCard } from './ui/SocietyCard'
import { PgCard } from './ui/PgCard'
import { CompareStrip } from './ui/CompareStrip'
import { VERDICT_TEXT } from './ui/homesText'
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

/** Residential mode (off by default): where the person works, and the home (society or PG) whose card is open. */
type HomesMode = { workplace: Workplace; society: string | null }

/** Where the map marks a home: a society's buildings, or a PG's listed point. [lon, lat] */
const pointOf = (a: Found): [number, number] => (isPg(a) ? [a.pg.lon, a.pg.lat] : markAt(a.society))

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
  // Residential mode; the preferences outlive it, so reopening keeps them.
  const [homesMode, setHomesMode] = useState<HomesMode | null>(() => {
    const h = readUrl().homes
    return h ? { workplace: h.workplace, society: h.society } : null
  })
  const [prefs, setPrefs] = useState<Preferences>(() => readUrl().homes?.prefs ?? DEFAULT_PREFERENCES)
  const [homes, setHomes] = useState<Homes | null>(null)
  const [homesFailed, setHomesFailed] = useState(false)
  const [pgs, setPgs] = useState<PgHomes | null>(null)
  const [pgsFailed, setPgsFailed] = useState(false)
  const fitHomes = useRef(false) // show the workplace and its societies once the data arrives
  const homesOn = !!homesMode
  // Societies compared side by side (numbered 1-3 on the map); kept, like the preferences, between searches.
  const [compare, setCompare] = useState<string[]>(() => readUrl().homes?.compare ?? [])
  const [lit, setLit] = useState<string | null>(null) // the comparison row whose places are lit
  // The places behind comparison rows, per places file (the societies' and the PGs' are separate).
  const [placeFiles, setPlaceFiles] = useState<Record<string, Map<string, NearbyPlace>>>({})
  const [stripHeight, setStripHeight] = useState(0)

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

  // Residential data loads on first use.
  useEffect(() => {
    if (!homesOn || homes) return
    let cancelled = false
    loadHomes().then((h) => {
      if (cancelled) return
      setHomes(h)
      setHomesFailed(!h)
    })
    return () => {
      cancelled = true
    }
  }, [homesOn, homes])

  const workplace = homesMode?.workplace ?? null
  const assessments = useMemo(
    () => (homes && workplace ? assessAll(prefs, { data: homes.data, commute: homes.commute, workplace }) : []),
    [homes, workplace, prefs],
  )
  // PGs load the first time they are shown, compared or opened (a shared link may hold PG ids).
  const showSocieties = prefs.show !== 'pgs'
  const showPgs = prefs.show !== 'societies'
  const wantPgs = homesOn && (showPgs || compare.some(isPgId) || isPgId(homesMode?.society ?? ''))
  useEffect(() => {
    if (!wantPgs || pgs) return
    let cancelled = false
    loadPgs().then((p) => {
      if (cancelled) return
      setPgs(p)
      setPgsFailed(!p)
    })
    return () => {
      cancelled = true
    }
  }, [wantPgs, pgs])
  const hoods = useMemo(() => [...(homes?.data.neighbourhoods ?? []), ...(pgs?.data.neighbourhoods ?? [])], [homes, pgs])
  const pgAssessments = useMemo(
    () => (pgs && workplace ? assessAllPgs(prefs, { pgs, hoods, workplace }) : []),
    [pgs, hoods, workplace, prefs],
  )
  // The homes of the kinds shown, best fit first (for societies alone, the same order as assessAll's).
  const found: Found[] = useMemo(
    () => [...(showSocieties ? assessments : []), ...(showPgs ? pgAssessments : [])].sort(byFit),
    [assessments, pgAssessments, showSocieties, showPgs],
  )
  const byId = useCallback(
    (id: string): Found | undefined =>
      isPgId(id) ? pgAssessments.find((a) => a.pg.id === id) : assessments.find((a) => a.society.id === id),
    [assessments, pgAssessments],
  )
  const openHome = homesMode?.society ? byId(homesMode.society) : undefined
  const openSociety = openHome && !isPg(openHome) ? openHome : undefined
  const openPg = openHome && isPg(openHome) ? openHome : undefined
  // Ids that name a known home (a shared link may hold old ones), and their assessments in order. PG ids
  // stay until the PG data is in, so a link to a comparison keeps them.
  const compareIds = useMemo(
    () => compare.filter((id) => (isPgId(id) ? !pgs || pgs.byId.has(id) : !homes || homes.byId.has(id))),
    [homes, pgs, compare],
  )
  const compared = useMemo(() => compareIds.map(byId).filter((a) => a !== undefined), [compareIds, byId])
  const comparing = homesOn && compared.length > 0

  // The places behind the comparison rows load the first time a home of that kind is compared.
  const placesFor = useMemo(
    () =>
      [
        compared.some((a) => !isPg(a)) && homes ? homes.data.amenities.places_file : null,
        compared.some(isPg) && pgs ? pgs.data.amenities.places_file : null,
      ].filter((f): f is string => !!f),
    [compared, homes, pgs],
  )
  useEffect(() => {
    let cancelled = false
    for (const f of placesFor)
      if (!placeFiles[f]) loadNearbyPlaces(f).then((m) => !cancelled && m && setPlaceFiles((x) => ({ ...x, [f]: m })))
    return () => {
      cancelled = true
    }
  }, [placesFor, placeFiles])
  const nearbyPlaces = useMemo(() => new Map(Object.values(placeFiles).flatMap((m) => [...m])), [placeFiles])
  const comparedHomes = useMemo(() => compared.map((a) => (isPg(a) ? a.pg : a.society)), [compared])

  // Society footprints by verdict ("no" is hidden), a dot for each match or likely one when zoomed out, and
  // a diamond for each PG shown that is not ruled out.
  const homesLayer: HomesLayer | null = useMemo(() => {
    if (!homes || !homesOn) return null
    const societies = showSocieties ? assessments : []
    const of = (v: string) => societies.filter((a) => a.verdict === v).flatMap((a) => a.society.buildings)
    return {
      match: of('match'),
      likely: of('likely'),
      unknown: of('unknown'),
      selected: openSociety?.society.buildings ?? [],
      dots: societies
        .filter((a) => a.verdict === 'match' || a.verdict === 'likely')
        .map((a) => {
          const [lon, lat] = markAt(a.society)
          return { id: a.society.id, name: a.society.name, lon, lat, verdict: a.verdict as 'match' | 'likely' }
        }),
      names: new Map(societies.flatMap((a) => a.society.buildings.map((b) => [b, `${a.society.name} · ${VERDICT_TEXT[a.verdict]}`] as const))),
      pgs: (showPgs ? pgAssessments : [])
        .filter((a) => a.verdict !== 'no')
        .map((a) => ({ id: a.pg.id, name: a.pg.name, lon: a.pg.lon, lat: a.pg.lat, verdict: a.verdict as 'match' | 'likely' | 'unknown', tip: `${a.pg.name} · ${VERDICT_TEXT[a.verdict]}` })),
      openPg: openPg
        ? {
            lon: openPg.pg.lon,
            lat: openPg.pg.lat,
            name: openPg.pg.name,
            others: openPg.pg.location.from === 'overture' ? (openPg.pg.location.others ?? []) : [],
          }
        : null,
      compare: compared.map((a) => {
        const [lon, lat] = pointOf(a)
        return { id: idOf(a), name: nameOf(a), lon, lat }
      }),
      lit: comparing && lit ? litPlaces(comparedHomes, lit, nearbyPlaces, homes.stations) : [],
    }
  }, [homes, homesOn, assessments, pgAssessments, showSocieties, showPgs, openSociety, openPg, compared, comparedHomes, comparing, lit, nearbyPlaces])

  // Once the data for what is shown is in, bring the workplace and the homes shown into view.
  useEffect(() => {
    if (!fitHomes.current || !homes || !workplace || (showPgs && !pgs && !pgsFailed)) return
    fitHomes.current = false
    const shown = found.filter((a) => a.verdict !== 'no').map(pointOf)
    api.current?.fitPoints([[workplace.lon, workplace.lat], ...shown])
  }, [homes, pgs, pgsFailed, showPgs, workplace, found])
  const changePrefs = useCallback(
    (p: Preferences) => {
      if (p.show !== prefs.show) fitHomes.current = true // the other kind of home may be elsewhere
      setPrefs(p)
    },
    [prefs.show],
  )

  // Residential parameters live in the URL only while the mode is on.
  useEffect(() => {
    writeUrl({ ...readUrl(), homes: homesMode ? { workplace: homesMode.workplace, prefs, society: homesMode.society, compare: compareIds } : undefined })
  }, [homesMode, prefs, compareIds])

  // A searched place that is not a building gets a pin; so does a workplace with nothing outlined.
  const place = selection?.place
  const pin: [number, number] | null =
    place && !place.buildingId ? [place.lon, place.lat] : workplace && !highlight.ids.length ? [workplace.lon, workplace.lat] : null

  // Keep the selection in the URL so a shared link opens the same card.
  useEffect(() => {
    const url = readUrl()
    if (!corporate && url.site) return // wait for company data before touching a shared site link
    if (!selection && url.place) return // ...and for the place index before touching a shared place link
    const site = !selection?.building && !selection?.place && sites.length ? sites[0].id : undefined
    writeUrl({ ...url, building: selection?.building?.id, site, place: selection?.place?.id })
  }, [selection, sites, corporate])

  const showSociety = useCallback(
    (id: string, fly: boolean) => {
      setHomesMode((m) => (m ? { ...m, society: id } : m))
      const p = isPgId(id) ? pgs?.byId.get(id) : undefined
      const s = isPgId(id) ? undefined : homes?.byId.get(id)
      const at: [number, number] | null = p ? [p.lon, p.lat] : s ? markAt(s) : null
      if (fly && at) api.current?.fitPoints([at])
    },
    [homes, pgs],
  )
  // In residential mode a map click opens a society's card; other buildings and company dots do nothing.
  const selectBuilding = useCallback(
    (b: BuildingProps | null) => {
      if (!homesOn) return setSelection(b ? { building: b, siteId: null } : null)
      const s = b ? homes?.byBuilding.get(b.id) : undefined
      if (s) showSociety(s.id, false)
    },
    [homesOn, homes, showSociety],
  )
  const toggleCompare = useCallback(
    (id: string) =>
      setCompare((c) => (c.includes(id) ? c.filter((x) => x !== id) : c.length < MAX_COMPARE ? [...c, id] : c)),
    [],
  )
  const showSite = useCallback((s: CorporateSite) => {
    setSelection({ building: null, siteId: s.id })
    api.current?.flyToSite(s)
  }, [])
  const selectSite = useCallback((s: CorporateSite) => (homesOn ? undefined : showSite(s)), [homesOn, showSite])
  const pick = useCallback(
    (h: Hit) => {
      setHomesMode(null) // a search leaves residential mode
      if (h.type === 'site') return showSite(h.site)
      setSelection({ building: null, siteId: null, place: h.place })
      api.current?.flyToPlace(h.place)
    },
    [showSite],
  )
  /** Start residential mode from the open card: its place, company site or building is the workplace. */
  const findHomes = useCallback(() => {
    if (!selection) return
    const b = selection.building
    const label = selection.place?.name ?? (sites[0] ? siteTitle(sites[0]) : b?.name) ?? 'Selected building'
    const ground = selection.place
      ? [selection.place.lon, selection.place.lat]
      : b
        ? (api.current?.buildingGround(b.id, b.height_m) ?? (sites[0] ? [sites[0].lon, sites[0].lat] : null))
        : sites[0]
          ? [sites[0].lon, sites[0].lat]
          : null
    if (!ground) return
    fitHomes.current = true
    setHomesMode({ workplace: { lon: ground[0], lat: ground[1], label }, society: null })
  }, [selection, sites])
  const onReady = useCallback((a: MapApi) => {
    api.current = a
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement).tagName)) return
      if (settingsOpen) setSettingsOpen(false)
      else if (homesMode?.society) setHomesMode({ ...homesMode, society: null })
      else if (homesMode) setHomesMode(null)
      else setSelection(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [settingsOpen, homesMode])

  const cardOpen = !!selection && (!!selection.building || !!selection.place || sites.length > 0)
  const slotOpen = cardOpen || homesOn

  return (
    <div className={`app look-${look}${slotOpen ? ' has-card' : ''}`}>
      {meta ? (
        <MapView
          key={dataset.id}
          dataset={dataset}
          meta={meta}
          look={look}
          showRoads={showRoads}
          corporate={corporate}
          highlight={highlight}
          homes={homesLayer}
          onSelectSociety={(id) => showSociety(id, true)}
          pin={pin}
          leftInset={slotOpen ? CARD_INSET : 0}
          bottomInset={comparing ? stripHeight : 0}
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

      {homesMode ? (
        openPg && pgs ? (
          <PgCard
            assessment={openPg}
            pgs={pgs}
            hoods={hoods}
            workplace={homesMode.workplace}
            compareAt={compareIds.indexOf(openPg.pg.id)}
            comparing={compareIds.length}
            onCompare={() => toggleCompare(openPg.pg.id)}
            onBack={() => setHomesMode({ ...homesMode, society: null })}
          />
        ) : openSociety && homes ? (
          <SocietyCard
            assessment={openSociety}
            homes={homes}
            workplace={homesMode.workplace}
            compareAt={compareIds.indexOf(openSociety.society.id)}
            comparing={compareIds.length}
            onCompare={() => toggleCompare(openSociety.society.id)}
            onBack={() => setHomesMode({ ...homesMode, society: null })}
          />
        ) : (
          <HomesPanel
            workplace={homesMode.workplace}
            homes={homes}
            failed={homesFailed}
            pgs={pgs}
            pgsFailed={pgsFailed}
            hoods={hoods}
            prefs={prefs}
            onPrefs={changePrefs}
            found={found}
            onOpen={(id) => showSociety(id, true)}
            compare={compareIds}
            onClose={() => setHomesMode(null)}
          />
        )
      ) : cardOpen ? (
        <Inspector building={selection!.building} place={selection!.place ?? null} sites={sites} onClose={() => setSelection(null)} onFindHomes={findHomes} />
      ) : null}

      {comparing && homes ? (
        <div className="compare-wrap">
          <CompareStrip
            compared={compared}
            homes={homes}
            pgs={pgs}
            prefs={prefs}
            onLit={setLit}
            onShowRow={(row) =>
              api.current?.fitPoints([
                ...compared.map(pointOf),
                ...litPlaces(comparedHomes, row, nearbyPlaces, homes.stations).map((p): [number, number] => [p.lon, p.lat]),
              ])
            }
            onOpen={(id) => showSociety(id, true)}
            onShowAll={() => api.current?.fitPoints([[homesMode!.workplace.lon, homesMode!.workplace.lat], ...compared.map(pointOf)])}
            onRemove={toggleCompare}
            onClear={() => setCompare([])}
            onHeight={setStripHeight}
          />
        </div>
      ) : null}

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
            setHomesMode(null)
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
