import { Hono } from 'hono';
import { z } from 'zod';
import { CandidateTupleSchema, type D1ApprovalService } from '../approvals/service';
import { requirePublishAccess } from '../auth/roles';
import { ApiError } from '../http/errors';
import { requireMutationRequest, type SlidingWindowRateLimiter } from '../http/security';
import type { ApiVariables } from './drafts';

const ApprovalInputSchema = z.strictObject({
  publishJobId: z.string().min(1).max(100),
  expectedTuple: CandidateTupleSchema,
  decision: z.enum(['approved', 'rejected', 'revoked']),
  note: z.string().trim().max(500).optional(),
});

const EligibilitySchema = z.strictObject({
  tuple: CandidateTupleSchema,
  observedProductionBaseSha: z.string().regex(/^[a-f0-9]{40}$/),
});

const mapError = (error: unknown): never => {
  if (!(error instanceof Error)) throw error;
  const conflict = new Set([
    'APPROVAL_JOB_NOT_SUCCEEDED',
    'APPROVAL_TUPLE_MISMATCH',
    'APPROVAL_EVIDENCE_INCOMPLETE',
    'IDEMPOTENCY_CONFLICT',
  ]);
  if (conflict.has(error.message))
    throw new ApiError(
      409,
      error.message,
      'The staging candidate is not eligible for this decision',
    );
  throw error;
};

export function createApprovalRoutes(
  service: D1ApprovalService | undefined,
  limiter: SlidingWindowRateLimiter,
  productionBaseSha?: () => Promise<string>,
) {
  const routes = new Hono<{ Variables: ApiVariables }>();
  const available = () => {
    if (!service)
      throw new ApiError(503, 'APPROVALS_NOT_CONFIGURED', 'Staging acceptance is not configured');
    return service;
  };
  routes.get('/production-base', async (context) => {
    requirePublishAccess(context.get('actor'));
    if (!productionBaseSha)
      throw new ApiError(
        503,
        'PRODUCTION_BASE_UNAVAILABLE',
        'Production base lookup is unavailable',
      );
    return context.json({ sha: await productionBaseSha() });
  });
  routes.post('/', async (context) => {
    const actor = requirePublishAccess(context.get('actor'));
    if (!limiter.consume(`approval:${actor.email}`))
      throw new ApiError(429, 'RATE_LIMITED', 'Try again shortly');
    const parsed = ApprovalInputSchema.safeParse(
      await requireMutationRequest(context.req.raw, new URL(context.req.url).origin),
    );
    if (!parsed.success)
      throw new ApiError(422, 'VALIDATION_FAILED', 'Review the exact approval candidate');
    try {
      return context.json(
        await available().record({
          ...parsed.data,
          actor: actor.email,
          requestId: context.get('requestId'),
          idempotencyKey: context.req.header('idempotency-key') ?? '',
        }),
        201,
      );
    } catch (error) {
      return mapError(error);
    }
  });
  routes.post('/eligibility', async (context) => {
    requirePublishAccess(context.get('actor'));
    const parsed = EligibilitySchema.safeParse(
      await requireMutationRequest(context.req.raw, new URL(context.req.url).origin),
    );
    if (!parsed.success)
      throw new ApiError(422, 'VALIDATION_FAILED', 'Review the exact candidate identity');
    return context.json(
      await available().eligibility(parsed.data.tuple, parsed.data.observedProductionBaseSha),
    );
  });
  return routes;
}
