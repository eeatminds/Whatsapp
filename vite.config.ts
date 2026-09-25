import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The SPA lives in web/ and is served by the API server from dist/web in production.
// In development, Vite proxies API, webhook and click-tracking routes to the API on :3000.
export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/r': 'http://localhost:3000',
      '/webhooks': 'http://localhost:3000',
    },
  },
});
