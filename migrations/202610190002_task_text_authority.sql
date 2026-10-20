-- 复用宿主完整 authority 格式；旧记录没有完整来源，保持 NULL 并持续隐藏正文。
ALTER TABLE analysis_tasks ADD COLUMN goal_authority JSON NULL;
ALTER TABLE clarifications ADD COLUMN text_authority JSON NULL;
ALTER TABLE condition_revisions ADD COLUMN field_authorities JSON NULL;
