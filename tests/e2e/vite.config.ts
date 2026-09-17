import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// These browser cases supply their own API fixtures. Do not launch a credentialed
// Worker: requests arriving during fixture teardown must fail without broadcasting
// a Worker configuration error to unrelated browser pages through Vite's overlay.
export default defineConfig({
  // The worker is lazy-loaded; discover its codec before an upload can trigger a reload.
  optimizeDeps: { include: ['@jsquash/webp/encode', 'react-dom/server'] },
  worker: { format: 'es' },
  cacheDir: 'node_modules/.vite-e2e',
  plugins: [
    react(),
    {
      name: 'browser-api-fixtures',
      configureServer(server) {
        for (const path of ['/api', '/auth']) {
          server.middlewares.use(path, (_request, response) => {
            response.writeHead(503, {
              'content-type': 'application/json',
              'cache-control': 'no-store',
            });
            response.end(
              JSON.stringify({
                code: 'UNMOCKED_API_REQUEST',
                message: 'Browser test request needs an API fixture',
              }),
            );
          });
        }
      },
    },
  ],
});
