ALTER TABLE personal_assets ADD COLUMN draft_origin JSON NULL;

INSERT INTO personal_assets(id,owner_id,space_id,version,kind,state,visibility,body,draft_origin)
SELECT id,owner_id,space_id,1,'skill',IF(state='pending','draft','deleted'),'personal',
 CASE WHEN state='pending' THEN JSON_OBJECT(
   'id',id,'kind','skill','state','draft','version','1','verified',CAST('false' AS JSON),'selected',CAST('false' AS JSON),
   'source_text','','name',JSON_EXTRACT(body,'$.name'),'body',JSON_EXTRACT(body,'$.body'),
   'scope',JSON_EXTRACT(body,'$.scope'),'files',JSON_EXTRACT(body,'$.files'),
   'dependencies',JSON_EXTRACT(body,'$.dependencies')
 ) ELSE JSON_OBJECT() END,
 JSON_OBJECT('reference',reference,'status',state,'asset_id',asset_id,
   'operation_id',operation_id,'origin_run_id',origin_run_id,
   'evidence_refs',JSON_EXTRACT(body,'$.evidence_refs'),'created_at',DATE_FORMAT(created_at,'%Y-%m-%dT%H:%i:%s.%fZ'))
FROM skill_drafts;

UPDATE personal_assets p JOIN skill_drafts d ON d.id=p.id
SET p.body=JSON_SET(p.body,'$.skill_sources',JSON_OBJECT(
    'source_skills',COALESCE(JSON_EXTRACT(d.text_authority,'$.source_skills'),JSON_ARRAY()),
    'source_query_results',COALESCE(JSON_EXTRACT(d.text_authority,'$.source_query_results'),JSON_ARRAY())
))
WHERE d.state='pending'
  AND JSON_CONTAINS_PATH(d.text_authority,'one','$.source_skills[0]','$.source_query_results[0]');

INSERT INTO idempotency_receipts(space_id,actor_id,domain,operation_id,request_hash,response_json,created_at)
SELECT space_id,owner_id,'skill_draft',operation_id,fingerprint,reference,created_at
FROM skill_drafts;

DROP TABLE skill_drafts;
