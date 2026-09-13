import type { RevisionRecord } from '../repositories/contracts';
import { ApiError } from '../http/errors';
import type { SiteDocument } from '../../site-kit/types';

/** Small per-draft aggregates; history is visited only by explicit bounded maintenance. */
export class D1LibraryProjection {
  constructor(private readonly database: D1Database) {}

  statements(
    revision: Pick<RevisionRecord, 'draftId' | 'sequence' | 'createdAt'> & {
      document: Partial<Pick<SiteDocument, 'media' | 'linkedMedia'>>;
    },
    previousSequence: number,
  ): D1PreparedStatement[] {
    const { draftId, sequence, document, createdAt } = revision;
    const entries = JSON.stringify([...(document.media ?? []), ...(document.linkedMedia ?? [])]);
    const covered = `COALESCE((SELECT sequence FROM draft_library_projection WHERE draft_id=?),0)=?`;
    return [
      this.database
        .prepare(
          `INSERT INTO draft_library_history(draft_id,item_id,signature,created_at,updated_at)
        SELECT ?,json_extract(value,'$.id'),value,?,? FROM json_each(?) WHERE ${covered}
        ON CONFLICT(draft_id,item_id) DO UPDATE SET signature=excluded.signature,
          created_at=MIN(draft_library_history.created_at,excluded.created_at),
          updated_at=CASE WHEN draft_library_history.signature<>excluded.signature
            THEN MAX(draft_library_history.updated_at,excluded.updated_at) ELSE draft_library_history.updated_at END
        WHERE draft_library_history.signature<>excluded.signature OR excluded.created_at<draft_library_history.created_at`,
        )
        .bind(draftId, createdAt, createdAt, entries, draftId, previousSequence),
      this.database
        .prepare(
          `INSERT OR IGNORE INTO draft_library_retained_paths(draft_id,source_path)
        SELECT ?,json_extract(value,'$.sourcePath') FROM json_each(?)
        WHERE json_extract(value,'$.sourcePath') IS NOT NULL AND ${covered}`,
        )
        .bind(draftId, entries, draftId, previousSequence),
      this.database
        .prepare(
          `INSERT INTO draft_library_projection(draft_id,sequence)
        SELECT ?,? WHERE ${covered}
        ON CONFLICT(draft_id) DO UPDATE SET sequence=excluded.sequence`,
        )
        .bind(draftId, sequence, draftId, previousSequence),
    ];
  }

  async requireCoverage(draftId: string, sequence: number) {
    const covered = await this.database
      .prepare('SELECT sequence,generation FROM draft_library_projection WHERE draft_id=?')
      .bind(draftId)
      .first<{ sequence: number; generation: string }>();
    if (covered?.sequence !== sequence)
      throw new ApiError(
        503,
        'LIBRARY_INDEX_PENDING',
        'Library history is being prepared. Try again after maintenance completes.',
      );
    return covered.generation;
  }

  async backfill(draftId: string) {
    const state = await this.database
      .prepare('SELECT sequence,generation FROM draft_library_projection WHERE draft_id=?')
      .bind(draftId)
      .first<{ sequence: number; generation: string }>();
    let previous = state?.sequence ?? 0;
    const rows = await this.database
      .prepare(
        `SELECT id,sequence,document_json,created_at FROM revisions
      WHERE draft_id=? AND sequence>? ORDER BY sequence LIMIT 8`,
      )
      .bind(draftId, previous)
      .all<{ id: string; sequence: number; document_json: string; created_at: string }>();
    if (!rows.results.length) return { processed: 0, sequence: previous };
    const statements = [
      this.database
        .prepare(
          `SELECT json(CASE WHEN
      COALESCE((SELECT sequence FROM draft_library_projection WHERE draft_id=?),0)=?
      AND COALESCE((SELECT generation FROM draft_library_projection WHERE draft_id=?),'')=?
      THEN 'true' ELSE 'projection-changed' END)`,
        )
        .bind(draftId, previous, draftId, state?.generation ?? ''),
    ];
    for (const row of rows.results) {
      statements.push(
        ...this.statements(
          {
            draftId,
            sequence: row.sequence,
            document: JSON.parse(row.document_json) as RevisionRecord['document'],
            createdAt: row.created_at,
          },
          previous,
        ),
      );
      previous = row.sequence;
    }
    await this.database.batch(statements);
    return { processed: rows.results.length, sequence: previous };
  }
}
