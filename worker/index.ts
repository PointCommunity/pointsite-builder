import { authenticateRequest, createGitHubAuthenticator } from '../src/server/auth/github';
import type { RoleDirectory, RoleRecord } from '../src/server/auth/roles';
import { parseConfig } from '../src/server/config';
import { createApp } from '../src/server/index';
import { D1DraftRepository } from '../src/server/repositories/d1';
import { StagingPublisher } from '../src/server/publish/service';
import { D1MediaRepository, D1PrivateBucket, MediaService } from '../src/server/media/service';
import { D1DraftAssets } from '../src/server/media/draft-assets';
import { D1LibraryService } from '../src/server/media/library';
import { D1AdminService } from '../src/server/admin/service';
import { D1PublishJobStore } from '../src/server/publish/jobs';
import { D1PublishPreflightStore } from '../src/server/publish/preflights';
import { D1ApprovalService } from '../src/server/approvals/service';
import { GitHubProductionReader } from '../src/server/github/client';
import { RetentionService } from '../src/server/maintenance/retention';
import { D1OwnershipMigration } from '../src/server/maintenance/asset-migration';
import { FeedbackService, parseFeedbackConfig } from '../src/server/feedback/service';
import {
  PUBLICATION_WORKFLOW_REVISION,
  VERIFICATION_WORKFLOW_REVISION,
  VERIFICATION_CALLER_BLOBS,
} from '../src/server/publish/renderer-contract';
import { D1PublicationVerifier } from '../src/server/publish/verification';
import { dispatchPendingPublication } from '../src/server/publish/dispatch';
import { D1PublicationRunner } from '../src/server/publish/runner';
import { refreshProviderUsage } from '../src/server/admin/provider-usage';
import { retirePublicationMetadata } from '../src/server/publish/releases';

declare const __BUILDER_SOURCE_REVISION__: string;
declare const __BUILDER_SOURCE_CLEAN__: boolean;

class D1RoleDirectory implements RoleDirectory {
  constructor(private readonly database: D1Database) {}

  async getRole(email: string): Promise<RoleRecord | null> {
    const row = await this.database
      .prepare('SELECT role, active FROM user_roles WHERE email = ?')
      .bind(email)
      .first<{ role: RoleRecord['role']; active: number }>();
    return row ? { role: row.role, active: row.active === 1 } : null;
  }
}

export default {
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const config = parseConfig(env as unknown as Record<string, unknown>);
    if (config.github) await dispatchPendingPublication(env.DB, config.github);
    if (config.github)
      await new D1PublicationVerifier(
        env.DB,
        { ...config.github, workflowRevision: VERIFICATION_WORKFLOW_REVISION },
        VERIFICATION_CALLER_BLOBS,
        config.workerReadToken,
      ).dispatchPending();
    await refreshProviderUsage(env.DB, config.analyticsToken);
    await retirePublicationMetadata(env.DB);
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    const config = parseConfig(env as unknown as Record<string, unknown>);
    const feedbackConfig =
      config.environment === 'production'
        ? parseFeedbackConfig(env as unknown as Record<string, unknown>)
        : undefined;
    const roles = new D1RoleDirectory(env.DB);
    const legacy = new MediaService(new D1MediaRepository(env.DB), new D1PrivateBucket(env.DB));
    const draftAssets = new D1DraftAssets(env.DB, legacy, env.ASSETS);
    const repository = new D1DraftRepository(env.DB, draftAssets, config.draftStorageFormat);
    const media = new MediaService(
      new D1MediaRepository(env.DB),
      new D1PrivateBucket(env.DB),
      undefined,
      draftAssets,
      false,
    );
    const auth = config.github ? createGitHubAuthenticator(config.github) : undefined;
    const app = createApp({
      repository,
      authenticate: (incomingRequest) => authenticateRequest(incomingRequest, config, roles, auth),
      environment: config.environment,
      version: config.appVersion,
      release: {
        sourceRevision: __BUILDER_SOURCE_REVISION__,
        sourceClean: __BUILDER_SOURCE_CLEAN__,
        workerVersionId: env.CF_VERSION_METADATA?.id ?? null,
        storageWriteFormat: config.draftStorageFormat,
      },
      readiness: async () => {
        await env.DB.prepare('SELECT id FROM drafts LIMIT 1').first();
      },
      ...(feedbackConfig
        ? {
            feedback: new FeedbackService(
              feedbackConfig,
              config.appVersion,
              __BUILDER_SOURCE_REVISION__,
            ),
          }
        : {}),
      ...(config.github
        ? {
            publisher: new StagingPublisher(
              repository,
              { ...config.github, workflowRevision: PUBLICATION_WORKFLOW_REVISION },
              media,
              new D1PublishJobStore(env.DB),
              new D1PublishPreflightStore(env.DB),
            ),
            publicationVerifier: new D1PublicationVerifier(
              env.DB,
              { ...config.github, workflowRevision: VERIFICATION_WORKFLOW_REVISION },
              VERIFICATION_CALLER_BLOBS,
              config.workerReadToken,
            ),
          }
        : {}),
      media,
      library: new D1LibraryService(env.DB, repository, draftAssets),
      admin: new D1AdminService(env.DB),
      approvals: new D1ApprovalService(env.DB, config.github),
      productionBaseSha: () => new GitHubProductionReader().currentMainSha(),
      retention: new RetentionService(env.DB),
      ownershipMigration: new D1OwnershipMigration(env.DB, env.ASSETS),
      publicationRunner: new D1PublicationRunner(env.DB, undefined, config.github),
      ...(auth ? { auth } : {}),
    });
    const url = new URL(request.url);
    const owner = /^\/assets\/builder\/([a-f0-9-]{36})\//.exec(url.pathname)?.[1];
    if (owner) {
      const path = url.pathname;
      url.pathname = `/api/drafts/${owner}/assets`;
      url.search = new URLSearchParams({ path }).toString();
      return app.fetch(new Request(url, request));
    }
    return app.fetch(request);
  },
};
