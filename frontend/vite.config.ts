import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Dev mode: forward API calls to a locally running `mesa serve`.
    // ws:true so the agent-attach terminal WebSocket proxies too.
    // changeOrigin rewrites the Host header to the target (127.0.0.1:7770) —
    // Vite's string shorthand sets this implicitly, but the object form does
    // not, and mesa's guard middleware 403s any Host that isn't its own.
    proxy: {
      '/api': { target: 'http://127.0.0.1:7770', ws: true, changeOrigin: true },
    },
  },
})
