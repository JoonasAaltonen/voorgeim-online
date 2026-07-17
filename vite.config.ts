import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Vite does not run the Worker, so online play would have nothing to talk
      // to on this port. With `wrangler dev` up alongside, this keeps the room
      // socket reachable at the same origin the client expects — so `npm run
      // dev` gives HMR *and* online play. Hotseat needs neither.
      '/api': { target: 'http://127.0.0.1:8787', ws: true },
    },
  },
})
