import { Hono } from 'hono';
import { z } from 'zod';
import { requireRole } from '../auth/roles';
import { ApiError } from '../http/errors';
import { requireMutationRequest } from '../http/security';
import type { StagingPublisher } from '../publish/service';
import type { ApiVariables } from './drafts';

const PublishSchema = z.strictObject({
  draftId: z.uuid(),
  expectedBaseSha: z.string().regex(/^[a-f0-9]{40}$/),
});

export function createPublishRoutes(publisher?: StagingPublisher) {
  const routes = new Hono<{ Variables: ApiVariables }>();
  routes.get('/staging/base', async (context) => {
    requireRole(context.get('actor'), 'publisher');
    if (!publisher)
      throw new ApiError(503, 'PUBLISHING_NOT_CONFIGURED', 'Staging publishing is not configured');
    return context.json({ sha: await publisher.currentBaseSha() });
  });
  routes.post('/staging', async (context) => {
    const actor = requireRole(context.get('actor'), 'publisher');
    if (!publisher)
      throw new ApiError(503, 'PUBLISHING_NOT_CONFIGURED', 'Staging publishing is not configured');
    const body = PublishSchema.safeParse(
      await requireMutationRequest(context.req.raw, new URL(context.req.url).origin),
    );
    if (!body.success) throw new ApiError(422, 'VALIDATION_FAILED', 'Review the publish candidate');
    try {
      return context.json(await publisher.publish({ ...body.data, actor: actor.email }), 201);
    } catch (error) {
      if (error instanceof Error && error.message === 'STAGING_BASE_DRIFT')
        throw new ApiError(409, 'STAGING_BASE_DRIFT', 'Staging changed; refresh the candidate');
      throw error;
    }
  });
  routes.post('/production', () => {
    throw new ApiError(403, 'PRODUCTION_DISABLED', 'Production publishing is disabled');
  });
  return routes;
}
