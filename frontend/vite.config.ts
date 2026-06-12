import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Dev mode: forward API calls to a locally running `mesa serve`.
    proxy: {
      '/api': 'http://127.0.0.1:7770',
    },
  },
})
