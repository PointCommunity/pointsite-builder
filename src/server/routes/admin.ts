import { Hono } from 'hono';
import { z } from 'zod';
import type { D1AdminService } from '../admin/service';
import { requireRole } from '../auth/roles';
import { ApiError } from '../http/errors';
import {
  requireMutationHeaders,
  requireMutationRequest,
  type SlidingWindowRateLimiter,
} from '../http/security';
import type { ApiVariables } from './drafts';
import type { RetentionService } from '../maintenance/retention';

const RoleInput = z.strictObject({
  githubLogin: z.string().regex(/^[A-Za-z0-9-]{1,39}$/),
  role: z.enum(['viewer', 'editor', 'publisher', 'administrator']),
  active: z.boolean(),
});
const RetentionApplyInput = z.strictObject({
  exportChecksum: z.string().regex(/^[a-f0-9]{64}$/),
});

export function createAdminRoutes(
  service: D1AdminService | undefined,
  limiter: SlidingWindowRateLimiter,
  retention?: RetentionService,
) {
  const routes = new Hono<{ Variables: ApiVariables }>();
  const available = () => {
    if (!service)
      throw new ApiError(503, 'ADMIN_NOT_CONFIGURED', 'Administration is not configured');
    return service;
  };
  routes.use('*', async (context, next) => {
    requireRole(context.get('actor'), 'administrator');
    await next();
  });
  routes.get('/roles', async (context) =>
    context.json({ items: await available().listRoles(), nextCursor: null }),
  );
  routes.put('/roles', async (context) => {
    const actor = context.get('actor');
    if (!limiter.consume(`admin:${actor.email}`))
      throw new ApiError(429, 'RATE_LIMITED', 'Try again shortly');
    requireMutationHeaders(
      context.req.raw,
      new URL(context.req.url).origin,
      'application/json',
      8_192,
    );
    const parsed = RoleInput.safeParse(await context.req.json());
    if (!parsed.success)
      throw new ApiError(
        422,
        'VALIDATION_FAILED',
        'Enter a valid GitHub username, role, and status',
        parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      );
    return context.json(
      await available().upsertRole({
        ...parsed.data,
        actor: actor.email,
        requestId: context.get('requestId'),
      }),
    );
  });
  routes.get('/audit', async (context) =>
    context.json({ items: await available().listAudit(100), nextCursor: null }),
  );
  routes.get('/capacity', async (context) => context.json(await available().capacity()));
  routes.get('/retention', async (context) => {
    if (!retention)
      throw new ApiError(
        503,
        'RETENTION_NOT_CONFIGURED',
        'Retention maintenance is not configured',
      );
    return context.json(await retention.plan());
  });
  routes.post('/retention/apply', async (context) => {
    const actor = context.get('actor');
    if (!retention)
      throw new ApiError(
        503,
        'RETENTION_NOT_CONFIGURED',
        'Retention maintenance is not configured',
      );
    const parsed = RetentionApplyInput.safeParse(
      await requireMutationRequest(context.req.raw, new URL(context.req.url).origin),
    );
    if (!parsed.success)
      throw new ApiError(422, 'VALIDATION_FAILED', 'Provide the saved retention export checksum');
    try {
      return context.json(
        await retention.applyCurrent(
          parsed.data.exportChecksum,
          actor.email,
          context.get('requestId'),
        ),
      );
    } catch (error) {
      if (error instanceof Error && error.message === 'RETENTION_EXPORT_MISMATCH')
        throw new ApiError(
          409,
          error.message,
          'Retention state changed; save a new dry-run export before applying',
        );
      throw error;
    }
  });
  return routes;
}
