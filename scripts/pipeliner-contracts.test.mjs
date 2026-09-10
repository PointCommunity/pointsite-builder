import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile, mkdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  compareProjectSnapshot,
  validateAdoptionContract,
  validateLocalLinks,
} from './lib/validation.mjs';

test('reference validation ignores fenced sample output but rejects broken document links', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'builder-links-test-'));
  const file = path.join(root, 'reference.md');
  try {
    await writeFile(file, '```text\n[Snapshot](missing.yml)\n```\n');
    assert.deepEqual(await validateLocalLinks(root, [file]), []);
    await writeFile(file, '[Missing](missing.md)\n');
    assert.equal((await validateLocalLinks(root, [file])).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
import { prepare, cleanup } from './local-qa.mjs';
import { planAdoption } from './lib/adoption.mjs';
import { requirePairedQA } from './lib/qa.mjs';
import { identityKeys, reviewRoute } from './lib/lifecycle.mjs';

test('Builder participant migration keeps Dev distinct from the Human PM and release identity staged', async () => {
  const profile = JSON.parse(await readFile('pipeliner.config.json', 'utf8'));
  assert.equal(requirePairedQA(profile.qa), profile.qa);
  assert.deepEqual(profile.qa.developers, [
    { id: 'Dev', kind: 'agent', github: 'brimdor', environments: ['local-macos'] },
  ]);
  assert.deepEqual(profile.qa.pms, [{ id: 'brimdor', kind: 'human' }]);
  assert.equal(profile.qa.turns[0].developer, 'Dev');
  assert.equal(profile.qa.turns[0].pm, 'brimdor');
  assert.deepEqual(identityKeys(profile, 'pre-release'), ['sourceCommit', 'gitTree']);
  assert.deepEqual(identityKeys(profile, 'released'), ['sourceCommit', 'gitTree', 'deploymentId']);
  assert.equal(profile.release.environments.length, 1);
  assert.equal(profile.release.environments[0].url, 'https://builder.pointatx.org');
  assert.equal(profile.release.cycle, undefined);
  assert.equal(
    reviewRoute({ status: 'In Review', pullRequestState: 'MERGED', findings: true }),
    'new-remediation-pr',
  );
});

test('adoption preserves only the exact approved Builder phrases and rejects drift or another repository', async () => {
  const profile = JSON.parse(await readFile('pipeliner.config.json', 'utf8'));
  const targetRoot = await mkdtemp(path.join(tmpdir(), 'builder-adoption-test-'));
  const preview = (candidate) =>
    planAdoption({ sourceRoot: process.cwd(), targetRoot, profile: candidate });
  try {
    const plan = await preview(profile);
    assert.equal(plan.conflicts.length, 0);
    assert.ok(plan.create.some((file) => file.relativePath === 'scripts/resolve-home.mjs'));
    const changed = structuredClone(profile);
    changed.workflow.approvalPhrases.completion = 'Approved';
    await assert.rejects(preview(changed), /exact PM-preserved Builder contract/);
    const other = structuredClone(profile);
    other.repository.name = 'another-repository';
    await assert.rejects(preview(other), /exact PM-preserved Builder contract/);
    const changedTurn = structuredClone(profile);
    changedTurn.qa.turns[0].approvalPhrase = 'Approved';
    await assert.rejects(preview(changedTurn), /exact PM-preserved Builder contract/);
  } finally {
    await rm(targetRoot, { recursive: true, force: true });
  }
});

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
  const profile = JSON.parse(await readFile('pipeliner.config.json', 'utf8'));
  assert.deepEqual(compareProjectSnapshot(blueprint, snapshot, profile), []);
  assert.ok(compareProjectSnapshot(blueprint, { ...snapshot, public: true }, profile).length);
  assert.ok(compareProjectSnapshot(blueprint, { ...snapshot, repositories: [] }, profile).length);
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

test('adoption validation requires agent testing instead of a bootstrap PM gate', async () => {
  const agents = await readFile('AGENTS.md', 'utf8');
  const adoptionSkill = await readFile('.agents/skills/pipeliner-adopt/SKILL.md', 'utf8');
  const updateSkill = await readFile('.agents/skills/pipeliner-update/SKILL.md', 'utf8');
  assert.match(agents, /No PM Testing is required for adoption or updates/);
  assert.match(updateSkill, /No PM Testing is required for adoption or updates/);
  assert.deepEqual(validateAdoptionContract({ agents, adoptionSkill }), []);
  const regressed = adoptionSkill.replaceAll(
    'No PM Testing is required for adoption or updates',
    'PM Testing steps are required',
  );
  assert.ok(validateAdoptionContract({ agents, adoptionSkill: regressed }).length > 0);
  assert.match(agents, /Approved to complete Issue #<number>/);
});
