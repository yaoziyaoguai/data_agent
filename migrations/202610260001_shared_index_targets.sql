-- 公共索引待办统一由knowledge拥有：目标判别进入主键，容纳知识对象与平台/
-- 文档来源的ID碰撞。旧knowledge行缺判别字段，按默认值明确回填knowledge_entry
-- 目标，不靠字符串前缀让各消费者自行猜测。space_id只由raw目标登记方填写
-- （知识对象仍经knowledge_objects联表定位空间）。
ALTER TABLE knowledge_index_jobs
 ADD COLUMN target_kind VARCHAR(24) NOT NULL DEFAULT 'knowledge_entry',
 ADD COLUMN space_id VARCHAR(64) NULL,
 DROP PRIMARY KEY,
 DROP INDEX index_claim,
 ADD PRIMARY KEY(target_kind,object_id,version),
 ADD INDEX index_claim(state,vector_state,lease_until);
