import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Bundled fonts (no CDN): the UI is embedded in the binary and must render
// offline (spec Requirement 10).
import '@fontsource/orbitron/700.css'
import '@fontsource/share-tech-mono/400.css'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
