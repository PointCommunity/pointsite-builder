import { z } from 'zod';

const RuntimeConfigSchema = z
  .object({
    ENVIRONMENT: z.enum(['local', 'preview', 'production']),
    APP_VERSION: z.string().min(1).max(100),
    BUILDER_ORIGIN: z.url().refine((value) => new URL(value).pathname === '/', {
      message: 'Builder origin must not include a path',
    }),
    STAGING_REPOSITORY: z.literal('PointCommunity/pointsite-staging'),
    DEV_AUTH_EMAIL: z.email().optional(),
    GITHUB_APP_ID: z.string().min(1).optional(),
    GITHUB_STAGING_INSTALLATION_ID: z.string().min(1).optional(),
    GITHUB_APP_PRIVATE_KEY: z.string().min(100).optional(),
    GITHUB_CLIENT_ID: z.string().min(8).optional(),
    GITHUB_CLIENT_SECRET: z.string().min(20).optional(),
    SESSION_SECRET: z.string().min(32).optional(),
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
    const githubFields = [
      value.GITHUB_APP_ID,
      value.GITHUB_STAGING_INSTALLATION_ID,
      value.GITHUB_APP_PRIVATE_KEY,
      value.GITHUB_CLIENT_ID,
      value.GITHUB_CLIENT_SECRET,
      value.SESSION_SECRET,
    ];
    const configured = githubFields.filter(Boolean).length;
    if (configured !== 0 && configured !== githubFields.length) {
      context.addIssue({
        code: 'custom',
        path: ['GITHUB_CLIENT_ID'],
        message: 'GitHub App authentication must be configured as one complete secret set',
      });
    }
    if (value.ENVIRONMENT !== 'local' && configured !== githubFields.length) {
      context.addIssue({
        code: 'custom',
        path: ['GITHUB_CLIENT_ID'],
        message: 'GitHub App authentication is required outside local development',
      });
    }
  });

export interface RuntimeConfig {
  environment: 'local' | 'preview' | 'production';
  appVersion: string;
  builderOrigin: string;
  devAuthEmail?: string;
  productionEnabled: false;
  github?: {
    appId: string;
    installationId: string;
    privateKey: string;
    clientId: string;
    clientSecret: string;
    sessionSecret: string;
    repository: 'PointCommunity/pointsite-staging';
    builderOrigin: string;
  };
}

export function parseConfig(input: Record<string, unknown>): RuntimeConfig {
  const value = RuntimeConfigSchema.parse(input);
  const github =
    value.GITHUB_APP_ID &&
    value.GITHUB_STAGING_INSTALLATION_ID &&
    value.GITHUB_APP_PRIVATE_KEY &&
    value.GITHUB_CLIENT_ID &&
    value.GITHUB_CLIENT_SECRET &&
    value.SESSION_SECRET
      ? {
          appId: value.GITHUB_APP_ID,
          installationId: value.GITHUB_STAGING_INSTALLATION_ID,
          privateKey: value.GITHUB_APP_PRIVATE_KEY,
          clientId: value.GITHUB_CLIENT_ID,
          clientSecret: value.GITHUB_CLIENT_SECRET,
          sessionSecret: value.SESSION_SECRET,
          repository: value.STAGING_REPOSITORY,
          builderOrigin: value.BUILDER_ORIGIN.replace(/\/$/, ''),
        }
      : undefined;
  return {
    environment: value.ENVIRONMENT,
    appVersion: value.APP_VERSION,
    builderOrigin: value.BUILDER_ORIGIN.replace(/\/$/, ''),
    ...(value.DEV_AUTH_EMAIL ? { devAuthEmail: value.DEV_AUTH_EMAIL.toLowerCase() } : {}),
    productionEnabled: false,
    ...(github ? { github } : {}),
  };
}
