ALTER TABLE source_revisions
 MODIFY updated_by VARCHAR(64) NULL,
 MODIFY content_fingerprint VARCHAR(64) NULL,
 MODIFY explanation_fingerprint VARCHAR(64) NULL,
 MODIFY comparison_method VARCHAR(64) NULL,
 MODIFY parsed BOOLEAN NULL,
 MODIFY complete BOOLEAN NULL,
 ADD COLUMN body LONGTEXT NULL,
 ADD COLUMN archive_complete BOOLEAN NOT NULL DEFAULT TRUE;

INSERT INTO source_revisions(source_id,version,body,archive_complete)
SELECT source_id,version,body,complete FROM source_snapshots
ON DUPLICATE KEY UPDATE body=VALUES(body),archive_complete=VALUES(archive_complete);

DROP TABLE source_snapshots;
