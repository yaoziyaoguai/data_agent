-- 对话授权绑定真实用户消息；旧客户端确认记录保持 NULL。
ALTER TABLE query_requests ADD COLUMN confirmation_message_id VARCHAR(64) NULL;
