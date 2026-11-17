-- 来源修订保留比较依据和操作者；正文只在source_current或既有精确旧档中读取。
CREATE TABLE source_revisions (
 source_id VARCHAR(64) NOT NULL,
 version BIGINT UNSIGNED NOT NULL,
 updated_by VARCHAR(64) NOT NULL,
 content_fingerprint VARCHAR(64) NOT NULL,
 explanation_fingerprint VARCHAR(64) NOT NULL,
 comparison_method VARCHAR(64) NOT NULL,
 parsed BOOLEAN NOT NULL,
 complete BOOLEAN NOT NULL,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 PRIMARY KEY(source_id,version)
);
