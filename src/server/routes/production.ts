import { Hono } from 'hono';
import { z } from 'zod';
import { requireRole } from '../auth/roles';
import { ApiError } from '../http/errors';
import { requireMutationRequest } from '../http/security';
import { ProductionCaptureSchema, type D1ProductionPublisher } from '../publish/promotion';
import { QueuedRecoverySchema } from '../publish/recovery';
import type { ApiVariables } from './drafts';
import { RollbackCaptureSchema, type D1CloudRollback } from '../publish/rollback';

const captureBody = ProductionCaptureSchema.pick({
  stagingJobId: true,
  approvalId: true,
  tuple: true,
});
const recoveryBody = QueuedRecoverySchema.pick({ action: true, expectedAttempts: true });

/** Production stays unavailable unless the deployment explicitly supplies its service. */
export function createProductionRoutes(
  production?: D1ProductionPublisher,
  rollback?: D1CloudRollback,
) {
  const routes = new Hono<{ Variables: ApiVariables }>();
  routes.get('/production/rollback', async (context) => {
    const actor = requireRole(context.get('actor'), 'administrator');
    context.header('Cache-Control', 'no-store');
    if (!rollback) return context.json({ enabled: false });
    try {
      return context.json({ enabled: true, ...(await rollback.workflow(actor.email)) });
    } catch (error) {
      throw productionError(error);
    }
  });
  routes.post('/production/rollback/prepare', async (context) => {
    const actor = requireRole(context.get('actor'), 'administrator');
    if (!rollback)
      throw new ApiError(403, 'PRODUCTION_DISABLED', 'Production rollback is disabled');
    z.strictObject({}).parse(
      await requireMutationRequest(context.req.raw, new URL(context.req.url).origin),
    );
    try {
      return context.json(await rollback.prepare(actor.email));
    } catch (error) {
      throw productionError(error);
    }
  });
  routes.post('/production/rollback', async (context) => {
    const actor = requireRole(context.get('actor'), 'administrator');
    if (!rollback)
      throw new ApiError(403, 'PRODUCTION_DISABLED', 'Production rollback is disabled');
    const body = RollbackCaptureSchema.omit({
      actor: true,
      idempotencyKey: true,
      requestId: true,
    }).safeParse(await requireMutationRequest(context.req.raw, new URL(context.req.url).origin));
    const key = RollbackCaptureSchema.shape.idempotencyKey.safeParse(
      context.req.header('idempotency-key'),
    );
    if (!body.success || !key.success)
      throw new ApiError(
        422,
        'VALIDATION_FAILED',
        'Choose the exact Production release to restore',
      );
    try {
      return context.json(
        await rollback.capture({
          ...body.data,
          actor: actor.email,
          idempotencyKey: key.data,
          requestId: context.get('requestId'),
        }),
        202,
      );
    } catch (error) {
      throw productionError(error);
    }
  });
  routes.post('/production/rollback/:jobId/recovery', async (context) => {
    const actor = requireRole(context.get('actor'), 'administrator');
    if (!rollback)
      throw new ApiError(403, 'PRODUCTION_DISABLED', 'Production rollback is disabled');
    const body = z
      .strictObject({ action: z.enum(['cancel', 'verify']) })
      .safeParse(await requireMutationRequest(context.req.raw, new URL(context.req.url).origin));
    const id = z.uuid().safeParse(context.req.param('jobId'));
    if (!body.success || !id.success)
      throw new ApiError(422, 'VALIDATION_FAILED', 'Choose the rollback to reconcile');
    try {
      return context.json(await rollback.recover(id.data, actor.email, body.data.action));
    } catch (error) {
      throw productionError(error);
    }
  });
  routes.get('/production/workflow', async (context) => {
    const actor = requireRole(context.get('actor'), 'administrator');
    const draftId = z.uuid().safeParse(context.req.query('draftId'));
    if (!draftId.success)
      throw new ApiError(422, 'VALIDATION_FAILED', 'Choose the draft publication to inspect');
    context.header('Cache-Control', 'no-store');
    if (!production) return context.json({ enabled: false });
    try {
      return context.json({
        enabled: true,
        ...(await production.workflowForDraft(draftId.data, actor.email)),
      });
    } catch (error) {
      throw productionError(error);
    }
  });
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
      'ROLLBACK_CAPTURE_CHANGED',
      'ROLLBACK_STATE_CHANGED',
      'ROLLBACK_SOURCE_UNAVAILABLE',
      'ROLLBACK_RECOVERY_CHANGED',
    ].includes(code)
  )
    return new ApiError(409, code, 'Publication state changed; refresh before trying again');
  return new ApiError(
    503,
    'PRODUCTION_UNAVAILABLE',
    'Production status could not be confirmed; refresh before trying again',
  );
}
