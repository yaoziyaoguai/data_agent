WITH turns AS (
 SELECT t.*,s.vehicle_id,s.build_id,s.policy_id,s.entry_kind,v.model_id
 FROM syn_voice_turn t JOIN syn_voice_session s ON s.session_id=t.session_id JOIN syn_vehicle v ON v.vehicle_id=s.vehicle_id
 WHERE t.started_at>='2026-09-01T00:00:00Z' AND t.started_at<'2026-10-01T00:00:00Z' AND t.started_at<'2026-10-04T00:00:00Z' AND t.finished_at<'2026-10-04T00:00:00Z' AND t.received_at<'2026-10-04T00:00:00Z' AND t.quality_state='valid'
 AND s.started_at<'2026-10-04T00:00:00Z' AND s.ended_at<'2026-10-04T00:00:00Z' AND s.received_at<'2026-10-04T00:00:00Z' AND s.quality_state='valid' AND s.is_complete=1
 AND v.telemetry_consent=1 AND v.is_lab_unit=0
),
wake AS (SELECT w.* FROM syn_wakeup_attempt w JOIN syn_vehicle v ON v.vehicle_id=w.vehicle_id
 WHERE w.started_at>='2026-09-01T00:00:00Z' AND w.started_at<'2026-10-01T00:00:00Z' AND w.received_at<'2026-10-04T00:00:00Z' AND w.quality_state='valid' AND v.telemetry_consent=1 AND v.is_lab_unit=0)
SELECT entry_kind,COUNT(*) AS turns,COUNT(DISTINCT session_id) AS sessions,
 (SELECT COUNT(*) FROM wake w WHERE w.trigger_kind=t.entry_kind) AS entry_observations,
 (SELECT COALESCE(SUM(accepted),0) FROM wake w WHERE w.trigger_kind=t.entry_kind) AS accepted_observations
FROM turns t GROUP BY entry_kind ORDER BY entry_kind;
