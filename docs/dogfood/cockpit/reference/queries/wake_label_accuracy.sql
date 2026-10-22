WITH wake AS (SELECT w.* FROM syn_wakeup_attempt w JOIN syn_vehicle v ON v.vehicle_id=w.vehicle_id
 WHERE w.started_at>='2026-09-01T00:00:00Z' AND w.started_at<'2026-10-01T00:00:00Z' AND w.received_at<'2026-10-04T00:00:00Z' AND w.quality_state='valid' AND v.telemetry_consent=1 AND v.is_lab_unit=0)
SELECT trigger_kind,COUNT(*) AS observations,COUNT(reference_is_intended) AS labeled,
 COUNT(CASE WHEN reference_is_intended=0 THEN 1 END) AS negative_labeled,
 COUNT(CASE WHEN reference_is_intended=0 AND accepted=1 THEN 1 END) AS false_accepts,
 ROUND(COUNT(CASE WHEN reference_is_intended=0 AND accepted=1 THEN 1 END)*1.0/NULLIF(COUNT(CASE WHEN reference_is_intended=0 THEN 1 END),0),6) AS false_accept_rate
FROM wake GROUP BY trigger_kind ORDER BY trigger_kind;
