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
 FROM operations o LEFT JOIN effects e ON e.operation_key=o.operation_key LEFT JOIN ranked_results r ON r.operation_key=o.operation_key AND r.rn=1)
SELECT final_state,COUNT(*) AS logical_actions,SUM(attempts) AS invocation_attempts FROM final_operations WHERE final_state IN ('unknown','no_receipt') GROUP BY final_state ORDER BY final_state;
