-- 原文索引目标进入公共待办：SourceKey的kind参与完整目标身份，平台与文档同ID
-- 不互删、不把document-调用别名当裸object_id。origin_job_id接续旧队列移交的
-- 原作业身份；知识行source_kind保持空串。
ALTER TABLE knowledge_index_jobs
 ADD COLUMN source_kind VARCHAR(16) NOT NULL DEFAULT '',
 ADD COLUMN origin_job_id VARCHAR(64) NULL,
 DROP PRIMARY KEY,
 ADD PRIMARY KEY(target_kind,source_kind,object_id,version);
