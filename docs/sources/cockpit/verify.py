#!/usr/bin/env python3
"""座舱资料的聚合验收：可复现生成、语义目录、数据约束与指标边界。"""
from __future__ import annotations
import json
from datetime import date, timedelta
from pathlib import Path
import re
import sqlite3
import subprocess
import sys

SOURCE=Path(__file__).resolve().parent
ROOT=SOURCE.parents[2]
COUNT_COLUMNS={'numerator','denominator','attempts','accepted_attempts','false_accepts','unintended_labeled_attempts',
               'labeled_attempts','matched_turns','attempted_turns','sample_count','logical_operations',
               'matched_operations','visible_records','matched_records','active_voice_vehicles','valid_voice_turns',
               'recovered_turns','successful_final_attempts','final_successful_candidates'}


def command(script,*args):
    completed=subprocess.run([sys.executable,str(SOURCE/script),*args],cwd=ROOT,capture_output=True,text=True)
    if completed.returncode:
        raise SystemExit(completed.stdout + completed.stderr)
    return json.loads(completed.stdout.strip().splitlines()[-1])


def metric_boundaries():
    catalog=json.loads((SOURCE/'semantic-catalog.json').read_text())
    metrics=[o for o in catalog['objects'] if o['kind']=='metric']
    assert len(metrics)==30
    db=sqlite3.connect(':memory:')
    for name in ('schema.sql','seed.sql','etl.sql'):db.executescript((SOURCE/name).read_text())
    executions=0;daily=[];checked=[]
    snapshot='2026-10-04T00:00:00Z'
    reference=json.loads((ROOT/'docs/dogfood/cockpit/reference/expected-results.json').read_text())['results']['first_vs_final_success']
    first_final=dict(zip(reference['columns'],reference['rows'][0]))
    overview=(SOURCE/'documents/overview.md').read_text()
    for metric in metrics:
        basis=next(e for e in metric['entries'] if e['path']=='time_basis')
        assert basis['source_facts']['quote'] in overview
        assert basis['source_facts']['quote'] in basis['effective_value']
        sql=next(e['effective_value'] for e in metric['entries'] if e['path']=='sql')
        for label,start,end in [('full_day','2026-09-01T00:00:00Z','2026-10-01T00:00:00Z'),
                                ('empty_day','2026-01-01T00:00:00Z','2026-02-01T00:00:00Z')]:
            cur=db.execute(sql,{'start':start,'end':end,'snapshot':snapshot});rows=cur.fetchall();executions+=1
            columns=[x[0] for x in cur.description]
            if label=='full_day' and metric['id'] in ('metric-asr_first_attempt_success_rate','metric-asr_final_attempt_success_rate'):
                prefix='first' if metric['id']=='metric-asr_first_attempt_success_rate' else 'final'
                assert len(rows)==1
                numerator,denominator,value=rows[0]
                assert (numerator,denominator)==(first_final[prefix+'_success'],first_final['turns'])
                assert round(value,6)==first_final[prefix+'_rate'],'复用原独立首末参考，不改旧key或数值'
            if label=='empty_day':
                for row in rows:
                    for column,value in zip(columns,row):
                        # 空分母计数为零、统计量无定义；按阶段分组的空集合本就没有行。
                        assert value==(0 if column in COUNT_COLUMNS else None),(metric['id'],column,value,'empty boundary')
        if re.search(r'\bFROM\s+syn_daily_',sql,re.I):
            daily.append(metric['id'])
            for start,end in [('2026-09-01T12:00:00Z','2026-09-02T12:00:00Z'),
                              ('2026-09-02T00:00:00Z','2026-09-01T00:00:00Z')]:
                rows=db.execute(sql,{'start':start,'end':end,'snapshot':snapshot}).fetchall();executions+=1
                assert rows==[],(metric['id'],'unsupported daily range must not look like precise result',rows)
        checked.append(metric['id'])
    assert len(daily)==12
    db.close()
    return {'metric_count':len(metrics),'sql_executions':executions,'whole_utc_day_only_metrics':daily,
            'checks':['known whole-day execution','empty counts zero/statistics NULL','daily half-day range refused','reversed daily range refused']}


def rule_sql_examples():
    text=(SOURCE/'documents/time-quality.md').read_text()
    snapshot_sql,measurement_sql,voice_counts_sql=re.findall(r'```sql\n(.*?)\n```',text,re.S)
    db=sqlite3.connect(':memory:')
    db.executescript('''
CREATE TABLE syn_vehicle(vehicle_id TEXT PRIMARY KEY,is_lab_unit INTEGER,telemetry_consent INTEGER);
CREATE TABLE syn_voice_session(session_id TEXT PRIMARY KEY,vehicle_id TEXT,started_at TEXT,ended_at TEXT,received_at TEXT,quality_state TEXT,is_complete INTEGER);
CREATE TABLE syn_voice_turn(turn_id TEXT PRIMARY KEY,session_id TEXT,started_at TEXT,finished_at TEXT,received_at TEXT,quality_state TEXT);
CREATE TABLE syn_tts_request(turn_id TEXT,received_at TEXT,finish_offset_ms INTEGER);
CREATE TABLE syn_daily_stage_latency(stage TEXT,snapshot_exclusive TEXT,turn_date TEXT,attempt_count INTEGER,latency_samples INTEGER,latency_sum_ms INTEGER);
INSERT INTO syn_vehicle VALUES('synthetic-vehicle',0,1);
INSERT INTO syn_voice_session VALUES('synthetic-session','synthetic-vehicle','2026-09-01T00:00:00Z','2026-09-01T00:01:00Z','2026-09-01T00:01:01Z','valid',1);
INSERT INTO syn_voice_turn VALUES('synthetic-turn','synthetic-session','2026-09-01T00:00:10Z','2026-09-01T00:00:12Z','2026-09-01T00:00:13Z','valid');
INSERT INTO syn_tts_request VALUES('synthetic-turn','2026-10-05T00:00:00Z',1000);
''')
    params={'start':'2026-09-01T00:00:00Z','end':'2026-10-01T00:00:00Z','snapshot':'2026-10-04T00:00:00Z','stage':'tts'}
    late=db.execute(snapshot_sql,params).fetchall()
    assert late==[(1,)],'晚到的唯一TTS不改变快照内无TTS判断'
    db.execute("UPDATE syn_tts_request SET received_at='2026-09-01T00:00:14Z'")
    visible=db.execute(snapshot_sql,params).fetchall()
    assert visible==[(0,)],'快照内可见TTS使同一轮次退出缺失集合'
    absent=db.execute(measurement_sql,params).fetchall()
    db.execute("INSERT INTO syn_daily_stage_latency VALUES('tts',?,'2026-09-01',0,0,0)",(params['snapshot'],))
    zero=db.execute(measurement_sql,params).fetchall()
    assert absent==[(0,0,None,None)]
    assert zero==[(1,0,0,None)],'有行全零与无行可区分，且无测量不能填0耗时'
    db.close()
    # 采用真实DDL、原合成维表与一条原本合法的sessionless wake，重放未修改ETL。
    seed=sqlite3.connect(':memory:');seed.row_factory=sqlite3.Row
    for name in ('schema.sql','seed.sql'):seed.executescript((SOURCE/name).read_text())
    wake=seed.execute('''SELECT w.* FROM syn_wakeup_attempt w JOIN syn_vehicle v ON v.vehicle_id=w.vehicle_id
        WHERE w.session_id IS NULL AND w.accepted=0 AND w.quality_state='valid'
          AND v.telemetry_consent=1 AND v.is_lab_unit=0 AND w.received_at<? ORDER BY w.started_at,w.wakeup_id LIMIT 1''',(params['snapshot'],)).fetchone()
    assert wake is not None
    sparse=sqlite3.connect(':memory:');sparse.executescript((SOURCE/'schema.sql').read_text())
    for table in ('syn_vehicle_model','syn_software_build','syn_vehicle','syn_voice_capability','syn_intent_catalog','syn_recognizer_model','syn_runtime_policy'):
        rows=seed.execute('SELECT * FROM '+table).fetchall()
        sparse.executemany('INSERT INTO '+table+' VALUES('+','.join('?' for _ in rows[0])+')',rows)
    day=date.fromisoformat(wake['started_at'][:10])
    scope={**params,'start':day.isoformat()+'T00:00:00Z','end':(day+timedelta(days=1)).isoformat()+'T00:00:00Z'}
    sparse.executescript((SOURCE/'etl.sql').read_text())
    empty_summary=sparse.execute(voice_counts_sql,scope).fetchall()
    assert empty_summary==[(0,0,0,0,None,None,None,None)]
    sparse.execute('INSERT INTO syn_wakeup_attempt VALUES('+','.join('?' for _ in wake)+')',tuple(wake))
    sparse.executescript((SOURCE/'etl.sql').read_text())
    assert sparse.execute('PRAGMA foreign_key_check').fetchall()==[]
    wake_summary=sparse.execute(voice_counts_sql,scope).fetchall()
    assert wake_summary==[(1,1,0,1,0,1,0,None)],'wake-only合法日表行及零轮次必须保留，无测量均值仍NULL'
    produced=sparse.execute('SELECT activity_date,turn_count,wakeup_attempt_count FROM syn_daily_voice_experience').fetchall()
    assert produced==[(day.isoformat(),0,1)]
    sparse.close();seed.close()

    measured=sqlite3.connect(':memory:')
    for name in ('schema.sql','seed.sql'):measured.executescript((SOURCE/name).read_text())
    later=(date.fromisoformat(params['snapshot'][:10])+timedelta(days=1)).isoformat()+'T00:00:00Z'
    measured.execute('UPDATE syn_action_result SET received_at=?',(later,))
    measured.executescript((SOURCE/'etl.sql').read_text())
    unmeasured=measured.execute(measurement_sql,{**params,'stage':'action'}).fetchall()
    assert len(unmeasured)==1 and unmeasured[0][0]>0 and unmeasured[0][1]>0
    assert unmeasured[0][2:]==(0,None),'有动作尝试但无可见终态耗时，不能补0毫秒'
    qualified=measured.execute('''SELECT COUNT(*) FROM syn_voice_turn t JOIN syn_voice_session s ON s.session_id=t.session_id
        JOIN syn_vehicle v ON v.vehicle_id=s.vehicle_id WHERE t.quality_state='valid' AND s.quality_state='valid' AND s.is_complete=1
        AND v.is_lab_unit=0 AND v.telemetry_consent=1 AND t.started_at>=:start AND t.started_at<:end
        AND t.finished_at<:snapshot AND t.received_at<:snapshot AND s.started_at<:snapshot AND s.ended_at<:snapshot AND s.received_at<:snapshot''',params).fetchone()[0]
    assert qualified>0
    measured.execute('UPDATE syn_asr_attempt SET received_at=?',(later,))
    catalog=json.loads((SOURCE/'semantic-catalog.json').read_text())
    rates=[o for o in catalog['objects'] if o['id'] in ('metric-asr_first_attempt_success_rate','metric-asr_final_attempt_success_rate')]
    assert len(rates)==2
    for metric in rates:
        sql=next(entry['effective_value'] for entry in metric['entries'] if entry['path']=='sql')
        assert measured.execute(sql,params).fetchall()==[(0,0,None)],'有合格轮次但无可见ASR尝试时比例NULL'
    measured.execute("UPDATE syn_voice_turn SET quality_state='invalid'")
    for metric in rates:
        sql=next(entry['effective_value'] for entry in metric['entries'] if entry['path']=='sql')
        assert measured.execute(sql,params).fetchall()==[(0,0,None)],'零合格轮次时计数0而比例NULL'
    assert measured.execute('PRAGMA foreign_key_check').fetchall()==[]
    measured.close()
    return {'child_snapshot':{'late':late,'visible':visible},'measurement_presence':{'absent':absent,'zero_row':zero},
            'legal_wake_only':{'produced':produced,'empty':empty_summary,'observed':wake_summary},
            'legal_unmeasured_action':unmeasured,'empty_asr_denominator':{'qualified_before':qualified,'metrics_checked':len(rates)},
            'limit':'只证明资料SQL在合成反例上的行为；真实覆盖仍需适用来源合同，不证明模型生成稿正确。'}


def main():
    generated=command('generate.py','--check')
    catalog=command('build_catalog.py','--check')
    data=command('verify_data.py')
    metrics=metric_boundaries()
    examples=rule_sql_examples()
    assert catalog['objects']==547
    assert catalog['kinds']=={'table':28,'field':421,'metric':30,'document':14,'relationship':54}
    report={'passed':True,'generated':generated,'catalog':catalog,'data_check_count':data['check_count'],
            'tables':data['tables'],'fields':data['fields'],'foreign_keys':data['foreign_keys'],'rows_total':data['rows_total'],
            'boundary_witnesses':data['boundary_witnesses'],'metric_sql':metrics,'rule_sql_examples':examples,
            'trial_executed':False,'model_requests':0,'scope':'合成资料和指标契约；不代表真实模型或真实平台验收'}
    print(json.dumps(report,ensure_ascii=False,indent=2))

if __name__=='__main__':main()
