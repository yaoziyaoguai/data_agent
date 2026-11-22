-- SQL 与分析证据已有结构化知识、查询和结果引用；不保留派生正文快照。
ALTER TABLE query_requests DROP COLUMN text_authority;
ALTER TABLE analysis_evidence DROP COLUMN text_authority;
