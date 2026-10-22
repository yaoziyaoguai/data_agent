WITH turns AS (
 SELECT t.*,s.vehicle_id,s.build_id,s.policy_id,s.entry_kind,v.model_id
 FROM syn_voice_turn t JOIN syn_voice_session s ON s.session_id=t.session_id JOIN syn_vehicle v ON v.vehicle_id=s.vehicle_id
 WHERE t.started_at>='2026-09-01T00:00:00Z' AND t.started_at<'2026-10-01T00:00:00Z' AND t.started_at<'2026-10-04T00:00:00Z' AND t.finished_at<'2026-10-04T00:00:00Z' AND t.received_at<'2026-10-04T00:00:00Z' AND t.quality_state='valid'
 AND s.started_at<'2026-10-04T00:00:00Z' AND s.ended_at<'2026-10-04T00:00:00Z' AND s.received_at<'2026-10-04T00:00:00Z' AND s.quality_state='valid' AND s.is_complete=1
 AND v.telemetry_consent=1 AND v.is_lab_unit=0
),
facts AS (SELECT a.*,t.vehicle_id,t.build_id,t.model_id,t.entry_kind,t.locale AS turn_locale,t.started_at AS turn_started_at,t.final_outcome,t.input_ms,t.first_audio_latency_ms FROM syn_asr_attempt a JOIN turns t ON t.turn_id=a.turn_id WHERE a.received_at<'2026-10-04T00:00:00Z' AND CAST(strftime('%s',t.started_at) AS INTEGER)*1000+a.finish_offset_ms<CAST(strftime('%s','2026-10-04T00:00:00Z') AS INTEGER)*1000), ranked AS (SELECT *,ROW_NUMBER() OVER(PARTITION BY turn_id ORDER BY attempt_no,asr_attempt_id) first_rank,ROW_NUMBER() OVER(PARTITION BY turn_id ORDER BY attempt_no DESC,asr_attempt_id DESC) final_rank FROM facts),
 per_turn AS (SELECT turn_id,COUNT(*) attempts,MAX(endpoint_kind='cloud') cloud,MAX(endpoint_kind='edge') edge,MAX(fallback_reason<>'none') fallback,
 MAX(CASE WHEN first_rank=1 THEN outcome END) first_outcome,MAX(CASE WHEN final_rank=1 THEN outcome END) final_outcome FROM ranked GROUP BY turn_id)
SELECT CASE WHEN fallback=1 THEN 'fallback' WHEN cloud=1 AND edge=0 THEN 'cloud_only' WHEN edge=1 AND cloud=0 THEN 'edge_only' ELSE 'mixed_without_fallback_flag' END path,
 COUNT(*) turns,SUM(attempts) attempts,SUM(p.first_outcome='succeeded') first_succeeded,SUM(p.final_outcome='succeeded') final_succeeded,
 SUM(p.first_outcome<>'succeeded' AND p.final_outcome='succeeded') recovered_turns,
 SUM(t.final_outcome='completed') completed_turns,ROUND(AVG(CASE WHEN p.final_outcome='succeeded' THEN t.first_audio_latency_ms END),6) successful_asr_first_audio_mean_ms
FROM per_turn p JOIN turns t ON t.turn_id=p.turn_id GROUP BY path ORDER BY path;
