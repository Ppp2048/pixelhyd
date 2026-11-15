# HITEC City web app

React + TypeScript + MapLibre GL JS viewer for the procedurally generated isometric art.

- `src/lib/projection.ts` — WGS84 ⇄ UTM 44N ⇄ isometric art pixels ⇄ image-space lon/lat (mirrors `pipeline/src/hitec_pipeline/iso.py`, tested against pyproj fixtures).
- `src/map/MapView.tsx` — MapLibre map: raster art from PMTiles (`raster-resampling: nearest`) plus a GeoJSON overlay for hit-testing, highlights and debug layers.
- `src/lib/urlState.ts` — URL holds the real lat/lon, zoom, dataset and selected building.

Data comes from the pipeline (`uv run hitec-pipeline render ...`), which copies `art.pmtiles`, `overlay.geojson` and `meta.json` into `public/tiles/<area>-k<k>/` (not committed).

```bash
npm run dev      # http://localhost:5173
npx vitest run   # unit tests
npm run build
```
