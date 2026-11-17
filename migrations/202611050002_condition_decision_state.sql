-- 旧条件按原格式读取；新条件及明确转换后的版本由analysis owner写2。
ALTER TABLE condition_revisions ADD COLUMN decision_state_version TINYINT UNSIGNED NOT NULL DEFAULT 1;
