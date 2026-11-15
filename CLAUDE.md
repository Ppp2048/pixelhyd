# HITEC City Isometric Map

## Objective
Build an original, geographically accurate, procedurally generated isometric pixel-art map of HITEC City, Hyderabad (5 km × 5 km square in UTM zone 44N centred on the Cyber Towers junction, 17.4507 °N, 78.3801 °E), displayed in an interactive web application.

The plan is `docs/implementation-plan.md`; the current state is `docs/prototype-report.md`.

## Structure
- `pipeline/` — Python (uv). Steps: `fetch` → `normalise` → `render`. Areas are defined in `pipeline/src/hitec_pipeline/area.py`.
- `web/` — Vite + React + TypeScript + MapLibre GL JS + PMTiles.
- `data/` — raw and generated data; reproducible, never committed.

## Working rules
1. Geographic accuracy first: positions come from real data through exact projections. Never invent geography.
2. Distinguish verified data from estimated attributes (e.g. building heights) in data, code and UI.
3. Artwork, code and assets are our own. Do not copy proprietary map imagery, assets or code from other projects; do not use Google Maps content as a data source.
4. Prefer open datasets (OpenStreetMap, Overture Maps, Google Open Buildings 2.5D, ESA WorldCover, Meta/WRI canopy) and keep attribution and ODbL obligations.
5. Respect the laptop's limits (Intel iGPU, 16 GB RAM, limited disk): bbox-scoped downloads, chunked rendering, no heavyweight desktop 3D tools.
6. Keep chunked rendering seamless — `pipeline/tests/test_seams.py` must pass.
7. Ask before scaling beyond the prototype area, downloading large datasets, or adding substantial dependencies.

## Commands
```bash
cd pipeline && uv run hitec-pipeline fetch|normalise|render --area prototype [--k 4 --chunk 512] && uv run pytest
cd web && npm run dev && npx vitest run && npx tsc -b && npx oxlint src
```
