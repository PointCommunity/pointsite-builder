ALTER TABLE approvals ADD COLUMN request_hash TEXT CHECK(request_hash IS NULL OR (length(request_hash)=64 AND request_hash NOT GLOB '*[^0-9a-f]*'));
CREATE TRIGGER cloud_approval_immutable BEFORE UPDATE ON approvals
WHEN json_extract(OLD.candidate_json,'$.publicationProtocol')=2
BEGIN SELECT RAISE(ABORT,'CLOUD_APPROVAL_IMMUTABLE'); END;
