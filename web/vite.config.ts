import { defineConfig, loadEnv } from 'vite'
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
  };
})
