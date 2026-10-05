-- 过期扫描与领取各有范围索引，避免锁住无关的排队任务插入区间。
CREATE INDEX prefill_expiration ON prefill_attempts(space_id,state,issued_until);
CREATE INDEX prefill_queue_order ON prefill_attempts(space_id,state,created_at,id);
