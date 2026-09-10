import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile, mkdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compareProjectSnapshot } from './lib/validation.mjs';
import { prepare, cleanup } from './local-qa.mjs';

test('audits the private adopter Project without requiring the public upstream identity', async () => {
  const blueprint = JSON.parse(await readFile('blueprints/github-project.json', 'utf8'));
  const identity = {
    title: 'PointSite Builder',
    visibility: 'PRIVATE',
    repository: 'PointCommunity/pointsite-builder',
  };
  const snapshot = {
    title: identity.title,
    public: false,
    repositories: [identity.repository],
    fields: blueprint.fields,
    views: blueprint.views,
    workflows: blueprint.workflows,
  };
  assert.deepEqual(compareProjectSnapshot(blueprint, snapshot, identity), []);
  assert.ok(compareProjectSnapshot(blueprint, { ...snapshot, public: true }, identity).length);
  assert.ok(compareProjectSnapshot(blueprint, { ...snapshot, repositories: [] }, identity).length);
});

test('cleanup removes only outputs absent at QA preparation and refuses a forged inventory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'builder-qa-test-'));
  try {
    await mkdir(path.join(root, 'node_modules'));
    await writeFile(path.join(root, 'node_modules', 'existing'), 'preserve');
    await prepare(root, 0);
    await mkdir(path.join(root, 'dist'));
    await cleanup(root);
    await assert.rejects(access(path.join(root, 'dist')));
    assert.equal(await readFile(path.join(root, 'node_modules', 'existing'), 'utf8'), 'preserve');
    await prepare(root, 0);
    const markerPath = path.join(root, '.pipeliner-local-qa.json');
    const marker = JSON.parse(await readFile(markerPath, 'utf8'));
    marker.createdPaths = ['../outside'];
    await writeFile(markerPath, JSON.stringify(marker));
    await assert.rejects(cleanup(root), /inventory/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('maintenance routing retains Issue-free adoption and local-only application QA', async () => {
  const agents = await readFile('AGENTS.md', 'utf8');
  const adopt = await readFile('.agents/skills/pipeliner-adopt/SKILL.md', 'utf8');
  const workflow = await readFile('.github/workflows/quality.yml', 'utf8');
  assert.match(agents, /Pipeliner adoption.*direct framework maintenance/);
  assert.match(adopt, /Do not create or require a GitHub Issue/);
  assert.match(workflow, /npm ci --ignore-scripts/);
  assert.match(workflow, /fetch-depth: 2/);
  assert.match(workflow, /show --first-parent --format= --check HEAD/);
  assert.doesNotMatch(
    workflow,
    /run:.*npm run (?:build|test:e2e|test:performance|test:coverage|check)\b/,
  );
});
