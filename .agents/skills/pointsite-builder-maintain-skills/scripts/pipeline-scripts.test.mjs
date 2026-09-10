import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractAssetPaths,
  validateHealthPayload,
  validateHtml,
} from '../../pointsite-builder-release-production/scripts/verify-live.mjs';
import { auditPipelineSnapshot } from '../../pointsite-builder-pipeline-health/scripts/audit-pipeline.mjs';

const projectFields = [
  {
    name: 'Status',
    options: ['Backlog', 'On Hold', 'In Progress', 'In Review', 'Done'].map((name) => ({ name })),
  },
  { name: 'Priority', options: ['P0', 'P1', 'P2', 'P3'].map((name) => ({ name })) },
  { name: 'Impact', options: ['High', 'Medium', 'Low'].map((name) => ({ name })) },
  { name: 'Effort', options: ['XS', 'S', 'M', 'L', 'XL'].map((name) => ({ name })) },
];

const projectViews = ['Backlog', 'Kanban'].map((name) => ({
  name,
  layout: 'BOARD_LAYOUT',
  verticalGroupBy: 'Status',
}));

const projectWorkflows = [
  'Auto-add sub-issues to project',
  'Auto-close issue',
  'Item added to project',
  'Item closed',
  'Pull request linked to issue',
  'Pull request merged',
].map((name) => ({ name, enabled: name !== 'Pull request merged' }));

function baseSnapshot(overrides = {}) {
  return {
    project: { title: 'PointSite Builder', public: false, closed: false },
    fields: projectFields,
    repositories: ['PointCommunity/pointsite-builder'],
    views: projectViews,
    workflows: projectWorkflows,
    availableLabels: [{ name: 'type:feature' }, { name: 'area:ui' }],
    branch: 'main',
    head: 'abc123',
    remoteMain: 'abc123',
    statusPorcelain: '',
    branchProtection: 'unavailable-private-plan',
    issues: [],
    items: [],
    prs: [],
    ...overrides,
  };
}

test('validates the Builder production health contract', () => {
  assert.deepEqual(
    validateHealthPayload({ ok: true, environment: 'production', version: '0.1.0' }),
    { environment: 'production', version: '0.1.0' },
  );
  assert.throws(
    () => validateHealthPayload({ ok: true, environment: 'staging', version: '0.1.0' }),
    /production/,
  );
});

test('extracts unique local build assets from valid Builder HTML', () => {
  const html = `<!doctype html><html><head><title>PointSite Builder</title>
    <script type="module" src="/assets/app.js"></script>
    <link rel="stylesheet" href="/assets/app.css">
    <script src="/assets/app.js"></script>
    <script src="https://example.com/ignored.js"></script>
  </head><body><div id="root"></div></body></html>`;

  assert.doesNotThrow(() => validateHtml(html));
  assert.deepEqual(extractAssetPaths(html), ['/assets/app.js', '/assets/app.css']);
  assert.throws(
    () =>
      validateHtml(
        '<!doctype html><html><head><title>Other</title></head><body><div id="root"></div></body></html>',
      ),
    /PointSite Builder/,
  );
});

test('accepts a complete unassigned Backlog card and reports the branch-rule limitation', () => {
  const result = auditPipelineSnapshot(
    baseSnapshot({
      issues: [
        {
          number: 18,
          labels: [{ name: 'type:feature' }, { name: 'area:ui' }],
          assignees: [],
        },
      ],
      items: [
        {
          content: { type: 'Issue', number: 18 },
          status: 'Backlog',
          priority: 'P1',
          impact: 'High',
          effort: 'M',
        },
      ],
    }),
  );

  assert.deepEqual(result.errors, []);
  assert.ok(result.warnings.some((warning) => warning.includes('branch rules are unavailable')));
  assert.equal(result.activeItems.length, 0);
});

test('rejects the former Project and Backlog view names', () => {
  const result = auditPipelineSnapshot(
    baseSnapshot({
      project: { title: 'PointSite Builder Development', public: false, closed: false },
      views: ['Backlog Priorities', 'Kanban'].map((name) => ({
        name,
        layout: 'BOARD_LAYOUT',
        verticalGroupBy: 'Status',
      })),
    }),
  );

  assert.ok(result.errors.some((error) => error.includes('Project must be')));
  assert.ok(result.errors.some((error) => error.includes('Backlog must be a board view')));
  assert.ok(result.errors.some((error) => error.includes('unexpected Project views')));
});

test('accepts one In Review Issue, an exact linked PR, and ignores Dependabot PRs', () => {
  const result = auditPipelineSnapshot(
    baseSnapshot({
      branch: 'issue/42-editor-fix',
      head: 'abc123',
      remoteMain: 'def456',
      issues: [
        {
          number: 42,
          labels: [{ name: 'type:bug' }, { name: 'area:ui' }],
          assignees: [{ login: 'brimdor' }],
        },
      ],
      items: [
        {
          content: { type: 'Issue', number: 42 },
          status: 'In Review',
          priority: 'P1',
          impact: 'High',
          effort: 'S',
        },
      ],
      prs: [
        {
          number: 9,
          body: 'Refs #42',
          headRefName: 'issue/42-editor-fix',
          baseRefName: 'main',
          isDraft: false,
          statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
        },
        {
          number: 10,
          body: 'Automated update',
          headRefName: 'dependabot/npm_and_yarn/react-20',
          baseRefName: 'main',
          statusCheckRollup: [],
        },
      ],
    }),
  );

  assert.deepEqual(result.errors, []);
  assert.equal(result.activeItems.length, 1);
  assert.equal(result.pipelinePrs.length, 1);
  assert.equal(result.dependabotPrs.length, 1);
});

test('accepts one deployed In Review Issue with its merged Showcase PR', () => {
  const result = auditPipelineSnapshot(
    baseSnapshot({
      branch: 'main',
      head: 'abc123',
      remoteMain: 'abc123',
      issues: [
        {
          number: 42,
          labels: [{ name: 'type:feature' }, { name: 'area:ui' }],
          assignees: [{ login: 'brimdor' }],
        },
      ],
      items: [
        {
          content: { type: 'Issue', number: 42 },
          status: 'In Review',
          priority: 'P1',
          impact: 'High',
          effort: 'S',
        },
      ],
      prs: [
        {
          number: 9,
          body: 'Refs #42',
          state: 'MERGED',
          headRefName: 'issue/42-editor-fix',
          baseRefName: 'main',
          isDraft: false,
          statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
        },
      ],
    }),
  );

  assert.deepEqual(result.errors, []);
  assert.equal(result.activeItems.length, 1);
  assert.equal(result.pipelinePrs.length, 0);
});

test('rejects multiple active cards, incomplete metadata, and auto-closing PRs', () => {
  const result = auditPipelineSnapshot(
    baseSnapshot({
      issues: [
        {
          number: 1,
          labels: [{ name: 'type:feature' }, { name: 'area:ui' }],
          assignees: [{ login: 'brimdor' }],
        },
        {
          number: 2,
          labels: [{ name: 'type:bug' }],
          assignees: [{ login: 'brimdor' }],
        },
      ],
      items: [
        {
          content: { type: 'Issue', number: 1 },
          status: 'In Progress',
          priority: 'P1',
          impact: 'High',
          effort: 'M',
        },
        {
          content: { type: 'Issue', number: 2 },
          status: 'In Review',
          priority: 'P2',
          impact: 'Medium',
          effort: '',
        },
      ],
      prs: [
        {
          number: 3,
          body: 'Fixes #1',
          headRefName: 'issue/1-first',
          baseRefName: 'main',
          statusCheckRollup: [],
        },
      ],
    }),
  );

  assert.ok(result.errors.some((error) => error.includes('single-active-Issue violation')));
  assert.ok(result.errors.some((error) => error.includes('missing effort')));
  assert.ok(result.errors.some((error) => error.includes('at least one area label')));
  assert.ok(result.errors.some((error) => error.includes('auto-close')));
});

test('accepts explicit Pipeliner maintenance without an Issue or active card', () => {
  const result = auditPipelineSnapshot(
    baseSnapshot({
      prs: [
        {
          number: 50,
          headRefName: 'codex/adopt-pipeliner',
          baseRefName: 'main',
          body: 'Pipeliner maintenance: adoption',
          files: [{ path: 'AGENTS.md' }, { path: 'pipeliner.config.json' }],
        },
      ],
    }),
  );
  assert.deepEqual(result.errors, []);
  assert.equal(result.pipelinePrs.length, 0);
  assert.equal(result.maintenancePrs.length, 1);
});

test('does not exempt application changes disguised as Pipeliner maintenance', () => {
  const result = auditPipelineSnapshot(
    baseSnapshot({
      prs: [
        {
          number: 50,
          headRefName: 'codex/adopt-pipeliner',
          baseRefName: 'main',
          body: 'Pipeliner maintenance: adoption',
          files: [{ path: 'src/App.tsx' }],
        },
      ],
    }),
  );
  assert.ok(result.errors.some((error) => error.includes('maintenance scope')));
});

test('does not exempt unverified or ordinary unlinked PRs', () => {
  for (const headRefName of ['codex/adopt-pipeliner', 'codex/other-work']) {
    const result = auditPipelineSnapshot(
      baseSnapshot({
        prs: [
          { number: 50, headRefName, baseRefName: 'main', body: 'Pipeliner maintenance: adoption' },
        ],
      }),
    );
    assert.ok(result.errors.length > 0);
  }
});

test('checks maintenance scope beyond the first 100 changed files', () => {
  const result = auditPipelineSnapshot(
    baseSnapshot({
      prs: [
        {
          number: 50,
          headRefName: 'codex/adopt-pipeliner',
          baseRefName: 'main',
          body: 'Pipeliner maintenance: adoption',
          files: [
            ...Array.from({ length: 100 }, (_, i) => ({ path: `.agents/fixture-${i}.md` })),
            { path: 'src/App.tsx' },
          ],
        },
      ],
    }),
  );
  assert.ok(result.errors.some((error) => error.includes('maintenance scope')));
});
