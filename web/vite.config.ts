import { cpSync } from 'node:fs'
import { relative, sep } from 'node:path'
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
 * Copy public/ into the build without public/tiles: the map archives (about 3 GB) are hosted
 * separately (VITE_TILES_URL), and Vite would otherwise copy them into every build.
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

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), visits(), publicWithoutTiles()],
  // MapLibre is most of the main chunk (~375 kB gzipped in all); one chunk is fine for a map app.
  build: { copyPublicDir: false, chunkSizeWarningLimit: 1500 },
  // MapLibre 6 starts a module worker that imports a sibling chunk by relative URL.
  // Vite's dependency pre-bundling moves the library and breaks that URL, so serve it as-is.
  optimizeDeps: { exclude: ['maplibre-gl'] },
})
