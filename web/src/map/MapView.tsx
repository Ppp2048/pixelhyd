import { useEffect, useRef } from 'react'
import * as maplibregl from 'maplibre-gl'
import type { GeoJSONSource, MapLayerMouseEvent, MapMouseEvent } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { Protocol } from 'pmtiles'
// Bundle MapLibre's module worker (and the chunk it imports) so it also works in production builds.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import { artToLngLat, imageToReal, nativeZoom, realToImage } from '../lib/projection'
import { readUrl, writeUrl } from '../lib/urlState'
import type { BuildingProps, Dataset, DatasetMeta } from '../types'

// The PMTiles protocol is global to MapLibre: register it once, before any map exists.
let protocolRegistered = false
function ensureProtocol() {
  if (protocolRegistered) return
  maplibregl.setWorkerUrl(workerUrl)
  maplibregl.addProtocol('pmtiles', new Protocol().tile)
  protocolRegistered = true
}

interface Props {
  dataset: Dataset
  meta: DatasetMeta
  showRoads: boolean
  selectedId: string | null
  onSelect: (b: BuildingProps | null) => void
  onCursor: (lonLat: [number, number] | null) => void
}

const NO_MATCH = ['==', ['get', 'id'], '__none__'] as const

export function MapView({ dataset, meta, showRoads, selectedId, onSelect, onCursor }: Props) {
  const container = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const selectRef = useRef(onSelect)
  const cursorRef = useRef(onCursor)
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
    const [west, north] = artToLngLat(p, -p.width * 0.25, -p.height * 0.25)
    const [east, south] = artToLngLat(p, p.width * 1.25, p.height * 1.25)
    const url = readUrl()
    const centre =
      url.lat !== undefined && url.lon !== undefined
        ? realToImage(p, url.lon, url.lat)
        : artToLngLat(p, meta.centre.art_px[0], meta.centre.art_px[1])
    const native = nativeZoom(p)

    const map = new maplibregl.Map({
      container: container.current,
      center: centre,
      zoom: url.zoom ?? native - 0.6,
      minZoom: meta.zoom.min - 1,
      maxZoom: native + 2.5,
      maxBounds: [
        [west, south],
        [east, north],
      ],
      renderWorldCopies: false,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      attributionControl: { compact: false, customAttribution: meta.attribution },
      style: {
        version: 8,
        sources: {
          art: { type: 'raster', url: `pmtiles://${origin}${dataset.base}/art.pmtiles`, tileSize: 256 },
          overlay: { type: 'geojson', data: `${dataset.base}/overlay.geojson` },
        },
        layers: [
          { id: 'paper', type: 'background', paint: { 'background-color': '#efe6d3' } },
          { id: 'art', type: 'raster', source: 'art', paint: { 'raster-resampling': 'nearest', 'raster-fade-duration': 0 } },
          {
            id: 'core', type: 'line', source: 'overlay', filter: ['==', ['get', 'layer'], 'core'],
            paint: { 'line-color': '#7a6a52', 'line-width': 1, 'line-dasharray': [3, 3], 'line-opacity': 0.6 },
          },
          {
            id: 'roads-debug', type: 'line', source: 'overlay', filter: ['==', ['get', 'layer'], 'road_centreline'],
            layout: { visibility: 'none' }, paint: { 'line-color': '#e0249a', 'line-width': 1.5 },
          },
          {
            id: 'buildings-hit', type: 'fill', source: 'overlay', filter: ['==', ['get', 'layer'], 'building'],
            paint: { 'fill-color': '#000', 'fill-opacity': 0 },
          },
          {
            id: 'buildings-hover', type: 'line', source: 'overlay', filter: NO_MATCH as unknown as maplibregl.FilterSpecification,
            paint: { 'line-color': '#ffd166', 'line-width': 2 },
          },
          {
            id: 'buildings-selected-fill', type: 'fill', source: 'overlay', filter: NO_MATCH as unknown as maplibregl.FilterSpecification,
            paint: { 'fill-color': '#ff7a33', 'fill-opacity': 0.18 },
          },
          {
            id: 'buildings-selected', type: 'line', source: 'overlay', filter: NO_MATCH as unknown as maplibregl.FilterSpecification,
            paint: { 'line-color': '#ff6a1f', 'line-width': 2.5 },
          },
          {
            id: 'pois', type: 'circle', source: 'overlay', filter: ['==', ['get', 'layer'], 'poi'],
            paint: { 'circle-radius': 4, 'circle-color': '#2b7a78', 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5 },
          },
        ],
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
    map.once('load', async () => {
      if (!url.building) return
      type Feature = { properties: Record<string, unknown> | null }
      const data = (await (map.getSource('overlay') as GeoJSONSource).getData()) as unknown as { features: Feature[] }
      const f = data.features.find((x: Feature) => x.properties?.layer === 'building' && x.properties?.id === url.building)
      if (f) selectRef.current(f.properties as unknown as BuildingProps)
    })

    return () => {
      window.removeEventListener('popstate', onPop)
      map.remove()
      mapRef.current = null
    }
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

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const apply = () => map.setLayoutProperty('roads-debug', 'visibility', showRoads ? 'visible' : 'none')
    if (map.isStyleLoaded()) apply()
    else map.once('load', apply)
  }, [showRoads])

  return <div ref={container} className="map" role="region" aria-label="Isometric map of HITEC City. Drag to move, scroll or pinch to zoom, click a building for details." />
}
