CREATE TABLE idempotency_receipts (
 space_id VARCHAR(64) NOT NULL,
 actor_id VARCHAR(64) NOT NULL,
 domain VARCHAR(32) NOT NULL,
 operation_id VARCHAR(64) NOT NULL,
 request_hash VARCHAR(64) NOT NULL,
 response_json JSON NOT NULL,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 PRIMARY KEY(space_id,actor_id,domain,operation_id),
 INDEX receipt_expiry(created_at)
);

INSERT INTO idempotency_receipts(space_id,actor_id,domain,operation_id,request_hash,response_json)
SELECT space_id,owner_id,'asset',operation_id,fingerprint,receipt
FROM asset_operations WHERE JSON_TYPE(receipt)<>'NULL'
UNION ALL
SELECT space_id,owner_id,'semantic_owner',operation_id,fingerprint,receipt
FROM semantic_owner_operations WHERE JSON_TYPE(receipt)<>'NULL'
UNION ALL
SELECT space_id,owner_id,'semantic_correction',operation_id,fingerprint,receipt
FROM semantic_correction_operations WHERE JSON_TYPE(receipt)<>'NULL'
UNION ALL
SELECT space_id,owner_id,'analysis_preference',operation_id,fingerprint,receipt
FROM analysis_preference_operations WHERE JSON_TYPE(receipt)<>'NULL' AND JSON_LENGTH(receipt)>0
UNION ALL
SELECT space_id,owner_id,'analysis_evidence',operation_id,fingerprint,receipt
FROM analysis_evidence_operations WHERE JSON_TYPE(receipt)<>'NULL'
UNION ALL
SELECT space_id,owner_id,'analysis_report',operation_id,fingerprint,receipt
FROM analysis_report_operations WHERE JSON_TYPE(receipt)<>'NULL';

-- 两个旧表缺空间列。只有能通过已有业务对象确定归属的回执才可接回。
INSERT INTO idempotency_receipts(space_id,actor_id,domain,operation_id,request_hash,response_json)
SELECT c.space_id,o.owner_id,'task_lifecycle',o.operation_id,o.fingerprint,o.receipt
FROM task_lifecycle_operations o
JOIN analysis_tasks t ON t.id=JSON_UNQUOTE(JSON_EXTRACT(o.receipt,'$.resource_id')) AND t.owner_id=o.owner_id
JOIN conversations c ON c.id=t.conversation_id AND c.owner_id=o.owner_id;

INSERT INTO idempotency_receipts(space_id,actor_id,domain,operation_id,request_hash,response_json)
SELECT k.space_id,o.owner_id,'knowledge',o.operation_id,o.fingerprint,o.receipt
FROM knowledge_operations o
JOIN knowledge_objects k ON k.id=JSON_UNQUOTE(COALESCE(
 JSON_EXTRACT(o.receipt,'$.object_id'),
 JSON_EXTRACT(o.receipt,'$.id'),
 JSON_EXTRACT(o.receipt,'$[0].id'),
 JSON_EXTRACT(o.receipt,'$.objects[0].id')
));

DROP TABLE asset_operations, semantic_owner_operations, semantic_correction_operations,
 analysis_preference_operations, analysis_evidence_operations, analysis_report_operations,
 task_lifecycle_operations, knowledge_operations;
