-- 标题由首条用户问题生成；游标顺序以不可变创建时间和ID确定。
ALTER TABLE conversations ADD COLUMN title VARCHAR(240), ADD INDEX history_page (owner_id,space_id,deleted,created_at,id);
UPDATE conversations c SET title=(SELECT LEFT(m.body,240) FROM conversation_messages m WHERE m.conversation_id=c.id AND m.client_key NOT LIKE 'result-%' ORDER BY m.created_at,m.id LIMIT 1);
-- 请求接收时固定参考时刻；跨日重试和结果唤醒沿用原值。
ALTER TABLE conversation_messages ADD COLUMN reference_time_utc VARCHAR(32), ADD COLUMN business_timezone VARCHAR(64) NOT NULL DEFAULT 'UTC', ADD INDEX request_clock (budget_scope_id,created_at);
UPDATE conversation_messages SET reference_time_utc=DATE_FORMAT(created_at,'%Y-%m-%dT%H:%i:%s.%fZ');
ALTER TABLE conversation_messages MODIFY COLUMN reference_time_utc VARCHAR(32) NOT NULL DEFAULT (DATE_FORMAT(UTC_TIMESTAMP(3),'%Y-%m-%dT%H:%i:%s.%fZ'));
