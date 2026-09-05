import { gzipSync } from 'node:zlib';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const directory = 'dist/client/assets';
const files = (await readdir(directory)).filter((name) => name.endsWith('.js'));
const sizes = await Promise.all(
  files.map(async (name) => ({
    name,
    gzipBytes: gzipSync(await readFile(join(directory, name))).byteLength,
  })),
);
const editor = sizes.find((item) => item.name.startsWith('VisualEditor-'));
const total = sizes.reduce((sum, item) => sum + item.gzipBytes, 0);
const evidence = {
  ok: Boolean(editor) && (editor?.gzipBytes ?? Infinity) <= 200_000 && total <= 500_000,
  totalJavaScriptGzipBytes: total,
  totalBudgetBytes: 500_000,
  lazyEditorGzipBytes: editor?.gzipBytes ?? null,
  lazyEditorBudgetBytes: 200_000,
  chunks: sizes.sort((left, right) => right.gzipBytes - left.gzipBytes),
  measuredAt: new Date().toISOString(),
};
await mkdir('artifacts', { recursive: true });
await writeFile('artifacts/bundle-budget.json', `${JSON.stringify(evidence, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(evidence)}\n`);
if (!evidence.ok) process.exitCode = 1;
