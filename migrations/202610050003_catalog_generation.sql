-- 完成的目录即使内容未变，也推进范围代次，阻止晚到旧读取执行缺席删除。
CREATE TABLE catalog_namespace_heads (
 space_id VARCHAR(64) NOT NULL, namespace VARCHAR(256) NOT NULL,
 generation BIGINT UNSIGNED NOT NULL DEFAULT 0,
 PRIMARY KEY(space_id,namespace)
);
ALTER TABLE catalog_imports ADD COLUMN namespace_baseline JSON;
ALTER TABLE catalog_platform_heads ADD COLUMN retired BOOLEAN NOT NULL DEFAULT FALSE;
