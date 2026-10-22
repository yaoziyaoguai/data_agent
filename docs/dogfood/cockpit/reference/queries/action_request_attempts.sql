WITH turns AS (
 SELECT t.*,s.vehicle_id,s.build_id,s.policy_id,s.entry_kind,v.model_id
 FROM syn_voice_turn t JOIN syn_voice_session s ON s.session_id=t.session_id JOIN syn_vehicle v ON v.vehicle_id=s.vehicle_id
 WHERE t.started_at>='2026-09-01T00:00:00Z' AND t.started_at<'2026-10-01T00:00:00Z' AND t.started_at<'2026-10-04T00:00:00Z' AND t.finished_at<'2026-10-04T00:00:00Z' AND t.received_at<'2026-10-04T00:00:00Z' AND t.quality_state='valid'
 AND s.started_at<'2026-10-04T00:00:00Z' AND s.ended_at<'2026-10-04T00:00:00Z' AND s.received_at<'2026-10-04T00:00:00Z' AND s.quality_state='valid' AND s.is_complete=1
 AND v.telemetry_consent=1 AND v.is_lab_unit=0
),
facts AS (SELECT i.*,t.vehicle_id,t.build_id,t.model_id,t.entry_kind,t.locale AS turn_locale,t.started_at AS turn_started_at,t.final_outcome,t.input_ms,t.first_audio_latency_ms FROM syn_action_invocation i JOIN turns t ON t.turn_id=i.turn_id WHERE i.received_at<'2026-10-04T00:00:00Z' AND CAST(strftime('%s',t.started_at) AS INTEGER)*1000+i.submitted_offset_ms<CAST(strftime('%s','2026-10-04T00:00:00Z') AS INTEGER)*1000), o AS (SELECT operation_key,COUNT(*) n FROM facts GROUP BY operation_key)
SELECT COUNT(*) AS logical_actions,COALESCE(SUM(n),0) AS invocation_attempts,COUNT(CASE WHEN n>1 THEN 1 END) AS retried_actions FROM o;
