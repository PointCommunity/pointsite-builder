import { Hono } from 'hono';
import { AuthenticationError, type GitHubAuthenticator } from './auth/github';
import type { Actor } from './auth/roles';
import { AuthorizationError } from './auth/roles';
import { ApiError, errorResponse } from './http/errors';
import { applySecurityHeaders, SlidingWindowRateLimiter } from './http/security';
import type { DraftRepository } from './repositories/contracts';
import { ConflictError, NotFoundError } from './repositories/memory';
import { createDraftRoutes, type ApiVariables } from './routes/drafts';
import { createRevisionRoutes } from './routes/revisions';
import { createPublishRoutes } from './routes/publish';
import type { StagingPublisher } from './publish/service';
import type { MediaService } from './media/service';
import { createMediaRoutes } from './routes/media';
import { createLibraryRoutes } from './routes/library';
import type { D1LibraryService } from './media/library';
import type { D1AdminService } from './admin/service';
import { createAdminRoutes } from './routes/admin';
import type { D1ApprovalService } from './approvals/service';
import { createApprovalRoutes } from './routes/approvals';
import type { RetentionService } from './maintenance/retention';
import type { FeedbackService } from './feedback/service';
import { createFeedbackRoutes } from './routes/feedback';
import type { D1OwnershipMigration } from './maintenance/asset-migration';
import { createAssetMigrationRoutes } from './routes/asset-migration';

export interface AppDependencies {
  repository: DraftRepository;
  authenticate(request: Request): Promise<Actor>;
  environment: string;
  version: string;
  publisher?: StagingPublisher;
  media?: MediaService;
  library?: D1LibraryService;
  admin?: D1AdminService;
  approvals?: D1ApprovalService;
  productionBaseSha?: () => Promise<string>;
  retention?: RetentionService;
  auth?: GitHubAuthenticator;
  feedback?: FeedbackService;
  ownershipMigration?: D1OwnershipMigration;
}

const mutationLimiter = new SlidingWindowRateLimiter(60, 60_000);

export function createApp(dependencies: AppDependencies) {
  const app = new Hono<{ Variables: ApiVariables }>();

  app.use('/api/*', async (context, next) => {
    const requestId = crypto.randomUUID();
    context.set('requestId', requestId);
    if (context.req.path !== '/api/health') {
      context.set('actor', await dependencies.authenticate(context.req.raw));
    }
    await next();
    context.res = applySecurityHeaders(context.res);
    context.res.headers.set('x-request-id', requestId);
  });

  app.get('/api/health', (context) =>
    context.json({
      ok: true,
      environment: dependencies.environment,
      version: dependencies.version,
    }),
  );
  app.get('/api/me', (context) => context.json(context.get('actor')));
  app.get('/auth/login', (context) => {
    if (!dependencies.auth) throw new AuthenticationError();
    return dependencies.auth.beginLogin(context.req.raw);
  });
  app.get('/auth/callback', (context) => {
    if (!dependencies.auth) throw new AuthenticationError();
    return dependencies.auth.completeLogin(context.req.raw);
  });
  app.post('/auth/logout', (context) => {
    if (!dependencies.auth) throw new AuthenticationError();
    const origin = context.req.header('origin');
    const fetchSite = context.req.header('sec-fetch-site');
    if (origin !== new URL(context.req.url).origin || fetchSite !== 'same-origin')
      throw new AuthenticationError('Invalid logout request');
    return dependencies.auth.logout();
  });
  app.route(
    '/api/drafts',
    createDraftRoutes(dependencies.repository, mutationLimiter, dependencies.media),
  );
  app.route('/api/drafts', createLibraryRoutes(dependencies.library, mutationLimiter));
  app.route('/api/feedback', createFeedbackRoutes(dependencies.feedback, mutationLimiter));
  app.route('/api/drafts', createRevisionRoutes(dependencies.repository, mutationLimiter));
  app.route('/api/publish', createPublishRoutes(dependencies.publisher, dependencies.approvals));
  app.route('/api/media', createMediaRoutes(dependencies.media, mutationLimiter));
  app.route(
    '/api/admin/asset-migration',
    createAssetMigrationRoutes(dependencies.ownershipMigration),
  );
  app.route(
    '/api/admin',
    createAdminRoutes(dependencies.admin, mutationLimiter, dependencies.retention),
  );
  app.route(
    '/api/approvals',
    createApprovalRoutes(
      dependencies.approvals,
      mutationLimiter,
      dependencies.productionBaseSha,
      dependencies.publisher ? () => dependencies.publisher!.currentBaseSha() : undefined,
    ),
  );

  app.notFound(() => {
    throw new ApiError(404, 'NOT_FOUND', 'The requested API operation does not exist');
  });

  app.onError((error, context) => {
    const requestId = context.get('requestId') || crypto.randomUUID();
    const secured = (response: Response) => {
      const result = applySecurityHeaders(response);
      result.headers.set('x-request-id', requestId);
      return result;
    };
    if (error instanceof AuthenticationError) {
      return secured(errorResponse(new ApiError(401, 'UNAUTHENTICATED', error.message), requestId));
    }
    if (error instanceof AuthorizationError) {
      return secured(errorResponse(new ApiError(403, 'FORBIDDEN', error.message), requestId));
    }
    if (error instanceof NotFoundError) {
      return secured(errorResponse(new ApiError(404, 'NOT_FOUND', error.message), requestId));
    }
    if (error instanceof ConflictError) {
      return secured(errorResponse(new ApiError(409, 'CONFLICT', error.message), requestId));
    }
    if (error instanceof Error && error.message === 'PRIVATE_MEDIA_LINK') {
      return secured(
        errorResponse(
          new ApiError(
            422,
            'PRIVATE_MEDIA_LINK',
            'Upload images into the draft instead of linking to private Builder storage.',
          ),
          requestId,
        ),
      );
    }
    console.error(
      JSON.stringify({
        event: 'unexpected_request_error',
        requestId,
        name: error instanceof Error ? error.name : 'UnknownError',
        message: error instanceof Error ? error.message : 'Unknown error',
      }),
    );
    return secured(errorResponse(error, requestId));
  });

  return app;
}
