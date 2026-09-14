import { createBuilderRuntime } from '../src/server/application';
import { parseConfig } from '../src/server/config';
import { FeedbackService, parseFeedbackConfig } from '../src/server/feedback/service';

declare const __BUILDER_SOURCE_REVISION__: string;
declare const __BUILDER_SOURCE_CLEAN__: boolean;

function runtime(env: Env) {
  const config = parseConfig(env as unknown as Record<string, unknown>);
  const feedbackConfig =
    config.environment === 'production'
      ? parseFeedbackConfig(env as unknown as Record<string, unknown>)
      : undefined;
  return createBuilderRuntime({
    workspace: env.DB,
    recovery: env.RECOVERY_DB,
    assets: env.ASSETS,
    config,
    release: {
      sourceRevision: __BUILDER_SOURCE_REVISION__,
      sourceClean: __BUILDER_SOURCE_CLEAN__,
      workerVersionId: env.CF_VERSION_METADATA?.id ?? null,
      storageWriteFormat: config.draftStorageFormat,
    },
    ...(feedbackConfig
      ? {
          feedback: new FeedbackService(
            feedbackConfig,
            config.appVersion,
            __BUILDER_SOURCE_REVISION__,
          ),
        }
      : {}),
  });
}

export default {
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await runtime(env).scheduled();
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    return runtime(env).fetch(request);
  },
};
