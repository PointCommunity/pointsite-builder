import { z } from 'zod';
import { publicationJson } from './build-proof';

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z.string().regex(/^[1-9][0-9]{0,19}$/);
const proofSchema = z.strictObject({
  target: z.enum(['staging', 'production']),
  runId: identifier,
  checkRunId: identifier,
  dispatchRevision: sha,
  commitSha: sha,
  workflowRevision: sha,
  candidateChecksum: digest,
  artifactDigest: digest,
  workerVersionId: z.uuid().optional(),
});
export type DeploymentExpectation = z.infer<typeof proofSchema>;

/** Native execution identity, current Git state and live release metadata identify different facts. */
export async function verifyDeploymentProof(
  expected: DeploymentExpectation,
  fetcher: typeof fetch = fetch,
) {
  try {
    const input = proofSchema.parse(expected);
    if (input.target === 'staging' && !input.workerVersionId)
      throw new Error('Missing Worker identity');
    const staging = input.target === 'staging';
    const repository = `PointCommunity/${staging ? 'pointsite-staging' : 'pointsite'}`;
    const environment = staging ? 'staging' : 'github-pages';
    const origin = staging ? 'https://staging.pointatx.org' : 'https://pointatx.org';
    const api = `https://api.github.com/repos/${repository}`;
    const jobUrl = `https://github.com/${repository}/actions/runs/${input.runId}/job/${input.checkRunId}`;
    const read = async (url: string): Promise<unknown> => {
      const response = await fetcher(url, {
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': 'PointSite-Builder',
          'cache-control': 'no-cache',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error('Unconfirmed provider response');
      return publicationJson(response, 32_768);
    };
    z.object({
      id: z
        .number()
        .int()
        .refine((id) => String(id) === input.checkRunId),
      status: z.literal('completed'),
      conclusion: z.literal('success'),
      head_sha: z.literal(input.dispatchRevision),
      details_url: z.literal(jobUrl),
      app: z.object({ id: z.literal(15368), slug: z.literal('github-actions') }),
    }).parse(await read(`${api}/check-runs/${input.checkRunId}`));
    // The dispatch commit identifies the workflow event. The new content commit
    // identifies the immutable published inputs; never report them as one SHA.
    z.object({ object: z.object({ sha: z.literal(input.commitSha) }) }).parse(
      await read(`${api}/git/ref/heads/main`),
    );
    const deploymentsUrl = `${api}/deployments?environment=${environment}&per_page=1`;
    const deploymentSchema = z.object({
      id: z.number().int().positive(),
      sha: z.literal(input.dispatchRevision),
      environment: z.literal(environment),
      performed_via_github_app: z.object({
        id: z.literal(15368),
        slug: z.literal('github-actions'),
      }),
    });
    const [deployment] = z
      .array(deploymentSchema)
      .length(1)
      .parse(await read(deploymentsUrl));
    z.array(
      z.object({
        state: z.literal('success'),
        environment: z.literal(environment),
        log_url: z.literal(jobUrl),
        environment_url: z.string().refine((url) => {
          try {
            const parsed = new URL(url);
            return (
              ['https:', 'http:'].includes(parsed.protocol) &&
              parsed.hostname === new URL(origin).hostname &&
              !parsed.username &&
              !parsed.password &&
              !parsed.port &&
              parsed.pathname === '/' &&
              !parsed.search &&
              !parsed.hash
            );
          } catch {
            return false;
          }
        }),
      }),
    )
      .length(1)
      .parse(await read(`${api}/deployments/${deployment.id}/statuses?per_page=1`));
    const release = z
      .strictObject({
        format: z.literal(2),
        candidateChecksum: z.literal(input.candidateChecksum),
        artifactDigest: z.literal(input.artifactDigest),
        workflowRevision: z.literal(input.workflowRevision),
        ...(staging ? { workerVersionId: z.literal(input.workerVersionId!) } : {}),
      })
      .parse(await read(`${origin}/__pointsite_release.json`));
    const [after] = z
      .array(deploymentSchema)
      .length(1)
      .parse(await read(deploymentsUrl));
    if (after.id !== deployment.id) throw new Error('Deployment changed during verification');
    return {
      deploymentId: String(deployment.id),
      runId: input.runId,
      checkRunId: input.checkRunId,
      dispatchRevision: input.dispatchRevision,
      commitSha: input.commitSha,
      jobUrl,
      deploymentUrl: origin,
      ...release,
    };
  } catch {
    // Do not log provider bodies or treat an incomplete probe as successful publication.
    throw new Error('PUBLICATION_VERIFICATION_UNCONFIRMED');
  }
}
