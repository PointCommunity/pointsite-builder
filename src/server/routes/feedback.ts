import { Hono } from 'hono';
import { z } from 'zod';
import { feedbackScreens, type FeedbackScreen } from '../../shared/feedback';
import type { FeedbackService } from '../feedback/service';
import { ApiError } from '../http/errors';
import { requireMutationHeaders, type SlidingWindowRateLimiter } from '../http/security';
import type { ApiVariables } from './drafts';

const inputSchema = z.strictObject({
  screen: z.enum(Object.keys(feedbackScreens) as [FeedbackScreen, ...FeedbackScreen[]]),
});

export function createFeedbackRoutes(
  service: FeedbackService | undefined,
  limiter: SlidingWindowRateLimiter,
) {
  const routes = new Hono<{ Variables: ApiVariables }>();
  routes.get('/', (context) =>
    context.json(service?.availability(context.get('actor').role) ?? { mode: 'disabled' }),
  );
  routes.post('/launch', async (context) => {
    const actor = context.get('actor');
    if (!service || service.availability(actor.role).mode === 'disabled')
      throw new ApiError(
        403,
        'FEEDBACK_UNAVAILABLE',
        'Feedback is not available for this account.',
      );
    requireMutationHeaders(
      context.req.raw,
      new URL(context.req.url).origin,
      'application/json',
      256,
    );
    if (!limiter.consume(`feedback:${actor.email}`))
      throw new ApiError(429, 'RATE_LIMITED', 'Please wait a moment before trying feedback again.');
    const text = await context.req.text();
    if (new TextEncoder().encode(text).byteLength > 256)
      throw new ApiError(413, 'REQUEST_TOO_LARGE', 'The feedback request is too large.');
    let input: unknown;
    try {
      input = JSON.parse(text) as unknown;
    } catch {
      input = null;
    }
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success)
      throw new ApiError(422, 'VALIDATION_FAILED', 'Choose a valid Builder screen.');
    return context.json(await service.launch(parsed.data.screen, actor.role));
  });
  return routes;
}
