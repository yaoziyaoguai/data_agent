-- 旧内联SDK检查点只读迁移：绑定交付选定的不可变副本，避免读取时换成其他运行的历史。
ALTER TABLE agent_runs ADD COLUMN legacy_delivery_checkpoint JSON NULL;
