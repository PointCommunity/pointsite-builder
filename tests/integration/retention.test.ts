// @vitest-environment node
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalize, checksumDocument } from '../../src/site-kit/canonicalize';
import { defaultSiteDocument } from '../../src/site-kit/default-site';
import { prepareRevisionPayload } from '../../src/server/repositories/revision-payloads';
import { D1LibraryProjection } from '../../src/server/media/library-projection';
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
  for (const migration of (await readdir('migrations'))
    .filter((file) => file.endsWith('.sql'))
    .sort())
    await database.exec(
      (await readFile(`migrations/${migration}`, 'utf8'))
        .replace(/--[^\n]*/g, '')
        .replace(/\s+/g, ' ')
        .trim(),
    );

  const document = JSON.stringify(defaultSiteDocument).replaceAll("'", "''");
  await database.exec(`
    INSERT INTO user_roles(email,role,active,created_at,updated_at,updated_by) VALUES ('admin@pointatx.org','administrator',1,'2025-01-01','2025-01-01','fixture');
    INSERT INTO drafts VALUES ('draft-live','pointsite','Live','revision-current','active','admin','2025-01-01','2026-09-01',NULL);
    INSERT INTO revisions (id,draft_id,sequence,parent_revision_id,checksum,document_json,label,schema_version,renderer_version,created_by,created_at) VALUES ('revision-old','draft-live',1,NULL,'${'a'.repeat(64)}','${document}',NULL,1,'1.0.0','admin','2025-01-01');
    INSERT INTO revisions (id,draft_id,sequence,parent_revision_id,checksum,document_json,label,schema_version,renderer_version,created_by,created_at) VALUES ('revision-named','draft-live',2,'revision-old','${'b'.repeat(64)}','${document}',NULL,1,'1.0.0','admin','2025-02-01');
    INSERT INTO revisions (id,draft_id,sequence,parent_revision_id,checksum,document_json,label,schema_version,renderer_version,created_by,created_at) VALUES ('revision-current','draft-live',3,'revision-named','${'c'.repeat(64)}','${document}',NULL,1,'1.0.0','admin','2026-09-01');
    INSERT INTO revision_labels VALUES ('label-1','revision-named','Before launch','admin','2025-02-01');
    INSERT INTO drafts VALUES ('draft-deleted','pointsite','Deleted','revision-deleted','deleted','admin','2025-01-01','2025-01-01','2025-01-01');
    INSERT INTO revisions (id,draft_id,sequence,parent_revision_id,checksum,document_json,label,schema_version,renderer_version,created_by,created_at) VALUES ('revision-deleted','draft-deleted',1,NULL,'${'d'.repeat(64)}','{"media":[]}',NULL,1,'1.0.0','admin','2025-01-01');
    INSERT INTO audit_events VALUES ('audit-old','2025-01-01','admin','old','test','old','succeeded','request-old',NULL,'{}');
    INSERT INTO audit_events VALUES ('audit-recent','2026-09-01','admin','recent','test','recent','succeeded','request-recent',NULL,'{}');
  `);
  return { database, service: new RetentionService(database) };
}

describe('retention maintenance', () => {
  it.each([
    "UPDATE user_roles SET active=0 WHERE email='admin@pointatx.org'",
    "UPDATE drafts SET latest_revision_id='revision-old' WHERE id='draft-live'",
    "UPDATE drafts SET status='archived',deleted_at=NULL WHERE id='draft-deleted'",
    "INSERT INTO revision_labels VALUES ('late-label','revision-old','Keep','admin','2026-09-12')",
  ])('rolls back when authority or eligibility changes at commit: %s', async (change) => {
    const { database, service } = await setup();
    const plan = await service.plan();
    const raced = new RetentionService(
      new Proxy(database, {
        get(target, property) {
          if (property === 'batch')
            return async (statements: D1PreparedStatement[]) => {
              await database.prepare(change).run();
              return database.batch(statements);
            };
          const value: unknown = Reflect.get(target, property);
          return typeof value === 'function' ? (value.bind(target) as unknown) : value;
        },
      }),
    );
    await expect(
      raced.apply(plan, plan.exportChecksum, 'admin@pointatx.org', 'raced-retention'),
    ).rejects.toThrow('RETENTION_STATE_CHANGED');
    expect(await database.prepare('SELECT COUNT(*) FROM revisions').first('COUNT(*)')).toBe(4);
    expect(
      await database
        .prepare("SELECT COUNT(*) FROM audit_events WHERE request_id='raced-retention'")
        .first('COUNT(*)'),
    ).toBe(0);
  });

  it('drains compact deleted histories in bounded recoverable batches and rolls back a late failure', async () => {
    const { database } = await setup();
    const documents = new Map<string, string>();
    for (let sequence = 2; sequence <= 24; sequence++) {
      const document = structuredClone(defaultSiteDocument);
      document.site.shortName = `Retained version ${sequence}`;
      const id = `deleted-${sequence}`;
      const payload = await prepareRevisionPayload(database, {
        id,
        draftId: 'draft-deleted',
        sequence,
        document,
      });
      await database.batch([
        database
          .prepare(
            `INSERT INTO revisions (id,draft_id,sequence,parent_revision_id,checksum,document_json,schema_version,renderer_version,created_by,created_at)
          VALUES (?,'draft-deleted',?,?,?,'{}',1,'1.0.0','admin','2025-01-01')`,
          )
          .bind(
            id,
            sequence,
            sequence === 2 ? 'revision-deleted' : `deleted-${sequence - 1}`,
            await checksumDocument(document),
          ),
        ...payload.statements,
      ]);
      documents.set(id, canonicalize(document));
    }
    await database
      .prepare("UPDATE drafts SET latest_revision_id='deleted-24' WHERE id='draft-deleted'")
      .run();
    await database
      .prepare(
        `INSERT INTO idempotency_keys(scope,idempotency_key,actor,request_hash,status_code,response_json,created_at,expires_at)
      VALUES ('save','retention-retry-key','admin',?,200,?,'2025-01-01','9999-12-31T23:59:59.999Z')`,
      )
      .bind(
        'a'.repeat(64),
        JSON.stringify({
          id: 'draft-deleted',
          latestRevisionId: 'deleted-24',
          document: defaultSiteDocument,
        }),
      )
      .run();
    for (let i = 0; i < 4; i++)
      await database
        .prepare(
          `INSERT INTO audit_events(id,occurred_at,actor,action,target_type,target_id,outcome,request_id,metadata_json)
      VALUES (?,'2025-01-01','admin','fixture','test','fixture','succeeded','fixture','{}')`,
        )
        .bind(`old-${i}`)
        .run();
    let prepared = 0;
    let fail = true;
    const measured = new RetentionService(
      new Proxy(database, {
        get(target, property) {
          if (property === 'prepare')
            return (sql: string) => {
              prepared++;
              return database.prepare(sql);
            };
          if (property === 'batch')
            return (statements: D1PreparedStatement[]) =>
              database.batch(
                fail
                  ? [...statements, database.prepare("SELECT json('injected-failure')")]
                  : statements,
              );
          const value: unknown = Reflect.get(target, property);
          return typeof value === 'function' ? (value.bind(target) as unknown) : value;
        },
      }),
    );
    const projection = new D1LibraryProjection(database);
    await projection.backfill('draft-live');
    await expect(projection.requireCoverage('draft-live', 3)).resolves.toEqual(expect.any(String));
    const initial = await measured.plan();
    await expect(
      measured.applyCurrent(initial.exportChecksum, 'admin@pointatx.org', 'failed-drain'),
    ).rejects.toThrow();
    expect(
      await database
        .prepare("SELECT COUNT(*) FROM revisions WHERE draft_id='draft-deleted'")
        .first('COUNT(*)'),
    ).toBe(24);
    expect(
      await database
        .prepare(
          "SELECT status_code FROM idempotency_keys WHERE idempotency_key='retention-retry-key'",
        )
        .first('status_code'),
    ).toBe(200);
    expect(
      await database
        .prepare("SELECT COUNT(*) FROM audit_events WHERE request_id='failed-drain'")
        .first('COUNT(*)'),
    ).toBe(0);
    fail = false;
    const exported = new Set<string>();
    let passes = 0;
    let peakStatements = 0;
    while (await database.prepare("SELECT id FROM drafts WHERE id='draft-deleted'").first()) {
      expect(++passes).toBeLessThan(10);
      const plan = await measured.plan();
      expect(
        plan.export.revisions.length + plan.export.deletedDraftRevisions.length,
      ).toBeLessThanOrEqual(6);
      for (const row of plan.export.deletedDraftRevisions) {
        expect(exported.has(row.id)).toBe(false);
        exported.add(row.id);
        if (documents.has(row.id))
          expect(canonicalize(JSON.parse(row.document_json))).toBe(documents.get(row.id));
      }
      prepared = 0;
      await measured.applyCurrent(plan.exportChecksum, 'admin@pointatx.org', 'drain');
      peakStatements = Math.max(peakStatements, prepared);
      expect(prepared).toBeLessThan(45);
      expect(
        await database
          .prepare(
            "SELECT response_json FROM idempotency_keys WHERE idempotency_key='retention-retry-key'",
          )
          .first('response_json'),
      ).toBe('{"deleted":true}');
    }
    expect(passes).toBeGreaterThan(1);
    expect(peakStatements).toBeGreaterThan(20);
    expect(exported.size).toBe(24);
    expect(await database.prepare('SELECT COUNT(*) FROM revision_payloads').first('COUNT(*)')).toBe(
      0,
    );
    expect(
      await database.prepare("SELECT id FROM drafts WHERE id='draft-live'").first(),
    ).not.toBeNull();
    await expect(projection.requireCoverage('draft-live', 3)).rejects.toThrow();
    expect((await projection.backfill('draft-live')).processed).toBe(2);
    await expect(projection.requireCoverage('draft-live', 3)).resolves.toEqual(expect.any(String));
  }, 30_000);

  it('bounds exports and rejects a revision named after the dry run without side effects', async () => {
    const { database, service } = await setup();
    const plan = await service.plan();
    await database
      .prepare(
        "INSERT INTO revision_labels VALUES ('late-label','revision-old','Keep this','admin','2026-09-12')",
      )
      .run();
    await expect(
      service.apply(plan, plan.exportChecksum, 'admin@pointatx.org', 'stale-retention'),
    ).rejects.toThrow();
    expect(
      await database.prepare("SELECT id FROM revisions WHERE id='revision-old'").first(),
    ).not.toBeNull();
    expect(
      await database
        .prepare("SELECT COUNT(*) FROM audit_events WHERE request_id='stale-retention'")
        .first('COUNT(*)'),
    ).toBe(0);
  });

  it('caps decoded revision exports at six per maintenance invocation', async () => {
    const { database, service } = await setup();
    for (let sequence = 4; sequence <= 84; sequence++)
      await database
        .prepare(
          `INSERT INTO revisions (id,draft_id,sequence,checksum,document_json,schema_version,renderer_version,created_by,created_at)
        VALUES (?,'draft-live',?,?,'{"media":[]}',1,'1.0.0','admin','2025-01-01')`,
        )
        .bind(`bounded-${sequence}`, sequence, 'a'.repeat(64))
        .run();
    const plan = await service.plan();
    expect(
      plan.export.revisions.length + plan.export.deletedDraftRevisions.length,
    ).toBeLessThanOrEqual(6);
  });

  it('is a non-mutating, export-checksummed dry run by default', async () => {
    const { database, service } = await setup();
    const plan = await service.plan();
    expect(plan.dryRun).toBe(true);
    expect(plan.report).toMatchObject({
      revisionsToDelete: 1,
      draftsToDelete: 1,
      mediaToOrphan: 0,
      mediaToDelete: 0,
      auditEventsToDelete: 1,
    });
    expect(plan.exportChecksum).toMatch(/^[a-f0-9]{64}$/);
    expect(await database.prepare('SELECT COUNT(*) AS count FROM revisions').first()).toEqual({
      count: 4,
    });
  });

  it('requires the exact saved export, preserves current/named data, and audits purges', async () => {
    const { database, service } = await setup();
    const plan = await service.plan();
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
    const audit = await database
      .prepare("SELECT action FROM audit_events WHERE request_id='retention-request'")
      .all<{ action: string }>();
    expect(audit.results.map((item) => item.action)).toEqual(
      expect.arrayContaining([
        'retention.revision.delete',
        'retention.draft.delete',
        'retention.audit.delete',
      ]),
    );
  });
});
