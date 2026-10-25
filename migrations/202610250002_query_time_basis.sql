-- 04任务上下文：查询草稿保存任务当前条件投影的时间基准快照；旧草稿保持NULL，不猜回填。
ALTER TABLE query_requests ADD COLUMN time_basis JSON NULL;
