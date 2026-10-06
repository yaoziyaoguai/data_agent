-- 本系统语义授权，与平台查询授权独立。字段引用表的授权记录。
CREATE TABLE semantic_ownership (
 space_id VARCHAR(64) NOT NULL,
 object_id VARCHAR(64) NOT NULL,
 authority_id VARCHAR(64) NOT NULL,
 maintainer_id VARCHAR(64) NULL,
 source VARCHAR(16) NOT NULL,
 version BIGINT UNSIGNED NOT NULL DEFAULT 1,
 updated_by VARCHAR(64) NOT NULL,
 PRIMARY KEY(space_id,object_id),
 INDEX semantic_authority(space_id,authority_id)
);
CREATE TABLE semantic_owner_operations (
 space_id VARCHAR(64) NOT NULL,
 owner_id VARCHAR(64) NOT NULL,
 operation_id VARCHAR(64) NOT NULL,
 fingerprint CHAR(64) NOT NULL,
 receipt JSON NOT NULL,
 PRIMARY KEY(space_id,owner_id,operation_id)
);
-- 独立的显式共享记录；旧 semantic_change_proposals 保持私人归属。
CREATE TABLE semantic_corrections (
 id VARCHAR(64) NOT NULL PRIMARY KEY,
 space_id VARCHAR(64) NOT NULL,
 submitter_id VARCHAR(64) NOT NULL,
 object_id VARCHAR(64) NOT NULL,
 revision BIGINT UNSIGNED NOT NULL,
 state VARCHAR(16) NOT NULL,
 body JSON NOT NULL,
 INDEX correction_inbox(space_id,object_id,id),
 INDEX correction_mine(space_id,submitter_id,id)
);
CREATE TABLE semantic_correction_operations (
 space_id VARCHAR(64) NOT NULL,
 owner_id VARCHAR(64) NOT NULL,
 operation_id VARCHAR(64) NOT NULL,
 fingerprint CHAR(64) NOT NULL,
 receipt JSON NOT NULL,
 PRIMARY KEY(space_id,owner_id,operation_id)
);
-- 录入者取自首版，不以最后修改者或负责人推断。
UPDATE knowledge_objects k JOIN knowledge_versions v ON v.object_id=k.id AND v.version=1
 SET k.body=JSON_SET(k.body,'$.created_by',JSON_UNQUOTE(JSON_EXTRACT(v.body,'$.updated_by')));
UPDATE knowledge_versions v JOIN knowledge_objects k ON k.id=v.object_id
 SET v.body=JSON_SET(v.body,'$.created_by',JSON_UNQUOTE(JSON_EXTRACT(k.body,'$.created_by')));
