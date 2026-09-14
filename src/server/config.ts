import { z } from 'zod';

const RuntimeConfigSchema = z
  .object({
    ENVIRONMENT: z.enum(['local', 'preview', 'canary', 'production']),
    RUNTIME: z.enum(['worker', 'node']).default('worker'),
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
    PRODUCTION_ENABLED: z.enum(['false', 'true']),
    DRAFT_STORAGE_FORMAT: z.enum(['legacy', 'compact-v1']).default('legacy'),
    CLOUDFLARE_ANALYTICS_TOKEN: z.string().min(20).optional(),
    CLOUDFLARE_WORKER_READ_TOKEN: z.string().min(20).optional(),
  })
  .superRefine((value, context) => {
    if (value.ENVIRONMENT === 'canary' && value.PRODUCTION_ENABLED === 'true') {
      context.addIssue({
        code: 'custom',
        path: ['PRODUCTION_ENABLED'],
        message: 'Canary cannot publish public Production',
      });
    }
    if (value.RUNTIME === 'node' && value.ENVIRONMENT !== 'local') {
      const expected =
        value.ENVIRONMENT === 'canary'
          ? 'https://builder-canary.eaglepass.io'
          : 'https://builder.eaglepass.io';
      if (
        !['canary', 'production'].includes(value.ENVIRONMENT) ||
        value.BUILDER_ORIGIN.replace(/\/$/, '') !== expected
      ) {
        context.addIssue({
          code: 'custom',
          path: ['BUILDER_ORIGIN'],
          message: 'Native Builder origin must match its environment',
        });
      }
    }
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
    if (value.PRODUCTION_ENABLED === 'true' && configured !== githubFields.length) {
      context.addIssue({
        code: 'custom',
        path: ['PRODUCTION_ENABLED'],
        message: 'Production publishing requires complete GitHub authentication',
      });
    }
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
  environment: 'local' | 'preview' | 'canary' | 'production';
  runtime: 'worker' | 'node';
  appVersion: string;
  builderOrigin: string;
  devAuthEmail?: string;
  productionEnabled: boolean;
  draftStorageFormat: 'legacy' | 'compact-v1';
  analyticsToken?: string;
  workerReadToken?: string;
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
  const value = RuntimeConfigSchema.parse({
    ...(input.RUNTIME === 'node' ? { DRAFT_STORAGE_FORMAT: 'compact-v1' } : {}),
    ...input,
  });
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
    runtime: value.RUNTIME,
    appVersion: value.APP_VERSION,
    builderOrigin: value.BUILDER_ORIGIN.replace(/\/$/, ''),
    ...(value.DEV_AUTH_EMAIL ? { devAuthEmail: value.DEV_AUTH_EMAIL.toLowerCase() } : {}),
    productionEnabled: value.PRODUCTION_ENABLED === 'true',
    draftStorageFormat: value.DRAFT_STORAGE_FORMAT,
    ...(value.CLOUDFLARE_ANALYTICS_TOKEN
      ? { analyticsToken: value.CLOUDFLARE_ANALYTICS_TOKEN }
      : {}),
    ...(value.CLOUDFLARE_WORKER_READ_TOKEN
      ? { workerReadToken: value.CLOUDFLARE_WORKER_READ_TOKEN }
      : {}),
    ...(github ? { github } : {}),
  };
}
