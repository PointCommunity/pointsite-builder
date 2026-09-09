import { Hono } from 'hono';
import { z } from 'zod';
import { defaultSiteDocument } from '../../site-kit/default-site';
import { SiteDocumentSchema } from '../../site-kit/schema';
import { DraftActionSchema } from '../../shared/draft-actions';
import type { Actor } from '../auth/roles';
import { requireRole } from '../auth/roles';
import { ApiError } from '../http/errors';
import { requireMutationRequest, type SlidingWindowRateLimiter } from '../http/security';
import type { DraftRepository } from '../repositories/contracts';
import { ConflictError } from '../repositories/memory';

export interface ApiVariables {
  actor: Actor;
  requestId: string;
}

const CreateDraftSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  fromRevisionId: z.uuid().optional(),
});

const SaveDraftSchema = z.strictObject({
  document: z.unknown(),
  action: DraftActionSchema,
  label: z.string().trim().max(100).optional(),
});
const ClientSchema = z.strictObject({ clientId: z.string().min(16).max(100) });
const ViewStateSchema = z.strictObject({
  draftId: z.uuid(),
  panel: z.enum(['layout', 'forms', 'library', 'preview', 'history', 'settings', 'admin']),
  pageId: z.string().max(100).nullable(),
  selectedElementId: z.string().max(100).nullable(),
  previewViewport: z.enum(['phone', 'tablet', 'desktop']),
  previewZoom: z.number().min(0.25).max(2),
  scrollPositions: z.record(z.string().max(40), z.number().min(0).max(1_000_000)),
  updatedAt: z.string(),
});
const TouchCheckoutSchema = ClientSchema.extend({ viewState: ViewStateSchema.optional() });

export const MAX_DRAFT_DOCUMENT_BYTES = 1_500_000;

function validationError(error: z.ZodError): ApiError {
  return new ApiError(
    422,
    'VALIDATION_FAILED',
    'Review the highlighted fields',
    error.issues.slice(0, 50).map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  );
}

function preconditionChecksum(value: string | undefined): string {
  const match = value?.match(/^"([a-f0-9]{64})"$/);
  if (!match?.[1]) {
    throw new ApiError(428, 'PRECONDITION_REQUIRED', 'If-Match must contain the current checksum');
  }
  return match[1];
}

export function createDraftRoutes(repository: DraftRepository, limiter: SlidingWindowRateLimiter) {
  const routes = new Hono<{ Variables: ApiVariables }>();

  routes.get('/checkouts', async (context) => {
    const actor = requireRole(context.get('actor'), 'viewer');
    return context.json({ items: await repository.listCheckoutAvailability(actor.email) });
  });

  routes.get('/checkout/owned', async (context) => {
    const actor = requireRole(context.get('actor'), 'editor');
    const checkout = await repository.ownedCheckout(actor.email);
    return context.json(
      checkout ? { draftId: checkout.draftId, expiresAt: checkout.expiresAt } : null,
    );
  });

  routes.get('/:draftId/checkout', async (context) => {
    const actor = requireRole(context.get('actor'), 'editor');
    const token = context.req.header('x-draft-checkout');
    if (!token)
      throw new ApiError(428, 'CHECKOUT_REQUIRED', 'A current draft checkout is required');
    await repository.assertCheckout(context.req.param('draftId'), actor.email, token);
    return context.json({ active: true });
  });

  routes.post('/:draftId/checkout', async (context) => {
    const actor = requireRole(context.get('actor'), 'editor');
    if (!limiter.consume(actor.email)) throw new ApiError(429, 'RATE_LIMITED', 'Try again shortly');
    const raw = await requireMutationRequest(context.req.raw, new URL(context.req.url).origin);
    const parsed = ClientSchema.safeParse(raw);
    if (!parsed.success) throw validationError(parsed.error);
    return context.json(
      await repository.acquireCheckout({
        draftId: context.req.param('draftId'),
        actor: actor.email,
        clientId: parsed.data.clientId,
        requestId: context.get('requestId'),
      }),
    );
  });

  routes.patch('/:draftId/checkout', async (context) => {
    const actor = requireRole(context.get('actor'), 'editor');
    if (!limiter.consume(actor.email)) throw new ApiError(429, 'RATE_LIMITED', 'Try again shortly');
    const raw = await requireMutationRequest(context.req.raw, new URL(context.req.url).origin);
    const parsed = TouchCheckoutSchema.safeParse(raw);
    if (!parsed.success) throw validationError(parsed.error);
    const token = context.req.header('x-draft-checkout');
    if (!token)
      throw new ApiError(428, 'CHECKOUT_REQUIRED', 'A current draft checkout is required');
    return context.json(
      await repository.touchCheckout(
        {
          draftId: context.req.param('draftId'),
          actor: actor.email,
          clientId: parsed.data.clientId,
          token,
          requestId: context.get('requestId'),
        },
        parsed.data.viewState,
      ),
    );
  });

  routes.delete('/:draftId/checkout', async (context) => {
    const actor = requireRole(context.get('actor'), 'editor');
    const raw = await requireMutationRequest(context.req.raw, new URL(context.req.url).origin);
    const parsed = ClientSchema.safeParse(raw);
    if (!parsed.success) throw validationError(parsed.error);
    const token = context.req.header('x-draft-checkout');
    if (!token)
      throw new ApiError(428, 'CHECKOUT_REQUIRED', 'A current draft checkout is required');
    await repository.releaseCheckout({
      draftId: context.req.param('draftId'),
      actor: actor.email,
      clientId: parsed.data.clientId,
      token,
      requestId: context.get('requestId'),
    });
    return context.body(null, 204);
  });

  routes.get('/', async (context) => {
    requireRole(context.get('actor'), 'viewer');
    const items = await repository.listDrafts();
    return context.json({ items, nextCursor: null });
  });

  routes.post('/', async (context) => {
    const actor = requireRole(context.get('actor'), 'editor');
    if (!limiter.consume(actor.email)) throw new ApiError(429, 'RATE_LIMITED', 'Try again shortly');
    const raw = await requireMutationRequest(context.req.raw, new URL(context.req.url).origin);
    const parsed = CreateDraftSchema.safeParse(raw);
    if (!parsed.success) throw validationError(parsed.error);
    const document = parsed.data.fromRevisionId
      ? (await repository.getRevision(parsed.data.fromRevisionId)).document
      : defaultSiteDocument;
    const draft = await repository.createDraft({
      name: parsed.data.name,
      document,
      actor: actor.email,
      idempotencyKey: context.req.header('idempotency-key') ?? '',
      requestId: context.get('requestId'),
    });
    return context.json(draft, 201);
  });

  routes.get('/:draftId', async (context) => {
    requireRole(context.get('actor'), 'viewer');
    return context.json(await repository.getDraft(context.req.param('draftId')));
  });

  routes.put('/:draftId', async (context) => {
    const actor = requireRole(context.get('actor'), 'editor');
    if (!limiter.consume(actor.email)) throw new ApiError(429, 'RATE_LIMITED', 'Try again shortly');
    const raw = await requireMutationRequest(context.req.raw, new URL(context.req.url).origin);
    const parsed = SaveDraftSchema.safeParse(raw);
    if (!parsed.success) throw validationError(parsed.error);
    if (
      new TextEncoder().encode(JSON.stringify(parsed.data.document)).byteLength >
      MAX_DRAFT_DOCUMENT_BYTES
    ) {
      throw new ApiError(
        413,
        'DOCUMENT_TOO_LARGE',
        'This draft is too large to save. Reduce its content and try again.',
      );
    }
    const document = SiteDocumentSchema.safeParse(parsed.data.document);
    if (!document.success) throw validationError(document.error);
    const checkoutToken = context.req.header('x-draft-checkout');
    if (!checkoutToken)
      throw new ApiError(428, 'CHECKOUT_REQUIRED', 'Open this draft for editing before saving');
    try {
      const draft = await repository.saveDraft({
        draftId: context.req.param('draftId'),
        expectedChecksum: preconditionChecksum(context.req.header('if-match')),
        document: document.data,
        actor: actor.email,
        idempotencyKey: context.req.header('idempotency-key') ?? '',
        requestId: context.get('requestId'),
        action: parsed.data.action,
        checkoutToken,
        label: parsed.data.label,
      });
      return context.json(draft);
    } catch (error) {
      if (error instanceof ConflictError && error.message.includes('newer revision')) {
        throw new ApiError(412, 'REVISION_CONFLICT', 'The draft has a newer revision');
      }
      throw error;
    }
  });

  return routes;
}
