import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { ApiError, errorResponse } from '../http/errors';
import type { ApiVariables } from './drafts';
import type { D1PublicationRunner } from '../publish/runner';
import type { D1PublicationVerifier } from '../publish/verification';
import { publicationJson } from '../publish/build-proof';
import type { D1CloudRollback } from '../publish/rollback';

function machineRoutes(configured: boolean) {
  const routes = new Hono<{ Variables: ApiVariables }>();
  const credential = (context: Context<{ Variables: ApiVariables }>) => {
    if (!configured)
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
  return { routes, credential };
}

export function createRollbackRunnerRoutes(rollback?: D1CloudRollback) {
  const { routes, credential } = machineRoutes(Boolean(rollback));
  for (const [path, method] of [
    ['reserve', 'reserve'],
    ['claim', 'claim'],
    ['authorize-deployment', 'authorizeDeployment'],
    ['finalize', 'finalize'],
  ] as const) {
    routes.post(`/:jobId/${path}`, async (context) => {
      const token = credential(context);
      if (context.req.raw.body) throw new Error('PUBLISH_RUNNER_UNAUTHORIZED');
      return context.json(await rollback![method](context.req.param('jobId'), token));
    });
  }
  routes.get('/:jobId/inputs', async (context) =>
    context.json(await rollback!.inputs(context.req.param('jobId'), credential(context))),
  );
  routes.post('/:jobId/deployment', async (context) => {
    const token = credential(context);
    if (context.req.header('content-type') !== 'application/json')
      throw new Error('PUBLISH_RUNNER_UNAUTHORIZED');
    return context.json(
      await rollback!.reportDeployment(
        context.req.param('jobId'),
        token,
        await publicationJson(new Response(context.req.raw.body), 8192),
      ),
    );
  });
  return routes;
}

export function createPublicationRunnerRoutes(runner?: D1PublicationRunner) {
  const { routes, credential } = machineRoutes(Boolean(runner));
  routes.post('/:jobId/claim', async (context) => {
    // This operation has no client-supplied scope or claim body.
    if (context.req.raw.body) throw new Error('PUBLISH_RUNNER_UNAUTHORIZED');
    const token = credential(context);
    await runner!.claim(context.req.param('jobId'), token);
    return context.json({ claimed: true });
  });
  for (const [path, method] of [
    ['reserve', 'reserve'],
    ['commit', 'commitBuild'],
    ['authorize-deployment', 'authorizeDeployment'],
    ['finalize', 'finalize'],
  ] as const) {
    routes.post(`/:jobId/${path}`, async (context) => {
      const token = credential(context);
      if (context.req.raw.body) throw new Error('PUBLISH_RUNNER_UNAUTHORIZED');
      return context.json(await runner![method](context.req.param('jobId'), token));
    });
  }
  for (const [path, method] of [
    ['build', 'authorizeBuild'],
    ['deployment', 'reportDeployment'],
  ] as const) {
    routes.post(`/:jobId/${path}`, async (context) => {
      const token = credential(context);
      if (context.req.header('content-type') !== 'application/json')
        throw new Error('PUBLISH_RUNNER_UNAUTHORIZED');
      const value = await publicationJson(new Response(context.req.raw.body), 8192);
      return context.json(await runner![method](context.req.param('jobId'), token, value));
    });
  }
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

export function createPublicationVerificationRoutes(verifier?: D1PublicationVerifier) {
  const { routes, credential } = machineRoutes(Boolean(verifier));
  for (const operation of ['reserve', 'claim', 'finalize'] as const) {
    routes.post(`/:jobId/${operation}`, async (context) => {
      const token = credential(context);
      if (context.req.raw.body) throw new Error('PUBLISH_RUNNER_UNAUTHORIZED');
      return context.json(await verifier![operation](context.req.param('jobId'), token));
    });
  }
  routes.get('/:jobId/inputs', async (context) => {
    const token = credential(context);
    return context.json(await verifier!.inputs(context.req.param('jobId'), token));
  });
  routes.post('/:jobId/report', async (context) => {
    const token = credential(context);
    if (context.req.header('content-type') !== 'application/json')
      throw new Error('PUBLISH_RUNNER_UNAUTHORIZED');
    const value = await publicationJson(new Response(context.req.raw.body), 8192);
    return context.json(await verifier!.report(context.req.param('jobId'), token, value));
  });
  return routes;
}
