import { Hono } from 'hono';
import { requireRole } from '../auth/roles';
import { ApiError } from '../http/errors';
import { requireMutationHeaders, type SlidingWindowRateLimiter } from '../http/security';
import type { MediaService } from '../media/service';
import type { ApiVariables } from './drafts';

const MAX_MULTIPART_BYTES = 5 * 1024 * 1024 + 64 * 1024;

export function createMediaRoutes(
  service: MediaService | undefined,
  limiter: SlidingWindowRateLimiter,
) {
  const routes = new Hono<{ Variables: ApiVariables }>();
  const available = () => {
    if (!service)
      throw new ApiError(503, 'MEDIA_NOT_CONFIGURED', 'Private media is not configured');
    return service;
  };
  routes.get('/', async (context) => {
    requireRole(context.get('actor'), 'viewer');
    return context.json({ items: await available().list(), nextCursor: null });
  });
  routes.post('/', async (context) => {
    const actor = requireRole(context.get('actor'), 'editor');
    if (!limiter.consume(`media:${actor.email}`))
      throw new ApiError(429, 'RATE_LIMITED', 'Try again shortly');
    const request = context.req.raw;
    requireMutationHeaders(
      request,
      new URL(context.req.url).origin,
      'multipart/form-data',
      MAX_MULTIPART_BYTES,
    );
    const form = await request.formData();
    const file = form.get('file');
    const altText = form.get('altText');
    if (!(file instanceof File) || typeof altText !== 'string')
      throw new ApiError(422, 'VALIDATION_FAILED', 'Choose an image and provide alternative text');
    try {
      const record = await available().upload({
        filename: file.name,
        contentType: file.type,
        bytes: new Uint8Array(await file.arrayBuffer()),
        altText,
        actor: actor.email,
        requestId: context.get('requestId'),
      });
      return context.json(record, 201);
    } catch (error) {
      if (error instanceof Error && !error.message.startsWith('GitHub'))
        throw new ApiError(422, 'MEDIA_REJECTED', error.message);
      throw error;
    }
  });
  routes.get('/:mediaId', async (context) => {
    requireRole(context.get('actor'), 'viewer');
    try {
      const object = await available().read(context.req.param('mediaId'));
      return new Response(Uint8Array.from(object.bytes).buffer, {
        headers: {
          'content-type': object.contentType,
          'content-disposition': `inline; filename="${object.filename.replaceAll('"', '')}"`,
        },
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'MEDIA_NOT_FOUND')
        throw new ApiError(404, 'NOT_FOUND', 'Media was not found');
      throw error;
    }
  });
  return routes;
}
