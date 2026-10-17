-- 结论正文不可变；命令回执只保留引用，删除会话时一并清理全部条件历史。
CREATE TABLE analysis_evidence (
 id VARCHAR(64) PRIMARY KEY,
 owner_id VARCHAR(64) NOT NULL,
 space_id VARCHAR(64) NOT NULL,
 conversation_id VARCHAR(64) NOT NULL,
 task_id VARCHAR(64) NOT NULL,
 condition_version BIGINT UNSIGNED NOT NULL,
 source_message_id VARCHAR(64) NOT NULL,
 body JSON NOT NULL,
 reference JSON NOT NULL,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 INDEX evidence_task_current(task_id,condition_version,created_at,id),
 INDEX evidence_owner_conversation(owner_id,space_id,conversation_id)
);
CREATE TABLE analysis_evidence_operations (
 owner_id VARCHAR(64) NOT NULL,
 space_id VARCHAR(64) NOT NULL,
 operation_id VARCHAR(64) NOT NULL,
 conversation_id VARCHAR(64) NOT NULL,
 fingerprint VARCHAR(64) NOT NULL,
 receipt JSON NOT NULL,
 PRIMARY KEY(owner_id,operation_id),
 INDEX evidence_operations_conversation(owner_id,space_id,conversation_id)
);
