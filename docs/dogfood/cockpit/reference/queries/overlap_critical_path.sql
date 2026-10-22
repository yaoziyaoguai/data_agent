WITH turns AS (
 SELECT t.*,s.vehicle_id,s.build_id,s.policy_id,s.entry_kind,v.model_id
 FROM syn_voice_turn t JOIN syn_voice_session s ON s.session_id=t.session_id JOIN syn_vehicle v ON v.vehicle_id=s.vehicle_id
 WHERE t.started_at>='2026-09-01T00:00:00Z' AND t.started_at<'2026-10-01T00:00:00Z' AND t.started_at<'2026-10-04T00:00:00Z' AND t.finished_at<'2026-10-04T00:00:00Z' AND t.received_at<'2026-10-04T00:00:00Z' AND t.quality_state='valid'
 AND s.started_at<'2026-10-04T00:00:00Z' AND s.ended_at<'2026-10-04T00:00:00Z' AND s.received_at<'2026-10-04T00:00:00Z' AND s.quality_state='valid' AND s.is_complete=1
 AND v.telemetry_consent=1 AND v.is_lab_unit=0
),
action_ends AS (
 SELECT i.invocation_id,i.turn_id,i.submitted_offset_ms,MIN(r.observed_offset_ms) en
 FROM syn_action_invocation i JOIN turns t ON t.turn_id=i.turn_id
 JOIN syn_action_result r ON r.invocation_id=i.invocation_id
 WHERE i.received_at<'2026-10-04T00:00:00Z' AND CAST(strftime('%s',t.started_at) AS INTEGER)*1000+i.submitted_offset_ms<CAST(strftime('%s','2026-10-04T00:00:00Z') AS INTEGER)*1000 AND r.received_at<'2026-10-04T00:00:00Z' AND CAST(strftime('%s',t.started_at) AS INTEGER)*1000+r.observed_offset_ms<CAST(strftime('%s','2026-10-04T00:00:00Z') AS INTEGER)*1000
 AND r.return_state IN ('succeeded','failed','cancelled') GROUP BY i.invocation_id,i.turn_id,i.submitted_offset_ms
), raw_spans AS (
 SELECT a.turn_id,a.start_offset_ms AS st,a.finish_offset_ms AS en FROM syn_asr_attempt a JOIN turns t ON t.turn_id=a.turn_id WHERE a.received_at<'2026-10-04T00:00:00Z' AND CAST(strftime('%s',t.started_at) AS INTEGER)*1000+a.finish_offset_ms<CAST(strftime('%s','2026-10-04T00:00:00Z') AS INTEGER)*1000
 UNION ALL SELECT n.turn_id,n.start_offset_ms,n.finish_offset_ms FROM syn_nlu_attempt n JOIN turns t ON t.turn_id=n.turn_id WHERE n.received_at<'2026-10-04T00:00:00Z' AND CAST(strftime('%s',t.started_at) AS INTEGER)*1000+n.finish_offset_ms<CAST(strftime('%s','2026-10-04T00:00:00Z') AS INTEGER)*1000
 UNION ALL SELECT r.turn_id,r.start_offset_ms,r.finish_offset_ms FROM syn_skill_route r JOIN turns t ON t.turn_id=r.turn_id WHERE r.received_at<'2026-10-04T00:00:00Z' AND CAST(strftime('%s',t.started_at) AS INTEGER)*1000+r.finish_offset_ms<CAST(strftime('%s','2026-10-04T00:00:00Z') AS INTEGER)*1000
 UNION ALL SELECT turn_id,submitted_offset_ms,en FROM action_ends
 UNION ALL SELECT x.turn_id,x.start_offset_ms,x.finish_offset_ms FROM syn_tts_request x JOIN turns t ON t.turn_id=x.turn_id WHERE x.received_at<'2026-10-04T00:00:00Z' AND CAST(strftime('%s',t.started_at) AS INTEGER)*1000+x.finish_offset_ms<CAST(strftime('%s','2026-10-04T00:00:00Z') AS INTEGER)*1000
 UNION ALL SELECT p.turn_id,p.start_offset_ms,p.finish_offset_ms FROM syn_playback_segment p JOIN turns t ON t.turn_id=p.turn_id WHERE p.received_at<'2026-10-04T00:00:00Z' AND CAST(strftime('%s',t.started_at) AS INTEGER)*1000+p.finish_offset_ms<CAST(strftime('%s','2026-10-04T00:00:00Z') AS INTEGER)*1000
), limits AS (SELECT t.turn_id,t.input_ms,t.first_audio_latency_ms,MAX(r.en) observed_end
 FROM turns t JOIN raw_spans r ON r.turn_id=t.turn_id WHERE t.first_audio_latency_ms IS NOT NULL GROUP BY t.turn_id,t.input_ms,t.first_audio_latency_ms),
 windows AS (SELECT *, 'before_first_audio' window_kind,input_ms+first_audio_latency_ms window_end FROM limits
 UNION ALL SELECT *, 'observed_flow',observed_end FROM limits),
 clipped AS (SELECT p.turn_id,w.window_kind,MAX(p.st,w.input_ms) st,MIN(p.en,w.window_end) en
 FROM raw_spans p JOIN windows w ON w.turn_id=p.turn_id WHERE p.en>w.input_ms AND p.st<w.window_end),
 ordered AS (SELECT *,MAX(en) OVER(PARTITION BY turn_id,window_kind ORDER BY st,en ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) prev_end FROM clipped WHERE en>st),
 grouped AS (SELECT *,SUM(CASE WHEN prev_end IS NULL OR st>prev_end THEN 1 ELSE 0 END) OVER(PARTITION BY turn_id,window_kind ORDER BY st,en) island FROM ordered),
 merged AS (SELECT turn_id,window_kind,island,MIN(st) st,MAX(en) en FROM grouped GROUP BY turn_id,window_kind,island),
 sums AS (SELECT turn_id,window_kind,SUM(en-st) sum_ms FROM clipped GROUP BY turn_id,window_kind),
 coverage AS (SELECT turn_id,window_kind,SUM(en-st) covered_ms FROM merged GROUP BY turn_id,window_kind),
 stats AS (SELECT s.*,c.covered_ms,s.sum_ms-c.covered_ms overlap_ms FROM sums s JOIN coverage c ON c.turn_id=s.turn_id AND c.window_kind=s.window_kind)

SELECT l.turn_id,l.first_audio_latency_ms AS first_audio_ms,l.observed_end-l.input_ms AS observed_flow_ms,
 f.sum_ms AS observed_stage_sum_ms,f.covered_ms AS observed_covered_ms,f.overlap_ms AS observed_overlap_ms,
 COALESCE(b.sum_ms,0) AS before_first_stage_sum_ms,COALESCE(b.covered_ms,0) AS before_first_covered_ms,
 COALESCE(b.overlap_ms,0) AS before_first_overlap_ms,l.first_audio_latency_ms-COALESCE(b.covered_ms,0) AS before_first_unobserved_ms
FROM limits l JOIN stats f ON f.turn_id=l.turn_id AND f.window_kind='observed_flow'
LEFT JOIN stats b ON b.turn_id=l.turn_id AND b.window_kind='before_first_audio'
WHERE f.overlap_ms>0 ORDER BY l.turn_id;
