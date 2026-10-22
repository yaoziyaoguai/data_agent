"""从已确认语音业务规范独立编写的参考SQL；不读取产品输出或其ETL公式。"""
from __future__ import annotations

CUTOFF='2026-10-04T00:00:00Z'
PERIODS={'july':('2026-07-01T00:00:00Z','2026-08-01T00:00:00Z'),'august':('2026-08-01T00:00:00Z','2026-09-01T00:00:00Z'),'september':('2026-09-01T00:00:00Z','2026-10-01T00:00:00Z'),'quarter':('2026-07-01T00:00:00Z','2026-10-01T00:00:00Z'),'empty':('2026-11-01T00:00:00Z','2026-12-01T00:00:00Z')}
ELIGIBLE="('completed','clarification_pending','rejected','failed','unknown')"

def turns(period='september'):
 start,end=PERIODS[period]
 return f"""turns AS (
 SELECT t.*,s.vehicle_id,s.build_id,s.policy_id,s.entry_kind,v.model_id
 FROM syn_voice_turn t JOIN syn_voice_session s ON s.session_id=t.session_id JOIN syn_vehicle v ON v.vehicle_id=s.vehicle_id
 WHERE t.started_at>='{start}' AND t.started_at<'{end}' AND t.started_at<'{CUTOFF}' AND t.finished_at<'{CUTOFF}' AND t.received_at<'{CUTOFF}' AND t.quality_state='valid'
 AND s.started_at<'{CUTOFF}' AND s.ended_at<'{CUTOFF}' AND s.received_at<'{CUTOFF}' AND s.quality_state='valid' AND s.is_complete=1
 AND v.telemetry_consent=1 AND v.is_lab_unit=0
)"""

def offset_visible(alias,field='finish_offset_ms',turn_alias='t'):
 return f"{alias}.received_at<'{CUTOFF}' AND CAST(strftime('%s',{turn_alias}.started_at) AS INTEGER)*1000+{alias}.{field}<CAST(strftime('%s','{CUTOFF}') AS INTEGER)*1000"

def fact(table,alias,offset='finish_offset_ms',period='september',name='facts'):
 return turns(period)+f",\n{name} AS (SELECT {alias}.*,t.vehicle_id,t.build_id,t.model_id,t.entry_kind,t.locale AS turn_locale,t.started_at AS turn_started_at,t.final_outcome,t.input_ms,t.first_audio_latency_ms FROM {table} {alias} JOIN turns t ON t.turn_id={alias}.turn_id WHERE {offset_visible(alias,offset)})"

def final_asr(period='september'):
 return fact('syn_asr_attempt','a',period=period)+",\nfinal_asr AS (SELECT *,ROW_NUMBER() OVER(PARTITION BY turn_id ORDER BY attempt_no DESC,asr_attempt_id DESC) AS final_rank FROM facts)"

def normalized(expression):
 result=expression
 for character in [' ','　','。','！','？','!','?','，',',','．','.']:
  result=f"replace({result},'{character}','')"
 for code in [9,13,10]:result=f"replace({result},char({code}),'')"
 return f'lower({result})'

ORACLES={}
def put(key,sql,cols,note='',large=False):
 ORACLES[key]={'kind':'sql','sql':sql.strip()+'\n','columns':cols.split(),'note':note,'numeric_tolerance':0.000001,'large_result':large}
def bundle(key,keys,note=''):
 ORACLES[key]={'kind':'bundle','keys':keys,'note':note}

for key,period in [('turns_september','september'),('turns_empty_month','empty')]:
 put(key,'WITH '+turns(period)+' SELECT COUNT(*) AS turn_count,COUNT(DISTINCT vehicle_id) AS active_vehicles FROM turns;','turn_count active_vehicles')
put('turns_primary_locale','WITH '+turns()+" SELECT COUNT(*) AS turn_count,COUNT(DISTINCT vehicle_id) AS active_vehicles FROM turns WHERE locale=(SELECT locale FROM syn_recognizer_model ORDER BY locale LIMIT 1);",'turn_count active_vehicles','primary_locale由fixtures/context.json展开。')
put('turns_by_entry','WITH '+turns()+f"""
SELECT entry_kind,COUNT(*) AS turn_count,COUNT(DISTINCT session_id) AS session_count,
 SUM(NOT EXISTS(SELECT 1 FROM syn_wakeup_attempt w WHERE w.session_id=t.session_id AND w.received_at<'{CUTOFF}' AND w.started_at<'{CUTOFF}' AND w.quality_state='valid')) AS turns_without_wakeup_record
FROM turns t GROUP BY entry_kind ORDER BY entry_kind;""",'entry_kind turn_count session_count turns_without_wakeup_record')
wake=f"""wake AS (SELECT w.* FROM syn_wakeup_attempt w JOIN syn_vehicle v ON v.vehicle_id=w.vehicle_id
 WHERE w.started_at>='2026-09-01T00:00:00Z' AND w.started_at<'2026-10-01T00:00:00Z' AND w.received_at<'{CUTOFF}' AND w.quality_state='valid' AND v.telemetry_consent=1 AND v.is_lab_unit=0)"""
put('wake_outcomes','WITH '+wake+"""
SELECT trigger_kind,accepted,reject_reason,COUNT(*) AS observations
FROM wake GROUP BY trigger_kind,accepted,reject_reason ORDER BY trigger_kind,accepted,reject_reason;""",'trigger_kind accepted reject_reason observations','入口观测不依赖是否建立完整session；质量指标另按入口计算。')
put('wake_label_accuracy','WITH '+wake+"""
SELECT trigger_kind,COUNT(*) AS observations,COUNT(reference_is_intended) AS labeled,
 COUNT(CASE WHEN reference_is_intended=0 THEN 1 END) AS negative_labeled,
 COUNT(CASE WHEN reference_is_intended=0 AND accepted=1 THEN 1 END) AS false_accepts,
 ROUND(COUNT(CASE WHEN reference_is_intended=0 AND accepted=1 THEN 1 END)*1.0/NULLIF(COUNT(CASE WHEN reference_is_intended=0 THEN 1 END),0),6) AS false_accept_rate
FROM wake GROUP BY trigger_kind ORDER BY trigger_kind;""",'trigger_kind observations labeled negative_labeled false_accepts false_accept_rate','错误接受率按入口的独立负标签分母；无负标签为NULL。')
bundle('wake_quality',['wake_outcomes','wake_label_accuracy'])
frontend=fact('syn_frontend_segment','f','end_offset_ms')
put('vad_segments','WITH '+frontend+"""
SELECT segment_kind,COUNT(*) AS segments,COUNT(DISTINCT turn_id) AS turns,SUM(speech_detected=1) AS speech_segments,
 SUM(CASE WHEN speech_detected=1 THEN duration_ms ELSE 0 END) AS speech_ms
FROM facts WHERE quality_state='valid' GROUP BY segment_kind ORDER BY segment_kind;""",'segment_kind segments turns speech_segments speech_ms')
for key,period,where in [('asr_final_success','september',''),('asr_edge_august','august',"AND endpoint_kind='edge'")]:
 put(key,'WITH '+final_asr(period)+f"""
SELECT endpoint_kind,COUNT(*) AS turns,SUM(outcome='succeeded') AS succeeded,
 SUM(outcome='failed') AS failed,SUM(outcome='timeout') AS timed_out,SUM(outcome='cancelled') AS cancelled,
 ROUND(SUM(outcome='succeeded')*1.0/NULLIF(COUNT(*),0),6) AS final_success_rate
FROM final_asr WHERE final_rank=1 {where} GROUP BY endpoint_kind ORDER BY endpoint_kind;""",'endpoint_kind turns succeeded failed timed_out cancelled final_success_rate','自定义最终尝试率：每轮最大可见attempt_no；分母含最终取消/超时，只统计实际有尝试的有效轮次。')
asr=fact('syn_asr_attempt','a')
hyp=f"""hyp AS (SELECT h.* FROM syn_asr_hypothesis h JOIN facts a ON a.asr_attempt_id=h.asr_attempt_id WHERE h.received_at<'{CUTOFF}')"""
put('asr_candidate_counts','WITH '+asr+',\n'+hyp+""", per_attempt AS (SELECT a.asr_attempt_id,COUNT(h.hypothesis_id) AS candidates,SUM(COALESCE(h.selected_for_nlu,0)) AS selected FROM facts a LEFT JOIN hyp h ON h.asr_attempt_id=a.asr_attempt_id WHERE a.outcome='succeeded' GROUP BY a.asr_attempt_id)
SELECT candidates,COUNT(*) AS successful_attempts,SUM(selected) AS selected_hypotheses FROM per_attempt GROUP BY candidates ORDER BY candidates;""",'candidates successful_attempts selected_hypotheses')
nlu=fact('syn_nlu_attempt','n')
put('nlu_outcomes','WITH '+nlu+' SELECT outcome,COUNT(*) AS attempts,COUNT(DISTINCT turn_id) AS turns,SUM(selected_for_dialogue) AS selected FROM facts GROUP BY outcome ORDER BY outcome;','outcome attempts turns selected')
put('slot_completeness','WITH '+nlu+f""", slots AS (SELECT s.nlu_attempt_id,COUNT(*) AS slot_rows,SUM(s.is_required=1) AS required_rows,SUM(s.is_required=1 AND s.is_resolved=0) AS unresolved_required FROM syn_slot_value s JOIN facts n ON n.nlu_attempt_id=s.nlu_attempt_id WHERE s.received_at<'{CUTOFF}' GROUP BY s.nlu_attempt_id)
SELECT COALESCE(n.predicted_intent_id,'unresolved_intent') AS intent_id,COUNT(*) AS selected_turns,
 SUM(n.missing_required_slots) AS declared_missing_slots,SUM(COALESCE(s.required_rows,0)) AS required_slot_rows,
 SUM(COALESCE(s.unresolved_required,0)) AS unresolved_required_slot_rows,SUM(n.missing_required_slots=0) AS no_declared_missing_turns
FROM facts n LEFT JOIN slots s ON s.nlu_attempt_id=n.nlu_attempt_id WHERE n.selected_for_dialogue=1 GROUP BY intent_id ORDER BY intent_id;""",'intent_id selected_turns declared_missing_slots required_slot_rows unresolved_required_slot_rows no_declared_missing_turns')
put('clarification_counts','WITH '+turns()+f""", transitions AS (SELECT d.* FROM syn_dialogue_transition d JOIN turns t ON t.turn_id=d.turn_id WHERE {offset_visible('d','offset_ms')}),
 latest AS (SELECT *,ROW_NUMBER() OVER(PARTITION BY session_id ORDER BY turn_no DESC,turn_id DESC) rn FROM turns)
SELECT (SELECT COUNT(DISTINCT session_id) FROM turns) AS sessions,
 (SELECT COUNT(DISTINCT t.session_id) FROM transitions d JOIN turns t ON t.turn_id=d.turn_id WHERE d.to_state='awaiting_slot') AS clarification_sessions,
 (SELECT COUNT(DISTINCT turn_id) FROM transitions WHERE to_state='awaiting_slot') AS clarification_turns,
 (SELECT COUNT(*) FROM latest WHERE rn=1 AND final_outcome='clarification_pending') AS latest_turn_pending_sessions;""",'sessions clarification_sessions clarification_turns latest_turn_pending_sessions','最后可见轮次待澄清不是逐历史问题未解决数量。')
route=fact('syn_skill_route','r')
put('skill_route_outcomes','WITH '+route+' SELECT route_kind,outcome,COUNT(*) AS attempts,COUNT(DISTINCT turn_id) AS turns,SUM(is_final_route) AS final_routes FROM facts GROUP BY route_kind,outcome ORDER BY route_kind,outcome;','route_kind outcome attempts turns final_routes')
inv=fact('syn_action_invocation','i','submitted_offset_ms')
results=f"""results AS (SELECT r.* FROM syn_action_result r JOIN facts i ON i.invocation_id=r.invocation_id JOIN turns t ON t.turn_id=r.turn_id WHERE {offset_visible('r','observed_offset_ms')}),
 ranked_results AS (SELECT *,ROW_NUMBER() OVER(PARTITION BY operation_key ORDER BY observed_offset_ms DESC,observation_no DESC,result_id DESC) rn FROM results),
 effects AS (SELECT operation_key,MAX(effect_state='confirmed') AS confirmed,COUNT(DISTINCT effect_instance_id) AS effect_instances FROM results GROUP BY operation_key),
 operations AS (SELECT operation_key,MIN(turn_id) AS turn_id,COUNT(*) AS attempts FROM facts GROUP BY operation_key),
 final_operations AS (SELECT o.*,COALESCE(e.confirmed,0) AS confirmed,COALESCE(e.effect_instances,0) AS effect_instances,
 CASE WHEN e.confirmed=1 THEN 'confirmed' WHEN r.result_id IS NULL THEN 'no_receipt' ELSE r.return_state END AS final_state
 FROM operations o LEFT JOIN effects e ON e.operation_key=o.operation_key LEFT JOIN ranked_results r ON r.operation_key=o.operation_key AND r.rn=1)"""
put('action_request_attempts','WITH '+inv+""", o AS (SELECT operation_key,COUNT(*) n FROM facts GROUP BY operation_key)
SELECT COUNT(*) AS logical_actions,COALESCE(SUM(n),0) AS invocation_attempts,COUNT(CASE WHEN n>1 THEN 1 END) AS retried_actions FROM o;""",'logical_actions invocation_attempts retried_actions')
put('action_receipts','WITH '+inv+',\n'+results+' SELECT final_state,COUNT(*) AS logical_actions,SUM(attempts) AS attempts,SUM(effect_instances) AS distinct_effect_instances FROM final_operations GROUP BY final_state ORDER BY final_state;','final_state logical_actions attempts distinct_effect_instances','已知confirmed不因之后的unknown轮询降级。')
tts=fact('syn_tts_request','r')
put('tts_outcomes','WITH '+tts+' SELECT endpoint_kind,outcome,COUNT(*) AS attempts,COUNT(DISTINCT turn_id) AS turns,SUM(attempt_no>1) AS retry_attempts FROM facts GROUP BY endpoint_kind,outcome ORDER BY endpoint_kind,outcome;','endpoint_kind outcome attempts turns retry_attempts')
play=fact('syn_playback_segment','p')
# 从实际播放记录独立取得首音，不直接相信turn上的冗余first_audio_latency_ms。
def first_audio(period='september'):
 return turns(period)+f""", audible AS (
 SELECT p.turn_id,MIN(p.start_offset_ms) AS first_start FROM syn_playback_segment p JOIN turns t ON t.turn_id=p.turn_id
 WHERE {offset_visible('p')} AND p.played_ms>0 GROUP BY p.turn_id),
 first_audio AS (SELECT t.*,a.first_start-t.input_ms AS observed_first_audio_ms FROM turns t JOIN audible a ON a.turn_id=t.turn_id)"""
put('first_playback_quantiles','WITH '+first_audio()+""", r AS (SELECT observed_first_audio_ms,ROW_NUMBER() OVER(ORDER BY observed_first_audio_ms,turn_id) rn,COUNT(*) OVER() n FROM first_audio)
SELECT COALESCE(MAX(n),0) AS samples,MAX(CASE WHEN rn=(n*50+99)/100 THEN observed_first_audio_ms END) AS p50_ms,
 MAX(CASE WHEN rn=(n*95+99)/100 THEN observed_first_audio_ms END) AS p95_ms FROM r;""",'samples p50_ms p95_ms','输入结束到实际首个可听片段；无首音不填0。')
put('playback_outcomes','WITH '+play+' SELECT completion_state,end_reason,COUNT(*) AS segments,COUNT(DISTINCT turn_id) AS turns,SUM(played_ms) AS played_ms FROM facts GROUP BY completion_state,end_reason ORDER BY completion_state,end_reason;','completion_state end_reason segments turns played_ms')
# 同为毫秒也应保留测量含义，不将服务器耗时和客户端wall混称。
stage_union=f"""stage_rows AS (
 SELECT 'asr' AS stage,a.endpoint_kind,a.outcome,a.wall_ms,a.queued_ms,t.turn_id,t.build_id FROM syn_asr_attempt a JOIN turns t ON t.turn_id=a.turn_id WHERE {offset_visible('a')}
 UNION ALL SELECT 'nlu',n.endpoint_kind,n.outcome,n.wall_ms,n.queued_ms,t.turn_id,t.build_id FROM syn_nlu_attempt n JOIN turns t ON t.turn_id=n.turn_id WHERE {offset_visible('n')}
 UNION ALL SELECT 'tts',r.endpoint_kind,r.outcome,r.wall_ms,0,t.turn_id,t.build_id FROM syn_tts_request r JOIN turns t ON t.turn_id=r.turn_id WHERE {offset_visible('r')}
)"""
put('stage_latency','WITH '+turns()+',\n'+stage_union+""", r AS (SELECT *,ROW_NUMBER() OVER(PARTITION BY stage,endpoint_kind ORDER BY wall_ms,turn_id) rn,COUNT(*) OVER(PARTITION BY stage,endpoint_kind) n FROM stage_rows WHERE wall_ms IS NOT NULL)
SELECT stage,endpoint_kind,MAX(n) AS samples,ROUND(AVG(wall_ms),6) AS mean_ms,MAX(CASE WHEN rn=(n*95+99)/100 THEN wall_ms END) AS p95_ms,ROUND(AVG(queued_ms),6) AS mean_queue_ms FROM r GROUP BY stage,endpoint_kind ORDER BY stage,endpoint_kind;""",'stage endpoint_kind samples mean_ms p95_ms mean_queue_ms','本参考只比较定义了wall_ms的ASR/NLU/TTS；动作的服务器耗时/回执等待需另列测量口径。')
feedback=f"""feedback AS (SELECT f.*,ROW_NUMBER() OVER(PARTITION BY f.turn_id ORDER BY f.collected_at DESC,f.feedback_id DESC) rn FROM syn_turn_feedback f JOIN turns t ON t.turn_id=f.turn_id WHERE f.collected_at<'{CUTOFF}' AND f.received_at<'{CUTOFF}' AND f.quality_state='valid' AND f.is_explicit=1)"""
put('feedback_rates','WITH '+turns()+',\n'+feedback+"""
SELECT COUNT(*) AS turns,COUNT(f.feedback_id) AS feedback_turns,COUNT(CASE WHEN f.rating='positive' THEN 1 END) AS positive_turns,
 ROUND(COUNT(f.feedback_id)*1.0/NULLIF(COUNT(*),0),6) AS feedback_coverage,
 ROUND(COUNT(CASE WHEN f.rating='positive' THEN 1 END)*1.0/NULLIF(COUNT(f.feedback_id),0),6) AS positive_rate
FROM turns t LEFT JOIN feedback f ON f.turn_id=t.turn_id AND f.rn=1;""",'turns feedback_turns positive_turns feedback_coverage positive_rate')
# 多表及口径参考。
put('asr_candidate_join','WITH '+final_asr()+f""", hc AS (SELECT h.asr_attempt_id,COUNT(*) n FROM syn_asr_hypothesis h JOIN facts a ON a.asr_attempt_id=h.asr_attempt_id WHERE h.received_at<'{CUTOFF}' GROUP BY h.asr_attempt_id)
SELECT COUNT(*) AS final_attempt_turns,SUM(a.outcome='succeeded') AS succeeded,
 ROUND(SUM(a.outcome='succeeded')*1.0/NULLIF(COUNT(*),0),6) AS final_success_rate,
 SUM(COALESCE(h.n,0)) AS final_attempt_hypotheses,ROUND(AVG(COALESCE(h.n,0)),6) AS mean_hypotheses
FROM final_asr a LEFT JOIN hc h ON h.asr_attempt_id=a.asr_attempt_id WHERE a.final_rank=1;""",'final_attempt_turns succeeded final_success_rate final_attempt_hypotheses mean_hypotheses')
put('asr_selection','WITH '+asr+',\n'+hyp+""", selected AS (SELECT h.* FROM hyp h WHERE h.selected_for_nlu=1 AND h.is_final=1)
SELECT candidate_rank,COUNT(*) AS selected_turns,SUM(confidence_permille < (SELECT MAX(x.confidence_permille) FROM hyp x WHERE x.asr_attempt_id=h.asr_attempt_id)) AS below_max_confidence
FROM selected h GROUP BY candidate_rank ORDER BY candidate_rank;""",'candidate_rank selected_turns below_max_confidence')
put('asr_candidate_slot_join','WITH '+turns()+f""", hs AS (SELECT h.turn_id,COUNT(*) n FROM syn_asr_hypothesis h JOIN syn_asr_attempt a ON a.asr_attempt_id=h.asr_attempt_id JOIN turns t ON t.turn_id=h.turn_id WHERE h.received_at<'{CUTOFF}' AND {offset_visible('a')} GROUP BY h.turn_id),
 slots AS (SELECT n.turn_id,COUNT(s.slot_id) n,SUM(s.is_required=1) required,SUM(s.is_required=1 AND s.is_resolved=0) unresolved FROM syn_nlu_attempt n JOIN turns t ON t.turn_id=n.turn_id LEFT JOIN syn_slot_value s ON s.nlu_attempt_id=n.nlu_attempt_id AND s.received_at<'{CUTOFF}' WHERE n.selected_for_dialogue=1 AND {offset_visible('n')} GROUP BY n.turn_id)
SELECT COUNT(*) AS turns,SUM(COALESCE(h.n,0)) AS asr_hypotheses,SUM(COALESCE(s.required,0)) AS required_slot_rows,
 SUM(COALESCE(s.unresolved,0)) AS unresolved_required_rows FROM turns t LEFT JOIN hs h ON h.turn_id=t.turn_id LEFT JOIN slots s ON s.turn_id=t.turn_id;""",'turns asr_hypotheses required_slot_rows unresolved_required_rows')
put('recognizer_revision_outcomes','WITH '+asr+"""
SELECT m.recognizer_id,m.model_revision,m.endpoint_kind,a.outcome,COUNT(*) AS attempts
FROM facts a JOIN syn_recognizer_model m ON m.recognizer_id=a.recognizer_id GROUP BY m.recognizer_id,m.model_revision,m.endpoint_kind,a.outcome ORDER BY m.recognizer_id,a.outcome;""",'recognizer_id model_revision endpoint_kind outcome attempts')
put('action_final_vs_attempt','WITH '+inv+',\n'+results+""", last_invocation AS (SELECT *,ROW_NUMBER() OVER(PARTITION BY invocation_id ORDER BY observed_offset_ms DESC,observation_no DESC,result_id DESC) rn FROM results)
SELECT (SELECT COUNT(*) FROM facts) AS invocation_attempts,(SELECT COUNT(*) FROM last_invocation WHERE rn=1 AND return_state='succeeded') AS succeeded_attempts,
 COUNT(*) AS logical_actions,SUM(confirmed) AS confirmed_actions,
 ROUND((SELECT COUNT(*) FROM last_invocation WHERE rn=1 AND return_state='succeeded')*1.0/NULLIF((SELECT COUNT(*) FROM facts),0),6) AS attempt_success_rate,
 ROUND(SUM(confirmed)*1.0/NULLIF(COUNT(*),0),6) AS effect_confirmation_rate FROM final_operations;""",'invocation_attempts succeeded_attempts logical_actions confirmed_actions attempt_success_rate effect_confirmation_rate')
put('first_vs_final_success','WITH '+asr+""", ranked AS (SELECT *,ROW_NUMBER() OVER(PARTITION BY turn_id ORDER BY attempt_no,asr_attempt_id) first_rank,ROW_NUMBER() OVER(PARTITION BY turn_id ORDER BY attempt_no DESC,asr_attempt_id DESC) last_rank FROM facts),
 per_turn AS (SELECT turn_id,MAX(CASE WHEN first_rank=1 THEN outcome END) first_outcome,MAX(CASE WHEN last_rank=1 THEN outcome END) last_outcome,COUNT(*) attempts,MAX(fallback_reason<>'none') fallback FROM ranked GROUP BY turn_id)
SELECT COUNT(*) AS turns,SUM(first_outcome='succeeded') AS first_success,SUM(last_outcome='succeeded') AS final_success,
 SUM(first_outcome<>'succeeded' AND last_outcome='succeeded') AS recovered_turns,SUM(attempts>1) AS retried_turns,
 ROUND(SUM(first_outcome='succeeded')*1.0/NULLIF(COUNT(*),0),6) AS first_rate,
 ROUND(SUM(last_outcome='succeeded')*1.0/NULLIF(COUNT(*),0),6) AS final_rate FROM per_turn;""",'turns first_success final_success recovered_turns retried_turns first_rate final_rate')
network=f"""network AS (SELECT n.*,ROW_NUMBER() OVER(PARTITION BY n.turn_id ORDER BY n.observed_at DESC,n.network_id DESC) rn FROM syn_network_observation n JOIN turns t ON t.turn_id=n.turn_id WHERE n.endpoint_scope='voice_cloud' AND n.observed_at<'{CUTOFF}' AND n.received_at<'{CUTOFF}' AND n.quality_state='valid')"""
put('network_voice_association','WITH '+final_asr()+',\n'+network+""", x AS (SELECT a.turn_id,COALESCE(n.reachability,'no_observation') AS network_group,a.outcome,a.first_audio_latency_ms FROM final_asr a LEFT JOIN network n ON n.turn_id=a.turn_id AND n.rn=1 WHERE a.final_rank=1),
 r AS (SELECT *,ROW_NUMBER() OVER(PARTITION BY network_group ORDER BY first_audio_latency_ms,turn_id) rn,COUNT(*) OVER(PARTITION BY network_group) n FROM x WHERE first_audio_latency_ms IS NOT NULL),
 p AS (SELECT network_group,MAX(CASE WHEN rn=(n*95+99)/100 THEN first_audio_latency_ms END) p95 FROM r GROUP BY network_group)
SELECT x.network_group,COUNT(*) AS asr_turns,SUM(x.outcome='succeeded') AS succeeded,ROUND(SUM(x.outcome='succeeded')*1.0/NULLIF(COUNT(*),0),6) AS success_rate,p.p95 AS first_audio_p95_ms FROM x LEFT JOIN p ON p.network_group=x.network_group GROUP BY x.network_group ORDER BY x.network_group;""",'network_group asr_turns succeeded success_rate first_audio_p95_ms','每轮最后可见观测分组，不声称观测覆盖全程网络或证明因果。')
# 区间覆盖分别核对首音前与完整已观察流程，不用播报后的耗时解释首播。
spans=f"""action_ends AS (
 SELECT i.invocation_id,i.turn_id,i.submitted_offset_ms,MIN(r.observed_offset_ms) en
 FROM syn_action_invocation i JOIN turns t ON t.turn_id=i.turn_id
 JOIN syn_action_result r ON r.invocation_id=i.invocation_id
 WHERE {offset_visible('i','submitted_offset_ms')} AND {offset_visible('r','observed_offset_ms')}
 AND r.return_state IN ('succeeded','failed','cancelled') GROUP BY i.invocation_id,i.turn_id,i.submitted_offset_ms
), raw_spans AS (
 SELECT a.turn_id,a.start_offset_ms AS st,a.finish_offset_ms AS en FROM syn_asr_attempt a JOIN turns t ON t.turn_id=a.turn_id WHERE {offset_visible('a')}
 UNION ALL SELECT n.turn_id,n.start_offset_ms,n.finish_offset_ms FROM syn_nlu_attempt n JOIN turns t ON t.turn_id=n.turn_id WHERE {offset_visible('n')}
 UNION ALL SELECT r.turn_id,r.start_offset_ms,r.finish_offset_ms FROM syn_skill_route r JOIN turns t ON t.turn_id=r.turn_id WHERE {offset_visible('r')}
 UNION ALL SELECT turn_id,submitted_offset_ms,en FROM action_ends
 UNION ALL SELECT x.turn_id,x.start_offset_ms,x.finish_offset_ms FROM syn_tts_request x JOIN turns t ON t.turn_id=x.turn_id WHERE {offset_visible('x')}
 UNION ALL SELECT p.turn_id,p.start_offset_ms,p.finish_offset_ms FROM syn_playback_segment p JOIN turns t ON t.turn_id=p.turn_id WHERE {offset_visible('p')}
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
"""
put('overlap_critical_path','WITH '+turns()+',\n'+spans+"""
SELECT l.turn_id,l.first_audio_latency_ms AS first_audio_ms,l.observed_end-l.input_ms AS observed_flow_ms,
 f.sum_ms AS observed_stage_sum_ms,f.covered_ms AS observed_covered_ms,f.overlap_ms AS observed_overlap_ms,
 COALESCE(b.sum_ms,0) AS before_first_stage_sum_ms,COALESCE(b.covered_ms,0) AS before_first_covered_ms,
 COALESCE(b.overlap_ms,0) AS before_first_overlap_ms,l.first_audio_latency_ms-COALESCE(b.covered_ms,0) AS before_first_unobserved_ms
FROM limits l JOIN stats f ON f.turn_id=l.turn_id AND f.window_kind='observed_flow'
LEFT JOIN stats b ON b.turn_id=l.turn_id AND b.window_kind='before_first_audio'
WHERE f.overlap_ms>0 ORDER BY l.turn_id;""",'turn_id first_audio_ms observed_flow_ms observed_stage_sum_ms observed_covered_ms observed_overlap_ms before_first_stage_sum_ms before_first_covered_ms before_first_overlap_ms before_first_unobserved_ms','含动作提交到首次可见确定回执、TTS与播放；unknown动作无确定终点不伪造区间。完整流程与首音前分别做交并；首音后的重叠不能解释首播延迟，不宣称证明依赖关键路径或根因。')
put('streamed_playback','WITH '+turns()+f""", tts AS (SELECT r.turn_id,COUNT(*) n,SUM(r.outcome='succeeded') succeeded FROM syn_tts_request r JOIN turns t ON t.turn_id=r.turn_id WHERE {offset_visible('r')} GROUP BY r.turn_id),
 plays AS (SELECT p.turn_id,COUNT(*) n,SUM(p.completion_state='complete') completed,MIN(CASE WHEN p.played_ms>0 THEN p.start_offset_ms END) first_start FROM syn_playback_segment p JOIN turns t ON t.turn_id=p.turn_id WHERE {offset_visible('p')} GROUP BY p.turn_id)
SELECT t.turn_id,COALESCE(r.n,0) AS tts_attempts,COALESCE(r.succeeded,0) AS tts_succeeded,COALESCE(p.n,0) AS playback_segments,COALESCE(p.completed,0) AS completed_segments,p.first_start-t.input_ms AS first_audio_ms
FROM turns t LEFT JOIN tts r ON r.turn_id=t.turn_id LEFT JOIN plays p ON p.turn_id=t.turn_id WHERE COALESCE(p.n,0)>1 ORDER BY t.turn_id;""",'turn_id tts_attempts tts_succeeded playback_segments completed_segments first_audio_ms')
put('weighted_success_rate','WITH '+final_asr()+""", language AS (SELECT turn_locale AS locale,COUNT(*) n,SUM(outcome='succeeded') ok FROM final_asr WHERE final_rank=1 GROUP BY turn_locale)
SELECT SUM(n) AS turns,SUM(ok) AS succeeded,ROUND(AVG(ok*1.0/NULLIF(n,0)),6) AS unweighted_mean,
 ROUND(SUM(ok)*1.0/NULLIF(SUM(n),0),6) AS weighted_rate FROM language;""",'turns succeeded unweighted_mean weighted_rate')
put('wake_denominator','WITH '+turns()+',\n'+wake+"""
SELECT entry_kind,COUNT(*) AS turns,COUNT(DISTINCT session_id) AS sessions,
 (SELECT COUNT(*) FROM wake w WHERE w.trigger_kind=t.entry_kind) AS entry_observations,
 (SELECT COALESCE(SUM(accepted),0) FROM wake w WHERE w.trigger_kind=t.entry_kind) AS accepted_observations
FROM turns t GROUP BY entry_kind ORDER BY entry_kind;""",'entry_kind turns sessions entry_observations accepted_observations','入口记录可包含拒绝且无session；有效轮次不是入口尝试分母。')
put('stage_success_cancelled_turn','WITH '+final_asr()+f""", playback AS (SELECT p.turn_id,COUNT(*) n,SUM(p.completion_state='interrupted') interrupted FROM syn_playback_segment p JOIN turns t ON t.turn_id=p.turn_id WHERE {offset_visible('p')} GROUP BY p.turn_id)
SELECT a.turn_id,a.outcome AS asr_final_outcome,a.final_outcome AS turn_outcome,COALESCE(p.n,0) AS playback_segments,COALESCE(p.interrupted,0) AS interrupted_segments
FROM final_asr a LEFT JOIN playback p ON p.turn_id=a.turn_id WHERE a.final_rank=1 AND a.outcome='succeeded' AND (a.final_outcome='cancelled' OR COALESCE(p.interrupted,0)>0) ORDER BY a.turn_id;""",'turn_id asr_final_outcome turn_outcome playback_segments interrupted_segments')
put('dialogues_vs_turns','WITH '+turns()+f""", clarifying AS (SELECT DISTINCT d.turn_id FROM syn_dialogue_transition d JOIN turns t ON t.turn_id=d.turn_id WHERE d.to_state='awaiting_slot' AND {offset_visible('d','offset_ms')})
SELECT COUNT(DISTINCT t.session_id) AS dialogues,COUNT(*) AS turns,COUNT(DISTINCT CASE WHEN c.turn_id IS NOT NULL THEN t.session_id END) AS clarification_dialogues FROM turns t LEFT JOIN clarifying c ON c.turn_id=t.turn_id;""",'dialogues turns clarification_dialogues')
put('daily_voice_reconciliation','WITH '+turns()+f""", day_turns AS (SELECT * FROM turns WHERE substr(started_at,1,10)='2026-09-15'),
 asr AS (SELECT a.*,ROW_NUMBER() OVER(PARTITION BY a.turn_id ORDER BY a.attempt_no DESC,a.asr_attempt_id DESC) rn FROM syn_asr_attempt a JOIN day_turns t ON t.turn_id=a.turn_id WHERE {offset_visible('a')}),
 m AS (SELECT SUM(turn_count) n,SUM(task_completed_count) completed,SUM(eligible_turn_count) eligible FROM syn_daily_voice_experience WHERE activity_date='2026-09-15')
SELECT (SELECT COUNT(*) FROM day_turns) AS raw_turns,m.n AS mart_turns,(SELECT COUNT(*) FROM day_turns WHERE final_outcome='completed') AS raw_completed,m.completed AS mart_completed,(SELECT COUNT(*) FROM day_turns WHERE final_outcome IN {ELIGIBLE}) AS raw_eligible,m.eligible AS mart_eligible FROM m;""",'raw_turns mart_turns raw_completed mart_completed raw_eligible mart_eligible','日体验mart没有ASR最终尝试成功数或动作请求量列；分别用阶段/意图mart对账，不凭空填列。')
put('timezone_boundary','WITH '+turns('quarter')+" SELECT date(started_at) AS utc_date,date(started_at,'+8 hours') AS utc_plus_eight_date,COUNT(*) AS turns FROM turns WHERE date(started_at)<>date(started_at,'+8 hours') GROUP BY utc_date,utc_plus_eight_date ORDER BY utc_date,utc_plus_eight_date;",'utc_date utc_plus_eight_date turns')
put('late_receipt_visibility','WITH '+turns()+f"""
SELECT COUNT(*) AS received_result_rows,SUM(r.received_at<'{CUTOFF}') AS snapshot_visible_rows,SUM(r.received_at>='{CUTOFF}') AS late_rows
FROM syn_action_result r JOIN turns t ON t.turn_id=r.turn_id
WHERE CAST(strftime('%s',t.started_at) AS INTEGER)*1000+r.observed_offset_ms<CAST(strftime('%s','{CUTOFF}') AS INTEGER)*1000;""",'received_result_rows snapshot_visible_rows late_rows','质量诊断用完整合成seed看晚到；运营指标不纳入快照后收到的结果。')
put('historical_build_usage','WITH '+turns('quarter')+"""
SELECT substr(t.started_at,1,7) AS month,t.vehicle_id,t.build_id AS historical_build,v.current_build_id,COUNT(*) AS turns
FROM turns t JOIN syn_vehicle v ON v.vehicle_id=t.vehicle_id WHERE t.build_id<>v.current_build_id
GROUP BY month,t.vehicle_id,t.build_id,v.current_build_id ORDER BY month,t.vehicle_id,t.build_id;""",'month vehicle_id historical_build current_build_id turns')
put('unknown_action_receipts','WITH '+inv+',\n'+results+"""
SELECT final_state,COUNT(*) AS logical_actions,SUM(attempts) AS invocation_attempts FROM final_operations WHERE final_state IN ('unknown','no_receipt') GROUP BY final_state ORDER BY final_state;""",'final_state logical_actions invocation_attempts')
put('null_zero_skipped_stages','WITH '+turns()+f"""
SELECT SUM(t.entry_kind IN ('button','continuous') AND NOT EXISTS(SELECT 1 FROM syn_wakeup_attempt w WHERE w.session_id=t.session_id AND w.received_at<'{CUTOFF}' AND w.quality_state='valid')) AS legal_no_wakeup_turns,
 SUM(t.final_outcome='no_speech') AS no_speech_turns,
 SUM(NOT EXISTS(SELECT 1 FROM syn_tts_request r WHERE r.turn_id=t.turn_id AND r.received_at<'{CUTOFF}')) AS no_tts_turns,
 SUM(t.first_audio_latency_ms IS NULL) AS no_observed_first_audio,
 SUM(t.first_audio_latency_ms=0) AS observed_zero_first_audio
FROM turns t;""",'legal_no_wakeup_turns no_speech_turns no_tts_turns no_observed_first_audio observed_zero_first_audio')
put('turn_change_contribution','WITH '+turns('quarter')+""", languages AS (SELECT locale,SUM(substr(started_at,1,7)='2026-08' AND final_outcome='completed') AS aug_completed,SUM(substr(started_at,1,7)='2026-09' AND final_outcome='completed') AS sep_completed FROM turns GROUP BY locale),
 changes AS (SELECT *,sep_completed-aug_completed AS delta FROM languages), total AS (SELECT SUM(delta) total_delta FROM changes)
SELECT c.locale,c.aug_completed,c.sep_completed,c.delta,t.total_delta,ROUND(c.delta*1.0/NULLIF(t.total_delta,0),6) AS share_of_change FROM changes c CROSS JOIN total t ORDER BY c.locale;""",'locale aug_completed sep_completed delta total_delta share_of_change')
put('asr_two_months','WITH '+final_asr('quarter')+"""
SELECT substr(turn_started_at,1,7) AS month,COUNT(*) AS turns,SUM(outcome='succeeded') AS succeeded,ROUND(SUM(outcome='succeeded')*1.0/NULLIF(COUNT(*),0),6) AS final_success_rate FROM final_asr WHERE final_rank=1 AND substr(turn_started_at,1,7) IN ('2026-08','2026-09') GROUP BY month ORDER BY month;""",'month turns succeeded final_success_rate')
put('first_playback_month_comparison','WITH '+first_audio('quarter')+""", r AS (SELECT substr(started_at,1,7) month,observed_first_audio_ms,ROW_NUMBER() OVER(PARTITION BY substr(started_at,1,7) ORDER BY observed_first_audio_ms,turn_id) rn,COUNT(*) OVER(PARTITION BY substr(started_at,1,7)) n FROM first_audio)
SELECT month,MAX(n) samples,MAX(CASE WHEN rn=(n*95+99)/100 THEN observed_first_audio_ms END) p95_ms FROM r WHERE month IN ('2026-08','2026-09') GROUP BY month ORDER BY month;""",'month samples p95_ms')
put('first_playback_seconds','WITH '+first_audio()+""", r AS (SELECT observed_first_audio_ms,ROW_NUMBER() OVER(ORDER BY observed_first_audio_ms,turn_id) rn,COUNT(*) OVER() n FROM first_audio)
SELECT COALESCE(MAX(n),0) samples,MAX(CASE WHEN rn=(n*95+99)/100 THEN observed_first_audio_ms END) p95_ms,ROUND(MAX(CASE WHEN rn=(n*95+99)/100 THEN observed_first_audio_ms END)/1000.0,3) p95_seconds FROM r;""",'samples p95_ms p95_seconds')
put('asr_candidates_large_result','WITH '+fact('syn_asr_attempt','a',period='quarter')+f"""
SELECT h.hypothesis_id,h.turn_id,h.asr_attempt_id,h.candidate_rank,h.confidence_permille,h.selected_for_nlu,h.normalized_text FROM syn_asr_hypothesis h JOIN facts a ON a.asr_attempt_id=h.asr_attempt_id WHERE h.received_at<'{CUTOFF}' ORDER BY h.turn_id,h.asr_attempt_id,h.candidate_rank,h.hypothesis_id;""",'hypothesis_id turn_id asr_attempt_id candidate_rank confidence_permille selected_for_nlu normalized_text','完整参考保留总行数/摘要；平台保存上限不代表原数据总量。',True)
# 人工标签子集，不使用预测补标签；缺失预测仍留在分母。
put('transcript_label_accuracy','WITH '+turns()+f""", chosen AS (SELECT h.turn_id,h.hypothesis_text FROM syn_asr_hypothesis h JOIN syn_asr_attempt a ON a.asr_attempt_id=h.asr_attempt_id JOIN turns t ON t.turn_id=h.turn_id WHERE h.selected_for_nlu=1 AND h.is_final=1 AND h.received_at<'{CUTOFF}' AND {offset_visible('a')})
SELECT COUNT(*) AS eligible_turns,COUNT(t.reference_text) AS labeled_turns,
 SUM(CASE WHEN t.reference_text IS NOT NULL AND {normalized('t.reference_text')}={normalized('h.hypothesis_text')} THEN 1 ELSE 0 END) AS exact_matches,
 ROUND(SUM(CASE WHEN t.reference_text IS NOT NULL AND {normalized('t.reference_text')}={normalized('h.hypothesis_text')} THEN 1 ELSE 0 END)*1.0/NULLIF(COUNT(t.reference_text),0),6) AS exact_match_rate
FROM turns t LEFT JOIN chosen h ON h.turn_id=t.turn_id WHERE t.final_outcome IN {ELIGIBLE};""",'eligible_turns labeled_turns exact_matches exact_match_rate','只去规定空白/标点与ASCII小写，不做中文数字、同义词、CER/WER。')
put('intent_label_accuracy','WITH '+turns()+f""", chosen AS (SELECT n.turn_id,n.predicted_intent_id FROM syn_nlu_attempt n JOIN turns t ON t.turn_id=n.turn_id WHERE n.selected_for_dialogue=1 AND {offset_visible('n')})
SELECT COUNT(*) AS eligible_turns,COUNT(t.reference_intent_id) AS labeled_turns,SUM(CASE WHEN t.reference_intent_id IS NOT NULL AND n.predicted_intent_id=t.reference_intent_id THEN 1 ELSE 0 END) AS intent_matches,
 ROUND(SUM(CASE WHEN t.reference_intent_id IS NOT NULL AND n.predicted_intent_id=t.reference_intent_id THEN 1 ELSE 0 END)*1.0/NULLIF(COUNT(t.reference_intent_id),0),6) AS intent_match_rate
FROM turns t LEFT JOIN chosen n ON n.turn_id=t.turn_id WHERE t.final_outcome IN {ELIGIBLE};""",'eligible_turns labeled_turns intent_matches intent_match_rate')
put('build_stratified_comparison','WITH '+final_asr('quarter')+"""
SELECT build_id,model_id,turn_locale,entry_kind,endpoint_kind,COUNT(*) AS turns,SUM(outcome='succeeded') AS succeeded,ROUND(SUM(outcome='succeeded')*1.0/NULLIF(COUNT(*),0),6) AS final_success_rate
FROM final_asr WHERE final_rank=1 GROUP BY build_id,model_id,turn_locale,entry_kind,endpoint_kind ORDER BY build_id,model_id,turn_locale,entry_kind,endpoint_kind;""",'build_id model_id turn_locale entry_kind endpoint_kind turns succeeded final_success_rate','不同模型/语言/入口/路径构成先分层；不是随机试验证据。')
put('fallback_paths','WITH '+asr+""", ranked AS (SELECT *,ROW_NUMBER() OVER(PARTITION BY turn_id ORDER BY attempt_no,asr_attempt_id) first_rank,ROW_NUMBER() OVER(PARTITION BY turn_id ORDER BY attempt_no DESC,asr_attempt_id DESC) final_rank FROM facts),
 per_turn AS (SELECT turn_id,COUNT(*) attempts,MAX(endpoint_kind='cloud') cloud,MAX(endpoint_kind='edge') edge,MAX(fallback_reason<>'none') fallback,
 MAX(CASE WHEN first_rank=1 THEN outcome END) first_outcome,MAX(CASE WHEN final_rank=1 THEN outcome END) final_outcome FROM ranked GROUP BY turn_id)
SELECT CASE WHEN fallback=1 THEN 'fallback' WHEN cloud=1 AND edge=0 THEN 'cloud_only' WHEN edge=1 AND cloud=0 THEN 'edge_only' ELSE 'mixed_without_fallback_flag' END path,
 COUNT(*) turns,SUM(attempts) attempts,SUM(p.first_outcome='succeeded') first_succeeded,SUM(p.final_outcome='succeeded') final_succeeded,
 SUM(p.first_outcome<>'succeeded' AND p.final_outcome='succeeded') recovered_turns,
 SUM(t.final_outcome='completed') completed_turns,ROUND(AVG(CASE WHEN p.final_outcome='succeeded' THEN t.first_audio_latency_ms END),6) successful_asr_first_audio_mean_ms
FROM per_turn p JOIN turns t ON t.turn_id=p.turn_id GROUP BY path ORDER BY path;""",'path turns attempts first_succeeded final_succeeded recovered_turns completed_turns successful_asr_first_audio_mean_ms','ASR最终成功与端到端completed分列；时延均值仅取最终ASR成功且有首音样本，不把未知算成功。')
put('build_playback_quantiles','WITH '+first_audio('quarter')+""", ranked AS (
 SELECT *,ROW_NUMBER() OVER(PARTITION BY build_id,model_id,locale,entry_kind ORDER BY observed_first_audio_ms,turn_id) rn,
 COUNT(*) OVER(PARTITION BY build_id,model_id,locale,entry_kind) n FROM first_audio)
SELECT build_id,model_id,locale,entry_kind,MAX(n) AS audio_samples,MAX(CASE WHEN rn=(n*95+99)/100 THEN observed_first_audio_ms END) AS first_audio_p95_ms
FROM ranked GROUP BY build_id,model_id,locale,entry_kind ORDER BY build_id,model_id,locale,entry_kind;""",'build_id model_id locale entry_kind audio_samples first_audio_p95_ms','首音样本独立于是否有最终ASR；版本和构成来自实际历史记录，不声称因果。')
bundle('build_comparison_bundle',['build_stratified_comparison','build_playback_quantiles'])
put('dialogue_context_actions','WITH '+inv+',\n'+results+f""", links AS (SELECT s.turn_id,COUNT(*) carried_slots,COUNT(DISTINCT s.source_turn_id) source_turns FROM syn_slot_value s JOIN turns t ON t.turn_id=s.turn_id WHERE s.source_turn_id IS NOT NULL AND s.received_at<'{CUTOFF}' GROUP BY s.turn_id),
 clarifying AS (SELECT DISTINCT d.turn_id FROM syn_dialogue_transition d JOIN turns t ON t.turn_id=d.turn_id WHERE d.to_state='awaiting_slot' AND {offset_visible('d','offset_ms')}),
 actions AS (SELECT turn_id,COUNT(*) logical_actions,SUM(confirmed) confirmed_actions,SUM(final_state IN ('unknown','no_receipt')) unknown_actions FROM final_operations GROUP BY turn_id)
SELECT t.turn_id,t.session_id,t.parent_turn_id,t.final_outcome,CASE WHEN c.turn_id IS NULL THEN 0 ELSE 1 END asked_for_slot,COALESCE(l.carried_slots,0) carried_slots,COALESCE(l.source_turns,0) source_turns,COALESCE(a.logical_actions,0) logical_actions,COALESCE(a.confirmed_actions,0) confirmed_actions,COALESCE(a.unknown_actions,0) unknown_actions
FROM turns t LEFT JOIN links l ON l.turn_id=t.turn_id LEFT JOIN clarifying c ON c.turn_id=t.turn_id LEFT JOIN actions a ON a.turn_id=t.turn_id
WHERE c.turn_id IS NOT NULL OR l.turn_id IS NOT NULL ORDER BY t.session_id,t.turn_no,t.turn_id;""",'turn_id session_id parent_turn_id final_outcome asked_for_slot carried_slots source_turns logical_actions confirmed_actions unknown_actions')
put('quarterly_task_trend','WITH '+turns('quarter')+f"""
SELECT substr(started_at,1,7) month,COUNT(*) turns,SUM(final_outcome IN {ELIGIBLE}) eligible,SUM(final_outcome='completed') completed,
 ROUND(SUM(final_outcome='completed')*1.0/NULLIF(SUM(final_outcome IN {ELIGIBLE}),0),6) completion_rate,
 COUNT(first_audio_latency_ms) first_audio_samples,ROUND(AVG(first_audio_latency_ms),6) first_audio_mean_ms
FROM turns GROUP BY month ORDER BY month;""",'month turns eligible completed completion_rate first_audio_samples first_audio_mean_ms')
bundle('split_asr_playback_periods',['asr_final_success','first_playback_month_comparison'],'九月ASR与八月首播独立条件。')
bundle('batch_asr_playback',['asr_final_success','first_playback_quantiles'],'仅A/C实际执行，B未提交。')
bundle('asr_playback_bundle',['asr_final_success','first_playback_quantiles'])
bundle('voice_chain_bundle',['turns_by_entry','wake_outcomes','wake_label_accuracy','vad_segments','asr_final_success','nlu_outcomes','skill_route_outcomes','action_receipts','tts_outcomes','playback_outcomes','quarterly_task_trend','transcript_label_accuracy','intent_label_accuracy','feedback_rates'])
bundle('critical_path_bundle',['overlap_critical_path','stage_latency','first_playback_quantiles'])
bundle('fallback_bundle',['fallback_paths','first_vs_final_success','network_voice_association'])
bundle('dialogue_action_bundle',['clarification_counts','slot_completeness','dialogue_context_actions','action_receipts'])
bundle('quarterly_voice_bundle',['quarterly_task_trend','asr_two_months','first_playback_month_comparison','turn_change_contribution'])
ORACLES['relative_month_behavior']={'kind':'behavior','rules':['由实际宿主request_clock展开上一UTC自然月半开区间','执行和结果解释沿原绝对参数，不按新时钟重算','超出冻结快照的范围明确说明，不编造业务未来事实']}
ORACLES['report_sources_behavior']={'kind':'behavior','rules':['只引用本人可读且有效的来源','每份来源保留原task/condition/query/result_ref','图表与正式数字使用实际返回列','报告/方法创建和修订不增加SQL执行授权']}
ORACLES['catalog_coverage_behavior']={'kind':'behavior','rules':['按knowledge manifest核对28表14文档与实际字段语义','限定范围和同版续读贯穿调查','只发送批准的模型知识，不上传seed、generator、oracle或评分','未完成/截断不能宣称全部覆盖']}
