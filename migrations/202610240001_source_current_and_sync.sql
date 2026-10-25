-- 来源当前正文与观测元数据分离；旧快照保留，回填按当前头分批进行。
CREATE TABLE source_current (
 source_id VARCHAR(64) PRIMARY KEY, space_id VARCHAR(64) NOT NULL,
 adapter_id VARCHAR(64) NOT NULL, source_kind VARCHAR(16) NOT NULL,
 namespace VARCHAR(256) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
 external_id VARCHAR(256) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
 revision BIGINT UNSIGNED NOT NULL, body LONGTEXT NOT NULL, complete BOOLEAN NOT NULL DEFAULT TRUE, metadata JSON NOT NULL,
 content_fingerprint VARCHAR(64) NOT NULL, explanation_fingerprint VARCHAR(64) NOT NULL,
 comparison_method VARCHAR(64) NOT NULL, parsed BOOLEAN NOT NULL,
 observed_metadata JSON NOT NULL,
 UNIQUE(space_id,adapter_id,source_kind,namespace,external_id)
);
-- 外部身份沿适配器原字符串比较，与来源ID的指纹一致；不折叠大小写或重音。
ALTER TABLE catalog_namespace_heads
 MODIFY namespace VARCHAR(256) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL;
ALTER TABLE catalog_platform_heads
 MODIFY namespace VARCHAR(256) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL DEFAULT '';
ALTER TABLE catalog_imports
 ADD COLUMN background BOOLEAN NOT NULL DEFAULT FALSE,
 ADD COLUMN error_message VARCHAR(1024),
 ADD COLUMN cursor_value VARCHAR(256),
 ADD COLUMN snapshot_id VARCHAR(256),
 ADD COLUMN source_namespace VARCHAR(256),
 ADD COLUMN authoritative BOOLEAN,
 ADD COLUMN processed_sources BIGINT UNSIGNED NOT NULL DEFAULT 0,
 ADD COLUMN pages_committed BIGINT UNSIGNED NOT NULL DEFAULT 0,
 ADD COLUMN directory_complete BOOLEAN NOT NULL DEFAULT FALSE;
CREATE TABLE catalog_sync_members (
 sync_id VARCHAR(64) NOT NULL, source_id VARCHAR(64) NOT NULL,
 platform_table_id VARCHAR(256) NOT NULL, accepted_revision BIGINT UNSIGNED NOT NULL,
 retained_objects JSON NOT NULL, pending_maintainers JSON NOT NULL,
 PRIMARY KEY(sync_id,source_id)
);
CREATE TABLE catalog_sync_pages (
 sync_id VARCHAR(64) NOT NULL, cursor_key VARCHAR(64) NOT NULL,
 PRIMARY KEY(sync_id,cursor_key)
);
-- 同一队列扩展具名目标；未接入的消费者不会领取新kind/schema。
ALTER TABLE background_jobs
 MODIFY conversation_id VARCHAR(64) NULL,
 MODIFY message_id VARCHAR(64) NULL,
 ADD COLUMN kind VARCHAR(32) NOT NULL DEFAULT 'message',
 ADD COLUMN schema_version INT UNSIGNED NOT NULL DEFAULT 1,
 ADD COLUMN resource_id VARCHAR(64),
 ADD COLUMN resource_version BIGINT UNSIGNED,
 ADD UNIQUE(kind,resource_id,resource_version),
 ADD INDEX jobs_target_due(kind,schema_version,state,lease_until);
