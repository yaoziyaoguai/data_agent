WITH turns AS (
 SELECT t.*,s.vehicle_id,s.build_id,s.policy_id,s.entry_kind,v.model_id
 FROM syn_voice_turn t JOIN syn_voice_session s ON s.session_id=t.session_id JOIN syn_vehicle v ON v.vehicle_id=s.vehicle_id
 WHERE t.started_at>='2026-09-01T00:00:00Z' AND t.started_at<'2026-10-01T00:00:00Z' AND t.started_at<'2026-10-04T00:00:00Z' AND t.finished_at<'2026-10-04T00:00:00Z' AND t.received_at<'2026-10-04T00:00:00Z' AND t.quality_state='valid'
 AND s.started_at<'2026-10-04T00:00:00Z' AND s.ended_at<'2026-10-04T00:00:00Z' AND s.received_at<'2026-10-04T00:00:00Z' AND s.quality_state='valid' AND s.is_complete=1
 AND v.telemetry_consent=1 AND v.is_lab_unit=0
),
facts AS (SELECT i.*,t.vehicle_id,t.build_id,t.model_id,t.entry_kind,t.locale AS turn_locale,t.started_at AS turn_started_at,t.final_outcome,t.input_ms,t.first_audio_latency_ms FROM syn_action_invocation i JOIN turns t ON t.turn_id=i.turn_id WHERE i.received_at<'2026-10-04T00:00:00Z' AND CAST(strftime('%s',t.started_at) AS INTEGER)*1000+i.submitted_offset_ms<CAST(strftime('%s','2026-10-04T00:00:00Z') AS INTEGER)*1000),
results AS (SELECT r.* FROM syn_action_result r JOIN facts i ON i.invocation_id=r.invocation_id JOIN turns t ON t.turn_id=r.turn_id WHERE r.received_at<'2026-10-04T00:00:00Z' AND CAST(strftime('%s',t.started_at) AS INTEGER)*1000+r.observed_offset_ms<CAST(strftime('%s','2026-10-04T00:00:00Z') AS INTEGER)*1000),
 ranked_results AS (SELECT *,ROW_NUMBER() OVER(PARTITION BY operation_key ORDER BY observed_offset_ms DESC,observation_no DESC,result_id DESC) rn FROM results),
 effects AS (SELECT operation_key,MAX(effect_state='confirmed') AS confirmed,COUNT(DISTINCT effect_instance_id) AS effect_instances FROM results GROUP BY operation_key),
 operations AS (SELECT operation_key,MIN(turn_id) AS turn_id,COUNT(*) AS attempts FROM facts GROUP BY operation_key),
 final_operations AS (SELECT o.*,COALESCE(e.confirmed,0) AS confirmed,COALESCE(e.effect_instances,0) AS effect_instances,
 CASE WHEN e.confirmed=1 THEN 'confirmed' WHEN r.result_id IS NULL THEN 'no_receipt' ELSE r.return_state END AS final_state
 FROM operations o LEFT JOIN effects e ON e.operation_key=o.operation_key LEFT JOIN ranked_results r ON r.operation_key=o.operation_key AND r.rn=1), links AS (SELECT s.turn_id,COUNT(*) carried_slots,COUNT(DISTINCT s.source_turn_id) source_turns FROM syn_slot_value s JOIN turns t ON t.turn_id=s.turn_id WHERE s.source_turn_id IS NOT NULL AND s.received_at<'2026-10-04T00:00:00Z' GROUP BY s.turn_id),
 clarifying AS (SELECT DISTINCT d.turn_id FROM syn_dialogue_transition d JOIN turns t ON t.turn_id=d.turn_id WHERE d.to_state='awaiting_slot' AND d.received_at<'2026-10-04T00:00:00Z' AND CAST(strftime('%s',t.started_at) AS INTEGER)*1000+d.offset_ms<CAST(strftime('%s','2026-10-04T00:00:00Z') AS INTEGER)*1000),
 actions AS (SELECT turn_id,COUNT(*) logical_actions,SUM(confirmed) confirmed_actions,SUM(final_state IN ('unknown','no_receipt')) unknown_actions FROM final_operations GROUP BY turn_id)
SELECT t.turn_id,t.session_id,t.parent_turn_id,t.final_outcome,CASE WHEN c.turn_id IS NULL THEN 0 ELSE 1 END asked_for_slot,COALESCE(l.carried_slots,0) carried_slots,COALESCE(l.source_turns,0) source_turns,COALESCE(a.logical_actions,0) logical_actions,COALESCE(a.confirmed_actions,0) confirmed_actions,COALESCE(a.unknown_actions,0) unknown_actions
FROM turns t LEFT JOIN links l ON l.turn_id=t.turn_id LEFT JOIN clarifying c ON c.turn_id=t.turn_id LEFT JOIN actions a ON a.turn_id=t.turn_id
WHERE c.turn_id IS NOT NULL OR l.turn_id IS NOT NULL ORDER BY t.session_id,t.turn_no,t.turn_id;
