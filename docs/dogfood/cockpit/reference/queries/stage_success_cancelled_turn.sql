WITH turns AS (
 SELECT t.*,s.vehicle_id,s.build_id,s.policy_id,s.entry_kind,v.model_id
 FROM syn_voice_turn t JOIN syn_voice_session s ON s.session_id=t.session_id JOIN syn_vehicle v ON v.vehicle_id=s.vehicle_id
 WHERE t.started_at>='2026-09-01T00:00:00Z' AND t.started_at<'2026-10-01T00:00:00Z' AND t.started_at<'2026-10-04T00:00:00Z' AND t.finished_at<'2026-10-04T00:00:00Z' AND t.received_at<'2026-10-04T00:00:00Z' AND t.quality_state='valid'
 AND s.started_at<'2026-10-04T00:00:00Z' AND s.ended_at<'2026-10-04T00:00:00Z' AND s.received_at<'2026-10-04T00:00:00Z' AND s.quality_state='valid' AND s.is_complete=1
 AND v.telemetry_consent=1 AND v.is_lab_unit=0
),
facts AS (SELECT a.*,t.vehicle_id,t.build_id,t.model_id,t.entry_kind,t.locale AS turn_locale,t.started_at AS turn_started_at,t.final_outcome,t.input_ms,t.first_audio_latency_ms FROM syn_asr_attempt a JOIN turns t ON t.turn_id=a.turn_id WHERE a.received_at<'2026-10-04T00:00:00Z' AND CAST(strftime('%s',t.started_at) AS INTEGER)*1000+a.finish_offset_ms<CAST(strftime('%s','2026-10-04T00:00:00Z') AS INTEGER)*1000),
final_asr AS (SELECT *,ROW_NUMBER() OVER(PARTITION BY turn_id ORDER BY attempt_no DESC,asr_attempt_id DESC) AS final_rank FROM facts), playback AS (SELECT p.turn_id,COUNT(*) n,SUM(p.completion_state='interrupted') interrupted FROM syn_playback_segment p JOIN turns t ON t.turn_id=p.turn_id WHERE p.received_at<'2026-10-04T00:00:00Z' AND CAST(strftime('%s',t.started_at) AS INTEGER)*1000+p.finish_offset_ms<CAST(strftime('%s','2026-10-04T00:00:00Z') AS INTEGER)*1000 GROUP BY p.turn_id)
SELECT a.turn_id,a.outcome AS asr_final_outcome,a.final_outcome AS turn_outcome,COALESCE(p.n,0) AS playback_segments,COALESCE(p.interrupted,0) AS interrupted_segments
FROM final_asr a LEFT JOIN playback p ON p.turn_id=a.turn_id WHERE a.final_rank=1 AND a.outcome='succeeded' AND (a.final_outcome='cancelled' OR COALESCE(p.interrupted,0)>0) ORDER BY a.turn_id;
