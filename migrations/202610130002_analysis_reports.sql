-- 每个任务只有一份报告，正文以不可变修订保存；命令回执只保留引用。
CREATE TABLE analysis_reports (
 id VARCHAR(64) PRIMARY KEY,
 owner_id VARCHAR(64) NOT NULL,
 space_id VARCHAR(64) NOT NULL,
 conversation_id VARCHAR(64) NOT NULL,
 task_id VARCHAR(64) NOT NULL,
 version BIGINT UNSIGNED NOT NULL,
 reference JSON NOT NULL,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 UNIQUE KEY report_task(task_id),
 INDEX report_owner_conversation(owner_id,space_id,conversation_id)
);
CREATE TABLE analysis_report_revisions (
 report_id VARCHAR(64) NOT NULL,
 version BIGINT UNSIGNED NOT NULL,
 condition_version BIGINT UNSIGNED NOT NULL,
 source_message_id VARCHAR(64) NOT NULL,
 body JSON NOT NULL,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 PRIMARY KEY(report_id,version)
);
CREATE TABLE analysis_report_operations (
 owner_id VARCHAR(64) NOT NULL,
 space_id VARCHAR(64) NOT NULL,
 operation_id VARCHAR(64) NOT NULL,
 conversation_id VARCHAR(64) NOT NULL,
 fingerprint VARCHAR(64) NOT NULL,
 receipt JSON NOT NULL,
 PRIMARY KEY(owner_id,operation_id),
 INDEX report_operations_conversation(owner_id,space_id,conversation_id)
);
