WITH turns AS (
 SELECT t.*,s.vehicle_id,s.build_id,s.policy_id,s.entry_kind,v.model_id
 FROM syn_voice_turn t JOIN syn_voice_session s ON s.session_id=t.session_id JOIN syn_vehicle v ON v.vehicle_id=s.vehicle_id
 WHERE t.started_at>='2026-07-01T00:00:00Z' AND t.started_at<'2026-10-01T00:00:00Z' AND t.started_at<'2026-10-04T00:00:00Z' AND t.finished_at<'2026-10-04T00:00:00Z' AND t.received_at<'2026-10-04T00:00:00Z' AND t.quality_state='valid'
 AND s.started_at<'2026-10-04T00:00:00Z' AND s.ended_at<'2026-10-04T00:00:00Z' AND s.received_at<'2026-10-04T00:00:00Z' AND s.quality_state='valid' AND s.is_complete=1
 AND v.telemetry_consent=1 AND v.is_lab_unit=0
), languages AS (SELECT locale,SUM(substr(started_at,1,7)='2026-08' AND final_outcome='completed') AS aug_completed,SUM(substr(started_at,1,7)='2026-09' AND final_outcome='completed') AS sep_completed FROM turns GROUP BY locale),
 changes AS (SELECT *,sep_completed-aug_completed AS delta FROM languages), total AS (SELECT SUM(delta) total_delta FROM changes)
SELECT c.locale,c.aug_completed,c.sep_completed,c.delta,t.total_delta,ROUND(c.delta*1.0/NULLIF(t.total_delta,0),6) AS share_of_change FROM changes c CROSS JOIN total t ORDER BY c.locale;
