import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { build } from 'vite';

// Build from a real checkout. The release command checks cleanliness before invoking this.
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const release = {
  sourceRevision: git('rev-parse', 'HEAD'),
  gitTree: git('rev-parse', 'HEAD^{tree}'),
  sourceClean: git('status', '--porcelain', '--untracked-files=all') === '',
};
await build({ mode: 'native' });
// External @imports can make lazy CSS loading fail under the native content security policy.
for (const file of await readdir('dist/client/assets')) {
  if (
    file.endsWith('.css') &&
    /@import\s+(?:url\()?['"]?https?:/i.test(await readFile(`dist/client/assets/${file}`, 'utf8'))
  )
    throw new Error('NATIVE_STYLES_MUST_BE_LOCAL');
}
await build({
  configFile: false,
  publicDir: false,
  ssr: { noExternal: true },
  build: {
    ssr: true,
    outDir: 'dist/server',
    target: 'node22',
    sourcemap: false,
    rollupOptions: {
      input: { index: 'server/index.ts', operator: 'server/operator.ts' },
      output: { entryFileNames: '[name].js' },
    },
  },
});
if (
  git('rev-parse', 'HEAD') !== release.sourceRevision ||
  (release.sourceClean && git('status', '--porcelain', '--untracked-files=all') !== '')
)
  throw new Error('SOURCE_CHANGED_DURING_BUILD');
await mkdir('dist', { recursive: true });
await writeFile('dist/release.json', JSON.stringify(release) + '\n');
console.log(JSON.stringify({ event: 'native_build_complete', ...release }));
