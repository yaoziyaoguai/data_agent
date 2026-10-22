"""操作者离线参考：SQL、独立逐行计算与实际合成平台互相核对。"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import math
from pathlib import Path
import sqlite3
import tempfile
from datetime import datetime
from collections import defaultdict

from oracle_queries import ORACLES, CUTOFF

ROOT = Path(__file__).resolve().parents[4]
SOURCE = ROOT / 'docs/sources/cockpit'
REFERENCE = Path(__file__).resolve().parent


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def database():
    db = sqlite3.connect(':memory:')
    for name in ('schema.sql', 'seed.sql', 'etl.sql'):
        db.executescript((SOURCE / name).read_text())
    return db


def all_results(db):
    output = {}
    for key, spec in ORACLES.items():
        if spec['kind'] != 'sql':
            continue
        cursor = db.execute(spec['sql'])
        columns = [c[0] for c in cursor.description]
        assert columns == spec['columns'], (key, columns, spec['columns'])
        rows = [list(row) for row in cursor.fetchall()]
        output[key] = {'columns': columns, 'row_count': len(rows), 'rows_sha256': digest(rows),
                       'rows': rows if len(rows) <= 200 else rows[:20], 'rows_included_complete': len(rows) <= 200}
    return output


def check_platform(expected):
    spec = importlib.util.spec_from_file_location('cockpit_reference_platform', ROOT / 'apps/platform-mock/server.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    checks = []
    with tempfile.TemporaryDirectory(prefix='cockpit-reference-') as directory:
        platform = module.Platform(Path(directory), source_directory=SOURCE)
        platform.delay = 0
        db = database()
        for key, item in ORACLES.items():
            if item['kind'] != 'sql':
                continue
            compiled = platform.compile({'sql': item['sql'], 'parameters': {}})
            assert compiled['state'] == 'passed', (key, compiled)
            query_id = 'reference-' + key
            request = {'query_id': query_id, 'owner_id': 'bob', 'sql': item['sql'], 'parameters': {},
                       'target_id': 'synthetic-sqlite', 'target_version': platform.platform_version}
            platform.operate('/submit', request)
            found = platform.operate('/lookup', {'query_id': query_id, 'owner_id': 'bob'})
            assert found['state'] == 'succeeded', (key, found)
            cursor, rows, pages = None, [], 0
            while True:
                result = platform.operate('/results', {'query_id': query_id, 'owner_id': 'bob', 'cursor': cursor})
                rows += result['rows']
                pages += 1
                cursor = result['next_cursor']
                if cursor is None:
                    break
            raw = db.execute(item['sql']).fetchall()
            wanted = [[None if c is None else str(c) for c in r] for r in raw[:1000]]
            assert rows == wanted, (key, 'platform rows differ')
            assert [c['name'] for c in result['columns']] == expected[key]['columns'], key
            assert result['saved_row_count'] == min(len(raw), 1000), key
            assert result['saved_result_complete'] == (len(raw) <= 1000), key
            assert result['truncated'] == (len(raw) > 1000), key
            checks.append({'key': key, 'compile': 'passed', 'execute': 'succeeded', 'pages': pages,
                           'saved_rows': len(rows), 'full_reference_rows': len(raw), 'truncated': result['truncated']})
        db.close()
    return checks


def independent_checks(db, expected):
    """不复用CTE、窗口SQL或mart，以原始行和业务定义核对核心量。"""
    db.row_factory = sqlite3.Row
    tables = {}
    for name in ('vehicle', 'voice_session', 'voice_turn', 'asr_attempt', 'asr_hypothesis', 'nlu_attempt',
                 'playback_segment', 'action_invocation', 'action_result', 'wakeup_attempt', 'turn_feedback'):
        tables[name] = [dict(row) for row in db.execute('SELECT * FROM syn_' + name)]
    vehicles = {x['vehicle_id']: x for x in tables['vehicle'] if x['telemetry_consent'] and not x['is_lab_unit']}
    sessions = {x['session_id']: x for x in tables['voice_session']
                if x['vehicle_id'] in vehicles and x['quality_state'] == 'valid' and x['is_complete']
                and max(x['started_at'], x['ended_at'], x['received_at']) < CUTOFF}
    turns = {x['turn_id']: x for x in tables['voice_turn'] if x['session_id'] in sessions
             and x['quality_state'] == 'valid' and '2026-09-01' <= x['started_at'] < '2026-10-01'
             and max(x['started_at'], x['finished_at'], x['received_at']) < CUTOFF}
    cutoff_ms = int(datetime.fromisoformat(CUTOFF.replace('Z', '+00:00')).timestamp()) * 1000
    def visible(row, offset='finish_offset_ms'):
        t = turns.get(row['turn_id'])
        return (t is not None and row['received_at'] < CUTOFF and
                int(datetime.fromisoformat(t['started_at'].replace('Z', '+00:00')).timestamp()) * 1000 + row[offset] < cutoff_ms)
    checks = []
    def match(key, rows):
        assert expected[key]['rows_included_complete'] and expected[key]['rows'] == rows, (key, rows, expected[key])
        checks.append(key)
    match('turns_september', [[len(turns), len({sessions[t['session_id']]['vehicle_id'] for t in turns.values()})]])
    match('turns_empty_month', [[0, 0]])
    attempts = [x for x in tables['asr_attempt'] if visible(x)]
    final = {}
    for row in sorted(attempts, key=lambda x: (x['attempt_no'], x['asr_attempt_id'])):
        final[row['turn_id']] = row
    groups = defaultdict(list)
    for row in final.values():
        groups[row['endpoint_kind']].append(row)
    match('asr_final_success', [[key, len(rows), *[sum(x['outcome'] == state for x in rows) for state in ('succeeded','failed','timeout','cancelled')],
                               round(sum(x['outcome']=='succeeded' for x in rows)/len(rows),6)] for key, rows in sorted(groups.items())])
    audible = {}
    for row in tables['playback_segment']:
        if visible(row) and row['played_ms'] > 0:
            audible[row['turn_id']] = min(audible.get(row['turn_id'], row['start_offset_ms']), row['start_offset_ms'])
    durations = sorted(start-turns[key]['input_ms'] for key,start in audible.items())
    percentile = lambda p: durations[math.ceil(p * len(durations))-1] if durations else None
    match('first_playback_quantiles', [[len(durations), percentile(.5), percentile(.95)]])
    assert all(turns[key]['first_audio_latency_ms'] == start-turns[key]['input_ms'] for key,start in audible.items())
    assert {key for key, t in turns.items() if t['first_audio_latency_ms'] is not None} == set(audible)
    checks.append('first_audio_redundant_field_matches_observed_playback')
    eligible = [t for t in turns.values() if t['final_outcome'] in ('completed','clarification_pending','rejected','failed','unknown')]
    attempt_ids = {a['asr_attempt_id'] for a in attempts}
    chosen = {h['turn_id']: h['hypothesis_text'] for h in tables['asr_hypothesis'] if h['selected_for_nlu'] and h['is_final'] and h['received_at'] < CUTOFF and h['asr_attempt_id'] in attempt_ids}
    translation = str.maketrans({**{c:'' for c in ' 　。！？!?，,．.\t\r\n'}, **{chr(c):chr(c+32) for c in range(65,91)}})
    normal = lambda text: text.translate(translation) if text is not None else None
    labeled = [t for t in eligible if t['reference_text'] is not None]
    exact = sum(normal(t['reference_text']) == normal(chosen.get(t['turn_id'])) for t in labeled)
    match('transcript_label_accuracy', [[len(eligible), len(labeled), exact, round(exact/len(labeled),6) if labeled else None]])
    chosen_nlu = {n['turn_id']: n['predicted_intent_id'] for n in tables['nlu_attempt'] if n['selected_for_dialogue'] and visible(n)}
    labeled = [t for t in eligible if t['reference_intent_id'] is not None]
    exact = sum(t['reference_intent_id'] == chosen_nlu.get(t['turn_id']) for t in labeled)
    match('intent_label_accuracy', [[len(eligible), len(labeled), exact, round(exact/len(labeled),6) if labeled else None]])
    ops = defaultdict(list)
    for invocation in tables['action_invocation']:
        if visible(invocation,'submitted_offset_ms'):
            ops[invocation['operation_key']].append(invocation)
    match('action_request_attempts', [[len(ops), sum(map(len,ops.values())),sum(len(v)>1 for v in ops.values())]])
    receipts = defaultdict(list)
    invocation_ids = {i['invocation_id'] for rows in ops.values() for i in rows}
    for row in tables['action_result']:
        if row['invocation_id'] in invocation_ids and visible(row,'observed_offset_ms'):
            receipts[row['operation_key']].append(row)
    states = defaultdict(lambda:[0,0,0])
    for key, invocations in ops.items():
        rows = receipts[key]
        confirmed = any(r['effect_state']=='confirmed' for r in rows)
        latest = max(rows,key=lambda r:(r['observed_offset_ms'],r['observation_no'],r['result_id'])) if rows else None
        state = 'confirmed' if confirmed else latest['return_state'] if latest else 'no_receipt'
        bucket = states[state]; bucket[0]+=1; bucket[1]+=len(invocations)
        bucket[2]+=len({r['effect_instance_id'] for r in rows if r['effect_instance_id'] is not None})
    match('action_receipts', [[state,*values] for state,values in sorted(states.items())])
    feedback = [f for f in tables['turn_feedback'] if f['turn_id'] in turns and f['quality_state']=='valid' and f['is_explicit'] and max(f['collected_at'],f['received_at'])<CUTOFF]
    positive = sum(f['rating']=='positive' for f in feedback)
    match('feedback_rates', [[len(turns),len(feedback),positive,round(len(feedback)/len(turns),6) if turns else None,round(positive/len(feedback),6) if feedback else None]])
    wake_groups=defaultdict(list)
    for w in tables['wakeup_attempt']:
        if w['vehicle_id'] in vehicles and w['quality_state']=='valid' and '2026-09-01'<=w['started_at']<'2026-10-01' and w['received_at']<CUTOFF:
            wake_groups[w['trigger_kind']].append(w)
    quality=[]
    for trigger, rows in sorted(wake_groups.items()):
        labeled=sum(w['reference_is_intended'] is not None for w in rows)
        negative=sum(w['reference_is_intended']==0 for w in rows)
        false=sum(w['reference_is_intended']==0 and w['accepted']==1 for w in rows)
        quality.append([trigger,len(rows),labeled,negative,false,round(false/negative,6) if negative else None])
    match('wake_label_accuracy', quality)
    return checks


if __name__ == '__main__':
    with database() as db:
        results = all_results(db)
        independent = independent_checks(db,results)
    platform = check_platform(results)
    print(json.dumps({'sql_queries':len(results),'independent_checks':independent,'platform':platform,'trial_executed':False,'model_requests':0},ensure_ascii=False,indent=2))
