INSERT INTO idempotency_receipts(space_id,actor_id,domain,operation_id,request_hash,response_json)
SELECT s.space_id,s.owner_id,'catalog_page',SHA2(CONCAT(p.sync_id,':',p.cursor_key),256),
 p.cursor_key,JSON_OBJECT('sync_id',p.sync_id,'cursor_key',p.cursor_key)
FROM catalog_sync_pages p JOIN catalog_imports s ON s.id=p.sync_id;

DROP TABLE catalog_sync_pages;
