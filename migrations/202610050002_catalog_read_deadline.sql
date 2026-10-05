-- 中断的目录读取不换基线自动重发；超时明确失败，新同步重新采集。
ALTER TABLE catalog_imports ADD COLUMN lease_until DATETIME(3);
UPDATE catalog_imports SET state='failed',error_code='source_interrupted' WHERE state='fetching';
