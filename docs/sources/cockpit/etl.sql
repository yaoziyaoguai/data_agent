-- 仅从允许的合成事实派生；不读取evaluation。
BEGIN;

-- target: syn_daily_voice_experience
DELETE FROM syn_daily_voice_experience;
INSERT INTO syn_daily_voice_experience
WITH valid_sessions AS (
  SELECT s.* FROM syn_voice_session s JOIN syn_vehicle v ON v.vehicle_id=s.vehicle_id
  WHERE v.telemetry_consent=1 AND v.is_lab_unit=0 AND s.is_complete=1 AND s.quality_state='valid'
    AND s.started_at < '2026-10-04T00:00:00Z' AND s.ended_at < '2026-10-04T00:00:00Z' AND s.received_at < '2026-10-04T00:00:00Z'
), valid_turns AS (
  SELECT t.*,s.vehicle_id,s.build_id FROM syn_voice_turn t JOIN valid_sessions s ON s.session_id=t.session_id
  WHERE t.quality_state='valid' AND t.started_at < '2026-10-04T00:00:00Z' AND t.finished_at < '2026-10-04T00:00:00Z' AND t.received_at < '2026-10-04T00:00:00Z'
),
selected_asr AS (SELECT turn_id,normalized_text FROM syn_asr_hypothesis WHERE selected_for_nlu=1 AND is_final=1 AND received_at < '2026-10-04T00:00:00Z'),
selected_nlu AS (SELECT turn_id,predicted_intent_id FROM syn_nlu_attempt WHERE selected_for_dialogue=1 AND received_at < '2026-10-04T00:00:00Z'),
feedback AS (SELECT turn_id,COUNT(*) n,SUM(rating='positive') positive FROM syn_turn_feedback WHERE quality_state='valid' AND is_explicit=1 AND collected_at < '2026-10-04T00:00:00Z' AND received_at < '2026-10-04T00:00:00Z' GROUP BY turn_id),
interruptions AS (SELECT interrupted_turn_id turn_id,COUNT(*) n FROM syn_interruption_event WHERE occurred_at < '2026-10-04T00:00:00Z' AND received_at < '2026-10-04T00:00:00Z' GROUP BY interrupted_turn_id),
turns AS (
 SELECT substr(t.started_at,1,10) d,t.vehicle_id,t.build_id,
 COUNT(*) turn_count,SUM(t.final_outcome NOT IN ('cancelled','no_speech')) eligible,
 SUM(t.final_outcome='completed') completed,SUM(t.final_outcome='clarification_pending') clarification,
 SUM(t.final_outcome='failed') failed,SUM(t.final_outcome='unknown') unknown_count,
 SUM(t.final_outcome='cancelled') cancelled,SUM(t.final_outcome='no_speech') no_speech,SUM(t.final_outcome='rejected') rejected,
 SUM(CASE WHEN t.final_outcome='completed' THEN t.task_latency_ms ELSE 0 END) latency_sum,
 SUM(t.final_outcome='completed') latency_n,COALESCE(SUM(t.first_audio_latency_ms),0) audio_sum,COUNT(t.first_audio_latency_ms) audio_n,
 SUM(t.final_outcome NOT IN ('cancelled','no_speech') AND t.reference_text IS NOT NULL) asr_labels,
 SUM(CASE WHEN t.final_outcome NOT IN ('cancelled','no_speech') AND t.reference_text IS NOT NULL AND a.normalized_text=lower(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(t.reference_text,' ',''),'　',''),char(9),''),char(13),''),char(10),''),'。',''),'！',''),'？',''),'!',''),'?',''),'，',''),',',''),'．',''),'.','')) THEN 1 ELSE 0 END) asr_matches,
 SUM(t.final_outcome NOT IN ('cancelled','no_speech') AND t.reference_intent_id IS NOT NULL) intent_labels,
 SUM(CASE WHEN t.final_outcome NOT IN ('cancelled','no_speech') AND t.reference_intent_id IS NOT NULL AND n.predicted_intent_id=t.reference_intent_id THEN 1 ELSE 0 END) intent_matches,
 SUM(COALESCE(f.n,0)) feedback_n,SUM(COALESCE(f.positive,0)) positive_n,SUM(COALESCE(i.n,0)) interruptions
 FROM valid_turns t LEFT JOIN selected_asr a ON a.turn_id=t.turn_id LEFT JOIN selected_nlu n ON n.turn_id=t.turn_id
 LEFT JOIN feedback f ON f.turn_id=t.turn_id LEFT JOIN interruptions i ON i.turn_id=t.turn_id
 GROUP BY d,t.vehicle_id,t.build_id
), sessions AS (SELECT substr(started_at,1,10) d,vehicle_id,build_id,COUNT(*) n FROM valid_sessions GROUP BY d,vehicle_id,build_id),
wakes AS (
 SELECT substr(w.started_at,1,10) d,w.vehicle_id,w.build_id,COUNT(*) n,SUM(w.accepted) accepted,
 COUNT(w.reference_is_intended) labeled,SUM(w.reference_is_intended=0 AND w.accepted=1) false_accept
 FROM syn_wakeup_attempt w JOIN syn_vehicle v ON v.vehicle_id=w.vehicle_id
 WHERE v.telemetry_consent=1 AND v.is_lab_unit=0 AND w.quality_state='valid' AND w.started_at < '2026-10-04T00:00:00Z' AND w.received_at < '2026-10-04T00:00:00Z'
 GROUP BY d,w.vehicle_id,w.build_id
), keys AS (SELECT d,vehicle_id,build_id FROM turns UNION SELECT d,vehicle_id,build_id FROM sessions UNION SELECT d,vehicle_id,build_id FROM wakes)
SELECT k.d,k.vehicle_id,k.build_id,COALESCE(s.n,0),COALESCE(w.n,0),COALESCE(w.accepted,0),COALESCE(w.labeled,0),COALESCE(w.false_accept,0),
 COALESCE(t.turn_count,0),COALESCE(t.eligible,0),COALESCE(t.completed,0),COALESCE(t.clarification,0),COALESCE(t.failed,0),COALESCE(t.unknown_count,0),COALESCE(t.cancelled,0),COALESCE(t.no_speech,0),COALESCE(t.rejected,0),
 COALESCE(t.latency_sum,0),COALESCE(t.latency_n,0),COALESCE(t.audio_sum,0),COALESCE(t.audio_n,0),COALESCE(t.asr_labels,0),COALESCE(t.asr_matches,0),COALESCE(t.intent_labels,0),COALESCE(t.intent_matches,0),COALESCE(t.feedback_n,0),COALESCE(t.positive_n,0),COALESCE(t.interruptions,0),'2026-10-04T00:00:00Z'
FROM keys k LEFT JOIN turns t ON t.d=k.d AND t.vehicle_id=k.vehicle_id AND t.build_id=k.build_id
LEFT JOIN sessions s ON s.d=k.d AND s.vehicle_id=k.vehicle_id AND s.build_id=k.build_id
LEFT JOIN wakes w ON w.d=k.d AND w.vehicle_id=k.vehicle_id AND w.build_id=k.build_id;
-- end-target

-- target: syn_daily_stage_latency
DELETE FROM syn_daily_stage_latency;
INSERT INTO syn_daily_stage_latency
WITH valid_sessions AS (
  SELECT s.* FROM syn_voice_session s JOIN syn_vehicle v ON v.vehicle_id=s.vehicle_id
  WHERE v.telemetry_consent=1 AND v.is_lab_unit=0 AND s.is_complete=1 AND s.quality_state='valid'
    AND s.started_at < '2026-10-04T00:00:00Z' AND s.ended_at < '2026-10-04T00:00:00Z' AND s.received_at < '2026-10-04T00:00:00Z'
), valid_turns AS (
  SELECT t.*,s.vehicle_id,s.build_id FROM syn_voice_turn t JOIN valid_sessions s ON s.session_id=t.session_id
  WHERE t.quality_state='valid' AND t.started_at < '2026-10-04T00:00:00Z' AND t.finished_at < '2026-10-04T00:00:00Z' AND t.received_at < '2026-10-04T00:00:00Z'
), latest_result AS (
 SELECT r.*,ROW_NUMBER() OVER(PARTITION BY invocation_id ORDER BY observation_no DESC) rn
 FROM syn_action_result r WHERE r.received_at < '2026-10-04T00:00:00Z'
), attempts AS (
 SELECT a.turn_id,'asr' stage,a.endpoint_kind,a.outcome,a.wall_ms latency,a.queued_ms queued FROM syn_asr_attempt a WHERE a.received_at < '2026-10-04T00:00:00Z'
 UNION ALL SELECT a.turn_id,'nlu',a.endpoint_kind,a.outcome,a.wall_ms,a.queued_ms FROM syn_nlu_attempt a WHERE a.received_at < '2026-10-04T00:00:00Z'
 UNION ALL SELECT a.turn_id,'route',CASE WHEN a.route_kind='cloud' THEN 'cloud' ELSE 'edge' END,CASE WHEN a.outcome='selected' THEN 'succeeded' ELSE a.outcome END,a.wall_ms,0 FROM syn_skill_route a WHERE a.received_at < '2026-10-04T00:00:00Z'
 UNION ALL SELECT a.turn_id,'action',CASE WHEN a.transport_kind='simulated_cloud' THEN 'cloud' ELSE 'edge' END,
 CASE WHEN a.acceptance_state='rejected' THEN 'rejected' ELSE COALESCE(r.return_state,'unknown') END,
 CASE WHEN r.return_state IN ('succeeded','failed','cancelled') THEN r.observed_offset_ms-a.submitted_offset_ms ELSE NULL END,0
 FROM syn_action_invocation a LEFT JOIN latest_result r ON r.invocation_id=a.invocation_id AND r.rn=1 WHERE a.received_at < '2026-10-04T00:00:00Z'
 UNION ALL SELECT a.turn_id,'tts',a.endpoint_kind,a.outcome,a.wall_ms,0 FROM syn_tts_request a WHERE a.received_at < '2026-10-04T00:00:00Z'
)
SELECT substr(t.started_at,1,10),a.stage,a.endpoint_kind,t.build_id,COUNT(*),COUNT(DISTINCT a.turn_id),
 SUM(a.outcome='succeeded'),SUM(a.outcome='failed'),SUM(a.outcome='timeout'),SUM(a.outcome='cancelled'),SUM(a.outcome='unknown'),SUM(a.outcome='ambiguous'),SUM(a.outcome='rejected'),
 COALESCE(SUM(a.latency),0),COUNT(a.latency),MIN(a.latency),MAX(a.latency),SUM(a.queued),'2026-10-04T00:00:00Z'
FROM attempts a JOIN valid_turns t ON t.turn_id=a.turn_id GROUP BY substr(t.started_at,1,10),a.stage,a.endpoint_kind,t.build_id;
-- end-target

-- target: syn_daily_intent_outcome
DELETE FROM syn_daily_intent_outcome;
INSERT INTO syn_daily_intent_outcome
WITH valid_sessions AS (
  SELECT s.* FROM syn_voice_session s JOIN syn_vehicle v ON v.vehicle_id=s.vehicle_id
  WHERE v.telemetry_consent=1 AND v.is_lab_unit=0 AND s.is_complete=1 AND s.quality_state='valid'
    AND s.started_at < '2026-10-04T00:00:00Z' AND s.ended_at < '2026-10-04T00:00:00Z' AND s.received_at < '2026-10-04T00:00:00Z'
), valid_turns AS (
  SELECT t.*,s.vehicle_id,s.build_id FROM syn_voice_turn t JOIN valid_sessions s ON s.session_id=t.session_id
  WHERE t.quality_state='valid' AND t.started_at < '2026-10-04T00:00:00Z' AND t.finished_at < '2026-10-04T00:00:00Z' AND t.received_at < '2026-10-04T00:00:00Z'
), selected AS (
 SELECT n.turn_id,n.predicted_intent_id intent_id FROM syn_nlu_attempt n WHERE n.selected_for_dialogue=1 AND n.predicted_intent_id IS NOT NULL AND n.received_at < '2026-10-04T00:00:00Z'
), actions AS (
 SELECT a.turn_id,COUNT(DISTINCT a.operation_key) n,COUNT(DISTINCT CASE WHEN r.effect_state='confirmed' THEN a.operation_key ELSE NULL END) confirmed
 FROM syn_action_invocation a LEFT JOIN syn_action_result r ON r.operation_key=a.operation_key AND r.received_at < '2026-10-04T00:00:00Z'
 WHERE a.received_at < '2026-10-04T00:00:00Z' GROUP BY a.turn_id
), feedback AS (SELECT turn_id,COUNT(*) n,SUM(rating='positive') positive FROM syn_turn_feedback WHERE quality_state='valid' AND is_explicit=1 AND collected_at < '2026-10-04T00:00:00Z' AND received_at < '2026-10-04T00:00:00Z' GROUP BY turn_id)
SELECT substr(t.started_at,1,10),n.intent_id,i.capability_id,t.build_id,COUNT(*),
 SUM(t.final_outcome='completed'),SUM(t.final_outcome='clarification_pending'),SUM(t.final_outcome='rejected'),SUM(t.final_outcome='failed'),SUM(t.final_outcome='cancelled'),SUM(t.final_outcome='unknown'),SUM(t.final_outcome='no_speech'),
 SUM(COALESCE(a.n,0)),SUM(COALESCE(a.confirmed,0)),SUM(COALESCE(f.n,0)),SUM(COALESCE(f.positive,0)),'2026-10-04T00:00:00Z'
FROM valid_turns t JOIN selected n ON n.turn_id=t.turn_id JOIN syn_intent_catalog i ON i.intent_id=n.intent_id
LEFT JOIN actions a ON a.turn_id=t.turn_id LEFT JOIN feedback f ON f.turn_id=t.turn_id
GROUP BY substr(t.started_at,1,10),n.intent_id,i.capability_id,t.build_id;
-- end-target
COMMIT;
