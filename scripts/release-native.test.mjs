import assert from 'node:assert/strict';
import test from 'node:test';
import { validateApproval, validateCandidate } from './release-native.mjs';

test('promotion requires approval of the exact clean source, image and both configurations', () => {
  const candidate = {
    sourceRevision: 'a'.repeat(40),
    gitTree: 'b'.repeat(40),
    sourceClean: true,
    repository: '10.0.20.11:32309/pointsite-builder',
    imageDigest: `sha256:${'c'.repeat(64)}`,
  };
  const canaryRevision = 'd'.repeat(40),
    productionConfigHash = 'e'.repeat(64);
  const approval = {
    ...candidate,
    canaryRevision,
    productionConfigHash,
    phrase: 'Approved to merge and deploy production',
    evidence: 'Explicit PM message for this tuple',
  };
  assert.equal(validateCandidate(candidate), candidate);
  assert.doesNotThrow(() =>
    validateApproval(candidate, approval, canaryRevision, productionConfigHash),
  );
  for (const field of [
    'sourceRevision',
    'gitTree',
    'imageDigest',
    'canaryRevision',
    'productionConfigHash',
    'phrase',
    'evidence',
  ])
    assert.throws(() =>
      validateApproval(
        candidate,
        { ...approval, [field]: '' },
        canaryRevision,
        productionConfigHash,
      ),
    );
  assert.throws(() => validateApproval(candidate, undefined, canaryRevision, productionConfigHash));
  assert.throws(() => validateApproval(candidate, approval, 'f'.repeat(40), productionConfigHash));
  assert.throws(() => validateApproval(candidate, approval, canaryRevision, 'f'.repeat(64)));
  for (const change of [
    { sourceClean: false },
    { repository: 'untrusted/image' },
    { imageDigest: `sha256:${'0'.repeat(64)}` },
  ])
    assert.throws(() => validateCandidate({ ...candidate, ...change }));
});
