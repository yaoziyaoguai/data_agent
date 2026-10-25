-- 只保存当前陈述与关系；原有知识版本兼容保留到统一升级切换。
CREATE TABLE knowledge_statements (
 object_id VARCHAR(64) NOT NULL, version BIGINT UNSIGNED NOT NULL,
 statement_id VARCHAR(64) NOT NULL, space_id VARCHAR(64) NOT NULL,
 entry_path VARCHAR(256) NOT NULL, layer VARCHAR(32) NOT NULL,
 body JSON NOT NULL,
 PRIMARY KEY(object_id,version,statement_id),
 INDEX statement_entries(space_id,object_id,version,entry_path)
);
CREATE TABLE knowledge_relations (
 relation_id VARCHAR(64) PRIMARY KEY, space_id VARCHAR(64) NOT NULL,
 subject_id VARCHAR(64) NOT NULL, subject_version BIGINT UNSIGNED NOT NULL,
 predicate VARCHAR(32) NOT NULL, target_kind VARCHAR(16) NOT NULL,
 target_id VARCHAR(64) NOT NULL, body JSON NOT NULL,
 INDEX relation_subject(space_id,subject_id,predicate,target_id),
 INDEX relation_target(space_id,target_id,predicate,subject_id)
);
