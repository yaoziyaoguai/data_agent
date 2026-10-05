-- 一条输入可包含多个目标；保留全部归属以支持混合输入取消后续接。
CREATE TABLE conversation_message_tasks (
 message_id VARCHAR(64) NOT NULL, task_id VARCHAR(64) NOT NULL,
 PRIMARY KEY(message_id,task_id), INDEX task_messages(task_id,message_id)
);
INSERT INTO conversation_message_tasks(message_id,task_id)
 SELECT id,routed_task_id FROM conversation_messages WHERE routed_task_id IS NOT NULL;
