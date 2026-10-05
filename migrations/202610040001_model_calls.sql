-- 请求范围固定模型profile，恢复不能切换试验或补额。
ALTER TABLE budget_scopes ADD COLUMN model_profile JSON;
CREATE TABLE model_trials (
 id VARCHAR(64) PRIMARY KEY, configuration_fingerprint VARCHAR(64) NOT NULL,
 call_limit INT UNSIGNED NOT NULL, cost_limit_micros BIGINT UNSIGNED NOT NULL,
 allocated_calls INT UNSIGNED NOT NULL DEFAULT 0, reserved_micros BIGINT UNSIGNED NOT NULL DEFAULT 0,
 spent_micros BIGINT UNSIGNED NOT NULL DEFAULT 0,
 state VARCHAR(16) NOT NULL DEFAULT 'active', expires_at DATETIME(3) NOT NULL
);
ALTER TABLE model_call_attempts
 ADD COLUMN parameters_fingerprint VARCHAR(64),
 ADD COLUMN input_tokens_upper INT UNSIGNED,
 ADD COLUMN output_tokens_max INT UNSIGNED,
 ADD COLUMN reserved_micros BIGINT UNSIGNED,
 ADD COLUMN actual_micros BIGINT UNSIGNED,
 ADD COLUMN usage_json JSON,
 ADD COLUMN permit_expires_at DATETIME(3);
