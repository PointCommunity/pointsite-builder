import { cloudflare } from '@cloudflare/vite-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { execFileSync } from 'node:child_process';

export default defineConfig({
  define: {
    __BUILDER_SOURCE_REVISION__: JSON.stringify(
      execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    ),
  },
  plugins: [react(), cloudflare()],
  build: {
    sourcemap: true,
  },
});
