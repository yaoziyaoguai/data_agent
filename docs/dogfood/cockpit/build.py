#!/usr/bin/env python3
"""生成/检查可阅读用例及模板；--freeze-reference显式更新离线参考。"""
from __future__ import annotations
import argparse
from collections import Counter
import hashlib
import html
import json
from pathlib import Path
import sys

PACKAGE = Path(__file__).resolve().parent
ROOT = PACKAGE.parents[2]
SOURCE = ROOT / 'docs/sources/cockpit'
sys.path.insert(0, str(PACKAGE / 'reference'))
from oracle_queries import ORACLES
from check_reference import database, all_results, independent_checks

LEVEL_NAMES = ['资料与入口', '单环节统计', '多表与口径', '多轮与执行', '报告、方法与记忆', '维护与权限', '综合分析与恢复']
STATUSES = ['not_run','pass','fail','partial','blocked_environment','blocked_authorization','inconclusive']


def dumps(value):
    return json.dumps(value, ensure_ascii=False, indent=2) + '\n'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def ordered(cases):
    pending = {c['id']: c for c in cases}
    out, seen = [], set()
    while pending:
        available = [c for c in pending.values() if set(c['depends_on']) <= seen and c['id'] != 'G10']
        if not available and set(pending) == {'G10'}:
            available = [pending['G10']]
        if not available:
            raise ValueError('case dependency cycle: ' + ','.join(pending))
        item = min(available, key=lambda c: (c['level'], c['id']))
        out.append(item['id']); seen.add(item['id']); del pending[item['id']]
    return out


def markdown_case(case):
    parts = [f"## {case['id']} · {case['title']}", f"L{case['level']} · {case['mode']} · 身份：{case['actor']} · 初始状态：not_run",
             '依赖：' + (', '.join(case['depends_on']) or '无'), '前提：\n' + '\n'.join('- ' + s for s in case['requires']),
             '操作：\n' + '\n'.join(f'{i}. {s}' for i,s in enumerate(case['steps'],1))]
    if case['messages']:
        parts.append('依次发送（只替换占位符；不发送验收与参考）：\n\n' + '\n\n'.join(f'{i}. {m}' for i,m in enumerate(case['messages'],1)))
    parts += ['逐条验收（操作者保留）：\n' + '\n'.join('- ' + s for s in case['expect']),
              '参考键：' + (', '.join(case['reference_keys']) or '行为/UI逐条核对'),
              '表：' + ', '.join(case['tables']), '文档：' + ', '.join(case['documents']),
              '清理：' + case['cleanup'], '备注：\n' + '\n'.join('- ' + s for s in case['notes'])]
    return '\n\n'.join(parts) + '\n'


def generated():
    data = json.loads((PACKAGE / 'scenarios.json').read_text())
    cases = data['cases']
    domain = json.loads((SOURCE / 'domain-spec.json').read_text())
    by_table = {t['name']: [c['id'] for c in cases if t['name'] in c['tables']] for t in domain['tables']}
    by_document = {d['file']: [c['id'] for c in cases if d['file'] in c['documents']] for d in domain['documents']}
    coverage = {'case_count':len(cases),'by_level':dict(sorted(Counter(str(c['level']) for c in cases).items())),
                'by_mode':dict(Counter(c['mode'] for c in cases)), 'tables':by_table,'documents':by_document,
                'execution_order':ordered(cases), 'coverage_means':'用例声明覆盖，不代表已通过或每字段均已实测。'}
    template = {'schema':1,'package_id':data['package_id'],'run_id':None,'trial_executed':False,'model_requests':0,
                'environment':{'commit':None,'source_fingerprint':None,'provider':None,'model':None,'thinking':None,
                               'pi_version':None,'memory_mode':None,'retrieval_mode':None,'authorization_evidence':None},
                'cases':[{'case_id':c['id'],'status':'not_run','attempts':[],
                          'assertions':[{'expected':e,'status':'not_run','evidence':[],'reason':None} for e in c['expect']]} for c in cases]}
    md = '# 座舱语音交互 Dogfood：100项用例\n\n由 `scenarios.json` 生成。本文只供操作者，验收/参考不能输入产品模型。\n\n' + '\n\n'.join(markdown_case(c) for c in cases)
    cards = []
    for c in cases:
        details = html.escape(markdown_case(c))
        cards.append(f'<article data-level="{c["level"]}" id="{c["id"]}"><h2>{c["id"]} · {html.escape(c["title"])}</h2><p>L{c["level"]} · {c["mode"]} · not_run</p><details><summary>展开操作、输入与验收</summary><pre>{details}</pre></details></article>')
    page = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>语音交互 Dogfood</title><style>body{font:16px/1.65 system-ui;background:#f5f3ec;color:#202a30;max-width:1050px;margin:auto;padding:30px}header{border-bottom:3px solid #276960}button,input{font:inherit;padding:8px;margin:4px;border:1px solid #8c9e98;border-radius:6px}article{padding:18px;background:white;border:1px solid #d8dfdb;border-radius:8px;margin:14px 0}h2{font-size:20px;margin:0}pre{white-space:pre-wrap;font:inherit;overflow-wrap:anywhere}nav{position:sticky;top:0;background:#f5f3ec;padding:8px 0}summary{cursor:pointer}small{color:#4c615c}</style><header><h1>座舱语音交互 Dogfood</h1><p>100项 · 28张表 · 14份文档 · 全部尚未试用</p><p>唤醒 → VAD → ASR → NLU/槽位 → 对话 → 技能 → 动作/回执 → TTS/播报</p><small>参考与验收只供操作者；页面是用例导航，不是产品通过报告。</small></header><nav><input id="q" aria-label="搜索用例" placeholder="搜索ID、标题或内容"><button data-filter="all">全部</button>' + ''.join(f'<button data-filter="{i}">L{i} {name}</button>' for i,name in enumerate(LEVEL_NAMES)) + '</nav><main>' + ''.join(cards) + '</main><script>let level="all";function filter(){const q=document.querySelector("#q").value.toLowerCase();document.querySelectorAll("article").forEach(x=>x.hidden=!((level==="all"||x.dataset.level===level)&&x.textContent.toLowerCase().includes(q)))}document.querySelector("#q").addEventListener("input",filter);document.querySelectorAll("button").forEach(b=>b.addEventListener("click",()=>{level=b.dataset.filter;filter()}));</script></html>\n'
    output = {'coverage.json':dumps(coverage),'records/results-template.json':dumps(template),'CASES.md':md,'guide.html':page}
    for key,spec in ORACLES.items():
        if spec['kind']=='sql': output[f'reference/queries/{key}.sql']=spec['sql']
    return output


def manifest():
    source_files = sorted(p for p in SOURCE.rglob('*') if p.is_file() and '__pycache__' not in p.parts and p.suffix in ('.sql','.md','.json','.py'))
    package_files = sorted(p for p in PACKAGE.rglob('*') if p.is_file() and '__pycache__' not in p.parts and p.name!='manifest.json' and p.suffix in ('.sql','.md','.json','.py','.html'))
    return {'schema':1,'package_id':json.loads((PACKAGE/'scenarios.json').read_text())['package_id'],'status':'prepared_not_run', 'case_count':100,
            'trial_executed':False,'model_requests':0,'sql_reference_count':sum(v['kind']=='sql' for v in ORACLES.values()),
            'source_directory':'docs/sources/cockpit','scope':'从零构造的座舱语音交互链路；无公司资料或原始录音。',
            'source_files_sha256':{p.relative_to(ROOT).as_posix():sha(p) for p in source_files},
            'package_files_sha256':{p.relative_to(PACKAGE).as_posix():sha(p) for p in package_files}}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check',action='store_true');parser.add_argument('--freeze-reference',action='store_true')
    parser.add_argument('--case');parser.add_argument('--level',type=int,choices=range(7));parser.add_argument('--list',action='store_true')
    parser.add_argument('--order',action='store_true');parser.add_argument('--messages-only',action='store_true');parser.add_argument('--run-prefix')
    args=parser.parse_args(); data=json.loads((PACKAGE/'scenarios.json').read_text());cases=data['cases']
    if args.case or args.level is not None or args.list or args.order:
        if args.order: print(' → '.join(ordered(cases)));return
        selected=[c for c in cases if (not args.case or c['id']==args.case) and (args.level is None or c['level']==args.level)]
        if not selected: parser.error('unknown case')
        context=json.loads((PACKAGE/'fixtures/context.json').read_text())
        if args.run_prefix: context['run_prefix']=args.run_prefix
        for c in selected:
            out=(f"{c['id']} L{c['level']} {c['mode']} {c['title']}" if args.list else '\n\n'.join(c['messages']) if args.messages_only else markdown_case(c))
            for key,value in context.items():
                if isinstance(value,str):out=out.replace('{{'+key+'}}',value)
            print(out)
        return
    if args.freeze_reference:
        if args.check: parser.error('--check cannot freeze')
        with database() as db:
            results=all_results(db); checks=independent_checks(db,results)
        (PACKAGE/'reference/expected-results.json').write_text(dumps({'schema':1,'basis':'independent SQL and raw-row reducers; not product results','checks':checks,'results':results}))
    output=generated()
    stale=[]
    for name,body in output.items():
        path=PACKAGE/name
        if args.check:
            if not path.exists() or path.read_text()!=body:stale.append(name)
        else:path.parent.mkdir(parents=True,exist_ok=True);path.write_text(body)
    body=dumps(manifest());path=PACKAGE/'manifest.json'
    if args.check:
        if not path.exists() or path.read_text()!=body:stale.append('manifest.json')
        if stale:raise SystemExit('stale generated files: '+', '.join(stale))
    else:path.write_text(body)
    print(dumps({'generated_files':len(output)+1,'checked':args.check,'trial_executed':False,'model_requests':0}))

if __name__=='__main__':main()
