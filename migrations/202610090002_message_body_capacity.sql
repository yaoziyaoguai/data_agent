-- 消息上限按字符计；32,000 字中文或四字节字符超出 TEXT 的字节容量。
ALTER TABLE conversation_messages MODIFY COLUMN body MEDIUMTEXT NOT NULL;
