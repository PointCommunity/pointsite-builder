import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile, mkdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  compareProjectSnapshot,
  validateAdoptionContract,
  validateLocalLinks,
  validateOperationalText,
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
import { planAdoption, applyAdoptionPlan } from './lib/adoption.mjs';
import { digest } from './lib/ci.mjs';
import { requirePairedQA } from './lib/qa.mjs';
import { identityKeys, reviewRoute, clarificationDecision } from './lib/lifecycle.mjs';

test('question exception accepts only the approved Builder directive and retains continuation checks', async () => {
  const profile = JSON.parse(await readFile('pipeliner.config.json', 'utf8'));
  const directive =
    'Use structured question controls for unresolved clarification when available, as requested by the PM';
  assert.deepEqual(validateOperationalText(directive, { profile }), []);
  assert.ok(validateOperationalText(directive).length);
  const other = structuredClone(profile);
  other.repository.name = 'another-repository';
  assert.ok(validateOperationalText(directive, { profile: other }).length);
  assert.ok(
    validateOperationalText('Use structured question tools for every question', { profile }).length,
  );
  assert.ok(
    validateOperationalText(`${directive}; continue independent authorized work`, { profile })
      .length,
  );
  assert.ok(validateOperationalText(`${directive}; call request_user_input`, { profile }).length);
  assert.deepEqual(
    validateOperationalText(
      'Never use native question controls. Do not continue independent authorized work.',
      { profile },
    ),
    [],
  );
});

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

test('question conflicts block reconciled provider instructions and byte drift still blocks apply', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'builder-question-install-'));
  const sourceRoot = path.join(root, 'source');
  const targetRoot = path.join(root, 'target');
  const relative = '.claude/skills/example/agents/openai.yaml';
  const approved =
    'Use structured question controls for unresolved clarification when available, as requested by the PM';
  const safe = 'Never use native question controls.';
  const conflicting = 'Call request_user_input for clarification.';
  const profile = JSON.parse(await readFile('pipeliner.config.json', 'utf8'));
  try {
    await mkdir(path.dirname(path.join(sourceRoot, relative)), { recursive: true });
    await mkdir(path.dirname(path.join(targetRoot, relative)), { recursive: true });
    await writeFile(path.join(sourceRoot, 'AGENTS.md'), approved);
    await writeFile(path.join(sourceRoot, relative), safe);
    await writeFile(path.join(targetRoot, relative), conflicting);
    const reconciliation = {
      version: 1,
      files: {
        [relative]: {
          sourceSha256: digest(Buffer.from(safe)),
          targetSha256: digest(Buffer.from(conflicting)),
          rationale: 'Fixture review cannot waive a question conflict.',
        },
      },
    };
    const preview = () => planAdoption({ sourceRoot, targetRoot, profile, reconciliation });
    const blocked = await preview();
    assert.equal(blocked.conflicts.length, 0);
    assert.equal(blocked.questionConflicts.length, 1);
    assert.equal(blocked.questionConflicts[0].origin, 'target');
    await assert.rejects(applyAdoptionPlan(blocked), /conflicting question instructions/);
    await assert.rejects(access(path.join(targetRoot, 'AGENTS.md')));
    await writeFile(path.join(targetRoot, relative), safe);
    await writeFile(path.join(sourceRoot, relative), conflicting);
    assert.ok((await preview()).questionConflicts.some((item) => item.origin === 'source'));
    await writeFile(path.join(sourceRoot, relative), safe);
    const clean = await preview();
    assert.equal(clean.questionConflicts.length, 0);
    await applyAdoptionPlan(clean);
    assert.equal((await preview()).create.length, 0);
    const repeat = await preview();
    await writeFile(path.join(targetRoot, relative), `${safe} Changed bytes.`);
    await assert.rejects(applyAdoptionPlan(repeat), /file changed after planning/);
    assert.equal((await preview()).conflicts.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('unanswered clarification yields control without a deadline and resumes only after an answer', () => {
  assert.deepEqual(clarificationDecision(), {
    channel: 'message',
    state: 'waiting',
    timeout: null,
    endTurn: true,
  });
  assert.equal(clarificationDecision({ answered: true }).endTurn, false);
  assert.equal(clarificationDecision({ answered: 'yes' }).endTurn, true);
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
