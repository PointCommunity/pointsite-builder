import type { SiteDocument } from '../../site-kit/types';
import { ConflictError, NotFoundError } from '../repositories/memory';
import { validateImageUpload } from './policy';
import type { MediaService } from './service';
import { assertNoPrivateBuilderLinks } from '../../shared/private-media-links';

const imagePath =
  /^\/assets\/(?:[a-z0-9][a-z0-9_-]*\/)*[a-z0-9][a-z0-9_-]*\.(?:avif|jpe?g|png|webp)$/;
const ownedPath =
  /^\/assets\/builder\/([a-f0-9-]{36})\/([a-f0-9-]{36})\/[a-z0-9][a-z0-9_-]*\.(?:avif|jpe?g|png|webp)$/;
const legacyUploadPath = /^\/assets\/builder\/([a-f0-9-]{36})\.(?:avif|jpe?g|png|webp)$/;
const chunkBytes = 1_000_000;

export interface DraftAssetObject {
  bytes: Uint8Array;
  contentType: string;
  filename: string;
}

interface AssetRow {
  id: string;
  draft_id: string;
  source_path: string;
  filename: string;
  content_type: string;
  byte_size: number;
  width: number;
  height: number;
  checksum: string;
}

interface AssetChunk {
  chunk_index: number;
  byte_size: number;
  bytes: ArrayBuffer;
}

async function decodeAsset(row: AssetRow, chunks: AssetChunk[]): Promise<DraftAssetObject> {
  const bytes = new Uint8Array(row.byte_size);
  let offset = 0;
  for (const [index, chunk] of chunks.entries()) {
    const data = new Uint8Array(chunk.bytes);
    if (
      chunk.chunk_index !== index ||
      data.byteLength !== chunk.byte_size ||
      offset + data.byteLength > bytes.byteLength
    )
      throw new Error('MEDIA_STORAGE_CORRUPT');
    bytes.set(data, offset);
    offset += data.byteLength;
  }
  if (offset !== row.byte_size) throw new Error('MEDIA_STORAGE_CORRUPT');
  const checksum = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.buffer))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  if (checksum !== row.checksum) throw new Error('MEDIA_STORAGE_CORRUPT');
  return { bytes, contentType: row.content_type, filename: row.filename };
}

export class D1DraftAssets {
  constructor(
    private readonly database: D1Database,
    private readonly legacy: Pick<MediaService, 'read'>,
    private readonly assets?: Pick<Fetcher, 'fetch'>,
  ) {}

  async prepareImage(
    draftId: string,
    bytes: Uint8Array,
    metadata: {
      filename: string;
      contentType: string;
      altText: string;
      actor: string;
      now?: string;
    },
  ) {
    const policy = validateImageUpload({ ...metadata, bytes });
    const assetId = crypto.randomUUID();
    const filename = metadata.filename.toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
    const stem =
      filename
        .replace(/\.[^.]+$/, '')
        .replace(/[^a-z0-9_-]/g, '-')
        .replace(/^[^a-z0-9]+/, '') || 'image';
    const basename = `${stem}.${policy.extension}`;
    const sourcePath = `/assets/builder/${draftId}/${assetId}/${basename}`;
    const checksum = [
      ...new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer)),
    ]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    const statements = [
      this.database
        .prepare(
          `INSERT INTO draft_asset_versions
       (id,draft_id,source_path,filename,content_type,byte_size,width,height,checksum,created_by,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          assetId,
          draftId,
          sourcePath,
          basename,
          policy.contentType,
          bytes.byteLength,
          policy.width,
          policy.height,
          checksum,
          metadata.actor,
          metadata.now ?? new Date().toISOString(),
        ),
    ];
    for (let offset = 0, index = 0; offset < bytes.byteLength; offset += chunkBytes, index++) {
      const chunk = bytes.slice(offset, offset + chunkBytes);
      statements.push(
        this.database
          .prepare(
            'INSERT INTO draft_asset_chunks (asset_id,chunk_index,byte_size,bytes) VALUES (?,?,?,?)',
          )
          .bind(assetId, index, chunk.byteLength, chunk.buffer),
      );
    }
    statements.push(this.binding(draftId, sourcePath, assetId));
    return {
      sourcePath,
      assetId,
      contentType: policy.contentType,
      width: policy.width,
      height: policy.height,
      checksum,
      byteSize: bytes.byteLength,
      statements,
    };
  }

  async prepareCreate(input: {
    draftId: string;
    document: SiteDocument;
    sourceDraftId?: string;
    actor: string;
    now: string;
  }): Promise<{ document: SiteDocument; statements: D1PreparedStatement[] }> {
    assertNoPrivateBuilderLinks(input.document);
    const document = structuredClone(input.document);
    const statements: D1PreparedStatement[] = [];
    const copied = new Map<string, string>();
    const sourceObjects = input.sourceDraftId
      ? await this.readManyForDraft(
          input.sourceDraftId,
          document.media.map((item) => item.sourcePath),
        )
      : undefined;
    for (const item of document.media) {
      const originalPath = item.sourcePath;
      let sourcePath = copied.get(originalPath);
      if (!sourcePath) {
        const object = sourceObjects
          ? sourceObjects.get(originalPath)
          : await this.readLegacy(originalPath);
        if (!object) throw new NotFoundError('Draft image was not found');
        const prepared = await this.prepareImage(input.draftId, object.bytes, {
          filename: originalPath.split('/').at(-1) ?? object.filename,
          contentType: object.contentType,
          altText: item.alt || 'Draft image',
          actor: input.actor,
          now: input.now,
        });
        sourcePath = prepared.sourcePath;
        copied.set(originalPath, sourcePath);
        statements.push(...prepared.statements);
      }
      item.sourcePath = sourcePath;
    }
    return { document, statements };
  }

  async prepareSave(input: {
    draftId: string;
    previousDocument: SiteDocument;
    document: SiteDocument;
    actor: string;
    now: string;
    preparedSourcePaths?: Set<string>;
  }): Promise<D1PreparedStatement[]> {
    assertNoPrivateBuilderLinks(input.document);
    const priorPaths = new Set(input.previousDocument.media.map((item) => item.sourcePath));
    const statements: D1PreparedStatement[] = [];
    const paths = [...new Set(input.document.media.map((item) => item.sourcePath))];
    const bindings = new Set(
      (
        await this.database
          .prepare(
            'SELECT source_path FROM draft_asset_bindings WHERE draft_id=? AND source_path IN (SELECT value FROM json_each(?))',
          )
          .bind(input.draftId, JSON.stringify(paths))
          .all<{ source_path: string }>()
      ).results.map((row) => row.source_path),
    );
    for (const sourcePath of paths) {
      const owner = ownedPath.exec(sourcePath)?.[1];
      if (owner && owner !== input.draftId)
        throw new ConflictError('Images must belong to this draft');
      if (bindings.has(sourcePath)) continue;
      if (owner === input.draftId && input.preparedSourcePaths?.has(sourcePath)) continue;
      if (owner || !priorPaths.has(sourcePath))
        throw new ConflictError('Image is unavailable in this draft');
      const object = await this.readLegacy(sourcePath);
      const prepared = await this.prepareImage(input.draftId, object.bytes, {
        filename: sourcePath.split('/').at(-1) ?? object.filename,
        contentType: object.contentType,
        altText:
          input.document.media.find((item) => item.sourcePath === sourcePath)?.alt || 'Draft image',
        actor: input.actor,
        now: input.now,
      });
      statements.push(
        ...prepared.statements,
        this.binding(input.draftId, sourcePath, prepared.assetId),
      );
    }
    return statements;
  }

  async readForDraft(draftId: string, sourcePath: string): Promise<DraftAssetObject> {
    if (!imagePath.test(sourcePath)) throw new NotFoundError('Draft image was not found');
    const owner = ownedPath.exec(sourcePath)?.[1];
    if (owner && owner !== draftId) throw new NotFoundError('Draft image was not found');
    let row = await this.find(draftId, sourcePath);
    if (!row) {
      // An owned path never falls back to shared storage or another draft.
      if (
        owner ||
        (sourcePath.startsWith('/assets/builder/') && !legacyUploadPath.test(sourcePath))
      )
        throw new NotFoundError('Draft image was not found');
      const referenced = await this.database
        .prepare(
          `SELECT r.id FROM revisions r JOIN drafts d ON d.id=r.draft_id,
         json_each(r.document_json,'$.media') item
         WHERE r.draft_id=? AND json_extract(item.value,'$.sourcePath')=? LIMIT 1`,
        )
        .bind(draftId, sourcePath)
        .first();
      if (!referenced) throw new NotFoundError('Draft image was not found');
      const object = await this.readLegacy(sourcePath);
      const prepared = await this.prepareImage(draftId, object.bytes, {
        filename: sourcePath.split('/').at(-1) ?? object.filename,
        contentType: object.contentType,
        altText: 'Retained draft image',
        actor: 'asset-migration',
      });
      try {
        await this.database.batch([
          ...prepared.statements,
          this.binding(draftId, sourcePath, prepared.assetId),
        ]);
      } catch (error) {
        // Another reader may have completed the same immutable binding first.
        if (!(await this.find(draftId, sourcePath))) throw error;
      }
      row = await this.find(draftId, sourcePath);
    }
    if (!row) throw new NotFoundError('Draft image was not found');
    const result = await this.database
      .prepare(
        'SELECT chunk_index,byte_size,bytes FROM draft_asset_chunks WHERE asset_id=? ORDER BY chunk_index',
      )
      .bind(row.id)
      .all<AssetChunk>();
    return decodeAsset(row, result.results);
  }

  async readManyForDraft(
    draftId: string,
    sourcePaths: string[],
    maximumBytes = 250 * 1024 * 1024,
  ): Promise<Map<string, DraftAssetObject>> {
    const paths = [...new Set(sourcePaths)];
    if (!paths.length) return new Map();
    for (const path of paths) {
      const owner = ownedPath.exec(path)?.[1];
      if (!imagePath.test(path) || (owner && owner !== draftId))
        throw new NotFoundError('Draft image was not found');
    }
    const rows = (
      await this.database
        .prepare(
          `SELECT b.source_path AS requested_path,v.* FROM json_each(?) requested
      JOIN draft_asset_bindings b ON b.source_path=requested.value AND b.draft_id=?
      JOIN draft_asset_versions v ON v.id=b.asset_id AND v.draft_id=b.draft_id JOIN drafts d ON d.id=b.draft_id`,
        )
        .bind(JSON.stringify(paths), draftId)
        .all<AssetRow & { requested_path: string }>()
    ).results;
    // Publishing and duplication require materialized ownership. Never silently
    // substitute a template or another owner's bytes for a missing binding.
    if (rows.length !== paths.length) throw new NotFoundError('Draft image was not found');
    if (rows.reduce((sum, row) => sum + row.byte_size, 0) > maximumBytes)
      throw new Error('MEDIA_READ_TOO_LARGE');
    const ids = [...new Set(rows.map((row) => row.id))];
    const chunks = (
      await this.database
        .prepare(
          'SELECT asset_id,chunk_index,byte_size,bytes FROM draft_asset_chunks WHERE asset_id IN (SELECT value FROM json_each(?)) ORDER BY asset_id,chunk_index',
        )
        .bind(JSON.stringify(ids))
        .all<AssetChunk & { asset_id: string }>()
    ).results;
    const grouped = new Map<string, AssetChunk[]>();
    for (const chunk of chunks) {
      const group = grouped.get(chunk.asset_id) ?? [];
      group.push(chunk);
      grouped.set(chunk.asset_id, group);
    }
    const objects = new Map<string, DraftAssetObject>();
    const decoded = new Map<string, DraftAssetObject>();
    for (const row of rows) {
      const object = decoded.get(row.id) ?? (await decodeAsset(row, grouped.get(row.id) ?? []));
      decoded.set(row.id, object);
      objects.set(row.requested_path, object);
    }
    return objects;
  }

  async materializeLegacyDraft(draftId: string): Promise<number> {
    const paths = await this.database
      .prepare(
        `SELECT DISTINCT json_extract(item.value,'$.sourcePath') AS source_path
       FROM revisions r,json_each(r.document_json,'$.media') item WHERE r.draft_id=?`,
      )
      .bind(draftId)
      .all<{ source_path: string }>();
    for (const { source_path: sourcePath } of paths.results)
      await this.readForDraft(draftId, sourcePath);
    return paths.results.length;
  }

  purgeStatements(draftId: string): D1PreparedStatement[] {
    return [
      this.database.prepare('DELETE FROM draft_asset_versions WHERE draft_id=?').bind(draftId),
    ];
  }

  private async find(draftId: string, sourcePath: string): Promise<AssetRow | null> {
    return this.database
      .prepare(
        `SELECT v.* FROM draft_asset_bindings b JOIN draft_asset_versions v ON v.id=b.asset_id AND v.draft_id=b.draft_id
       JOIN drafts d ON d.id=b.draft_id WHERE b.draft_id=? AND b.source_path=?`,
      )
      .bind(draftId, sourcePath)
      .first<AssetRow>();
  }

  private binding(draftId: string, sourcePath: string, assetId: string): D1PreparedStatement {
    return this.database
      .prepare('INSERT INTO draft_asset_bindings (draft_id,source_path,asset_id) VALUES (?,?,?)')
      .bind(draftId, sourcePath, assetId);
  }

  private async readLegacy(sourcePath: string): Promise<DraftAssetObject> {
    if (!imagePath.test(sourcePath) || ownedPath.test(sourcePath))
      throw new NotFoundError('Draft image was not found');
    const uploaded = legacyUploadPath.exec(sourcePath)?.[1];
    if (uploaded) return this.legacy.read(uploaded);
    if (sourcePath.startsWith('/assets/builder/') || !this.assets)
      throw new NotFoundError('Draft image was not found');
    const response = await this.assets.fetch(
      new Request(`https://builder-assets.invalid${sourcePath}`),
    );
    if (!response.ok) throw new NotFoundError('Draft image was not found');
    const contentType = response.headers.get('content-type')?.split(';')[0] ?? '';
    if (!contentType.startsWith('image/')) throw new NotFoundError('Draft image was not found');
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      contentType,
      filename: sourcePath.split('/').at(-1) ?? 'image.png',
    };
  }
}
