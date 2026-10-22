WITH wake AS (SELECT w.* FROM syn_wakeup_attempt w JOIN syn_vehicle v ON v.vehicle_id=w.vehicle_id
 WHERE w.started_at>='2026-09-01T00:00:00Z' AND w.started_at<'2026-10-01T00:00:00Z' AND w.received_at<'2026-10-04T00:00:00Z' AND w.quality_state='valid' AND v.telemetry_consent=1 AND v.is_lab_unit=0)
SELECT trigger_kind,accepted,reject_reason,COUNT(*) AS observations
FROM wake GROUP BY trigger_kind,accepted,reject_reason ORDER BY trigger_kind,accepted,reject_reason;
