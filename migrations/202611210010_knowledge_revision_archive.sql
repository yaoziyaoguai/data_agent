ALTER TABLE knowledge_revisions
 MODIFY updated_by VARCHAR(64) NULL,
 MODIFY fingerprint VARCHAR(64) NULL,
 MODIFY changed_paths JSON NULL,
 ADD COLUMN archived_body JSON NULL;

INSERT INTO knowledge_revisions(object_id,version,archived_body)
SELECT object_id,version,body FROM knowledge_versions
ON DUPLICATE KEY UPDATE archived_body=VALUES(archived_body);

DROP TABLE knowledge_versions;
