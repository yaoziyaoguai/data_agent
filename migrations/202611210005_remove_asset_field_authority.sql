-- 仅迁移既有的 Skill 祖先和查询来源，原逐字段来源中的顺带读取不再参与失效。
UPDATE personal_asset_versions v
JOIN personal_assets p ON p.id=v.asset_id AND p.kind='skill'
SET v.body=JSON_SET(v.body,'$.skill_sources',JSON_OBJECT(
    'source_skills',COALESCE((SELECT JSON_ARRAYAGG(ref) FROM JSON_TABLE(v.field_authorities,'$.*.authority.source_skills[*]' COLUMNS (ref JSON PATH '$')) AS skills),JSON_ARRAY()),
    'source_query_results',COALESCE((SELECT JSON_ARRAYAGG(ref) FROM JSON_TABLE(v.field_authorities,'$.*.authority.source_query_results[*]' COLUMNS (ref JSON PATH '$')) AS queries),JSON_ARRAY())
))
WHERE JSON_CONTAINS_PATH(v.field_authorities,'one',
    '$.*.authority.source_skills[0]','$.*.authority.source_query_results[0]');

UPDATE personal_assets p
JOIN personal_asset_versions v ON v.asset_id=p.id AND v.version=p.version
SET p.body=JSON_SET(p.body,'$.skill_sources',JSON_EXTRACT(v.body,'$.skill_sources'))
WHERE JSON_CONTAINS_PATH(v.body,'one','$.skill_sources');

ALTER TABLE personal_assets DROP COLUMN field_authorities;
ALTER TABLE personal_asset_versions DROP COLUMN field_authorities;
