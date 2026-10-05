-- 保留最初输入的请求标识，恢复后仍能关联运行与工具调用。
ALTER TABLE conversation_messages ADD COLUMN request_id VARCHAR(64);
