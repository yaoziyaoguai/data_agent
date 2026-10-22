WITH turns AS (
 SELECT t.*,s.vehicle_id,s.build_id,s.policy_id,s.entry_kind,v.model_id
 FROM syn_voice_turn t JOIN syn_voice_session s ON s.session_id=t.session_id JOIN syn_vehicle v ON v.vehicle_id=s.vehicle_id
 WHERE t.started_at>='2026-09-01T00:00:00Z' AND t.started_at<'2026-10-01T00:00:00Z' AND t.started_at<'2026-10-04T00:00:00Z' AND t.finished_at<'2026-10-04T00:00:00Z' AND t.received_at<'2026-10-04T00:00:00Z' AND t.quality_state='valid'
 AND s.started_at<'2026-10-04T00:00:00Z' AND s.ended_at<'2026-10-04T00:00:00Z' AND s.received_at<'2026-10-04T00:00:00Z' AND s.quality_state='valid' AND s.is_complete=1
 AND v.telemetry_consent=1 AND v.is_lab_unit=0
)
SELECT SUM(t.entry_kind IN ('button','continuous') AND NOT EXISTS(SELECT 1 FROM syn_wakeup_attempt w WHERE w.session_id=t.session_id AND w.received_at<'2026-10-04T00:00:00Z' AND w.quality_state='valid')) AS legal_no_wakeup_turns,
 SUM(t.final_outcome='no_speech') AS no_speech_turns,
 SUM(NOT EXISTS(SELECT 1 FROM syn_tts_request r WHERE r.turn_id=t.turn_id AND r.received_at<'2026-10-04T00:00:00Z')) AS no_tts_turns,
 SUM(t.first_audio_latency_ms IS NULL) AS no_observed_first_audio,
 SUM(t.first_audio_latency_ms=0) AS observed_zero_first_audio
FROM turns t;
