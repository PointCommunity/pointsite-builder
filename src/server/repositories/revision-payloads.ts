import { canonicalize } from '../../site-kit/canonicalize';
import type { RevisionRecord } from './contracts';
import { decodeRevision, encodeRevision, type RevisionEncoding } from './revision-codec';

export interface StoredRevisionDocument {
  id: string;
  draft_id: string;
  checksum: string;
  document_json: string;
}
interface PayloadRow {
  revision_id: string;
  base_revision_id: string | null;
  codec: RevisionEncoding['codec'];
  payload: number[];
  raw_bytes: number;
  prefix_bytes: number;
  suffix_bytes: number;
}
const encoding = (row: PayloadRow): RevisionEncoding => ({
  codec: row.codec,
  payload: new Uint8Array(row.payload),
  rawBytes: row.raw_bytes,
  prefixBytes: row.prefix_bytes,
  suffixBytes: row.suffix_bytes,
});

/** Legacy JSON stays readable. Compact documents require one payload and at most one full base. */
export async function readRevisionDocument(
  database: D1Database,
  row: StoredRevisionDocument,
): Promise<unknown> {
  if (row.document_json !== '{}') return JSON.parse(row.document_json) as unknown;
  const payload = await database
    .prepare('SELECT * FROM revision_payloads WHERE revision_id=?')
    .bind(row.id)
    .first<PayloadRow>();
  if (!payload) throw new Error('REVISION_PAYLOAD_MISSING');
  let checkpoint: Uint8Array | undefined;
  if (payload.base_revision_id) {
    const base = await database
      .prepare(
        `SELECT p.*,r.checksum FROM revision_payloads p JOIN revisions r ON r.id=p.revision_id
      WHERE p.revision_id=? AND r.draft_id=? AND p.codec='gzip' AND p.base_revision_id IS NULL`,
      )
      .bind(payload.base_revision_id, row.draft_id)
      .first<PayloadRow & { checksum: string }>();
    if (!base) throw new Error('REVISION_CHECKPOINT_MISSING');
    checkpoint = await decodeRevision(encoding(base), base.checksum);
  }
  const bytes = await decodeRevision(encoding(payload), row.checksum, checkpoint);
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
}

export async function prepareRevisionPayload(
  database: D1Database,
  revision: Pick<RevisionRecord, 'id' | 'draftId' | 'sequence'> & { document: unknown },
) {
  const base =
    revision.sequence > 1
      ? await database
          .prepare(
            `SELECT p.*,r.checksum FROM revisions r JOIN revision_payloads p ON p.revision_id=r.id
    WHERE r.draft_id=? AND r.sequence>=? AND r.sequence<? AND p.codec='gzip'
    ORDER BY r.sequence DESC LIMIT 1`,
          )
          .bind(revision.draftId, revision.sequence - 31, revision.sequence)
          .first<PayloadRow & { checksum: string }>()
      : null;
  const checkpoint = base ? await decodeRevision(encoding(base), base.checksum) : undefined;
  const encoded = await encodeRevision(
    new TextEncoder().encode(canonicalize(revision.document)),
    checkpoint,
  );
  return {
    documentJson: '{}',
    statements: [
      database
        .prepare(
          `INSERT INTO revision_payloads(revision_id,base_revision_id,codec,payload,raw_bytes,prefix_bytes,suffix_bytes) VALUES (?,?,?,?,?,?,?)`,
        )
        .bind(
          revision.id,
          encoded.codec === 'gzip-splice' ? base!.revision_id : null,
          encoded.codec,
          encoded.payload.buffer,
          encoded.rawBytes,
          encoded.prefixBytes,
          encoded.suffixBytes,
        ),
    ],
  };
}
