# Data assets: what is in git and how a fresh clone gets the rest

Written 2026-11-27. This describes the **existing** storage strategy; it does not change it. Generated data
is reproducible from the pipeline and is kept out of git (`.gitignore`: `data/`, which also matches
`web/public/data/`, and `web/public/tiles/`). There is no CI workflow in the repository.

## In git (the inputs)

| Path | What |
|---|---|
| `pipeline/src/`, `web/src/` | Code |
| `pipeline/corporate/companies.json`, `sites.json`, `leads.json` | Company research, the source of truth for `corporate.json` ([corporate-model-plan.md](corporate-model-plan.md)) |
| `pipeline/corporate/legacy/` | Archives, byte for byte: the 2026-11-19 research seed, `matches-2026-11.json`, and the last v1 `corporate.json` (`corporate-v1-2026-11.json`) |
| `pipeline/corporate/migration-report.md` | Record of the one-off migration (B3) |
| `pipeline/residential/societies.json`, `pgs.json` | Home-search research |

## Not in git (generated; rebuild with the pipeline)

| Asset | Where | Built by | Needs first |
|---|---|---|---|
| Raw downloads (Overture, OSM, the airport supplement) | `data/raw/` | `hitec-pipeline tiles batch` (or `fetch` for the prototype) | Network; Overpass and Overture |
| Normalised features per tile | `data/work/hitec-city/<tile>/features.gpkg` | `tiles batch` | The raw downloads |
| Rendered tiles and the tile index | `data/out/`, `data/tiles/hitec-city/index.json` | `tiles batch` | The features |
| Map archives | `web/public/tiles/hitec-city-k4/`: `art.<version>.pmtiles`, `overlay.<version>.pmtiles`, `meta.json` | `hitec-pipeline tiles publish` | Validated tiles |
| Search index | `web/public/data/places.json` | `hitec-pipeline places` | OSM downloads and the tile features (it links named buildings to map ids) |
| Company sites | `web/public/data/corporate.json` | `hitec-pipeline corporate` | The tile features holding each site's footprint (it scans the city grid) |
| Home search | `web/public/data/residential*.json` (6 files) | `hitec-pipeline residential fetch`, then `hitec-pipeline residential` | The tile features (society boundaries, footprints, the road graph for drive times) |
| Deploy chunks | `data/deploy/tiles/` | `hitec-pipeline deploy` | The map archives ([deploy.md](deploy.md)) |
| Old seed location | `data/corporate/` | Not rebuilt; superseded by `pipeline/corporate/` | — |

## A fresh clone, step by step

1. `cd pipeline && uv sync`; `cd ../web && npm install`.
2. **Tests work without any generated data.** Tests that need it are skipped: `test_seams.py` (tile
   features) and the v2 half of `web/src/lib/corporate.test.ts` (a built `corporate.json`). The v1 half
   reads the tracked archive, so it always runs.
3. **Quick look (prototype area):** `fetch`, `normalise` and `render --area prototype` (see README, "Run
   it"). This gives art for 250 m only. Company and home data need the city tiles where their buildings
   are, so `corporate` and `residential` report missing footprints there. `corporate` then writes a
   file with no sites and exits 1, and the app runs without company data.
4. **The full city:** `tiles batch` until `tiles status` shows every tile validated, then `tiles publish`,
   `places`, `corporate`, `residential fetch` and `residential`. This takes hours and about 3 GB of
   archives (plus the raw downloads), and it re-downloads from Overpass and Overture. Their data changes
   over time, so a rebuild can differ from the published map. The corporate build checks every
   footprint by its OSM name and fails loudly if one moved or was renamed.
5. Without `web/public/tiles/`, the app loads but the map is blank. Without `web/public/data/`, search,
   company sites and home search are missing; `loadCorporate` returns `null` and the map still works.

## Where the current published data lives

Only on the development laptop. The archives in use there are `art.20261126150257681436.pmtiles` and
`overlay.20261126150426904530.pmtiles`. The live site ([deploy.md](deploy.md)) holds the copy from its last
manual deploy: on 2026-11-27, from `main` at `a1aefc9`, with these same archives (as chunk files) and the
v2 `corporate.json`. Deploys are manual, so later changes reach it only when it is deployed again. The
Cloudflare deployment is not a backup: it holds chunk files and built data, not the inputs. A lost laptop means a full rebuild. Options for later (not
adopted; each needs a decision): keep the small JSON outputs in git, or attach a data snapshot to a
GitHub release.
