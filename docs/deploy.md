# Deploying Pixelhyd

Everything is served by Cloudflare Pages on the free plan, with no payment method:

| Part | What | Size |
|---|---|---|
| Site | `web/dist` from `npm run build:deploy`: the app and `data/*.json` | ~4 MB |
| Tiles | `dist/tiles/hitec-city-k4/`: `meta.json` and the two map archives cut into 256 KiB chunk files | ~3.06 GB, ~11,700 files |
| Visit counter | `/api/visits`: `web/functions/api/visits.ts` + `web/server/`, stored in D1 | — |

## Why the tiles are cut into chunks

The map archives are PMTiles files, which a reader normally fetches in byte ranges. Pages answers a
range request with the whole file, and limits a deployment to 20,000 files of at most 25 MiB, so the
2.4 GB and 0.6 GB archives cannot be served as they are.

`hitec-pipeline deploy` cuts each archive into fixed-size chunk files (`chunks/<archive>/<i>.bin`)
and writes a `meta.json` with a `chunks` field listing each archive's size, chunk size, chunk count
and SHA-256. The app (`web/src/map/chunkedSource.ts`) then reads any byte range by fetching the whole
chunks that cover it, keeps recent chunks in memory, and slices out the bytes. The chunks of an
archive, joined in order, are the archive byte for byte. Without a `chunks` field (development, or a
host that answers range requests) the app reads the archives directly.

Chunk folders are named after the archive's version, so they never change and are cached for a year
(`public/_headers`); `meta.json` is cached for five minutes.

## Free allowances

- Pages: unlimited static requests and bandwidth; 20,000 files per deployment, 25 MiB per file.
  The build stops if it would exceed either limit.
- Pages Functions count as Workers requests: 100,000 a day. Only `/api/visits` runs a function
  (wrangler generates the routes); the counter sends one request per visitor per minute.
- D1: 5 GB stored, 100,000 rows written a day.

No secrets live in the repository. The D1 `database_id` in `web/wrangler.toml` is an identifier, not
a credential, and wrangler keeps its sign-in outside the project.

Commands use Git Bash. `wrangler` is run with `npx` at a pinned version, not installed into the
project. `WRANGLER_SEND_METRICS=false` turns off its usage telemetry.

## 0. Build and check locally (no account needed)

```bash
cd pipeline && uv run hitec-pipeline deploy   # data/deploy/tiles: ~11,700 chunk files, checked by SHA-256
cd ../web && npm run build:deploy             # dist/ with the chunks hard-linked in; checks the host limits
npm run preview                               # http://localhost:4173, counter on local SQLite
```

`npx wrangler@4.156.0 pages dev` also serves `dist/` with the real Pages Function and a local D1
(after `d1 migrations apply pixelhyd-visits --local`), but it reads all 3 GB before answering, so
the first request is slow.

`hitec-pipeline deploy` keeps chunk folders that still match their archive, so running it again
after publishing new tiles only cuts the new archive.

## 1. Account steps (yours)

1. Create a free Cloudflare account.
2. Sign wrangler in: `npx wrangler@4.156.0 login` (opens the browser).

## 2. Counter database → D1

```bash
cd web
npx wrangler@4.156.0 d1 create pixelhyd-visits      # copy database_id into wrangler.toml
npx wrangler@4.156.0 d1 migrations apply pixelhyd-visits --remote
```

## 3. Site and tiles → Pages

```bash
npx wrangler@4.156.0 pages project create pixelhyd --production-branch main   # once
npm run build:deploy
npx wrangler@4.156.0 pages deploy --branch main
```

`--branch main` makes it the production deployment; without it, wrangler names the deployment
after the current git branch and it becomes a preview at its own address.
The first deploy uploads about 3 GB. Later deploys upload only files whose contents are new
(wrangler compares hashes), so app changes take seconds and new tiles upload only the new chunks.
The site is then at `https://pixelhyd.pages.dev`.

To publish new tiles: `hitec-pipeline tiles publish`, then `hitec-pipeline deploy`,
`npm run build:deploy` and `pages deploy`.

## Other hosts

- `npm start` runs `web/server/main.ts`: the site and the counter in one Node 24 process (SQLite at
  `VISITS_DB` on a persistent disk; `TRUST_PROXY=1` behind a proxy). Build with
  `npm run build:deploy` to include the chunked tiles.
- A bucket that answers `Range` requests with `206` (R2, S3) can serve the archives whole: build with
  `VITE_TILES_URL=https://… npm run build` and upload `web/public/tiles/hitec-city-k4/` (archives
  first, then `meta.json`). It must send CORS for `GET, HEAD` with header `Range`, expose
  `ETag, Content-Range` (`web/deploy/r2-cors.json`), and serve `.pmtiles` without
  `Content-Encoding`. R2 may ask for a payment method before it is turned on.

## Data licences

The map art is a produced work from OpenStreetMap and Overture Maps data; the map's credit line
names both. The overlay tiles and the files under `/data` are derived databases of OpenStreetMap
data, so they are offered under the Open Database License; the Settings panel says so and links the
licence.

## Checks after deploying

- The whole city draws, and zooming in loads building detail. In the browser's network panel, tiles
  arrive as `chunks/…/<i>.bin` with status 200 and no `Range` header.
- Search finds "Charminar" and "Microsoft" (data files served).
- `https://pixelhyd.pages.dev/api/visits` returns `{"active":…,"total":…}`; opening the site in a
  normal browser raises `active`.
- The browser console is free of errors.
- Settings shows the data licence and visit-count privacy notes.
