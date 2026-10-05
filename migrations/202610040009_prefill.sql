-- ingestion拥有固定来源输入/分析尝试；runtime拥有原维护范围的调用账本。
CREATE TABLE prefill_attempts (
 id VARCHAR(64) PRIMARY KEY, space_id VARCHAR(64) NOT NULL, object_id VARCHAR(64) NOT NULL,
 expected_version BIGINT UNSIGNED NOT NULL, input_fingerprint VARCHAR(64) NOT NULL,
 input_json JSON NOT NULL, issued_until DATETIME(3), state VARCHAR(32) NOT NULL DEFAULT 'queued',
 result_json JSON, error_code VARCHAR(64), UNIQUE(space_id,object_id,expected_version), created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
);
CREATE TABLE maintenance_model_calls (
 id VARCHAR(64) PRIMARY KEY, trial_id VARCHAR(64) NOT NULL, state VARCHAR(16) NOT NULL,
 reserved_micros BIGINT UNSIGNED NOT NULL, usage_json JSON,
 FOREIGN KEY(trial_id) REFERENCES model_trials(id)
);
