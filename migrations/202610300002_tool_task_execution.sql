-- 取消只可结算明确尚未开始的原任务操作；旧行缺执行事实，保持未知。
ALTER TABLE tool_calls
 ADD COLUMN task_id VARCHAR(64) NULL,
 ADD COLUMN task_condition_version BIGINT UNSIGNED NULL,
 ADD COLUMN execution_started BOOLEAN NULL;
