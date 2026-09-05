// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { afterEach, describe, expect, it } from 'vitest';
import { RetentionService } from '../../src/server/maintenance/retention';

let miniflare: Miniflare;
afterEach(async () => miniflare?.dispose());

async function setup() {
  miniflare = new Miniflare({
    compatibilityDate: '2026-09-05',
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: { DB: crypto.randomUUID() },
  });
  const database = await miniflare.getD1Database('DB');
  for (const migration of [
    'migrations/0001_initial.sql',
    'migrations/0002_integrity_triggers.sql',
    'migrations/0003_revision_labels.sql',
    'migrations/0004_exact_approvals.sql',
    'migrations/0005_revision_retention.sql',
  ])
    await database.exec((await readFile(migration, 'utf8')).replace(/\s+/g, ' ').trim());

  const document = JSON.stringify({ media: [{ id: 'media-referenced' }] });
  await database.exec(`
    INSERT INTO drafts VALUES ('draft-live','pointsite','Live','revision-current','active','admin','2025-01-01','2026-09-01',NULL);
    INSERT INTO revisions VALUES ('revision-old','draft-live',1,NULL,'${'a'.repeat(64)}','${document}',NULL,1,'1.0.0','admin','2025-01-01');
    INSERT INTO revisions VALUES ('revision-named','draft-live',2,'revision-old','${'b'.repeat(64)}','${document}',NULL,1,'1.0.0','admin','2025-02-01');
    INSERT INTO revisions VALUES ('revision-current','draft-live',3,'revision-named','${'c'.repeat(64)}','${document}',NULL,1,'1.0.0','admin','2026-09-01');
    INSERT INTO revision_labels VALUES ('label-1','revision-named','Before launch','admin','2025-02-01');
    INSERT INTO drafts VALUES ('draft-deleted','pointsite','Deleted','revision-deleted','deleted','admin','2025-01-01','2025-01-01','2025-01-01');
    INSERT INTO revisions VALUES ('revision-deleted','draft-deleted',1,NULL,'${'d'.repeat(64)}','{"media":[]}',NULL,1,'1.0.0','admin','2025-01-01');
    INSERT INTO media_assets VALUES ('media-referenced','private/referenced.png','referenced.png','image/png',10,1,1,'${'e'.repeat(64)}','Alt','ready','admin','2025-01-01','2026-09-01');
    INSERT INTO media_assets VALUES ('media-ready','private/ready.png','ready.png','image/png',10,1,1,'${'f'.repeat(64)}','Alt','ready','admin','2026-08-01',NULL);
    INSERT INTO media_assets VALUES ('media-orphan','private/orphan.png','orphan.png','image/png',10,1,1,'${'1'.repeat(64)}','Alt','orphaned','admin','2025-01-01',NULL);
    INSERT INTO audit_events VALUES ('audit-old','2025-01-01','admin','old','test','old','succeeded','request-old',NULL,'{}');
    INSERT INTO audit_events VALUES ('audit-recent','2026-09-01','admin','recent','test','recent','succeeded','request-recent',NULL,'{}');
  `);
  const deletedKeys: string[] = [];
  return {
    database,
    deletedKeys,
    service: new RetentionService(database, {
      delete: (key: string) => {
        deletedKeys.push(key);
        return Promise.resolve();
      },
    }),
  };
}

describe('retention maintenance', () => {
  it('is a non-mutating, export-checksummed dry run by default', async () => {
    const { database, deletedKeys, service } = await setup();
    const plan = await service.plan(new Date('2026-09-05T12:00:00.000Z'));
    expect(plan.dryRun).toBe(true);
    expect(plan.report).toMatchObject({
      revisionsToDelete: 1,
      draftsToDelete: 1,
      mediaToOrphan: 1,
      mediaToDelete: 1,
      auditEventsToDelete: 1,
    });
    expect(plan.exportChecksum).toMatch(/^[a-f0-9]{64}$/);
    expect(await database.prepare('SELECT COUNT(*) AS count FROM revisions').first()).toEqual({
      count: 4,
    });
    expect(deletedKeys).toEqual([]);
  });

  it('requires the exact saved export, preserves current/named/referenced data, and audits purges', async () => {
    const { database, deletedKeys, service } = await setup();
    const plan = await service.plan(new Date('2026-09-05T12:00:00.000Z'));
    await expect(
      service.apply(plan, '0'.repeat(64), 'admin@pointatx.org', 'retention-request'),
    ).rejects.toThrow('RETENTION_EXPORT_MISMATCH');
    const result = await service.apply(
      plan,
      plan.exportChecksum,
      'admin@pointatx.org',
      'retention-request',
    );
    expect(result.applied).toBe(true);
    const revisions = await database
      .prepare('SELECT id,parent_revision_id FROM revisions ORDER BY sequence')
      .all<{ id: string; parent_revision_id: string | null }>();
    expect(revisions.results).toEqual([
      { id: 'revision-named', parent_revision_id: null },
      { id: 'revision-current', parent_revision_id: 'revision-named' },
    ]);
    expect(await database.prepare("SELECT id FROM drafts WHERE id='draft-live'").first()).toEqual({
      id: 'draft-live',
    });
    expect(
      await database.prepare("SELECT id FROM drafts WHERE id='draft-deleted'").first(),
    ).toBeNull();
    expect(
      await database.prepare("SELECT status FROM media_assets WHERE id='media-ready'").first(),
    ).toEqual({ status: 'orphaned' });
    expect(
      await database.prepare("SELECT id FROM media_assets WHERE id='media-referenced'").first(),
    ).toEqual({ id: 'media-referenced' });
    expect(deletedKeys).toEqual(['private/orphan.png']);
    const audit = await database
      .prepare("SELECT action FROM audit_events WHERE request_id='retention-request'")
      .all<{ action: string }>();
    expect(audit.results.map((item) => item.action)).toEqual(
      expect.arrayContaining([
        'retention.revision.delete',
        'retention.draft.delete',
        'retention.media.orphan',
        'retention.media.delete',
        'retention.audit.delete',
      ]),
    );
  });
});
