// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { afterEach, describe, expect, it } from 'vitest';
import { D1ApprovalService, type CandidateTuple } from '../../src/server/approvals/service';

let miniflare: Miniflare;
afterEach(async () => miniflare?.dispose());

const tuple: CandidateTuple = {
  siteId: 'pointsite',
  revisionId: '10000000-0000-4000-8000-000000000001',
  revisionChecksum: 'a'.repeat(64),
  schemaVersion: 1,
  rendererVersion: '1.0.0',
  candidateChecksum: 'b'.repeat(64),
  stagingBaseSha: 'c'.repeat(40),
  stagingCommitSha: 'd'.repeat(40),
  productionBaseSha: 'e'.repeat(40),
};

const completeEvidence = {
  candidateChecksum: tuple.candidateChecksum,
  commitSha: tuple.stagingCommitSha,
  workflowRunId: '1234',
  workflowUrl: 'https://github.com/PointCommunity/pointsite-staging/actions/runs/1234',
  deploymentId: '5678',
  deploymentUrl: 'https://staging.example.test',
  checks: {
    build: true,
    schema: true,
    renderer: true,
    routes: true,
    assets: true,
    accessibility: true,
    responsive: true,
    security: true,
    primaryFlow: true,
    live: true,
  },
};

async function setup() {
  miniflare = new Miniflare({
    compatibilityDate: '2026-09-05',
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: { DB: crypto.randomUUID() },
  });
  const database = await miniflare.getD1Database('DB');
  for (const migration of [
    'migrations/0001_initial.sql',
    'migrations/0002_integrity_triggers.sql',
    'migrations/0003_revision_labels.sql',
    'migrations/0004_exact_approvals.sql',
  ]) {
    await database.exec((await readFile(migration, 'utf8')).replace(/\s+/g, ' ').trim());
  }
  await database
    .prepare(
      "INSERT INTO publish_jobs (id,idempotency_key,environment,status,candidate_json,candidate_checksum,repository,base_sha,result_sha,external_url,evidence_json,requested_by,requested_at,completed_at) VALUES ('job-1','publish-test-key-0001','staging','succeeded',?,?,'PointCommunity/pointsite-staging',?,?,?,?,'publisher@pointatx.org',datetime('now'),datetime('now'))",
    )
    .bind(
      JSON.stringify({
        siteId: tuple.siteId,
        revisionId: tuple.revisionId,
        revisionChecksum: tuple.revisionChecksum,
        schemaVersion: tuple.schemaVersion,
        rendererVersion: tuple.rendererVersion,
      }),
      tuple.candidateChecksum,
      tuple.stagingBaseSha,
      tuple.stagingCommitSha,
      'https://github.com/PointCommunity/pointsite-staging/commit/d',
      JSON.stringify(completeEvidence),
    )
    .run();
  return { database, service: new D1ApprovalService(database) };
}

describe('exact staging approval', () => {
  it('accepts complete exact evidence idempotently and records an immutable audit', async () => {
    const { database, service } = await setup();
    const input = {
      publishJobId: 'job-1',
      expectedTuple: tuple,
      decision: 'approved' as const,
      note: 'Staging reviewed',
      actor: 'publisher@pointatx.org',
      requestId: 'request-1',
      idempotencyKey: 'approval-test-key-0001',
    };
    const approval = await service.record(input);
    const repeated = await service.record(input);
    expect(repeated.id).toBe(approval.id);
    await expect(service.getLatestForJob('job-1')).resolves.toMatchObject({
      id: approval.id,
      publishJobId: 'job-1',
      decision: 'approved',
    });
    await expect(service.getLatestForJob('missing')).resolves.toBeNull();
    await expect(service.eligibility(tuple, tuple.productionBaseSha)).resolves.toMatchObject({
      eligible: true,
      approvalId: approval.id,
    });
    const audits = await database
      .prepare("SELECT action FROM audit_events WHERE target_type='approval'")
      .all<{ action: string }>();
    expect(audits.results).toEqual([{ action: 'approval.approved' }]);
  });

  it('fails closed for incomplete evidence, tuple drift, and production-base drift', async () => {
    const { database, service } = await setup();
    await database
      .prepare('UPDATE publish_jobs SET evidence_json=? WHERE id=?')
      .bind(
        JSON.stringify({
          ...completeEvidence,
          checks: { ...completeEvidence.checks, accessibility: false },
        }),
        'job-1',
      )
      .run();
    await expect(
      service.record({
        publishJobId: 'job-1',
        expectedTuple: tuple,
        decision: 'approved',
        actor: 'publisher@pointatx.org',
        requestId: 'request-2',
        idempotencyKey: 'approval-test-key-0002',
      }),
    ).rejects.toThrow('APPROVAL_EVIDENCE_INCOMPLETE');

    await database
      .prepare('UPDATE publish_jobs SET evidence_json=? WHERE id=?')
      .bind(JSON.stringify(completeEvidence), 'job-1')
      .run();
    await expect(
      service.record({
        publishJobId: 'job-1',
        expectedTuple: { ...tuple, rendererVersion: '1.0.1' },
        decision: 'approved',
        actor: 'publisher@pointatx.org',
        requestId: 'request-3',
        idempotencyKey: 'approval-test-key-0003',
      }),
    ).rejects.toThrow('APPROVAL_TUPLE_MISMATCH');

    await service.record({
      publishJobId: 'job-1',
      expectedTuple: tuple,
      decision: 'approved',
      actor: 'publisher@pointatx.org',
      requestId: 'request-4',
      idempotencyKey: 'approval-test-key-0004',
    });
    await expect(service.eligibility(tuple, 'f'.repeat(40))).resolves.toMatchObject({
      eligible: false,
      reason: 'PRODUCTION_BASE_DRIFT',
    });
    await expect(
      service.eligibility({ ...tuple, stagingCommitSha: '1'.repeat(40) }, tuple.productionBaseSha),
    ).resolves.toMatchObject({ eligible: false, reason: 'CANDIDATE_DRIFT' });
  });
});
