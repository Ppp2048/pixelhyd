import { useEffect, useRef } from 'react'
import * as maplibregl from 'maplibre-gl'
import type { GeoJSONSource, MapLayerMouseEvent, MapMouseEvent, RasterTileSource, VectorTileSource } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { PMTiles, Protocol } from 'pmtiles'
// Bundle MapLibre's module worker (and the chunk it imports) so it also works in production builds.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import { artToLngLat, imageToReal, lngLatToArt, nativeZoom, realToImage, silhouetteGround } from '../lib/projection'
import { readUrl, writeUrl } from '../lib/urlState'
import { siteTitle, type Corporate } from '../lib/corporate'
import type { Place } from '../lib/places'
import type { LitPlace } from '../lib/homes'
import { DUSK, duskProtocol, setArtGeometry } from './duskLook'
import { ChunkedSource } from './chunkedSource'
import { DATASETS, type BuildingProps, type CorporateSite, type Dataset, type DatasetMeta } from '../types'

// The PMTiles protocol is global to MapLibre: register it once, before any map exists.
let protocol: Protocol | null = null
function ensureProtocol(): Protocol {
  if (protocol) return protocol
  maplibregl.setWorkerUrl(workerUrl)
  protocol = new Protocol()
  maplibregl.addProtocol('pmtiles', protocol.tile)
  maplibregl.addProtocol(DUSK, duskProtocol(protocol)) // same archive, graded and textured in the browser
  return protocol
}

/**
 * Where the archives were cut into chunk files (meta.chunks, for hosts without range requests),
 * read them through ChunkedSource. The protocol finds a reader by the archive's URL, so the map
 * style keeps naming the archive itself.
 */
function registerChunkedArchives(pm: Protocol, dataset: Dataset, meta: DatasetMeta) {
  if (!meta.chunks) return
  for (const [name, info] of Object.entries(meta.chunks.archives)) {
    const url = fileUrl(dataset, name)
    if (pm.get(url)) continue
    const folder = `${meta.chunks.dir}/${name.replace(/\.pmtiles$/, '')}`
    const layout = { size: info.size, chunk: info.chunk, url: (i: number) => fileUrl(dataset, `${folder}/${i}.bin`) }
    pm.add(new PMTiles(new ChunkedSource(url, layout)))
  }
}

export type Look = 'day' | 'dusk'
const PAPER: Record<Look, string> = { day: '#efe6d3', dusk: '#15171c' }
/** Dusk tiles arrive from workers a little later, so they fade in instead of popping. */
const FADE_MS: Record<Look, number> = { day: 0, dusk: 160 }
/** Absolute URL of a file in the dataset's folder (which may be on another host, like a CDN). */
const fileUrl = (dataset: Dataset, name: string) => new URL(`${dataset.base}/${name}`, window.location.href).href
/** The art source URL: the published archive, through the protocol of the chosen look. */
const artSourceUrl = (dataset: Dataset, art: string, look: Look) => `${look === 'dusk' ? DUSK : 'pmtiles'}://${fileUrl(dataset, art)}`

/** The map's credit line (plain text in meta.json), with OpenStreetMap linked to its copyright page. */
const attributionHtml = (text: string) =>
  text
    .replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)
    .replace('OpenStreetMap contributors', '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a>')

/** Map actions for the floating controls and search. */
export interface MapApi {
  zoomIn: () => void
  zoomOut: () => void
  resetView: () => void
  flyToSite: (site: CorporateSite) => void
  flyToPlace: (place: Place) => void
  /** Fit real-world points (WGS84 [lon, lat]) into view beside the card. */
  fitPoints: (points: [number, number][]) => void
  /** Ground point under a building on screen (from its loaded silhouette), or null if it is not loaded. */
  buildingGround: (id: string, height: number) => [number, number] | null
}

/** What is selected on the map: the footprints to outline, and whether they are an unverified site. */
export interface Highlight {
  ids: string[]
  unverified: boolean
}

/** Residential mode on the map: society footprints by verdict ("no" is not drawn) and dots when zoomed out. */
export interface HomesLayer {
  match: string[]
  likely: string[]
  unknown: string[]
  /** Footprints of the society whose card is open. */
  selected: string[]
  /** One per matching or likely society. [lon, lat] in WGS84 */
  dots: { id: string; name: string; lon: number; lat: number; verdict: 'match' | 'likely' }[]
  /** Hover text per society building. */
  names: Map<string, string>
  /** PGs shown and not ruled out: a diamond each, at every zoom. [lon, lat] in WGS84; `tip` is the hover text. */
  pgs: { id: string; name: string; lon: number; lat: number; verdict: 'match' | 'likely' | 'unknown'; tip: string }[]
  /** The PG whose card is open: a ring, and its other listings' points (dotted) where they disagree. */
  openPg: { name: string; lon: number; lat: number; others: { lon: number; lat: number }[] } | null
  /** Compared homes, numbered 1-3 on the map in this order. [lon, lat] in WGS84 */
  compare: { id: string; name: string; lon: number; lat: number }[]
  /** Places lit by the hovered comparison row. */
  lit: LitPlace[]
}

interface Props {
  dataset: Dataset
  meta: DatasetMeta
  look: Look
  showRoads: boolean
  corporate: Corporate | null
  highlight: Highlight
  /** Residential mode; null (the default) leaves the map exactly as it is without it. */
  homes: HomesLayer | null
  onSelectSociety: (id: string) => void
  /** A searched place that is not a building: marked with a pin. [lon, lat] */
  pin: [number, number] | null
  /** Space taken by the details card on the left (px), so flights land beside it. */
  leftInset: number
  /** Space taken along the bottom (px), by the comparison strip. */
  bottomInset: number
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

/**
 * Residential colours: the card's confirmed (green) and unverified (amber) tokens, per look, and a cool
 * blue for lit places, apart from the verdict greens and the companies' orange.
 */
const HOME_COLOURS: Record<Look, { fit: string; unsure: string; open: string; dotEdge: string; lit: string }> = {
  dusk: { fit: '#74cf9f', unsure: '#e8c27a', open: '#eafff3', dotEdge: '#15171c', lit: '#8fd0ff' },
  day: { fit: '#2f7d4f', unsure: '#9a6a00', open: '#173f28', dotEdge: '#fbf7ee', lit: '#2d6a9a' },
}
const HOME_LINES = ['homes-match-fill', 'homes-match-line', 'homes-likely-line', 'homes-unknown-casing', 'homes-unknown-line', 'homes-open']
const HOME_DOTS = ['homes-dot-halo', 'homes-dot', 'homes-pg-ring', 'homes-pg-alt', 'homes-pg', 'homes-lit-halo', 'homes-lit']
const HOME_SOURCES = ['homes', 'homes-pg', 'homes-pg-open', 'homes-lit']
const PG_IMAGES = ['pg-match', 'pg-likely', 'pg-unknown', 'pg-alt', 'pg-ring']

/** Device pixels per CSS pixel in the PG diamonds, and their canvas side in CSS pixels. */
const PG_PX = 2
const PG_BOX = 32

/**
 * PG diamonds (the style has no sprite, so they are drawn here), coloured like the society dots: filled =
 * match, ring = likely, dashed amber = unknown; a dotted outline for another listing of the open PG, and a
 * soft ring around the open one.
 */
function pgImages(look: Look): Record<string, ImageData> {
  const c = HOME_COLOURS[look]
  const draw = (paint: (g: CanvasRenderingContext2D) => void) => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = PG_BOX * PG_PX
    const g = canvas.getContext('2d')!
    g.scale(PG_PX, PG_PX)
    g.translate(PG_BOX / 2, PG_BOX / 2)
    paint(g)
    return g.getImageData(0, 0, canvas.width, canvas.height)
  }
  const diamond = (g: CanvasRenderingContext2D, r: number) => {
    g.beginPath()
    g.moveTo(0, -r)
    g.lineTo(r, 0)
    g.lineTo(0, r)
    g.lineTo(-r, 0)
    g.closePath()
  }
  const edge = (g: CanvasRenderingContext2D, r: number) => {
    diamond(g, r + 2.2)
    g.fillStyle = c.dotEdge
    g.globalAlpha = look === 'dusk' ? 0.8 : 0.9
    g.fill()
    g.globalAlpha = 1
  }
  return {
    'pg-match': draw((g) => {
      edge(g, 6.4)
      diamond(g, 6.4)
      g.fillStyle = c.fit
      g.fill()
    }),
    'pg-likely': draw((g) => {
      edge(g, 6.4)
      diamond(g, 5.4)
      g.fillStyle = c.dotEdge
      g.fill()
      g.lineWidth = 2
      g.strokeStyle = c.fit
      g.stroke()
    }),
    'pg-unknown': draw((g) => {
      edge(g, 7.4)
      diamond(g, 6.6)
      g.lineWidth = 2
      g.setLineDash([2.4, 1.8])
      g.strokeStyle = c.unsure
      g.stroke()
    }),
    'pg-alt': draw((g) => {
      diamond(g, 5)
      g.lineWidth = 3
      g.strokeStyle = c.dotEdge
      g.globalAlpha = 0.45
      g.stroke()
      g.globalAlpha = 1
      g.lineWidth = 1.6
      g.setLineDash([1.2, 1.6])
      g.strokeStyle = c.unsure
      g.stroke()
    }),
    'pg-ring': draw((g) => {
      diamond(g, 12.5)
      g.lineWidth = 3.5
      g.strokeStyle = c.fit
      g.globalAlpha = 0.5
      g.stroke()
      g.globalAlpha = 1
      diamond(g, 10.2)
      g.lineWidth = 1.5
      g.strokeStyle = c.open
      g.stroke()
    }),
  }
}

/** Residential layers, added only while the mode is on: filled = match, outline = likely, dashed = unknown. */
function homeLayers(meta: DatasetMeta, look: Look): maplibregl.LayerSpecification[] {
  const c = HOME_COLOURS[look]
  const building = (meta.overlay?.type === 'vector'
    ? { source: 'overlay', 'source-layer': 'building' }
    : { source: 'overlay', filter: ['==', ['get', 'layer'], 'building'] }) as Record<string, unknown>
  const width: maplibregl.ExpressionSpecification = ['interpolate', ['linear'], ['zoom'], 14, 1.2, 20, 2.2]
  const fade = (from: number): maplibregl.ExpressionSpecification => ['interpolate', ['linear'], ['zoom'], DOT_FADE[0], from, DOT_FADE[1], 0]
  const pgSize: maplibregl.ExpressionSpecification = ['interpolate', ['linear'], ['zoom'], 11, 0.8, 16, 1.1]
  return [
    { id: 'homes-match-fill', type: 'fill', ...building, filter: NONE, paint: { 'fill-color': c.fit, 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 14, 0.3, 18, 0.16] } },
    { id: 'homes-match-line', type: 'line', ...building, filter: NONE, paint: { 'line-color': c.fit, 'line-width': width } },
    { id: 'homes-likely-line', type: 'line', ...building, filter: NONE, paint: { 'line-color': c.fit, 'line-opacity': 0.9, 'line-width': width } },
    // Dashes over the light day art get a soft pale casing, so they read apart from the buildings' own edges.
    {
      id: 'homes-unknown-casing', type: 'line', ...building, filter: NONE,
      paint: { 'line-color': c.dotEdge, 'line-width': 4, 'line-opacity': look === 'day' ? 0.6 : 0 },
    },
    { id: 'homes-unknown-line', type: 'line', ...building, filter: NONE, paint: { 'line-color': c.unsure, 'line-width': look === 'day' ? 2 : 1.6, 'line-dasharray': [2, 1.5] } },
    { id: 'homes-open', type: 'line', ...building, filter: NONE, paint: { 'line-color': c.open, 'line-width': ['interpolate', ['linear'], ['zoom'], 14, 2, 20, 3] } },
    {
      id: 'homes-dot-halo', type: 'circle', source: 'homes', maxzoom: DOT_FADE[1],
      paint: { 'circle-color': c.fit, 'circle-opacity': fade(0.22), 'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 6, 14, 11], 'circle-blur': 0.6 },
    },
    {
      // Match: a filled dot; likely: a ring, as on the footprints.
      id: 'homes-dot', type: 'circle', source: 'homes', maxzoom: DOT_FADE[1],
      paint: {
        'circle-color': ['case', ['==', ['get', 'verdict'], 'match'], c.fit, c.dotEdge],
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 3.5, 14, 5.5],
        'circle-stroke-color': ['case', ['==', ['get', 'verdict'], 'match'], c.dotEdge, c.fit],
        'circle-stroke-width': 2,
        'circle-opacity': fade(1),
        'circle-stroke-opacity': fade(1),
      },
    },
    // PGs: diamonds at every zoom (they have no footprints), the best fits drawn on top.
    {
      id: 'homes-pg-ring', type: 'symbol', source: 'homes-pg-open', filter: ['==', ['get', 'role'], 'open'],
      layout: { 'icon-image': 'pg-ring', 'icon-allow-overlap': true, 'icon-ignore-placement': true, 'icon-size': pgSize },
    },
    {
      id: 'homes-pg-alt', type: 'symbol', source: 'homes-pg-open', filter: ['==', ['get', 'role'], 'other'],
      layout: { 'icon-image': 'pg-alt', 'icon-allow-overlap': true, 'icon-ignore-placement': true, 'icon-size': pgSize },
    },
    {
      id: 'homes-pg', type: 'symbol', source: 'homes-pg',
      layout: {
        'icon-image': ['concat', 'pg-', ['get', 'verdict']],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'icon-size': pgSize,
        'symbol-sort-key': ['match', ['get', 'verdict'], 'match', 3, 'likely', 2, 1],
      },
    },
    // Places behind a hovered comparison row, at every zoom.
    { id: 'homes-lit-halo', type: 'circle', source: 'homes-lit', paint: { 'circle-color': c.lit, 'circle-opacity': 0.3, 'circle-radius': 11, 'circle-blur': 0.6 } },
    {
      id: 'homes-lit', type: 'circle', source: 'homes-lit',
      paint: { 'circle-color': c.lit, 'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 3.5, 18, 5.5], 'circle-stroke-color': c.dotEdge, 'circle-stroke-width': 1.5 },
    },
  ] as maplibregl.LayerSpecification[]
}

const both = (xs: number[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : String(xs[0]))
const homeLit = (meta: DatasetMeta, lit: LitPlace[]): maplibregl.GeoJSONSourceSpecification['data'] => ({
  type: 'FeatureCollection',
  features: lit.map((l) => ({
    type: 'Feature',
    properties: { tip: `${l.name ?? 'Unnamed place'} · near ${both(l.near)}` },
    geometry: { type: 'Point', coordinates: realToImage(meta.projection, l.lon, l.lat) },
  })),
})

const homePgs = (meta: DatasetMeta, homes: HomesLayer): maplibregl.GeoJSONSourceSpecification['data'] => ({
  type: 'FeatureCollection',
  features: homes.pgs.map((d) => ({
    type: 'Feature',
    properties: { id: d.id, verdict: d.verdict, tip: d.tip },
    geometry: { type: 'Point', coordinates: realToImage(meta.projection, d.lon, d.lat) },
  })),
})

const homeOpenPg = (meta: DatasetMeta, homes: HomesLayer): maplibregl.GeoJSONSourceSpecification['data'] => {
  const o = homes.openPg
  if (!o) return EMPTY
  const at = (role: string, lon: number, lat: number, tip: string) => ({
    type: 'Feature' as const,
    properties: { role, tip },
    geometry: { type: 'Point' as const, coordinates: realToImage(meta.projection, lon, lat) },
  })
  return {
    type: 'FeatureCollection',
    features: [at('open', o.lon, o.lat, o.name), ...o.others.map((x) => at('other', x.lon, x.lat, `Another listing of ${o.name}`))],
  }
}

const homeDots = (meta: DatasetMeta, homes: HomesLayer): maplibregl.GeoJSONSourceSpecification['data'] => ({
  type: 'FeatureCollection',
  features: homes.dots.map((d) => ({
    type: 'Feature',
    properties: { id: d.id, name: d.name, verdict: d.verdict },
    geometry: { type: 'Point', coordinates: realToImage(meta.projection, d.lon, d.lat) },
  })),
})

/** Show the map tooltip with `text` at `point`, or hide it. */
function showTip(el: HTMLDivElement | null, text: string | null, point?: maplibregl.Point) {
  if (!el) return
  el.hidden = !text
  if (text && point) {
    el.textContent = text
    el.style.transform = `translate(${Math.round(point.x)}px, ${Math.round(point.y)}px)`
  }
}

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
    registerChunkedArchives(ensureProtocol(), dataset, meta)
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
      attributionControl: { compact: window.innerWidth < 720, customAttribution: attributionHtml(meta.attribution) },
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
    const tip = (text: string | null, point?: maplibregl.Point) => showTip(tooltip.current, text, point)
    map.on('mousemove', 'buildings-hit', (e: MapLayerMouseEvent) => {
      const f = e.features?.[0]
      if (!f) return
      const id = String(f.properties.id)
      const sites = live.current.corporate?.byBuilding.get(id)
      const home = live.current.homes?.names.get(id)
      map.getCanvas().style.cursor = 'pointer'
      map.setFilter('buildings-hover', sites ? NONE : idsFilter([id]))
      map.setFilter('corp-hover', sites ? idsFilter([id]) : NONE)
      tip(home ?? (sites ? sites.map((s) => siteTitle(s) + (s.status === 'unverified' ? ' (unverified)' : '')).join(' · ') : null), e.point)
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
    // Residential dots (their layer exists only while the mode is on; MapLibre skips a missing layer).
    map.on('mousemove', 'homes-dot', (e: MapLayerMouseEvent) => {
      map.getCanvas().style.cursor = 'pointer'
      tip(String(e.features?.[0]?.properties.name ?? ''), e.point)
    })
    map.on('mouseleave', 'homes-dot', () => {
      map.getCanvas().style.cursor = ''
      tip(null)
    })
    map.on('mousemove', 'homes-lit', (e: MapLayerMouseEvent) => tip(String(e.features?.[0]?.properties.tip ?? ''), e.point))
    map.on('mouseleave', 'homes-lit', () => tip(null))
    for (const layer of ['homes-pg', 'homes-pg-alt']) {
      map.on('mousemove', layer, (e: MapLayerMouseEvent) => {
        if (layer === 'homes-pg') map.getCanvas().style.cursor = 'pointer'
        tip(String(e.features?.[0]?.properties.tip ?? ''), e.point)
      })
      map.on('mouseleave', layer, () => {
        map.getCanvas().style.cursor = ''
        tip(null)
      })
    }
    map.on('click', (e: MapMouseEvent) => {
      if (map.getLayer('homes-pg')) {
        const pg = map.queryRenderedFeatures(e.point, { layers: ['homes-pg'] })[0]
        if (pg) {
          live.current.onSelectSociety(String(pg.properties.id))
          return
        }
      }
      if (map.getLayer('homes-dot') && map.getZoom() < DOT_FADE[1]) {
        const dot = map.queryRenderedFeatures(e.point, { layers: ['homes-dot'] })[0]
        if (dot) {
          live.current.onSelectSociety(String(dot.properties.id))
          return
        }
      }
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
        ? // Residential mode's panel fills the bottom sheet (up to 58 % of the screen); other cards are shorter.
          { top: 150, bottom: Math.round(window.innerHeight * (live.current.homes ? 0.6 : 0.45)), left: 30, right: 30 }
        : // Points are at ground level and buildings rise above them: leave more room at the top.
          { top: tall ? 260 : 140, bottom: Math.max(90, live.current.bottomInset + 80), left: live.current.leftInset + 80, right: 120 }
    /** Fly to fit real-world points, close enough to read a building. */
    const fitReal = (real: number[][]) => {
      const pts = real.map(([lon, lat]) => realToImage(p, lon, lat))
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
    }
    live.current.onReady({
      zoomIn: () => map.zoomIn(ease),
      zoomOut: () => map.zoomOut(ease),
      resetView: () => map.fitBounds(boundsOf(meta), { padding: cityPadding(), duration: 1200 }),
      flyToSite: (site) => fitReal([...site.buildings.map((b) => [b.lon, b.lat]), [site.lon, site.lat]]),
      fitPoints: (points) => {
        if (points.length) fitReal(points)
      },
      buildingGround: (id, height) => {
        // Every loaded piece of the silhouette (vector tiles cut features at tile edges).
        const filter = (vector ? ['==', ['get', 'id'], id] : ['all', ['==', ['get', 'layer'], 'building'], ['==', ['get', 'id'], id]]) as maplibregl.FilterSpecification
        const parts = map.querySourceFeatures('overlay', vector ? { sourceLayer: 'building', filter } : { filter })
        const box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity]
        for (const f of parts) {
          const g = f.geometry
          const coords = g.type === 'Polygon' ? g.coordinates.flat() : g.type === 'MultiPolygon' ? g.coordinates.flat(2) : []
          for (const [lon, lat] of coords) {
            const [x, y] = lngLatToArt(p, lon, lat)
            box[0] = Math.min(box[0], x)
            box[1] = Math.min(box[1], y)
            box[2] = Math.max(box[2], x)
            box[3] = Math.max(box[3], y)
          }
        }
        return Number.isFinite(box[0]) ? silhouetteGround(p, box, height) : null
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

  // Residential mode: its layers exist only while it is on, so without it the style is exactly as before.
  const homes = props.homes
  const homesKey = homes
    ? [
        homes.match,
        homes.likely,
        homes.unknown,
        homes.selected,
        homes.dots.map((d) => `${d.id}:${d.verdict}`),
        homes.pgs.map((d) => `${d.id}:${d.verdict}`),
        homes.openPg ? [homes.openPg.name, homes.openPg.lon, homes.openPg.lat] : [],
      ]
        .map((x) => x.join(','))
        .join('|')
    : ''
  const homesLook = useRef<Look | null>(null)
  useEffect(() => {
    whenReady(mapRef.current, (map) => {
      if (map.getSource('homes') && (!homes || homesLook.current !== look)) {
        for (const id of [...HOME_DOTS, ...HOME_LINES]) if (map.getLayer(id)) map.removeLayer(id)
        for (const id of HOME_SOURCES) if (map.getSource(id)) map.removeSource(id)
        for (const id of PG_IMAGES) if (map.hasImage(id)) map.removeImage(id)
      }
      if (!homes) return
      if (!map.getSource('homes')) {
        for (const id of HOME_SOURCES) map.addSource(id, { type: 'geojson', data: EMPTY })
        for (const [id, image] of Object.entries(pgImages(look))) map.addImage(id, image, { pixelRatio: PG_PX })
        // Footprints under the hover and selection outlines; dots under the search pin.
        for (const l of homeLayers(meta, look)) map.addLayer(l, HOME_DOTS.includes(l.id) ? 'pin-halo' : 'buildings-hover')
        homesLook.current = look
      }
      map.getSource<GeoJSONSource>('homes')?.setData(homeDots(meta, homes))
      map.getSource<GeoJSONSource>('homes-pg')?.setData(homePgs(meta, homes))
      map.getSource<GeoJSONSource>('homes-pg-open')?.setData(homeOpenPg(meta, homes))
      map.setFilter('homes-match-fill', idsFilter(homes.match))
      map.setFilter('homes-match-line', idsFilter(homes.match))
      map.setFilter('homes-likely-line', idsFilter(homes.likely))
      map.setFilter('homes-unknown-casing', idsFilter(homes.unknown))
      map.setFilter('homes-unknown-line', idsFilter(homes.unknown))
      map.setFilter('homes-open', idsFilter(homes.selected))
    })
    // The key captures the layer contents; the names only feed the hover tip (read live).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [homesKey, look, meta])

  // Places lit by a comparison row (after the effect above, which may have just re-created their source).
  const lit = homes?.lit
  const litKey = lit?.map((l) => `${l.id}:${l.near.join('')}`).join(',') ?? ''
  useEffect(() => {
    whenReady(mapRef.current, (map) => map.getSource<GeoJSONSource>('homes-lit')?.setData(homeLit(meta, lit ?? [])))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [litKey, homesKey, look, meta])

  // Compared homes: numbered markers (HTML, since the style has no font for map text).
  const compare = homes?.compare
  const compareKey = compare?.map((c) => c.id).join(',') ?? ''
  useEffect(() => {
    const map = mapRef.current
    if (!map || !compare?.length) return
    const markers = compare.map((c, i) => {
      const el = document.createElement('button')
      el.className = 'cmp-marker'
      el.textContent = String(i + 1)
      el.title = c.name
      el.setAttribute('aria-label', `${i + 1}: ${c.name}`)
      el.addEventListener('click', (e) => {
        e.stopPropagation()
        live.current.onSelectSociety(c.id)
      })
      // Lifted by the pointer drawn under the box (.cmp-marker::after), so its tip is on the point.
      return new maplibregl.Marker({ element: el, anchor: 'bottom', offset: [0, -6] }).setLngLat(realToImage(meta.projection, c.lon, c.lat)).addTo(map)
    })
    return () => markers.forEach((m) => m.remove())
    // The key captures the ids and their order; names are fixed per id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compareKey, meta])

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
