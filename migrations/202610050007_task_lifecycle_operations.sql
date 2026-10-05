-- 取消命令按用户及操作身份保存回执，网络重传不能再次中断剩余任务。
CREATE TABLE task_lifecycle_operations (
 owner_id VARCHAR(64) NOT NULL, operation_id VARCHAR(64) NOT NULL,
 fingerprint VARCHAR(64) NOT NULL, receipt JSON NOT NULL,
 PRIMARY KEY(owner_id,operation_id)
);
