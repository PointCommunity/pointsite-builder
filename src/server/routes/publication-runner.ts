import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { ApiError, errorResponse } from '../http/errors';
import type { ApiVariables } from './drafts';
import type { D1PublicationRunner } from '../publish/runner';

export function createPublicationRunnerRoutes(runner?: D1PublicationRunner) {
  const routes = new Hono<{ Variables: ApiVariables }>();
  const credential = (context: Context<{ Variables: ApiVariables }>) => {
    if (!runner)
      throw new ApiError(503, 'PUBLISH_RUNNER_NOT_CONFIGURED', 'Publication runner unavailable');
    const header = context.req.header('authorization') ?? '';
    if (
      !/^Bearer [^\s]{1,16384}$/.test(header) ||
      !z.uuid().safeParse(context.req.param('jobId')).success ||
      new URL(context.req.url).search ||
      context.req.header('cookie') ||
      context.req.header('origin')
    )
      throw new Error('PUBLISH_RUNNER_UNAUTHORIZED');
    return header.slice(7);
  };
  routes.onError((error, context) => {
    // D1/JWT errors can include SQL or claims. Only stable codes leave this route.
    const unauthorized = error.message === 'PUBLISH_RUNNER_UNAUTHORIZED';
    const safe =
      error instanceof ApiError
        ? error
        : new ApiError(
            unauthorized ? 401 : 409,
            unauthorized ? 'PUBLISH_RUNNER_UNAUTHORIZED' : 'PUBLISH_RUNNER_REJECTED',
            'Publication runner request rejected',
          );
    return errorResponse(safe, context.get('requestId'));
  });
  routes.post('/:jobId/claim', async (context) => {
    // This operation has no client-supplied scope or claim body.
    if (context.req.raw.body) throw new Error('PUBLISH_RUNNER_UNAUTHORIZED');
    await runner!.claim(context.req.param('jobId'), credential(context));
    return context.json({ claimed: true });
  });
  routes.get('/:jobId/inputs', async (context) =>
    context.json(await runner!.inputs(context.req.param('jobId'), credential(context))),
  );
  routes.get('/:jobId/assets/:assetId/chunks/:index', async (context) => {
    const index = z
      .string()
      .regex(/^[0-5]$/)
      .parse(context.req.param('index'));
    const bytes = await runner!.chunk(
      context.req.param('jobId'),
      credential(context),
      context.req.param('assetId'),
      Number(index),
    );
    return new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } });
  });
  return routes;
}
