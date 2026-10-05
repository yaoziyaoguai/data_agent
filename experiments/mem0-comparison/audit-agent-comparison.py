"""核对固定测量覆盖、真实提取链路和账本；允许内容失败，禁止把漏跑当成功。"""
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def audit(directory, source_review=None):
    result = json.loads((directory / 'result.json').read_text())
    assert result['schema'] == 2 and result['finishedAt']
    assert result['sourceHashes'] == result['finalSourceHashes'], '测量时源码发生变化'
    changed = {name: {"measured_sha256": digest, "current_sha256": hashlib.sha256((ROOT / name).read_bytes()).hexdigest()}
               for name, digest in result['sourceHashes'].items()
               if hashlib.sha256((ROOT / name).read_bytes()).hexdigest() != digest}
    if changed:
        # 仅接受本轮已独立复核的日志采集/离线评分修正；模型、输入、业务及提取接缝必须冻结。
        allowed = {'experiments/mem0-comparison/' + name for name in
                   ['agent-comparison.mjs', 'agent-scoring.py', 'audit-agent-comparison.py']}
        assert source_review is not None and set(changed) <= allowed, '冻结源码改变，缺少范围明确的独立复核'
        review = json.loads(source_review.read_text())
        assert review['conclusion'] == 'passed' and review['result_sha256'] == hashlib.sha256((directory / 'result.json').read_bytes()).hexdigest()
        assert set(review['files']) == set(changed)
        for name, hashes in changed.items():
            assert all(review['files'][name][key] == value for key, value in hashes.items())
            assert review['files'][name]['effect'] == 'evidence_only'
    criteria = json.loads((ROOT / 'experiments/mem0-comparison/agent-expected.json').read_text())
    names = ['sample'] if result['sample'] else list(criteria['scenarios'])
    repeats = 2
    expected = {(name, group, repeat) for name in names for group in ['original', 'mem0'] for repeat in range(1, repeats + 1)}
    actual = {(s['id'], s['group'], s['repetition']) for s in result['scenarios']}
    assert actual == expected and len(actual) == len(result['scenarios']), '固定分母未覆盖'
    assert result['configuration']['agent_model'] == 'deepseek-flash'
    assert result['configuration']['embedding'] == 'qwen3.7-text-embedding'
    calls = cost = 0
    committed = extracted = replays = 0
    for scenario in result['scenarios']:
        ledger = scenario['ledger']
        assert ledger and scenario['finishedAt']
        assert len(scenario['callReceipts']) == ledger['calls']
        calls += ledger['calls']
        cost += int(ledger['spent_micros']) + int(ledger['reserved_micros'])
        prepared = {}
        for event in scenario['memoryTrace']:
            if event['action'] == 'prepare':
                extracted += not event['receipt'].get('replayed', False)
                replays += event['receipt'].get('replayed', False)
                assert event['sent_arguments']['body'] == event['receipt']['body']
                key = event['operation']
                if key in prepared:
                    assert prepared[key] == event['sent_arguments'], '三条路径参数不一致'
                prepared[key] = event['sent_arguments']
            if event['action'] == 'commit' and event['receipt']['index_state'] == 'ready':
                committed += 1
                matches = [a for step in scenario['steps'] for a in step.get('assets', [])
                           if a['id'] == event['asset_id'] and a['version'] == event['version']]
                assert matches and any(a['body'] == prepared[event['operation']]['body'] for a in matches), '正式正文不是Mem0提取结果'
        assert scenario['group'] != 'original' or not scenario['memoryTrace']
    assert calls == result['agentTotals']['calls'] and cost == result['agentTotals']['cost_micros']
    assert calls <= result['configuration']['agent_call_limit']
    assert cost <= result['configuration']['agent_cost_limit_micros']
    assert committed > 0 and extracted > 0 and replays > 0, 'Mem0未实际参与成功提交'
    events = [json.loads(line) for line in (directory / 'memory-service.jsonl').read_text().splitlines()]
    prepare_requests = [e['request'] for e in events if e['request']['action'] == 'prepare']
    assert prepare_requests and all('asset' not in r and 'body' not in r and 'scope' not in r for r in prepare_requests)
    for request in prepare_requests:
        matching = [s for s in result['scenarios'] if s['group'] == 'mem0' and request['case'] == s['id'] + '_r' + str(s['repetition'])]
        assert len(matching) == 1 and request['message'] in [step['text'] for step in matching[0]['steps']]
        assert request['quote'] in request['message']
    for filename, total_key in [('extraction-calls.jsonl', 'extraction'), ('embedding-calls.jsonl', 'embedding')]:
        receipts = {}
        for line in (directory / filename).read_text().splitlines():
            r = json.loads(line); receipts[r['attempt']] = r
        total = result['memoryTotals'][total_key]
        assert len(receipts) == total.get('calls', total.get('embedding_api_requests'))
    return {'status': 'passed', 'combinations': len(actual), 'agent_calls': calls,
            'agent_cost_with_reserve_micros': cost, 'mem0_preparations': extracted, 'commits': committed,
            'parameter_replays': replays, 'reviewed_evidence_only_changes': sorted(changed), 'result_sha256': hashlib.sha256((directory / 'result.json').read_bytes()).hexdigest(),
            'limitation': '覆盖和链路审计通过不等于内容全部正确；内容由独立评分报告给出。'}


if __name__ == '__main__':
    directory = Path(sys.argv[1])
    source_review = Path(sys.argv[sys.argv.index('--source-review') + 1]) if '--source-review' in sys.argv else None
    receipt = audit(directory, source_review)
    (directory / 'audit.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2))
    print(json.dumps(receipt, ensure_ascii=False))
