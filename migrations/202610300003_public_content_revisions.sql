-- 新公共修订只保必要元信息；已有全文旧档原样保留，不在迁移中清理。
CREATE TABLE knowledge_revisions (
 object_id VARCHAR(64) NOT NULL,
 version BIGINT UNSIGNED NOT NULL,
 updated_by VARCHAR(64) NOT NULL,
 fingerprint VARCHAR(64) NOT NULL,
 changed_paths JSON NOT NULL,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 PRIMARY KEY(object_id,version)
);
