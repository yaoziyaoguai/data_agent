-- ingestion拥有维护范围与调度优先级；不修改正式知识版本。
CREATE TABLE table_analysis_preferences (
 space_id VARCHAR(64) NOT NULL, table_id VARCHAR(64) NOT NULL,
 version BIGINT UNSIGNED NOT NULL DEFAULT 1, preferred BOOLEAN NOT NULL DEFAULT FALSE,
 updated_by VARCHAR(64), PRIMARY KEY(space_id,table_id)
);
CREATE TABLE analysis_preference_operations (
 space_id VARCHAR(64) NOT NULL, owner_id VARCHAR(64) NOT NULL, operation_id VARCHAR(64) NOT NULL,
 fingerprint VARCHAR(64) NOT NULL, receipt JSON NOT NULL,
 PRIMARY KEY(space_id,owner_id,operation_id)
);
ALTER TABLE prefill_attempts
 ADD table_id VARCHAR(64), ADD priority TINYINT UNSIGNED NOT NULL DEFAULT 0;
UPDATE prefill_attempts SET table_id = CASE
 WHEN JSON_UNQUOTE(JSON_EXTRACT(input_json,'$.object.kind'))='table' THEN object_id
 WHEN JSON_UNQUOTE(JSON_EXTRACT(input_json,'$.object.kind'))='field' THEN JSON_UNQUOTE(JSON_EXTRACT(input_json,'$.object.related_ids[0]'))
 ELSE NULL END;
CREATE INDEX prefill_priority_order ON prefill_attempts(space_id,state,priority DESC,created_at,id);
