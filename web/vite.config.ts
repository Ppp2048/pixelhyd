import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // MapLibre 6 starts a module worker that imports a sibling chunk by relative URL.
  // Vite's dependency pre-bundling moves the library and breaks that URL, so serve it as-is.
  optimizeDeps: { exclude: ['maplibre-gl'] },
})
