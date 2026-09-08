import { ApiError } from './errors';

const MAX_JSON_BYTES = 1_600_000;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{16,100}$/;

export function requireMutationHeaders(
  request: Request,
  allowedOrigin: string,
  allowedContentType: string,
  maxBytes: number,
): void {
  if (request.headers.get('origin') !== allowedOrigin)
    throw new ApiError(403, 'ORIGIN_DENIED', 'The request origin is not allowed');
  if (request.headers.get('sec-fetch-site') !== 'same-origin')
    throw new ApiError(403, 'FETCH_METADATA_DENIED', 'Cross-site requests are not allowed');
  const contentType = request.headers.get('content-type')?.split(';')[0]?.trim();
  if (contentType !== allowedContentType)
    throw new ApiError(415, 'CONTENT_TYPE_REQUIRED', `Use ${allowedContentType}`);
  if (!IDEMPOTENCY_KEY.test(request.headers.get('idempotency-key') ?? ''))
    throw new ApiError(400, 'IDEMPOTENCY_REQUIRED', 'A valid Idempotency-Key is required');
  const declaredSize = Number(request.headers.get('content-length') ?? 0);
  if (declaredSize > maxBytes)
    throw new ApiError(413, 'REQUEST_TOO_LARGE', 'The request body is too large');
}

export async function requireMutationRequest(
  request: Request,
  allowedOrigin: string,
): Promise<unknown> {
  requireMutationHeaders(request, allowedOrigin, 'application/json', MAX_JSON_BYTES);
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_JSON_BYTES) {
    throw new ApiError(413, 'REQUEST_TOO_LARGE', 'The request body is too large');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError(400, 'INVALID_JSON', 'The request body is not valid JSON');
  }
}

export function applySecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'no-store');
  headers.set(
    'content-security-policy',
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  );
  headers.set('cross-origin-resource-policy', 'same-origin');
  headers.set('referrer-policy', 'no-referrer');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('x-frame-options', 'DENY');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export class SlidingWindowRateLimiter {
  readonly #events = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMilliseconds: number,
  ) {}

  consume(key: string, now = Date.now()): boolean {
    const cutoff = now - this.windowMilliseconds;
    const recent = (this.#events.get(key) ?? []).filter((timestamp) => timestamp > cutoff);
    if (recent.length >= this.limit) {
      this.#events.set(key, recent);
      return false;
    }
    recent.push(now);
    this.#events.set(key, recent);
    return true;
  }
}
