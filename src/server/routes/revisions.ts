import { Hono } from 'hono';
import { z } from 'zod';
import { DELETE_DRAFT_CONFIRMATION } from '../../shared/draft-lifecycle';
import { requireRole } from '../auth/roles';
import { ApiError } from '../http/errors';
import { requireMutationRequest, type SlidingWindowRateLimiter } from '../http/security';
import type { DraftRepository } from '../repositories/contracts';
import { ConflictError } from '../repositories/memory';
import { draftMutationProof, type ApiVariables } from './drafts';

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
  .refine((value) => Boolean(value.name) !== Boolean(value.status), 'Change either name or status');
const DeleteDraftSchema = z.strictObject({
  confirmation: z.literal(DELETE_DRAFT_CONFIRMATION),
});

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
        draftMutationProof(context.req.raw),
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
    const proof = draftMutationProof(context.req.raw);
    if (body.expectedChecksum !== proof.expectedChecksum)
      throw new ApiError(422, 'VALIDATION_FAILED', 'Expected checksum must match If-Match');
    try {
      return context.json(
        await repository.restoreRevision({
          draftId: context.req.param('draftId'),
          revisionId: body.revisionId,
          ...proof,
          actor: actor.email,
          idempotencyKey: context.req.header('idempotency-key') ?? '',
          requestId: context.get('requestId'),
        }),
      );
    } catch (error) {
      if (error instanceof ConflictError && error.message.includes('newer revision'))
        throw new ApiError(412, 'REVISION_CONFLICT', 'The draft has a newer revision');
      throw error;
    }
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
        draftMutationProof(context.req.raw),
      );
    }
    if (body.name) {
      draft = await repository.renameDraft(
        draft.id,
        body.name,
        actor.email,
        context.get('requestId'),
        draftMutationProof(context.req.raw),
      );
    }
    return context.json(draft);
  });

  routes.delete('/:draftId', async (context) => {
    const actor = requireRole(context.get('actor'), 'editor');
    if (!limiter.consume(actor.email)) throw new ApiError(429, 'RATE_LIMITED', 'Try again shortly');
    parse(
      DeleteDraftSchema,
      await requireMutationRequest(context.req.raw, new URL(context.req.url).origin),
    );
    const draft = await repository.getDraft(context.req.param('draftId'));
    if (draft.status !== 'archived') {
      throw new ConflictError('Only archived drafts can be deleted');
    }
    return context.json(
      await repository.purgeDraft(
        draft.id,
        actor.email,
        context.get('requestId'),
        draftMutationProof(context.req.raw),
      ),
    );
  });

  return routes;
}
