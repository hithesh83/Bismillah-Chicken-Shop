import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],

  // ── Proxy ──────────────────────────────────────────────────
  // Any request starting with /api is forwarded to the Express
  // backend running on port 5000. This avoids CORS issues during
  // development because the browser only ever talks to port 5173.
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:5001',
        changeOrigin: true,
      },
    },
  },
})
