import { z } from 'zod';
import { publicationJson } from './build-proof';

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z.string().regex(/^[1-9][0-9]{0,19}$/);
const conclusion = z.enum([
  'action_required',
  'cancelled',
  'failure',
  'neutral',
  'success',
  'skipped',
  'stale',
  'timed_out',
]);
const nativeState = z.enum(['success', 'failure', 'error']);
const verificationSchema = z.strictObject({
  runId: identifier,
  checkRunId: identifier,
  dispatchRevision: sha,
  workflowRevision: sha,
  originalConclusion: conclusion.optional(),
  originalDeploymentState: nativeState.optional(),
});
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
  verification: verificationSchema.optional(),
});
export type DeploymentExpectation = z.infer<typeof proofSchema>;

export const PublicationEvidenceSchema = z.strictObject({
  format: z.literal(2),
  verificationStatus: z.literal('passed'),
  deploymentId: identifier,
  runId: identifier,
  checkRunId: identifier,
  dispatchRevision: sha,
  commitSha: sha,
  workflowRevision: sha,
  candidateChecksum: digest,
  artifactDigest: digest,
  workerVersionId: z.uuid().optional(),
  verification: verificationSchema
    .extend({ originalConclusion: conclusion, originalDeploymentState: nativeState })
    .optional(),
  jobUrl: z.url(),
  deploymentUrl: z.url(),
});

/** Native execution identity, current Git state and live release metadata identify different facts. */
export async function verifyDeploymentProof(
  expected: DeploymentExpectation,
  fetcher: typeof fetch = fetch,
  githubToken?: string,
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
          ...(githubToken && url.startsWith(`${api}/`)
            ? { authorization: `Bearer ${githubToken}` }
            : {}),
        },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error('Unconfirmed provider response');
      return publicationJson(response, 32_768);
    };
    const execution = async (
      runId: string,
      checkRunId: string,
      dispatchRevision: string,
      mustSucceed: boolean,
    ) =>
      z
        .object({
          id: z
            .number()
            .int()
            .refine((id) => String(id) === checkRunId),
          status: z.literal('completed'),
          conclusion: mustSucceed ? z.literal('success') : conclusion,
          head_sha: z.literal(dispatchRevision),
          details_url: z.literal(
            `https://github.com/${repository}/actions/runs/${runId}/job/${checkRunId}`,
          ),
          app: z.object({ id: z.literal(15368), slug: z.literal('github-actions') }),
        })
        .parse(await read(`${api}/check-runs/${checkRunId}`));
    if (input.verification) {
      if (
        input.verification.runId === input.runId ||
        input.verification.checkRunId === input.checkRunId ||
        input.verification.dispatchRevision !== input.commitSha
      )
        throw new Error('Verification execution is not independent');
      await execution(
        input.verification.runId,
        input.verification.checkRunId,
        input.verification.dispatchRevision,
        true,
      );
    }
    const original = await execution(
      input.runId,
      input.checkRunId,
      input.dispatchRevision,
      !input.verification,
    );
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
    const [status] = z
      .array(
        z.object({
          state: input.verification ? nativeState : z.literal('success'),
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
      ...(input.verification
        ? {
            verification: {
              ...input.verification,
              originalConclusion: original.conclusion,
              originalDeploymentState: status.state,
            },
          }
        : {}),
    };
  } catch {
    // Do not log provider bodies or treat an incomplete probe as successful publication.
    throw new Error('PUBLICATION_VERIFICATION_UNCONFIRMED');
  }
}

/** A missing runner acknowledgement requires independent Cloudflare traffic and version evidence. */
export async function verifyStagingDeployment(
  commitSha: string,
  candidateChecksum: string,
  readToken: string,
  fetcher: typeof fetch = fetch,
) {
  try {
    sha.parse(commitSha);
    digest.parse(candidateChecksum);
    z.string().min(1).max(4096).parse(readToken);
    const api =
      'https://api.cloudflare.com/client/v4/accounts/bc890091d86ddf9ce669e96e79d47746/workers/scripts/pointsite-staging';
    const read = async (path: string) =>
      publicationJson(
        await fetcher(`${api}${path}`, {
          headers: { authorization: `Bearer ${readToken}`, 'cache-control': 'no-cache' },
          redirect: 'error',
          signal: AbortSignal.timeout(10_000),
        }),
        65_536,
      );
    const active = async () => {
      const response = z
        .object({
          success: z.literal(true),
          result: z.object({ deployments: z.array(z.unknown()).min(1).max(100) }),
        })
        .parse(await read('/deployments'));
      return z
        .object({
          id: z.uuid(),
          versions: z
            .array(z.object({ version_id: z.uuid(), percentage: z.literal(100) }))
            .length(1),
        })
        .parse(response.result.deployments[0]);
    };
    const deployment = await active();
    const workerVersionId = deployment.versions[0].version_id;
    z.object({
      success: z.literal(true),
      result: z.object({
        id: z.literal(workerVersionId),
        annotations: z.object({
          'workers/tag': z.literal(commitSha),
          'workers/message': z.literal(`Staging candidate ${candidateChecksum} from ${commitSha}`),
        }),
      }),
    }).parse(await read(`/versions/${workerVersionId}`));
    const after = await active();
    if (after.id !== deployment.id || after.versions[0].version_id !== workerVersionId)
      throw new Error('Native deployment changed');
    return { deploymentId: deployment.id, workerVersionId };
  } catch {
    throw new Error('PUBLICATION_VERIFICATION_UNCONFIRMED');
  }
}
