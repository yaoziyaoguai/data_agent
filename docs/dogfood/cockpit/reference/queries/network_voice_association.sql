WITH turns AS (
 SELECT t.*,s.vehicle_id,s.build_id,s.policy_id,s.entry_kind,v.model_id
 FROM syn_voice_turn t JOIN syn_voice_session s ON s.session_id=t.session_id JOIN syn_vehicle v ON v.vehicle_id=s.vehicle_id
 WHERE t.started_at>='2026-09-01T00:00:00Z' AND t.started_at<'2026-10-01T00:00:00Z' AND t.started_at<'2026-10-04T00:00:00Z' AND t.finished_at<'2026-10-04T00:00:00Z' AND t.received_at<'2026-10-04T00:00:00Z' AND t.quality_state='valid'
 AND s.started_at<'2026-10-04T00:00:00Z' AND s.ended_at<'2026-10-04T00:00:00Z' AND s.received_at<'2026-10-04T00:00:00Z' AND s.quality_state='valid' AND s.is_complete=1
 AND v.telemetry_consent=1 AND v.is_lab_unit=0
),
facts AS (SELECT a.*,t.vehicle_id,t.build_id,t.model_id,t.entry_kind,t.locale AS turn_locale,t.started_at AS turn_started_at,t.final_outcome,t.input_ms,t.first_audio_latency_ms FROM syn_asr_attempt a JOIN turns t ON t.turn_id=a.turn_id WHERE a.received_at<'2026-10-04T00:00:00Z' AND CAST(strftime('%s',t.started_at) AS INTEGER)*1000+a.finish_offset_ms<CAST(strftime('%s','2026-10-04T00:00:00Z') AS INTEGER)*1000),
final_asr AS (SELECT *,ROW_NUMBER() OVER(PARTITION BY turn_id ORDER BY attempt_no DESC,asr_attempt_id DESC) AS final_rank FROM facts),
network AS (SELECT n.*,ROW_NUMBER() OVER(PARTITION BY n.turn_id ORDER BY n.observed_at DESC,n.network_id DESC) rn FROM syn_network_observation n JOIN turns t ON t.turn_id=n.turn_id WHERE n.endpoint_scope='voice_cloud' AND n.observed_at<'2026-10-04T00:00:00Z' AND n.received_at<'2026-10-04T00:00:00Z' AND n.quality_state='valid'), x AS (SELECT a.turn_id,COALESCE(n.reachability,'no_observation') AS network_group,a.outcome,a.first_audio_latency_ms FROM final_asr a LEFT JOIN network n ON n.turn_id=a.turn_id AND n.rn=1 WHERE a.final_rank=1),
 r AS (SELECT *,ROW_NUMBER() OVER(PARTITION BY network_group ORDER BY first_audio_latency_ms,turn_id) rn,COUNT(*) OVER(PARTITION BY network_group) n FROM x WHERE first_audio_latency_ms IS NOT NULL),
 p AS (SELECT network_group,MAX(CASE WHEN rn=(n*95+99)/100 THEN first_audio_latency_ms END) p95 FROM r GROUP BY network_group)
SELECT x.network_group,COUNT(*) AS asr_turns,SUM(x.outcome='succeeded') AS succeeded,ROUND(SUM(x.outcome='succeeded')*1.0/NULLIF(COUNT(*),0),6) AS success_rate,p.p95 AS first_audio_p95_ms FROM x LEFT JOIN p ON p.network_group=x.network_group GROUP BY x.network_group ORDER BY x.network_group;
