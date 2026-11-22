import type { ProjectionMeta } from './lib/projection'

export interface DatasetMeta {
  area: string
  k: number
  projection: ProjectionMeta
  centre: { lat: number; lon: number; art_px: [number, number] }
  core_square_utm: [number, number, number, number]
  zoom: { min: number; max: number }
  attribution: string
  metrics: Record<string, unknown>
  /** Present for the tiled map: the interactive overlay as vector tiles. */
  overlay?: { type: 'vector'; url: string; layers: string[]; minzoom: number; maxzoom: number }
  /** Tiled map: file name of the current (versioned) art archive. */
  art?: string
  /** Tiled map: art-pixel box (x0, y0, x1, y1) of the whole city grid; may be negative. */
  canvas?: [number, number, number, number]
  /**
   * Deployed builds only: the archives were cut into chunk files for a host without range requests
   * (pipeline `hitec-pipeline deploy`). Chunk i of archive `a.pmtiles` is `<dir>/a/<i>.bin`.
   */
  chunks?: { dir: string; archives: Record<string, { size: number; chunk: number; count: number; sha256: string }> }
}

export type HeightConfidence = 'verified' | 'derived' | 'modelled' | 'estimated'

export interface BuildingProps {
  layer: 'building'
  id: string
  name: string | null
  use: string | null
  levels: number | null
  height_m: number
  height_source: string
  height_confidence: HeightConfidence
  footprint_source: string
  osm_id: string | null
  area_m2: number
}

export interface Dataset {
  id: string
  label: string
  base: string
}

/**
 * Where the map tiles live: this site's /tiles by default (in a deploy build, cut into chunks); or a storage
 * bucket or CDN, set at build time with VITE_TILES_URL (see docs/deploy.md).
 */
const TILES = (import.meta.env.VITE_TILES_URL || '/tiles').replace(/\/+$/, '')

/** The first entry is the public map; the prototypes are development builds (settings, dev only). */
export const DATASETS: Dataset[] = [
  { id: 'hitec-city-k4', label: 'Hyderabad', base: `${TILES}/hitec-city-k4` },
  ...(import.meta.env.DEV
    ? [
        { id: 'prototype-k4', label: 'Prototype · 4 px/m', base: '/tiles/prototype-k4' },
        { id: 'prototype-k2', label: 'Prototype · 2 px/m', base: '/tiles/prototype-k2' },
      ]
    : []),
]

/** A company at a site, linked to map footprints (web/public/data/corporate.json, built by the pipeline). */
export interface CorporateSite {
  id: string
  /** confirmed: footprint and occupant supported; unverified: named footprint, occupant still to confirm. */
  status: 'confirmed' | 'unverified'
  /** campus: linked through a named campus polygon; building: through a named building. */
  match: 'campus' | 'building'
  match_note: string
  company_name: string | null
  brand_or_entity: string | null
  sector: string | null
  campus_or_property: string | null
  building_name: string | null
  address: string | null
  city_area: string | null
  association_type: string | null
  evidence_level: string | null
  verification_status: string | null
  source_note: string | null
  last_checked: string | null
  sources: string[]
  campus: { osm_id: string; name: string } | null
  buildings: { id: string; osm_id: string; name: string | null; lat: number; lon: number }[]
  /** Where to fly to: the campus or first building (WGS84, ground level). */
  lat: number
  lon: number
}

export interface CorporateData {
  generated_at: string
  dataset: string
  attribution: string
  sites: CorporateSite[]
}
