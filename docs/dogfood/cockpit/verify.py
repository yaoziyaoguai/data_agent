#!/usr/bin/env python3
"""只校验Dogfood包和独立参考，不执行产品试用或请求模型。"""
from __future__ import annotations
from collections import Counter
import json
from pathlib import Path
import subprocess
import sys

PACKAGE=Path(__file__).resolve().parent
ROOT=PACKAGE.parents[2]
sys.path.insert(0,str(PACKAGE/'reference'))
from oracle_queries import ORACLES
from check_reference import database, all_results, independent_checks, check_platform
from build import ordered
from grade import validate_record


def main():
    generated=subprocess.run([sys.executable,str(PACKAGE/'build.py'),'--check'],cwd=ROOT,capture_output=True,text=True)
    if generated.returncode:raise SystemExit(generated.stdout+generated.stderr)
    data=json.loads((PACKAGE/'scenarios.json').read_text());cases=data['cases']
    assert len(cases)==100 and data['case_count']==100
    ids={c['id'] for c in cases};assert len(ids)==100
    assert Counter(c['level'] for c in cases)=={0:10,1:20,2:20,3:15,4:15,5:10,6:10}
    assert all(c['status']=='not_run' and c['attempts']==[] for c in cases)
    assert len(ordered(cases))==100 and ordered(cases)[-1]=='G10'
    source=ROOT/'docs/sources/cockpit';spec=json.loads((source/'domain-spec.json').read_text())
    tables={t['name'] for t in spec['tables']};docs={d['file'] for d in spec['documents']}
    assert set().union(*(set(c['tables']) for c in cases))==tables
    assert set().union(*(set(c['documents']) for c in cases))==docs
    for c in cases:
        assert c['expect'] and c['steps'] and c['requires'],c['id']
        assert set(c['depends_on'])<=ids and c['id'] not in c['depends_on'],c['id']
        assert set(c['reference_keys'])<=set(ORACLES),c['id']
        assert all((source/path).is_file() for path in c['documents']),c['id']
        if c['mode']=='model':assert c['messages'],c['id']
    for key,item in ORACLES.items():
        if item['kind']=='bundle':assert set(item['keys'])<=set(ORACLES),key
    manifest=json.loads((source/'knowledge-manifest.json').read_text())
    allowed=set(manifest['knowledge_files'])
    assert allowed and all(p=='schema.sql' or p=='etl.sql' or p=='business-guide.md' or p in docs for p in allowed)
    assert not any('dogfood' in p or 'seed' in p or 'evaluation' in p or 'reference' in p or p.endswith('.py') for p in allowed)
    frozen=json.loads((PACKAGE/'reference/expected-results.json').read_text())
    with database() as db:
        actual=all_results(db)
        assert actual==frozen['results'],'independent expected results changed; investigate before freeze'
        cross=independent_checks(db,actual)
        assert cross==frozen['checks']
    for key in ('overlap_critical_path','streamed_playback'):
        assert actual[key]['row_count']>0, (key,'missing positive complexity witness')
    late=actual['late_receipt_visibility'];assert late['rows'][0][late['columns'].index('late_rows')]>0,'late child receipt witness missing'
    assert actual['asr_candidates_large_result']['row_count']>1000
    platform=check_platform(actual)
    grade=validate_record(PACKAGE/'records/results-template.json');assert grade['record_consistent'],grade
    assert grade['states']=={'not_run':100}
    result={'status':'prepared_not_run','case_count':100,'tables':len(tables),'documents':len(docs),
            'sql_reference_count':len(actual),'independent_checks':cross,'platform_queries':len(platform),
            'platform_saved_rows_compared':sum(p['saved_rows'] for p in platform),
            'platform_pages_compared':sum(p['pages'] for p in platform),'truncated_queries':[p['key'] for p in platform if p['truncated']],
            'trial_executed':False,'model_requests':0,'limitations':['未执行新包真实模型Dogfood','未验证真实平台或真实音频识别']}
    print(json.dumps(result,ensure_ascii=False,indent=2))

if __name__=='__main__':main()
