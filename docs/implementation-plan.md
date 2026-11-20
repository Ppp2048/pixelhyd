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

## 12. Workstreams on `feature/residential-discovery`

[V] = checked in the data or the browser · [E] = estimate · snapshot: OSM 2026-11-15, Overture 2026-10-21.

### 12.1 Status
| Workstream | State |
|---|---|
| A. Residential discovery | M1–M9 done: societies data, amenities, drive-time grid, match rules, map highlights, society card, comparison of up to 3, phone layout. Mode off = baseline pixels. 56 pipeline and 73 web tests pass. Not committed. |
| A+. PGs inside residential discovery | R1–R2 done (12.4): 120 PGs in the residential strip, 11 confirmed from operator pages, 30 probable, 79 unverified; drive times, metro and nearby counts in files of their own. Society files unchanged. R3 built (12.4): Show switch, PG filters, card, diamonds and mixed comparison. Not committed. |
| B. Corporate offices | Seed of 10 companies, one record each. Only Microsoft is Confirmed (4 named OSM buildings) and Wells Fargo Unverified. The other 8 have no resolved building, which is why only Microsoft shows on the map. |
| C. Map accuracy | Audited (12.2); nothing changed yet. |

**Renderer:** an offline Python isometric renderer writes raster art PMTiles plus a vector overlay, and MapLibre shows them in image space. `hitec-pipeline tiles batch <ids> --rerender` already re-renders only the chosen tiles. It then rebuilds only their lower-zoom ancestors and replaces only those tiles in the archives.

### 12.2 Map accuracy findings [V]
| Problem | Cause | Tiles affected |
|---|---|---|
| RGIA shows bare ground and grass; there is no runway, taxiway or apron. Begumpet and Hakimpet are likely the same. | `aeroway` is missing from the Overpass query | ≈ 40 [E] |
| Ground-level railways are invisible: 532 km of main line and yards appear as empty strips | The renderer draws only elevated rail | 264 |
| The Old City Green Line extension (12 km, OSM `railway=construction`) is drawn as a finished metro | Rail status is ignored | 14 |
| Flyovers look missing. 53 named flyovers and ≈ 190 km of bridge ways are in the data, drawn as 7 m decks. But their top is the same asphalt as ground roads, so at normal zoom they read as roads. | Deck styling | 842 if restyled |
| Footbridges (9 km) are drawn as 7 m road decks | No class distinction | within the 842 |

Metro Lines 1–3 are present and elevated. Phase II has not been approved (news, Nov 2026), so no planned line is drawn, which is correct.

### 12.3 Fix method: no regeneration
- **Data fixes** (metro status, offices, PGs) go in optional vector layers, off by default. Turning them off restores today's map exactly.
- **Artwork fixes** re-render only the affected tiles with the existing batch, using the same projection, palette and light. Building and road geometry are not refetched.
  - Aeroway comes in as a small extra layer per tile.
  - Before re-rendering: back up `art.pmtiles` and hash every tile.
  - After: every untouched tile must be hash-identical, and changed tiles are reviewed side by side.
- **Order, smallest first:**
  1. Old City construction metro (14 tiles)
  2. Airports (≈ 40)
  3. Ground rail (264)
  4. Flyover deck style (842), only after you approve a one-tile pilot

### 12.4 PGs inside residential discovery
- **Google Maps is not used.**
  - Project rule: no Google Maps content as a data source.
  - Google's Places policy forbids storing Places content (except place IDs) and forbids showing it on a non-Google map.
  - An optional "Open in Google Maps" link (Maps URLs: no API, nothing stored) is allowed.
- **Open data [V]**, in the residential strip:
  - Overture has 595 PG-, hostel- or lodging-like places. The median confidence is 0.58, and there are many false positives: apartment names and institutional hostels.
  - Of these, 12 are branded Stanza Living, 3 Colive and 1 Settl.
  - OSM has almost no PGs tagged.
- **What open data does not have:** rent, deposit, sharing, food, AC and gender. These come only from the operator's own page (cited and dated) or from your own visit. Otherwise they show as "Not published". Listing portals are not scraped.
- **R1, data:** `pipeline/residential/pgs.json`, mirroring `societies.json`:
  - operator;
  - men / women / co-living;
  - location, plus the OSM building where it can be resolved by name (otherwise a point, never the nearest building);
  - rent per single / double / triple sharing, with source and date;
  - deposit;
  - food, Wi-Fi, AC, laundry, housekeeping, each yes / no / unknown;
  - public business contact only;
  - status: Confirmed / Probable / Unverified / Closed;
  - date last checked.
- **R2, pipeline:** the same drive-time grid and nearby counts as for societies.
- **R1–R2 as built [V, 2026-11-20]** (`pgs.py`, `pipeline/residential/pgs.json`):
  - Operator pages are read only where robots.txt and the terms allow it: Zolo, HelloWorld, Settl. and Aadhya yes. Stanza Living (terms forbid robots and reuse) and Colive (blocks ClaudeBot; terms forbid machine-readable databases) are never read; their PGs carry the link only.
  - Of 24 readable pages, 11 gave address, rents and services; 13 no longer list the property (kept as unverified, link dropped). Zolo prints prices without a period, so none is assumed.
  - Overture points for one PG can disagree by up to 12.5 km; 10 PGs are flagged "location uncertain". Hostels on OSM university, college or school grounds are left out (4).
  - Output: `residential_pgs.json`, `residential_pg_commute.json`, `residential_pg_places.json`, about 1 MB gzipped, loaded only when PGs are shown.
- **R3 as built [V, 2026-11-21]:**
  - Code: `web/src/lib/pgs.ts` (data, loading, rules), `ui/PgCard.tsx`, and changes to the panel, comparison strip, map (a symbol layer of runtime-drawn diamonds) and URL (`ht`, `hr`, `hg`, `hi`, `hv`).
  - Pipeline: PGs outside the society neighbourhoods get the nearest OSM suburb or town within 3 km. Without these, 26 PGs had no neighbourhood; now 1 has none. Uncertain PGs keep their other listing points.
  - One refinement to the design: a confirmed page listing a "Classic sharing" room without a count doesn't rule out a sharing choice; it stays unknown.
  - Example search (PGs, ₹12,000, double, women's or mixed, 30 min to Mindspace): 0 match, 8 likely, 67 unknown, 45 hidden.
  - Checks:
    - mode-off views are pixel-identical to M9 apart from the live visit counter;
    - the Societies view loads no PG data;
    - the day look renders;
    - no console errors;
    - 85 web and 68 pipeline tests pass, and the production build passes.
  - The Google Maps link is not built and awaits approval.
- **R3, interface (design approved 2026-11-20).** Mockups were injected into the running app with real data; no source changed.
  - **Show:** Societies (the default, today's view unchanged) · PGs & co-living · Both. Kept in the URL as `ht=pg|both`, so old links open as before. PG files load only when PGs are shown.
  - **Panel:**
    - Monthly rent applies to both types; for PGs it has lower steps, from ₹6,000.
    - BHK and Furnishing apply only to societies. They are hidden for PGs, and in Both they don't affect PGs.
    - New PG fields: Sharing (single / double / triple), Who can stay (men's / women's / mixed), Included (food, Wi-Fi, AC, laundry, housekeeping), and Listing (confirmed on the operator's page).
    - Drive, neighbourhoods, places within 1 km and metro work as now.
  - **PG verdicts** (the same four):
    - Rent: the cheapest published starting price for the chosen sharing. At or under budget it is a match if the price is per month, likely if the page gives no period. Over budget it is "no" if per month, unknown if no period. Unpublished or not read is unknown.
    - Sharing: offered is a match. If a confirmed page lists only other room types, "no". Otherwise unknown.
    - Who can stay: from the operator's page or link, match or "no". From the listing name, likely or "no". Unstated is unknown.
    - Included: yes is a match, no is "no", unstated is unknown.
  - **Map:** PGs are small diamonds; societies keep their round dots and outlines. Filled = match, outlined = likely, dashed amber = unknown; ruled-out PGs are hidden. The open PG gets a ring. For a PG with an uncertain location, its other listing points are dotted.
  - **PG card:**
    - status and fit chips;
    - cautions: page gone, location uncertain, open data only;
    - the reasons;
    - Compare;
    - rent per room type as published, with the date and any missing period;
    - deposit;
    - who can stay, with its source;
    - included, not included and not published;
    - the address as printed;
    - drive, metro, nearby places and sources.
  - **Comparison:** up to 3 homes of either type. New rows: Type, Rent, Rooms, Who can stay, Food. A row that doesn't apply shows "—".
  - **Phone:** the same sheet, with Show at the top.
  - **Pipeline additions:**
    - neighbourhoods for PGs outside the society areas (KPHB, Gopanpally), from OSM place points by the same 3 km rule;
    - the other listing points of uncertain PGs.
  - **Optional, needs approval:** an "Open in Google Maps" link on the card, using Maps URLs (`/maps/search/?api=1&query=`). It opens a new tab and nothing is fetched or stored.
  - **Unchanged:** the artwork, mode off, and the Societies view. These are checked against M9 baselines.
- **R4, checks:** same as M9. Mode off = baseline, and there are no console errors.

### 12.5 Corporate offices
- **B1, schema v2:** one row per office, in `pipeline/corporate/offices.csv`, checked by `hitec-pipeline corporate`. Each row has:
  - company, sector (tech / IT services / banking & finance / pharma & life sciences / consulting / other);
  - campus, address, latitude and longitude, footprint;
  - office type (HQ / development centre / GCC / delivery / R&D / sales / plant);
  - status (Confirmed / Probable / Unverified / Closed) with an evidence date;
  - sources, and confidence.

  The existing 10 seed records are migrated.
- **B2, candidates:** Overture places plus OSM named buildings and office tags produce a review list only, never the map. In the residential strip alone there are 3,608 corporate-category places. Name matches for large employers are noisy: "Apple" matches 32, including resellers.
- **B3, verification:**
  - **Confirmed:** an official company page or a government record (for example SEZ notifications) names the building.
  - **Probable:** an official source names only the campus, or a reputable press source names the building.
  - **Unverified:** open data only.
  - **Closed:** a dated source reports the exit.
- **B4, footprint:** a named OSM building with a name check, or an OSM id chosen during review. Otherwise the office is marked Unresolved, never attached to the nearest building.
- **B5, interface:**
  - The existing search, card and building highlight handle several offices per company.
  - An optional "Offices" layer with a sector filter, off by default.
  - Offices can be chosen as the workplace in residential mode.
  - Design for approval first.
- **Pilot:** about 40 companies across the areas listed, then extend.

### 12.6 Skills
| Skill | Use |
|---|---|
| playwright-cli (installed) | All browser checks, including this audit's airport, rail and flyover views. The Playwright agent-CLI page offers the same skill, so there is nothing new to add. |
| maplibre-cartography, -pmtiles-patterns, -tile-sources (installed, from maplibre/maplibre-agent-skills, MIT) | Overlay ordering and legibility; patching the art archive; GeoJSON is fine for a few thousand points. Of the repo's other 10 skills, only sprites-icons might help later (office/PG icons). Not installed. |
| isometric-ops (installed) | Pixel styling for runway, rail and deck re-renders |
| google-maps-platform (installed) | Only to confirm the terms. No Google data is used. |
| mimic, find-skills | Not needed |
| TerraLabAI/geoai-skills | Not installed: MIT, but 4 commits; built around QGIS; its gis-data skill repeats our Overpass and Overture fetchers. |

### 12.7 Dependencies
- No new npm or Python packages.
- Downloads (sizes reported before fetching):
  - Overture places for the whole city box, needed for offices and PGs outside the residential strip;
  - one small Overpass query for `aeroway`.

### 12.8 Recommended sequence (stop for review after each)
1. PGs R1–R2, then R3–R4. This continues residential discovery and does not touch the artwork.
2. Offices B1–B4 pilot (data only), then the B5 design.
3. Map accuracy, in the 12.3 order: the metro status layer and Old City tiles, then airports, then rail, then the flyover pilot.

## Sources
[Overture Python CLI](https://docs.overturemaps.org/getting-data/overturemaps-py/) · [overturemaps-py](https://github.com/OvertureMaps/overturemaps-py) · [Open Buildings 2.5D Temporal (Earth Engine catalog, incl. GCS download note and S2-cell tiling)](https://developers.google.com/earth-engine/datasets/catalog/GOOGLE_Research_open-buildings-temporal_v1?hl=en) · [MapLibre custom CRS discussion #163](https://github.com/maplibre/maplibre/discussions/163) · [MapLibre ImageSource](https://maplibre.org/maplibre-gl-js/docs/API/classes/ImageSource) · OSM data via Overpass API (counts above).

Section 12: [Places API policies](https://developers.google.com/maps/documentation/places/web-service/policies) · [Overture places taxonomy](https://docs.overturemaps.org/guides/places/taxonomy/) · [Metro Phase II stalled, Telangana Today, 11 Nov 2026](https://telanganatoday.com/metro-rail-expansion-hyderabad-loses-steam-other-city-metros-gain-pace) · [SEZ notifications, sezindia.gov.in](https://sezindia.gov.in/sites/default/files/notifed/Notified_SEZs_358.pdf) · [maplibre-agent-skills](https://github.com/maplibre/maplibre-agent-skills) · [geoai-skills](https://github.com/TerraLabAI/geoai-skills) · [Playwright agent CLI skills](https://playwright.dev/agent-cli/skills)
