CREATE INDEX revisions_retention_age ON revisions(created_at DESC,id DESC);
CREATE INDEX publish_jobs_revision ON publish_jobs(json_extract(candidate_json,'$.revisionId'));
CREATE INDEX publish_jobs_draft_status ON publish_jobs(json_extract(candidate_json,'$.draftId'),status);
CREATE INDEX revisions_parent ON revisions(parent_revision_id);
