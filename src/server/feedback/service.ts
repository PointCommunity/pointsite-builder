import { importPKCS8, SignJWT } from 'jose';
import { z } from 'zod';
import type { Role } from '../repositories/contracts';
import { ApiError } from '../http/errors';
import {
  feedbackScreens,
  type FeedbackAvailability,
  type FeedbackScreen,
} from '../../shared/feedback';

const schema = z
  .object({
    POINTVIEW_MODE: z.enum(['pilot', 'production']),
    POINTVIEW_ORIGIN: z.enum([
      'https://pointview-canary.eaglepass.io',
      'https://pointview.eaglepass.io',
    ]),
    POINTVIEW_KEY_ID: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
    POINTVIEW_PRIVATE_KEY: z
      .string()
      .regex(/^-----BEGIN PRIVATE KEY-----\n[A-Za-z0-9+/=\r\n]+\n-----END PRIVATE KEY-----\s*$/),
    BUILDER_ORIGIN: z.literal('https://builder.pointatx.org'),
  })
  .refine(
    (value) =>
      value.POINTVIEW_ORIGIN ===
      (value.POINTVIEW_MODE === 'pilot'
        ? 'https://pointview-canary.eaglepass.io'
        : 'https://pointview.eaglepass.io'),
  );

export type FeedbackConfig = z.infer<typeof schema>;

// Feedback configuration must never make unrelated Builder operations unavailable.
export function parseFeedbackConfig(input: Record<string, unknown>): FeedbackConfig | undefined {
  const parsed = schema.safeParse(input);
  return parsed.success ? parsed.data : undefined;
}

export class FeedbackService {
  constructor(
    private readonly config: FeedbackConfig,
    private readonly version: string,
    private readonly revision: string,
  ) {}

  availability(role: Role): FeedbackAvailability {
    if (!/^[a-f0-9]{40}$/.test(this.revision) || !this.version || this.version.length > 100)
      return { mode: 'disabled' };
    return {
      mode:
        this.config.POINTVIEW_MODE === 'pilot' && role !== 'administrator'
          ? 'disabled'
          : this.config.POINTVIEW_MODE,
    };
  }

  async launch(
    screen: FeedbackScreen,
    role: Role,
  ): Promise<{ action: string; launchToken: string }> {
    if (
      this.availability(role).mode === 'disabled' ||
      (screen === 'editor.admin' && role !== 'administrator')
    )
      throw new ApiError(
        403,
        'FEEDBACK_UNAVAILABLE',
        'Feedback is not available for this account.',
      );
    try {
      const context = feedbackScreens[screen];
      const now = Math.floor(Date.now() / 1000);
      const key = await importPKCS8(this.config.POINTVIEW_PRIVATE_KEY, 'EdDSA');
      const launchToken = await new SignJWT({
        source_app: 'pointsite-builder',
        environment: 'production',
        context: {
          location: context.location,
          screen_name: context.name,
          app_version: this.version,
          source_revision: this.revision,
          return_url: 'https://builder.pointatx.org/',
        },
      })
        .setProtectedHeader({ alg: 'EdDSA', kid: this.config.POINTVIEW_KEY_ID, typ: 'JWT' })
        .setIssuer('pointsite-builder')
        .setAudience('pointview')
        .setIssuedAt(now)
        .setExpirationTime(now + 120)
        .setJti(crypto.randomUUID())
        .sign(key);
      return { action: `${this.config.POINTVIEW_ORIGIN}/launch`, launchToken };
    } catch {
      // Never forward signing-library errors, key material, or assertions to the logger.
      throw new ApiError(
        503,
        'FEEDBACK_UNAVAILABLE',
        'Feedback could not be opened. Your draft is safe. Please try again.',
      );
    }
  }
}
