import { useEffect, useRef } from 'react'
import * as maplibregl from 'maplibre-gl'
import type { GeoJSONSource, MapLayerMouseEvent, MapMouseEvent, RasterTileSource, VectorTileSource } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { Protocol } from 'pmtiles'
// Bundle MapLibre's module worker (and the chunk it imports) so it also works in production builds.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import { artToLngLat, imageToReal, nativeZoom, realToImage } from '../lib/projection'
import { readUrl, writeUrl } from '../lib/urlState'
import { DUSK, duskProtocol, setArtGeometry } from './duskLook'
import type { BuildingProps, Dataset, DatasetMeta } from '../types'

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
/** The art source URL: the published archive, through the protocol of the chosen look. */
const artSourceUrl = (dataset: Dataset, art: string, look: Look) =>
  `${look === 'dusk' ? DUSK : 'pmtiles'}://${window.location.origin}${dataset.base}/${art}`

interface Props {
  dataset: Dataset
  meta: DatasetMeta
  look: Look
  showRoads: boolean
  selectedId: string | null
  onSelect: (b: BuildingProps | null) => void
  onCursor: (lonLat: [number, number] | null) => void
}

const NO_MATCH = ['==', ['get', 'id'], '__none__'] as const
/** How often a growing tiled map checks for a newly published version. */
const LIVE_POLL_MS = 60_000

/** Pan limits: the whole city canvas (may extend to negative art px) plus a 10 % margin. */
function panBounds(meta: DatasetMeta): maplibregl.LngLatBoundsLike {
  const p = meta.projection
  const [cx0, cy0, cx1, cy1] = meta.canvas ?? [0, 0, p.width, p.height]
  const mx = (cx1 - cx0) * 0.1
  const my = (cy1 - cy0) * 0.1
  const [west, north] = artToLngLat(p, cx0 - mx, cy0 - my)
  const [east, south] = artToLngLat(p, cx1 + mx, cy1 + my)
  return [
    [west, south],
    [east, north],
  ]
}

export function MapView({ dataset, meta, look, showRoads, selectedId, onSelect, onCursor }: Props) {
  const container = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const selectRef = useRef(onSelect)
  const cursorRef = useRef(onCursor)
  const lookRef = useRef(look)
  // Keep the latest callbacks for map event handlers without re-creating the map.
  useEffect(() => {
    selectRef.current = onSelect
    cursorRef.current = onCursor
  }, [onSelect, onCursor])

  useEffect(() => {
    if (!container.current) return
    ensureProtocol()
    const p = meta.projection
    const origin = window.location.origin
    const url = readUrl()
    const centre =
      url.lat !== undefined && url.lon !== undefined
        ? realToImage(p, url.lon, url.lat)
        : artToLngLat(p, meta.centre.art_px[0], meta.centre.art_px[1])
    const native = nativeZoom(p)
    setArtGeometry(meta.zoom.max, p.k, p.v)

    // Overlay: vector tiles for the tiled map (loads only what is in view), one GeoJSON for the prototypes.
    const vector = meta.overlay?.type === 'vector'
    const overlaySource: maplibregl.SourceSpecification = vector
      ? { type: 'vector', url: `pmtiles://${origin}${dataset.base}/${meta.overlay!.url}` }
      : { type: 'geojson', data: `${dataset.base}/overlay.geojson` }
    // Where a feature class lives: a vector source layer, or a `layer` property in the GeoJSON.
    const ov = (name: string) =>
      (vector
        ? { source: 'overlay', 'source-layer': name }
        : { source: 'overlay', filter: ['==', ['get', 'layer'], name] }) as Record<string, unknown>

    const map = new maplibregl.Map({
      container: container.current,
      center: centre,
      zoom: url.zoom ?? native - 0.6,
      minZoom: meta.zoom.min - 1,
      maxZoom: native + 2.5,
      maxBounds: panBounds(meta),
      renderWorldCopies: false,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      attributionControl: { compact: false, customAttribution: meta.attribution },
      style: {
        version: 8,
        sources: {
          art: { type: 'raster', url: artSourceUrl(dataset, meta.art ?? 'art.pmtiles', lookRef.current), tileSize: 256 },
          overlay: overlaySource,
        },
        layers: [
          { id: 'paper', type: 'background', paint: { 'background-color': PAPER[lookRef.current] } },
          { id: 'art', type: 'raster', source: 'art', paint: { 'raster-resampling': 'nearest', 'raster-fade-duration': FADE_MS[lookRef.current] } },
          // No area outline, generation grid or POI markers: the art stands on its own.
          {
            id: 'roads-debug', type: 'line', ...ov('road_centreline'),
            layout: { visibility: 'none' }, paint: { 'line-color': '#e0249a', 'line-width': 1.5 },
          },
          { id: 'buildings-hit', type: 'fill', ...ov('building'), paint: { 'fill-color': '#000', 'fill-opacity': 0 } },
          {
            id: 'buildings-hover', type: 'line', ...ov('building'), filter: NO_MATCH as unknown as maplibregl.FilterSpecification,
            paint: { 'line-color': '#ffd166', 'line-width': 2 },
          },
          {
            id: 'buildings-selected-fill', type: 'fill', ...ov('building'), filter: NO_MATCH as unknown as maplibregl.FilterSpecification,
            paint: { 'fill-color': '#ff7a33', 'fill-opacity': 0.18 },
          },
          {
            id: 'buildings-selected', type: 'line', ...ov('building'), filter: NO_MATCH as unknown as maplibregl.FilterSpecification,
            paint: { 'line-color': '#ff6a1f', 'line-width': 2.5 },
          },
        ] as maplibregl.LayerSpecification[],
      },
    })
    map.touchZoomRotate.disableRotation()
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
    mapRef.current = map
    ;(window as unknown as { __map: maplibregl.Map }).__map = map // for browser tests

    const idFilter = (id: string) => ['==', ['get', 'id'], id] as maplibregl.FilterSpecification
    map.on('mousemove', 'buildings-hit', (e: MapLayerMouseEvent) => {
      const f = e.features?.[0]
      if (!f) return
      map.getCanvas().style.cursor = 'pointer'
      map.setFilter('buildings-hover', idFilter(String(f.properties.id)))
    })
    map.on('mouseleave', 'buildings-hit', () => {
      map.getCanvas().style.cursor = ''
      map.setFilter('buildings-hover', NO_MATCH as unknown as maplibregl.FilterSpecification)
    })
    map.on('click', (e: MapMouseEvent) => {
      const hits = map.queryRenderedFeatures(e.point, { layers: ['buildings-hit'] })
      // Several silhouettes can overlap on screen; the last-drawn (nearest) building wins.
      const props = hits.map((h: maplibregl.MapGeoJSONFeature) => h.properties as unknown as BuildingProps & { depth: number })
      props.sort((a: { depth: number }, b: { depth: number }) => a.depth - b.depth)
      selectRef.current(props[0] ?? null)
    })
    map.on('mousemove', (e: MapMouseEvent) => cursorRef.current(imageToReal(p, e.lngLat.lng, e.lngLat.lat)))
    map.on('mouseout', () => cursorRef.current(null))

    const sync = () => {
      const c = map.getCenter()
      const [lon, lat] = imageToReal(p, c.lng, c.lat)
      const prev = readUrl()
      writeUrl({ dataset: dataset.id, lat, lon, zoom: map.getZoom(), building: prev.building })
    }
    map.on('moveend', sync)
    map.once('load', sync) // record the dataset and view even before the first move
    const onPop = () => {
      const s = readUrl()
      if (s.lat === undefined || s.lon === undefined) return
      map.jumpTo({ center: realToImage(p, s.lon, s.lat), zoom: s.zoom ?? map.getZoom() })
    }
    window.addEventListener('popstate', onPop)

    // Restore a selected building from the URL once the overlay has loaded.
    if (url.building) {
      const id = url.building
      if (vector) {
        // Vector tiles only hold what is loaded; a shared view is centred on the building, so it is.
        map.once('idle', () => {
          const f = map.querySourceFeatures('overlay', { sourceLayer: 'building', filter: ['==', ['get', 'id'], id] })[0]
          if (f) selectRef.current(f.properties as unknown as BuildingProps)
        })
      } else {
        map.once('load', async () => {
          type Feature = { properties: Record<string, unknown> | null }
          const data = (await (map.getSource('overlay') as GeoJSONSource).getData()) as unknown as { features: Feature[] }
          const f = data.features.find((x: Feature) => x.properties?.layer === 'building' && x.properties?.id === id)
          if (f) selectRef.current(f.properties as unknown as BuildingProps)
        })
      }
    }

    return () => {
      window.removeEventListener('popstate', onPop)
      map.remove()
      mapRef.current = null
    }
  }, [dataset, meta])

  // Live updates: while the city grid grows, each batch publishes new versioned archives.
  // Swap them in place (keeping the view) instead of waiting for a manual reload.
  useEffect(() => {
    if (!meta.art) return
    const origin = window.location.origin
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
        map.getSource<VectorTileSource>('overlay')?.setUrl(`pmtiles://${origin}${dataset.base}/${next.overlay.url}`)
      }
      if (String(next.canvas) !== shown.canvas) map.setMaxBounds(panBounds(next))
      shown = { art: next.art ?? shown.art, overlay: next.overlay?.url, canvas: String(next.canvas) }
    }, LIVE_POLL_MS)
    return () => window.clearInterval(timer)
  }, [dataset, meta])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const apply = () => {
      const f = selectedId ? (['==', ['get', 'id'], selectedId] as maplibregl.FilterSpecification) : (NO_MATCH as unknown as maplibregl.FilterSpecification)
      map.setFilter('buildings-selected', f)
      map.setFilter('buildings-selected-fill', f)
      const s = readUrl()
      writeUrl({ ...s, building: selectedId ?? undefined })
    }
    if (map.isStyleLoaded()) apply()
    else map.once('load', apply)
  }, [selectedId])

  // Switch look in place: same archive, other protocol; the view stays where it is.
  const artName = useRef(meta.art ?? 'art.pmtiles')
  useEffect(() => {
    lookRef.current = look
    const map = mapRef.current
    if (!map) return
    const apply = () => {
      const src = map.getSource<RasterTileSource>('art')
      const name = src?.url?.split('/').pop() ?? artName.current
      const url = artSourceUrl(dataset, name, look)
      if (src && src.url !== url) src.setUrl(url)
      map.setPaintProperty('paper', 'background-color', PAPER[look])
      map.setPaintProperty('art', 'raster-fade-duration', FADE_MS[look])
    }
    if (map.isStyleLoaded()) apply()
    else map.once('load', apply)
  }, [dataset, look])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const apply = () => map.setLayoutProperty('roads-debug', 'visibility', showRoads ? 'visible' : 'none')
    if (map.isStyleLoaded()) apply()
    else map.once('load', apply)
  }, [showRoads])

  return <div ref={container} className="map" role="region" aria-label="Isometric map of HITEC City. Drag to move, scroll or pinch to zoom, click a building for details." />
}
