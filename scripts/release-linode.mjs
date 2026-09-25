import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import {
  quality,
  validateApproval,
  validateCandidate,
  validateGitops,
  verifyCanary,
  verifyImage,
} from './release-native.mjs';
import { verifyLive } from '../.agents/skills/pointsite-builder-release-production/scripts/verify-live.mjs';

const target = 'root@45.33.2.134';
const homelab = '/Users/chris/Documents/Github/homelab';
const sha = /^[a-f0-9]{40}$/;
const hash = /^[a-f0-9]{64}$/;
const image = /^localhost\/pointsite-builder:[a-f0-9]{40}$/;
const imageId = /^sha256:[a-f0-9]{64}$/;
const command = (file, args, options = {}) =>
  execFileSync(file, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    ...options,
  }).trim();
const git = (...args) => command('git', args);
const gitops = (...args) => command('git', ['-C', homelab, ...args]);

export function validateRoute(values) {
  const production = values.indexOf("hostname: 'builder.eaglepass.io'");
  const wildcard = values.indexOf("hostname: '*.eaglepass.io'");
  if (
    production < 0 ||
    wildcard <= production ||
    values.slice(production, wildcard).match(/service:\s*http:\/\/45\.33\.2\.134:3000\b/g)
      ?.length !== 1 ||
    !values.slice(production, wildcard).includes('httpHostHeader: builder.eaglepass.io') ||
    !/hostname: '\*\.eaglepass\.io'\s*\n\s*service: https:\/\/ingress-nginx-controller\.ingress-nginx\b/.test(
      values.slice(wildcard),
    ) ||
    values.includes("hostname: 'builder-canary.eaglepass.io'")
  )
    throw new Error('LINODE_ROUTE_AND_HOMELAB_CANARY_REQUIRED');
}

export function validateInspection(value) {
  if (
    !hash.test(value?.wrapperHash) ||
    !hash.test(value?.unitHash) ||
    !image.test(value?.previousImage) ||
    !imageId.test(value?.previousImageId)
  )
    throw new Error('LINODE_INSPECTION_REQUIRED');
  return value;
}

export function productionConfigHash(candidate, canaryRevision, inspected) {
  validateCandidate(candidate);
  validateInspection(inspected);
  if (!sha.test(canaryRevision)) throw new Error('CANARY_REVISION_REQUIRED');
  return createHash('sha256')
    .update(
      JSON.stringify({
        target,
        service: 'pointsite-builder.service',
        gitTree: candidate.gitTree,
        canaryImageDigest: candidate.imageDigest,
        canaryRevision,
        ...inspected,
      }),
    )
    .digest('hex');
}

function remote(action, args = []) {
  const script = readFileSync(new URL('./deploy-linode-production.sh', import.meta.url));
  const result = command(
    'ssh',
    [
      '-T',
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      'ConnectTimeout=10',
      target,
      'bash',
      '-s',
      '--',
      action,
      ...args,
    ],
    { input: script, stdio: ['pipe', 'pipe', 'inherit'], timeout: 30 * 60_000 },
  );
  return JSON.parse(result);
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      candidate: { type: 'string' },
      approval: { type: 'string' },
      'gitops-transport': { type: 'string' },
    },
  });
  const [action] = positionals;
  if (positionals.length !== 1 || !['inspect', 'deploy'].includes(action) || !values.candidate)
    throw new Error('Use inspect|deploy --candidate FILE [--approval FILE].');
  if (git('status', '--porcelain', '--untracked-files=all'))
    throw new Error('CLEAN_SOURCE_REQUIRED');
  const mainRevision = git('rev-parse', 'HEAD');
  const gitTree = git('rev-parse', 'HEAD^{tree}');
  if (git('rev-parse', '@{upstream}') !== mainRevision) throw new Error('PUSHED_SOURCE_REQUIRED');
  const candidate = validateCandidate(JSON.parse(await readFile(values.candidate, 'utf8')));
  if (
    candidate.gitTree !== gitTree ||
    (action === 'inspect' && candidate.sourceRevision !== mainRevision)
  )
    throw new Error('APPROVED_SOURCE_TREE_REQUIRED');
  if (
    action === 'deploy' &&
    (git('branch', '--show-current') !== 'main' || mainRevision !== git('rev-parse', 'origin/main'))
  )
    throw new Error('MERGED_MAIN_REQUIRED');
  quality(candidate.sourceRevision);
  if (mainRevision !== candidate.sourceRevision) quality(mainRevision);
  await verifyImage(candidate);
  validateGitops(values['gitops-transport'] ?? 'origin');
  validateRoute(gitops('show', 'HEAD:system/cloudflared/values.yaml'));
  const canaryRevision = verifyCanary(candidate);
  const inspected = validateInspection(remote('inspect'));
  const configHash = productionConfigHash(candidate, canaryRevision, inspected);
  if (action === 'inspect') {
    console.log(
      JSON.stringify({
        ...candidate,
        canaryRevision,
        productionConfigHash: configHash,
        target,
        ...inspected,
      }),
    );
    return;
  }
  if (!values.approval) throw new Error('EXACT_PM_APPROVAL_REQUIRED');
  // The receipt records the PM's actual exact-candidate approval; the CLI never infers it.
  validateApproval(
    candidate,
    JSON.parse(await readFile(values.approval, 'utf8')),
    canaryRevision,
    configHash,
  );
  const released = remote('deploy', [
    mainRevision,
    gitTree,
    inspected.wrapperHash,
    inspected.unitHash,
  ]);
  try {
    if (
      released.previousImage !== inspected.previousImage ||
      released.previousImageId !== inspected.previousImageId ||
      !sha.test(released.previousRevision) ||
      released.newImage !== `localhost/pointsite-builder:${mainRevision}` ||
      released.sourceRevision !== mainRevision ||
      released.gitTree !== gitTree ||
      !imageId.test(released.newImageId) ||
      !/^[0-9a-f-]{36}$/.test(released.preBackupId) ||
      !/^[0-9a-f-]{36}$/.test(released.postBackupId) ||
      released.preBackupId === released.postBackupId ||
      !/^\/usr\/local\/sbin\/pointsite-builder-run\.bak-[0-9]{8}T[0-9]{6}Z-[0-9]+$/.test(
        released.wrapperBackup,
      )
    )
      throw new Error('LINODE_RELEASE_EVIDENCE_MISMATCH');
    await verifyLive('https://builder.eaglepass.io');
    await verifyLive('https://builder-canary.eaglepass.io');
  } catch (error) {
    if (
      sha.test(released.previousRevision) &&
      image.test(released.newImage) &&
      image.test(released.previousImage) &&
      /^\/usr\/local\/sbin\/pointsite-builder-run\.bak-[0-9]{8}T[0-9]{6}Z-[0-9]+$/.test(
        released.wrapperBackup,
      )
    ) {
      let restored;
      try {
        restored = remote('rollback', [
          released.newImage,
          released.previousImage,
          released.wrapperBackup,
          released.previousRevision,
        ]);
      } catch (rollbackError) {
        throw new Error(
          `Linode release failed: ${error.message}; rollback failed: ${rollbackError.message}`,
        );
      }
      if (restored.status !== 'rolled_back') throw new Error('LINODE_ROLLBACK_UNVERIFIED');
      throw new Error(`Linode release failed and rollback ${restored.status}: ${error.message}`);
    }
    throw error;
  }
  console.log(
    JSON.stringify({
      ...released,
      canaryRevision,
      canaryImageDigest: candidate.imageDigest,
      productionConfigHash: configHash,
      target,
      status: 'Linode and public HTTP verified; authenticated smoke test still required',
    }),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
