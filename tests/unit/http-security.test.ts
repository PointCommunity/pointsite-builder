// @vitest-environment node

import { ApiError, errorResponse } from '../../src/server/http/errors';
import {
  SlidingWindowRateLimiter,
  applySecurityHeaders,
  requireMutationRequest,
} from '../../src/server/http/security';

const origin = 'https://builder.pointatx.org';

function mutationRequest(headers: Record<string, string> = {}, body = '{}') {
  return new Request(`${origin}/api/drafts`, {
    method: 'POST',
    body,
    headers: {
      'content-type': 'application/json',
      origin,
      'sec-fetch-site': 'same-origin',
      'idempotency-key': '0123456789abcdef',
      ...headers,
    },
  });
}

describe('HTTP security controls', () => {
  it('accepts bounded same-origin JSON mutations with idempotency', async () => {
    const body = await requireMutationRequest(mutationRequest(), origin);
    expect(body).toEqual({});
  });

  it.each([
    [{ origin: 'https://evil.example' }, '{}', 'ORIGIN_DENIED'],
    [{ 'sec-fetch-site': 'cross-site' }, '{}', 'FETCH_METADATA_DENIED'],
    [{ 'content-type': 'text/plain' }, '{}', 'CONTENT_TYPE_REQUIRED'],
    [{ 'idempotency-key': 'short' }, '{}', 'IDEMPOTENCY_REQUIRED'],
  ])('rejects invalid mutation metadata', async (headers, body, code) => {
    await expect(
      requireMutationRequest(mutationRequest(headers, body), origin),
    ).rejects.toMatchObject({
      code,
    });
  });

  it('rejects oversized and malformed JSON before route handling', async () => {
    await expect(
      requireMutationRequest(
        mutationRequest({}, JSON.stringify({ data: 'x'.repeat(1_600_000) })),
        origin,
      ),
    ).rejects.toMatchObject({ code: 'REQUEST_TOO_LARGE' });
    await expect(requireMutationRequest(mutationRequest({}, '{'), origin)).rejects.toMatchObject({
      code: 'INVALID_JSON',
    });
  });

  it('returns one safe error shape and masks unexpected exceptions', async () => {
    const expected = errorResponse(
      new ApiError(422, 'VALIDATION_FAILED', 'Review the highlighted fields', [
        { path: 'pages.0.route', message: 'Route is reserved' },
      ]),
      'request-1',
    );
    await expect(expected.json()).resolves.toEqual({
      code: 'VALIDATION_FAILED',
      message: 'Review the highlighted fields',
      requestId: 'request-1',
      fieldErrors: [{ path: 'pages.0.route', message: 'Route is reserved' }],
    });

    const masked = errorResponse(new Error('database token abc123'), 'request-2');
    await expect(masked.json()).resolves.toEqual({
      code: 'INTERNAL_ERROR',
      message: 'The request could not be completed',
      requestId: 'request-2',
    });
  });

  it('applies private security headers to API responses', () => {
    const response = applySecurityHeaders(new Response('{}'));
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });

  it('limits repeated actor mutations in a bounded window', () => {
    const limiter = new SlidingWindowRateLimiter(2, 60_000);
    expect(limiter.consume('editor@pointatx.org', 1_000)).toBe(true);
    expect(limiter.consume('editor@pointatx.org', 1_001)).toBe(true);
    expect(limiter.consume('editor@pointatx.org', 1_002)).toBe(false);
    expect(limiter.consume('editor@pointatx.org', 61_001)).toBe(true);
  });
});
