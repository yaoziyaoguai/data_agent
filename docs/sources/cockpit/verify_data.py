#!/usr/bin/env python3
"""独立核对合成语音日志的关系、时钟、状态与汇总；不读取业务验收预期。"""
from __future__ import annotations
import argparse
from collections import defaultdict
from datetime import datetime,timedelta
import hashlib
import json
from pathlib import Path
import sqlite3

ROOT=Path(__file__).resolve().parent

def moment(value):return datetime.fromisoformat(value.replace('Z','+00:00'))
def check(condition,name):
    if not condition:raise AssertionError(name)

def verify():
    spec=json.loads((ROOT/'domain-spec.json').read_text());con=sqlite3.connect(':memory:');con.row_factory=sqlite3.Row
    con.execute('PRAGMA foreign_keys=ON')
    for name in ['schema.sql','seed.sql','etl.sql']:con.executescript((ROOT/name).read_text())
    checks=[]
    def passed(name,condition):check(condition,name);checks.append(name)
    tables={t['name']:[dict(r) for r in con.execute('SELECT * FROM '+t['name'])] for t in spec['tables']}
    indices={t['name']:{r[t['primary_key'][0]]:r for r in tables[t['name']]} for t in spec['tables'] if len(t['primary_key'])==1}
    def rows(name):return tables['syn_'+name]
    def get(name,id):return indices['syn_'+name][id]
    def scalar(sql):return con.execute(sql).fetchone()[0]
    cutoff=spec['time']['snapshot_exclusive'];cut=moment(cutoff)
    passed('28张表与至少300个语义字段实际存在',len(tables)==28 and sum(len(con.execute('PRAGMA table_info('+t+')').fetchall()) for t in tables)==spec['counts']['fields']>=300)
    passed('全部外键可解析',not con.execute('PRAGMA foreign_key_check').fetchall())
    passed('种子小于10MB且具有数万事实',(ROOT/'seed.sql').stat().st_size<10000000 and sum(len(v) for k,v in tables.items() if not k.startswith('syn_daily_'))>=25000)
    passed('没有原始音频、真实身份或地理列',not any(c['name'] in {'vin','audio_path','audio_uri','audio_blob','latitude','longitude','phone_number','email','account_id'} for t in spec['tables'] for c in t['columns']))
    for session in rows('voice_session'):
        vehicle=get('vehicle',session['vehicle_id']);build=get('software_build',session['build_id']);start=moment(session['started_at']);end=moment(session['ended_at'])
        check(vehicle['telemetry_consent']==1,'无授权车辆不能产生会话')
        check(session['duration_ms']==round((end-start).total_seconds()*1000),'会话时长与时钟一致')
        check(session['started_at']>=vehicle['first_activated_at'] and (not vehicle['retired_at'] or session['started_at']<vehicle['retired_at']),'会话在设备观察范围内')
        check(session['started_at']>=build['released_at'],'会话不得使用未来build')
        check(moment(session['received_at'])>end,'会话接收晚于结束')
    passed('会话身份、版本、授权与精确时长自洽',True)
    for turn in rows('voice_turn'):
        session=get('voice_session',turn['session_id']);start=moment(turn['started_at']);end=moment(turn['finished_at'])
        check(moment(session['started_at'])<=start<=end<=moment(session['ended_at']),'轮次在会话内')
        check(turn['finished_at']==(start+timedelta(milliseconds=turn['terminal_offset_ms'])).strftime('%Y-%m-%dT%H:%M:%SZ'),'墙钟按单调偏移截断')
        check(turn['task_latency_ms']==turn['terminal_offset_ms']-turn['input_ms'],'任务时延从输入结束计')
        check(moment(turn['received_at'])>start+timedelta(milliseconds=turn['terminal_offset_ms']),'轮次接收晚于任务结束')
        if parent:=turn['parent_turn_id']:
            original=get('voice_turn',parent);check(original['session_id']==turn['session_id'] and original['turn_no']<turn['turn_no'],'上下文仅来自同会话前文')
        has_label=turn['reference_text'] is not None or turn['reference_intent_id'] is not None
        check((turn['label_origin']=='synthetic_authored')==has_label,'参考标签与来源一致')
    passed('轮次时钟、输入排除、上下文与标签NULL正确',True)
    segments=defaultdict(list)
    for r in rows('frontend_segment'):segments[r['turn_id']].append(r)
    for turn in rows('voice_turn'):
        ordered=sorted(segments[turn['turn_id']],key=lambda r:r['segment_no']);position=0
        for r in ordered:check(r['start_offset_ms']==position,'VAD片段连续无重叠');position=r['end_offset_ms']
        check(position==turn['input_ms'],'VAD覆盖输入区间')
    passed('前端片段连续覆盖人工输入时长且不生成音频',True)
    stage_tables=[('asr_attempt','finish_offset_ms'),('nlu_attempt','finish_offset_ms'),('skill_route','finish_offset_ms'),('tts_request','finish_offset_ms'),('playback_segment','finish_offset_ms'),('frontend_segment','end_offset_ms'),('dialogue_transition','offset_ms'),('action_result','observed_offset_ms'),('action_invocation','submitted_offset_ms')]
    for name,offset in stage_tables:
        for r in rows(name):
            turn=get('voice_turn',r['turn_id']);actual=moment(turn['started_at'])+timedelta(milliseconds=r[offset]);check(moment(r['received_at'])>actual,'阶段接收晚于实际发生/结束:'+name)
    passed('所有offset共用turn锚点且接收不早于实际阶段',True)
    for r in rows('asr_attempt')+rows('nlu_attempt'):
        model=get('recognizer_model',r['recognizer_id']);turn=get('voice_turn',r['turn_id']);session=get('voice_session',turn['session_id']);policy=get('runtime_policy',session['policy_id'])
        check(model['component']==('asr' if 'asr_attempt_id'in r else 'nlu'),'模型类型匹配阶段')
        check(model['endpoint_kind']==r['endpoint_kind'] and model['locale']==turn['locale'],'模型端云与locale匹配')
        check(model['available_from']<=turn['started_at'],'不使用未来模型')
        check(policy['endpoint_preference']!='edge_only' or r['endpoint_kind']=='edge','edge_only不调用云ASR/NLU')
    passed('端云配置、语言、可用版本与策略一致',True)
    for r in rows('asr_hypothesis'):
        a=get('asr_attempt',r['asr_attempt_id']);check(a['turn_id']==r['turn_id'] and a['outcome']=='succeeded','候选属于成功的同轮ASR')
    for r in rows('nlu_attempt'):
        h=get('asr_hypothesis',r['hypothesis_id']);check(h['turn_id']==r['turn_id'] and h['selected_for_nlu']==1,'NLU采用同轮实际候选')
        check(h['is_final']==1 and r['start_offset_ms']>=get('asr_attempt',h['asr_attempt_id'])['finish_offset_ms'],'本包NLU只在所采用ASR最终候选就绪后开始')
        slots=[s for s in rows('slot_value') if s['nlu_attempt_id']==r['nlu_attempt_id']]
        check(sum(s['is_required'] and not s['is_resolved'] for s in slots)==r['missing_required_slots'],'缺槽数与记录一致')
    for r in rows('slot_value'):
        n=get('nlu_attempt',r['nlu_attempt_id']);check(n['turn_id']==r['turn_id'],'槽位轮次匹配')
        if r['resolution_source']=='context':
            check(r['source_turn_id'] is not None,'上下文槽位保留来源');source=get('voice_turn',r['source_turn_id']);target=get('voice_turn',r['turn_id']);check(source['session_id']==target['session_id'] and source['turn_no']<target['turn_no'],'槽位来源同会话前文')
        else:check(r['source_turn_id'] is None,'非上下文槽位不伪造来源')
    passed('ASR候选、NLU选择和必填槽位引用一致',True)
    for r in rows('skill_route'):
        n=get('nlu_attempt',r['nlu_attempt_id']);intent=get('intent_catalog',r['intent_id'])
        check(n['turn_id']==r['turn_id'] and n['selected_for_dialogue']==1 and n['predicted_intent_id']==r['intent_id'],'路由使用最终采用理解')
        check(r['capability_id']==intent['capability_id'],'意图所属能力匹配')
        check(not r['is_final_route'] or r['outcome']=='selected','仅selected可为最终路由')
        if r['is_final_route']:
            cap=get('voice_capability',r['capability_id']);session=get('voice_session',get('voice_turn',r['turn_id'])['session_id'])
            check(cap['seat_scope']=='all' or (cap['seat_scope']=='front' and session['seat_zone']!='rear') or (cap['seat_scope']=='driver' and session['seat_zone']=='driver'),'最终路由符合音区规则')
    passed('最终路由符合实际意图、能力与音区边界',True)
    operation_results=defaultdict(list);invocations=defaultdict(list)
    for a in rows('action_invocation'):
        route=get('skill_route',a['route_id']);check(route['turn_id']==a['turn_id'] and route['is_final_route']==1,'动作来自最终同轮路由')
        check(a['action_name']==get('intent_catalog',route['intent_id'])['action_name'],'动作名来自意图定义');invocations[a['operation_key']].append(a)
    for r in rows('action_result'):
        a=get('action_invocation',r['invocation_id']);check(a['turn_id']==r['turn_id'] and a['operation_key']==r['operation_key'],'回执操作身份一致')
        check(r['observed_offset_ms']>=a['submitted_offset_ms'],'回执不早于提交');operation_results[r['operation_key']].append(r)
    for op,values in operation_results.items():
        confirmed=[r for r in values if r['effect_state']=='confirmed']
        check(len({r['effect_instance_id'] for r in confirmed})<=1,'同操作不产生两个效果实例')
        check(len({(r['result_value'],r['result_unit']) for r in confirmed})<=1,'重放不改变效果值')
        if confirmed:
            first=min(r['observed_offset_ms'] for r in confirmed)
            check(all(r['return_state']=='succeeded' and r['effect_state']=='confirmed' for r in values if r['observed_offset_ms']>=first),'已确认效果不被后续unknown降级')
    passed('传输重试与重复回执保持单一逻辑效果',True)
    plays=defaultdict(list);tts_plays=defaultdict(list)
    for r in rows('playback_segment'):
        tts=get('tts_request',r['tts_id']);check(tts['turn_id']==r['turn_id'] and tts['outcome']=='succeeded','播放只引用同轮成功TTS')
        check(r['start_offset_ms']>=tts['first_chunk_offset_ms'],'首音不早于首块')
        check(r['planned_ms']<=tts['simulated_audio_ms'],'播放计划不超过合成时长');plays[r['turn_id']].append(r);tts_plays[r['tts_id']].append(r)
    for tts_id,segments in tts_plays.items():
        ordered=sorted(segments,key=lambda r:r['segment_no'])
        check([r['segment_no'] for r in ordered]==list(range(1,len(ordered)+1)),'同TTS播放段编号连续且不重用')
        check(sum(r['planned_ms'] for r in ordered)<=get('tts_request',tts_id)['simulated_audio_ms'],'多段播放计划不能重复计入同一合成音频')
        check(all(a['finish_offset_ms']<=b['start_offset_ms'] for a,b in zip(ordered,ordered[1:])),'同TTS连续播放段不重叠')
    passed('多段播报保持同一TTS身份与不重复的音频时间范围',True)
    for turn in rows('voice_turn'):
        expected=min((r['start_offset_ms'] for r in plays[turn['turn_id']]),default=None)
        check(turn['first_audio_latency_ms']==(expected-turn['input_ms'] if expected is not None else None),'首音来自实际播放而非TTS请求')
        if turn['final_outcome']=='completed':
            check(any(r['effect_state']=='confirmed' for r in rows('action_result') if r['turn_id']==turn['turn_id']),'completed有真实合成效果回执')
    for r in rows('interruption_event'):
        play=get('playback_segment',r['playback_id']);turn=get('voice_turn',r['interrupted_turn_id']);trigger=get('voice_turn',r['triggering_turn_id']) if r['triggering_turn_id'] else None
        check(play['turn_id']==r['interrupted_turn_id'] and turn['session_id']==r['session_id'],'打断定位原播放与会话')
        check(trigger is None or (trigger['session_id']==r['session_id'] and trigger['turn_no']>turn['turn_no']),'新输入属于同会话后继轮')
        check(r['offset_in_playback_ms']+r['stop_latency_ms']==play['played_ms'],'播放停止时点与确认延迟对应')
        check(turn['final_outcome']=='completed' if r['action_was_already_confirmed'] else True,'播放打断不撤销原效果')
    passed('TTS、实际首音、播放结束和打断分层一致',True)
    valid=f"FROM syn_voice_turn t JOIN syn_voice_session s ON s.session_id=t.session_id JOIN syn_vehicle v ON v.vehicle_id=s.vehicle_id WHERE v.telemetry_consent=1 AND v.is_lab_unit=0 AND s.is_complete=1 AND s.quality_state='valid' AND s.started_at<'{cutoff}' AND s.ended_at<'{cutoff}' AND s.received_at<'{cutoff}' AND t.quality_state='valid' AND t.started_at<'{cutoff}' AND t.finished_at<'{cutoff}' AND t.received_at<'{cutoff}'"
    passed('日体验轮次总量不因候选/槽位/重试放大',scalar('SELECT COALESCE(SUM(turn_count),0) FROM syn_daily_voice_experience')==scalar('SELECT COUNT(*) '+valid))
    passed('缺预测仍保留在人工文本标签分母',scalar('SELECT SUM(asr_labeled_turn_count) FROM syn_daily_voice_experience')==scalar("SELECT COUNT(*) "+valid+" AND t.final_outcome NOT IN ('cancelled','no_speech') AND t.reference_text IS NOT NULL"))
    passed('缺预测仍保留在人工意图标签分母',scalar('SELECT SUM(intent_labeled_turn_count) FROM syn_daily_voice_experience')==scalar("SELECT COUNT(*) "+valid+" AND t.final_outcome NOT IN ('cancelled','no_speech') AND t.reference_intent_id IS NOT NULL"))
    first={name:sorted(tuple(r.values()) for r in values) for name,values in tables.items() if name.startswith('syn_daily_')}
    con.executescript((ROOT/'etl.sql').read_text())
    second={name:[tuple(r) for r in con.execute('SELECT * FROM '+name+' ORDER BY '+','.join(next(t['primary_key'] for t in spec['tables'] if t['name']==name)))] for name in first}
    passed('三份日汇总重算幂等',all(sorted(first[n])==sorted(second[n]) for n in first))
    witnesses={
      'unlabeled_turns':scalar('SELECT COUNT(*) FROM syn_voice_turn WHERE reference_text IS NULL AND reference_intent_id IS NULL'),
      'labeled_without_prediction':scalar("SELECT COUNT(*) FROM syn_voice_turn t WHERE reference_intent_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM syn_nlu_attempt n WHERE n.turn_id=t.turn_id AND n.selected_for_dialogue=1)"),
      'asr_retry_turns':scalar('SELECT COUNT(DISTINCT turn_id) FROM syn_asr_attempt WHERE attempt_no>1'),
      'non_top_selected_hypotheses':scalar('SELECT COUNT(*) FROM syn_asr_hypothesis WHERE selected_for_nlu=1 AND candidate_rank>1'),
      'context_slots':scalar("SELECT COUNT(*) FROM syn_slot_value WHERE resolution_source='context'"),
      'unknown_actions':scalar("SELECT COUNT(*) FROM syn_action_result WHERE return_state='unknown'"),
      'duplicate_confirmed_receipts':scalar("SELECT COUNT(*) FROM (SELECT operation_key FROM syn_action_result WHERE effect_state='confirmed' GROUP BY operation_key HAVING COUNT(*)>1)"),
      'completed_without_audio':scalar("SELECT COUNT(*) FROM syn_voice_turn WHERE final_outcome='completed' AND first_audio_latency_ms IS NULL"),
      'completed_negative_feedback':scalar("SELECT COUNT(*) FROM syn_voice_turn t JOIN syn_turn_feedback f ON f.turn_id=t.turn_id WHERE t.final_outcome='completed' AND f.rating='negative'"),
      'button_without_wakeup':scalar("SELECT COUNT(*) FROM syn_voice_session s WHERE entry_kind='button' AND NOT EXISTS(SELECT 1 FROM syn_wakeup_attempt w WHERE w.session_id=s.session_id)"),
      'late_turns':scalar(f"SELECT COUNT(*) FROM syn_voice_turn WHERE started_at<'{cutoff}' AND received_at>='{cutoff}'"),
      'cross_midnight_playback':sum((moment(get('voice_turn',r['turn_id'])['started_at'])+timedelta(milliseconds=r['finish_offset_ms'])).date()!=moment(get('voice_turn',r['turn_id'])['started_at']).date() for r in rows('playback_segment')),
      'wake_false_accepts':scalar('SELECT COUNT(*) FROM syn_wakeup_attempt WHERE accepted=1 AND reference_is_intended=0'),
      'zero_eligible_day_groups':scalar('SELECT COUNT(*) FROM syn_daily_voice_experience WHERE turn_count>0 AND eligible_turn_count=0'),
      'visible_streaming_tts_playback_turns':scalar('SELECT COUNT(*) '+valid+f" AND t.started_at>='2026-09-01T00:00:00Z' AND t.started_at<'2026-10-01T00:00:00Z' AND EXISTS(SELECT 1 FROM syn_tts_request x JOIN syn_playback_segment p ON p.tts_id=x.tts_id WHERE x.turn_id=t.turn_id AND x.received_at<'{cutoff}' AND p.received_at<'{cutoff}' AND p.start_offset_ms<x.finish_offset_ms AND p.finish_offset_ms>x.start_offset_ms)"),
      'visible_multi_segment_turns':scalar('SELECT COUNT(*) '+valid+f" AND t.started_at>='2026-09-01T00:00:00Z' AND t.started_at<'2026-10-01T00:00:00Z' AND EXISTS(SELECT 1 FROM syn_playback_segment p WHERE p.turn_id=t.turn_id AND p.received_at<'{cutoff}' GROUP BY p.tts_id HAVING COUNT(*)>1)"),
      'late_action_receipts_with_visible_parent':scalar('SELECT COUNT(*) '+valid+f" AND t.started_at>='2026-09-01T00:00:00Z' AND t.started_at<'2026-10-01T00:00:00Z' AND EXISTS(SELECT 1 FROM syn_action_result r JOIN syn_action_invocation a ON a.invocation_id=r.invocation_id WHERE r.turn_id=t.turn_id AND a.received_at<'{cutoff}' AND r.received_at>='{cutoff}' AND CAST(strftime('%s',t.started_at) AS INTEGER)*1000+r.observed_offset_ms<CAST(strftime('%s','{cutoff}') AS INTEGER)*1000)"),
    }
    passed('必要边界均有实际记录而非空设定',all(v>0 for v in witnesses.values()))
    counts={name:scalar('SELECT COUNT(*) FROM '+name) for name in tables}
    result={'passed':True,'checks':checks,'check_count':len(checks),'tables':len(tables),'fields':spec['counts']['fields'],'foreign_keys':sum(len(con.execute('PRAGMA foreign_key_list('+n+')').fetchall()) for n in tables),'row_counts':counts,'rows_total':sum(counts.values()),'boundary_witnesses':witnesses,'source_sha256':{name:hashlib.sha256((ROOT/name).read_bytes()).hexdigest() for name in ['domain-spec.json','schema.sql','seed.sql','etl.sql']}}
    con.close();return result

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--report',type=Path);args=p.parse_args();result=verify()
    if args.report:args.report.parent.mkdir(parents=True,exist_ok=True);args.report.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(result,ensure_ascii=False));return 0
if __name__=='__main__':raise SystemExit(main())
