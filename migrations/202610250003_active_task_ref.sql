-- 04任务上下文：会话级活动任务绑定与消息任务清单分离。回填只取既有route绑定
-- 的最近一次真实归属（有证据数据），无条件任务历史不猜活动目标。
ALTER TABLE conversations ADD COLUMN active_task_id VARCHAR(64) NULL;
ALTER TABLE conversations ADD COLUMN active_task_condition_version BIGINT UNSIGNED NULL;
UPDATE conversations c
SET c.active_task_id = (
  SELECT bound.task_id FROM (
    SELECT COALESCE(b.task_id, m.routed_task_id) AS task_id, MAX(e.event_seq) AS seq
    FROM conversation_messages m
    JOIN conversation_events e ON e.conversation_id = m.conversation_id
         AND e.event_type = 'message'
         AND JSON_UNQUOTE(JSON_EXTRACT(e.payload, '$.message_id')) = m.id
    LEFT JOIN conversation_message_tasks b ON b.message_id = m.id
    WHERE m.conversation_id = c.id AND m.disposition <> 'withdrawn'
      AND COALESCE(b.task_id, m.routed_task_id) IS NOT NULL
    GROUP BY COALESCE(b.task_id, m.routed_task_id)
    ORDER BY seq DESC, task_id
    LIMIT 1
  ) bound
)
WHERE c.active_task_id IS NULL;
UPDATE conversations c
JOIN analysis_tasks t ON t.id = c.active_task_id
SET c.active_task_condition_version = t.condition_version;
