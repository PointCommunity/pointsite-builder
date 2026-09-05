import { Hono } from 'hono';
import { AuthenticationError } from './auth/access';
import type { Actor } from './auth/roles';
import { AuthorizationError } from './auth/roles';
import { ApiError, errorResponse } from './http/errors';
import { applySecurityHeaders, SlidingWindowRateLimiter } from './http/security';
import type { DraftRepository } from './repositories/contracts';
import { ConflictError, NotFoundError } from './repositories/memory';
import { createDraftRoutes, type ApiVariables } from './routes/drafts';
import { createRevisionRoutes } from './routes/revisions';

export interface AppDependencies {
  repository: DraftRepository;
  authenticate(request: Request): Promise<Actor>;
  environment: string;
  version: string;
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
  app.route('/api/drafts', createDraftRoutes(dependencies.repository, mutationLimiter));
  app.route('/api/drafts', createRevisionRoutes(dependencies.repository, mutationLimiter));

  app.notFound(() => {
    throw new ApiError(404, 'NOT_FOUND', 'The requested API operation does not exist');
  });

  app.onError((error, context) => {
    const requestId = context.get('requestId') || crypto.randomUUID();
    if (error instanceof AuthenticationError) {
      return applySecurityHeaders(
        errorResponse(new ApiError(401, 'UNAUTHENTICATED', error.message), requestId),
      );
    }
    if (error instanceof AuthorizationError) {
      return applySecurityHeaders(
        errorResponse(new ApiError(403, 'FORBIDDEN', error.message), requestId),
      );
    }
    if (error instanceof NotFoundError) {
      return applySecurityHeaders(
        errorResponse(new ApiError(404, 'NOT_FOUND', error.message), requestId),
      );
    }
    if (error instanceof ConflictError) {
      return applySecurityHeaders(
        errorResponse(new ApiError(409, 'CONFLICT', error.message), requestId),
      );
    }
    return applySecurityHeaders(errorResponse(error, requestId));
  });

  return app;
}
