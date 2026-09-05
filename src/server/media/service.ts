import { validateImageUpload } from './policy';

export type MediaStatus = 'ready' | 'rejected' | 'published' | 'orphaned';

export interface MediaRecord {
  id: string;
  objectKey: string;
  filename: string;
  contentType: string;
  byteSize: number;
  width: number;
  height: number;
  checksum: string;
  altText: string;
  status: MediaStatus;
  createdBy: string;
  createdAt: string;
  lastReferencedAt: string | null;
}

export interface MediaRepository {
  list(): Promise<MediaRecord[]>;
  findDuplicate(checksum: string, byteSize: number): Promise<MediaRecord | null>;
  get(id: string): Promise<MediaRecord | null>;
  totalBytes(): Promise<number>;
  create(record: MediaRecord, requestId: string): Promise<void>;
  markOrphaned(
    referencedIds: Set<string>,
    before: string,
    actor: string,
    requestId: string,
  ): Promise<number>;
  deleteOrphans(before: string, actor: string, requestId: string): Promise<MediaRecord[]>;
}

export interface PrivateBucket {
  put(key: string, bytes: Uint8Array, options?: { contentType: string }): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export class MediaService {
  constructor(
    private readonly repository: MediaRepository,
    private readonly bucket: PrivateBucket,
    private readonly capacityBytes = 250 * 1024 * 1024,
  ) {}

  list(): Promise<MediaRecord[]> {
    return this.repository.list();
  }

  async upload(input: {
    filename: string;
    contentType: string;
    bytes: Uint8Array;
    altText: string;
    actor: string;
    requestId: string;
  }): Promise<MediaRecord> {
    const policy = validateImageUpload(input);
    const checksum = await sha256(input.bytes);
    const duplicate = await this.repository.findDuplicate(checksum, input.bytes.byteLength);
    if (duplicate?.status === 'ready' || duplicate?.status === 'published') return duplicate;
    if ((await this.repository.totalBytes()) + input.bytes.byteLength > this.capacityBytes)
      throw new Error('MEDIA_CAPACITY_EXCEEDED');
    const id = crypto.randomUUID();
    const objectKey = `draft/${crypto.randomUUID()}.${policy.extension}`;
    const record: MediaRecord = {
      id,
      objectKey,
      filename: input.filename,
      contentType: policy.contentType,
      byteSize: input.bytes.byteLength,
      width: policy.width,
      height: policy.height,
      checksum,
      altText: input.altText.trim(),
      status: 'ready',
      createdBy: input.actor,
      createdAt: new Date().toISOString(),
      lastReferencedAt: null,
    };
    await this.bucket.put(objectKey, input.bytes, { contentType: policy.contentType });
    try {
      await this.repository.create(record, input.requestId);
    } catch (error) {
      await this.bucket.delete(objectKey);
      throw error;
    }
    return record;
  }

  async read(id: string): Promise<{ bytes: Uint8Array; contentType: string; filename: string }> {
    const record = await this.repository.get(id);
    if (!record || !['ready', 'published'].includes(record.status))
      throw new Error('MEDIA_NOT_FOUND');
    const bytes = await this.bucket.get(record.objectKey);
    if (!bytes) throw new Error('MEDIA_NOT_FOUND');
    return { bytes, contentType: record.contentType, filename: record.filename };
  }
}

interface MediaRow {
  id: string;
  object_key: string;
  filename: string;
  content_type: string;
  byte_size: number;
  width: number;
  height: number;
  checksum: string;
  alt_text: string;
  status: MediaStatus;
  created_by: string;
  created_at: string;
  last_referenced_at: string | null;
}
const select = `SELECT id,object_key,filename,content_type,byte_size,width,height,checksum,alt_text,status,created_by,created_at,last_referenced_at FROM media_assets`;
function fromRow(row: MediaRow): MediaRecord {
  return {
    id: row.id,
    objectKey: row.object_key,
    filename: row.filename,
    contentType: row.content_type,
    byteSize: row.byte_size,
    width: row.width,
    height: row.height,
    checksum: row.checksum,
    altText: row.alt_text,
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
    lastReferencedAt: row.last_referenced_at,
  };
}

export class D1MediaRepository implements MediaRepository {
  constructor(private readonly database: D1Database) {}
  async list() {
    const result = await this.database
      .prepare(`${select} WHERE status IN ('ready','published') ORDER BY created_at DESC LIMIT 100`)
      .all<MediaRow>();
    return result.results.map(fromRow);
  }
  async findDuplicate(checksum: string, byteSize: number) {
    const row = await this.database
      .prepare(`${select} WHERE checksum=? AND byte_size=?`)
      .bind(checksum, byteSize)
      .first<MediaRow>();
    return row ? fromRow(row) : null;
  }
  async get(id: string) {
    const row = await this.database.prepare(`${select} WHERE id=?`).bind(id).first<MediaRow>();
    return row ? fromRow(row) : null;
  }
  async totalBytes() {
    const row = await this.database
      .prepare(
        "SELECT COALESCE(SUM(byte_size), 0) AS total FROM media_assets WHERE status != 'rejected'",
      )
      .first<{ total: number }>();
    return row?.total ?? 0;
  }
  async create(record: MediaRecord, requestId: string) {
    await this.database.batch([
      this.database
        .prepare(
          `INSERT INTO media_assets (id,object_key,filename,content_type,byte_size,width,height,checksum,alt_text,status,created_by,created_at,last_referenced_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          record.id,
          record.objectKey,
          record.filename,
          record.contentType,
          record.byteSize,
          record.width,
          record.height,
          record.checksum,
          record.altText,
          record.status,
          record.createdBy,
          record.createdAt,
          record.lastReferencedAt,
        ),
      this.database
        .prepare(
          `INSERT INTO audit_events (id,occurred_at,actor,action,target_type,target_id,outcome,request_id,metadata_json) VALUES (?,?,?,?,?,?, 'succeeded',?,?)`,
        )
        .bind(
          crypto.randomUUID(),
          new Date().toISOString(),
          record.createdBy,
          'media.upload',
          'media',
          record.id,
          requestId,
          JSON.stringify({
            byteSize: record.byteSize,
            contentType: record.contentType,
            width: record.width,
            height: record.height,
          }),
        ),
    ]);
  }
  async markOrphaned(referencedIds: Set<string>, before: string, actor: string, requestId: string) {
    const candidates = await this.list();
    let count = 0;
    for (const item of candidates)
      if (!referencedIds.has(item.id) && item.createdAt < before && item.status === 'ready') {
        await this.database.batch([
          this.database
            .prepare(`UPDATE media_assets SET status='orphaned' WHERE id=? AND status='ready'`)
            .bind(item.id),
          this.audit(actor, 'media.orphan', item.id, requestId),
        ]);
        count += 1;
      }
    return count;
  }
  async deleteOrphans(before: string, actor: string, requestId: string) {
    const result = await this.database
      .prepare(`${select} WHERE status='orphaned' AND created_at < ?`)
      .bind(before)
      .all<MediaRow>();
    const items = result.results.map(fromRow);
    for (const item of items)
      await this.database.batch([
        this.database.prepare('DELETE FROM media_assets WHERE id=?').bind(item.id),
        this.audit(actor, 'media.delete', item.id, requestId),
      ]);
    return items;
  }
  private audit(actor: string, action: string, id: string, requestId: string) {
    return this.database
      .prepare(
        `INSERT INTO audit_events (id,occurred_at,actor,action,target_type,target_id,outcome,request_id,metadata_json) VALUES (?,?,?,?,?,?, 'succeeded',?,'{}')`,
      )
      .bind(crypto.randomUUID(), new Date().toISOString(), actor, action, 'media', id, requestId);
  }
}

const D1_CHUNK_BYTES = 1_000_000;

export class D1PrivateBucket implements PrivateBucket {
  constructor(private readonly database: D1Database) {}

  async put(key: string, bytes: Uint8Array) {
    const statements = [
      this.database.prepare('DELETE FROM media_object_chunks WHERE object_key=?').bind(key),
    ];
    for (let offset = 0, index = 0; offset < bytes.byteLength; offset += D1_CHUNK_BYTES, index++) {
      const chunk = bytes.slice(offset, offset + D1_CHUNK_BYTES);
      statements.push(
        this.database
          .prepare(
            'INSERT INTO media_object_chunks (object_key,chunk_index,byte_size,bytes) VALUES (?,?,?,?)',
          )
          .bind(key, index, chunk.byteLength, chunk.buffer),
      );
    }
    await this.database.batch(statements);
  }

  async get(key: string) {
    const result = await this.database
      .prepare(
        'SELECT chunk_index,byte_size,bytes FROM media_object_chunks WHERE object_key=? ORDER BY chunk_index',
      )
      .bind(key)
      .all<{ chunk_index: number; byte_size: number; bytes: ArrayBuffer }>();
    if (!result.results.length) return null;
    const size = result.results.reduce((total, row) => total + row.byte_size, 0);
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const row of result.results) {
      const chunk = new Uint8Array(row.bytes);
      if (chunk.byteLength !== row.byte_size) throw new Error('MEDIA_STORAGE_CORRUPT');
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }

  async delete(key: string) {
    await this.database
      .prepare('DELETE FROM media_object_chunks WHERE object_key=?')
      .bind(key)
      .run();
  }
}
