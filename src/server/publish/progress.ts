import { z } from 'zod';
import { publicationDestination } from './destinations';
import { publicationJson } from './build-proof';
import { supportText } from '../../shared/publication-support';

const state = z.enum(['queued', 'waiting', 'pending', 'in_progress', 'completed']);
const conclusion = z
  .enum([
    'success',
    'failure',
    'cancelled',
    'timed_out',
    'action_required',
    'neutral',
    'skipped',
    'stale',
    'startup_failure',
  ])
  .nullable();
const step = z.object({
  number: z.number().int(),
  name: z.string().max(1000),
  status: state,
  conclusion,
});
const jobsSchema = z.object({
  total_count: z.number().int().max(100),
  jobs: z
    .array(
      z.object({
        id: z.number().int().positive(),
        run_id: z.number().int().positive(),
        run_attempt: z.number().int().positive(),
        head_sha: z.string(),
        name: z.string().max(1000),
        status: state,
        conclusion,
        steps: z.array(step).max(100),
      }),
    )
    .max(100),
});
export interface ActionsProgress {
  checkedAt: string;
  retryAt?: string;
  lastSuccessfulCheckAt?: string;
  unconfirmed?: boolean;
  run?: { status: string; conclusion: string | null; workflowUrl: string };
  unavailable?: string;
  jobs?: {
    name: string;
    status: string;
    conclusion: string | null;
    workflowUrl: string;
    errors?: { message: string; path: string; line: number }[];
    errorsUnavailable?: boolean;
    steps: { number: number; name: string; status: string; conclusion: string | null }[];
  }[];
}
const caches = new WeakMap<
  typeof fetch,
  Map<string, { until: number; value: Promise<ActionsProgress> }>
>();

/** Public diagnostic metadata only; never authorizes acceptance, recovery or publication. */
export async function readPublicationActions(
  input: {
    target: 'staging' | 'production';
    builderOrigin?: string;
    runId?: string;
    attempt?: string;
    jobId?: string;
    requestedAt?: string;
    sha: string;
  },
  fetcher: typeof fetch = fetch,
): Promise<ActionsProgress> {
  const destination = publicationDestination(input.target, input.builderOrigin);
  const repository = destination.repository;
  if (
    (input.runId !== undefined
      ? !/^[1-9][0-9]{0,19}$/.test(input.runId) || !/^[1-9][0-9]{0,19}$/.test(input.attempt ?? '')
      : !z.uuid().safeParse(input.jobId).success ||
        !Number.isFinite(Date.parse(input.requestedAt ?? ''))) ||
    !/^[a-f0-9]{40}$/.test(input.sha)
  )
    return { checkedAt: new Date().toISOString(), unavailable: 'ACTIONS_IDENTITY_UNAVAILABLE' };
  const api = `https://api.github.com/repos/PointCommunity/${repository}/actions/runs`;
  let cache = caches.get(fetcher);
  if (!cache) {
    cache = new Map();
    caches.set(fetcher, cache);
  }
  const key = `${api}:${input.runId ?? input.jobId}:${input.attempt ?? ''}:${input.sha}:${input.requestedAt ?? ''}`;
  const prior = cache.get(key);
  if (prior && prior.until > Date.now()) return prior.value;
  // Public API allowance is shared by the host. Milestones refresh every ten seconds;
  // job details refresh once a minute, coalesced across browsers, with provider backoff.
  const entry = {
    until: Date.now() + 60_000,
    value: Promise.resolve<ActionsProgress>({ checkedAt: '' }),
  };
  entry.value = (async () => {
    const checkedAt = new Date().toISOString();
    let unavailable = 'ACTIONS_STATUS_UNAVAILABLE';
    let runProgress: ActionsProgress['run'];
    const read = async (url: string) => {
      const response = await fetcher(url, {
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': 'PointSite-Builder',
          'x-github-api-version': '2022-11-28',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
        const retry = Number(response.headers.get('retry-after')) * 1000;
        entry.until = Math.max(
          entry.until,
          Math.min(
            Date.now() + 3_600_000,
            Math.max(
              Number.isFinite(reset) ? reset : 0,
              Date.now() + (Number.isFinite(retry) && retry > 0 ? retry : 60_000),
            ),
          ),
        );
        unavailable =
          response.status === 403 || response.status === 429 ? 'ACTIONS_RATE_LIMITED' : unavailable;
        throw new Error('Provider unavailable');
      }
      return publicationJson(response, 524_288);
    };
    try {
      const runSchema = z.object({
        id: z.number().int().positive().safe(),
        run_attempt: z.number().int().positive(),
        status: state,
        conclusion,
        head_sha: z.literal(input.sha),
        head_branch: z.literal('main'),
        event: z.literal('repository_dispatch'),
        path: z.enum([
          '.github/workflows/publish-candidate.yml',
          '.github/workflows/publish-candidate.yml@main',
          '.github/workflows/publish-candidate.yml@refs/heads/main',
        ]),
        repository: z.object({
          id: z
            .number()
            .int()
            .refine((id) => String(id) === destination.id),
          full_name: z.literal(`PointCommunity/${repository}`),
        }),
        display_title: z.string(),
        created_at: z.string(),
      });
      let run;
      if (input.runId) {
        run = runSchema.parse(await read(`${api}/${input.runId}/attempts/${input.attempt}`));
        if (String(run.id) !== input.runId || String(run.run_attempt) !== input.attempt)
          throw new Error('Run identity mismatch');
      } else {
        const list = z
          .object({
            total_count: z.number().int().nonnegative(),
            workflow_runs: z.array(z.unknown()).max(100),
          })
          .parse(await read(`${api}?event=repository_dispatch&head_sha=${input.sha}&per_page=100`));
        const matches = list.workflow_runs.flatMap((value) => {
          const parsed = runSchema.safeParse(value);
          if (!parsed.success) return [];
          const valueRun = parsed.data;
          const title =
            input.target === 'staging'
              ? 'Publish Staging candidate'
              : 'Publish accepted public candidate';
          return valueRun.display_title === `${title} ${input.jobId}` &&
            Date.parse(valueRun.created_at) >=
              Math.floor(Date.parse(input.requestedAt!) / 1000) * 1000
            ? [valueRun]
            : [];
        });
        // A truncated listing cannot prove that another matching dispatch is absent.
        if (list.total_count !== list.workflow_runs.length || matches.length !== 1)
          return {
            checkedAt,
            lastSuccessfulCheckAt: checkedAt,
            retryAt: new Date(entry.until).toISOString(),
            unconfirmed: true,
          };
        run = matches[0];
      }
      runProgress = {
        status: run.status,
        conclusion: run.conclusion,
        workflowUrl: `https://github.com/PointCommunity/${repository}/actions/runs/${run.id}`,
      };
      const result = jobsSchema.parse(
        await read(`${api}/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`),
      );
      if (
        result.total_count !== result.jobs.length ||
        result.jobs.some(
          (job) =>
            job.run_id !== run.id ||
            job.run_attempt !== run.run_attempt ||
            job.head_sha !== input.sha,
        )
      )
        throw new Error('Actions identity mismatch');
      const annotated = result.jobs
        .filter(
          (job) => job.conclusion && !['success', 'skipped', 'neutral'].includes(job.conclusion),
        )
        .slice(0, 3);
      const jobs = await Promise.all(
        result.jobs.map(async (job) => {
          const failed =
            job.conclusion && !['success', 'skipped', 'neutral'].includes(job.conclusion);
          if (!failed) return {};
          if (!annotated.includes(job)) return { errorsUnavailable: true };
          try {
            const annotations = await fetcher(
              `https://api.github.com/repos/PointCommunity/${repository}/check-runs/${job.id}/annotations?per_page=20`,
              {
                headers: {
                  accept: 'application/vnd.github+json',
                  'user-agent': 'PointSite-Builder',
                },
                redirect: 'error',
                signal: AbortSignal.timeout(5000),
              },
            );
            if (!annotations.ok) throw new Error('Annotations unavailable');
            const errors = z
              .array(
                z.object({
                  message: z.string().max(16_384),
                  path: z.string().max(1024),
                  start_line: z.number().int(),
                }),
              )
              .max(20)
              .parse(await publicationJson(annotations, 131_072));
            return {
              errors: errors.map((error) => ({
                message: supportText(error.message),
                path: supportText(error.path),
                line: error.start_line,
              })),
            };
          } catch {
            return { errorsUnavailable: true };
          }
        }),
      );
      return {
        checkedAt,
        lastSuccessfulCheckAt: checkedAt,
        retryAt: new Date(entry.until).toISOString(),
        run: runProgress,
        jobs: result.jobs.map((job, index) => ({
          ...jobs[index],
          name: supportText(job.name),
          status: job.status,
          conclusion: job.conclusion,
          workflowUrl: `https://github.com/PointCommunity/${repository}/actions/runs/${run.id}/job/${job.id}`,
          steps: job.steps.map((value) => ({ ...value, name: supportText(value.name) })),
        })),
      };
    } catch {
      const previous = await prior?.value;
      return {
        ...previous,
        ...(runProgress ? { run: runProgress } : {}),
        checkedAt,
        unavailable,
        retryAt: new Date(entry.until).toISOString(),
      };
    }
  })();
  cache.delete(key);
  if (cache.size >= 20) cache.delete(cache.keys().next().value!);
  cache.set(key, entry);
  return entry.value;
}
