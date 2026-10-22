WITH turns AS (
 SELECT t.*,s.vehicle_id,s.build_id,s.policy_id,s.entry_kind,v.model_id
 FROM syn_voice_turn t JOIN syn_voice_session s ON s.session_id=t.session_id JOIN syn_vehicle v ON v.vehicle_id=s.vehicle_id
 WHERE t.started_at>='2026-07-01T00:00:00Z' AND t.started_at<'2026-10-01T00:00:00Z' AND t.started_at<'2026-10-04T00:00:00Z' AND t.finished_at<'2026-10-04T00:00:00Z' AND t.received_at<'2026-10-04T00:00:00Z' AND t.quality_state='valid'
 AND s.started_at<'2026-10-04T00:00:00Z' AND s.ended_at<'2026-10-04T00:00:00Z' AND s.received_at<'2026-10-04T00:00:00Z' AND s.quality_state='valid' AND s.is_complete=1
 AND v.telemetry_consent=1 AND v.is_lab_unit=0
), audible AS (
 SELECT p.turn_id,MIN(p.start_offset_ms) AS first_start FROM syn_playback_segment p JOIN turns t ON t.turn_id=p.turn_id
 WHERE p.received_at<'2026-10-04T00:00:00Z' AND CAST(strftime('%s',t.started_at) AS INTEGER)*1000+p.finish_offset_ms<CAST(strftime('%s','2026-10-04T00:00:00Z') AS INTEGER)*1000 AND p.played_ms>0 GROUP BY p.turn_id),
 first_audio AS (SELECT t.*,a.first_start-t.input_ms AS observed_first_audio_ms FROM turns t JOIN audible a ON a.turn_id=t.turn_id), ranked AS (
 SELECT *,ROW_NUMBER() OVER(PARTITION BY build_id,model_id,locale,entry_kind ORDER BY observed_first_audio_ms,turn_id) rn,
 COUNT(*) OVER(PARTITION BY build_id,model_id,locale,entry_kind) n FROM first_audio)
SELECT build_id,model_id,locale,entry_kind,MAX(n) AS audio_samples,MAX(CASE WHEN rn=(n*95+99)/100 THEN observed_first_audio_ms END) AS first_audio_p95_ms
FROM ranked GROUP BY build_id,model_id,locale,entry_kind ORDER BY build_id,model_id,locale,entry_kind;
