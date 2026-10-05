-- conversations：会话、输入和持久展示事件；runtime：运行、恢复和调用账本。
CREATE TABLE conversations (
 id VARCHAR(64) PRIMARY KEY, owner_id VARCHAR(64) NOT NULL, space_id VARCHAR(64) NOT NULL,
 creation_key VARCHAR(64) NOT NULL, event_seq BIGINT UNSIGNED NOT NULL DEFAULT 0,
 lease_epoch BIGINT UNSIGNED NOT NULL DEFAULT 0, lease_owner VARCHAR(64), lease_until DATETIME(3),
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), UNIQUE(owner_id, space_id, creation_key)
);
CREATE TABLE conversation_messages (
 id VARCHAR(64) PRIMARY KEY, conversation_id VARCHAR(64) NOT NULL, owner_id VARCHAR(64) NOT NULL,
 client_key VARCHAR(64) NOT NULL, body TEXT NOT NULL, fingerprint VARCHAR(64) NOT NULL,
 recovery_chain_id VARCHAR(64) NOT NULL, budget_scope_id VARCHAR(64) NOT NULL,
 disposition VARCHAR(16) NOT NULL DEFAULT 'pending', created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 UNIQUE(owner_id,client_key), FOREIGN KEY(conversation_id) REFERENCES conversations(id)
);
CREATE TABLE conversation_events (
 event_id VARCHAR(64) PRIMARY KEY, conversation_id VARCHAR(64) NOT NULL, event_seq BIGINT UNSIGNED NOT NULL,
 event_type VARCHAR(32) NOT NULL, payload JSON NOT NULL, UNIQUE(conversation_id,event_seq),
 FOREIGN KEY(conversation_id) REFERENCES conversations(id)
);
-- analysis：受控工具创建的业务任务，幂等键来自宿主工具账本。
CREATE TABLE analysis_tasks (
 id VARCHAR(64) PRIMARY KEY, conversation_id VARCHAR(64) NOT NULL, owner_id VARCHAR(64) NOT NULL,
 operation_id VARCHAR(64) NOT NULL, goal TEXT NOT NULL, condition_version BIGINT UNSIGNED NOT NULL DEFAULT 1,
 UNIQUE(conversation_id,operation_id), FOREIGN KEY(conversation_id) REFERENCES conversations(id)
);
CREATE TABLE agent_runs (
 id VARCHAR(64) PRIMARY KEY, conversation_id VARCHAR(64) NOT NULL, message_id VARCHAR(64) NOT NULL,
 recovery_chain_id VARCHAR(64) NOT NULL, budget_scope_id VARCHAR(64) NOT NULL,
 lease_epoch BIGINT UNSIGNED NOT NULL, state VARCHAR(16) NOT NULL,
 job_id VARCHAR(64) NOT NULL, job_lease_epoch BIGINT UNSIGNED NOT NULL,
 output_id VARCHAR(64) NOT NULL, attempt_id VARCHAR(64) NOT NULL,
 commit_id VARCHAR(64), commit_fingerprint VARCHAR(64),
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 FOREIGN KEY(conversation_id) REFERENCES conversations(id), FOREIGN KEY(message_id) REFERENCES conversation_messages(id)
);
CREATE TABLE pi_checkpoints (
 recovery_chain_id VARCHAR(64) PRIMARY KEY, checkpoint JSON NOT NULL,
 version BIGINT UNSIGNED NOT NULL DEFAULT 1
);
CREATE TABLE tool_calls (
 operation_id VARCHAR(64) PRIMARY KEY, conversation_id VARCHAR(64) NOT NULL,
 recovery_chain_id VARCHAR(64) NOT NULL, sdk_tool_call_id VARCHAR(64) NOT NULL,
 origin_run_id VARCHAR(64) NOT NULL, tool_name VARCHAR(64) NOT NULL,
 arguments_fingerprint VARCHAR(64) NOT NULL, state VARCHAR(16) NOT NULL, receipt JSON,
 UNIQUE(conversation_id,recovery_chain_id,sdk_tool_call_id)
);
CREATE TABLE assistant_outputs (
 attempt_id VARCHAR(64) PRIMARY KEY, output_id VARCHAR(64) NOT NULL, run_id VARCHAR(64) NOT NULL,
 state VARCHAR(16) NOT NULL, replaces_attempt_id VARCHAR(64), final_text TEXT,
 FOREIGN KEY(run_id) REFERENCES agent_runs(id)
);
CREATE TABLE output_chunks (
 attempt_id VARCHAR(64) NOT NULL, chunk_seq BIGINT UNSIGNED NOT NULL, body TEXT NOT NULL,
 PRIMARY KEY(attempt_id,chunk_seq), FOREIGN KEY(attempt_id) REFERENCES assistant_outputs(attempt_id)
);
CREATE TABLE budget_scopes (
 id VARCHAR(64) PRIMARY KEY, message_id VARCHAR(64) NOT NULL UNIQUE,
 call_limit INT UNSIGNED NOT NULL, issued_calls INT UNSIGNED NOT NULL DEFAULT 0
);
CREATE TABLE model_call_attempts (
 id VARCHAR(64) PRIMARY KEY, budget_scope_id VARCHAR(64) NOT NULL, run_id VARCHAR(64) NOT NULL,
 state VARCHAR(16) NOT NULL, FOREIGN KEY(budget_scope_id) REFERENCES budget_scopes(id)
);
-- jobs：作业租约与会话租约分别记录。
CREATE TABLE background_jobs (
 id VARCHAR(64) PRIMARY KEY, conversation_id VARCHAR(64) NOT NULL, message_id VARCHAR(64) NOT NULL UNIQUE,
 state VARCHAR(16) NOT NULL DEFAULT 'queued', lease_owner VARCHAR(64), lease_epoch BIGINT UNSIGNED NOT NULL DEFAULT 0,
 lease_until DATETIME(3), attempts INT UNSIGNED NOT NULL DEFAULT 0,
 FOREIGN KEY(conversation_id) REFERENCES conversations(id), FOREIGN KEY(message_id) REFERENCES conversation_messages(id)
);
