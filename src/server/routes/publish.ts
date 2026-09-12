import { Hono } from 'hono';
import { z } from 'zod';
import { requirePublishAccess } from '../auth/roles';
import { ApiError } from '../http/errors';
import { requireMutationRequest } from '../http/security';
import type { StagingPublisher } from '../publish/service';
import type { D1ApprovalService } from '../approvals/service';
import type { ApiVariables } from './drafts';

const PublishSchema = z.strictObject({
  draftId: z.uuid(),
  expectedRevisionId: z.uuid(),
  expectedRevisionChecksum: z.string().regex(/^[a-f0-9]{64}$/),
  expectedBaseSha: z.string().regex(/^[a-f0-9]{40}$/),
});

const WorkflowQuerySchema = z.strictObject({ draftId: z.uuid() });
const PreflightSchema = PublishSchema.omit({ expectedBaseSha: true });

export function createPublishRoutes(publisher?: StagingPublisher, approvals?: D1ApprovalService) {
  const routes = new Hono<{ Variables: ApiVariables }>();
  routes.get('/staging/base', async (context) => {
    requirePublishAccess(context.get('actor'));
    if (!publisher)
      throw new ApiError(503, 'PUBLISHING_NOT_CONFIGURED', 'Staging publishing is not configured');
    return context.json({ sha: await publisher.currentBaseSha() });
  });
  routes.get('/staging/workflow', async (context) => {
    requirePublishAccess(context.get('actor'));
    if (!publisher)
      throw new ApiError(503, 'PUBLISHING_NOT_CONFIGURED', 'Staging publishing is not configured');
    const query = WorkflowQuerySchema.safeParse(context.req.query());
    if (!query.success) throw new ApiError(422, 'VALIDATION_FAILED', 'Choose a valid draft');
    const workflow = await publisher.workflowForDraft(query.data.draftId);
    const approval =
      workflow.job && approvals ? await approvals.getLatestForJob(workflow.job.id) : null;
    return context.json({
      ...workflow,
      approval: approval
        ? {
            id: approval.id,
            publishJobId: approval.publishJobId,
            decision: approval.decision,
            createdAt: approval.createdAt,
          }
        : null,
    });
  });
  routes.post('/staging', async (context) => {
    const actor = requirePublishAccess(context.get('actor'));
    if (!publisher)
      throw new ApiError(503, 'PUBLISHING_NOT_CONFIGURED', 'Staging publishing is not configured');
    const body = PublishSchema.safeParse(
      await requireMutationRequest(context.req.raw, new URL(context.req.url).origin),
    );
    if (!body.success) throw new ApiError(422, 'VALIDATION_FAILED', 'Review the publish candidate');
    try {
      const result = await publisher.publish({
        ...body.data,
        actor: actor.email,
        idempotencyKey: context.req.header('idempotency-key') ?? '',
        requestId: context.get('requestId'),
      });
      return context.json(result, result.status === 'running' ? 202 : 201);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('STAGING_RENDERER_MISMATCH:'))
        throw new ApiError(
          409,
          'STAGING_RENDERER_MISMATCH',
          'Staging renderer differs from Builder; ask a site maintainer to sync it before publishing',
        );
      if (error instanceof Error && error.message === 'STAGING_BASE_DRIFT')
        throw new ApiError(409, 'STAGING_BASE_DRIFT', 'Staging changed; refresh the candidate');
      if (error instanceof Error && error.message === 'IDEMPOTENCY_CONFLICT')
        throw new ApiError(
          409,
          'IDEMPOTENCY_CONFLICT',
          'This publish retry belongs to a different candidate',
        );
      if (error instanceof Error && error.message === 'DRAFT_REVISION_DRIFT')
        throw new ApiError(
          409,
          'DRAFT_REVISION_DRIFT',
          'The draft changed; reopen publishing for the latest saved revision',
        );
      if (
        error instanceof Error &&
        (error.message === 'PUBLISH_JOB_NOT_CLAIMABLE' ||
          error.message === 'PUBLISH_SLOT_BUSY' ||
          error.message === 'PUBLISH_STEP_UNAVAILABLE')
      )
        throw new ApiError(
          409,
          'PUBLISH_SLOT_BUSY',
          'Staging is currently in use; your draft remains safe and no publication was queued',
        );
      if (error instanceof Error && error.message === 'PREFLIGHT_REQUIRED')
        throw new ApiError(
          409,
          'PREFLIGHT_REQUIRED',
          'Run the private preflight for this exact saved revision before publishing',
        );
      if (error instanceof Error && error.message === 'PREFLIGHT_CANDIDATE_DRIFT')
        throw new ApiError(
          409,
          'PREFLIGHT_CANDIDATE_DRIFT',
          'The private candidate check is no longer current; run it again',
        );
      throw error;
    }
  });
  routes.post('/staging/preflight', async (context) => {
    const actor = requirePublishAccess(context.get('actor'));
    if (!publisher)
      throw new ApiError(503, 'PUBLISHING_NOT_CONFIGURED', 'Staging publishing is not configured');
    const body = PreflightSchema.safeParse(
      await requireMutationRequest(context.req.raw, new URL(context.req.url).origin),
    );
    if (!body.success)
      throw new ApiError(422, 'VALIDATION_FAILED', 'Review the private preflight candidate');
    try {
      return context.json(
        await publisher.preflight({
          ...body.data,
          actor: actor.email,
          idempotencyKey: context.req.header('idempotency-key') ?? '',
          requestId: context.get('requestId'),
        }),
        201,
      );
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('STAGING_RENDERER_MISMATCH:'))
        throw new ApiError(
          409,
          'STAGING_RENDERER_MISMATCH',
          'Staging renderer differs from Builder; ask a site maintainer to sync it before publishing',
        );
      if (error instanceof Error && error.message === 'DRAFT_REVISION_DRIFT')
        throw new ApiError(
          409,
          'DRAFT_REVISION_DRIFT',
          'The draft changed; reopen publishing for the latest saved revision',
        );
      if (error instanceof Error && error.message === 'IDEMPOTENCY_CONFLICT')
        throw new ApiError(
          409,
          'IDEMPOTENCY_CONFLICT',
          'This private preflight retry belongs to a different candidate',
        );
      throw error;
    }
  });
  routes.get('/jobs/:jobId', async (context) => {
    requirePublishAccess(context.get('actor'));
    if (!publisher)
      throw new ApiError(503, 'PUBLISHING_NOT_CONFIGURED', 'Staging publishing is not configured');
    const job = await publisher.getJob(context.req.param('jobId'));
    if (!job) throw new ApiError(404, 'NOT_FOUND', 'Publish job was not found');
    return context.json(job);
  });
  routes.post('/jobs/:jobId/continue', async (context) => {
    const actor = requirePublishAccess(context.get('actor'));
    if (!publisher)
      throw new ApiError(503, 'PUBLISHING_NOT_CONFIGURED', 'Staging publishing is not configured');
    await requireMutationRequest(context.req.raw, new URL(context.req.url).origin);
    try {
      const result = await publisher.continuePublication(
        context.req.param('jobId'),
        actor.email,
        context.get('requestId'),
      );
      return context.json(result, result.status === 'running' ? 202 : 201);
    } catch (error) {
      if (
        error instanceof Error &&
        /^(PUBLISH_STEP_UNAVAILABLE|PUBLISH_JOB_NOT_CLAIMABLE|DRAFT_REVISION_DRIFT|STAGING_BASE_DRIFT|PREFLIGHT_CANDIDATE_DRIFT)$/.test(
          error.message,
        )
      )
        throw new ApiError(
          409,
          error.message,
          'Publication cannot continue; refresh the saved draft and publication status',
        );
      if (error instanceof Error && error.message.startsWith('STAGING_RENDERER_MISMATCH:'))
        throw new ApiError(
          409,
          'STAGING_RENDERER_MISMATCH',
          'Staging renderer differs from Builder',
        );
      throw error;
    }
  });
  routes.post('/jobs/:jobId/verification', async (context) => {
    const actor = requirePublishAccess(context.get('actor'));
    if (!publisher)
      throw new ApiError(503, 'PUBLISHING_NOT_CONFIGURED', 'Staging publishing is not configured');
    await requireMutationRequest(context.req.raw, new URL(context.req.url).origin);
    try {
      return context.json(
        await publisher.refreshVerification(
          context.req.param('jobId'),
          actor.email,
          context.get('requestId'),
        ),
      );
    } catch (error) {
      if (error instanceof Error && error.message === 'PUBLISH_JOB_NOT_VERIFIABLE')
        throw new ApiError(409, error.message, 'The publish job is not ready for verification');
      throw error;
    }
  });
  routes.post('/production', () => {
    throw new ApiError(403, 'PRODUCTION_DISABLED', 'Production publishing is disabled');
  });
  return routes;
}
