// `defineConfig` comes from 'vitest/config' rather than 'vite' so the `test`
// block below is typed; it is vite's own `defineConfig` widened, so the
// plugins/build/server halves are unaffected.
import { defineConfig } from 'vitest/config'
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
  test: {
    // Unit tests cover the pure logic modules only — no component rendering,
    // so there is no React testing library here. Two of those modules still
    // reach for browser globals that exist nowhere else (boardView's
    // `localStorage`, keyboardScope's `document`), so the whole suite runs
    // under jsdom rather than splitting environments per file.
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
    // time.ts exists because mesa's timestamps are zoneless UTC that
    // `new Date()` misreads as local — a bug with no symptom at UTC-0. CI
    // runners are UTC, where the assert guarding it passes against a broken
    // implementation too, so pin a fixed offset zone instead of inheriting
    // the machine's. (Fixed, not merely non-UTC: a DST-observing zone would
    // make a hardcoded expected offset depend on the date under test.)
    env: { TZ: 'America/Panama' }, // UTC-5 year round
  },
})
