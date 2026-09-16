import { authenticateRequest, createGitHubAuthenticator } from './auth/github';
import type { RoleDirectory, RoleRecord } from './auth/roles';
import type { RuntimeConfig } from './config';
import { createApp, type AppDependencies } from './index';
import { D1DraftRepository } from './repositories/d1';
import { StagingPublisher } from './publish/service';
import { D1MediaRepository, D1PrivateBucket, MediaService } from './media/service';
import { D1DraftAssets } from './media/draft-assets';
import { D1LibraryService } from './media/library';
import { D1AdminService, type NativeStorageReport } from './admin/service';
import { D1PublishJobStore } from './publish/jobs';
import { D1PublishPreflightStore } from './publish/preflights';
import { D1ApprovalService } from './approvals/service';
import { GitHubProductionReader } from './github/client';
import { RetentionService } from './maintenance/retention';
import { D1OwnershipMigration } from './maintenance/asset-migration';
import {
  PUBLICATION_WORKFLOW_REVISION,
  VERIFICATION_WORKFLOW_REVISION,
  VERIFICATION_CALLER_BLOBS,
  PUBLICATION_PRODUCTION_CALLER_BLOB,
} from './publish/renderer-contract';
import { D1PublicationVerifier } from './publish/verification';
import { dispatchPendingPublication } from './publish/dispatch';
import { D1PublicationRunner } from './publish/runner';
import { refreshProviderUsage } from './admin/provider-usage';
import { retirePublicationMetadata } from './publish/releases';
import { openRecoveryDatabase } from './maintenance/recovery-control';
import { D1DeletionReceipts } from './maintenance/deletion-receipts';
import { applySecurityHeaders } from './http/security';
import { D1ProductionPublisher } from './publish/promotion';
import { D1CloudRollback } from './publish/rollback';
import type { ProductionDraftSource } from './repositories/contracts';

interface RuntimeOptions {
  workspace: D1Database;
  recovery: D1Database;
  assets: Pick<Fetcher, 'fetch'>;
  config: RuntimeConfig;
  release: NonNullable<AppDependencies['release']>;
  feedback?: AppDependencies['feedback'];
  /** Trusted source pin, never a user request or environment override. */
  rollbackCallerBlob?: string;
  productionSource?: (target: 'staging' | 'production') => Promise<ProductionDraftSource>;
  nativeStorage?: () => Promise<NativeStorageReport>;
  sessionEpoch?: () => Promise<number>;
}

export function createBuilderRuntime(options: RuntimeOptions) {
  const { workspace, recovery, assets, config, release, feedback, rollbackCallerBlob } = options;
  let auth = config.github ? createGitHubAuthenticator(config.github) : undefined;
  let sessionEpoch: number | undefined;
  const publishing = config.github
    ? { ...config.github, workflowRevision: PUBLICATION_WORKFLOW_REVISION }
    : undefined;
  const verification = config.github
    ? { ...config.github, workflowRevision: VERIFICATION_WORKFLOW_REVISION }
    : undefined;
  return {
    async scheduled(): Promise<void> {
      const database = await openRecoveryDatabase(workspace, recovery);
      if (publishing) {
        await dispatchPendingPublication(database, publishing, fetch, config.productionEnabled);
        if (config.productionEnabled && rollbackCallerBlob) {
          await new D1CloudRollback(database, publishing, rollbackCallerBlob).dispatchPending();
        }
      }
      if (verification)
        await new D1PublicationVerifier(
          database,
          verification,
          VERIFICATION_CALLER_BLOBS,
          config.workerReadToken,
        ).dispatchPending();
      if (config.runtime === 'worker') await refreshProviderUsage(database, config.analyticsToken);
      await retirePublicationMetadata(database);
      await new D1DeletionReceipts(database, recovery).retire();
    },
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      let database = workspace;
      if (url.pathname !== '/api/health') {
        try {
          database = await openRecoveryDatabase(workspace, recovery);
        } catch {
          return applySecurityHeaders(
            Response.json(
              {
                code: 'WORKSPACE_ACCESS_UNAVAILABLE',
                message: 'Workspace access is temporarily unavailable.',
                requestId: crypto.randomUUID(),
              },
              { status: 503 },
            ),
          );
        }
      }
      if (config.github && options.sessionEpoch && url.pathname !== '/api/health') {
        const epoch = await options.sessionEpoch();
        if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error('SESSION_EPOCH_UNAVAILABLE');
        if (epoch !== sessionEpoch) {
          auth = createGitHubAuthenticator({
            ...config.github,
            sessionSecret: JSON.stringify([
              config.github.sessionSecret,
              config.builderOrigin,
              epoch,
            ]),
          });
          sessionEpoch = epoch;
        }
      }
      const deletionReceipts = new D1DeletionReceipts(database, recovery);
      const roles: RoleDirectory = {
        async getRole(email) {
          const row = await database
            .prepare('SELECT role, active FROM user_roles WHERE email = ?')
            .bind(email)
            .first<{ role: RoleRecord['role']; active: number }>();
          return row ? { role: row.role, active: row.active === 1 } : null;
        },
      };
      const legacy = new MediaService(
        new D1MediaRepository(database),
        new D1PrivateBucket(database),
      );
      const draftAssets = new D1DraftAssets(database, legacy, assets);
      const repository = new D1DraftRepository(
        database,
        draftAssets,
        config.draftStorageFormat,
        deletionReceipts,
        options.productionSource,
        config.environment !== 'local',
      );
      const media = new MediaService(
        new D1MediaRepository(database),
        new D1PrivateBucket(database),
        undefined,
        draftAssets,
        false,
      );
      const app = createApp({
        repository,
        media,
        environment: config.environment,
        version: config.appVersion,
        release,
        authenticate: (incoming) => authenticateRequest(incoming, config, roles, auth),
        readiness: async () => {
          await database.prepare('SELECT id FROM drafts LIMIT 1').first();
        },
        ...(feedback ? { feedback } : {}),
        ...(auth ? { auth } : {}),
        ...(publishing
          ? {
              publisher: new StagingPublisher(
                repository,
                publishing,
                media,
                new D1PublishJobStore(database, publishing.builderOrigin),
                new D1PublishPreflightStore(database),
              ),
              ...(config.productionEnabled
                ? {
                    production: new D1ProductionPublisher(
                      database,
                      publishing,
                      PUBLICATION_PRODUCTION_CALLER_BLOB,
                    ),
                    ...(rollbackCallerBlob
                      ? { rollback: new D1CloudRollback(database, publishing, rollbackCallerBlob) }
                      : {}),
                  }
                : {}),
            }
          : {}),
        ...(verification
          ? {
              publicationVerifier: new D1PublicationVerifier(
                database,
                verification,
                VERIFICATION_CALLER_BLOBS,
                config.workerReadToken,
              ),
            }
          : {}),
        library: new D1LibraryService(database, repository, draftAssets, deletionReceipts),
        admin: new D1AdminService(database, undefined, options.nativeStorage),
        approvals: new D1ApprovalService(database, config.github),
        productionBaseSha: () =>
          new GitHubProductionReader(fetch, config.builderOrigin).currentMainSha(),
        retention: new RetentionService(database, deletionReceipts),
        ownershipMigration: new D1OwnershipMigration(database, assets),
        ...(options.productionSource
          ? {
              publicationSourcePreview: async (target: 'staging' | 'production') =>
                (await options.productionSource!(target)).provenance,
            }
          : {}),
        publicationRunner: new D1PublicationRunner(database, undefined, config.github),
      });
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
}
