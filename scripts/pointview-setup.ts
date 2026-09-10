import { spawnSync } from 'node:child_process';
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';

const origin = 'https://builder.pointatx.org';
const publicKeySchema = z.object({
  kid: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  jwk: z
    .object({
      kty: z.literal('OKP'),
      crv: z.literal('Ed25519'),
      x: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    })
    .strict(),
  not_before: z.iso.datetime(),
  not_after: z.iso.datetime(),
});
const registrationSchema = z.object({
  slug: z.literal('pointsite-builder'),
  display_name: z.literal('PointSite Builder'),
  github_owner: z.literal('PointCommunity'),
  github_repo: z.literal('pointsite-builder'),
  github_project_node_id: z.literal('PVT_kwDOE0xBLs4Bivi-'),
  github_project_number: z.literal(1),
  github_installation_id: z.number().int().positive(),
  allowed_origins: z.tuple([z.literal(origin)]),
  return_url_prefixes: z.tuple([z.literal(`${origin}/`)]),
  governed_labels: z.array(z.string()),
  public_keys: z.array(publicKeySchema).min(1).max(20),
});

export function validateRegistration(input: unknown, kid: string, publicX: string) {
  const source = registrationSchema.parse(input);
  const key = source.public_keys.find(
    (candidate) => candidate.kid === kid && candidate.jwk.x === publicX,
  );
  if (
    !key ||
    Date.parse(key.not_before) > Date.now() ||
    Date.parse(key.not_after) < Date.now() + 300_000
  )
    throw new Error('Registration must contain the active matching public key.');
  for (const label of ['type:bug', 'type:feature', 'type:maintenance', 'type:security'])
    if (!source.governed_labels.includes(label)) throw new Error('Missing governed label.');
  if (!source.governed_labels.some((label) => label.startsWith('area:')))
    throw new Error('Missing governed area.');
  return source;
}

function command(file: string, args: string[], input?: string) {
  const result = spawnSync(file, args, {
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 120_000,
  });
  // CLI diagnostics may contain secret input. Only expose a fixed failure message.
  if (result.status !== 0)
    throw new Error(`${file} operation failed; no secret diagnostics were printed.`);
  return result.stdout;
}

function readKey(vault: string, item: string) {
  const saved = z
    .object({ fields: z.array(z.object({ id: z.string(), value: z.string().optional() })) })
    .parse(
      JSON.parse(
        command('op', ['item', 'get', item, '--vault', vault, '--format', 'json', '--reveal']),
      ),
    );
  const pem = saved.fields.find((field) => field.id === 'private-key')?.value;
  const kid = saved.fields.find((field) => field.id === 'key-id')?.value;
  if (!pem || !kid) throw new Error('Signing item is incomplete.');
  const privateKey = createPrivateKey(pem);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Expected an Ed25519 key.');
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
  return { pem, kid, jwk };
}

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      vault: { type: 'string' },
      item: { type: 'string' },
      output: { type: 'string' },
      installation: { type: 'string' },
      previous: { type: 'string' },
      registration: { type: 'string' },
    },
  });
  const action = positionals[0];
  if (!['prepare', 'stage', 'disable'].includes(action ?? ''))
    throw new Error(
      'Use prepare --vault --installation --output [--previous], stage --vault --item --registration, or disable.',
    );
  if (action === 'disable') {
    command('npm', ['run', 'cloudflare:verify-account']);
    command('npx', ['wrangler', 'secret', 'bulk'], JSON.stringify({ POINTVIEW_MODE: 'disabled' }));
    console.log(
      'Feedback disabled. Verify the live control disappears; Builder functions remain available.',
    );
    return;
  }
  if (!values.vault) throw new Error('An explicitly approved 1Password vault is required.');
  if (action === 'prepare') {
    if (!values.output || !/^[1-9][0-9]*$/.test(values.installation ?? ''))
      throw new Error('Installation ID and public output path are required.');
    const previous = values.previous
      ? registrationSchema.parse(JSON.parse(readFileSync(values.previous, 'utf8')))
      : undefined;
    const project = z
      .object({
        id: z.literal('PVT_kwDOE0xBLs4Bivi-'),
        number: z.literal(1),
        public: z.literal(false),
      })
      .parse(
        JSON.parse(
          command('gh', ['project', 'view', '1', '--owner', 'PointCommunity', '--format', 'json']),
        ),
      );
    const labels = z
      .array(z.object({ name: z.string() }))
      .parse(
        JSON.parse(
          command('gh', [
            'label',
            'list',
            '--repo',
            'PointCommunity/pointsite-builder',
            '--limit',
            '100',
            '--json',
            'name',
          ]),
        ),
      );
    const kid = `builder-${randomUUID()}`;
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const jwk = publicKey.export({ format: 'jwk' });
    const registration = validateRegistration(
      {
        slug: 'pointsite-builder',
        display_name: 'PointSite Builder',
        github_owner: 'PointCommunity',
        github_repo: 'pointsite-builder',
        github_project_node_id: project.id,
        github_project_number: project.number,
        github_installation_id: Number(values.installation),
        allowed_origins: [origin],
        return_url_prefixes: [`${origin}/`],
        governed_labels: labels
          .map((label) => label.name)
          .filter((label) => /^(type|area):/.test(label)),
        public_keys: [
          ...(previous?.public_keys ?? []),
          {
            kid,
            jwk,
            not_before: new Date(Date.now() - 60_000).toISOString(),
            not_after: new Date(Date.now() + 365 * 86_400_000).toISOString(),
          },
        ],
      },
      kid,
      jwk.x!,
    );
    // The only serialized private key goes directly through stdin into the approved vault.
    const saved = z.object({ id: z.string() }).parse(
      JSON.parse(
        command(
          'op',
          ['item', 'create', '-', '--vault', values.vault, '--format', 'json'],
          JSON.stringify({
            title: `PointSite Builder PointView ${kid}`,
            category: 'SECURE_NOTE',
            fields: [
              { id: 'private-key', label: 'private-key', type: 'CONCEALED', value: pem },
              { id: 'key-id', label: 'key-id', type: 'STRING', value: kid },
            ],
          }),
        ),
      ),
    );
    const recovered = readKey(values.vault, saved.id);
    if (recovered.jwk.x !== jwk.x || recovered.kid !== kid)
      throw new Error('Vault readback did not match.');
    writeFileSync(values.output, JSON.stringify(registration, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    console.log(
      JSON.stringify({
        vaultItemId: saved.id,
        keyId: kid,
        publicRegistration: resolve(values.output),
        next: 'Register the public configuration in PointView, then validate the exact repository and Project before staging.',
      }),
    );
    return;
  }
  if (!values.item || !values.registration)
    throw new Error('Vault item and validated public registration are required.');
  const key = readKey(values.vault, values.item);
  validateRegistration(JSON.parse(readFileSync(values.registration, 'utf8')), key.kid, key.jwk.x!);
  command('npm', ['run', 'cloudflare:verify-account']);
  // Staging a key intentionally does not enable feedback. Release configuration controls rollout.
  command(
    'npx',
    ['wrangler', 'secret', 'bulk'],
    JSON.stringify({ POINTVIEW_PRIVATE_KEY: key.pem, POINTVIEW_KEY_ID: key.kid }),
  );
  console.log(
    'Signing key staged. Require live PointView validation and the verified Builder release before enabling the pilot.',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch {
    console.error(
      'PointView setup failed. Check command arguments, CLI authentication, vault access, and public registration. No private diagnostics were emitted.',
    );
    process.exitCode = 1;
  }
}
