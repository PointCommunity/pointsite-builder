import { Hono } from 'hono';
import { z } from 'zod';
import { requireRole } from '../auth/roles';
import { ApiError } from '../http/errors';
import { requireMutationRequest, type SlidingWindowRateLimiter } from '../http/security';
import type { DraftRepository } from '../repositories/contracts';
import type { ApiVariables } from './drafts';

const LabelSchema = z.strictObject({ label: z.string().trim().min(1).max(100) });
const RestoreSchema = z.strictObject({
  revisionId: z.uuid(),
  expectedChecksum: z.string().regex(/^[a-f0-9]{64}$/),
});
const LifecycleSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(100).optional(),
    status: z.enum(['active', 'archived']).optional(),
  })
  .refine((value) => value.name || value.status, 'A name or status change is required');

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ApiError(
      422,
      'VALIDATION_FAILED',
      'Review the highlighted fields',
      result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }
  return result.data;
}

export function createRevisionRoutes(
  repository: DraftRepository,
  limiter: SlidingWindowRateLimiter,
) {
  const routes = new Hono<{ Variables: ApiVariables }>();

  routes.get('/:draftId/revisions', async (context) => {
    requireRole(context.get('actor'), 'viewer');
    const items = await repository.listRevisions(context.req.param('draftId'));
    return context.json({ items, nextCursor: null });
  });

  routes.patch('/:draftId/revisions/:revisionId', async (context) => {
    const actor = requireRole(context.get('actor'), 'editor');
    if (!limiter.consume(actor.email)) throw new ApiError(429, 'RATE_LIMITED', 'Try again shortly');
    const body = parse(
      LabelSchema,
      await requireMutationRequest(context.req.raw, new URL(context.req.url).origin),
    );
    return context.json(
      await repository.labelRevision(
        context.req.param('draftId'),
        context.req.param('revisionId'),
        body.label,
        actor.email,
        context.get('requestId'),
      ),
    );
  });

  routes.post('/:draftId/restore', async (context) => {
    const actor = requireRole(context.get('actor'), 'editor');
    if (!limiter.consume(actor.email)) throw new ApiError(429, 'RATE_LIMITED', 'Try again shortly');
    const body = parse(
      RestoreSchema,
      await requireMutationRequest(context.req.raw, new URL(context.req.url).origin),
    );
    return context.json(
      await repository.restoreRevision({
        draftId: context.req.param('draftId'),
        revisionId: body.revisionId,
        expectedChecksum: body.expectedChecksum,
        actor: actor.email,
        idempotencyKey: context.req.header('idempotency-key') ?? '',
        requestId: context.get('requestId'),
      }),
    );
  });

  routes.patch('/:draftId', async (context) => {
    const actor = requireRole(context.get('actor'), 'editor');
    if (!limiter.consume(actor.email)) throw new ApiError(429, 'RATE_LIMITED', 'Try again shortly');
    const body = parse(
      LifecycleSchema,
      await requireMutationRequest(context.req.raw, new URL(context.req.url).origin),
    );
    let draft = await repository.getDraft(context.req.param('draftId'));
    if (body.status) {
      draft = await repository.setDraftStatus(
        draft.id,
        body.status,
        actor.email,
        context.get('requestId'),
      );
    }
    if (body.name) {
      draft = await repository.renameDraft(
        draft.id,
        body.name,
        actor.email,
        context.get('requestId'),
      );
    }
    return context.json(draft);
  });

  routes.delete('/:draftId', async (context) => {
    const actor = requireRole(context.get('actor'), 'editor');
    if (!limiter.consume(actor.email)) throw new ApiError(429, 'RATE_LIMITED', 'Try again shortly');
    await requireMutationRequest(context.req.raw, new URL(context.req.url).origin);
    return context.json(
      await repository.setDraftStatus(
        context.req.param('draftId'),
        'deleted',
        actor.email,
        context.get('requestId'),
      ),
    );
  });

  return routes;
}
