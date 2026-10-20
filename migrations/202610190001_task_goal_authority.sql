-- 分析目标正文绑定生成时条件的来源；旧记录无法反推来源，保持NULL并保守核验。
ALTER TABLE analysis_tasks
 ADD COLUMN goal_condition_version BIGINT UNSIGNED NULL;
