# HITEC City web app

React + TypeScript + MapLibre GL JS viewer for the procedurally generated isometric art.

- `src/lib/projection.ts` — WGS84 ⇄ UTM 44N ⇄ isometric art pixels ⇄ image-space lon/lat (mirrors `pipeline/src/hitec_pipeline/iso.py`, tested against pyproj fixtures).
- `src/map/MapView.tsx` — MapLibre map: raster art from PMTiles (`raster-resampling: nearest`) plus a GeoJSON overlay for hit-testing, highlights and debug layers.
- `src/lib/urlState.ts` — URL holds the real lat/lon, zoom, dataset and selected building.

Data comes from the pipeline and is not committed (see [docs/data-assets.md](../docs/data-assets.md)):

- `public/tiles/hitec-city-k4/`: the city map (`art.<version>.pmtiles`, `overlay.<version>.pmtiles`, `meta.json`), from `hitec-pipeline tiles publish`.
- `public/tiles/prototype-k<k>/`: a prototype area (`art.pmtiles`, `overlay.geojson`, `meta.json`), from `hitec-pipeline render --area prototype`; shown in development builds only.
- `public/data/`: search, company and home-search files, from `hitec-pipeline places`, `corporate` and `residential`.

```bash
npm run dev      # http://localhost:5173
npx vitest run   # unit tests
npm run lint     # oxlint
npm run build    # type check + production build
```

Deploying is described in [docs/deploy.md](../docs/deploy.md).
