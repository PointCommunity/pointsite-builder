import { cloudflare } from '@cloudflare/vite-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { execFileSync } from 'node:child_process';

export default defineConfig(({ mode }) => ({
  // The worker is lazy-loaded; discover its codec before an upload can trigger a reload.
  optimizeDeps: { include: ['@jsquash/webp/encode'] },
  worker: { format: 'es' },
  define: {
    __BUILDER_SOURCE_CLEAN__: JSON.stringify(
      execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
        encoding: 'utf8',
      }).trim() === '',
    ),
    __BUILDER_SOURCE_REVISION__: JSON.stringify(
      execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    ),
  },
  plugins: [react(), ...(mode === 'native' ? [] : [cloudflare()])],
  build: {
    sourcemap: mode !== 'native',
    ...(mode === 'native' ? { outDir: 'dist/client' } : {}),
  },
}));
