WITH turns AS (
 SELECT t.*,s.vehicle_id,s.build_id,s.policy_id,s.entry_kind,v.model_id
 FROM syn_voice_turn t JOIN syn_voice_session s ON s.session_id=t.session_id JOIN syn_vehicle v ON v.vehicle_id=s.vehicle_id
 WHERE t.started_at>='2026-07-01T00:00:00Z' AND t.started_at<'2026-10-01T00:00:00Z' AND t.started_at<'2026-10-04T00:00:00Z' AND t.finished_at<'2026-10-04T00:00:00Z' AND t.received_at<'2026-10-04T00:00:00Z' AND t.quality_state='valid'
 AND s.started_at<'2026-10-04T00:00:00Z' AND s.ended_at<'2026-10-04T00:00:00Z' AND s.received_at<'2026-10-04T00:00:00Z' AND s.quality_state='valid' AND s.is_complete=1
 AND v.telemetry_consent=1 AND v.is_lab_unit=0
)
SELECT substr(started_at,1,7) month,COUNT(*) turns,SUM(final_outcome IN ('completed','clarification_pending','rejected','failed','unknown')) eligible,SUM(final_outcome='completed') completed,
 ROUND(SUM(final_outcome='completed')*1.0/NULLIF(SUM(final_outcome IN ('completed','clarification_pending','rejected','failed','unknown')),0),6) completion_rate,
 COUNT(first_audio_latency_ms) first_audio_samples,ROUND(AVG(first_audio_latency_ms),6) first_audio_mean_ms
FROM turns GROUP BY month ORDER BY month;
