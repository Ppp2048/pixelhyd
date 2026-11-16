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

export const DATASETS: Dataset[] = [
  { id: 'hitec-city-k4', label: 'Hyderabad · city grid', base: '/tiles/hitec-city-k4' },
  { id: 'prototype-k4', label: 'Prototype · 4 px/m', base: '/tiles/prototype-k4' },
  { id: 'prototype-k2', label: 'Prototype · 2 px/m', base: '/tiles/prototype-k2' },
]
