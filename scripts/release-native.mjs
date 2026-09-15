import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

const homelab = '/Users/chris/Documents/Github/homelab';
const repository = '10.0.20.11:32309/pointsite-builder';
const sha = /^[a-f0-9]{40}$/;
const digest = /^sha256:[a-f0-9]{64}$/;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const command = (file, args, cwd = process.cwd()) =>
  execFileSync(file, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
const git = (...args) => command('git', args);
const gitops = (...args) => command('git', ['-C', homelab, ...args]);

export function validateCandidate(candidate) {
  if (
    !sha.test(candidate?.sourceRevision) ||
    !sha.test(candidate?.gitTree) ||
    !digest.test(candidate?.imageDigest) ||
    candidate.imageDigest === `sha256:${'0'.repeat(64)}` ||
    candidate.repository !== repository ||
    candidate.sourceClean !== true
  )
    throw new Error('COMPLETE_CLEAN_CANDIDATE_REQUIRED');
  return candidate;
}

export function validateApproval(candidate, approval, canaryRevision, productionConfigHash) {
  validateCandidate(candidate);
  if (
    approval?.phrase !== 'Approved to merge and deploy production' ||
    typeof approval.evidence !== 'string' ||
    !approval.evidence.trim() ||
    approval.sourceRevision !== candidate.sourceRevision ||
    approval.gitTree !== candidate.gitTree ||
    approval.imageDigest !== candidate.imageDigest ||
    !sha.test(canaryRevision) ||
    approval.canaryRevision !== canaryRevision ||
    !/^[a-f0-9]{64}$/.test(productionConfigHash) ||
    approval.productionConfigHash !== productionConfigHash
  )
    throw new Error('EXACT_PM_APPROVAL_REQUIRED');
}

async function verifyImage(candidate) {
  const response = await fetch(
    `http://10.0.20.11:32309/v2/pointsite-builder/manifests/${candidate.imageDigest}`,
    {
      headers: {
        accept:
          'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json',
      },
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!response.ok) throw new Error('REGISTRY_IMAGE_UNAVAILABLE');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (`sha256:${hash(bytes)}` !== candidate.imageDigest)
    throw new Error('REGISTRY_DIGEST_MISMATCH');
  const manifest = JSON.parse(bytes);
  if (!digest.test(manifest.config?.digest)) throw new Error('SINGLE_PLATFORM_IMAGE_REQUIRED');
  const configResponse = await fetch(
    `http://10.0.20.11:32309/v2/pointsite-builder/blobs/${manifest.config.digest}`,
    { signal: AbortSignal.timeout(20_000) },
  );
  if (!configResponse.ok) throw new Error('REGISTRY_CONFIG_UNAVAILABLE');
  const configBytes = Buffer.from(await configResponse.arrayBuffer());
  if (`sha256:${hash(configBytes)}` !== manifest.config.digest)
    throw new Error('REGISTRY_CONFIG_MISMATCH');
  const config = JSON.parse(configBytes);
  if (
    config.architecture !== 'amd64' ||
    config.os !== 'linux' ||
    config.config.Labels?.['org.opencontainers.image.revision'] !== candidate.sourceRevision ||
    config.config.Labels?.['io.eaglepass.builder.tree'] !== candidate.gitTree
  )
    throw new Error('IMAGE_SOURCE_MISMATCH');
}

function quality(revision) {
  const checks = JSON.parse(
    command('gh', [
      'api',
      `repos/PointCommunity/pointsite-builder/commits/${revision}/check-runs`,
      '--paginate',
    ]),
  );
  for (const name of [
    'Pipeline contracts',
    'Dependency security',
    'Secret security',
    'Source security',
  ]) {
    const check = checks.check_runs.find(
      (item) =>
        item.name === name && item.head_sha === revision && item.app?.slug === 'github-actions',
    );
    if (check?.conclusion !== 'success') throw new Error(`QUALITY_REQUIRED: ${name}`);
  }
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      connection: { type: 'string' },
      candidate: { type: 'string' },
      approval: { type: 'string' },
      'gitops-transport': { type: 'string' },
    },
  });
  const [action] = positionals;
  if (positionals.length !== 1 || !['build', 'inspect', 'canary', 'production'].includes(action))
    throw new Error(
      'Use build --connection NAME, inspect --candidate FILE, or canary|production --candidate FILE [--approval FILE].',
    );
  if (git('status', '--porcelain', '--untracked-files=all'))
    throw new Error('CLEAN_SOURCE_REQUIRED');
  const sourceRevision = git('rev-parse', 'HEAD');
  const gitTree = git('rev-parse', 'HEAD^{tree}');
  if (git('rev-parse', '@{upstream}') !== sourceRevision) throw new Error('PUSHED_SOURCE_REQUIRED');
  quality(sourceRevision);
  if (action === 'build') {
    if (!/^[a-zA-Z0-9_-]+$/.test(values.connection ?? ''))
      throw new Error('EXPLICIT_LOCAL_PODMAN_CONNECTION_REQUIRED');
    const podman = (...args) => command('podman', ['--connection', values.connection, ...args]);
    command('npm', ['run', 'build:native']);
    const release = JSON.parse(await readFile('dist/release.json', 'utf8'));
    if (
      !release.sourceClean ||
      release.sourceRevision !== sourceRevision ||
      release.gitTree !== gitTree
    )
      throw new Error('BUILD_SOURCE_CHANGED');
    const image = `${repository}:${sourceRevision}`;
    podman(
      'build',
      '--platform',
      'linux/amd64',
      '--label',
      `org.opencontainers.image.revision=${sourceRevision}`,
      '--label',
      `io.eaglepass.builder.tree=${gitTree}`,
      '-t',
      image,
      '-f',
      'Containerfile',
      '.',
    );
    if (
      git('rev-parse', 'HEAD') !== sourceRevision ||
      git('status', '--porcelain', '--untracked-files=all')
    )
      throw new Error('BUILD_SOURCE_CHANGED');
    await mkdir('artifacts', { recursive: true });
    podman('push', '--tls-verify=false', '--digestfile', 'artifacts/native-image-digest', image);
    const candidate = validateCandidate({
      ...release,
      repository,
      imageDigest: (await readFile('artifacts/native-image-digest', 'utf8')).trim(),
    });
    await verifyImage(candidate);
    await writeFile('artifacts/native-candidate.json', JSON.stringify(candidate, null, 2) + '\n');
    console.log(JSON.stringify(candidate));
    return;
  }
  if (!values.candidate) throw new Error('CANDIDATE_FILE_REQUIRED');
  const candidate = validateCandidate(JSON.parse(await readFile(values.candidate, 'utf8')));
  if (
    candidate.gitTree !== gitTree ||
    (action === 'canary' && candidate.sourceRevision !== sourceRevision)
  )
    throw new Error('CANDIDATE_SOURCE_CHANGED');
  await verifyImage(candidate);
  if (
    gitops('remote', 'get-url', 'origin') !== 'git@git.eaglepass.io:ops/homelab.git' ||
    gitops('branch', '--show-current') !== 'master'
  )
    throw new Error('CANONICAL_GITOPS_MASTER_REQUIRED');
  // Optional authenticated kubectl tunnel to the same Gitea service, never another remote.
  const transport = values['gitops-transport'] ?? 'origin';
  if (!['origin', 'http://127.0.0.1:23061/ops/homelab.git'].includes(transport))
    throw new Error('CANONICAL_GITEA_TRANSPORT_REQUIRED');
  gitops('fetch', transport, 'master:refs/remotes/origin/master');
  if (
    gitops('rev-parse', 'HEAD') !== gitops('rev-parse', 'origin/master') ||
    gitops('status', '--porcelain')
  )
    throw new Error('CLEAN_CURRENT_GITOPS_REQUIRED');
  const name = action === 'canary' ? 'builder-canary' : 'builder';
  const source = `release-preparation/builder-${action === 'inspect' ? 'production' : action}`;
  const chart = await readFile(resolve(homelab, source, 'Chart.yaml'), 'utf8');
  const original = await readFile(resolve(homelab, source, 'values.yaml'), 'utf8');
  if ((original.match(/digest: sha256:[a-f0-9]{64}/g) ?? []).length !== 1)
    throw new Error('ONE_IMAGE_PIN_REQUIRED');
  const yaml = original
    .replace(/tag: [^\n]+/, `tag: ${candidate.sourceRevision}`)
    .replace(/digest: sha256:[a-f0-9]{64}/, `digest: ${candidate.imageDigest}`);
  const productionConfigHash = hash(chart + '\0' + yaml);
  if (action === 'inspect') {
    console.log(
      JSON.stringify({
        ...candidate,
        productionConfigHash,
        gitopsRevision: gitops('rev-parse', 'HEAD'),
      }),
    );
    return;
  }
  if (action === 'production') {
    if (
      git('branch', '--show-current') !== 'main' ||
      sourceRevision !== git('rev-parse', 'origin/main')
    )
      throw new Error('MERGED_SOURCE_REQUIRED');
    const argo = JSON.parse(
      command('kubectl', ['-n', 'argocd', 'get', 'application', 'builder-canary', '-o', 'json']),
    );
    if (
      argo.spec.source.repoURL !== 'http://gitea-http.gitea:3000/ops/homelab' ||
      argo.spec.source.targetRevision !== 'master' ||
      argo.spec.source.path !== 'apps/builder-canary'
    )
      throw new Error('CANARY_SOURCE_AUTHORITY_REQUIRED');
    if (argo.status.sync.status !== 'Synced' || argo.status.health.status !== 'Healthy')
      throw new Error('HEALTHY_CANARY_REQUIRED');
    const pods = JSON.parse(
      command('kubectl', [
        '-n',
        'builder-canary',
        'get',
        'pods',
        '-l',
        'app.kubernetes.io/instance=builder-canary',
        '-o',
        'json',
      ]),
    );
    if (
      pods.items.length !== 1 ||
      pods.items[0].status.containerStatuses?.length !== 1 ||
      !pods.items[0].status.containerStatuses.every(
        (s) => s.ready && s.imageID.endsWith('@' + candidate.imageDigest),
      )
    )
      throw new Error('RUNNING_CANARY_DIGEST_REQUIRED');
    if (!values.approval) throw new Error('EXACT_PM_APPROVAL_REQUIRED');
    // This is an agent-recorded receipt of actual PM approval, never permission inferred by the CLI.
    validateApproval(
      candidate,
      JSON.parse(await readFile(values.approval, 'utf8')),
      argo.status.sync.revision,
      productionConfigHash,
    );
    const canaryValues = gitops(
      'show',
      `${argo.status.sync.revision}:apps/builder-canary/values.yaml`,
    );
    if (!canaryValues.includes(`digest: ${candidate.imageDigest}`))
      throw new Error('CANARY_CONFIG_DIGEST_MISMATCH');
  }
  // Agents review storage, backup, auth and cluster preflight before invoking this command.
  const directory = resolve(homelab, 'apps', name);
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, 'Chart.yaml'), chart);
  await writeFile(resolve(directory, 'values.yaml'), yaml);
  command('helm', ['dependency', 'build', directory]);
  command('helm', ['lint', directory]);
  command('helm', ['template', name, directory, '--namespace', name]);
  const previousRevision = gitops('rev-parse', 'HEAD');
  gitops('add', '--', `apps/${name}/Chart.yaml`, `apps/${name}/values.yaml`);
  gitops('diff', '--cached', '--check');
  gitops('commit', '-m', `deploy: ${name} ${candidate.sourceRevision.slice(0, 12)}`);
  gitops('push', transport, 'master');
  console.log(
    JSON.stringify({
      action,
      previousRevision,
      gitopsRevision: gitops('rev-parse', 'HEAD'),
      productionConfigHash,
      ...candidate,
      status: 'GitOps dispatched; live verification required',
    }),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
