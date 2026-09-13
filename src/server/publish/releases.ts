/** Append only after verified job success, inside the same transaction. */
export function verifiedReleaseStatement(database: D1Database, jobId: string) {
  return database
    .prepare(
      `INSERT INTO publication_releases
    (id,kind,job_id,previous_release_id,artifact_digest,source_json,evidence_json,verified_at)
    SELECT j.id,'publication',j.id,(SELECT id FROM publication_releases ORDER BY sequence DESC LIMIT 1),
      json_extract(pr.build_json,'$.artifactDigest'),
      json_object('repository',j.repository,'commitSha',j.result_sha,
        'treeSha',json_extract(pr.build_json,'$.treeSha'),
        'manifestBlobSha',json_extract(pr.build_json,'$.manifestBlobSha'),
        'workflowRevision',pi.workflow_revision,'candidateChecksum',j.candidate_checksum,
        'fileCount',json_extract(pr.build_json,'$.fileCount'),'totalBytes',json_extract(pr.build_json,'$.totalBytes')),
      j.evidence_json,j.completed_at
    FROM publish_jobs j JOIN publication_inputs pi ON pi.job_id=j.id JOIN publication_runs pr ON pr.job_id=j.id
    WHERE j.id=? AND j.environment='production-merge' AND j.status='succeeded'
      AND NOT EXISTS(SELECT 1 FROM publication_releases WHERE job_id=j.id)`,
    )
    .bind(jobId);
}

const cutoff = "strftime('%Y-%m-%dT%H:%M:%fZ','now','-90 days')";
const retainedReleases = 'SELECT job_id FROM publication_releases ORDER BY sequence DESC LIMIT 2';
const retirableJob = `j.environment IN ('staging','production-merge')
  AND j.status IN ('succeeded','failed','cancelled') AND j.completed_at<${cutoff}
  AND json_extract(j.candidate_json,'$.publicationProtocol')=2
  AND ((j.status IN ('failed','cancelled') AND pr.deploy_authorized_at IS NULL)
    OR (j.status='succeeded' AND json_extract(j.evidence_json,'$.verificationStatus')='passed'))
  AND NOT EXISTS(SELECT 1 FROM publication_slots WHERE job_id=j.id)
  AND NOT EXISTS(SELECT 1 FROM publication_retries WHERE parent_job_id=j.id)
  AND NOT EXISTS(SELECT 1 FROM publication_promotions WHERE staging_job_id=j.id)
  AND NOT EXISTS(SELECT 1 FROM (${retainedReleases}) kept WHERE kept.job_id=j.id)
  AND NOT EXISTS(SELECT 1 FROM publication_releases WHERE job_id=j.id AND recorded_at>=${cutoff})
  AND j.id IS NOT (SELECT id FROM publish_jobs WHERE environment='staging' AND status='succeeded'
    AND json_extract(evidence_json,'$.verificationStatus')='passed'
    ORDER BY completed_at DESC,id DESC LIMIT 1)`;
const retirableRelease = `recorded_at<${cutoff}
  AND sequence NOT IN (SELECT sequence FROM publication_releases ORDER BY sequence DESC LIMIT 2)`;

/** One metadata retirement per kind; retained documents and image bytes are never deleted here. */
export async function retirePublicationMetadata(database: D1Database) {
  const [job, release] = await Promise.all([
    database
      .prepare(
        `SELECT j.id,j.idempotency_key FROM publish_jobs j INDEXED BY publication_jobs_retention
      JOIN publication_runs pr ON pr.job_id=j.id WHERE ${retirableJob}
      ORDER BY j.completed_at,j.id LIMIT 1`,
      )
      .first<{ id: string; idempotency_key: string }>(),
    database
      .prepare(
        `SELECT id FROM publication_releases INDEXED BY publication_releases_age WHERE ${retirableRelease}
      ORDER BY recorded_at,sequence LIMIT 1`,
      )
      .first<{ id: string }>(),
  ]);
  if (!job && !release) return { jobs: 0, releases: 0 };
  const statements: D1PreparedStatement[] = [];
  const audit = (id: string, action: string, target: string) =>
    database
      .prepare(
        `INSERT INTO audit_events(id,occurred_at,actor,action,target_type,target_id,outcome,request_id,metadata_json)
    VALUES (?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),'system:publication-retention',?,?,?,'succeeded',?,'{}')`,
      )
      .bind(crypto.randomUUID(), action, target, id, crypto.randomUUID());
  if (job)
    statements.push(
      database
        .prepare(
          `SELECT json(CASE WHEN EXISTS(SELECT 1 FROM publish_jobs j
      JOIN publication_runs pr ON pr.job_id=j.id WHERE j.id=? AND j.idempotency_key=? AND ${retirableJob})
      THEN 'true' ELSE 'publication-retention-changed' END)`,
        )
        .bind(job.id, job.idempotency_key),
      database
        .prepare('INSERT INTO publication_tombstones(idempotency_key,job_id) VALUES (?,?)')
        .bind(job.idempotency_key, job.id),
      database.prepare('DELETE FROM publication_asset_pins WHERE job_id=?').bind(job.id),
      database.prepare('DELETE FROM publication_inputs WHERE job_id=?').bind(job.id),
      database.prepare('DELETE FROM approvals WHERE publish_job_id=?').bind(job.id),
      database.prepare('DELETE FROM publish_jobs WHERE id=?').bind(job.id),
      audit(job.id, 'publication.retired', 'publish-job'),
    );
  if (release)
    statements.push(
      database
        .prepare(
          `SELECT json(CASE WHEN EXISTS(SELECT 1 FROM publication_releases
      WHERE id=? AND ${retirableRelease}) THEN 'true' ELSE 'publication-retention-changed' END)`,
        )
        .bind(release.id),
      database.prepare('DELETE FROM publication_releases WHERE id=?').bind(release.id),
      audit(release.id, 'publication.release-retired', 'publication-release'),
    );
  try {
    await database.batch(statements);
  } catch (error) {
    if (error instanceof Error && error.message.includes('malformed JSON'))
      throw new Error('PUBLICATION_RETENTION_CHANGED');
    throw error;
  }
  return { jobs: job ? 1 : 0, releases: release ? 1 : 0 };
}
