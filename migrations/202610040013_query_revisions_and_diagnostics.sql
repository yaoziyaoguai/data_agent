-- 查询模块保留草稿修订关系、有限提交次数和平台诊断。
ALTER TABLE query_requests
    ADD COLUMN replaces_query_id VARCHAR(64),
    ADD COLUMN submission_attempts INT UNSIGNED NOT NULL DEFAULT 0,
    ADD COLUMN error_details JSON;
CREATE INDEX query_requests_revisions ON query_requests(replaces_query_id);
