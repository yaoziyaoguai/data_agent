-- ingestion拥有采集前基线与平台版本；原始表快照支持按需重分析。
CREATE TABLE catalog_imports (
 id VARCHAR(64) PRIMARY KEY, space_id VARCHAR(64) NOT NULL, owner_id VARCHAR(64) NOT NULL,
 operation_id VARCHAR(64) NOT NULL, baseline JSON NOT NULL, state VARCHAR(16) NOT NULL,
 receipt JSON, error_code VARCHAR(64), created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 UNIQUE(space_id,owner_id,operation_id)
);
CREATE TABLE catalog_platform_heads (
 source_id VARCHAR(64) PRIMARY KEY, platform_version BIGINT UNSIGNED NOT NULL
);
CREATE TABLE catalog_table_snapshots (
 source_id VARCHAR(64) NOT NULL, version BIGINT UNSIGNED NOT NULL, namespace VARCHAR(256) NOT NULL,
 body JSON NOT NULL, PRIMARY KEY(source_id,version)
);
