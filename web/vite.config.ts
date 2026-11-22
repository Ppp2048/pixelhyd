import { copyFileSync, cpSync, existsSync, linkSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

/** Where development and preview servers keep visit counts (inside the git-ignored data folder). */
const VISITS_DB = fileURLToPath(new URL('../data/stats/visits.sqlite', import.meta.url))

/** Serve the anonymous visit counter (/api/visits) from Vite's dev and preview servers. */
function visits(): Plugin {
  const middleware = async () => {
    const { createVisits } = await import('./server/visits.ts')
    const { sqliteStore } = await import('./server/sqliteStore.ts')
    const { visitsMiddleware } = await import('./server/node.ts')
    return visitsMiddleware(createVisits(sqliteStore(process.env.VISITS_DB ?? VISITS_DB)))
  }
  return {
    name: 'pixelhyd-visits',
    async configureServer(server) {
      server.middlewares.use(await middleware())
    },
    async configurePreviewServer(server) {
      server.middlewares.use(await middleware())
    },
  }
}

/**
 * Copy public/ into the build without public/tiles: the map archives (about 3 GB) are not part of
 * an ordinary build, and Vite would otherwise copy them into every one.
 */
function publicWithoutTiles(): Plugin {
  let outDir = 'dist'
  return {
    name: 'pixelhyd-public-without-tiles',
    apply: 'build',
    configResolved(c) {
      outDir = c.build.outDir
    },
    closeBundle() {
      const from = fileURLToPath(new URL('./public', import.meta.url))
      cpSync(from, outDir, { recursive: true, filter: (src) => relative(from, src).split(sep)[0] !== 'tiles' })
    },
  }
}

/** Cloudflare Pages (free plan) limits on one deployment. */
const HOST_MAX_FILES = 20_000
const HOST_MAX_FILE_BYTES = 25 * 1024 * 1024

/** Every file under `dir`, recursively. */
function* filesIn(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* filesIn(path)
    else yield path
  }
}

/**
 * `npm run build:deploy` (mode "deploy"): put the chunked tiles from the pipeline
 * (`hitec-pipeline deploy`, in ../data/deploy/tiles) into dist/tiles, as hard links where the
 * disk allows so 3 GB is not copied, then check the build fits the host's limits.
 */
function deployTiles(): Plugin {
  let outDir = 'dist'
  let deploy = false
  return {
    name: 'pixelhyd-deploy-tiles',
    apply: 'build',
    configResolved(c) {
      outDir = resolve(c.root, c.build.outDir)
      deploy = c.mode === 'deploy'
    },
    closeBundle() {
      if (!deploy) return
      const from = fileURLToPath(new URL('../data/deploy/tiles', import.meta.url))
      if (!existsSync(from)) throw new Error(`${from} is missing: run \`uv run hitec-pipeline deploy\` in pipeline/ first`)
      let copied = 0
      for (const src of filesIn(from)) {
        const dest = join(outDir, 'tiles', relative(from, src))
        mkdirSync(dirname(dest), { recursive: true })
        rmSync(dest, { force: true })
        try {
          linkSync(src, dest)
        } catch {
          copyFileSync(src, dest)
          copied++
        }
      }
      let files = 0
      let largest = { path: '', bytes: 0 }
      for (const path of filesIn(outDir)) {
        files++
        const bytes = statSync(path).size
        if (bytes > largest.bytes) largest = { path, bytes }
      }
      const summary = `${files} files, largest ${(largest.bytes / 2 ** 20).toFixed(1)} MiB (${relative(outDir, largest.path)})`
      if (files > HOST_MAX_FILES || largest.bytes > HOST_MAX_FILE_BYTES)
        throw new Error(`The build exceeds the host's limits of ${HOST_MAX_FILES} files of 25 MiB: ${summary}`)
      console.log(`deploy build: ${summary}${copied ? `; ${copied} tile files copied, not linked` : ''}`)
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), visits(), publicWithoutTiles(), deployTiles()],
  // MapLibre is most of the main chunk (~375 kB gzipped in all); one chunk is fine for a map app.
  build: { copyPublicDir: false, chunkSizeWarningLimit: 1500 },
  // MapLibre 6 starts a module worker that imports a sibling chunk by relative URL.
  // Vite's dependency pre-bundling moves the library and breaks that URL, so serve it as-is.
  optimizeDeps: { exclude: ['maplibre-gl'] },
})
