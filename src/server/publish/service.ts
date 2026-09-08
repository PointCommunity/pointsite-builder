import { createInstallationToken } from '../github/app-auth';
import { GitHubStagingClient } from '../github/client';
import type { StagingCommit, StagingVerificationEvidence } from '../github/client';
import type { MediaService } from '../media/service';
import type { DraftRepository } from '../repositories/contracts';
import { buildCandidate } from './candidate';
import { STAGING_RENDERER_CONTRACT } from './renderer-contract';
import type { D1PublishJobStore, PublishJobRecord } from './jobs';
import { z } from 'zod';

export interface PublisherConfig {
  appId: string;
  installationId: string;
  privateKey: string;
}

interface PublishInput {
  draftId: string;
  expectedRevisionId: string;
  expectedRevisionChecksum: string;
  expectedBaseSha: string;
  actor: string;
  idempotencyKey: string;
  requestId: string;
}

interface StagingClient {
  currentMainSha(): Promise<string>;
  assertRendererCompatible(
    expectedBaseSha: string,
    contract: Record<string, string>,
  ): Promise<void>;
  commitFiles(input: {
    expectedBaseSha: string;
    message: string;
    files: Awaited<ReturnType<typeof buildCandidate>>['files'];
  }): Promise<StagingCommit>;
  verificationForCommit(commitSha: string): Promise<
    | { status: 'pending' }
    | {
        status: 'failed';
        failedChecks: string[];
        failedCheckUrls: Record<string, string>;
      }
    | { status: 'passed'; evidence: StagingVerificationEvidence }
  >;
}

export class StagingPublisher {
  constructor(
    private readonly repository: DraftRepository,
    private readonly config: PublisherConfig,
    private readonly media?: MediaService,
    private readonly jobs?: D1PublishJobStore,
    private readonly clientFactory?: () => Promise<StagingClient>,
  ) {}

  async currentBaseSha(): Promise<string> {
    return (await this.client()).currentMainSha();
  }

  async getJob(id: string) {
    if (!this.jobs) throw new Error('PUBLISH_JOBS_NOT_CONFIGURED');
    return this.jobs.getById(id);
  }

  async workflowForDraft(draftId: string) {
    if (!this.jobs) throw new Error('PUBLISH_JOBS_NOT_CONFIGURED');
    const [currentStagingSha, job] = await Promise.all([
      this.currentBaseSha(),
      this.jobs.getLatestForDraft(draftId),
    ]);
    return {
      currentStagingSha,
      reviewUrl: 'https://staging.pointatx.org',
      job: job ? this.workflowJob(job) : null,
    };
  }

  async refreshVerification(id: string, actor: string, requestId: string) {
    if (!this.jobs) throw new Error('PUBLISH_JOBS_NOT_CONFIGURED');
    const job = await this.jobs.getById(id);
    if (!job || job.status !== 'succeeded' || !job.resultSha)
      throw new Error('PUBLISH_JOB_NOT_VERIFIABLE');
    const result = await (await this.client()).verificationForCommit(job.resultSha);
    const evidence =
      result.status === 'passed'
        ? {
            ...result.evidence,
            candidateChecksum: job.candidateChecksum,
            verificationStatus: 'passed',
          }
        : {
            candidateChecksum: job.candidateChecksum,
            commitSha: job.resultSha,
            verificationStatus: result.status,
            ...(result.status === 'failed'
              ? {
                  failedChecks: result.failedChecks,
                  failedCheckUrls: result.failedCheckUrls,
                }
              : {}),
          };
    await this.jobs.recordVerification(id, actor, requestId, evidence);
    return { ...job, evidence };
  }

  async publish(input: PublishInput) {
    const draft = await this.repository.getDraft(input.draftId);
    if (
      draft.revision.id !== input.expectedRevisionId ||
      draft.revision.checksum !== input.expectedRevisionChecksum
    )
      throw new Error('DRAFT_REVISION_DRIFT');
    const client = await this.client();
    await client.assertRendererCompatible(input.expectedBaseSha, STAGING_RENDERER_CONTRACT);
    const candidate = await buildCandidate(draft, this.media);
    let job: PublishJobRecord | null = null;
    if (this.jobs) {
      job = await this.jobs.getByKey(input.idempotencyKey);
      if (
        job &&
        (job.candidateChecksum !== candidate.candidateChecksum ||
          job.baseSha !== input.expectedBaseSha)
      )
        throw new Error('IDEMPOTENCY_CONFLICT');
      job ??= await this.jobs.getLatestReusable(candidate.candidateChecksum, input.expectedBaseSha);
      if (job?.status === 'succeeded' && job.resultSha && job.externalUrl) {
        return this.result(
          draft,
          candidate.candidateChecksum,
          input,
          job.resultSha,
          job.externalUrl,
          job.id,
        );
      }
      job ??= await this.jobs.create({
        idempotencyKey: input.idempotencyKey,
        candidateChecksum: candidate.candidateChecksum,
        candidate: {
          siteId: 'pointsite',
          draftId: draft.id,
          revisionId: draft.revision.id,
          revisionChecksum: draft.revision.checksum,
          schemaVersion: draft.document.schemaVersion,
          rendererVersion: draft.document.rendererVersion,
          fileCount: candidate.files.length,
        },
        baseSha: input.expectedBaseSha,
        actor: input.actor,
        requestId: input.requestId,
      });
      await this.jobs.markRunning(job.id, input.actor, input.requestId);
    }
    let commit: { sha: string; url: string };
    try {
      commit = await client.commitFiles({
        expectedBaseSha: input.expectedBaseSha,
        message: `Publish builder revision ${draft.revision.sequence} to staging`,
        files: candidate.files,
      });
      if (job && this.jobs) await this.jobs.succeed(job.id, input.actor, input.requestId, commit);
    } catch (error) {
      if (job && this.jobs)
        await this.jobs.fail(
          job.id,
          input.actor,
          input.requestId,
          error instanceof Error ? error.message.slice(0, 100) : 'UNKNOWN',
        );
      throw error;
    }
    return this.result(draft, candidate.candidateChecksum, input, commit.sha, commit.url, job?.id);
  }

  private result(
    draft: Awaited<ReturnType<DraftRepository['getDraft']>>,
    candidateChecksum: string,
    input: Pick<PublishInput, 'expectedBaseSha' | 'actor'>,
    sha: string,
    url: string,
    jobId?: string,
  ) {
    return {
      environment: 'staging' as const,
      siteId: 'pointsite' as const,
      schemaVersion: draft.document.schemaVersion,
      rendererVersion: draft.document.rendererVersion,
      revisionId: draft.revision.id,
      revisionChecksum: draft.revision.checksum,
      candidateChecksum,
      baseSha: input.expectedBaseSha,
      stagingBaseSha: input.expectedBaseSha,
      commitSha: sha,
      url,
      ...(jobId ? { jobId } : {}),
      requestedBy: input.actor,
      status: 'succeeded' as const,
    };
  }

  private workflowJob(job: PublishJobRecord) {
    const candidate = z
      .strictObject({
        siteId: z.literal('pointsite'),
        draftId: z.uuid(),
        revisionId: z.uuid(),
        revisionChecksum: z.string().regex(/^[a-f0-9]{64}$/),
        schemaVersion: z.number().int().positive(),
        rendererVersion: z.string(),
        fileCount: z.number().int().positive().optional(),
      })
      .parse(job.candidate);
    return {
      id: job.id,
      status: job.status,
      candidateChecksum: job.candidateChecksum,
      draftId: candidate.draftId,
      revisionId: candidate.revisionId,
      revisionChecksum: candidate.revisionChecksum,
      schemaVersion: candidate.schemaVersion,
      rendererVersion: candidate.rendererVersion,
      stagingBaseSha: job.baseSha,
      stagingCommitSha: job.resultSha,
      commitUrl: job.externalUrl,
      requestedAt: job.requestedAt,
      completedAt: job.completedAt,
      evidence: job.evidence,
    };
  }

  private async client(): Promise<StagingClient> {
    if (this.clientFactory) return this.clientFactory();
    const token = await createInstallationToken({
      appId: this.config.appId,
      installationId: this.config.installationId,
      privateKey: this.config.privateKey,
    });
    return new GitHubStagingClient('PointCommunity/pointsite-staging', token);
  }
}
