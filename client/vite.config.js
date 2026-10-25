import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Loopback by default, widened only on purpose, by the SAME variable the API server reads
    // (`server/index.js`, `resolveHost`) — one switch for both listeners, because widening one
    // without the other produces a page that loads and an app that does not work. WO-0034.
    //
    // Enforced, not asserted: `server/__tests__/bind-and-cors.test.js` scans this file and fails
    // if this value becomes a literal again. It was `'0.0.0.0'` until 2026-09-23.
    host: process.env.CLAUDEDM_HOST || '127.0.0.1',
    fs: {
      // The client legitimately imports shared/text-bounds.mjs, which lives outside this package.
      // Vite's dev server defaults server.fs.allow to the client root alone, so without this the
      // browser gets `403 Restricted` for that module and the whole app fails to load (WO-0007).
      //
      // Scoped to that ONE directory on purpose. Do NOT widen this to '..' or the project root:
      // `CLAUDEDM_HOST=0.0.0.0` puts this dev server on the LAN, and the project root contains
      // data/, including data/players.json (emails and unsalted SHA-256 password hashes).
      allow: [
        path.resolve(import.meta.dirname, '.'),
        path.resolve(import.meta.dirname, '../shared'),
      ],
    },
  }
})
