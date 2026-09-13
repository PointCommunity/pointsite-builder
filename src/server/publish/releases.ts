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
