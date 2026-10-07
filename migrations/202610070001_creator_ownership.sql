CREATE INDEX semantic_creator_pool ON semantic_ownership(space_id,source,maintainer_id,object_id);

-- 仅补首次人工录入且从未指派的独立对象；不改变平台对象、系统预填、转交或撤销。
UPDATE semantic_ownership o
 JOIN knowledge_objects k ON k.space_id=o.space_id AND k.id=o.object_id
 JOIN knowledge_versions v ON v.object_id=k.id AND v.version=1
 SET o.maintainer_id=JSON_UNQUOTE(JSON_EXTRACT(v.body,'$.created_by')),
     o.source='creator',o.version=o.version+1,o.updated_by='creator-backfill'
 WHERE o.source='system' AND o.authority_id=o.object_id
   AND o.maintainer_id IS NULL AND o.version=1
   AND k.kind IN ('metric','document','relationship','term') AND k.source_id IS NULL
   AND JSON_UNQUOTE(JSON_EXTRACT(v.body,'$.created_by'))=JSON_UNQUOTE(JSON_EXTRACT(v.body,'$.entries[0].human_override.edited_by'))
   AND JSON_UNQUOTE(JSON_EXTRACT(v.body,'$.created_by')) NOT IN ('','synthetic-import','system');
