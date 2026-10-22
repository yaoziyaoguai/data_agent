WITH turns AS (
 SELECT t.*,s.vehicle_id,s.build_id,s.policy_id,s.entry_kind,v.model_id
 FROM syn_voice_turn t JOIN syn_voice_session s ON s.session_id=t.session_id JOIN syn_vehicle v ON v.vehicle_id=s.vehicle_id
 WHERE t.started_at>='2026-09-01T00:00:00Z' AND t.started_at<'2026-10-01T00:00:00Z' AND t.started_at<'2026-10-04T00:00:00Z' AND t.finished_at<'2026-10-04T00:00:00Z' AND t.received_at<'2026-10-04T00:00:00Z' AND t.quality_state='valid'
 AND s.started_at<'2026-10-04T00:00:00Z' AND s.ended_at<'2026-10-04T00:00:00Z' AND s.received_at<'2026-10-04T00:00:00Z' AND s.quality_state='valid' AND s.is_complete=1
 AND v.telemetry_consent=1 AND v.is_lab_unit=0
), chosen AS (SELECT n.turn_id,n.predicted_intent_id FROM syn_nlu_attempt n JOIN turns t ON t.turn_id=n.turn_id WHERE n.selected_for_dialogue=1 AND n.received_at<'2026-10-04T00:00:00Z' AND CAST(strftime('%s',t.started_at) AS INTEGER)*1000+n.finish_offset_ms<CAST(strftime('%s','2026-10-04T00:00:00Z') AS INTEGER)*1000)
SELECT COUNT(*) AS eligible_turns,COUNT(t.reference_intent_id) AS labeled_turns,SUM(CASE WHEN t.reference_intent_id IS NOT NULL AND n.predicted_intent_id=t.reference_intent_id THEN 1 ELSE 0 END) AS intent_matches,
 ROUND(SUM(CASE WHEN t.reference_intent_id IS NOT NULL AND n.predicted_intent_id=t.reference_intent_id THEN 1 ELSE 0 END)*1.0/NULLIF(COUNT(t.reference_intent_id),0),6) AS intent_match_rate
FROM turns t LEFT JOIN chosen n ON n.turn_id=t.turn_id WHERE t.final_outcome IN ('completed','clarification_pending','rejected','failed','unknown');
