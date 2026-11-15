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
  { id: 'prototype-k4', label: 'Prototype · 4 px/m', base: '/tiles/prototype-k4' },
  { id: 'prototype-k2', label: 'Prototype · 2 px/m', base: '/tiles/prototype-k2' },
]
