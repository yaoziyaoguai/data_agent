-- 未确认的方法草稿独立于正式资产；正文失效后只保留原操作与来源身份。
CREATE TABLE skill_drafts (
 id VARCHAR(64) PRIMARY KEY,
 owner_id VARCHAR(64) NOT NULL,
 space_id VARCHAR(64) NOT NULL,
 conversation_id VARCHAR(64) NOT NULL,
 source_message_id VARCHAR(64) NOT NULL,
 origin_run_id VARCHAR(64) NOT NULL,
 operation_id VARCHAR(64) NOT NULL,
 fingerprint VARCHAR(64) NOT NULL,
 reference JSON NOT NULL,
 state ENUM('pending','confirmed','condition_changed','sources_unavailable') NOT NULL,
 body JSON NULL,
 asset_id VARCHAR(64) NULL,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 UNIQUE KEY skill_draft_operation(owner_id,space_id,operation_id),
 INDEX skill_draft_owner(owner_id,space_id,id),
 INDEX skill_draft_conversation(owner_id,space_id,conversation_id)
);
