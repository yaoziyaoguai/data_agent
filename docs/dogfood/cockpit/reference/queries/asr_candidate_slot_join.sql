WITH turns AS (
 SELECT t.*,s.vehicle_id,s.build_id,s.policy_id,s.entry_kind,v.model_id
 FROM syn_voice_turn t JOIN syn_voice_session s ON s.session_id=t.session_id JOIN syn_vehicle v ON v.vehicle_id=s.vehicle_id
 WHERE t.started_at>='2026-09-01T00:00:00Z' AND t.started_at<'2026-10-01T00:00:00Z' AND t.started_at<'2026-10-04T00:00:00Z' AND t.finished_at<'2026-10-04T00:00:00Z' AND t.received_at<'2026-10-04T00:00:00Z' AND t.quality_state='valid'
 AND s.started_at<'2026-10-04T00:00:00Z' AND s.ended_at<'2026-10-04T00:00:00Z' AND s.received_at<'2026-10-04T00:00:00Z' AND s.quality_state='valid' AND s.is_complete=1
 AND v.telemetry_consent=1 AND v.is_lab_unit=0
), hs AS (SELECT h.turn_id,COUNT(*) n FROM syn_asr_hypothesis h JOIN syn_asr_attempt a ON a.asr_attempt_id=h.asr_attempt_id JOIN turns t ON t.turn_id=h.turn_id WHERE h.received_at<'2026-10-04T00:00:00Z' AND a.received_at<'2026-10-04T00:00:00Z' AND CAST(strftime('%s',t.started_at) AS INTEGER)*1000+a.finish_offset_ms<CAST(strftime('%s','2026-10-04T00:00:00Z') AS INTEGER)*1000 GROUP BY h.turn_id),
 slots AS (SELECT n.turn_id,COUNT(s.slot_id) n,SUM(s.is_required=1) required,SUM(s.is_required=1 AND s.is_resolved=0) unresolved FROM syn_nlu_attempt n JOIN turns t ON t.turn_id=n.turn_id LEFT JOIN syn_slot_value s ON s.nlu_attempt_id=n.nlu_attempt_id AND s.received_at<'2026-10-04T00:00:00Z' WHERE n.selected_for_dialogue=1 AND n.received_at<'2026-10-04T00:00:00Z' AND CAST(strftime('%s',t.started_at) AS INTEGER)*1000+n.finish_offset_ms<CAST(strftime('%s','2026-10-04T00:00:00Z') AS INTEGER)*1000 GROUP BY n.turn_id)
SELECT COUNT(*) AS turns,SUM(COALESCE(h.n,0)) AS asr_hypotheses,SUM(COALESCE(s.required,0)) AS required_slot_rows,
 SUM(COALESCE(s.unresolved,0)) AS unresolved_required_rows FROM turns t LEFT JOIN hs h ON h.turn_id=t.turn_id LEFT JOIN slots s ON s.turn_id=t.turn_id;
