#!/usr/bin/env python3
"""从公开合成语音规范复现DDL、事件种子和日汇总；不读取外部业务资料。"""
from __future__ import annotations
import argparse
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parent
SPEC=json.loads((ROOT/'domain-spec.json').read_text())
TABLES={t['name']:t for t in SPEC['tables']}
SNAPSHOT=SPEC['time']['snapshot_exclusive']
UTC=timezone.utc

def instant(text):return datetime.fromisoformat(text.replace('Z','+00:00'))
def stamp(anchor,offset_ms=0):return (anchor+timedelta(milliseconds=offset_ms)).strftime('%Y-%m-%dT%H:%M:%SZ')
def received(anchor,offset_ms=0):return stamp(anchor,offset_ms+2500)
def literal(value):
    if value is None:return 'NULL'
    if isinstance(value,int):return str(value)
    return "'"+str(value).replace("'","''")+"'"
def normalize(text):
    removed=set(' \u3000\t\r\n。！？!?，,．.')
    return ''.join(chr(ord(c)+32) if 'A'<=c<='Z' else c for c in text if c not in removed)

def schema_sql():
    chunks=['-- 完全合成的座舱语音交互日志；无音频、VIN、真实位置或公司信息。','PRAGMA foreign_keys = ON;']
    for table in SPEC['tables']:
        columns=[]
        for column in table['columns']:
            name=column['name'];clause=f"{name} {column['type']}"+('' if column['nullable'] else ' NOT NULL')
            if 'enum' in column:clause+=' CHECK ('+name+' IN ('+', '.join(map(literal,column['enum']))+'))'
            if 'minimum' in column:clause+=f" CHECK ({name} >= {column['minimum']})"
            if 'maximum' in column:clause+=f" CHECK ({name} <= {column['maximum']})"
            columns.append('  '+clause)
        columns.append('  PRIMARY KEY ('+', '.join(table['primary_key'])+')')
        columns += ['  UNIQUE ('+', '.join(keys)+')' for keys in table['unique_keys']]
        columns += ['  CHECK ('+check+')' for check in table['checks']]
        for column in table['columns']:
            if reference:=column.get('references'):
                columns.append(f"  FOREIGN KEY ({column['name']}) REFERENCES {reference['table']}({reference['column']})")
        chunks.append('-- '+table['label']+'：'+table['grain']+'。\nCREATE TABLE '+table['name']+' (\n'+',\n'.join(columns)+'\n);')
        for column in table['columns']:
            if 'references' in column and table['primary_key'][0]!=column['name']:
                chunks.append(f"CREATE INDEX ix_{table['name']}_{column['name']} ON {table['name']}({column['name']});")
    for table,flag in [('syn_asr_hypothesis','selected_for_nlu'),('syn_nlu_attempt','selected_for_dialogue'),('syn_skill_route','is_final_route')]:
        chunks.append(f'CREATE UNIQUE INDEX ix_{table}_selected ON {table}(turn_id) WHERE {flag}=1;')
    return '\n\n'.join(chunks)+'\n'

class Data:
    def __init__(self):self.rows=defaultdict(list);self.index={};self.counters=Counter();self.turn_count=0
    def add(self,table,**values):
        name='syn_'+table if not table.startswith('syn_') else table
        definition=TABLES[name];columns={c['name']:c for c in definition['columns']}
        assert not (values.keys()-columns.keys()),(name,values.keys()-columns.keys())
        for key,col in columns.items():
            if key not in values:
                if col['nullable']:values[key]=None
                elif key=='quality_state':values[key]='valid'
                else:raise AssertionError((name,'missing',key))
        self.rows[name].append(values)
        if len(definition['primary_key'])==1:self.index[(name,values[definition['primary_key'][0]])]=values
        return values
    def get(self,table,id):return self.index[('syn_'+table,id)]
    def id(self,prefix):self.counters[prefix]+=1;return f'{prefix}{self.counters[prefix]:07d}'

CAPABILITIES=[
 ('CLIMATE','空调调节','climate','local_action',False,'driver'),
 ('MEDIA','媒体控制','media','local_action',False,'all'),
 ('NAVIGATION','导航目标','navigation','simulated_remote',True,'front'),
 ('STATUS','车辆状态读取','vehicle_status','read_only',False,'all'),
 ('SETTINGS','系统设置','system_settings','local_action',False,'all'),
 ('HELP','语音帮助','assistant_help','read_only',False,'all'),
 ('COMMUNICATION','合成联系人入口','communication','simulated_remote',True,'front'),
]
INTENTS=[
 ('TEMP','CLIMATE','设置温度','set_temperature','target_temperature','decimal','degree_c','16至30，整数或半度','把温度设为22度','Set temperature to 22 degrees'),
 ('MEDIA','MEDIA','播放合成音轨','play_media','media_item','text',None,'仅合成音轨甲或乙','播放合成音轨甲','Play synthetic track A'),
 ('NAV','NAVIGATION','设置虚构目的地','set_destination','destination','text',None,'仅演示地点甲或乙，无坐标','导航到演示地点甲','Navigate to synthetic place A'),
 ('RANGE','STATUS','读取模拟续航','read_range','','text','km','无需槽位，结果只来自合成动作回执','查询模拟续航','Read simulated range'),
 ('VOLUME','SETTINGS','设置音量','set_volume','volume','decimal','percent','0至100整数','音量调到40','Set volume to 40'),
 ('HELP','HELP','显示语音帮助','show_help','','text',None,'无需槽位','显示语音帮助','Show voice help'),
 ('CONTACT','COMMUNICATION','打开合成联系人','open_contact','contact','text',None,'仅演示联系人甲或乙，不含号码','打开演示联系人甲','Open synthetic contact A'),
 ('CANCEL','HELP','取消待定目标','none','','text',None,'只取消明确指向的待定目标','算了','Cancel that'),
]
BUILD_DATES=[instant('2026-06-15T00:00:00Z'),instant('2026-07-25T00:00:00Z'),instant('2026-08-25T00:00:00Z'),instant('2026-09-25T00:00:00Z')]

def build_at(vid,when):
    selected=1
    for i,date in enumerate(BUILD_DATES,1):
        if when>=date+timedelta(days=(vid*2)%7):selected=i
    return 'SB'+str(selected)

def dimensions(data):
    for i in range(1,4):
        data.add('vehicle_model',model_id=f'SM{i}',model_name=['合成座舱甲型','合成座舱乙型','合成座舱丙型'][i-1],hardware_family=f'LAB_FAMILY_{i}',microphone_zone_count=[2,3,4][i-1],speaker_zone_count=[2,3,4][i-1],memory_capacity_mib=[4096,6144,8192][i-1],edge_compute_tier=['basic','standard','extended'][i-1],supports_barge_in=1,supports_offline_asr=1,supported_locales='zh-CN,en-US',introduced_date='2026-06-01',is_simulated=1)
    for i,date in enumerate(BUILD_DATES,1):
        data.add('software_build',build_id=f'SB{i}',build_label=f'synthetic-voice-{i}.0',released_at=stamp(date),base_build_id=f'SB{i-1}' if i>1 else None,release_track='lab' if i==1 else 'trial',protocol_revision=1,dialogue_engine_revision=i,routing_revision=i,default_locale='zh-CN',allows_cloud_fallback=1,is_withdrawn=0)
    for i in range(1,37):
        activation=instant('2026-06-20T00:00:00Z')+timedelta(days=i%7)
        data.add('vehicle',vehicle_id=f'SV{i:03d}',model_id=f'SM{1+(i-1)%3}',fleet_group=['group_a','group_b','group_c'][(i-1)%3],region_code=['zone_n','zone_s','zone_e','zone_w'][(i-1)%4],enrolled_at='2026-06-10T00:00:00Z',first_activated_at=stamp(activation),current_build_id=build_at(i,instant(SNAPSHOT)-timedelta(seconds=1)),telemetry_consent=0 if i==34 else 1,is_lab_unit=1 if i>=35 else 0,business_timezone='UTC',default_locale='en-US' if i%6==0 else 'zh-CN',retired_at='2026-08-31T00:00:00Z' if i==33 else None,identity_policy='synthetic_only')
    for key,name,domain,kind,network,seat in CAPABILITIES:
        data.add('voice_capability',capability_id='SC_'+key,capability_name=name,domain_code=domain,execution_kind=kind,requires_network=int(network),supports_context=1,supports_cancel=1,supports_clarification=1,latency_budget_ms=3000,seat_scope=seat,capability_state='active',scope_note='仅用于从零合成语音链路日志，不连接真实车辆、内容或服务。')
    for key,cap,name,action,slot,kind,unit,rule,zh,en in INTENTS:
        data.add('intent_catalog',intent_id='SI_'+key,capability_id='SC_'+cap,intent_name=name,action_name=action,required_slot_names=slot,optional_slot_names='',slot_validation_rule=rule,may_use_context=1,requires_effect_receipt=0 if action=='none' else 1,confirmation_mode='clarify_missing' if slot else 'none',intent_state='active',example_command=zh)
    for component in ['asr','nlu']:
        for endpoint in ['edge','cloud']:
            for locale in ['zh-CN','en-US']:
                for revision in ['a','b']:
                    data.add('recognizer_model',recognizer_id=f'SR_{component}_{endpoint}_{locale}_{revision}',recognizer_name=f'合成{component}配置{endpoint}-{locale}-{revision}',component=component,endpoint_kind=endpoint,model_revision='synthetic_'+revision,locale=locale,available_from='2026-06-01T00:00:00Z' if revision=='a' else '2026-08-15T00:00:00Z',timeout_ms=4000 if endpoint=='cloud' else 2500,supports_streaming=1 if component=='asr' else 0,supports_context_bias=1,training_origin='synthetic_profile_only')
    for i,preference in enumerate(['adaptive','cloud_preferred','edge_only'],1):
        data.add('runtime_policy',policy_id=f'SP{i}',policy_name=f'合成策略{i}',valid_from='2026-06-01T00:00:00Z',endpoint_preference=preference,asr_max_attempts=3,nlu_max_attempts=3,action_max_attempts=3,clarification_max_turns=3,turn_timeout_ms=18000,allow_barge_in=1,allow_context_carry=1,late_response_policy='accept_if_pending',cloud_rtt_threshold_ms=500,fallback_policy='none' if preference=='edge_only' else 'edge_fallback',deduplicate_actions=1)

def error(data,session,turn_id,stage,record_id,anchor,offset,code,recovery='none',state='not_started'):
    data.add('error_event',error_id=data.id('ER'),session_id=session['session_id'],turn_id=turn_id,stage=stage,related_record_id=record_id,occurred_at=stamp(anchor,offset),error_code=code,severity='warning' if state=='succeeded' else 'error',retryable=1 if recovery in ['retry','edge_fallback','query_receipt'] else 0,recovery_action=recovery,recovery_state=state,detail_text='从零构造的链路状态观测；该分类不证明实际故障根因。',received_at=received(anchor,offset))

def make_turn(data,session,vid,seq,case,parent=None,start_in_session=5000,barge_at=None):
    data.turn_count+=1;number=data.turn_count;turn_id=data.id('TR');anchor=instant(session['started_at'])+timedelta(milliseconds=start_in_session)
    locale=session['locale'];english=locale=='en-US';rev='b' if session['build_id'] in ['SB3','SB4'] else 'a'
    chosen=INTENTS[(number+vid)%7];parent_id=parent['turn_id'] if parent else None
    if case in ['clarify','context_fill','context_delta','rejected','mis_asr'] or barge_at is not None:chosen=INTENTS[0]
    if case=='cancel':chosen=INTENTS[7]
    if case=='mis_intent':chosen=INTENTS[1]
    key,cap,name,action,slot,kind,unit,rule,zh,en=chosen
    input_text=en if english else zh;value={'TEMP':'22','MEDIA':'Synthetic Track A' if english else '合成音轨甲','NAV':'Synthetic Place A' if english else '演示地点甲','RANGE':str(180+(vid%10)*5),'VOLUME':'40','HELP':'Synthetic help shown' if english else '已显示合成帮助','CONTACT':'Synthetic Contact A' if english else '演示联系人甲','CANCEL':None}[key]
    if case=='clarify':input_text='Set temperature' if english else '调整温度';value=None
    if case=='context_fill':input_text='22 degrees' if english else '22度';value='22'
    if case=='context_delta':input_text='A little lower' if english else '再调低一点';value=str(int(parent['effect_value'])-1)
    if case=='rejected':input_text='Set temperature to 35 degrees' if english else '把温度设为35度';value='35'
    if case=='no_speech':input_text=None
    input_ms=1000+(number%5)*120 if input_text else 1500
    labeled_text=input_text if input_text is not None and number%5!=0 else None
    labeled_intent='SI_'+key if input_text is not None and number%4!=0 else None
    label_origin='synthetic_authored' if labeled_text is not None or labeled_intent is not None else 'none'
    final_outcome='completed';response=None;first_audio=None;last_result=None;route_id=None;effect_value=value
    selected_hyp=None;nlu_id=None;actual_intent='SI_'+key;route_ready_offset=None;action_submitted_offset=None
    # 输入片段为人工模拟，不生成或引用任何音频。
    boundaries=[0,input_ms//3,2*input_ms//3,input_ms]
    for n in range(3):
        kind_segment='silence' if case=='no_speech' else ('silence' if n==1 else 'speech')
        data.add('frontend_segment',segment_id=data.id('FE'),turn_id=turn_id,segment_no=n+1,segment_kind=kind_segment,start_offset_ms=boundaries[n],end_offset_ms=boundaries[n+1],duration_ms=boundaries[n+1]-boundaries[n],speech_detected=0 if kind_segment=='silence' else 1,endpoint_reason='input_end' if n==2 else 'speech_end',clipped_ms=0,feature_frame_count=(boundaries[n+1]-boundaries[n])//10,noise_bucket=['quiet','moderate','noisy'][number%3],received_at=received(anchor,boundaries[n+1]))
    cursor=input_ms+80
    network_offline=(number%9==0)
    data.add('network_observation',network_id=data.id('NW'),session_id=session['session_id'],turn_id=turn_id,observed_at=stamp(anchor,100),transport='none' if network_offline else ('wifi' if vid%2 else 'cellular'),reachability='offline' if network_offline else ('degraded' if number%11==0 else 'online'),rtt_ms=None if network_offline else 30+(number%9)*17,loss_permille=None if network_offline else (number%5)*7,signal_bucket='not_applicable' if network_offline else ['good','fair','weak'][number%3],endpoint_scope='voice_cloud',network_label='SYN_NETWORK_'+str(vid%4),received_at=received(anchor,100))
    if case=='no_speech':
        final_outcome='no_speech';cursor=input_ms+500
    else:
        endpoint='edge' if session['policy_id']=='SP3' or network_offline else 'cloud'
        attempts=[]
        if case=='asr_retry':attempts=[('cloud','timeout',4000,'none'),('edge','succeeded',750,'cloud_timeout')]
        elif case=='asr_failed':attempts=[(endpoint,'failed',1100,'none')]
        else:attempts=[(endpoint,'succeeded',550+(number%6)*90,'network_unavailable' if network_offline and session['policy_id']!='SP3' else 'none')]
        for attempt_no,(endpoint,outcome,wall,fallback) in enumerate(attempts,1):
            aid=data.id('AS');start=cursor;finish=start+wall
            data.add('asr_attempt',asr_attempt_id=aid,turn_id=turn_id,attempt_no=attempt_no,recognizer_id=f'SR_asr_{endpoint}_{locale}_{rev}',endpoint_kind=endpoint,start_offset_ms=start,finish_offset_ms=finish,wall_ms=wall,queued_ms=min(50,wall),outcome=outcome,fallback_reason=fallback,timeout_ms=4000 if endpoint=='cloud' else 2500,is_streaming=1,partial_result_count=2 if outcome=='succeeded' else 0,error_code=None if outcome=='succeeded' else 'SYN_ASR_'+outcome.upper(),received_at=received(anchor,finish))
            if outcome!='succeeded':error(data,session,turn_id,'asr',aid,anchor,finish,'SYN_ASR_'+outcome.upper(),'edge_fallback' if case=='asr_retry' else 'none','succeeded' if case=='asr_retry' else 'not_started')
            if outcome=='succeeded':
                adopted=input_text
                if case=='mis_asr':adopted='Set temperature to 20 degrees' if english else '把温度设为20度';effect_value='20'
                selected_rank=2 if number%7==0 else 1
                for rank in [1,2,3]:
                    hyp=data.id('HY');hyp_text=adopted if rank==selected_rank else (('Synthetic alternative '+str(rank)) if english else ('合成候选'+str(rank)))
                    data.add('asr_hypothesis',hypothesis_id=hyp,asr_attempt_id=aid,turn_id=turn_id,candidate_rank=rank,hypothesis_text=hyp_text,normalized_text=normalize(hyp_text),confidence_permille=970-rank*85,is_final=1,selected_for_nlu=int(rank==selected_rank),selection_reason=('context_bias' if selected_rank==2 else ('fallback' if fallback!='none' else 'rank')) if rank==selected_rank else 'not_selected',locale=locale,received_at=received(anchor,finish+20))
                    if rank==selected_rank:selected_hyp=hyp
            cursor=finish+60
        if selected_hyp is None:final_outcome='failed';response='Please repeat the command.' if english else '请再说一遍。'
        else:
            nlu_attempts=['ambiguous','succeeded'] if case=='nlu_retry' else ['succeeded']
            if case=='mis_intent':actual_intent='SI_NAV';action='set_destination';slot='destination';kind='text';unit=None;effect_value='Synthetic Place A' if english else '演示地点甲';cap='NAVIGATION'
            for n,outcome in enumerate(nlu_attempts,1):
                nid=data.id('NL');start=cursor;finish=start+220+(number%4)*30;selected=n==len(nlu_attempts)
                missing=1 if selected and case=='clarify' else 0
                data.add('nlu_attempt',nlu_attempt_id=nid,turn_id=turn_id,hypothesis_id=selected_hyp,attempt_no=n,recognizer_id=f'SR_nlu_{endpoint}_{locale}_{rev}',endpoint_kind=endpoint,start_offset_ms=start,finish_offset_ms=finish,wall_ms=finish-start,queued_ms=20,outcome=outcome,predicted_intent_id=actual_intent if outcome=='succeeded' else None,confidence_permille=870 if outcome=='succeeded' else None,missing_required_slots=missing,context_used=int(parent is not None),selected_for_dialogue=int(selected),error_code=None if outcome=='succeeded' else 'SYN_NLU_AMBIGUOUS',received_at=received(anchor,finish))
                if outcome=='ambiguous':error(data,session,turn_id,'nlu',nid,anchor,finish,'SYN_NLU_AMBIGUOUS','retry','succeeded')
                if outcome=='succeeded' and slot:
                    source='missing' if case=='clarify' else ('context' if case=='context_delta' else 'utterance')
                    raw=None if case=='clarify' else (input_text if case in ['context_fill','context_delta'] else str(effect_value))
                    data.add('slot_value',slot_id=data.id('SL'),nlu_attempt_id=nid,turn_id=turn_id,slot_name=slot,raw_value=raw,normalized_value=None if case=='clarify' else str(effect_value),value_kind=kind,value_unit=unit,resolution_source=source,confidence_permille=None if case=='clarify' else 900,is_required=1,is_resolved=0 if case=='clarify' else 1,validation_state='missing' if case=='clarify' else ('out_of_range' if case=='rejected' else 'valid'),source_turn_id=parent_id if source=='context' else None,received_at=received(anchor,finish+10))
                if selected:nlu_id=nid
                cursor=finish+40
            if case=='clarify':final_outcome='clarification_pending';response='What target temperature do you want?' if english else '请告诉我目标温度。'
            elif case=='cancel':final_outcome='cancelled';response='The pending request is cancelled.' if english else '已取消刚才待定的请求。'
            elif case=='rejected' or (data.get('voice_capability','SC_'+cap)['seat_scope']=='driver' and session['seat_zone']!='driver') or (data.get('voice_capability','SC_'+cap)['seat_scope']=='front' and session['seat_zone']=='rear'):
                final_outcome='rejected';response=('That temperature is outside the synthetic range.' if english else '该温度超出合成规则允许范围。') if case=='rejected' else ('This seat is outside the synthetic capability scope.' if english else '该音区不在本合成能力允许范围内。')
                rejected_route=data.id('RT');start=cursor;cursor+=70
                data.add('skill_route',route_id=rejected_route,turn_id=turn_id,nlu_attempt_id=nlu_id,attempt_no=1,capability_id='SC_'+cap,intent_id=actual_intent,skill_code='SYN_SKILL_'+cap,route_kind='cloud' if cap in ['NAVIGATION','COMMUNICATION'] else 'local',start_offset_ms=start,finish_offset_ms=cursor,wall_ms=70,outcome='rejected',is_final_route=0,reject_reason='policy',received_at=received(anchor,cursor))
                error(data,session,turn_id,'route',rejected_route,anchor,cursor,'SYN_ROUTE_POLICY')
            else:
                rid=data.id('RT');start=cursor;finish=start+70;route_id=rid
                data.add('skill_route',route_id=rid,turn_id=turn_id,nlu_attempt_id=nlu_id,attempt_no=1,capability_id='SC_'+cap,intent_id=actual_intent,skill_code='SYN_SKILL_'+cap,route_kind='cloud' if cap in ['NAVIGATION','COMMUNICATION'] else 'local',start_offset_ms=start,finish_offset_ms=finish,wall_ms=70,outcome='selected',is_final_route=1,reject_reason='none',received_at=received(anchor,finish))
                route_ready_offset=finish;cursor=finish+30;op='OP_'+turn_id
                if network_offline and cap in ['NAVIGATION','COMMUNICATION'] and case!='action_unknown':
                    data.add('network_observation',network_id=data.id('NW'),session_id=session['session_id'],turn_id=turn_id,observed_at=stamp(anchor,cursor-10),transport='wifi',reachability='online',rtt_ms=45,loss_permille=0,signal_bucket='good',endpoint_scope='voice_cloud',network_label='SYN_NETWORK_RECOVERED',received_at=received(anchor,cursor-10))
                action_attempts=2 if case=='action_retry' else 1
                for attempt in range(1,action_attempts+1):
                    invocation=data.id('AI');submit=cursor;action_submitted_offset=submit if attempt==1 else action_submitted_offset;unknown=case=='action_unknown' or (case=='action_retry' and attempt==1)
                    return_state='unknown' if unknown else ('failed' if case=='action_failed' else 'succeeded')
                    elapsed=4000 if unknown else 650+(number%3)*50;observed=submit+elapsed
                    data.add('action_invocation',invocation_id=invocation,turn_id=turn_id,route_id=route_id,operation_key=op,attempt_no=attempt,action_name=action,argument_name=slot or 'none',argument_value=str(effect_value) if slot else None,argument_unit=unit if slot else None,submitted_offset_ms=submit,deadline_offset_ms=submit+4000,transport_kind='simulated_cloud' if cap in ['NAVIGATION','COMMUNICATION'] else 'local_bus',acceptance_state='unknown' if unknown else 'accepted',idempotency_supported=1,timeout_ms=4000,received_at=received(anchor,submit))
                    result=data.id('AR');confirmed=return_state=='succeeded'
                    # 本地效果已经观察到，但少量回执日志独立积压；不能据父轮次及时推断每条子记录可见。
                    receipt_received='2026-10-05T00:00:00Z' if anchor.month==9 and anchor.day>=27 and vid%3==0 and seq==1 and confirmed else received(anchor,observed)
                    data.add('action_result',result_id=result,invocation_id=invocation,turn_id=turn_id,operation_key=op,observation_no=1,observed_offset_ms=observed,return_state=return_state,effect_state='confirmed' if confirmed else ('unknown' if unknown else 'not_observed'),effect_instance_id='FX_'+turn_id if confirmed else None,result_value=str(effect_value) if confirmed else None,result_unit=unit if confirmed else None,error_code='SYN_ACTION_UNKNOWN' if unknown else ('SYN_ACTION_FAILED' if return_state=='failed' else None),replayed_receipt=1 if case=='action_retry' and attempt==2 else 0,server_elapsed_ms=None if unknown else elapsed,received_at=receipt_received)
                    if unknown or return_state=='failed':error(data,session,turn_id,'action',invocation,anchor,observed,'SYN_ACTION_'+return_state.upper(),'query_receipt' if case=='action_retry' else 'none','succeeded' if case=='action_retry' else ('unknown' if unknown else 'failed'))
                    last_result=result;cursor=observed+50
                    if case=='action_retry' and attempt==2:
                        repeated=data.id('AR')
                        data.add('action_result',result_id=repeated,invocation_id=invocation,turn_id=turn_id,operation_key=op,observation_no=2,observed_offset_ms=observed+30,return_state='succeeded',effect_state='confirmed',effect_instance_id='FX_'+turn_id,result_value=str(effect_value),result_unit=unit,error_code=None,replayed_receipt=1,server_elapsed_ms=elapsed,received_at=received(anchor,observed+30))
                        last_result=repeated
                if case=='action_unknown':final_outcome='unknown';response='The effect is not confirmed yet.' if english else '暂时无法确认是否已经生效。'
                elif case=='action_failed':final_outcome='failed';response='The synthetic action failed.' if english else '合成动作返回失败，未确认生效。'
                else:response=(f'Synthetic action completed: {effect_value}.' if english else f'合成动作已完成：{effect_value}。')
    terminal=cursor+80
    # 对话状态记录保留历史事实，不因后续轮次改变旧turn的终态。
    transitions=[('listening','understanding','parsed',input_ms)] if case!='no_speech' else [('listening','no_speech','silence',terminal)]
    if case!='no_speech':
        dest={'completed':'completed','clarification_pending':'awaiting_slot','cancelled':'cancelled','failed':'failed','unknown':'unknown','rejected':'rejected'}[final_outcome]
        if route_id:transitions += [('understanding','ready','slot_filled' if parent else 'parsed',route_ready_offset),('ready','executing','parsed',action_submitted_offset),('executing',dest,'action_receipt' if final_outcome=='completed' else 'timeout',terminal)]
        else:transitions.append(('understanding',dest,'missing_slot' if case=='clarify' else ('user_cancel' if case=='cancel' else ('policy_rejected' if case=='rejected' else 'timeout')),terminal))
    for n,(before,after,reason,offset) in enumerate(transitions,1):
        data.add('dialogue_transition',transition_id=data.id('DT'),turn_id=turn_id,transition_no=n,from_state=before,to_state=after,reason=reason,offset_ms=offset,context_turn_id=parent_id,clarification_slot=slot if case=='clarify' and after=='awaiting_slot' else None,clarification_text=response if case=='clarify' and after=='awaiting_slot' else None,user_decision='cancelled' if case=='cancel' else ('unanswered' if case=='clarify' else ('provided' if parent else 'not_required')),context_preserved=0 if case=='cancel' else 1,received_at=received(anchor,offset))
    playback=None;last_offset=terminal
    if response is not None:
        tid=data.id('TT');tts_start=terminal+20;wall=380+(number%3)*40;tts_finish=tts_start+wall;tts_failed=case=='tts_failed';audio_ms=9000 if barge_at is not None else 1800+(len(response)%20)*80
        data.add('tts_request',tts_id=tid,turn_id=turn_id,action_result_id=last_result,attempt_no=1,response_kind='clarification' if case=='clarify' else ('error' if final_outcome in ['failed','rejected'] else ('status' if final_outcome in ['cancelled','unknown'] else 'answer')),response_text=response,voice_profile='synthetic_voice_b' if english else 'synthetic_voice_a',endpoint_kind='edge',start_offset_ms=tts_start,first_chunk_offset_ms=None if tts_failed else tts_start+160,finish_offset_ms=tts_finish,wall_ms=wall,simulated_audio_ms=0 if tts_failed else audio_ms,outcome='failed' if tts_failed else 'succeeded',error_code='SYN_TTS_FAILED' if tts_failed else None,received_at=received(anchor,tts_finish))
        last_offset=tts_finish
        if tts_failed:error(data,session,turn_id,'tts',tid,anchor,tts_finish,'SYN_TTS_FAILED')
        else:
            play_start=tts_start+220;played=audio_ms;buffer=120 if number%17==0 else 0
            if barge_at is not None:
                played=barge_at-start_in_session-play_start+120
                assert 0<played<audio_ms,(played,barge_at,start_in_session,play_start)
                buffer=0
            # 一次TTS可以连续播出多个片段；分段不增加合成请求、音频总时长或用户轮次。
            segment_count=3 if barge_at is None and number%29==0 else 1
            segment_start=play_start
            for segment_no in range(1,segment_count+1):
                planned=audio_ms//segment_count if segment_no<segment_count else audio_ms-(audio_ms//segment_count)*(segment_count-1)
                segment_played=planned if segment_count>1 else played
                segment_buffer=buffer if segment_no==segment_count else 0
                finish=segment_start+segment_played+segment_buffer
                playback=data.add('playback_segment',playback_id=data.id('PB'),tts_id=tid,turn_id=turn_id,segment_no=segment_no,output_zone='front',start_offset_ms=segment_start,finish_offset_ms=finish,planned_ms=planned,played_ms=segment_played,buffering_ms=segment_buffer,end_reason='barge_in' if barge_at is not None else 'completed',completion_state='interrupted' if barge_at is not None else 'complete',volume_pct=40+(vid%3)*5,received_at=received(anchor,finish))
                segment_start=finish
            first_audio=play_start-input_ms;last_offset=max(last_offset,playback['finish_offset_ms'])
    late=anchor.strftime('%m-%d') in ['09-29','09-30'] and vid%8==1 and seq==2
    quality_state='invalid' if number%127==0 else 'valid'
    data.add('voice_turn',turn_id=turn_id,session_id=session['session_id'],turn_no=seq,parent_turn_id=parent_id,started_at=stamp(anchor),finished_at=stamp(anchor,terminal),input_kind='silence' if case=='no_speech' else ('cancel' if case=='cancel' else ('follow_up' if parent else 'command')),reference_text=labeled_text,reference_intent_id=labeled_intent,label_origin=label_origin,locale=locale,seat_zone=session['seat_zone'],input_ms=input_ms,terminal_offset_ms=terminal,task_latency_ms=terminal-input_ms,first_audio_latency_ms=first_audio,final_outcome=final_outcome,final_response_text=response,received_at='2026-10-05T00:00:00Z' if late else received(anchor,last_offset+500),quality_state=quality_state)
    if number%3!=0:
        rating='negative' if case in ['mis_asr','mis_intent','action_unknown','action_failed','tts_failed','asr_failed'] else ('neutral' if case in ['cancel','clarify','no_speech'] or barge_at is not None else 'positive')
        reason='wrong_action' if case in ['mis_asr','mis_intent'] else ('no_response' if case in ['tts_failed','asr_failed'] else ('stopped' if case=='cancel' or barge_at is not None else ('unclear' if rating!='positive' else 'correct')))
        data.add('turn_feedback',feedback_id=data.id('FB'),turn_id=turn_id,collected_at=stamp(anchor,last_offset+2000),rating=rating,reason_category=reason,feedback_source='synthetic_authored',is_explicit=1,comment_text=None,rating_scale_revision=1,received_at=received(anchor,last_offset+2000))
    return {'turn_id':turn_id,'effect_value':effect_value,'anchor':anchor,'playback':playback,'last_offset':last_offset,'terminal':terminal}

def build_rows():
    data=Data();dimensions(data);start=instant(SPEC['time']['activity_start_inclusive']);session_number=0
    cases=['direct','asr_retry','nlu_retry','rejected','no_speech','asr_failed','action_unknown','action_failed','tts_failed','mis_asr','mis_intent','action_retry']
    for day in range(92):
        date=start+timedelta(days=day)
        for vid in range(1,37):
            vehicle=data.get('vehicle',f'SV{vid:03d}')
            if not vehicle['telemetry_consent'] or (vehicle['retired_at'] and date>=instant(vehicle['retired_at'])) or (vid==32 and date.month==9):continue
            if (day+vid)%4!=0:continue
            session_number+=1;sid=data.id('VS');night=date.day==31 or (date.month==9 and date.day==30)
            anchor=date+timedelta(hours=23,minutes=59,seconds=10) if night and vid%3==0 else date+timedelta(hours=6+vid%12,minutes=vid%6*5)
            mode=session_number%15;entry=['wake_word','button','continuous'][session_number%3];false_wake=session_number%41==0
            if false_wake:entry='wake_word'
            policy='SP1' if mode in [3,4,11] or false_wake else f'SP{1+session_number%3}'
            # 需要云超时回退的合成路径不能配edge_only策略。
            if cases[mode%12]=='asr_retry':policy='SP1'
            session=data.add('voice_session',session_id=sid,vehicle_id=vehicle['vehicle_id'],build_id=build_at(vid,anchor),policy_id=policy,started_at=stamp(anchor),ended_at=stamp(anchor,100000),duration_ms=100000,entry_kind=entry,locale=vehicle['default_locale'],seat_zone='driver' if mode==11 else ['driver','front_passenger','rear'][vid%3],motion_state='moving' if vid%2 else 'parked',network_at_start='offline' if session_number%9==0 else 'online',end_reason='idle',is_complete=0 if session_number%43==0 else 1,received_at=received(anchor,100000),quality_state='invalid' if session_number%37==0 else 'valid')
            if entry=='wake_word':
                labeled=0 if false_wake else (None if session_number%5==0 else 1)
                data.add('wakeup_attempt',wakeup_id=data.id('WK'),vehicle_id=vehicle['vehicle_id'],build_id=session['build_id'],session_id=sid,started_at=stamp(anchor),trigger_kind='wake_word',seat_zone=session['seat_zone'],candidate_detected=1,accepted=1,reject_reason='none',confidence_permille=730+session_number%200,reference_is_intended=labeled,label_origin='none' if labeled is None else 'synthetic_authored',decision_ms=120+session_number%120,received_at=received(anchor,500))
            if session_number%5==0:
                ref=1 if session_number%10==0 else 0;detected=0 if ref else 1
                data.add('wakeup_attempt',wakeup_id=data.id('WK'),vehicle_id=vehicle['vehicle_id'],build_id=session['build_id'],session_id=None,started_at=stamp(anchor-timedelta(minutes=5)),trigger_kind='wake_word',seat_zone=session['seat_zone'],candidate_detected=detected,accepted=0,reject_reason='not_detected' if not detected else 'false_trigger',confidence_permille=330 if detected else None,reference_is_intended=ref,label_origin='synthetic_authored',decision_ms=220,received_at=received(anchor-timedelta(minutes=5),500))
            if false_wake:make_turn(data,session,vid,1,'no_speech');continue
            if mode in [3,4]:
                first=make_turn(data,session,vid,1,'clarify');make_turn(data,session,vid,2,'context_fill' if mode==3 else 'cancel',first,45000)
            elif mode==11:
                first=make_turn(data,session,vid,1,'direct',start_in_session=5000,barge_at=12000)
                # 后续相对温度指令沿已确认效果补槽，保留原轮次，不因打断撤销旧动作。
                second=make_turn(data,session,vid,2,'context_delta',first,start_in_session=12000)
                context_policy='carry'
                playback=first['playback'];assert playback
                data.add('interruption_event',interruption_id=data.id('BI'),session_id=sid,interrupted_turn_id=first['turn_id'],playback_id=playback['playback_id'],triggering_turn_id=second['turn_id'],occurred_at=stamp(anchor,12000),trigger_kind='new_utterance',offset_in_playback_ms=12000-5000-playback['start_offset_ms'],stop_latency_ms=120,stop_confirmed=1,action_was_already_confirmed=1,context_policy=context_policy,received_at=received(anchor,12120))
            else:
                case1=cases[mode%12];case2=cases[(mode+5)%12]
                if case1=='asr_retry' or case2=='asr_retry':session['policy_id']='SP1'
                make_turn(data,session,vid,1,case1);make_turn(data,session,vid,2,case2,start_in_session=45000)
    return data.rows

def seed_sql(rows):
    statements=['-- 生成器从零构造的语音交互日志；不要将种子作为模型知识。','PRAGMA foreign_keys = ON;','BEGIN;']
    for table in SPEC['tables']:
        name=table['name'];columns=[c['name'] for c in table['columns']]
        for row in rows[name]:statements.append('INSERT INTO '+name+' VALUES ('+', '.join(literal(row[key]) for key in columns)+');')
    statements.append('COMMIT;')
    return '\n'.join(statements)+'\n'

# 分段标记供语义目录与平台定位每个真实加工节点；验证答案不参与生成。
def etl_sql():
    cutoff=literal(SNAPSHOT)
    valid=f"""valid_sessions AS (
  SELECT s.* FROM syn_voice_session s JOIN syn_vehicle v ON v.vehicle_id=s.vehicle_id
  WHERE v.telemetry_consent=1 AND v.is_lab_unit=0 AND s.is_complete=1 AND s.quality_state='valid'
    AND s.started_at < {cutoff} AND s.ended_at < {cutoff} AND s.received_at < {cutoff}
), valid_turns AS (
  SELECT t.*,s.vehicle_id,s.build_id FROM syn_voice_turn t JOIN valid_sessions s ON s.session_id=t.session_id
  WHERE t.quality_state='valid' AND t.started_at < {cutoff} AND t.finished_at < {cutoff} AND t.received_at < {cutoff}
)"""
    norm='t.reference_text'
    for ch in ' \u3000\t\r\n。！？!?，,．.':
        character = f'char({ord(ch)})' if ord(ch) < 32 else literal(ch)
        norm = 'replace(' + norm + ',' + character + ",'')"
    norm='lower('+norm+')'
    first=f"""-- target: syn_daily_voice_experience
DELETE FROM syn_daily_voice_experience;
INSERT INTO syn_daily_voice_experience
WITH {valid},
selected_asr AS (SELECT turn_id,normalized_text FROM syn_asr_hypothesis WHERE selected_for_nlu=1 AND is_final=1 AND received_at < {cutoff}),
selected_nlu AS (SELECT turn_id,predicted_intent_id FROM syn_nlu_attempt WHERE selected_for_dialogue=1 AND received_at < {cutoff}),
feedback AS (SELECT turn_id,COUNT(*) n,SUM(rating='positive') positive FROM syn_turn_feedback WHERE quality_state='valid' AND is_explicit=1 AND collected_at < {cutoff} AND received_at < {cutoff} GROUP BY turn_id),
interruptions AS (SELECT interrupted_turn_id turn_id,COUNT(*) n FROM syn_interruption_event WHERE occurred_at < {cutoff} AND received_at < {cutoff} GROUP BY interrupted_turn_id),
turns AS (
 SELECT substr(t.started_at,1,10) d,t.vehicle_id,t.build_id,
 COUNT(*) turn_count,SUM(t.final_outcome NOT IN ('cancelled','no_speech')) eligible,
 SUM(t.final_outcome='completed') completed,SUM(t.final_outcome='clarification_pending') clarification,
 SUM(t.final_outcome='failed') failed,SUM(t.final_outcome='unknown') unknown_count,
 SUM(t.final_outcome='cancelled') cancelled,SUM(t.final_outcome='no_speech') no_speech,SUM(t.final_outcome='rejected') rejected,
 SUM(CASE WHEN t.final_outcome='completed' THEN t.task_latency_ms ELSE 0 END) latency_sum,
 SUM(t.final_outcome='completed') latency_n,COALESCE(SUM(t.first_audio_latency_ms),0) audio_sum,COUNT(t.first_audio_latency_ms) audio_n,
 SUM(t.final_outcome NOT IN ('cancelled','no_speech') AND t.reference_text IS NOT NULL) asr_labels,
 SUM(CASE WHEN t.final_outcome NOT IN ('cancelled','no_speech') AND t.reference_text IS NOT NULL AND a.normalized_text={norm} THEN 1 ELSE 0 END) asr_matches,
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
 WHERE v.telemetry_consent=1 AND v.is_lab_unit=0 AND w.quality_state='valid' AND w.started_at < {cutoff} AND w.received_at < {cutoff}
 GROUP BY d,w.vehicle_id,w.build_id
), keys AS (SELECT d,vehicle_id,build_id FROM turns UNION SELECT d,vehicle_id,build_id FROM sessions UNION SELECT d,vehicle_id,build_id FROM wakes)
SELECT k.d,k.vehicle_id,k.build_id,COALESCE(s.n,0),COALESCE(w.n,0),COALESCE(w.accepted,0),COALESCE(w.labeled,0),COALESCE(w.false_accept,0),
 COALESCE(t.turn_count,0),COALESCE(t.eligible,0),COALESCE(t.completed,0),COALESCE(t.clarification,0),COALESCE(t.failed,0),COALESCE(t.unknown_count,0),COALESCE(t.cancelled,0),COALESCE(t.no_speech,0),COALESCE(t.rejected,0),
 COALESCE(t.latency_sum,0),COALESCE(t.latency_n,0),COALESCE(t.audio_sum,0),COALESCE(t.audio_n,0),COALESCE(t.asr_labels,0),COALESCE(t.asr_matches,0),COALESCE(t.intent_labels,0),COALESCE(t.intent_matches,0),COALESCE(t.feedback_n,0),COALESCE(t.positive_n,0),COALESCE(t.interruptions,0),{cutoff}
FROM keys k LEFT JOIN turns t ON t.d=k.d AND t.vehicle_id=k.vehicle_id AND t.build_id=k.build_id
LEFT JOIN sessions s ON s.d=k.d AND s.vehicle_id=k.vehicle_id AND s.build_id=k.build_id
LEFT JOIN wakes w ON w.d=k.d AND w.vehicle_id=k.vehicle_id AND w.build_id=k.build_id;
-- end-target"""
    second=f"""-- target: syn_daily_stage_latency
DELETE FROM syn_daily_stage_latency;
INSERT INTO syn_daily_stage_latency
WITH {valid}, latest_result AS (
 SELECT r.*,ROW_NUMBER() OVER(PARTITION BY invocation_id ORDER BY observation_no DESC) rn
 FROM syn_action_result r WHERE r.received_at < {cutoff}
), attempts AS (
 SELECT a.turn_id,'asr' stage,a.endpoint_kind,a.outcome,a.wall_ms latency,a.queued_ms queued FROM syn_asr_attempt a WHERE a.received_at < {cutoff}
 UNION ALL SELECT a.turn_id,'nlu',a.endpoint_kind,a.outcome,a.wall_ms,a.queued_ms FROM syn_nlu_attempt a WHERE a.received_at < {cutoff}
 UNION ALL SELECT a.turn_id,'route',CASE WHEN a.route_kind='cloud' THEN 'cloud' ELSE 'edge' END,CASE WHEN a.outcome='selected' THEN 'succeeded' ELSE a.outcome END,a.wall_ms,0 FROM syn_skill_route a WHERE a.received_at < {cutoff}
 UNION ALL SELECT a.turn_id,'action',CASE WHEN a.transport_kind='simulated_cloud' THEN 'cloud' ELSE 'edge' END,
 CASE WHEN a.acceptance_state='rejected' THEN 'rejected' ELSE COALESCE(r.return_state,'unknown') END,
 CASE WHEN r.return_state IN ('succeeded','failed','cancelled') THEN r.observed_offset_ms-a.submitted_offset_ms ELSE NULL END,0
 FROM syn_action_invocation a LEFT JOIN latest_result r ON r.invocation_id=a.invocation_id AND r.rn=1 WHERE a.received_at < {cutoff}
 UNION ALL SELECT a.turn_id,'tts',a.endpoint_kind,a.outcome,a.wall_ms,0 FROM syn_tts_request a WHERE a.received_at < {cutoff}
)
SELECT substr(t.started_at,1,10),a.stage,a.endpoint_kind,t.build_id,COUNT(*),COUNT(DISTINCT a.turn_id),
 SUM(a.outcome='succeeded'),SUM(a.outcome='failed'),SUM(a.outcome='timeout'),SUM(a.outcome='cancelled'),SUM(a.outcome='unknown'),SUM(a.outcome='ambiguous'),SUM(a.outcome='rejected'),
 COALESCE(SUM(a.latency),0),COUNT(a.latency),MIN(a.latency),MAX(a.latency),SUM(a.queued),{cutoff}
FROM attempts a JOIN valid_turns t ON t.turn_id=a.turn_id GROUP BY substr(t.started_at,1,10),a.stage,a.endpoint_kind,t.build_id;
-- end-target"""
    third=f"""-- target: syn_daily_intent_outcome
DELETE FROM syn_daily_intent_outcome;
INSERT INTO syn_daily_intent_outcome
WITH {valid}, selected AS (
 SELECT n.turn_id,n.predicted_intent_id intent_id FROM syn_nlu_attempt n WHERE n.selected_for_dialogue=1 AND n.predicted_intent_id IS NOT NULL AND n.received_at < {cutoff}
), actions AS (
 SELECT a.turn_id,COUNT(DISTINCT a.operation_key) n,COUNT(DISTINCT CASE WHEN r.effect_state='confirmed' THEN a.operation_key ELSE NULL END) confirmed
 FROM syn_action_invocation a LEFT JOIN syn_action_result r ON r.operation_key=a.operation_key AND r.received_at < {cutoff}
 WHERE a.received_at < {cutoff} GROUP BY a.turn_id
), feedback AS (SELECT turn_id,COUNT(*) n,SUM(rating='positive') positive FROM syn_turn_feedback WHERE quality_state='valid' AND is_explicit=1 AND collected_at < {cutoff} AND received_at < {cutoff} GROUP BY turn_id)
SELECT substr(t.started_at,1,10),n.intent_id,i.capability_id,t.build_id,COUNT(*),
 SUM(t.final_outcome='completed'),SUM(t.final_outcome='clarification_pending'),SUM(t.final_outcome='rejected'),SUM(t.final_outcome='failed'),SUM(t.final_outcome='cancelled'),SUM(t.final_outcome='unknown'),SUM(t.final_outcome='no_speech'),
 SUM(COALESCE(a.n,0)),SUM(COALESCE(a.confirmed,0)),SUM(COALESCE(f.n,0)),SUM(COALESCE(f.positive,0)),{cutoff}
FROM valid_turns t JOIN selected n ON n.turn_id=t.turn_id JOIN syn_intent_catalog i ON i.intent_id=n.intent_id
LEFT JOIN actions a ON a.turn_id=t.turn_id LEFT JOIN feedback f ON f.turn_id=t.turn_id
GROUP BY substr(t.started_at,1,10),n.intent_id,i.capability_id,t.build_id;
-- end-target"""
    return '-- 仅从允许的合成事实派生；不读取evaluation。\nBEGIN;\n\n'+first+'\n\n'+second+'\n\n'+third+'\nCOMMIT;\n'

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--check',action='store_true');args=parser.parse_args()
    rows=build_rows();outputs={'schema.sql':schema_sql(),'seed.sql':seed_sql(rows),'etl.sql':etl_sql()}
    bad=[]
    for name,body in outputs.items():
        path=ROOT/name
        if args.check:
            if not path.exists() or path.read_text()!=body:bad.append(name)
        else:path.write_text(body)
    counts={name:len(values) for name,values in rows.items()}
    print(json.dumps({'reproducible':not bad,'different_files':bad,'tables':len(TABLES),'fields':sum(len(t['columns']) for t in SPEC['tables']),'seed_rows':sum(counts.values()),'seed_bytes':len(outputs['seed.sql'].encode()),'row_counts':counts},ensure_ascii=False))
    return bool(bad)
if __name__=='__main__':raise SystemExit(main())
