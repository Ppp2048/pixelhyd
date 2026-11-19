# Deploying Pixelhyd

Three parts, deployed separately:

| Part | What | Size | Where (free) |
|---|---|---|---|
| Site | `web/dist` from `npm run build` (app, `data/corporate.json`, `data/places.json`) | ~4 MB | Cloudflare Pages |
| Visit counter | `/api/visits`: `web/functions/api/visits.ts` + `web/server/` | — | Pages Function + D1 |
| Tiles | `web/public/tiles/hitec-city-k4/`: `meta.json`, `art.<version>.pmtiles`, `overlay.<version>.pmtiles` | ~3 GB | R2 bucket |

No secrets live in the repository. `VITE_TILES_URL` is a public URL baked into the build, and the
D1 `database_id` in `web/wrangler.toml` is an identifier, not a credential. The one credential, an
R2 upload token, stays in your rclone config.

Cloudflare's free allowances cover this comfortably: R2 10 GB stored, 10 M reads and 1 M writes a
month with no download fees; Workers/Pages Functions 100 000 requests a day (the counter sends one
per visitor per minute); D1 5 GB and 100 000 written rows a day. Cloudflare may ask for a payment
method before turning R2 on; nothing is charged within the free allowance.

Commands use Git Bash from `web/`. `wrangler` is run with `npx` at a pinned version, not installed
into the project. `WRANGLER_SEND_METRICS=false` turns off its usage telemetry.

## 0. Check locally first (no account needed)

```bash
npm run build
npx wrangler@4.156.0 d1 migrations apply pixelhyd-visits --local
npx wrangler@4.156.0 pages dev        # http://localhost:8788, counter on local D1
```

## 1. Account steps (yours)

1. Create a Cloudflare account and turn on R2 in the dashboard.
2. Sign wrangler in: `npx wrangler@4.156.0 login` (opens the browser).
3. Install rclone for the large upload: `winget install Rclone.Rclone`.
4. In the dashboard, R2 → Manage API tokens → create a token with Object Read & Write on the
   `pixelhyd-tiles` bucket only. Run `rclone config` and add a remote named `r2`: type `s3`,
   provider `Cloudflare`, the token's access key and secret, endpoint
   `https://<account id>.r2.cloudflarestorage.com`. Never paste the token into the repo or chat.

## 2. Tiles → R2

```bash
npx wrangler@4.156.0 r2 bucket create pixelhyd-tiles
npx wrangler@4.156.0 r2 bucket cors set pixelhyd-tiles --file deploy/r2-cors.json
npx wrangler@4.156.0 r2 bucket dev-url enable pixelhyd-tiles   # prints https://pub-….r2.dev

# Archives first (immutable: each build has a new name), then meta.json (short cache).
rclone copy public/tiles/hitec-city-k4 r2:pixelhyd-tiles/hitec-city-k4 --exclude meta.json \
  --s3-chunk-size 100M --header-upload "Cache-Control: public, max-age=31536000, immutable" -P
rclone copyto public/tiles/hitec-city-k4/meta.json r2:pixelhyd-tiles/hitec-city-k4/meta.json \
  --header-upload "Cache-Control: public, max-age=300"
```

The `r2.dev` address is rate-limited and meant for light use. If you own a domain on Cloudflare,
connect it to the bucket instead (R2 → bucket → Settings → Custom domains) and use that URL below.

## 3. Counter database → D1

```bash
npx wrangler@4.156.0 d1 create pixelhyd-visits      # copy database_id into wrangler.toml
npx wrangler@4.156.0 d1 migrations apply pixelhyd-visits --remote
```

## 4. Site → Pages

```bash
VITE_TILES_URL=https://pub-….r2.dev npm run build
npx wrangler@4.156.0 pages deploy                    # first run creates the "pixelhyd" project
```

The site is then at `https://pixelhyd.pages.dev`. To publish new tiles later: upload the new
archives, then `meta.json`. No site rebuild is needed.

## Other hosts

`npm start` runs `web/server/main.ts`: the site and the counter in one Node 24 process (SQLite at
`VISITS_DB` on a persistent disk; `TRUST_PROXY=1` behind a proxy). Any bucket works for tiles if it
answers `Range` requests with `206`, sends CORS for `GET, HEAD` with header `Range` and exposes
`ETag, Content-Range`, and serves `.pmtiles` without `Content-Encoding`.

## Checks after deploying

- The whole city draws, and zooming in loads building detail (tiles reachable; CORS and ranges work).
- Search finds "Charminar" and "Microsoft" (data files served).
- `https://pixelhyd.pages.dev/api/visits` returns `{"active":…,"total":…}`; opening the site in a normal browser raises `active`.
- The browser console is free of CORS or 4xx errors.
