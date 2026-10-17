-- 新正常配置可省略累计门槛；旧trial原值、到期与未知预留不变。
ALTER TABLE model_trials
 MODIFY COLUMN call_limit INT UNSIGNED NULL,
 MODIFY COLUMN cost_limit_micros BIGINT UNSIGNED NULL,
 MODIFY COLUMN expires_at DATETIME(3) NULL;

ALTER TABLE budget_scopes
 ADD COLUMN model_failure_streak TINYINT UNSIGNED NOT NULL DEFAULT 0;

ALTER TABLE model_call_attempts
 ADD COLUMN scope_call_sequence INT UNSIGNED NULL,
 ADD COLUMN outcome VARCHAR(24) NULL;
