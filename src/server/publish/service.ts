import { createInstallationToken } from '../github/app-auth';
import { GitHubStagingClient } from '../github/client';
import type { MediaService } from '../media/service';
import type { DraftRepository } from '../repositories/contracts';
import { buildCandidate } from './candidate';
import type { D1PublishJobStore, PublishJobRecord } from './jobs';

export interface PublisherConfig {
  appId: string;
  installationId: string;
  privateKey: string;
}

interface PublishInput {
  draftId: string;
  expectedBaseSha: string;
  actor: string;
  idempotencyKey: string;
  requestId: string;
}

export class StagingPublisher {
  constructor(
    private readonly repository: DraftRepository,
    private readonly config: PublisherConfig,
    private readonly media?: MediaService,
    private readonly jobs?: D1PublishJobStore,
  ) {}

  async currentBaseSha(): Promise<string> {
    return (await this.client()).currentMainSha();
  }

  async publish(input: PublishInput) {
    const draft = await this.repository.getDraft(input.draftId);
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
          draftId: draft.id,
          revisionId: draft.revision.id,
          revisionChecksum: draft.revision.checksum,
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
      commit = await (
        await this.client()
      ).commitFiles({
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
      revisionId: draft.revision.id,
      revisionChecksum: draft.revision.checksum,
      candidateChecksum,
      baseSha: input.expectedBaseSha,
      commitSha: sha,
      url,
      ...(jobId ? { jobId } : {}),
      requestedBy: input.actor,
      status: 'succeeded' as const,
    };
  }

  private async client() {
    const token = await createInstallationToken({
      appId: this.config.appId,
      installationId: this.config.installationId,
      privateKey: this.config.privateKey,
    });
    return new GitHubStagingClient('PointCommunity/pointsite-staging', token);
  }
}
