-- 索引目标绑定模型和collection，换目标后不能沿用旧库的完成状态。
ALTER TABLE knowledge_index_jobs ADD COLUMN vector_target VARCHAR(64);
CREATE TABLE knowledge_index_rebuilds (
 space_id VARCHAR(64) NOT NULL, owner_id VARCHAR(64) NOT NULL, operation_id VARCHAR(64) NOT NULL,
 target VARCHAR(64) NOT NULL, receipt JSON NOT NULL,
 PRIMARY KEY(space_id,owner_id,operation_id)
);
