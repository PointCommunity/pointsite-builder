import { mkdir, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { createApp } from '../../src/server/index.ts';
import { InMemoryRepository } from '../../src/server/repositories/memory.ts';

const app = createApp({
  repository: new InMemoryRepository(),
  authenticate: () => Promise.resolve({ email: 'load@pointatx.org', role: 'viewer' }),
  environment: 'performance-test',
  version: 'local',
});
const samples = [];
const requests = 1_000;
const concurrency = 25;
for (let offset = 0; offset < requests; offset += concurrency) {
  await Promise.all(
    Array.from({ length: Math.min(concurrency, requests - offset) }, async () => {
      const started = performance.now();
      const response = await app.request('https://builder.pointatx.org/api/drafts');
      if (response.status !== 200) throw new Error(`Unexpected load response ${response.status}`);
      await response.arrayBuffer();
      samples.push(performance.now() - started);
    }),
  );
}
samples.sort((left, right) => left - right);
const percentile = (value) => samples[Math.ceil((value / 100) * samples.length) - 1] ?? 0;
const evidence = {
  ok: percentile(95) < 100,
  requests,
  concurrency,
  p50Ms: Number(percentile(50).toFixed(2)),
  p95Ms: Number(percentile(95).toFixed(2)),
  p99Ms: Number(percentile(99).toFixed(2)),
  budgetP95Ms: 100,
  measuredAt: new Date().toISOString(),
};
await mkdir('artifacts', { recursive: true });
await writeFile('artifacts/api-load.json', `${JSON.stringify(evidence, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(evidence)}\n`);
if (!evidence.ok) process.exitCode = 1;
