import assert from 'node:assert/strict';
import { gzipSync, gunzipSync } from 'node:zlib';
import { defaultSiteDocument } from '../../src/site-kit/default-site';
import { canonicalize } from '../../src/site-kit/canonicalize';

// T1 experiment only. No production persistence format is enabled by this fixture.
const workload = {
  editors: 2,
  sessionsPerEditor: 2,
  sessionMinutes: 45,
  actionsPerSession: 100,
  retentionDays: 90,
  checkpointInterval: 32,
  mediaBudgetBytes: 100_000_000,
  metadataBudgetBytes: 34_000_000,
  databaseBudgetBytes: 350_000_000,
};
const document = structuredClone(defaultSiteDocument);
const samples = 400;
let checkpoint = Buffer.alloc(0);
let rawBytes = 0;
let encodedBytes = 0;
let maximumEncodedBytes = 0;
for (let index = 0; index < samples; index++) {
  document.pages[0].metadata.description = `Editorial action ${index}: résumé, 教会, 🌿.`;
  if (index % 10 === 0) document.pages[0].title = `Welcome ${index}`;
  if (index % 50 === 0 && document.media[0]) document.media[0].alt = `Image ${index}`;
  const current = Buffer.from(canonicalize(document));
  let compressed: Buffer;
  if (index % workload.checkpointInterval === 0) {
    checkpoint = current;
    compressed = gzipSync(current);
    assert.deepEqual(gunzipSync(compressed), current);
  } else {
    let prefix = 0;
    let suffix = 0;
    const length = Math.min(current.length, checkpoint.length);
    while (prefix < length && current[prefix] === checkpoint[prefix]) prefix++;
    while (
      suffix < length - prefix &&
      current[current.length - suffix - 1] === checkpoint[checkpoint.length - suffix - 1]
    )
      suffix++;
    compressed = gzipSync(current.subarray(prefix, current.length - suffix));
    const restored = Buffer.concat([
      checkpoint.subarray(0, prefix),
      gunzipSync(compressed),
      checkpoint.subarray(checkpoint.length - suffix),
    ]);
    assert.deepEqual(restored, current);
  }
  rawBytes += current.length;
  // Model base64 envelope, immutable base pointer, offsets, checksum and codec metadata.
  const storedBytes = Math.ceil(compressed.length / 3) * 4 + 256;
  encodedBytes += storedBytes;
  maximumEncodedBytes = Math.max(maximumEncodedBytes, storedBytes);
}
const actionsPerDay = workload.editors * workload.sessionsPerEditor * workload.actionsPerSession;
const projectedRevisionBytes =
  Math.ceil(encodedBytes / samples) * actionsPerDay * workload.retentionDays;
const projectedDatabaseBytes =
  projectedRevisionBytes + workload.mediaBudgetBytes + workload.metadataBudgetBytes;
assert(projectedDatabaseBytes < workload.databaseBudgetBytes);
console.log(
  JSON.stringify(
    {
      kind: 'synthetic-forward-encoding-feasibility',
      workload,
      samples,
      rawMeanBytes: Math.ceil(rawBytes / samples),
      modeledStoredMeanBytes: Math.ceil(encodedBytes / samples),
      maximumEncodedBytes,
      projectedRevisionBytes,
      projectedDatabaseBytes,
      growthRevisionBytes: projectedRevisionBytes * 4,
      limitation:
        'Public synthetic documents; modeled payload bytes only. D1 allocation, row costs, CPU, migration and complete action distributions remain separate gates.',
    },
    null,
    2,
  ),
);
