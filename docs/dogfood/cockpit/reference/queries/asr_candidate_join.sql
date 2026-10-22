WITH turns AS (
 SELECT t.*,s.vehicle_id,s.build_id,s.policy_id,s.entry_kind,v.model_id
 FROM syn_voice_turn t JOIN syn_voice_session s ON s.session_id=t.session_id JOIN syn_vehicle v ON v.vehicle_id=s.vehicle_id
 WHERE t.started_at>='2026-09-01T00:00:00Z' AND t.started_at<'2026-10-01T00:00:00Z' AND t.started_at<'2026-10-04T00:00:00Z' AND t.finished_at<'2026-10-04T00:00:00Z' AND t.received_at<'2026-10-04T00:00:00Z' AND t.quality_state='valid'
 AND s.started_at<'2026-10-04T00:00:00Z' AND s.ended_at<'2026-10-04T00:00:00Z' AND s.received_at<'2026-10-04T00:00:00Z' AND s.quality_state='valid' AND s.is_complete=1
 AND v.telemetry_consent=1 AND v.is_lab_unit=0
),
facts AS (SELECT a.*,t.vehicle_id,t.build_id,t.model_id,t.entry_kind,t.locale AS turn_locale,t.started_at AS turn_started_at,t.final_outcome,t.input_ms,t.first_audio_latency_ms FROM syn_asr_attempt a JOIN turns t ON t.turn_id=a.turn_id WHERE a.received_at<'2026-10-04T00:00:00Z' AND CAST(strftime('%s',t.started_at) AS INTEGER)*1000+a.finish_offset_ms<CAST(strftime('%s','2026-10-04T00:00:00Z') AS INTEGER)*1000),
final_asr AS (SELECT *,ROW_NUMBER() OVER(PARTITION BY turn_id ORDER BY attempt_no DESC,asr_attempt_id DESC) AS final_rank FROM facts), hc AS (SELECT h.asr_attempt_id,COUNT(*) n FROM syn_asr_hypothesis h JOIN facts a ON a.asr_attempt_id=h.asr_attempt_id WHERE h.received_at<'2026-10-04T00:00:00Z' GROUP BY h.asr_attempt_id)
SELECT COUNT(*) AS final_attempt_turns,SUM(a.outcome='succeeded') AS succeeded,
 ROUND(SUM(a.outcome='succeeded')*1.0/NULLIF(COUNT(*),0),6) AS final_success_rate,
 SUM(COALESCE(h.n,0)) AS final_attempt_hypotheses,ROUND(AVG(COALESCE(h.n,0)),6) AS mean_hypotheses
FROM final_asr a LEFT JOIN hc h ON h.asr_attempt_id=a.asr_attempt_id WHERE a.final_rank=1;
