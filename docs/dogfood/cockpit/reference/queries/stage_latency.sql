WITH turns AS (
 SELECT t.*,s.vehicle_id,s.build_id,s.policy_id,s.entry_kind,v.model_id
 FROM syn_voice_turn t JOIN syn_voice_session s ON s.session_id=t.session_id JOIN syn_vehicle v ON v.vehicle_id=s.vehicle_id
 WHERE t.started_at>='2026-09-01T00:00:00Z' AND t.started_at<'2026-10-01T00:00:00Z' AND t.started_at<'2026-10-04T00:00:00Z' AND t.finished_at<'2026-10-04T00:00:00Z' AND t.received_at<'2026-10-04T00:00:00Z' AND t.quality_state='valid'
 AND s.started_at<'2026-10-04T00:00:00Z' AND s.ended_at<'2026-10-04T00:00:00Z' AND s.received_at<'2026-10-04T00:00:00Z' AND s.quality_state='valid' AND s.is_complete=1
 AND v.telemetry_consent=1 AND v.is_lab_unit=0
),
stage_rows AS (
 SELECT 'asr' AS stage,a.endpoint_kind,a.outcome,a.wall_ms,a.queued_ms,t.turn_id,t.build_id FROM syn_asr_attempt a JOIN turns t ON t.turn_id=a.turn_id WHERE a.received_at<'2026-10-04T00:00:00Z' AND CAST(strftime('%s',t.started_at) AS INTEGER)*1000+a.finish_offset_ms<CAST(strftime('%s','2026-10-04T00:00:00Z') AS INTEGER)*1000
 UNION ALL SELECT 'nlu',n.endpoint_kind,n.outcome,n.wall_ms,n.queued_ms,t.turn_id,t.build_id FROM syn_nlu_attempt n JOIN turns t ON t.turn_id=n.turn_id WHERE n.received_at<'2026-10-04T00:00:00Z' AND CAST(strftime('%s',t.started_at) AS INTEGER)*1000+n.finish_offset_ms<CAST(strftime('%s','2026-10-04T00:00:00Z') AS INTEGER)*1000
 UNION ALL SELECT 'tts',r.endpoint_kind,r.outcome,r.wall_ms,0,t.turn_id,t.build_id FROM syn_tts_request r JOIN turns t ON t.turn_id=r.turn_id WHERE r.received_at<'2026-10-04T00:00:00Z' AND CAST(strftime('%s',t.started_at) AS INTEGER)*1000+r.finish_offset_ms<CAST(strftime('%s','2026-10-04T00:00:00Z') AS INTEGER)*1000
), r AS (SELECT *,ROW_NUMBER() OVER(PARTITION BY stage,endpoint_kind ORDER BY wall_ms,turn_id) rn,COUNT(*) OVER(PARTITION BY stage,endpoint_kind) n FROM stage_rows WHERE wall_ms IS NOT NULL)
SELECT stage,endpoint_kind,MAX(n) AS samples,ROUND(AVG(wall_ms),6) AS mean_ms,MAX(CASE WHEN rn=(n*95+99)/100 THEN wall_ms END) AS p95_ms,ROUND(AVG(queued_ms),6) AS mean_queue_ms FROM r GROUP BY stage,endpoint_kind ORDER BY stage,endpoint_kind;
