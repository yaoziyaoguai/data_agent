WITH turns AS (
 SELECT t.*,s.vehicle_id,s.build_id,s.policy_id,s.entry_kind,v.model_id
 FROM syn_voice_turn t JOIN syn_voice_session s ON s.session_id=t.session_id JOIN syn_vehicle v ON v.vehicle_id=s.vehicle_id
 WHERE t.started_at>='2026-09-01T00:00:00Z' AND t.started_at<'2026-10-01T00:00:00Z' AND t.started_at<'2026-10-04T00:00:00Z' AND t.finished_at<'2026-10-04T00:00:00Z' AND t.received_at<'2026-10-04T00:00:00Z' AND t.quality_state='valid'
 AND s.started_at<'2026-10-04T00:00:00Z' AND s.ended_at<'2026-10-04T00:00:00Z' AND s.received_at<'2026-10-04T00:00:00Z' AND s.quality_state='valid' AND s.is_complete=1
 AND v.telemetry_consent=1 AND v.is_lab_unit=0
), tts AS (SELECT r.turn_id,COUNT(*) n,SUM(r.outcome='succeeded') succeeded FROM syn_tts_request r JOIN turns t ON t.turn_id=r.turn_id WHERE r.received_at<'2026-10-04T00:00:00Z' AND CAST(strftime('%s',t.started_at) AS INTEGER)*1000+r.finish_offset_ms<CAST(strftime('%s','2026-10-04T00:00:00Z') AS INTEGER)*1000 GROUP BY r.turn_id),
 plays AS (SELECT p.turn_id,COUNT(*) n,SUM(p.completion_state='complete') completed,MIN(CASE WHEN p.played_ms>0 THEN p.start_offset_ms END) first_start FROM syn_playback_segment p JOIN turns t ON t.turn_id=p.turn_id WHERE p.received_at<'2026-10-04T00:00:00Z' AND CAST(strftime('%s',t.started_at) AS INTEGER)*1000+p.finish_offset_ms<CAST(strftime('%s','2026-10-04T00:00:00Z') AS INTEGER)*1000 GROUP BY p.turn_id)
SELECT t.turn_id,COALESCE(r.n,0) AS tts_attempts,COALESCE(r.succeeded,0) AS tts_succeeded,COALESCE(p.n,0) AS playback_segments,COALESCE(p.completed,0) AS completed_segments,p.first_start-t.input_ms AS first_audio_ms
FROM turns t LEFT JOIN tts r ON r.turn_id=t.turn_id LEFT JOIN plays p ON p.turn_id=t.turn_id WHERE COALESCE(p.n,0)>1 ORDER BY t.turn_id;
