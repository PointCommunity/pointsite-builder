import { Hono } from 'hono';
import { z } from 'zod';
import { requireRole } from '../auth/roles';
import { ApiError } from '../http/errors';
import {
  requireMutationHeaders,
  requireMutationRequest,
  type SlidingWindowRateLimiter,
} from '../http/security';
import type { D1LibraryService } from '../media/library';
import type { ApiVariables } from './drafts';

const Metadata = z.strictObject({
  displayName: z.string().trim().min(1).max(120),
  altText: z.string().trim().max(300),
  tags: z.array(z.string().trim().min(1).max(40)).max(20),
});
const Link = Metadata.extend({
  mediaType: z.enum(['image', 'video', 'youtube']),
  url: z.url().max(2_000),
});
const Update = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('update'), metadata: Metadata }),
  z.strictObject({ action: z.literal('archive') }),
  z.strictObject({ action: z.literal('unarchive') }),
]);
const Confirmation = z.strictObject({ confirmation: z.literal(true) });
const MAX_MULTIPART_BYTES = 5 * 1024 * 1024 + 64 * 1024;

async function boundedForm(request: Request): Promise<FormData> {
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(422, 'VALIDATION_FAILED', 'Choose an image');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_MULTIPART_BYTES) {
        await reader.cancel();
        throw new ApiError(413, 'REQUEST_TOO_LARGE', 'The image request is too large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Request(request.url, {
    method: 'POST',
    headers: request.headers,
    body: bytes,
  }).formData();
}

export function createLibraryRoutes(
  service: D1LibraryService | undefined,
  limiter: SlidingWindowRateLimiter,
) {
  const routes = new Hono<{ Variables: ApiVariables }>();
  const available = () => {
    if (!service)
      throw new ApiError(503, 'LIBRARY_NOT_CONFIGURED', 'Draft Library is not configured');
    return service;
  };
  routes.get('/:draftId/library', async (context) => {
    requireRole(context.get('actor'), 'viewer');
    return context.json(await available().list(context.req.param('draftId')));
  });
  routes.on(
    ['POST', 'PATCH', 'DELETE'],
    [
      '/:draftId/library/images',
      '/:draftId/library/links',
      '/:draftId/library/items/:itemId',
      '/:draftId/library/items/:itemId/replacement',
    ],
    async (context) => {
      const actor = requireRole(context.get('actor'), 'editor');
      if (!limiter.consume(`library:${actor.email}`))
        throw new ApiError(429, 'RATE_LIMITED', 'Try again shortly');
      const request = context.req.raw;
      const checksum = context.req.header('if-match')?.match(/^"([a-f0-9]{64})"$/)?.[1];
      const checkoutToken = context.req.header('x-draft-checkout');
      const expectedRevisionId = context.req.header('x-draft-revision');
      const idempotencyKey = context.req.header('idempotency-key');
      if (
        !checksum ||
        !checkoutToken ||
        !expectedRevisionId ||
        !z.uuid().safeParse(expectedRevisionId).success ||
        !idempotencyKey ||
        !/^[A-Za-z0-9._:-]{16,100}$/.test(idempotencyKey)
      )
        throw new ApiError(
          428,
          'PRECONDITION_REQUIRED',
          'A saved draft, current checkout, and request key are required',
        );
      const input = {
        draftId: context.req.param('draftId'),
        expectedRevisionId,
        expectedChecksum: checksum,
        checkoutToken,
        idempotencyKey,
        actor: actor.email,
        requestId: context.get('requestId'),
      };
      const path = context.req.path;
      try {
        if (
          request.method === 'POST' &&
          (path.endsWith('/images') || path.endsWith('/replacement'))
        ) {
          requireMutationHeaders(
            request,
            new URL(request.url).origin,
            'multipart/form-data',
            MAX_MULTIPART_BYTES,
          );
          const form = await boundedForm(request);
          const file = form.get('file');
          const altText = form.get('altText');
          if (!(file instanceof File) || typeof altText !== 'string')
            throw new ApiError(
              422,
              'VALIDATION_FAILED',
              'Choose an image and provide alternative text',
            );
          const image = {
            filename: file.name,
            contentType: file.type,
            bytes: new Uint8Array(await file.arrayBuffer()),
            altText,
          };
          if (path.endsWith('/images'))
            return context.json(await available().mutate(input, { action: 'upload', image }), 201);
          if (form.get('confirmed') !== 'true')
            throw new ApiError(
              422,
              'CONFIRMATION_REQUIRED',
              'Confirm replacement before continuing',
            );
          const rawTags = form.get('tags');
          if (rawTags !== null && typeof rawTags !== 'string')
            throw new ApiError(422, 'VALIDATION_FAILED', 'Review the image tags');
          const tags: unknown = JSON.parse(rawTags ?? '[]');
          const metadata = Metadata.parse({
            displayName: form.get('displayName'),
            altText,
            tags,
          });
          return context.json(
            await available().mutate(input, {
              action: 'replace',
              itemId: context.req.param('itemId'),
              image,
              metadata,
            }),
          );
        }
        const body = await requireMutationRequest(request, new URL(request.url).origin);
        if (request.method === 'POST' && path.endsWith('/links'))
          return context.json(
            await available().mutate(input, { action: 'link', link: Link.parse(body) }),
            201,
          );
        if (request.method === 'PATCH' && context.req.param('itemId')) {
          const command = Update.parse(body);
          return context.json(
            await available().mutate(input, { ...command, itemId: context.req.param('itemId') }),
          );
        }
        if (request.method === 'DELETE' && context.req.param('itemId')) {
          Confirmation.parse(body);
          return context.json(
            await available().mutate(input, {
              action: 'delete',
              itemId: context.req.param('itemId'),
            }),
          );
        }
        throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Unsupported Library action');
      } catch (error) {
        if (error instanceof Error && error.message === 'PRIVATE_MEDIA_LINK')
          throw new ApiError(
            422,
            'PRIVATE_MEDIA_LINK',
            'Upload this image into this draft instead of linking to private Builder storage.',
          );
        if (error instanceof z.ZodError || error instanceof SyntaxError)
          throw new ApiError(422, 'VALIDATION_FAILED', 'Review the Library fields');
        if (error instanceof Error && error.message.includes('MEDIA_CAPACITY_EXCEEDED'))
          throw new ApiError(
            422,
            'MEDIA_CAPACITY_EXCEEDED',
            'Private image storage is full. Free space before adding or replacing images.',
          );
        if (error instanceof Error && error.message.startsWith('MEDIA_'))
          throw new ApiError(422, 'MEDIA_REJECTED', error.message.replace(/^MEDIA_REJECTED: /, ''));
        throw error;
      }
    },
  );
  return routes;
}
