import { createInstallationToken } from '../github/app-auth';
import { GitHubStagingClient } from '../github/client';
import type { DraftRepository } from '../repositories/contracts';
import { buildCandidate } from './candidate';

export interface PublisherConfig {
  appId: string;
  installationId: string;
  privateKey: string;
}

export class StagingPublisher {
  constructor(
    private readonly repository: DraftRepository,
    private readonly config: PublisherConfig,
  ) {}

  async currentBaseSha(): Promise<string> {
    return (await this.client()).currentMainSha();
  }

  async publish(input: { draftId: string; expectedBaseSha: string; actor: string }) {
    const draft = await this.repository.getDraft(input.draftId);
    const candidate = await buildCandidate(draft);
    const commit = await (
      await this.client()
    ).commitFiles({
      expectedBaseSha: input.expectedBaseSha,
      message: `Publish builder revision ${draft.revision.sequence} to staging`,
      files: candidate.files,
    });
    return {
      environment: 'staging' as const,
      revisionId: draft.revision.id,
      revisionChecksum: draft.revision.checksum,
      candidateChecksum: candidate.candidateChecksum,
      baseSha: input.expectedBaseSha,
      commitSha: commit.sha,
      url: commit.url,
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
