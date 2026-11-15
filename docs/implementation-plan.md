# HITEC City Isometric Map — Audit, Architecture and Prototype Plan

**Status:** approved plan (2026-11-15). The 250 m prototype (Phase 1) is complete — see [prototype-report.md](prototype-report.md).
**Scope (fixed):** HITEC City, Hyderabad · 5 km × 5 km (25 km²) · real geography · original procedural isometric pixel-inspired artwork · interactive web app · no Blender or other desktop 3D tool.

Evidence tags: **[V]** verified now on this machine or by query · **[E]** estimate · **[U]** uncertain, must be tested.

---

## 1. Audit

### 1.1 Starting point
No code, prototypes or Hyderabad data existed when this plan was written; all work below starts from scratch. [V]

### 1.2 Machine [V]
| Resource | Value | Consequence |
|---|---|---|
| CPU | Intel i7-1255U (10 cores, 12 threads) | Fine for chunked CPU rendering; parallelise chunks with `multiprocessing` |
| GPU | Intel Iris Xe, no CUDA | Rules out local AI image models; irrelevant for the procedural route |
| RAM | 16 GB | Render in chunks; target < 2 GB peak |
| Disk | **16 GB free of 280 GB (95 % full)** | Hard budget: whole project ≤ 3 GB including environments |
| Docker | Installed, daemon not running | Not needed by this plan |

### 1.3 Environments [V]
| | Installed | Missing / notes |
|---|---|---|
| Python 3.14.2 (global) | numpy 2.4.2, Pillow 12.1.1, pandas 3.0.1 | geopandas, shapely, pyogrio, pyproj, pyarrow, rasterio, duckdb **not installed**. PyPI has Windows wheels usable on 3.14 for all of them (pyogrio and duckdb via `abi3` wheels) → no conda/GDAL install needed |
| uv 0.11.23 | ✅ | Use for an isolated project venv (don't touch the global Python) |
| Node 24.16 / npm 11.13 | Global: Claude Code, `@playwright/cli` 0.1.24 (+ its Chromium) | No project packages yet |
| CLI geo tools | — | tippecanoe, pmtiles, ogr2ogr, osmium, vips, ImageMagick, Blender: **none installed, none required** |

### 1.4 Installed skills — relevance
| Skill | Verdict | Use / reject |
|---|---|---|
| **isometric-ops** | **High** | Use: projection constants (2:1 dimetric 26.565°), depth-sort doctrine (painter's order, AABB/topological fallback), style guide (one light direction, 3-tone faces), `iso-math.py` (stdlib, to verify constants), `tile-validate.py`/`sheet-pack.py` for sprite sheets. Reject: Blender, three.js, ControlNet/AI routes. |
| **maplibre-tile-sources** | **High** | GeoJSON vs vector tiles thresholds (< 5k features GeoJSON; > 100k vector tiles); raster + vector source combination |
| **maplibre-pmtiles-patterns** | **High** | Single-file static hosting, `pmtiles` protocol, `url:` (not `tiles:`) for correct overzoom, CORS + `Range` headers. Its Go CLI is optional, not required |
| **maplibre-cartography** | Medium | Label halo/contrast on busy imagery, layer ordering, accessibility notes |
| **playwright-cli** | **High** | Browser checks, screenshots, performance sampling |
| city3d (plugin) | Low | Photogrammetry/Blender oriented — reject. Reusable ideas: its data-source legality rules and stdlib OSM fetch approach |
| google-maps-platform | None | Google Maps content can't be used as a data source (licence terms) |

---

## 2. Area definition

Default extent: a **5 000 m × 5 000 m square in UTM zone 44N (EPSG:32644)** centred on the Cyber Towers junction (OSM: 17.4507 °N, 78.3801 °E [V]).
- Approx. lat/lon box: 17.4281–17.4733 °N, 78.3566–78.4036 °E.
- Covers HITEC City, Madhapur, Mindspace, Cyber Gateway, HITEC City MMTS station (17.4698 °N), the Durgam Cheruvu lake area and parts of Kondapur. **Excludes most of Gachibowli and the Financial District** (decision D1).
- Defining the square in metres (not degrees) makes it exactly 5 km on the ground and keeps all maths in one CRS.

### OSM content in this square [V, Overpass, 2026-11-15]
| Feature | Count | Note |
|---|---|---|
| Buildings | 15,498 | |
| …with `height` | **7** | |
| …with `building:levels` | **180 (1.2 %)** | Heights must come from elsewhere |
| Named buildings | 421 | |
| Highway ways / named | 5,219 / 724 | |
| Footways/paths | 236 | Sidewalks mostly unmapped |
| Food & drink places | 346 | Restaurants, cafés, fast food, bars, pubs |
| `office=*` features | 245 | Company data is thin |
| Parks/gardens · water · malls | 80 · 34 · 10 | |

---

## 3. Recommended end-to-end architecture

```
           ┌────────────── pipeline/ (Python, uv venv, CPU) ───────────────┐
 OSM (Overpass, bbox) ─┐                                                   │
 Overture buildings ───┼─► fetch ─► normalise+validate ─► features.gpkg ──┐│
 (Open Buildings 2.5D)─┘   (raw/,   (UTM 44N, dedupe,     (one table per   ││
                            manifest) heights+sources)     layer)          ││
                                                                           ▼│
                     isometric projection (exact affine) ─► chunked renderer│
                     (Pillow, NumPy, deterministic seeds)   (art tiles)     │
                                                                           ││
             art.pmtiles (raster, WebP)    overlay.pmtiles / .geojson      ││
             (pyramid built bottom-up)     (footprints, roads, POIs in      ││
                                            the same image space)           ││
           └──────────────────────────────┬────────────────────────────────┘│
                                          ▼
           web/ (Vite + React + TypeScript + MapLibre GL JS + pmtiles)
           raster art layer · vector hit/label layers · search · filters · inspector
                                          ▼
                      static hosting (any host with HTTP Range + CORS)
```

### Key choices

| Choice | Why needed | Alternatives | Why this one | Perf / complexity impact |
|---|---|---|---|---|
| **Procedural raster artwork** (pre-rendered tiles) | The look is pixel art with walls, windows, shadows — per-pixel control | Live vector 3D (MapLibre `fill-extrusion`); Three.js scene; SVG | Only pre-rendered raster gives true pixel-art control and constant browser cost regardless of detail | Rendering cost moves offline; browser only decodes images |
| **MapLibre GL JS in "image space"** | Smooth zoom/pan, GPU vector overlays, hover/click queries, PMTiles, collision-aware labels | OpenSeadragon; Leaflet `CRS.Simple`; custom canvas | MapLibre only supports Web Mercator, so isometric art can't be a normal geographic layer. We map isometric pixel coordinates linearly into a tiny lon/lat box at the equator (distortion < 10⁻⁶ [E]) and use `raster-resampling: nearest`. This gives vector interactivity that OpenSeadragon lacks. **[U] must be proven in the prototype**; fallback is Leaflet `CRS.Simple` | ~230 KB gz library; one GPU canvas |
| **2:1 dimetric projection from UTM metres** | Geographic accuracy + pixel-stepped edges | True 30° isometric; oblique; perspective | 2:1 gives integer pixel steps (isometric-ops doctrine); the affine from UTM is exact and invertible | Pure arithmetic |
| **Overture buildings as the single footprint source** | Avoid double-counted buildings | Merge OSM + Overture + ML ourselves | Overture already conflates OSM → Esri → Google/Microsoft ML with per-feature sources; OSM tags are joined by the OSM IDs kept in Overture's `sources` | No custom conflation code |
| **PMTiles** for art and overlay | Static hosting, no tile server | Folder of `z/x/y` files; tile server | One file, range requests; written from Python (`pmtiles` package), no Go/Docker | ~0 server cost |
| **React + TypeScript (Vite)** | Filter panels, inspector, search, URL state | Vanilla TS | The scope includes stateful UI (filters, details, lists); React keeps that maintainable | +~45 KB gz |
| **No Three.js** | — | Three.js orthographic 3D | No requirement needs real-time 3D; it would cost GPU/battery and reproduce what the raster already shows | — |

---

## 4. Geographic data strategy

### 4.1 Sources
| Layer | Source | Access (bbox only) | Licence |
|---|---|---|---|
| Building footprints | **Overture buildings** (latest release) | `overturemaps download --bbox … -f geoparquet --type building` (pure-Python CLI; reads only needed row groups) | ODbL |
| Building tags (name, levels, height, use) | OSM via Overpass | one JSON query per layer, cached in `data/raw/` | ODbL |
| Heights (where tags missing) | **Google Open Buildings 2.5D Temporal, 2023** | Earth Engine export or GCS download by S2 cell [U: tile size unknown] | CC BY 4.0 / ODbL |
| Roads, rail, metro, water, parks, land use | OSM via Overpass | bbox query | ODbL |
| Places to eat / hang out | OSM + **Overture Places** | same CLI, `--type place` | ODbL / CDLA-P 2.0 / Apache-2.0 per source |
| Offices / startups | OSM `office=*` + a hand-curated, cited list | CSV in repo | ours (facts only) |
| Terrain | Not in MVP (decision D6) | — | — |

Every download writes a manifest entry: URL, query, timestamp, Overture release, OSM base timestamp, licence, file hash. Re-running with the same snapshot reproduces the same output; changing the bbox or snapshot updates the area.

### 4.2 Coordinate pipeline
`EPSG:4326 → EPSG:32644 (pyproj, metres) → isometric pixels (affine) → image-space lon/lat (linear, for MapLibre)`.
- All geometry work (buffers, areas, simplification, shadows) happens in **metres**.
- The isometric affine (k = pixels per metre along the screen x-axis):
  `x = k·(E − N) + cx`, `y = −(k/2)·(E + N) + cy − v·z` with vertical scale `v = k·√6/2 ≈ 1.2247k` px per metre of height (exact 2:1 dimetric; to be confirmed with isometric-ops `iso-math.py`).
- Round-trip tests: lat/lon → px → lat/lon error < 1 cm.

### 4.3 Building heights — never invented silently
Each building gets `height_m`, `height_source` and `height_confidence`:

| Priority | Source | Confidence |
|---|---|---|
| 1 | OSM `height` / Overture `height` from a surveyed source | verified |
| 2 | OSM/Overture `building:levels` × 3.3 m + roof allowance | derived |
| 3 | Open Buildings 2.5D 2023, median of 4 m pixels inside the footprint (≥ 3 pixels required) | modelled |
| 4 | Class default (e.g. house 7 m, office 25 m) with seeded ±variation | **estimated** |

Plausibility clamps (2–180 m) and outlier flags (a height > 4× its neighbours' median). The app shows the source in the building inspector and offers a "data honesty" overlay that tints estimated heights.

### 4.4 Validation and deduplication
- `make_valid`, drop slivers < 8 m², drop exact duplicates by geometry hash; flag pairs overlapping > 50 % (ML duplicates) and keep the higher-priority source.
- Simplify footprints with a 0.25 m tolerance (below one art pixel at k ≤ 4).
- Roads: merge by `(name, class)`, compute widths from `lanes`/`width` tags or a class table (flagged `estimated`), buffer in metres and **union per class**, so junctions are seamless.
- Bridges, flyovers and the elevated metro (HITEC City station is on an elevated line): use the OSM `bridge`/`layer` tags to draw them elevated with a cast shadow.
- Report: counts per source and confidence, invalid geometries fixed, duplicates removed, all written to `data/out/report.json`.

### 4.5 Boundary continuity
Fetch with a **150 m buffer** beyond the 5 km square, process everything, clip only at render time. Buildings crossing the edge are kept whole (no cut-in-half towers); shadows and tall buildings that spill across the edge are rendered from the buffer.

---

## 5. Procedural artwork strategy

Original rules, own palette, own light direction — not derived from any existing map imagery.

| Element | Technique |
|---|---|
| Ground and land use | Polygon fills per class (built-up, park, water, bare rock — HITEC City has granite outcrops) with seeded noise/dither patterns |
| Roads | Union-buffered polygons per class, darker casing, lane/centre markings sampled along centrelines, junction fills from the union |
| Shadows | Sun at a fixed azimuth/elevation (our choice, e.g. light from the **upper right**). Shadow = hull(footprint ∪ footprint translated by `h·cot(elevation)`), drawn on the ground layer with multiply blending, before buildings |
| Buildings | Extruded prisms: visible wall faces chosen by edge normal vs camera; three-tone shading (roof light, one side mid, other side dark); windows from a **wall-space texture** (NumPy pattern per floor height and building class) affine-mapped onto each face with nearest-neighbour; roof details (parapet line, water tanks, AC units) seeded by building ID |
| Depth order | Painter's algorithm keyed on each building's nearest ground point; topological sort only for screen-overlapping pairs where the scalar key fails (isometric-ops §9) |
| Trees | OSM trees/tree rows + seeded scatter inside parks and green land use (sprites drawn by us, packed with `sheet-pack.py`); Meta/WRI canopy later |
| Variation | Every random choice uses `hash(feature_id)` as its seed → identical across chunks and re-runs; variation never changes position or size |
| Palette | 32–48 own colours with fixed ramps; final tiles quantised to the palette without dithering → crisp pixels and small files |
| Labels | **Not baked into the art.** Names are vector/HTML labels in the app, so they stay sharp and switchable |

Rendering library: **Pillow `ImageDraw`** (aliased polygon fills are exactly what pixel art needs) + NumPy for textures and masks. SVG rendering is rejected: it needs an extra rasteriser (cairo/resvg) and anti-aliases edges, which works against the pixel look.

---

## 6. Application rendering strategy

| Layer (bottom → top) | Source type | Purpose |
|---|---|---|
| Art | `raster` from `art.pmtiles`, `raster-resampling: nearest`, `raster-fade-duration: 0` | The city |
| Hit areas | `vector` (or GeoJSON in the prototype) — building silhouettes (footprint + roof + walls) in image space | Hover highlight (`feature-state`), click → inspector |
| Highlights | same source, filtered | "Show offices / food / hangouts" outlines and glows |
| POIs | GeoJSON (≈ 1–3 k points) | Filterable markers with clustering |
| Labels | English: MapLibre symbol layer. **Telugu: HTML overlays** — MapLibre's text renderer lacks complex-script shaping for Indic scripts [U, to verify] | Names |

Interaction: search (places, streets, POIs, lat/lon) → convert to image space → fly; filters; building inspector (name, use, levels, height + source); URL state with real lat/lon, written only after camera moves settle and parsed on `popstate`/`hashchange`, so shared links always match the view.

Feature counts decide the overlay format: prototype (~300 buildings) → GeoJSON; full area (15–30 k buildings) → vector tiles. Generating them needs either `tippecanoe` (no Windows build; Docker) or the pure-Python `mapbox-vector-tile` package → decision at Phase 3 (D9).

---

## 7. Performance and resource strategy

### 7.1 Size estimates for the full 25 km² [E]
| k (px/m) | Max-zoom canvas | Content tiles (256 px, half the canvas is empty diamond corners) | Pyramid total | Disk (WebP, palette art) |
|---|---|---|---|---|
| 2 | 20,000 × ~10,400 | ~1,600 | ~2,100 | **≈ 40–80 MB** |
| 4 | 40,000 × ~20,700 | ~6,400 | ~8,500 | **≈ 150–300 MB** |

Both settings fit easily in the disk budget.

### 7.2 Processing
- **Chunks:** render 2048 × 2048 px blocks aligned to the tile grid. Each chunk pulls features whose projected bounds (including height and shadow) intersect it plus a margin (`max_height·v + max_shadow` px), via a Shapely STRtree. Because draw order and randomness are global and deterministic, neighbouring chunks produce identical pixels at their borders → **no seams, no duplicates**.
- Peak memory per worker ≈ 2048² × 4 B × 3 layers ≈ 50 MB; 4 workers ≈ 0.5 GB including geometry [E].
- Pyramid built bottom-up: max-zoom tiles written straight to PMTiles; each lower level is 2×2 tiles box-reduced (`Image.reduce(2)`) → the full image never exists in memory.
- Incremental: a chunk re-renders only if its inputs' hash changes.

### 7.3 Browser
Tiles are loaded only for the viewport; no hidden layers (loading an invisible layer wastes bandwidth); overzoom past max with nearest-neighbour instead of extra levels; MapLibre lazy-loaded behind the shell; POIs ≤ a few thousand; tile cache bounded by MapLibre defaults.

### 7.4 Disk budget
| Item | Estimate |
|---|---|
| Python venv (geo stack + pyarrow + Pillow) | ~0.4–0.5 GB |
| `web/node_modules` | ~0.3 GB |
| Raw data (Overture bbox, Overpass JSON, height raster crop) | ~0.1–0.3 GB, plus a temporary height download [U] |
| Outputs (k = 4) | ≤ 0.3 GB |
| **Total** | **≈ 1.2–1.5 GB** of the 16 GB free |

---

## 8. Dependencies

### 8.1 Reuse (already present)
uv, Python 3.14, Node 24/npm, git, `@playwright/cli` + its Chromium (browser testing), isometric-ops scripts (stdlib/Pillow via `uv run`), global Pillow/NumPy (only for quick one-off checks; the project uses its own venv).

### 8.2 Necessary additions (all from PyPI/npm; nothing installed until approved)
| Package | Why | Stage |
|---|---|---|
| shapely, pyproj, geopandas, pyogrio, pyarrow | Geometry, exact reprojection, GeoParquet/GeoPackage I/O | Prototype |
| numpy, pillow (in the venv) | Rendering | Prototype |
| overturemaps | bbox download of Overture buildings/places | Prototype |
| pmtiles (Python) | Write raster/vector tiles into one archive | Prototype |
| pytest | Pipeline tests | Prototype |
| rasterio | Read the Open Buildings height raster | Phase 2 (only if D4 approved) |
| mapbox-vector-tile | Python vector tiles if we avoid tippecanoe | Phase 3 (D9) |
| npm: vite, react, react-dom, typescript, maplibre-gl, pmtiles, vitest, @playwright/test | App + tests | Prototype |

### 8.3 Deliberately not used
Blender, GDAL CLI, DuckDB (the Overture CLI covers bbox reads), tippecanoe/Docker (unless D9), osmium (Overpass is enough for 25 km²), Three.js / deck.gl, OpenSeadragon, cairo/skia/resvg, any AI image model, Google Maps data.

---

## 9. Phased plan

### Phase 0 — Setup (after approval)
Set up the repository and `CLAUDE.md`; create `pipeline/` (uv project) and `web/` (Vite React TS); `.gitignore` for `data/` and outputs.

### Phase 1 — 250 m × 250 m prototype (≈ 1–2 weeks)
**Box:** 250 m square in UTM centred on the HITEC City metro station / Cyber Towers junction (elevated metro, flyover, office towers, arterial roads, mixed heights — the hardest representative mix).

| Step | Output | Acceptance check |
|---|---|---|
| 1. Extract | Overture buildings + OSM roads/water/POIs for the box + 150 m buffer; manifest | Counts reported; manifest complete |
| 2. Normalise | Projected, validated, deduplicated layers with height source per building | Report lists every estimated height; no invalid geometry |
| 3. Project | Isometric coordinates | Round-trip < 1 cm; OSM road centrelines drawn as a debug overlay align with rendered roads within 1 px |
| 4. Render | Art at **k = 2 and k = 4** (both, to choose D3) in 2 chunks forced across the box | No seam along the chunk border (pixel diff of a re-render as one chunk = 0) |
| 5. Style | Palette, light, windows, shadows, trees v1 | Your visual review |
| 6. Tile | `art.pmtiles` + `overlay.geojson` | `pmtiles` header shows correct bounds/zooms |
| 7. App | MapLibre image-space viewer, hover/click inspector, zoom/pan, URL state | Clicking a building shows its correct OSM/Overture record |
| 8. Measure | Render time, peak RAM, tile bytes, fps (Playwright) | Render < 1 min, RAM < 1 GB, 60 fps pan, first view < 1 MB |

Deliverable: a short prototype report with screenshots and numbers, then go/no-go and decisions D2, D3, D5.

### Phase 2 — Pipeline hardening on 1 km × 1 km
Open Buildings heights (if D4), chunk parallelism, depth-sort edge cases, bridges/metro, trees, palette lock, golden-image tests.

### Phase 3 — Full 5 km × 5 km
Full render and pyramid, vector tiles for overlays (D9), QA sweep (random 50 locations compared against OSM), performance re-check.

### Phase 4 — Product features
Search, filters (offices, startups, food, hangouts), POI clustering, building inspector with data sources, data-honesty overlay, English + Telugu labels, accessibility (focus, keyboard, live regions), error states.

### Phase 5 — Testing and release
pytest + Vitest + Playwright e2e, visual regression against our own approved baselines, performance budget, attribution page (OSM, Overture, Google Open Buildings), ODbL data download, static deploy.

---

## 10. Risks and uncertainties
| Risk | Impact | Mitigation |
|---|---|---|
| MapLibre image-space approach has a blocker (resampling, overzoom, label placement) [U] | Display architecture | Proven or rejected in prototype step 7; fallback Leaflet `CRS.Simple` (same tiles) |
| Open Buildings height access: download unit size/format per S2 cell, or Earth Engine sign-in [U] | Heights for ~98 % of buildings | Measure the download before fetching; if too large, Earth Engine export of the bbox (needs your account) |
| Height accuracy (4 m raster, ±several m; tall glass towers) | Skyline credibility | Source + confidence shown per building; hand overrides file for ~20 landmarks with cited heights |
| Overture/OSM footprints in campuses (Mindspace etc.) may be coarse or missing | Visual gaps | Report coverage per block; contribute fixes upstream to OSM rather than inventing |
| Depth-sort errors for large, irregular footprints | Visible artefacts | Topological fallback on overlaps; golden-image tests |
| Telugu label shaping in MapLibre [U] | Bilingual labels | HTML overlay labels for Telugu |
| Terrain ignored (HITEC City has granite hills and the Durgam Cheruvu valley) | Relative heights look flat | Declared limitation; terrain as a later layer (DEM licence check) |
| Disk at 95 % | Failed writes | Budget ≤ 1.5 GB; manifests let us delete raw files after processing |
| Startups data has no open source | Filter completeness | Curated, cited CSV; clearly labelled as partial |

## 11. Decisions requiring your approval
| # | Decision | Recommendation |
|---|---|---|
| D1 | 5 km square centre | Cyber Towers junction (17.4507, 78.3801). Alternative: shift ~2 km south-west to include Gachibowli/Financial District |
| D2 | Display architecture | MapLibre in image space, proven in the prototype; fallback Leaflet `CRS.Simple` |
| D3 | Art resolution | Decide after the prototype renders k = 2 and k = 4 |
| D4 | Height data | Allow the Open Buildings 2.5D download (size to be reported first); Earth Engine only if needed |
| D5 | Installs | Python venv packages in §8.2 (~0.5 GB) and npm packages (~0.3 GB) |
| D6 | Terrain | Flat ground in MVP |
| D7 | Stack | React + TypeScript + Vite |
| D8 | Repo hygiene | Project `CLAUDE.md`, `.gitignore` and first commit |
| D9 | Vector tiles (Phase 3) | Pure-Python `mapbox-vector-tile`, or tippecanoe via Docker |
| D10 | Label languages | English first, Telugu via HTML overlays |

## Sources
[Overture Python CLI](https://docs.overturemaps.org/getting-data/overturemaps-py/) · [overturemaps-py](https://github.com/OvertureMaps/overturemaps-py) · [Open Buildings 2.5D Temporal (Earth Engine catalog, incl. GCS download note and S2-cell tiling)](https://developers.google.com/earth-engine/datasets/catalog/GOOGLE_Research_open-buildings-temporal_v1?hl=en) · [MapLibre custom CRS discussion #163](https://github.com/maplibre/maplibre/discussions/163) · [MapLibre ImageSource](https://maplibre.org/maplibre-gl-js/docs/API/classes/ImageSource) · OSM data via Overpass API (counts above).
