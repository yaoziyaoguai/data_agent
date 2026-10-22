WITH turns AS (
 SELECT t.*,s.vehicle_id,s.build_id,s.policy_id,s.entry_kind,v.model_id
 FROM syn_voice_turn t JOIN syn_voice_session s ON s.session_id=t.session_id JOIN syn_vehicle v ON v.vehicle_id=s.vehicle_id
 WHERE t.started_at>='2026-09-01T00:00:00Z' AND t.started_at<'2026-10-01T00:00:00Z' AND t.started_at<'2026-10-04T00:00:00Z' AND t.finished_at<'2026-10-04T00:00:00Z' AND t.received_at<'2026-10-04T00:00:00Z' AND t.quality_state='valid'
 AND s.started_at<'2026-10-04T00:00:00Z' AND s.ended_at<'2026-10-04T00:00:00Z' AND s.received_at<'2026-10-04T00:00:00Z' AND s.quality_state='valid' AND s.is_complete=1
 AND v.telemetry_consent=1 AND v.is_lab_unit=0
), day_turns AS (SELECT * FROM turns WHERE substr(started_at,1,10)='2026-09-15'),
 asr AS (SELECT a.*,ROW_NUMBER() OVER(PARTITION BY a.turn_id ORDER BY a.attempt_no DESC,a.asr_attempt_id DESC) rn FROM syn_asr_attempt a JOIN day_turns t ON t.turn_id=a.turn_id WHERE a.received_at<'2026-10-04T00:00:00Z' AND CAST(strftime('%s',t.started_at) AS INTEGER)*1000+a.finish_offset_ms<CAST(strftime('%s','2026-10-04T00:00:00Z') AS INTEGER)*1000),
 m AS (SELECT SUM(turn_count) n,SUM(task_completed_count) completed,SUM(eligible_turn_count) eligible FROM syn_daily_voice_experience WHERE activity_date='2026-09-15')
SELECT (SELECT COUNT(*) FROM day_turns) AS raw_turns,m.n AS mart_turns,(SELECT COUNT(*) FROM day_turns WHERE final_outcome='completed') AS raw_completed,m.completed AS mart_completed,(SELECT COUNT(*) FROM day_turns WHERE final_outcome IN ('completed','clarification_pending','rejected','failed','unknown')) AS raw_eligible,m.eligible AS mart_eligible FROM m;
