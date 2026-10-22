WITH turns AS (
 SELECT t.*,s.vehicle_id,s.build_id,s.policy_id,s.entry_kind,v.model_id
 FROM syn_voice_turn t JOIN syn_voice_session s ON s.session_id=t.session_id JOIN syn_vehicle v ON v.vehicle_id=s.vehicle_id
 WHERE t.started_at>='2026-09-01T00:00:00Z' AND t.started_at<'2026-10-01T00:00:00Z' AND t.started_at<'2026-10-04T00:00:00Z' AND t.finished_at<'2026-10-04T00:00:00Z' AND t.received_at<'2026-10-04T00:00:00Z' AND t.quality_state='valid'
 AND s.started_at<'2026-10-04T00:00:00Z' AND s.ended_at<'2026-10-04T00:00:00Z' AND s.received_at<'2026-10-04T00:00:00Z' AND s.quality_state='valid' AND s.is_complete=1
 AND v.telemetry_consent=1 AND v.is_lab_unit=0
),
feedback AS (SELECT f.*,ROW_NUMBER() OVER(PARTITION BY f.turn_id ORDER BY f.collected_at DESC,f.feedback_id DESC) rn FROM syn_turn_feedback f JOIN turns t ON t.turn_id=f.turn_id WHERE f.collected_at<'2026-10-04T00:00:00Z' AND f.received_at<'2026-10-04T00:00:00Z' AND f.quality_state='valid' AND f.is_explicit=1)
SELECT COUNT(*) AS turns,COUNT(f.feedback_id) AS feedback_turns,COUNT(CASE WHEN f.rating='positive' THEN 1 END) AS positive_turns,
 ROUND(COUNT(f.feedback_id)*1.0/NULLIF(COUNT(*),0),6) AS feedback_coverage,
 ROUND(COUNT(CASE WHEN f.rating='positive' THEN 1 END)*1.0/NULLIF(COUNT(f.feedback_id),0),6) AS positive_rate
FROM turns t LEFT JOIN feedback f ON f.turn_id=t.turn_id AND f.rn=1;
