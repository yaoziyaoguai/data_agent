-- 来源级语义准备进度：正文仍归source_current/source_snapshots，本表只保存
-- 覆盖、状态、冻结批次与错误；作业与预算仍归background_jobs和maintenance_model_calls。
CREATE TABLE source_preparations (
 source_id VARCHAR(64) NOT NULL, space_id VARCHAR(64) NOT NULL,
 revision BIGINT UNSIGNED NOT NULL, method_version VARCHAR(64) NOT NULL,
 input_fingerprint VARCHAR(64) NOT NULL, dependency_fingerprint VARCHAR(64) NOT NULL,
 segment_cursor JSON NULL, segments_read BIGINT UNSIGNED NOT NULL DEFAULT 0,
 covered_chars BIGINT UNSIGNED NOT NULL DEFAULT 0,
 batch_sequence BIGINT UNSIGNED NOT NULL DEFAULT 0,
 semantic_status VARCHAR(16) NOT NULL DEFAULT 'pending',
 unresolved JSON NOT NULL, error_code VARCHAR(64) NULL,
 frozen_batch JSON NULL, pending_draft JSON NULL,
 call_state VARCHAR(16) NULL, issued_until DATETIME(3) NULL,
 updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
 PRIMARY KEY(source_id,revision,method_version),
 INDEX preparation_status(space_id,semantic_status)
);
