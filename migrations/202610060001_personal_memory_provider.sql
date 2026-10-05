-- 复用runtime调用总账；后台索引可归原请求或明确维护profile，不依赖活动run。
ALTER TABLE model_call_attempts
 MODIFY budget_scope_id VARCHAR(64) NULL,
 MODIFY run_id VARCHAR(64) NULL,
 ADD COLUMN purpose VARCHAR(32) NOT NULL DEFAULT 'agent',
 ADD COLUMN trial_id VARCHAR(64),
 ADD COLUMN operation_id VARCHAR(64),
 ADD COLUMN price_version VARCHAR(64);

-- assets拥有派生索引待办；正式资产与待办在同一事务提交。
CREATE TABLE personal_memory_index_jobs (
 id VARCHAR(64) PRIMARY KEY, owner_id VARCHAR(64) NOT NULL, space_id VARCHAR(64) NOT NULL,
 asset_id VARCHAR(64) NOT NULL, asset_version BIGINT UNSIGNED NOT NULL, asset_json JSON NOT NULL,
 extraction_operation_id VARCHAR(64), budget_scope_id VARCHAR(64), model_profile JSON,
 state VARCHAR(16) NOT NULL DEFAULT 'queued', attempts INT UNSIGNED NOT NULL DEFAULT 0,
 lease_epoch BIGINT UNSIGNED NOT NULL DEFAULT 0, lease_until DATETIME(3), error_code VARCHAR(64),
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 UNIQUE(owner_id,space_id,asset_id,asset_version), INDEX(state,created_at)
);
