-- 旧版只保存最后一次归属；从成功工具回执补回同一输入的全部真实任务。
INSERT IGNORE INTO conversation_message_tasks(message_id,task_id)
 SELECT r.message_id,a.id FROM tool_calls t
 JOIN agent_runs r ON r.id=t.origin_run_id AND r.conversation_id=t.conversation_id
 JOIN conversation_messages m ON m.id=r.message_id AND m.conversation_id=r.conversation_id
 JOIN analysis_tasks a ON a.id=JSON_UNQUOTE(JSON_EXTRACT(t.receipt,'$.data.task_id'))
  AND a.conversation_id=m.conversation_id
 WHERE t.state='succeeded' AND t.tool_name='update_analysis_task'
  AND JSON_TYPE(JSON_EXTRACT(t.receipt,'$.data.task_id'))='STRING';
