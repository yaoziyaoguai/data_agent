-- 模型生成资产的正文来源不随确认、启停或公开副本丢失；旧NULL由持久操作记录判别。
ALTER TABLE personal_assets ADD COLUMN field_authorities JSON NULL;
ALTER TABLE personal_asset_versions ADD COLUMN field_authorities JSON NULL;
ALTER TABLE skill_drafts ADD COLUMN text_authority JSON NULL;
