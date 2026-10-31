import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { validateApproval, validateCandidate, validateGitopsCheckout } from './release-native.mjs';
import { productionConfigHash, validateInspection, validateRoute } from './release-linode.mjs';

test('GitOps permits a clean detached canonical worktree and rejects drift or other authority', async () => {
  const root = await mkdtemp(join(tmpdir(), 'builder-gitops-test-'));
  const git = (...args) =>
    execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  try {
    git('init', '--initial-branch=master');
    git('config', 'user.name', 'Release test');
    git('config', 'user.email', 'release@example.invalid');
    await writeFile(join(root, 'values.yaml'), 'image: retained\n');
    git('add', '.');
    git('commit', '-m', 'fixture');
    const revision = git('rev-parse', 'HEAD');
    git('remote', 'add', 'origin', 'git@git.eaglepass.io:ops/homelab.git');
    git('update-ref', 'refs/remotes/origin/master', revision);
    assert.equal(validateGitopsCheckout(root), revision);
    git('checkout', '--detach');
    assert.equal(validateGitopsCheckout(root), revision);
    await writeFile(join(root, 'unrelated.txt'), 'preserve\n');
    assert.throws(() => validateGitopsCheckout(root), /CLEAN_CURRENT_GITOPS_REQUIRED/);
    await rm(join(root, 'unrelated.txt'));
    git('checkout', '-b', 'unreviewed');
    assert.throws(() => validateGitopsCheckout(root), /CANONICAL_GITOPS_MASTER_REQUIRED/);
    git('checkout', '--detach');
    git('remote', 'set-url', '--push', 'origin', 'https://example.invalid/ops/homelab');
    assert.throws(() => validateGitopsCheckout(root), /CANONICAL_GITOPS_MASTER_REQUIRED/);
    git('config', '--unset', 'remote.origin.pushurl');
    git('remote', 'set-url', 'origin', 'https://example.invalid/ops/homelab');
    assert.throws(() => validateGitopsCheckout(root), /CANONICAL_GITOPS_MASTER_REQUIRED/);
    git('remote', 'set-url', 'origin', 'git@git.eaglepass.io:ops/homelab.git');
    git('commit', '--allow-empty', '-m', 'unpublished');
    assert.throws(() => validateGitopsCheckout(root), /CLEAN_CURRENT_GITOPS_REQUIRED/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Linode release requires approval of the exact clean source, Canary and runtime configuration', () => {
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

test('legacy homelab Production action fails before it can mutate GitOps', () => {
  assert.throws(
    () =>
      execFileSync('node', ['scripts/release-native.mjs', 'production'], {
        encoding: 'utf8',
        stdio: 'pipe',
      }),
    /Linode Production uses release-linode\.mjs/,
  );
  execFileSync('bash', ['-n', 'scripts/deploy-linode-production.sh']);
});

test('Linode approval hash binds the observed host configuration and Canary identity', () => {
  const candidate = validateCandidate({
    sourceRevision: 'a'.repeat(40),
    gitTree: 'b'.repeat(40),
    sourceClean: true,
    repository: '10.0.20.11:32309/pointsite-builder',
    imageDigest: `sha256:${'c'.repeat(64)}`,
  });
  const inspected = validateInspection({
    wrapperHash: 'd'.repeat(64),
    unitHash: 'e'.repeat(64),
    previousImage: `localhost/pointsite-builder:${'f'.repeat(40)}`,
    previousImageId: `sha256:${'1'.repeat(64)}`,
  });
  const current = productionConfigHash(candidate, '2'.repeat(40), inspected);
  assert.match(current, /^[a-f0-9]{64}$/);
  const podmanInspection = { ...inspected, previousImageId: '1'.repeat(64) };
  assert.equal(validateInspection(podmanInspection), podmanInspection);
  assert.notEqual(current, productionConfigHash(candidate, '2'.repeat(40), podmanInspection));
  assert.throws(() => validateInspection({ ...inspected, previousImageId: '1'.repeat(63) }));
  assert.notEqual(current, productionConfigHash(candidate, '3'.repeat(40), inspected));
  assert.notEqual(
    current,
    productionConfigHash(candidate, '2'.repeat(40), { ...inspected, wrapperHash: '4'.repeat(64) }),
  );
  assert.throws(() => validateInspection({ ...inspected, previousImage: 'builder:latest' }));
});

test('Production route must precede the homelab wildcard and Canary cannot target Linode', () => {
  const route = [
    "- hostname: 'builder.eaglepass.io'",
    '  service: http://45.33.2.134:3000',
    '  originRequest:',
    '    httpHostHeader: builder.eaglepass.io',
    "- hostname: '*.eaglepass.io'",
    '  service: https://ingress-nginx-controller.ingress-nginx',
  ].join('\n');
  assert.doesNotThrow(() => validateRoute(route));
  assert.throws(() => validateRoute(route.replace('45.33.2.134', '10.0.20.11')));
  assert.throws(() =>
    validateRoute(route.replace('builder.eaglepass.io', 'builder-canary.eaglepass.io')),
  );
  assert.throws(() =>
    validateRoute(
      route.replace("- hostname: '*.eaglepass.io'", "- hostname: 'builder-canary.eaglepass.io'"),
    ),
  );
  assert.throws(() =>
    validateRoute(
      route.replace('https://ingress-nginx-controller.ingress-nginx', 'http://45.33.2.134:3000'),
    ),
  );
});

test('Linode wrapper switch preserves other bytes and rejects an ambiguous image pin', async () => {
  const script = await readFile('scripts/deploy-linode-production.sh', 'utf8');
  const python = script.match(
    /python3 - "\$wrapper" "\$previous_image" "\$new_image" <<'PY'\n([\s\S]*?)\nPY/,
  );
  assert.ok(python);
  const root = await mkdtemp(join(tmpdir(), 'builder-wrapper-test-'));
  const wrapper = join(root, 'pointsite-builder-run');
  const oldImage = `localhost/pointsite-builder:${'a'.repeat(40)}`;
  const newImage = `localhost/pointsite-builder:${'b'.repeat(40)}`;
  const original = `#!/bin/sh\nSECRET_FILE=/protected/key\npodman run ${oldImage}\n`;
  try {
    await writeFile(wrapper, original);
    await chmod(wrapper, 0o700);
    execFileSync('python3', ['-', wrapper, oldImage, newImage], { input: python[1] });
    assert.equal(await readFile(wrapper, 'utf8'), original.replace(oldImage, newImage));
    assert.equal((await stat(wrapper)).mode & 0o777, 0o700);
    await writeFile(wrapper, original + `# ${oldImage}\n`);
    assert.throws(() =>
      execFileSync('python3', ['-', wrapper, oldImage, newImage], {
        input: python[1],
        stdio: 'pipe',
      }),
    );
    assert.equal(await readFile(wrapper, 'utf8'), original + `# ${oldImage}\n`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Linode image build verifies freshly built source metadata before packaging', async () => {
  const script = await readFile('scripts/deploy-linode-production.sh', 'utf8');
  assert.ok(script.indexOf('podman run --rm') < script.indexOf('podman build --quiet'));
  const python = script.match(
    /python3 - "\$app\/dist\/release\.json" "\$main_revision" "\$approved_tree" <<'PY'\n([\s\S]*?)\nPY/,
  );
  assert.ok(python);
  const root = await mkdtemp(join(tmpdir(), 'builder-build-metadata-test-'));
  const release = join(root, 'release.json');
  const revision = 'a'.repeat(40);
  const tree = 'b'.repeat(40);
  try {
    await writeFile(
      release,
      JSON.stringify({ sourceClean: true, sourceRevision: revision, gitTree: tree }),
    );
    assert.doesNotThrow(() =>
      execFileSync('python3', ['-', release, revision, tree], { input: python[1] }),
    );
    await writeFile(
      release,
      JSON.stringify({ sourceClean: true, sourceRevision: 'c'.repeat(40), gitTree: tree }),
    );
    assert.throws(() =>
      execFileSync('python3', ['-', release, revision, tree], { input: python[1], stdio: 'pipe' }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
