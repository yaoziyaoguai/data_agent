WITH turns AS (
 SELECT t.*,s.vehicle_id,s.build_id,s.policy_id,s.entry_kind,v.model_id
 FROM syn_voice_turn t JOIN syn_voice_session s ON s.session_id=t.session_id JOIN syn_vehicle v ON v.vehicle_id=s.vehicle_id
 WHERE t.started_at>='2026-09-01T00:00:00Z' AND t.started_at<'2026-10-01T00:00:00Z' AND t.started_at<'2026-10-04T00:00:00Z' AND t.finished_at<'2026-10-04T00:00:00Z' AND t.received_at<'2026-10-04T00:00:00Z' AND t.quality_state='valid'
 AND s.started_at<'2026-10-04T00:00:00Z' AND s.ended_at<'2026-10-04T00:00:00Z' AND s.received_at<'2026-10-04T00:00:00Z' AND s.quality_state='valid' AND s.is_complete=1
 AND v.telemetry_consent=1 AND v.is_lab_unit=0
),
facts AS (SELECT n.*,t.vehicle_id,t.build_id,t.model_id,t.entry_kind,t.locale AS turn_locale,t.started_at AS turn_started_at,t.final_outcome,t.input_ms,t.first_audio_latency_ms FROM syn_nlu_attempt n JOIN turns t ON t.turn_id=n.turn_id WHERE n.received_at<'2026-10-04T00:00:00Z' AND CAST(strftime('%s',t.started_at) AS INTEGER)*1000+n.finish_offset_ms<CAST(strftime('%s','2026-10-04T00:00:00Z') AS INTEGER)*1000), slots AS (SELECT s.nlu_attempt_id,COUNT(*) AS slot_rows,SUM(s.is_required=1) AS required_rows,SUM(s.is_required=1 AND s.is_resolved=0) AS unresolved_required FROM syn_slot_value s JOIN facts n ON n.nlu_attempt_id=s.nlu_attempt_id WHERE s.received_at<'2026-10-04T00:00:00Z' GROUP BY s.nlu_attempt_id)
SELECT COALESCE(n.predicted_intent_id,'unresolved_intent') AS intent_id,COUNT(*) AS selected_turns,
 SUM(n.missing_required_slots) AS declared_missing_slots,SUM(COALESCE(s.required_rows,0)) AS required_slot_rows,
 SUM(COALESCE(s.unresolved_required,0)) AS unresolved_required_slot_rows,SUM(n.missing_required_slots=0) AS no_declared_missing_turns
FROM facts n LEFT JOIN slots s ON s.nlu_attempt_id=n.nlu_attempt_id WHERE n.selected_for_dialogue=1 GROUP BY intent_id ORDER BY intent_id;
