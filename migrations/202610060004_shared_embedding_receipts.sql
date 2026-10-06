-- runtime保存已结算向量回执，索引重发无需再次调用付费模型。
ALTER TABLE model_call_attempts ADD COLUMN response_json JSON;
-- 同一知识版本的维护预算首次绑定后保持，Worker重试不能获得新额度。
ALTER TABLE knowledge_index_jobs ADD COLUMN embedding_profile JSON;
