import { createInstallationToken } from '../github/app-auth';
import { GitHubStagingClient } from '../github/client';
import type {
  StagingUploadInput,
  StagingUploadResult,
  StagingUploadProgress,
  StagingVerificationEvidence,
} from '../github/client';
import type { MediaService } from '../media/service';
import type { DraftRepository } from '../repositories/contracts';
import { buildCandidate } from './candidate';
import { STAGING_RENDERER_CONTRACT } from './renderer-contract';
import type { D1PublishJobStore, PublishJobRecord } from './jobs';
import type { D1PublishPreflightStore } from './preflights';
import { checksumDocument } from '../../site-kit/canonicalize';
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

type PreflightInput = Omit<PublishInput, 'expectedBaseSha'>;

interface StagingClient {
  currentMainSha(): Promise<string>;
  assertRendererCompatible(
    expectedBaseSha: string,
    contract: Record<string, string>,
  ): Promise<void>;
  advanceCommit(input: StagingUploadInput): Promise<StagingUploadResult>;
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
    private readonly preflights?: D1PublishPreflightStore,
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
    if (!this.jobs || !this.preflights) throw new Error('PUBLISH_JOBS_NOT_CONFIGURED');
    const draft = await this.repository.getDraft(draftId);
    const contractChecksum = await this.rendererContractChecksum();
    const now = new Date().toISOString();
    const [currentStagingSha, job, latestPreflight, availability] = await Promise.all([
      this.currentBaseSha(),
      this.jobs.getLatestForDraft(draftId),
      this.preflights.getLatestForDraft(draftId),
      this.jobs.availability(now),
    ]);
    const preflight = !latestPreflight
      ? { state: 'required' as const, reason: 'not-validated' as const }
      : latestPreflight.revisionId !== draft.revision.id ||
          latestPreflight.revisionChecksum !== draft.revision.checksum
        ? { state: 'required' as const, reason: 'revision-changed' as const }
        : latestPreflight.rendererContractChecksum !== contractChecksum
          ? { state: 'required' as const, reason: 'renderer-contract-changed' as const }
          : latestPreflight.status !== 'passed' || !latestPreflight.candidateChecksum
            ? { state: 'required' as const, reason: 'failed' as const }
            : {
                state: 'passed' as const,
                revisionId: latestPreflight.revisionId,
                revisionChecksum: latestPreflight.revisionChecksum,
                candidateChecksum: latestPreflight.candidateChecksum,
                validatedAt: latestPreflight.completedAt,
              };
    return {
      currentStagingSha,
      reviewUrl: 'https://staging.pointatx.org',
      preflight,
      availability,
      job: job ? this.workflowJob(job, now) : null,
    };
  }

  async preflight(input: PreflightInput) {
    if (!this.preflights) throw new Error('PREFLIGHTS_NOT_CONFIGURED');
    const draft = await this.repository.getDraft(input.draftId);
    if (draft.status !== 'active') throw new Error('DRAFT_REVISION_DRIFT');
    const contractChecksum = await this.rendererContractChecksum();
    if (
      draft.revision.id !== input.expectedRevisionId ||
      draft.revision.checksum !== input.expectedRevisionChecksum
    ) {
      await this.preflights.recordFailed({
        ...input,
        revisionId: draft.revision.id,
        revisionChecksum: draft.revision.checksum,
        rendererContractChecksum: contractChecksum,
        failureCode: 'DRAFT_REVISION_DRIFT',
      });
      throw new Error('DRAFT_REVISION_DRIFT');
    }
    const current = await this.preflights.getLatestCurrent(
      draft.id,
      draft.revision.id,
      draft.revision.checksum,
      contractChecksum,
    );
    if (current?.candidateChecksum)
      return {
        state: 'passed' as const,
        revisionId: current.revisionId,
        revisionChecksum: current.revisionChecksum,
        candidateChecksum: current.candidateChecksum,
        validatedAt: current.completedAt,
      };

    try {
      const client = await this.client();
      const baseSha = await client.currentMainSha();
      await client.assertRendererCompatible(baseSha, STAGING_RENDERER_CONTRACT);
      const candidate = await buildCandidate(draft, this.media);
      const currentDraft = await this.repository.getDraft(input.draftId);
      if (
        currentDraft.status !== 'active' ||
        currentDraft.revision.id !== input.expectedRevisionId ||
        currentDraft.revision.checksum !== input.expectedRevisionChecksum
      )
        throw new Error('DRAFT_REVISION_DRIFT');
      const passed = await this.preflights.recordPassed({
        ...input,
        revisionId: draft.revision.id,
        revisionChecksum: draft.revision.checksum,
        candidateChecksum: candidate.candidateChecksum,
        schemaVersion: draft.document.schemaVersion,
        rendererVersion: draft.document.rendererVersion,
        rendererContractChecksum: contractChecksum,
        validatedBaseSha: baseSha,
        fileCount: candidate.files.length,
      });
      return {
        state: 'passed' as const,
        revisionId: passed.revisionId,
        revisionChecksum: passed.revisionChecksum,
        candidateChecksum: passed.candidateChecksum!,
        validatedAt: passed.completedAt,
      };
    } catch (error) {
      await this.preflights.recordFailed({
        ...input,
        revisionId: draft.revision.id,
        revisionChecksum: draft.revision.checksum,
        rendererContractChecksum: contractChecksum,
        failureCode: this.preflightFailureCode(error),
      });
      throw error;
    }
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
    if (!this.jobs || !this.preflights) throw new Error('PUBLISH_JOBS_NOT_CONFIGURED');
    const draft = await this.repository.getDraft(input.draftId);
    if (
      draft.status !== 'active' ||
      draft.revision.id !== input.expectedRevisionId ||
      draft.revision.checksum !== input.expectedRevisionChecksum
    )
      throw new Error('DRAFT_REVISION_DRIFT');
    const contractChecksum = await this.rendererContractChecksum();
    const preflight = await this.preflights.getLatestCurrent(
      draft.id,
      draft.revision.id,
      draft.revision.checksum,
      contractChecksum,
    );
    if (!preflight?.candidateChecksum) throw new Error('PREFLIGHT_REQUIRED');

    const existing = await this.jobs.getByKey(input.idempotencyKey);
    if (
      existing &&
      (existing.candidateChecksum !== preflight.candidateChecksum ||
        existing.baseSha !== input.expectedBaseSha)
    )
      throw new Error('IDEMPOTENCY_CONFLICT');
    if (existing?.status === 'succeeded' && existing.resultSha && existing.externalUrl)
      return this.result(
        draft,
        existing.candidateChecksum,
        input,
        existing.resultSha,
        existing.externalUrl,
        existing.id,
      );
    const now = new Date().toISOString();
    if (
      (existing?.status === 'queued' || existing?.status === 'running') &&
      existing.leaseExpiresAt &&
      existing.leaseExpiresAt > now
    )
      return this.continuePublication(existing.id, input.actor, input.requestId);
    if (existing?.evidence.upload) {
      const reclaimed = await this.jobs.claim({
        ...input,
        candidateChecksum: existing.candidateChecksum,
        candidate: existing.candidate,
        baseSha: existing.baseSha,
      });
      return this.continuePublication(reclaimed.id, input.actor, input.requestId);
    }
    if ((await this.jobs.availability(now)).state === 'busy') throw new Error('PUBLISH_SLOT_BUSY');
    const reusable = await this.jobs.getLatestReusable(
      preflight.candidateChecksum,
      input.expectedBaseSha,
    );
    if (reusable?.status === 'succeeded' && reusable.resultSha && reusable.externalUrl)
      return this.result(
        draft,
        preflight.candidateChecksum,
        input,
        reusable.resultSha,
        reusable.externalUrl,
        reusable.id,
      );

    const client = await this.client();
    const currentBaseSha = await client.currentMainSha();
    if (currentBaseSha !== input.expectedBaseSha) throw new Error('STAGING_BASE_DRIFT');
    try {
      await client.assertRendererCompatible(currentBaseSha, STAGING_RENDERER_CONTRACT);
    } catch (error) {
      await this.recordRecheckFailure(input, draft, contractChecksum, error);
      throw error;
    }
    const candidate = await buildCandidate(draft, this.media);
    if (candidate.candidateChecksum !== preflight.candidateChecksum) {
      await this.recordRecheckFailure(
        input,
        draft,
        contractChecksum,
        new Error('PREFLIGHT_CANDIDATE_DRIFT'),
      );
      throw new Error('PREFLIGHT_CANDIDATE_DRIFT');
    }
    const currentDraft = await this.repository.getDraft(input.draftId);
    if (
      currentDraft.status !== 'active' ||
      currentDraft.revision.id !== input.expectedRevisionId ||
      currentDraft.revision.checksum !== input.expectedRevisionChecksum
    ) {
      await this.recordRecheckFailure(
        input,
        draft,
        contractChecksum,
        new Error('DRAFT_REVISION_DRIFT'),
      );
      throw new Error('DRAFT_REVISION_DRIFT');
    }
    const job: PublishJobRecord = await this.jobs.claim({
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
    return this.advance(job, input.actor, input.requestId, client, candidate);
  }

  async continuePublication(id: string, actor: string, requestId: string) {
    if (!this.jobs) throw new Error('PUBLISH_JOBS_NOT_CONFIGURED');
    const job = await this.jobs.getById(id);
    if (!job) throw new Error('PUBLISH_JOB_NOT_CLAIMABLE');
    if (job.status === 'succeeded' && job.resultSha && job.externalUrl) {
      const draft = await this.repository.getDraft(String(job.candidate.draftId));
      return this.result(
        draft,
        job.candidateChecksum,
        { expectedBaseSha: job.baseSha, actor },
        job.resultSha,
        job.externalUrl,
        job.id,
      );
    }
    return this.advance(job, actor, requestId);
  }

  private async advance(
    job: PublishJobRecord,
    actor: string,
    requestId: string,
    preparedClient?: StagingClient,
    preparedCandidate?: Awaited<ReturnType<typeof buildCandidate>>,
  ) {
    const jobs = this.jobs!;
    const draft = await this.repository.getDraft(String(job.candidate.draftId));
    if (
      draft.status !== 'active' ||
      draft.revision.id !== job.candidate.revisionId ||
      draft.revision.checksum !== job.candidate.revisionChecksum
    ) {
      await jobs.fail(job.id, actor, requestId, 'DRAFT_REVISION_DRIFT');
      throw new Error('DRAFT_REVISION_DRIFT');
    }
    const { token, job: claimed } = await jobs.acquireStep(job.id);
    try {
      const client = preparedClient ?? (await this.client());
      if (!preparedClient)
        await client.assertRendererCompatible(job.baseSha, STAGING_RENDERER_CONTRACT);
      const candidate = preparedCandidate ?? (await buildCandidate(draft, this.media));
      if (candidate.candidateChecksum !== job.candidateChecksum)
        throw new Error('PREFLIGHT_CANDIDATE_DRIFT');
      const progress: StagingUploadProgress = z
        .object({
          blobShas: z.array(z.string().regex(/^[a-f0-9]{40}$/)).max(candidate.files.length),
          commit: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/), url: z.url() }).optional(),
        })
        .parse(claimed.evidence.upload ?? { blobShas: [] });
      await jobs.guardStep(job.id, token);
      const result = await client.advanceCommit({
        expectedBaseSha: job.baseSha,
        message: `Publish builder revision ${draft.revision.sequence} to staging`,
        files: candidate.files,
        requestedAt: job.requestedAt,
        progress,
        checkpoint: (next) => jobs.checkpoint(job.id, token, next),
        guard: () => jobs.guardStep(job.id, token),
      });
      if (result.status === 'running')
        return {
          environment: 'staging' as const,
          jobId: job.id,
          status: 'running' as const,
          uploaded: result.uploaded,
          total: result.total,
          candidateChecksum: job.candidateChecksum,
        };
      await jobs.succeed(job.id, actor, requestId, result.commit);
      return this.result(
        draft,
        candidate.candidateChecksum,
        { expectedBaseSha: job.baseSha, actor },
        result.commit.sha,
        result.commit.url,
        job.id,
      );
    } catch (error) {
      await jobs.failStep(
        job.id,
        token,
        actor,
        requestId,
        error instanceof Error ? error.message.slice(0, 100) : 'UNKNOWN',
      );
      throw error;
    } finally {
      await jobs.releaseStep(job.id, token);
    }
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

  private workflowJob(job: PublishJobRecord, now = new Date().toISOString()) {
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
    const leaseExpired =
      (job.status === 'queued' || job.status === 'running') &&
      (!job.leaseExpiresAt || job.leaseExpiresAt <= now);
    return {
      id: job.id,
      status: leaseExpired ? ('cancelled' as const) : job.status,
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
      completedAt: leaseExpired ? (job.completedAt ?? job.leaseExpiresAt ?? now) : job.completedAt,
      evidence: leaseExpired
        ? { ...job.evidence, failureCode: 'PUBLISH_LEASE_EXPIRED' }
        : job.evidence,
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

  private rendererContractChecksum(): Promise<string> {
    return checksumDocument(STAGING_RENDERER_CONTRACT);
  }

  private preflightFailureCode(error: unknown): string {
    if (!(error instanceof Error)) return 'PREFLIGHT_FAILED';
    if (error.message.startsWith('STAGING_RENDERER_MISMATCH:')) return 'STAGING_RENDERER_MISMATCH';
    return /^[A-Z0-9_]{3,100}$/.test(error.message) ? error.message : 'PREFLIGHT_FAILED';
  }

  private async recordRecheckFailure(
    input: PublishInput,
    draft: Awaited<ReturnType<DraftRepository['getDraft']>>,
    rendererContractChecksum: string,
    error: unknown,
  ): Promise<void> {
    await this.preflights!.recordFailed({
      idempotencyKey: `recheck-${crypto.randomUUID()}`,
      draftId: draft.id,
      revisionId: draft.revision.id,
      revisionChecksum: draft.revision.checksum,
      rendererContractChecksum,
      failureCode: this.preflightFailureCode(error),
      actor: input.actor,
      requestId: input.requestId,
    });
  }
}
