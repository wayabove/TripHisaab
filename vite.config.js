import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    // The spreadsheet exporter is intentionally lazy-loaded and weighs ~863 kB.
    // Keep the warning threshold above that known non-initial chunk while the
    // mobile-critical app chunk remains much smaller via manual chunks below.
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/xlsx-js-style")) return "spreadsheet-export";
          if (id.includes("node_modules/firebase")) return "firebase";
          if (id.includes("node_modules/react") || id.includes("node_modules/react-dom")) return "react";
        },
      },
    },
  },
})
