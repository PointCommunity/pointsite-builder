import type { JWTVerifyGetKey } from 'jose';
import { z } from 'zod';
import { publicationDestination } from './destinations';
import { checksumDocument } from '../../site-kit/canonicalize';
import { publicationMediaPaths } from '../../site-kit/publication-media';
import { SiteDocumentSchema } from '../../site-kit/schema';
import { assertNoPrivateBuilderLinks } from '../../shared/private-media-links';
import {
  readRevisionDocument,
  type StoredRevisionDocument,
} from '../repositories/revision-payloads';
import { PublicationAssetSchema } from './inputs';
import { verifyPublicationRunner, type PublicationRunnerScope } from './runner-auth';
import { createPublisherToken, githubHeaders } from '../github/app-auth';
import type { PublisherConfig } from './service';
import { PublicationBuildSchema, commitPublicationBuild, publicationJson } from './build-proof';
import { PublicationEvidenceSchema, verifyDeploymentProof } from './deployment-proof';
import { currentPromotion } from './promotion';
import { verifiedReleaseStatement } from './releases';

// Every call checks the live role, draft lifecycle, slot and signed run. The
// selected revision deliberately need not remain the editor's latest revision.
const authorizedFrom = `FROM publication_runs pr
  JOIN publication_inputs pi ON pi.job_id=pr.job_id
  JOIN publication_slots ps ON ps.job_id=pr.job_id
  JOIN publish_jobs j ON j.id=pr.job_id
  JOIN drafts d ON d.id=pi.draft_id
  JOIN user_roles u ON u.email=j.requested_by AND u.active=1
  WHERE pr.job_id=? AND d.status='active'
    AND NOT EXISTS(SELECT 1 FROM publication_verifications WHERE job_id=pr.job_id)
    AND ((ps.target='staging' AND j.environment='staging' AND u.role IN ('publisher','administrator'))
      OR (ps.target='production' AND j.environment='production-merge' AND u.role='administrator'
        AND ${currentPromotion}))`;

type RunnerRow = {
  repository: string;
  nonce: string;
  dispatch_revision: string;
  workflow_revision: string;
  target: PublicationRunnerScope['target'];
  run_id: string | null;
  run_attempt: string | null;
  check_run_id: string | null;
  requested_by: string;
  github_login: string;
  base_sha: string;
  candidate_checksum: string;
  build_json: string | null;
  deployment_json: string | null;
  deploy_authorized_at: string | null;
  result_sha: string | null;
};
type Identity = Awaited<ReturnType<typeof verifyPublicationRunner>>;

export class D1PublicationRunner {
  constructor(
    private readonly database: D1Database,
    private readonly keys?: JWTVerifyGetKey,
    private readonly config?: PublisherConfig,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async authenticate(jobId: string, token: string, finalize = false) {
    if (!z.uuid().safeParse(jobId).success) throw new Error('PUBLISH_RUNNER_UNAUTHORIZED');
    const row = await this.database
      .prepare(
        `SELECT j.repository,pr.nonce,pr.dispatch_revision,
      pi.workflow_revision,ps.target,COALESCE(pr.run_id,pr.reserved_run_id) AS run_id,
      COALESCE(pr.run_attempt,pr.reserved_run_attempt) AS run_attempt,pr.check_run_id,
      j.requested_by,u.github_login,j.base_sha,j.candidate_checksum,pr.build_json,
      pr.deployment_json,pr.deploy_authorized_at,j.result_sha ${authorizedFrom}
      AND j.status IN (${finalize ? "'running','succeeded'" : "'queued','running'"})`,
      )
      .bind(jobId)
      .first<RunnerRow>();
    if (!row) throw new Error('PUBLISH_RUNNER_UNAUTHORIZED');
    if (
      row.repository !==
      `PointCommunity/${publicationDestination(row.target, this.config?.builderOrigin).repository}`
    )
      throw new Error('PUBLISH_RUNNER_UNAUTHORIZED');
    const scope: PublicationRunnerScope = {
      builderOrigin: this.config?.builderOrigin,
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
    return { scope, identity, row };
  }

  private guard(
    scope: PublicationRunnerScope,
    identity: Identity,
    mode: 'execute' | 'claim' | 'finalize' = 'execute',
  ) {
    return this.database
      .prepare(
        `SELECT json(CASE WHEN EXISTS (SELECT 1 ${authorizedFrom}
      AND pr.nonce=? AND pr.dispatch_revision=? AND pi.workflow_revision=? AND ps.target=?
      AND pr.reserved_run_id=? AND pr.reserved_run_attempt=? AND pr.reserved_check_run_id!=?
      AND j.status IN (${mode === 'claim' ? "'queued','running'" : mode === 'finalize' ? "'running','succeeded'" : "'running'"})
      AND (${mode === 'claim' ? 'pr.run_id IS NULL OR ' : ''}(pr.run_id=? AND pr.run_attempt=? AND pr.check_run_id${mode === 'finalize' ? '!=' : '='}?))
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
        identity.runId,
        identity.runAttempt,
        identity.checkRunId,
      );
  }

  async reserve(jobId: string, token: string) {
    const { scope, identity } = await this.authenticate(jobId, token);
    await this.database.batch([
      this.database
        .prepare(
          `SELECT json(CASE WHEN EXISTS (SELECT 1 ${authorizedFrom}
        AND pr.nonce=? AND pr.dispatch_revision=? AND pi.workflow_revision=? AND ps.target=?
        AND j.status='queued' AND pr.run_id IS NULL AND (pr.reserved_run_id IS NULL OR
          (pr.reserved_run_id=? AND pr.reserved_run_attempt=? AND pr.reserved_check_run_id=?))
        ) THEN 'true' ELSE 'publication reservation no longer authorized' END)`,
        )
        .bind(
          jobId,
          scope.nonce,
          scope.dispatchRevision,
          scope.workflowRevision,
          scope.target,
          identity.runId,
          identity.runAttempt,
          identity.checkRunId,
        ),
      this.database
        .prepare(
          `UPDATE publication_runs SET reserved_run_id=?,reserved_run_attempt=?,reserved_check_run_id=?
        WHERE job_id=?`,
        )
        .bind(identity.runId, identity.runAttempt, identity.checkRunId, jobId),
    ]);
    return { reserved: true as const };
  }

  async claim(jobId: string, token: string): Promise<void> {
    const { scope, identity } = await this.authenticate(jobId, token);
    await this.database.batch([
      this.guard(scope, identity, 'claim'),
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

  private request: typeof fetch = (url, init) => {
    const fetcher = this.fetcher;
    const timeout = AbortSignal.timeout(10_000);
    return fetcher(url, {
      ...init,
      redirect: 'error',
      signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
    });
  };

  private async publisher(row: RunnerRow, signal?: AbortSignal) {
    if (!this.config) throw new Error('PUBLISH_RUNNER_NOT_CONFIGURED');
    return createPublisherToken({
      ...this.config,
      repository: publicationDestination(row.target, this.config?.builderOrigin).repository,
      subject: row.requested_by,
      login: row.github_login,
      fetcher: signal ? (url, init) => this.request(url, { ...init, signal }) : this.request,
    });
  }

  /** Bind one build before its inputs are uploaded to the public candidate branch. */
  async authorizeBuild(jobId: string, token: string, value: unknown) {
    const build = PublicationBuildSchema.parse(value);
    const { scope, identity, row } = await this.authenticate(jobId, token);
    if (build.candidateChecksum !== row.candidate_checksum)
      throw new Error('PUBLICATION_INPUT_MISMATCH');
    if (row.target === 'production') {
      const digest = await this.database
        .prepare('SELECT artifact_digest FROM publication_promotions WHERE job_id=?')
        .bind(jobId)
        .first<string>('artifact_digest');
      if (digest !== build.artifactDigest) throw new Error('PUBLICATION_OUTPUT_MISMATCH');
    }
    await this.guard(scope, identity).first();
    await this.publisher(row);
    await this.database.batch([
      this.guard(scope, identity),
      this.database
        .prepare(
          `UPDATE publication_runs SET build_json=?,
        commit_authorized_at=COALESCE(commit_authorized_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE job_id=?`,
        )
        .bind(JSON.stringify(build), jobId),
    ]);
    return { authorized: true as const };
  }

  async commitBuild(jobId: string, token: string) {
    const budget = AbortSignal.timeout(20_000);
    const { scope, identity, row } = await this.authenticate(jobId, token);
    const build = PublicationBuildSchema.parse(JSON.parse(row.build_json ?? 'null'));
    await this.guard(scope, identity).first();
    const installation = await this.publisher(row, budget);
    const assets = await this.database
      .prepare('SELECT source_path FROM publication_asset_pins WHERE job_id=? ORDER BY source_path')
      .bind(jobId)
      .all<{ source_path: string }>();
    await commitPublicationBuild({
      repository: publicationDestination(row.target, this.config?.builderOrigin).repository,
      jobId,
      baseSha: row.base_sha,
      build,
      assetPaths: assets.results.map((asset) => asset.source_path),
      token: installation,
      signal: budget,
      guard: async (signal) => {
        await this.publisher(row, signal);
        await this.guard(scope, identity).first();
      },
      fetcher: this.request,
    });
    // Record a confirmed external effect even if authority changes during the RPC.
    // This is an acknowledgment, never permission to begin the next deployment.
    await this.database
      .prepare(
        `UPDATE publish_jobs SET result_sha=?,external_url=? WHERE id=?
      AND EXISTS (SELECT 1 FROM publication_runs WHERE job_id=? AND build_json=?)`,
      )
      .bind(
        build.commitSha,
        `https://github.com/PointCommunity/${publicationDestination(row.target, this.config?.builderOrigin).repository}/commit/${build.commitSha}`,
        jobId,
        jobId,
        JSON.stringify(build),
      )
      .run();
    return { commitSha: build.commitSha };
  }

  async authorizeDeployment(jobId: string, token: string) {
    const { scope, identity, row } = await this.authenticate(jobId, token);
    const build = PublicationBuildSchema.parse(JSON.parse(row.build_json ?? 'null'));
    if (row.result_sha !== build.commitSha) throw new Error('PUBLICATION_COMMIT_UNCONFIRMED');
    await this.guard(scope, identity).first();
    const installation = await this.publisher(row);
    z.object({ object: z.object({ sha: z.literal(build.commitSha) }) }).parse(
      await publicationJson(
        await this.request(
          `https://api.github.com/repos/PointCommunity/${publicationDestination(row.target, this.config?.builderOrigin).repository}/git/ref/heads/main`,
          { headers: githubHeaders(installation) },
        ),
        16_384,
      ),
    );
    await this.database.batch([
      this.guard(scope, identity),
      this.database
        .prepare(
          `UPDATE publication_runs SET deploy_authorized_at=COALESCE(deploy_authorized_at,
        strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE job_id=?`,
        )
        .bind(jobId),
    ]);
    return { authorized: true as const };
  }

  async reportDeployment(jobId: string, token: string, value: unknown) {
    const { scope, identity, row } = await this.authenticate(jobId, token);
    const build = PublicationBuildSchema.parse(JSON.parse(row.build_json ?? 'null'));
    const deployment = z
      .strictObject({ artifactDigest: z.literal(build.artifactDigest) })
      .parse(value);
    if (!row.deploy_authorized_at || row.result_sha !== build.commitSha)
      throw new Error('PUBLICATION_DEPLOYMENT_NOT_AUTHORIZED');
    await this.database.batch([
      this.guard(scope, identity),
      this.database
        .prepare('UPDATE publication_runs SET deployment_json=? WHERE job_id=?')
        .bind(JSON.stringify(deployment), jobId),
    ]);
    return { recorded: true as const };
  }

  /** A different check in the same signed run verifies the completed deployment job. */
  async finalize(jobId: string, token: string) {
    if (await this.completedReceipt(jobId, token)) return { verified: true as const };
    try {
      const { scope, identity, row } = await this.authenticate(jobId, token, true);
      const build = PublicationBuildSchema.parse(JSON.parse(row.build_json ?? 'null'));
      const deployment = z
        .strictObject({ artifactDigest: z.literal(build.artifactDigest) })
        .parse(JSON.parse(row.deployment_json ?? 'null'));
      if (!row.deploy_authorized_at || row.result_sha !== build.commitSha || !row.check_run_id)
        throw new Error('PUBLICATION_DEPLOYMENT_NOT_AUTHORIZED');
      await this.guard(scope, identity, 'finalize').first();
      const githubToken = await this.publisher(row);
      const evidence = {
        ...(await verifyDeploymentProof(
          {
            ...deployment,
            target: scope.target,
            runId: identity.runId,
            checkRunId: row.check_run_id,
            dispatchRevision: scope.dispatchRevision,
            commitSha: build.commitSha,
            workflowRevision: scope.workflowRevision,
            candidateChecksum: build.candidateChecksum,
            artifactDigest: build.artifactDigest,
          },
          this.request,
          githubToken,
          this.config?.builderOrigin,
        )),
        verificationStatus: 'passed',
      };
      await this.database.batch([
        this.guard(scope, identity, 'finalize'),
        this.database
          .prepare(
            `INSERT INTO audit_events
        (id,occurred_at,actor,action,target_type,target_id,outcome,request_id,metadata_json)
        SELECT ?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),requested_by,'publish.verified',
        'publish-job',id,'succeeded',?,'{}' FROM publish_jobs WHERE id=? AND status='running'`,
          )
          .bind(crypto.randomUUID(), crypto.randomUUID(), jobId),
        this.database
          .prepare(
            `UPDATE publish_jobs SET status='succeeded',evidence_json=?,
        completed_at=COALESCE(completed_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id=?`,
          )
          .bind(JSON.stringify(evidence), jobId),
        verifiedReleaseStatement(this.database, jobId),
        this.database
          .prepare("DELETE FROM publication_slots WHERE target='production' AND job_id=?")
          .bind(jobId),
      ]);
      return { verified: true as const };
    } catch (error) {
      if (await this.completedReceipt(jobId, token)) return { verified: true as const };
      throw error;
    }
  }

  /** A lost finalizer response returns its recorded result without reacquiring a released slot. */
  private async completedReceipt(jobId: string, token: string) {
    const row = await this.database
      .prepare(
        `SELECT pr.nonce,pr.dispatch_revision,pr.run_id,pr.run_attempt,
      pr.check_run_id,pr.reserved_check_run_id,pi.workflow_revision,j.environment,j.evidence_json,pr.build_json
      FROM publish_jobs j JOIN publication_inputs pi ON pi.job_id=j.id
      JOIN publication_runs pr ON pr.job_id=j.id JOIN user_roles u ON u.email=j.requested_by
      WHERE j.id=? AND j.status='succeeded' AND u.active=1
        AND ((j.environment='staging' AND u.role IN ('publisher','administrator'))
          OR (j.environment='production-merge' AND u.role='administrator'))`,
      )
      .bind(jobId)
      .first<{
        nonce: string;
        dispatch_revision: string;
        run_id: string;
        run_attempt: string;
        check_run_id: string;
        reserved_check_run_id: string;
        workflow_revision: string;
        environment: string;
        evidence_json: string;
        build_json: string;
      }>();
    if (!row) return false;
    const identity = await verifyPublicationRunner(
      token,
      {
        builderOrigin: this.config?.builderOrigin,
        jobId,
        nonce: row.nonce,
        dispatchRevision: row.dispatch_revision,
        workflowRevision: row.workflow_revision,
        target: row.environment === 'staging' ? 'staging' : 'production',
        run: { id: row.run_id, attempt: row.run_attempt },
      },
      this.keys,
    );
    const evidence = PublicationEvidenceSchema.parse(JSON.parse(row.evidence_json));
    const build = PublicationBuildSchema.parse(JSON.parse(row.build_json));
    if (
      identity.checkRunId === row.check_run_id ||
      identity.checkRunId === row.reserved_check_run_id ||
      evidence.runId !== row.run_id ||
      evidence.checkRunId !== row.check_run_id ||
      evidence.dispatchRevision !== row.dispatch_revision ||
      evidence.workflowRevision !== row.workflow_revision ||
      evidence.commitSha !== build.commitSha ||
      evidence.artifactDigest !== build.artifactDigest ||
      evidence.candidateChecksum !== build.candidateChecksum
    )
      throw new Error('PUBLISH_RUNNER_UNAUTHORIZED');
    return true;
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
    const paths =
      candidate.mediaSelection === 'referenced'
        ? publicationMediaPaths(document)
        : [...new Set(document.media.map((item) => item.sourcePath))].sort();
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
