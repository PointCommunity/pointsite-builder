import type { JWTVerifyGetKey } from 'jose';
import { z } from 'zod';
import { checksumDocument } from '../../site-kit/canonicalize';
import { SiteDocumentSchema } from '../../site-kit/schema';
import { assertNoPrivateBuilderLinks } from '../../shared/private-media-links';
import {
  readRevisionDocument,
  type StoredRevisionDocument,
} from '../repositories/revision-payloads';
import { PublicationAssetSchema } from './inputs';
import { verifyPublicationRunner, type PublicationRunnerScope } from './runner-auth';

// Every call checks the live role, draft lifecycle, slot and signed run. The
// selected revision deliberately need not remain the editor's latest revision.
const authorizedFrom = `FROM publication_runs pr
  JOIN publication_inputs pi ON pi.job_id=pr.job_id
  JOIN publication_slots ps ON ps.job_id=pr.job_id
  JOIN publish_jobs j ON j.id=pr.job_id
  JOIN drafts d ON d.id=pi.draft_id
  JOIN user_roles u ON u.email=j.requested_by AND u.active=1
  WHERE pr.job_id=? AND d.status='active' AND j.status IN ('queued','running')
    AND ((ps.target='staging' AND j.environment='staging' AND u.role IN ('publisher','administrator'))
      OR (ps.target='production' AND j.environment='production-merge' AND u.role='administrator'))`;

type RunnerRow = {
  nonce: string;
  dispatch_revision: string;
  workflow_revision: string;
  target: PublicationRunnerScope['target'];
  run_id: string | null;
  run_attempt: string | null;
  check_run_id: string | null;
};
type Identity = Awaited<ReturnType<typeof verifyPublicationRunner>>;

export class D1PublicationRunner {
  constructor(
    private readonly database: D1Database,
    private readonly keys?: JWTVerifyGetKey,
  ) {}

  private async authenticate(jobId: string, token: string) {
    if (!z.uuid().safeParse(jobId).success) throw new Error('PUBLISH_RUNNER_UNAUTHORIZED');
    const row = await this.database
      .prepare(
        `SELECT pr.nonce,pr.dispatch_revision,
      pi.workflow_revision,ps.target,pr.run_id,pr.run_attempt,pr.check_run_id ${authorizedFrom}`,
      )
      .bind(jobId)
      .first<RunnerRow>();
    if (!row) throw new Error('PUBLISH_RUNNER_UNAUTHORIZED');
    const scope: PublicationRunnerScope = {
      jobId,
      nonce: row.nonce,
      dispatchRevision: row.dispatch_revision,
      workflowRevision: row.workflow_revision,
      target: row.target,
      ...(row.run_id && row.run_attempt
        ? { run: { id: row.run_id, attempt: row.run_attempt } }
        : {}),
    };
    const identity = await verifyPublicationRunner(token, scope, this.keys);
    return { scope, identity };
  }

  private guard(scope: PublicationRunnerScope, identity: Identity, claim = false) {
    return this.database
      .prepare(
        `SELECT json(CASE WHEN EXISTS (SELECT 1 ${authorizedFrom}
      AND pr.nonce=? AND pr.dispatch_revision=? AND pi.workflow_revision=? AND ps.target=?
      AND (${claim ? 'pr.run_id IS NULL OR ' : ''}(pr.run_id=? AND pr.run_attempt=? AND pr.check_run_id=?))
    ) THEN 'true' ELSE 'publication runner no longer authorized' END)`,
      )
      .bind(
        scope.jobId,
        scope.nonce,
        scope.dispatchRevision,
        scope.workflowRevision,
        scope.target,
        identity.runId,
        identity.runAttempt,
        identity.checkRunId,
      );
  }

  async claim(jobId: string, token: string): Promise<void> {
    const { scope, identity } = await this.authenticate(jobId, token);
    await this.database.batch([
      this.guard(scope, identity, true),
      this.database
        .prepare(
          `INSERT INTO audit_events
        (id,occurred_at,actor,action,target_type,target_id,outcome,request_id,metadata_json)
        SELECT ?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),requested_by,'publish.runner-claimed',
          'publish-job',id,'succeeded',?,'{}' FROM publish_jobs WHERE id=? AND status='queued'`,
        )
        .bind(crypto.randomUUID(), crypto.randomUUID(), jobId),
      this.database
        .prepare(
          `UPDATE publication_runs SET run_id=?,run_attempt=?,check_run_id=?,
        claimed_at=COALESCE(claimed_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE job_id=?`,
        )
        .bind(identity.runId, identity.runAttempt, identity.checkRunId, jobId),
      this.database
        .prepare("UPDATE publish_jobs SET status='running' WHERE id=? AND status='queued'")
        .bind(jobId),
    ]);
  }

  async inputs(jobId: string, token: string) {
    const { scope, identity } = await this.authenticate(jobId, token);
    const result = await this.database.batch([
      this.guard(scope, identity),
      this.database
        .prepare(
          `SELECT r.id,r.draft_id,r.checksum,r.document_json,j.candidate_json,
        j.candidate_checksum,j.base_sha,j.requested_at FROM publication_inputs pi
        JOIN revisions r ON r.id=pi.revision_id AND r.draft_id=pi.draft_id
        JOIN publish_jobs j ON j.id=pi.job_id WHERE pi.job_id=?`,
        )
        .bind(jobId),
      this.database
        .prepare(
          `SELECT v.id AS assetId,p.source_path AS sourcePath,v.checksum,
        v.byte_size AS byteSize,v.content_type AS contentType FROM publication_asset_pins p
        JOIN draft_asset_versions v ON v.id=p.asset_id AND v.draft_id=p.draft_id
        WHERE p.job_id=? ORDER BY p.source_path`,
        )
        .bind(jobId),
    ]);
    const row = result[1].results[0] as
      | (StoredRevisionDocument & {
          candidate_json: string;
          candidate_checksum: string;
          base_sha: string;
          requested_at: string;
        })
      | undefined;
    if (!row) throw new Error('PUBLICATION_INPUT_MISMATCH');
    const document = SiteDocumentSchema.parse(await readRevisionDocument(this.database, row));
    assertNoPrivateBuilderLinks(document);
    const assets = z.array(PublicationAssetSchema).max(500).parse(result[2].results);
    const candidate = z
      .record(z.string(), z.union([z.string(), z.number()]))
      .parse(JSON.parse(row.candidate_json));
    const paths = [...new Set(document.media.map((item) => item.sourcePath))].sort();
    if (
      (await checksumDocument(document)) !== row.checksum ||
      (await checksumDocument({ ...candidate, assets })) !== row.candidate_checksum ||
      paths.length !== assets.length ||
      assets.some((asset, index) => asset.sourcePath !== paths[index])
    )
      throw new Error('PUBLICATION_INPUT_MISMATCH');
    // Decoding may take further queries. Recheck authority before returning data.
    await this.guard(scope, identity).first();
    return {
      candidate,
      candidateChecksum: row.candidate_checksum,
      document,
      assets,
      baseSha: row.base_sha,
      requestedAt: row.requested_at,
    };
  }

  async chunk(jobId: string, token: string, assetId: string, index: number): Promise<ArrayBuffer> {
    z.uuid().parse(assetId);
    z.number().int().min(0).max(5).parse(index);
    const { scope, identity } = await this.authenticate(jobId, token);
    const result = await this.database.batch([
      this.guard(scope, identity),
      this.database
        .prepare(
          `SELECT c.bytes,c.byte_size FROM publication_asset_pins p
        JOIN draft_asset_chunks c ON c.asset_id=p.asset_id
        WHERE p.job_id=? AND p.asset_id=? AND c.chunk_index=?`,
        )
        .bind(jobId, assetId, index),
    ]);
    const chunk = result[1].results[0] as { bytes: number[]; byte_size: number } | undefined;
    if (
      !chunk ||
      chunk.byte_size < 1 ||
      chunk.byte_size > 1_000_000 ||
      chunk.bytes.length !== chunk.byte_size
    )
      throw new Error('PUBLICATION_ASSET_MISSING');
    return Uint8Array.from(chunk.bytes).buffer;
  }
}
