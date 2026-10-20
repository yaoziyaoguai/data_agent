-- 查询正文复用宿主完整来源；升级前 NULL 正文只返回控制状态，不能重新确认执行。
ALTER TABLE query_requests ADD COLUMN text_authority JSON NULL;
