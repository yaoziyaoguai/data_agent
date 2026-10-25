-- 04任务上下文：查询草稿保存口径决策及采纳来源；旧记录保持NULL，不猜回填。
ALTER TABLE query_requests ADD COLUMN semantic_resolution JSON NULL;
