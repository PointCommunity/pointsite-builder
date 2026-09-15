import { z } from 'zod';
import { publicationDestination } from './destinations';
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

/** A recovery-code repair may advance main, but cannot change any published input. */
export async function verifyRecoveryRevision(
  published: string,
  current: string,
  read: (path: string, maximum?: number) => Promise<unknown>,
) {
  sha.parse(published);
  sha.parse(current);
  if (published === current) return;
  const allowed = new Set([
    '.github/workflows/verify-publication.yml',
    '.github/workflows/verify-runtime.yml',
    'scripts/verification-run.mts',
    'scripts/verification-output.mts',
    'tests/verification-output.test.ts',
  ]);
  const tree = z.object({
    sha,
    truncated: z.literal(false),
    tree: z
      .array(
        z.object({
          path: z.string().min(1).max(1024),
          mode: z.string(),
          type: z.enum(['blob', 'tree', 'commit']),
          sha,
        }),
      )
      .max(10_000),
  });
  const leaves = async (revision: string) => {
    const commit = z
      .object({ sha: z.literal(revision), tree: z.object({ sha }) })
      .parse(await read(`/git/commits/${revision}`));
    const value = tree.parse(await read(`/git/trees/${commit.tree.sha}?recursive=1`, 1_000_000));
    if (value.sha !== commit.tree.sha) throw new Error('Recovery tree changed');
    return new Map(
      value.tree.filter((entry) => entry.type !== 'tree').map((entry) => [entry.path, entry]),
    );
  };
  const before = await leaves(published);
  const after = await leaves(current);
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    const old = before.get(path);
    const next = after.get(path);
    if (old?.sha === next?.sha && old?.mode === next?.mode && old?.type === next?.type) continue;
    if (!allowed.has(path) || !next || next.type !== 'blob' || next.mode !== '100644')
      throw new Error('Published inputs changed during recovery');
  }
}

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

/** Actions environment deployments can have null App attribution; the native check owns the link. */
export function verifyDeploymentCheck(
  value: unknown,
  expected: {
    repository: string;
    runId: string;
    checkRunId: string;
    dispatchRevision: string;
    deploymentId: number;
  },
) {
  return z
    .object({
      id: z
        .number()
        .int()
        .refine((id) => String(id) === expected.checkRunId),
      head_sha: z.literal(expected.dispatchRevision),
      details_url: z.literal(
        `https://github.com/${expected.repository}/actions/runs/${expected.runId}/job/${expected.checkRunId}`,
      ),
      app: z.object({ id: z.literal(15368), slug: z.literal('github-actions') }),
      deployment: z.object({ id: z.literal(expected.deploymentId) }),
    })
    .parse(value);
}

/** Native execution identity, current Git state and live release metadata identify different facts. */
export async function verifyDeploymentProof(
  expected: DeploymentExpectation,
  fetcher: typeof fetch = fetch,
  githubToken?: string,
  builderOrigin?: string,
) {
  try {
    const input = proofSchema.parse(expected);
    const staging = input.target === 'staging';
    const destination = publicationDestination(input.target, builderOrigin);
    const repository = `PointCommunity/${destination.repository}`;
    const { environment, origin } = destination;
    const api = `https://api.github.com/repos/${repository}`;
    const jobUrl = `https://github.com/${repository}/actions/runs/${input.runId}/job/${input.checkRunId}`;
    const read = async (url: string, maximum = 32_768): Promise<unknown> => {
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
      return publicationJson(response, maximum);
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
          deployment: z.object({ id: z.number().int().positive() }).nullish(),
        })
        .parse(await read(`${api}/check-runs/${checkRunId}`));
    if (input.verification) {
      if (
        input.verification.runId === input.runId ||
        input.verification.checkRunId === input.checkRunId
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
    const currentRevision = input.verification?.dispatchRevision ?? input.commitSha;
    z.object({ object: z.object({ sha: z.literal(currentRevision) }) }).parse(
      await read(`${api}/git/ref/heads/main`),
    );
    await verifyRecoveryRevision(input.commitSha, currentRevision, (path, maximum) =>
      read(`${api}${path}`, maximum),
    );
    const deploymentsUrl = `${api}/deployments?environment=${environment}&per_page=1`;
    const deploymentSchema = z.object({
      id: z.number().int().positive(),
      sha: z.literal(input.dispatchRevision),
      environment: z.literal(environment),
    });
    const [deployment] = z
      .array(deploymentSchema)
      .length(1)
      .parse(await read(deploymentsUrl));
    verifyDeploymentCheck(original, { ...input, repository, deploymentId: deployment.id });
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
        sourceCommit: sha.optional(),
        ...(staging && input.workerVersionId
          ? { workerVersionId: z.literal(input.workerVersionId) }
          : {}),
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
      format: release.format,
      candidateChecksum: release.candidateChecksum,
      artifactDigest: release.artifactDigest,
      workflowRevision: release.workflowRevision,
      ...('workerVersionId' in release ? { workerVersionId: release.workerVersionId } : {}),
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
