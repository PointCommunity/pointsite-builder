import { Hono } from 'hono';
import { z } from 'zod';
import { requireRole } from '../auth/roles';
import { ApiError } from '../http/errors';
import { requireMutationHeaders } from '../http/security';
import { publicationJson } from '../publish/build-proof';
import {
  VerificationRequestSchema,
  VerificationRecoverySchema,
  type D1PublicationVerifier,
} from '../publish/verification';
import type { ApiVariables } from './drafts';

export function createVerificationSessionRoutes(
  verifier?: D1PublicationVerifier,
  productionEnabled = false,
) {
  const routes = new Hono<{ Variables: ApiVariables }>();
  const bodySchema = VerificationRequestSchema.pick({ expectedAttempts: true });
  const recoveryBody = VerificationRecoverySchema.pick({ action: true, expectedDispatches: true });
  const readBody = async (request: Request) => {
    requireMutationHeaders(request, new URL(request.url).origin, 'application/json', 8192);
    try {
      return await publicationJson(new Response(request.body), 8192);
    } catch {
      throw new ApiError(422, 'VALIDATION_FAILED', 'Choose the publication to verify');
    }
  };
  for (const target of ['staging', 'production'] as const) {
    const path = `/${target}/jobs/:jobId/verification`;
    const recoveryPath = `${path}/:verificationId/recovery`;
    for (const route of [path, recoveryPath])
      routes.use(route, async (context, next) => {
        requireRole(context.get('actor'), target === 'staging' ? 'publisher' : 'administrator');
        if (target === 'production' && !productionEnabled)
          throw new ApiError(403, 'PRODUCTION_DISABLED', 'Production publishing is disabled');
        if (!verifier)
          throw new ApiError(
            503,
            'PUBLICATION_VERIFICATION_UNAVAILABLE',
            'Verification is unavailable',
          );
        if (
          !z.uuid().safeParse(context.req.param('jobId')).success ||
          new URL(context.req.url).search
        )
          throw new ApiError(422, 'VALIDATION_FAILED', 'Choose the publication to verify');
        await next();
      });
    routes.get(path, async (context) => {
      try {
        return context.json({
          verification: await verifier!.status(
            context.req.param('jobId')!,
            target,
            context.get('actor').email,
          ),
        });
      } catch (error) {
        throw verificationError(error);
      }
    });
    routes.post(path, async (context) => {
      const input = bodySchema.safeParse(await readBody(context.req.raw));
      if (!input.success)
        throw new ApiError(422, 'VALIDATION_FAILED', 'Choose the publication to verify');
      try {
        const captured = await verifier!.capture({
          ...input.data,
          target,
          jobId: context.req.param('jobId')!,
          actor: context.get('actor').email,
          requestId: context.get('requestId'),
          idempotencyKey: context.req.header('idempotency-key')!,
        });
        // The durable scheduler owns retry after capture, including an uncertain dispatch reply.
        try {
          await verifier!.dispatch(captured.verificationId);
        } catch {
          /* Status retains dispatch failure. */
        }
        return context.json(captured, 202);
      } catch (error) {
        throw verificationError(error);
      }
    });
    routes.post(recoveryPath, async (context) => {
      const input = recoveryBody.safeParse(await readBody(context.req.raw));
      const verificationId = z.uuid().safeParse(context.req.param('verificationId'));
      if (!input.success || !verificationId.success)
        throw new ApiError(422, 'VALIDATION_FAILED', 'Choose the verification to recover');
      try {
        const result = await verifier![input.data.action]({
          ...input.data,
          target,
          jobId: context.req.param('jobId')!,
          verificationId: verificationId.data,
          actor: context.get('actor').email,
          requestId: context.get('requestId'),
          idempotencyKey: context.req.header('idempotency-key')!,
        });
        if ('verificationId' in result && typeof result.verificationId === 'string') {
          try {
            await verifier!.dispatch(result.verificationId);
          } catch {
            /* Durable status owns retry. */
          }
        }
        return context.json(result);
      } catch (error) {
        throw verificationError(error);
      }
    });
  }
  return routes;
}

function verificationError(error: unknown) {
  const code = error instanceof Error ? error.message : '';
  if (['PUBLISH_AUTHORITY_CHANGED', 'PUBLISH_GITHUB_AUTHORITY_CHANGED'].includes(code))
    return new ApiError(403, code, 'Your publishing authority changed; refresh your session');
  if (
    [
      'PUBLICATION_VERIFICATION_BUSY',
      'PUBLICATION_VERIFICATION_CHANGED',
      'PUBLICATION_VERIFICATION_LIMIT',
      'PUBLICATION_VERIFICATION_RECONCILE_REQUIRED',
      'PUBLICATION_VERIFICATION_BACKOFF',
      'PUBLICATION_RUN_NOT_TERMINAL',
      'PUBLICATION_VERIFICATION_UNCONFIRMED',
      'IDEMPOTENCY_CONFLICT',
    ].includes(code)
  )
    return new ApiError(409, code, 'Publication state changed; refresh before trying again');
  return new ApiError(
    503,
    'PUBLICATION_VERIFICATION_UNAVAILABLE',
    'Verification could not be confirmed; refresh before trying again',
  );
}
