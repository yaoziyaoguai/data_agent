#!/usr/bin/env python3
"""座舱资料的聚合验收：可复现生成、语义目录、数据约束与指标边界。"""
from __future__ import annotations
import json
from pathlib import Path
import re
import sqlite3
import subprocess
import sys

SOURCE=Path(__file__).resolve().parent
ROOT=SOURCE.parents[2]
COUNT_COLUMNS={'numerator','denominator','attempts','accepted_attempts','false_accepts','unintended_labeled_attempts',
               'labeled_attempts','matched_turns','attempted_turns','sample_count','logical_operations',
               'matched_operations','visible_records','matched_records','active_voice_vehicles','valid_voice_turns'}


def command(script,*args):
    completed=subprocess.run([sys.executable,str(SOURCE/script),*args],cwd=ROOT,capture_output=True,text=True)
    if completed.returncode:
        raise SystemExit(completed.stdout + completed.stderr)
    return json.loads(completed.stdout.strip().splitlines()[-1])


def metric_boundaries():
    catalog=json.loads((SOURCE/'semantic-catalog.json').read_text())
    metrics=[o for o in catalog['objects'] if o['kind']=='metric']
    assert len(metrics)==26
    db=sqlite3.connect(':memory:')
    for name in ('schema.sql','seed.sql','etl.sql'):db.executescript((SOURCE/name).read_text())
    executions=0;daily=[];checked=[]
    snapshot='2026-10-04T00:00:00Z'
    for metric in metrics:
        sql=next(e['effective_value'] for e in metric['entries'] if e['path']=='sql')
        for label,start,end in [('full_day','2026-09-01T00:00:00Z','2026-10-01T00:00:00Z'),
                                ('empty_day','2026-01-01T00:00:00Z','2026-02-01T00:00:00Z')]:
            cur=db.execute(sql,{'start':start,'end':end,'snapshot':snapshot});rows=cur.fetchall();executions+=1
            columns=[x[0] for x in cur.description]
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


def main():
    generated=command('generate.py','--check')
    catalog=command('build_catalog.py','--check')
    data=command('verify_data.py')
    metrics=metric_boundaries()
    assert catalog['objects']==543
    assert catalog['kinds']=={'table':28,'field':421,'metric':26,'document':14,'relationship':54}
    report={'passed':True,'generated':generated,'catalog':catalog,'data_check_count':data['check_count'],
            'tables':data['tables'],'fields':data['fields'],'foreign_keys':data['foreign_keys'],'rows_total':data['rows_total'],
            'boundary_witnesses':data['boundary_witnesses'],'metric_sql':metrics,
            'trial_executed':False,'model_requests':0,'scope':'合成资料和指标契约；不代表真实模型或真实平台验收'}
    print(json.dumps(report,ensure_ascii=False,indent=2))

if __name__=='__main__':main()
