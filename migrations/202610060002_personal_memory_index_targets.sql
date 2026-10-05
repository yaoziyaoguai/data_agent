-- 一个数据库可从正式正文重建到新集合；旧任务和模型账本保留原身份。
ALTER TABLE personal_memory_index_jobs
 ADD COLUMN index_target VARCHAR(160) NOT NULL DEFAULT 'default',
 DROP INDEX owner_id,
 ADD UNIQUE KEY asset_target_version(owner_id,space_id,asset_id,asset_version,index_target);
