-- 完整范围与移除判断只在全部分页成功后执行。
ALTER TABLE catalog_platform_heads ADD COLUMN namespace VARCHAR(256) NOT NULL DEFAULT '', ADD COLUMN platform_table_id VARCHAR(256) NOT NULL DEFAULT '';
