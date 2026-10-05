-- 领取与外部调用分开；未知回执保留并通过不可变片段键查证。
ALTER TABLE knowledge_index_jobs
 ADD COLUMN vector_state VARCHAR(16) NOT NULL DEFAULT 'pending',
 ADD COLUMN vector_error VARCHAR(64), ADD COLUMN vector_receipt JSON,
 ADD COLUMN lease_epoch BIGINT UNSIGNED NOT NULL DEFAULT 0,
 ADD COLUMN lease_until DATETIME(3), ADD COLUMN vector_attempts INT UNSIGNED NOT NULL DEFAULT 0,
 ADD INDEX index_claim(state,vector_state,lease_until);
