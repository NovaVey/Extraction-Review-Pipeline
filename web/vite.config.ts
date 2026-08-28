// defineConfig from 'vitest/config' rather than plain 'vite' -- it re-exports vite's
// own config machinery plus additionally types the `test` field below, so this one
// file covers both `vite dev`/`vite build` and `vitest run` without a second config
// file. loadEnv itself isn't re-exported there, so it still comes from 'vite'.
import { loadEnv } from 'vite'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Read from web/.env.local (gitignored), not the VITE_-prefixed client-exposed
  // vars — API_SHARED_SECRET must never reach the browser bundle. loadEnv's
  // return value is only used here, server-side, to configure the dev proxy.
  const env = loadEnv(mode, process.cwd(), '');
  const target = env.API_PROXY_TARGET || 'http://localhost:3000';
  const apiKey = env.API_SHARED_SECRET;

  return {
    plugins: [react(), tailwindcss()],
    server: {
      // Lets the frontend call same-origin `/api/...` paths in dev without CORS
      // ever entering the picture, and without adding @fastify/cors to the API.
      // Defaults to the local API; point API_PROXY_TARGET at a deployed instance
      // (see web/.env.example) and the shared secret is attached automatically —
      // it never enters the browser this way, only this Node-side proxy.
      proxy: {
        '/api': {
          target,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ''),
          ...(apiKey && { headers: { 'x-api-key': apiKey } }),
        },
      },
    },
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/setupTests.ts'],
    },
  };
})
