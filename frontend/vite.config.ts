import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    // Vite's default target (baseline-widely-available) floors out at
    // iOS/Safari 16.4 — a real device on an older iOS gets a silent
    // module-script SyntaxError (page loads, CSS background shows, React
    // never mounts). Widen the floor so the bundle keeps working on older
    // real devices, not just the current-iOS simulator.
    target: ['es2020', 'safari13', 'ios13'],
  },
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
