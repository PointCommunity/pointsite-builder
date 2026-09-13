import { Hono } from 'hono';
import { z } from 'zod';
import { requireRole } from '../auth/roles';
import { ApiError } from '../http/errors';
import { requireMutationRequest } from '../http/security';
import { ProductionCaptureSchema, type D1ProductionPublisher } from '../publish/promotion';
import { QueuedRecoverySchema } from '../publish/recovery';
import type { ApiVariables } from './drafts';

const captureBody = ProductionCaptureSchema.pick({
  stagingJobId: true,
  approvalId: true,
  tuple: true,
});
const recoveryBody = QueuedRecoverySchema.pick({ action: true, expectedAttempts: true });

/** Production stays unavailable unless the deployment explicitly supplies its service. */
export function createProductionRoutes(production?: D1ProductionPublisher) {
  const routes = new Hono<{ Variables: ApiVariables }>();
  routes.post('/production', async (context) => {
    if (!production)
      throw new ApiError(403, 'PRODUCTION_DISABLED', 'Production publishing is disabled');
    const actor = requireRole(context.get('actor'), 'administrator');
    const input = captureBody.safeParse(
      await requireMutationRequest(context.req.raw, new URL(context.req.url).origin),
    );
    const key = ProductionCaptureSchema.shape.idempotencyKey.safeParse(
      context.req.header('idempotency-key'),
    );
    if (!input.success || !key.success)
      throw new ApiError(422, 'VALIDATION_FAILED', 'Choose the exact accepted Staging version');
    try {
      const job = await production.capture({
        ...input.data,
        actor: actor.email,
        idempotencyKey: key.data,
        requestId: context.get('requestId'),
      });
      return context.json(job, job.status === 'queued' || job.status === 'running' ? 202 : 200);
    } catch (error) {
      throw productionError(error);
    }
  });
  routes.post('/production/jobs/:jobId/recovery', async (context) => {
    if (!production)
      throw new ApiError(403, 'PRODUCTION_DISABLED', 'Production publishing is disabled');
    const actor = requireRole(context.get('actor'), 'administrator');
    const input = recoveryBody.safeParse(
      await requireMutationRequest(context.req.raw, new URL(context.req.url).origin),
    );
    const key = QueuedRecoverySchema.shape.idempotencyKey.safeParse(
      context.req.header('idempotency-key'),
    );
    const jobId = z.uuid().safeParse(context.req.param('jobId'));
    if (!input.success || !key.success || !jobId.success)
      throw new ApiError(422, 'VALIDATION_FAILED', 'Choose the Production publication to recover');
    try {
      return context.json(
        await production.recoverQueued({
          ...input.data,
          jobId: jobId.data,
          actor: actor.email,
          idempotencyKey: key.data,
          requestId: context.get('requestId'),
        }),
      );
    } catch (error) {
      throw productionError(error);
    }
  });
  return routes;
}

function productionError(error: unknown) {
  const code = error instanceof Error ? error.message : '';
  if (
    [
      'PRODUCTION_AUTHORITY_CHANGED',
      'PUBLISH_AUTHORITY_CHANGED',
      'PUBLISH_GITHUB_AUTHORITY_CHANGED',
    ].includes(code)
  )
    return new ApiError(
      403,
      code,
      'Your Production publishing authority changed; refresh your session',
    );
  if (
    [
      'PRODUCTION_ACCEPTANCE_CHANGED',
      'PRODUCTION_INPUTS_UNAVAILABLE',
      'PRODUCTION_CAPTURE_CHANGED',
      'PUBLICATION_RECOVERY_CHANGED',
      'PUBLICATION_RUNTIME_UNAVAILABLE',
      'PUBLICATION_RUN_NOT_TERMINAL',
      'PUBLICATION_VERIFICATION_UNCONFIRMED',
      'IDEMPOTENCY_CONFLICT',
    ].includes(code)
  )
    return new ApiError(409, code, 'Publication state changed; refresh before trying again');
  return new ApiError(
    503,
    'PRODUCTION_UNAVAILABLE',
    'Production status could not be confirmed; refresh before trying again',
  );
}
