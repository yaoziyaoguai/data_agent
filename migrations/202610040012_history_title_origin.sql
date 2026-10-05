-- 旧空标题按预算所属的原消息补齐，客户端ID前缀不能代表输入来源。
UPDATE conversations c SET title=(
  SELECT LEFT(m.body,240) FROM conversation_messages m
  JOIN budget_scopes b ON b.message_id=m.id
  WHERE m.conversation_id=c.id ORDER BY m.created_at,m.id LIMIT 1
) WHERE c.title IS NULL;
