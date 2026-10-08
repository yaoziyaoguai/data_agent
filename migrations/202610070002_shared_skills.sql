ALTER TABLE personal_assets ADD COLUMN visibility VARCHAR(16) NOT NULL DEFAULT 'personal', ADD INDEX asset_visibility (space_id,visibility,state,id), ADD CONSTRAINT asset_visibility_kind CHECK (visibility='personal' OR (visibility='space' AND kind='skill'));
CREATE TABLE skill_publications (
 source_asset_id VARCHAR(64) PRIMARY KEY,
 public_asset_id VARCHAR(64) NOT NULL UNIQUE,
 source_version BIGINT UNSIGNED NOT NULL,
 space_id VARCHAR(64) NOT NULL
);
CREATE TABLE skill_suggestions (
 id VARCHAR(64) PRIMARY KEY,
 asset_id VARCHAR(64) NOT NULL,
 space_id VARCHAR(64) NOT NULL,
 revision BIGINT UNSIGNED NOT NULL,
 body JSON NOT NULL,
 INDEX skill_suggestion_page (asset_id,space_id,id)
);

-- 旧开发身份均属于 demo；操作回执也必须按空间隔离。
ALTER TABLE asset_operations ADD COLUMN space_id VARCHAR(64) NOT NULL DEFAULT 'demo', DROP PRIMARY KEY, ADD PRIMARY KEY(owner_id,space_id,operation_id);
