WITH turns AS (
 SELECT t.*,s.vehicle_id,s.build_id,s.policy_id,s.entry_kind,v.model_id
 FROM syn_voice_turn t JOIN syn_voice_session s ON s.session_id=t.session_id JOIN syn_vehicle v ON v.vehicle_id=s.vehicle_id
 WHERE t.started_at>='2026-09-01T00:00:00Z' AND t.started_at<'2026-10-01T00:00:00Z' AND t.started_at<'2026-10-04T00:00:00Z' AND t.finished_at<'2026-10-04T00:00:00Z' AND t.received_at<'2026-10-04T00:00:00Z' AND t.quality_state='valid'
 AND s.started_at<'2026-10-04T00:00:00Z' AND s.ended_at<'2026-10-04T00:00:00Z' AND s.received_at<'2026-10-04T00:00:00Z' AND s.quality_state='valid' AND s.is_complete=1
 AND v.telemetry_consent=1 AND v.is_lab_unit=0
), clarifying AS (SELECT DISTINCT d.turn_id FROM syn_dialogue_transition d JOIN turns t ON t.turn_id=d.turn_id WHERE d.to_state='awaiting_slot' AND d.received_at<'2026-10-04T00:00:00Z' AND CAST(strftime('%s',t.started_at) AS INTEGER)*1000+d.offset_ms<CAST(strftime('%s','2026-10-04T00:00:00Z') AS INTEGER)*1000)
SELECT COUNT(DISTINCT t.session_id) AS dialogues,COUNT(*) AS turns,COUNT(DISTINCT CASE WHEN c.turn_id IS NOT NULL THEN t.session_id END) AS clarification_dialogues FROM turns t LEFT JOIN clarifying c ON c.turn_id=t.turn_id;
