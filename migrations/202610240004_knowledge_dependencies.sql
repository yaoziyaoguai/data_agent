CREATE TABLE knowledge_dependencies(
 owner_id VARCHAR(64) NOT NULL,
 owner_version BIGINT UNSIGNED NOT NULL,
 space_id VARCHAR(64) NOT NULL,
 entry_path VARCHAR(64) NOT NULL,
 layer VARCHAR(32) NOT NULL,
 purpose VARCHAR(16) NOT NULL,
 role VARCHAR(32) NOT NULL,
 effective BOOLEAN NOT NULL DEFAULT FALSE,
 target_kind VARCHAR(16) NOT NULL,
 target_id VARCHAR(64) NOT NULL,
 target_revision BIGINT UNSIGNED NOT NULL,
 target_path VARCHAR(64) NOT NULL DEFAULT '',
 target_fingerprint VARCHAR(128) NULL,
 PRIMARY KEY(owner_id,owner_version,entry_path,layer,purpose,role,target_kind,target_id,target_revision,target_path),
 KEY idx_dependency_dependents(space_id,target_kind,target_id,owner_id),
 KEY idx_dependency_effective(owner_id,owner_version,effective,purpose)
);
-- 每个(owner,version)一行映射状态：complete=有效层内容全部可解释（人工内容或已映射来源），
-- unknown=存在无映射来源的自动成果。读取侧不得把缺行或unknown当已知无依赖。
CREATE TABLE knowledge_dependency_states(
 owner_id VARCHAR(64) NOT NULL,
 owner_version BIGINT UNSIGNED NOT NULL,
 space_id VARCHAR(64) NOT NULL,
 mapping_state VARCHAR(16) NOT NULL,
 PRIMARY KEY(owner_id,owner_version),
 KEY idx_dependency_state_space(space_id,mapping_state)
);
