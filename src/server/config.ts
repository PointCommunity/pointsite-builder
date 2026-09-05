import { z } from 'zod';

const RuntimeConfigSchema = z
  .object({
    ENVIRONMENT: z.enum(['local', 'preview', 'production']),
    APP_VERSION: z.string().min(1).max(100),
    ACCESS_TEAM_DOMAIN: z.string().regex(/^[a-z0-9.-]+\.cloudflareaccess\.com$/),
    ACCESS_AUD: z.string().min(8).max(200),
    DEV_AUTH_EMAIL: z.email().optional(),
    PRODUCTION_ENABLED: z.literal('false'),
  })
  .superRefine((value, context) => {
    if (value.ENVIRONMENT !== 'local' && value.DEV_AUTH_EMAIL) {
      context.addIssue({
        code: 'custom',
        path: ['DEV_AUTH_EMAIL'],
        message: 'Development identity is allowed only in the local environment',
      });
    }
  });

export interface RuntimeConfig {
  environment: 'local' | 'preview' | 'production';
  appVersion: string;
  accessTeamDomain: string;
  accessAudience: string;
  devAuthEmail?: string;
  productionEnabled: false;
}

export function parseConfig(input: Record<string, unknown>): RuntimeConfig {
  const value = RuntimeConfigSchema.parse(input);
  return {
    environment: value.ENVIRONMENT,
    appVersion: value.APP_VERSION,
    accessTeamDomain: value.ACCESS_TEAM_DOMAIN,
    accessAudience: value.ACCESS_AUD,
    ...(value.DEV_AUTH_EMAIL ? { devAuthEmail: value.DEV_AUTH_EMAIL.toLowerCase() } : {}),
    productionEnabled: false,
  };
}
