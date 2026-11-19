import { useEffect, useRef } from 'react'
import * as maplibregl from 'maplibre-gl'
import type { GeoJSONSource, MapLayerMouseEvent, MapMouseEvent, RasterTileSource, VectorTileSource } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { Protocol } from 'pmtiles'
// Bundle MapLibre's module worker (and the chunk it imports) so it also works in production builds.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import { artToLngLat, imageToReal, nativeZoom, realToImage } from '../lib/projection'
import { readUrl, writeUrl } from '../lib/urlState'
import { siteTitle, type Corporate } from '../lib/corporate'
import type { Place } from '../lib/places'
import { DUSK, duskProtocol, setArtGeometry } from './duskLook'
import { DATASETS, type BuildingProps, type CorporateSite, type Dataset, type DatasetMeta } from '../types'

// The PMTiles protocol is global to MapLibre: register it once, before any map exists.
let protocolRegistered = false
function ensureProtocol() {
  if (protocolRegistered) return
  maplibregl.setWorkerUrl(workerUrl)
  const pm = new Protocol()
  maplibregl.addProtocol('pmtiles', pm.tile)
  maplibregl.addProtocol(DUSK, duskProtocol(pm)) // same archive, graded and textured in the browser
  protocolRegistered = true
}

export type Look = 'day' | 'dusk'
const PAPER: Record<Look, string> = { day: '#efe6d3', dusk: '#15171c' }
/** Dusk tiles arrive from workers a little later, so they fade in instead of popping. */
const FADE_MS: Record<Look, number> = { day: 0, dusk: 160 }
/** Absolute URL of a file in the dataset's folder (which may be on another host, like a CDN). */
const fileUrl = (dataset: Dataset, name: string) => new URL(`${dataset.base}/${name}`, window.location.href).href
/** The art source URL: the published archive, through the protocol of the chosen look. */
const artSourceUrl = (dataset: Dataset, art: string, look: Look) => `${look === 'dusk' ? DUSK : 'pmtiles'}://${fileUrl(dataset, art)}`

/** Map actions for the floating controls and search. */
export interface MapApi {
  zoomIn: () => void
  zoomOut: () => void
  resetView: () => void
  flyToSite: (site: CorporateSite) => void
  flyToPlace: (place: Place) => void
}

/** What is selected on the map: the footprints to outline, and whether they are an unverified site. */
export interface Highlight {
  ids: string[]
  unverified: boolean
}

interface Props {
  dataset: Dataset
  meta: DatasetMeta
  look: Look
  showRoads: boolean
  corporate: Corporate | null
  highlight: Highlight
  /** A searched place that is not a building: marked with a pin. [lon, lat] */
  pin: [number, number] | null
  /** Space taken by the details card on the left (px), so flights land beside it. */
  leftInset: number
  onSelectBuilding: (b: BuildingProps | null) => void
  onSelectSite: (site: CorporateSite) => void
  onCursor: (lonLat: [number, number] | null) => void
  onLoading: (loading: boolean) => void
  /** Map tiles failed to load (network, or a tile host without CORS / range support). */
  onTileError: () => void
  onReady: (api: MapApi) => void
}

const NONE = ['==', ['get', 'id'], '__none__'] as unknown as maplibregl.FilterSpecification
const idsFilter = (ids: string[]) => (ids.length ? (['in', ['get', 'id'], ['literal', ids]] as maplibregl.FilterSpecification) : NONE)
/** How often a growing tiled map checks for a newly published version. */
const LIVE_POLL_MS = 60_000
/** Company dots show while footprints are too small to read; outlines take over as you zoom in. */
const DOT_FADE: [number, number] = [14.6, 15.6]
const ACCENT = '#f1a24a'

/** Art-pixel box of the whole city grid. */
const cityBox = (meta: DatasetMeta) => meta.canvas ?? [0, 0, meta.projection.width, meta.projection.height]

/** The city canvas as map bounds, grown by `margin` (a fraction of its size) on every side. */
function boundsOf(meta: DatasetMeta, margin = 0): maplibregl.LngLatBoundsLike {
  const p = meta.projection
  const [cx0, cy0, cx1, cy1] = cityBox(meta)
  const mx = (cx1 - cx0) * margin
  const my = (cy1 - cy0) * margin
  const [west, north] = artToLngLat(p, cx0 - mx, cy0 - my)
  const [east, south] = artToLngLat(p, cx1 + mx, cy1 + my)
  return [
    [west, south],
    [east, north],
  ]
}
/** Pan limits: the whole city plus a 10 % margin. */
const panBounds = (meta: DatasetMeta) => boundsOf(meta, 0.1)
const cityPadding = () => (window.innerWidth < 720 ? 12 : 48)

/** How close a flight to a place comes, below the native zoom: areas wide, single places close. */
const PLACE_ZOOM: Record<string, number> = { locality: 4, street: 2, park: 2.4, campus: 2.4, landmark: 1.6, transit: 1.6 }
const EMPTY: maplibregl.GeoJSONSourceSpecification['data'] = { type: 'FeatureCollection', features: [] }

const pinData = (meta: DatasetMeta, pin: [number, number] | null): maplibregl.GeoJSONSourceSpecification['data'] =>
  pin
    ? { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: realToImage(meta.projection, pin[0], pin[1]) } }
    : EMPTY

const sitePoints = (meta: DatasetMeta, corporate: Corporate | null): maplibregl.GeoJSONSourceSpecification["data"] => ({
  type: 'FeatureCollection',
  features: (corporate?.sites ?? [])
    .filter((s) => s.status === 'confirmed')
    .map((s) => ({
      type: 'Feature',
      properties: { site: s.id },
      geometry: { type: 'Point', coordinates: realToImage(meta.projection, s.lon, s.lat) },
    })),
})

export function MapView(props: Props) {
  const { dataset, meta, look, showRoads, corporate, highlight } = props
  const container = useRef<HTMLDivElement>(null)
  const tooltip = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  // Latest props for map event handlers, without re-creating the map.
  const live = useRef(props)
  const lookRef = useRef(look)
  useEffect(() => {
    live.current = props
  })

  useEffect(() => {
    if (!container.current) return
    ensureProtocol()
    const p = meta.projection
    const url = readUrl()
    const native = nativeZoom(p)
    setArtGeometry(meta.zoom.max, p.k, p.v)
    const shared = url.lat !== undefined && url.lon !== undefined

    // Overlay: vector tiles for the tiled map (loads only what is in view), one GeoJSON for the prototypes.
    const vector = meta.overlay?.type === 'vector'
    const overlaySource: maplibregl.SourceSpecification = vector
      ? { type: 'vector', url: `pmtiles://${fileUrl(dataset, meta.overlay!.url)}` }
      : { type: 'geojson', data: `${dataset.base}/overlay.geojson` }
    // Where a feature class lives: a vector source layer, or a `layer` property in the GeoJSON.
    const ov = (name: string) =>
      (vector
        ? { source: 'overlay', 'source-layer': name }
        : { source: 'overlay', filter: ['==', ['get', 'layer'], name] }) as Record<string, unknown>

    const map = new maplibregl.Map({
      container: container.current,
      // A shared link opens where it points; otherwise the whole city.
      ...(shared
        ? { center: realToImage(p, url.lon!, url.lat!), zoom: url.zoom ?? native - 2 }
        : { bounds: boundsOf(meta), fitBoundsOptions: { padding: cityPadding() } }),
      minZoom: meta.zoom.min - 1,
      maxZoom: native + 2.5,
      maxBounds: panBounds(meta),
      renderWorldCopies: false,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      attributionControl: { compact: window.innerWidth < 720, customAttribution: meta.attribution },
      style: {
        version: 8,
        sources: {
          art: { type: 'raster', url: artSourceUrl(dataset, meta.art ?? 'art.pmtiles', lookRef.current), tileSize: 256 },
          overlay: overlaySource,
          sites: { type: 'geojson', data: sitePoints(meta, live.current.corporate) },
          pin: { type: 'geojson', data: pinData(meta, live.current.pin) },
        },
        layers: [
          { id: 'paper', type: 'background', paint: { 'background-color': PAPER[lookRef.current] } },
          { id: 'art', type: 'raster', source: 'art', paint: { 'raster-resampling': 'nearest', 'raster-fade-duration': FADE_MS[lookRef.current] } },
          {
            id: 'roads-debug', type: 'line', ...ov('road_centreline'),
            layout: { visibility: 'none' }, paint: { 'line-color': '#e0249a', 'line-width': 1.5 },
          },
          { id: 'buildings-hit', type: 'fill', ...ov('building'), paint: { 'fill-color': '#000', 'fill-opacity': 0 } },
          // Confirmed company buildings: a faint warm wash and a fine rim, so the art stays readable.
          {
            id: 'corp-fill', type: 'fill', ...ov('building'), filter: NONE,
            paint: { 'fill-color': ACCENT, 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 14, 0.16, 18, 0.07] },
          },
          {
            id: 'corp-line', type: 'line', ...ov('building'), filter: NONE,
            paint: { 'line-color': '#f6bd72', 'line-opacity': 0.75, 'line-width': ['interpolate', ['linear'], ['zoom'], 14, 0.8, 20, 1.6] },
          },
          {
            id: 'buildings-hover', type: 'line', ...ov('building'), filter: NONE,
            paint: { 'line-color': 'rgba(255, 244, 222, 0.55)', 'line-width': 1.2 },
          },
          { id: 'corp-hover', type: 'line', ...ov('building'), filter: NONE, paint: { 'line-color': '#ffd59a', 'line-width': 2.4 } },
          { id: 'selected-fill', type: 'fill', ...ov('building'), filter: NONE, paint: { 'fill-color': '#ff8a3d', 'fill-opacity': 0.2 } },
          {
            id: 'selected-line', type: 'line', ...ov('building'), filter: NONE,
            paint: { 'line-color': '#ff8a3d', 'line-width': ['interpolate', ['linear'], ['zoom'], 14, 1.6, 19, 2.6] },
          },
          {
            id: 'selected-unverified', type: 'line', ...ov('building'), filter: NONE,
            paint: { 'line-color': '#e8c27a', 'line-width': 2, 'line-dasharray': [2, 1.5] },
          },
          // Zoomed out, a company is a small lit dot until its footprint is big enough to outline.
          {
            id: 'site-halo', type: 'circle', source: 'sites', maxzoom: DOT_FADE[1],
            paint: {
              'circle-color': ACCENT,
              'circle-opacity': ['interpolate', ['linear'], ['zoom'], DOT_FADE[0], 0.22, DOT_FADE[1], 0],
              'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 6, 14, 11],
              'circle-blur': 0.6,
            },
          },
          {
            id: 'site-dot', type: 'circle', source: 'sites', maxzoom: DOT_FADE[1],
            paint: {
              'circle-color': ACCENT,
              'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 3, 14, 5],
              'circle-stroke-color': '#15171c',
              'circle-stroke-width': 1.5,
              'circle-opacity': ['interpolate', ['linear'], ['zoom'], DOT_FADE[0], 1, DOT_FADE[1], 0],
              'circle-stroke-opacity': ['interpolate', ['linear'], ['zoom'], DOT_FADE[0], 1, DOT_FADE[1], 0],
            },
          },
          // A searched place without a building: a soft ring and a dot, above everything else.
          {
            id: 'pin-halo', type: 'circle', source: 'pin',
            paint: { 'circle-color': '#ff8a3d', 'circle-opacity': 0.25, 'circle-radius': 16, 'circle-blur': 0.5 },
          },
          {
            id: 'pin-dot', type: 'circle', source: 'pin',
            paint: { 'circle-color': '#ff8a3d', 'circle-radius': 6, 'circle-stroke-color': '#fff4e6', 'circle-stroke-width': 2 },
          },
        ] as maplibregl.LayerSpecification[],
      },
    })
    map.once('load', () => styled.add(map))
    map.touchZoomRotate.disableRotation()
    // On phones the attribution starts folded into its (i) button, which opens it.
    if (window.innerWidth < 720)
      map.once('load', () => container.current?.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show'))
    mapRef.current = map
    ;(window as unknown as { __map: maplibregl.Map }).__map = map // for browser tests

    // ---- hover: any building gets a faint rim; a company building a bright one and its name
    const tip = (text: string | null, point?: maplibregl.Point) => {
      const el = tooltip.current
      if (!el) return
      el.hidden = !text
      if (text && point) {
        el.textContent = text
        el.style.transform = `translate(${Math.round(point.x)}px, ${Math.round(point.y)}px)`
      }
    }
    map.on('mousemove', 'buildings-hit', (e: MapLayerMouseEvent) => {
      const f = e.features?.[0]
      if (!f) return
      const id = String(f.properties.id)
      const sites = live.current.corporate?.byBuilding.get(id)
      map.getCanvas().style.cursor = 'pointer'
      map.setFilter('buildings-hover', sites ? NONE : idsFilter([id]))
      map.setFilter('corp-hover', sites ? idsFilter([id]) : NONE)
      tip(sites ? sites.map((s) => siteTitle(s) + (s.status === 'unverified' ? ' (unverified)' : '')).join(' · ') : null, e.point)
    })
    map.on('mouseleave', 'buildings-hit', () => {
      map.getCanvas().style.cursor = ''
      map.setFilter('buildings-hover', NONE)
      map.setFilter('corp-hover', NONE)
      tip(null)
    })
    map.on('mousemove', 'site-dot', (e: MapLayerMouseEvent) => {
      const site = live.current.corporate?.byId.get(String(e.features?.[0]?.properties.site))
      map.getCanvas().style.cursor = 'pointer'
      if (site) tip(siteTitle(site), e.point)
    })
    map.on('mouseleave', 'site-dot', () => {
      map.getCanvas().style.cursor = ''
      tip(null)
    })
    map.on('click', (e: MapMouseEvent) => {
      if (map.getZoom() < DOT_FADE[0]) {
        const dot = map.queryRenderedFeatures(e.point, { layers: ['site-dot'] })[0]
        const site = dot && live.current.corporate?.byId.get(String(dot.properties.site))
        if (site) {
          live.current.onSelectSite(site)
          return
        }
      }
      const hits = map.queryRenderedFeatures(e.point, { layers: ['buildings-hit'] })
      // Several silhouettes can overlap on screen; the last-drawn (nearest) building wins.
      const props = hits.map((h: maplibregl.MapGeoJSONFeature) => h.properties as unknown as BuildingProps & { depth: number })
      props.sort((a: { depth: number }, b: { depth: number }) => a.depth - b.depth)
      live.current.onSelectBuilding(props[0] ?? null)
    })
    map.on('mousemove', (e: MapMouseEvent) => live.current.onCursor(imageToReal(p, e.lngLat.lng, e.lngLat.lat)))
    map.on('mouseout', () => {
      live.current.onCursor(null)
      tip(null)
    })
    map.on('movestart', () => tip(null))

    // ---- loading indicator: busy while tiles for the view are still arriving
    map.on('dataloading', () => live.current.onLoading(true))
    map.on('idle', () => live.current.onLoading(false))
    map.on('error', (e: maplibregl.ErrorEvent & { sourceId?: string }) => {
      if (e.sourceId === 'art' || e.sourceId === 'overlay') live.current.onTileError()
      else console.error(e.error)
    })

    const sync = () => {
      const c = map.getCenter()
      const [lon, lat] = imageToReal(p, c.lng, c.lat)
      writeUrl({ ...readUrl(), dataset: dataset.id === DATASETS[0].id ? undefined : dataset.id, lat, lon, zoom: map.getZoom() })
    }
    map.on('moveend', sync)
    const onPop = () => {
      const s = readUrl()
      if (s.lat === undefined || s.lon === undefined) return
      map.jumpTo({ center: realToImage(p, s.lon, s.lat), zoom: s.zoom ?? map.getZoom() })
    }
    window.addEventListener('popstate', onPop)

    // Restore a selected building from the URL once the overlay has loaded.
    if (url.building && !url.site) {
      const id = url.building
      if (vector) {
        // Vector tiles only hold what is loaded; a shared view is centred on the building, so it is.
        map.once('idle', () => {
          const f = map.querySourceFeatures('overlay', { sourceLayer: 'building', filter: ['==', ['get', 'id'], id] })[0]
          if (f) live.current.onSelectBuilding(f.properties as unknown as BuildingProps)
        })
      } else {
        map.once('load', async () => {
          type Feature = { properties: Record<string, unknown> | null }
          const data = (await (map.getSource('overlay') as GeoJSONSource).getData()) as unknown as { features: Feature[] }
          const f = data.features.find((x: Feature) => x.properties?.layer === 'building' && x.properties?.id === id)
          if (f) live.current.onSelectBuilding(f.properties as unknown as BuildingProps)
        })
      }
    }

    const ease = { duration: 450 }
    /** Room around a flight's target: clear of the card (left, or a bottom sheet on phones) and the top bar. */
    const flightPadding = (tall: boolean) =>
      window.innerWidth < 720
        ? { top: 150, bottom: Math.round(window.innerHeight * 0.45), left: 30, right: 30 }
        : // Points are at ground level and buildings rise above them: leave more room at the top.
          { top: tall ? 260 : 140, bottom: 90, left: live.current.leftInset + 80, right: 120 }
    live.current.onReady({
      zoomIn: () => map.zoomIn(ease),
      zoomOut: () => map.zoomOut(ease),
      resetView: () => map.fitBounds(boundsOf(meta), { padding: cityPadding(), duration: 1200 }),
      flyToSite: (site) => {
        const pts = [...site.buildings.map((b) => [b.lon, b.lat]), [site.lon, site.lat]].map(([lon, lat]) => realToImage(p, lon, lat))
        const xs = pts.map((q) => q[0])
        const ys = pts.map((q) => q[1])
        const pad = flightPadding(true)
        map.fitBounds(
          [
            [Math.min(...xs), Math.min(...ys)],
            [Math.max(...xs), Math.max(...ys)],
          ],
          { padding: pad, maxZoom: native - 1.2, duration: 1800, essential: true },
        )
      },
      flyToPlace: (place) => {
        const zoom = native - (place.buildingId ? 1.2 : PLACE_ZOOM[place.cat] ?? 1.4)
        const pad = flightPadding(!!place.buildingId)
        // Streets and areas fit their extent (all four corners: the projection is isometric); a point
        // is a zero-size box, so it lands at `zoom` inside the same padding. (flyTo's padding would
        // stay on the camera afterwards.)
        const [w, s, e, n] = place.bbox ?? [place.lon, place.lat, place.lon, place.lat]
        const pts = [[w, s], [w, n], [e, s], [e, n]].map(([lon, lat]) => realToImage(p, lon, lat))
        const xs = pts.map((q) => q[0])
        const ys = pts.map((q) => q[1])
        map.fitBounds(
          [
            [Math.min(...xs), Math.min(...ys)],
            [Math.max(...xs), Math.max(...ys)],
          ],
          { padding: pad, maxZoom: zoom, duration: 1800, essential: true },
        )
      },
    })

    return () => {
      window.removeEventListener('popstate', onPop)
      map.remove()
      mapRef.current = null
    }
  }, [dataset, meta])

  // Live updates (development): while the city grid grows, each batch publishes new versioned
  // archives. Swap them in place (keeping the view) instead of waiting for a manual reload.
  useEffect(() => {
    if (!meta.art || !import.meta.env.DEV) return
    let shown = { art: meta.art, overlay: meta.overlay?.url, canvas: String(meta.canvas) }
    const timer = window.setInterval(async () => {
      const map = mapRef.current
      if (!map || document.hidden || !map.isStyleLoaded()) return
      let next: DatasetMeta
      try {
        next = await (await fetch(`${dataset.base}/meta.json`, { cache: 'no-store' })).json()
      } catch {
        return // publishing in progress or server restarting: try again next time
      }
      if (next.art && next.art !== shown.art) map.getSource<RasterTileSource>('art')?.setUrl(artSourceUrl(dataset, next.art, lookRef.current))
      if (next.overlay?.url && next.overlay.url !== shown.overlay) {
        map.getSource<VectorTileSource>('overlay')?.setUrl(`pmtiles://${fileUrl(dataset, next.overlay.url)}`)
      }
      if (String(next.canvas) !== shown.canvas) map.setMaxBounds(panBounds(next))
      shown = { art: next.art ?? shown.art, overlay: next.overlay?.url, canvas: String(next.canvas) }
    }, LIVE_POLL_MS)
    return () => window.clearInterval(timer)
  }, [dataset, meta])

  // Company data: dots for zoomed-out views and the outline of every confirmed building.
  useEffect(() => {
    whenReady(mapRef.current, (map) => {
      map.getSource<GeoJSONSource>('sites')?.setData(sitePoints(meta, corporate))
      const ids = corporate?.confirmedBuildings ?? []
      map.setFilter('corp-fill', idsFilter(ids))
      map.setFilter('corp-line', idsFilter(ids))
    })
  }, [corporate, meta])

  const pin = props.pin
  const pinKey = pin ? pin.join(',') : ''
  useEffect(() => {
    whenReady(mapRef.current, (map) => map.getSource<GeoJSONSource>('pin')?.setData(pinData(meta, pin)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinKey, meta])

  const { ids, unverified } = highlight
  const highlightKey = `${unverified}|${ids.join(',')}`
  useEffect(() => {
    whenReady(mapRef.current, (map) => {
      const f = idsFilter(ids)
      map.setFilter('selected-fill', unverified ? NONE : f)
      map.setFilter('selected-line', unverified ? NONE : f)
      map.setFilter('selected-unverified', unverified ? f : NONE)
    })
    // The key captures `ids` and `unverified`; a new array with the same ids needs no update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightKey])

  // Switch look in place: same archive, other protocol; the view stays where it is.
  const artName = useRef(meta.art ?? 'art.pmtiles')
  useEffect(() => {
    lookRef.current = look
    whenReady(mapRef.current, (map) => {
      const src = map.getSource<RasterTileSource>('art')
      const name = src?.url?.split('/').pop() ?? artName.current
      const url = artSourceUrl(dataset, name, look)
      if (src && src.url !== url) src.setUrl(url)
      map.setPaintProperty('paper', 'background-color', PAPER[look])
      map.setPaintProperty('art', 'raster-fade-duration', FADE_MS[look])
    })
  }, [dataset, look])

  useEffect(() => {
    whenReady(mapRef.current, (map) => map.setLayoutProperty('roads-debug', 'visibility', showRoads ? 'visible' : 'none'))
  }, [showRoads])

  return (
    <div className="map-wrap">
      <div ref={container} className="map" role="region" aria-label="Isometric map of Hyderabad. Drag to move, scroll or pinch to zoom, select a building for details." />
      <div ref={tooltip} className="map-tip" hidden role="tooltip" />
    </div>
  )
}

/** Maps whose style has loaded. (`isStyleLoaded()` is also false while tiles load, and 'load' fires once.) */
const styled = new WeakSet<maplibregl.Map>()

/** Run once the map's style is ready (immediately if it already is). */
function whenReady(map: maplibregl.Map | null, apply: (map: maplibregl.Map) => void) {
  if (!map) return
  if (styled.has(map) || map.isStyleLoaded()) apply(map)
  else map.once('load', () => apply(map))
}
