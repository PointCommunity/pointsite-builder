// @vitest-environment node
import { expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { exportPKCS8, generateKeyPair, SignJWT } from 'jose';
import { SqliteDatabase } from '../../server/sqlite';
import { migrateDatabase } from '../../server/migrations';
import { createPublicAssets } from '../../server/http';
import { D1DraftRepository } from '../../src/server/repositories/d1';
import { D1DraftAssets } from '../../src/server/media/draft-assets';
import { D1MediaRepository, D1PrivateBucket, MediaService } from '../../src/server/media/service';
import { D1PublishJobStore } from '../../src/server/publish/jobs';
import { D1PublicationRunner } from '../../src/server/publish/runner';
import { defaultSiteDocument } from '../../src/site-kit/default-site';
import { publicationMediaPaths } from '../../src/site-kit/publication-media';
import { publicationClaims } from '../fixtures/publication-runner';
import { publicationGitHubFixture } from '../fixtures/publication-github';

test('independent native Builders cannot overwrite a shared Staging winner or exchange runner tokens', async () => {
  const databases: SqliteDatabase[] = [];
  let sharedMain = 'b'.repeat(40);
  const keys = await generateKeyPair('RS256', { extractable: true });
  const actor = 'github:12345';
  try {
    const candidates = [];
    for (const builderOrigin of [
      'https://builder-canary.eaglepass.io',
      'https://builder.eaglepass.io',
    ]) {
      const database = new SqliteDatabase(':memory:');
      databases.push(database);
      await migrateDatabase(database, 'migrations');
      await database
        .prepare(
          "INSERT INTO user_roles(email,github_login,role,active,created_at,updated_at,updated_by) VALUES (?,'fixture-publisher','administrator',1,'fixture','fixture','fixture')",
        )
        .bind(actor)
        .run();
      const legacy = new MediaService(
        new D1MediaRepository(database),
        new D1PrivateBucket(database),
      );
      const assets = new D1DraftAssets(
        database,
        legacy,
        createPublicAssets(process.cwd() + '/public'),
      );
      const repository = new D1DraftRepository(database, assets, 'compact-v1');
      const draft = await repository.createDraft({
        name: builderOrigin,
        document: defaultSiteDocument,
        actor,
        idempotencyKey: crypto.randomUUID(),
        requestId: crypto.randomUUID(),
      });
      const store = new D1PublishJobStore(database);
      const job = await store.captureStaging({
        draft,
        actor,
        workflowRevision: 'a'.repeat(40),
        baseSha: sharedMain,
        idempotencyKey: crypto.randomUUID(),
        requestId: crypto.randomUUID(),
      });
      const nonce = await database
        .prepare('SELECT nonce FROM publication_runs WHERE job_id=?')
        .bind(job.id)
        .first<string>('nonce');
      const claims = publicationClaims({
        builderOrigin,
        target: 'staging',
        jobId: job.id,
        nonce: nonce!,
        workflowRevision: 'a'.repeat(40),
        dispatchRevision: sharedMain,
      });
      const sign = (checkRunId: string) =>
        new SignJWT({ ...claims, check_run_id: checkRunId })
          .setProtectedHeader({ alg: 'RS256' })
          .sign(keys.privateKey);
      const provider = await publicationGitHubFixture(
        job.id,
        job.candidateChecksum,
        publicationMediaPaths(draft.document),
      );
      provider.build.commitSha = (candidates.length ? '9' : 'c').repeat(40);
      Object.defineProperty(provider.state, 'main', {
        get: () => sharedMain,
        set: (value: string) => {
          sharedMain = value;
        },
      });
      const runner = new D1PublicationRunner(
        database,
        () => Promise.resolve(keys.publicKey),
        {
          builderOrigin,
          appId: '123',
          installationId: '456',
          privateKey: await exportPKCS8(keys.privateKey),
        },
        provider.fetcher,
      );
      await runner.reserve(job.id, await sign('23456'));
      const token = await sign('34567');
      await runner.claim(job.id, token);
      const pinned = await runner.inputs(job.id, token);
      expect(pinned.assets.length).toBeGreaterThan(0);
      for (const asset of pinned.assets) {
        const chunks = [];
        for (let index = 0; index < Math.ceil(asset.byteSize / 1_000_000); index++)
          chunks.push(Buffer.from(await runner.chunk(job.id, token, asset.assetId, index)));
        const bytes = Buffer.concat(chunks);
        expect(bytes.byteLength).toBe(asset.byteSize);
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(asset.checksum);
      }
      await runner.authorizeBuild(job.id, token, provider.build);
      candidates.push({ runner, job, token, provider, store, database });
    }
    const [winner, stale] = candidates;
    await expect(stale.runner.commitBuild(stale.job.id, winner.token)).rejects.toThrow(
      'PUBLISH_RUNNER_UNAUTHORIZED',
    );
    await winner.runner.commitBuild(winner.job.id, winner.token);
    expect(sharedMain).toBe(winner.provider.build.commitSha);
    await expect(stale.runner.commitBuild(stale.job.id, stale.token)).rejects.toThrow(
      'PUBLICATION_COMMIT_UNCONFIRMED',
    );
    expect(sharedMain).toBe(winner.provider.build.commitSha);
    expect(stale.provider.state.mutations).toBe(0);
    expect((await stale.store.getById(stale.job.id))?.resultSha).toBeNull();
    await winner.runner.commitBuild(winner.job.id, winner.token);
    expect(winner.provider.state.mutations).toBe(1);
    expect(
      await winner.database
        .prepare('SELECT 1 FROM publish_jobs WHERE id=?')
        .bind(stale.job.id)
        .first(),
    ).toBeNull();
  } finally {
    for (const database of databases) database.close();
  }
});
