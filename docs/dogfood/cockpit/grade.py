#!/usr/bin/env python3
"""检查试用记录的完整性；不替操作者判断语义正确，也不修改状态。"""
from __future__ import annotations
import argparse
from collections import Counter
from decimal import Decimal, InvalidOperation
import json
from pathlib import Path
import sys

PACKAGE = Path(__file__).resolve().parent
sys.path.insert(0,str(PACKAGE/'reference'))
from oracle_queries import ORACLES
from check_reference import database

STATUSES={'not_run','pass','fail','partial','blocked_environment','blocked_authorization','inconclusive'}


def compare(actual, key):
    item=ORACLES.get(key)
    if not item or item['kind']!='sql':raise ValueError('reference key must identify one SQL')
    with database() as db:
        cursor=db.execute(item['sql']); rows=[list(r) for r in cursor.fetchall()]
    if actual['columns']!=item['columns']:raise ValueError('columns/order differ; provide an explicit audited mapping')
    if len(actual['rows'])!=len(rows):raise ValueError(f'row count differs: actual={len(actual["rows"])} expected={len(rows)}; a saved prefix is not a full result')
    for i,(got,want) in enumerate(zip(actual['rows'],rows)):
        if len(got)!=len(want):raise ValueError(f'column count differs at row {i}')
        for j,(a,b) in enumerate(zip(got,want)):
            if b is None:
                okay=a is None
            elif isinstance(b,(int,float)):
                try:
                    delta=abs(Decimal(str(a))-Decimal(str(b)))
                    tolerance=Decimal('0') if isinstance(b,int) else Decimal(str(item['numeric_tolerance']))
                    okay=delta<=tolerance
                except (InvalidOperation,ValueError):okay=False
            else:okay=a==b
            if not okay:raise ValueError(f'value mismatch at row {i} column {item["columns"][j]}: {a!r} != {b!r}')
    return {'reference_key':key,'numeric_match':True,'rows':len(rows),'semantic_grade':'requires_manual_review'}


def validate_record(path, trajectories=False, require_pass=()):
    source=PACKAGE.parents[1]/'execution/semantic-runtime/integrated-trajectories.json' if trajectories else PACKAGE/'scenarios.json'
    record=json.loads(path.read_text());cases=json.loads(source.read_text())['cases'];expected={c['id']:c for c in cases}
    case_count=len(cases) if trajectories else 100
    observed=record.get('cases',[]);errors=[];ids=[r.get('case_id') for r in observed]
    if len(ids)!=case_count or len(set(ids))!=case_count or set(ids)!=set(expected):errors.append(f'must contain each of the {case_count} case IDs exactly once')
    counts=Counter();evidence_count=0
    for row in observed:
        case_id=row.get('case_id');status=row.get('status');counts[status]+=1
        if status not in STATUSES:errors.append(f'{case_id}: invalid status')
        case=expected.get(case_id)
        if not case:continue
        assertions=row.get('assertions',[])
        if [a.get('expected') for a in assertions]!=case['expect']:errors.append(f'{case_id}: assertion list differs from frozen scenario')
        if status=='pass' and (not row.get('attempts') or not assertions or any(a.get('status')!='pass' for a in assertions)):
            errors.append(f'{case_id}: pass requires attempts and every assertion passed')
        if status=='not_run' and row.get('attempts'):errors.append(f'{case_id}: attempts exist but status is not_run')
        for assertion in assertions:
            state=assertion.get('status')
            if state not in STATUSES:errors.append(f'{case_id}: invalid assertion status')
            if state!='not_run' and not assertion.get('reason'):errors.append(f'{case_id}: evaluated assertion needs reason')
            if state in ('pass','fail') and not assertion.get('evidence'):errors.append(f'{case_id}: pass/fail assertion needs evidence')
            for evidence in assertion.get('evidence',[]):
                target=(path.parent/evidence).resolve()
                if not target.is_file():errors.append(f'{case_id}: missing evidence {evidence}')
                else:evidence_count+=1
        for attempt in row.get('attempts',[]):
            for key in ('attempt_id','mode','started_at','status','trace'):
                if not attempt.get(key):errors.append(f'{case_id}: attempt missing {key}')
            if attempt.get('mode') not in ('real_model','model_mock','ui','engineering'):errors.append(f'{case_id}: attempt mode must distinguish real model from mock')
            if case['mode']=='model' and status=='pass' and not any(a.get('mode')=='real_model' for a in row.get('attempts',[])):
                errors.append(f'{case_id}: a model case cannot pass only on mock evidence')
            if attempt.get('trace') and not (path.parent/attempt['trace']).is_file():errors.append(f'{case_id}: missing attempt trace')
    by_id={row.get('case_id'):row for row in observed}
    for case_id in require_pass:
        if case_id not in expected or case_id not in by_id:
            errors.append(f'required pass case ID not found: {case_id}')
        elif by_id[case_id].get('status')!='pass':
            errors.append(f'{case_id}: required pass, got {by_id[case_id].get("status")}')
    return {'states':dict(counts),'case_count':len(observed),'existing_evidence_references':evidence_count,
            'record_consistent':not errors,'errors':errors,'automatic_semantic_grading':False}


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('record',type=Path,nargs='?');parser.add_argument('--reference-key');parser.add_argument('--actual',type=Path)
    parser.add_argument('--trajectories',action='store_true',help='validate the integrated trajectory list instead of the original 100 cases')
    parser.add_argument('--require-pass',nargs='+',default=[],metavar='CASE_ID',help='require these fixed case IDs to pass while preserving the complete record')
    args=parser.parse_args()
    if args.reference_key:
        if args.require_pass:parser.error('--require-pass is only for record validation')
        if not args.actual:parser.error('--actual required')
        report=compare(json.loads(args.actual.read_text()),args.reference_key)
    else:
        if not args.record:parser.error('results.json path required')
        report=validate_record(args.record,trajectories=args.trajectories,require_pass=args.require_pass)
    print(json.dumps(report,ensure_ascii=False,indent=2))
    if report.get('errors'):raise SystemExit(1)

if __name__=='__main__':main()
