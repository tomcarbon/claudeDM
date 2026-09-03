import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    fs: {
      // The client legitimately imports shared/text-bounds.mjs, which lives outside this package.
      // Vite's dev server defaults server.fs.allow to the client root alone, so without this the
      // browser gets `403 Restricted` for that module and the whole app fails to load (WO-0007).
      //
      // Scoped to that ONE directory on purpose. Do NOT widen this to '..' or the project root:
      // `host: '0.0.0.0'` above puts this dev server on the LAN, and the project root contains
      // data/, including data/players.json (emails and unsalted SHA-256 password hashes).
      allow: [
        path.resolve(import.meta.dirname, '.'),
        path.resolve(import.meta.dirname, '../shared'),
      ],
    },
  }
})
