-- 会话写入锁使入队顺序等于接收顺序；跨会话可独立领取。
ALTER TABLE background_jobs ADD COLUMN dispatch_seq BIGINT UNSIGNED NOT NULL AUTO_INCREMENT UNIQUE;
CREATE INDEX jobs_conversation_order ON background_jobs(conversation_id,dispatch_seq,state);
