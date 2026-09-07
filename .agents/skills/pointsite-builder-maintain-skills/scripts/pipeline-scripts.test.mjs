import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractAssetPaths,
  validateHealthPayload,
  validateHtml,
  verifyLive,
} from '../../pointsite-builder-release-production/scripts/verify-live.mjs';
import { auditPipelineSnapshot } from '../../pointsite-builder-pipeline-health/scripts/audit-pipeline.mjs';

test('validates the Builder production health contract', () => {
  assert.deepEqual(
    validateHealthPayload({ ok: true, environment: 'production', version: '0.1.0' }),
    {
      environment: 'production',
      version: '0.1.0',
    },
  );
  assert.throws(
    () => validateHealthPayload({ ok: true, environment: 'staging', version: '0.1.0' }),
    /production/,
  );
});

test('refuses to treat another environment as Builder production', async () => {
  await assert.rejects(() => verifyLive('https://staging.example.com'), /restricted/);
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

test('accepts one active Issue and its correctly linked workflow PR', () => {
  const result = auditPipelineSnapshot({
    branch: 'issue/42-editor-fix',
    head: 'abc123',
    remoteMain: 'def456',
    statusPorcelain: '',
    issues: [
      {
        number: 42,
        title: 'Fix editor',
        labels: [{ name: 'bug' }],
        assignees: [{ login: 'brimdor' }],
      },
    ],
    prs: [
      {
        number: 9,
        body: 'Refs #42',
        headRefName: 'issue/42-editor-fix',
        baseRefName: 'main',
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
  });

  assert.deepEqual(result.errors, []);
  assert.equal(result.activeIssues.length, 1);
  assert.equal(result.pipelinePrs.length, 1);
  assert.equal(result.dependabotPrs.length, 1);
});

test('rejects multiple active Issues and auto-closing workflow PRs', () => {
  const result = auditPipelineSnapshot({
    branch: 'main',
    head: 'abc123',
    remoteMain: 'abc123',
    statusPorcelain: '',
    issues: [
      {
        number: 1,
        title: 'First',
        labels: [{ name: 'enhancement' }],
        assignees: [{ login: 'brimdor' }],
      },
      {
        number: 2,
        title: 'Second',
        labels: [{ name: 'bug' }],
        assignees: [{ login: 'brimdor' }],
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
  });

  assert.ok(result.errors.some((error) => error.includes('active-Issue violation')));
  assert.ok(result.errors.some((error) => error.includes('auto-close')));
});
