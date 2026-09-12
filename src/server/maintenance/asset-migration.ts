import { checksumDocument } from '../../site-kit/canonicalize';
import { defaultSiteDocument } from '../../site-kit/default-site';
import { SiteDocumentSchema } from '../../site-kit/schema';
import { D1DraftAssets } from '../media/draft-assets';
import { D1PrivateBucket } from '../media/service';

type LegacyRecord = {
  id: string;
  object_key: string;
  filename: string;
  content_type: string;
  byte_size: number;
  checksum: string;
  alt_text: string;
  display_name: string | null;
  tags_json: string;
};
const legacyPath = /^\/assets\/builder\/([a-f0-9-]{36})\.(?:avif|jpe?g|png|webp)$/;
const digest = async (bytes: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
const missingSource = `SELECT r.draft_id,json_extract(item.value,'$.sourcePath') AS source_path
  FROM revisions r,json_each(r.document_json,'$.media') item
  WHERE NOT EXISTS(SELECT 1 FROM draft_asset_bindings b JOIN draft_asset_versions v ON v.id=b.asset_id
    JOIN draft_asset_migration_verified verified ON verified.draft_id=b.draft_id AND verified.source_path=b.source_path
      AND verified.asset_id=v.id AND verified.checksum=v.checksum
    WHERE b.draft_id=r.draft_id AND b.source_path=json_extract(item.value,'$.sourcePath'))`;

/** Resumable conversion. A step copies one owner or recovers one unassigned upload. */
export class D1OwnershipMigration {
  private readonly bucket: D1PrivateBucket;
  private readonly assets: D1DraftAssets;

  constructor(
    private readonly database: D1Database,
    assets?: Pick<Fetcher, 'fetch'>,
  ) {
    this.bucket = new D1PrivateBucket(database);
    this.assets = new D1DraftAssets(database, { read: (id) => this.readLegacy(id) }, assets);
  }

  async status() {
    const state = await this.database
      .prepare('SELECT state FROM draft_asset_migration WHERE id=1')
      .first<{ state: 'pending' | 'complete' }>();
    if (!state) throw new Error('ASSET_MIGRATION_NOT_CONFIGURED');
    const counts = await this.database
      .prepare(
        `SELECT
      (SELECT COUNT(DISTINCT draft_id) FROM (${missingSource})) AS remainingDrafts,
      (SELECT COUNT(*) FROM media_assets) AS legacyAssets,
      (SELECT COALESCE(SUM(byte_size),0) FROM media_object_chunks) AS legacyBytes,
      (SELECT COUNT(*) FROM draft_asset_migration_recovered) AS recoveredUploads`,
      )
      .first<{
        remainingDrafts: number;
        legacyAssets: number;
        legacyBytes: number;
        recoveredUploads: number;
      }>();
    return {
      ...state,
      ...counts,
      remainingDrafts: state.state === 'complete' ? 0 : counts?.remainingDrafts,
    };
  }

  async step(actor: string, requestId: string) {
    if ((await this.status()).state === 'complete') return this.status();
    const next = await this.database
      .prepare(`SELECT DISTINCT draft_id FROM (${missingSource}) ORDER BY draft_id LIMIT 1`)
      .first<{ draft_id: string }>();
    if (next) {
      await this.assets.materializeLegacyDraft(next.draft_id);
      const paths = await this.database
        .prepare(
          `SELECT DISTINCT json_extract(item.value,'$.sourcePath') AS source_path FROM revisions r,json_each(r.document_json,'$.media') item WHERE r.draft_id=?`,
        )
        .bind(next.draft_id)
        .all<{ source_path: string }>();
      for (const { source_path: sourcePath } of paths.results) {
        const object = await this.assets.readForDraft(next.draft_id, sourcePath);
        const checksum = await digest(object.bytes);
        const legacyId = legacyPath.exec(sourcePath)?.[1];
        if (
          legacyId &&
          checksum !==
            (
              await this.database
                .prepare('SELECT checksum FROM media_assets WHERE id=?')
                .bind(legacyId)
                .first<{ checksum: string }>()
            )?.checksum
        )
          throw new Error('MEDIA_STORAGE_CORRUPT');
        await this.verify(next.draft_id, sourcePath, checksum).run();
      }
      return this.status();
    }
    const orphan = await this.database
      .prepare(
        `SELECT m.* FROM media_assets m
      WHERE NOT EXISTS(SELECT 1 FROM revisions r,json_each(r.document_json,'$.media') item
        WHERE instr(json_extract(item.value,'$.sourcePath'),'/assets/builder/'||m.id||'.')=1)
      AND NOT EXISTS(SELECT 1 FROM draft_asset_migration_recovered recovered WHERE recovered.legacy_id=m.id)
      ORDER BY m.id LIMIT 1`,
      )
      .first<LegacyRecord>();
    if (orphan) {
      await this.recover(orphan, await this.readLegacy(orphan.id), actor);
      return this.status();
    }
    const loose = await this.database
      .prepare(
        `SELECT DISTINCT object_key FROM media_object_chunks c WHERE NOT EXISTS(SELECT 1 FROM media_assets m WHERE m.object_key=c.object_key) AND NOT EXISTS(SELECT 1 FROM draft_asset_migration_recovered recovered WHERE recovered.legacy_id='chunk:'||c.object_key) ORDER BY object_key LIMIT 1`,
      )
      .first<{ object_key: string }>();
    if (loose) {
      const bytes = await this.bucket.get(loose.object_key);
      if (!bytes) throw new Error('MEDIA_STORAGE_CORRUPT');
      const extension = loose.object_key.split('.').at(-1) ?? '';
      const contentType = (
        {
          png: 'image/png',
          jpg: 'image/jpeg',
          jpeg: 'image/jpeg',
          webp: 'image/webp',
          avif: 'image/avif',
        } as Record<string, string>
      )[extension];
      if (!contentType) throw new Error('MEDIA_STORAGE_CORRUPT');
      await this.recover(
        {
          id: `chunk:${loose.object_key}`,
          object_key: loose.object_key,
          filename: `recovered.${extension}`,
          content_type: contentType,
          byte_size: bytes.byteLength,
          checksum: await digest(bytes),
          alt_text: 'Recovered upload',
          display_name: 'Recovered upload',
          tags_json: '[]',
        },
        { bytes, contentType, filename: `recovered.${extension}` },
        actor,
      );
      return this.status();
    }
    // The final guard is evaluated in the same transaction as legacy deletion. New
    // revisions or recovery work make the deletion triggers abort the whole batch.
    await this.database.batch([
      this.database
        .prepare(
          `UPDATE draft_asset_migration SET state='complete',completed_at=?,recovery_draft_id=NULL WHERE id=1 AND state='pending'
        AND NOT EXISTS(${missingSource})
        AND NOT EXISTS(SELECT 1 FROM media_assets m WHERE NOT EXISTS(SELECT 1 FROM draft_asset_migration_verified verified JOIN draft_asset_versions v ON v.id=verified.asset_id AND v.checksum=verified.checksum WHERE instr(verified.source_path,'/assets/builder/'||m.id||'.')=1 AND v.checksum=m.checksum) AND NOT EXISTS(SELECT 1 FROM draft_asset_migration_recovered recovered JOIN draft_asset_versions v ON v.id=recovered.asset_id WHERE recovered.legacy_id=m.id AND v.checksum=m.checksum))
        AND NOT EXISTS(SELECT 1 FROM media_object_chunks c WHERE NOT EXISTS(SELECT 1 FROM media_assets m WHERE m.object_key=c.object_key) AND NOT EXISTS(SELECT 1 FROM draft_asset_migration_recovered recovered JOIN draft_asset_versions v ON v.id=recovered.asset_id WHERE recovered.legacy_id='chunk:'||c.object_key))`,
        )
        .bind(new Date().toISOString()),
      this.database.prepare('DELETE FROM media_object_chunks'),
      this.database.prepare(
        "UPDATE audit_events SET metadata_json='{}' WHERE target_type='media' AND target_id IN (SELECT id FROM media_assets)",
      ),
      this.database.prepare('DELETE FROM media_assets'),
      this.database
        .prepare(
          "INSERT INTO audit_events(id,occurred_at,actor,action,target_type,target_id,outcome,request_id,metadata_json) SELECT ?,?,?,'draft-assets.migrated','maintenance','draft-assets','succeeded',?,'{}' WHERE (SELECT state FROM draft_asset_migration WHERE id=1)='complete'",
        )
        .bind(crypto.randomUUID(), new Date().toISOString(), actor, requestId),
    ]);
    return this.status();
  }

  private async readLegacy(id: string) {
    const row = await this.database
      .prepare('SELECT * FROM media_assets WHERE id=?')
      .bind(id)
      .first<LegacyRecord>();
    if (!row) throw new Error('MEDIA_NOT_FOUND');
    const bytes = await this.bucket.get(row.object_key);
    if (!bytes || bytes.byteLength !== row.byte_size || (await digest(bytes)) !== row.checksum)
      throw new Error('MEDIA_STORAGE_CORRUPT');
    return { bytes, contentType: row.content_type, filename: row.filename };
  }

  private verify(draftId: string, sourcePath: string, checksum: string) {
    return this.database
      .prepare(
        `INSERT OR IGNORE INTO draft_asset_migration_verified(draft_id,source_path,asset_id,checksum)
      SELECT b.draft_id,b.source_path,v.id,v.checksum FROM draft_asset_bindings b JOIN draft_asset_versions v ON v.id=b.asset_id
      WHERE b.draft_id=? AND b.source_path=? AND v.checksum=?`,
      )
      .bind(draftId, sourcePath, checksum);
  }

  private async recover(
    record: LegacyRecord,
    object: { bytes: Uint8Array; contentType: string; filename: string },
    actor: string,
  ) {
    let recovery = await this.database
      .prepare(
        'SELECT d.id,r.id AS revision_id,r.sequence,r.document_json FROM draft_asset_migration migration JOIN drafts d ON d.id=migration.recovery_draft_id JOIN revisions r ON r.id=d.latest_revision_id WHERE migration.id=1',
      )
      .first<{ id: string; revision_id: string; sequence: number; document_json: string }>();
    let document = recovery ? SiteDocumentSchema.parse(JSON.parse(recovery.document_json)) : null;
    if (document && document.media.length >= 500) {
      recovery = null;
      document = null;
    }
    const now = new Date().toISOString();
    const draftId = recovery?.id ?? crypto.randomUUID();
    document ??= SiteDocumentSchema.parse({
      ...defaultSiteDocument,
      pages: [
        {
          id: crypto.randomUUID(),
          title: 'Recovered uploads',
          route: '/',
          status: 'draft',
          metadata: {
            title: 'Recovered uploads',
            description: 'Unassigned private uploads preserved during ownership migration.',
          },
          blocks: [],
        },
      ],
      navigation: [],
      forms: [],
      media: [],
      linkedMedia: [],
      collections: { people: [], beliefs: [], groups: [], events: [] },
    });
    const image = await this.assets.prepareImage(draftId, object.bytes, {
      filename: record.filename,
      contentType: object.contentType,
      altText: record.alt_text || 'Recovered upload',
      actor,
      now,
    });
    document.media.push({
      id: crypto.randomUUID(),
      sourcePath: image.sourcePath,
      alt: record.alt_text,
      ...(record.display_name ? { displayName: record.display_name } : {}),
      tags: JSON.parse(record.tags_json) as string[],
    });
    document = SiteDocumentSchema.parse(document);
    const revisionId = crypto.randomUUID();
    const statements = [
      ...(recovery
        ? []
        : [
            this.database
              .prepare(
                "INSERT INTO drafts(id,site_id,name,status,created_by,created_at,updated_at) VALUES (?,'pointsite','Recovered legacy uploads','archived',?,?,?)",
              )
              .bind(draftId, actor, now, now),
          ]),
      ...image.statements,
      this.database
        .prepare(
          'INSERT INTO revisions(id,draft_id,sequence,parent_revision_id,checksum,document_json,schema_version,renderer_version,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        )
        .bind(
          revisionId,
          draftId,
          (recovery?.sequence ?? 0) + 1,
          recovery?.revision_id ?? null,
          await checksumDocument(document),
          JSON.stringify(document),
          document.schemaVersion,
          document.rendererVersion,
          actor,
          now,
        ),
      this.database
        .prepare('UPDATE drafts SET latest_revision_id=?,updated_at=? WHERE id=?')
        .bind(revisionId, now, draftId),
      this.database
        .prepare(
          'INSERT INTO draft_asset_migration_recovered(legacy_id,draft_id,asset_id) VALUES (?,?,?)',
        )
        .bind(record.id, draftId, image.assetId),
      this.database
        .prepare('UPDATE draft_asset_migration SET recovery_draft_id=? WHERE id=1')
        .bind(draftId),
    ];
    await this.database.batch(statements);
    const copied = await this.assets.readForDraft(draftId, image.sourcePath);
    if ((await digest(copied.bytes)) !== record.checksum) throw new Error('MEDIA_STORAGE_CORRUPT');
    await this.verify(draftId, image.sourcePath, record.checksum).run();
  }
}
