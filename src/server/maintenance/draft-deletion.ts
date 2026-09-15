/** The caller authorizes deletion and clears latest_revision_id in this same transaction. */
export function draftDeletionStatements(
  database: D1Database,
  draftId: string,
): D1PreparedStatement[] {
  return [
    database
      .prepare(
        `UPDATE idempotency_keys SET status_code=410,response_json='{"deleted":true}',
      expires_at='9999-12-31T23:59:59.999Z' WHERE json_extract(response_json,'$.id')=?`,
      )
      .bind(draftId),
    database.prepare('DELETE FROM publish_preflights WHERE draft_id=?').bind(draftId),
    database.prepare('DELETE FROM draft_checkouts WHERE draft_id=?').bind(draftId),
    database.prepare('DELETE FROM editor_view_states WHERE draft_id=?').bind(draftId),
    database.prepare('DELETE FROM draft_asset_versions WHERE draft_id=?').bind(draftId),
    database
      .prepare(
        `DELETE FROM audit_events WHERE target_id=? OR json_extract(metadata_json,'$.draftId')=?
      OR target_id IN (SELECT id FROM revisions WHERE draft_id=?)`,
      )
      .bind(draftId, draftId, draftId),
    database
      .prepare(
        'DELETE FROM revision_labels WHERE revision_id IN (SELECT id FROM revisions WHERE draft_id=?)',
      )
      .bind(draftId),
    // Remove splice references before checkpoints cascade; work stays independent of history length.
    database
      .prepare(
        'DELETE FROM revision_payloads WHERE base_revision_id IS NOT NULL AND revision_id IN (SELECT id FROM revisions WHERE draft_id=?)',
      )
      .bind(draftId),
    database.prepare('DELETE FROM revisions WHERE draft_id=?').bind(draftId),
    database.prepare('DELETE FROM drafts WHERE id=?').bind(draftId),
  ];
}
