#!/usr/bin/env python3
"""生成和核对试用资料；不调用模型、应用服务或真实数据库。"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
from pathlib import Path
import re
import shlex
import sqlite3
import sys


BASE = Path(__file__).resolve().parent
ROOT = BASE.parents[2]
STATES = ['not_run', 'pass', 'fail', 'partial', 'blocked_environment',
          'blocked_authorization', 'inconclusive']
MODE_NAMES = {'ui': '页面操作', 'model': '真实模型', 'setup': '需要准备',
              'engineering': '隔离工程专项'}
GROUP_NAMES = {'workbench': '工作台', 'personal': '记忆与方法', 'maintainer': '语义维护',
               'admin': '超级维护', 'collaboration': '协作', 'boundaries': '边界',
               'regression': '修复与SDK', 'complex': '复杂连续任务'}


def read_json(name: str) -> dict | list:
    return json.loads((BASE / name).read_text(encoding='utf-8'))


def json_text(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2) + '\n'


def namespace(value: object) -> object:
    if isinstance(value, str):
        return value.replace('DF1014', '{{run_prefix}}')
    if isinstance(value, list):
        return [namespace(item) for item in value]
    if isinstance(value, dict):
        return {key: namespace(item) for key, item in value.items()}
    return value


def validate(cases: list[dict], areas: list[dict], manifest: dict) -> dict:
    ids = {case['id'] for case in cases}
    assert len(cases) == len(ids) == manifest['case_count'] == 160
    assert len(areas) == manifest['coverage_area_count'] == 43
    assert {case['id'] for case in cases if case['group'] == 'regression'} == {
        f'R{number:02}' for number in range(1, 25)}
    assert {case['id'] for case in cases if case['group'] == 'complex'} == {
        f'Z{number:02}' for number in range(1, 17)}
    assert hashlib.sha256((BASE / 'legacy-cases.json').read_bytes()).hexdigest() == manifest['legacy_snapshot_sha256']
    legacy = [case for group in read_json('legacy-cases.json') for case in group['cases']]
    by_id = {case['id']: case for case in cases}
    assert len(legacy) == manifest['legacy_count'] == 120
    for original in legacy:
        assert all(by_id[original['id']][key] == namespace(value)
                   for key, value in original.items()), original['id']
    covered = set()
    for area in areas:
        assert area['case_ids'] and set(area['case_ids']) <= ids, area['id']
        covered.update(area['case_ids'])
    assert covered == ids
    references = read_json('reference/expected-results.json')['checks']
    for case in cases:
        assert case['mode'] in MODE_NAMES and case['group'] in GROUP_NAMES
        assert case['preferred_actor'] in {'alice', 'bob', 'carol', 'multiple'}
        assert all(case.get(field) for field in ['steps', 'expect', 'roles', 'requires', 'cleanup', 'coverage_ids'])
        assert set(case['depends_on']) <= ids and case['id'] not in case['depends_on']
        assert set(case['reference_keys']) <= set(references), case['id']
        for command in case['engineering_commands']:
            assert command[0] == 'node' and len(command) == 2
            assert (ROOT / command[1]).is_file(), command
    # 依赖只约束前置产物，不把失败的整项变成所有后续步骤的永久阻断。
    visited, visiting = set(), set()
    def visit(identifier: str) -> None:
        assert identifier not in visiting, f'循环依赖: {identifier}'
        if identifier in visited:
            return
        visiting.add(identifier)
        for dependency in by_id[identifier]['depends_on']:
            visit(dependency)
        visiting.remove(identifier)
        visited.add(identifier)
    for identifier in ids:
        visit(identifier)
    source = ROOT / manifest['source_directory']
    for name, expected_hash in manifest['source_hashes'].items():
        assert hashlib.sha256((source / name).read_bytes()).hexdigest() == expected_hash, name
    with sqlite3.connect(':memory:') as database:
        for name in ['schema.sql', 'seed.sql', 'etl.sql']:
            database.executescript((source / name).read_text())
        for key, reference in references.items():
            actual = [list(row) for row in database.execute(reference['sql'])]
            assert actual == reference['rows'], (key, actual, reference['rows'])
    for path in BASE.rglob('*'):
        if path.is_file() and path.suffix in {'.json', '.md', '.py', '.html', '.sql'}:
            body = path.read_text()
            assert not re.search('/' + 'Users' + r'/[^\s"<>]+', body), path.name
            assert not re.search(r'(?i)(?:api[_-]?key|authorization)\s*[=:]\s*["\']?(?:sk-[A-Za-z0-9]|Bearer\s+[A-Za-z0-9])', body), path.name
    return {'cases': len(cases), 'legacy_preserved': len(legacy), 'coverage_areas': len(areas),
            'reference_queries': len(references), 'source_hashes': len(manifest['source_hashes']),
            'trial_executed': False, 'model_requests': 0}


def result_template(cases: list[dict]) -> dict:
    return {'schema': 1, 'package_id': 'data-agent-dogfood-20261019',
            'run_id': None, 'run_prefix': None, 'environment_reference': None,
            'case_count': len(cases), 'status_counts': {state: len(cases) if state == 'not_run' else 0 for state in STATES},
            'cases': [{'case_id': case['id'], 'status': 'not_run', 'attempts': [],
                       'assertions': [{'expected': expected, 'status': 'not_run', 'evidence_ids': []}
                                      for expected in case['expect']],
                       'actual_mode': None, 'actual_actor': None, 'code_commit': None,
                       'reused_evidence_ids': [], 'issue_ids': [], 'blocked_reason': None,
                       'next_action': None} for case in cases],
            'attempt_fields': ['attempt_id', 'started_at', 'finished_at', 'step_results', 'user_messages',
                               'actual_answer', 'final_sql_and_parameters', 'object_ids_and_versions',
                               'evidence_files', 'model_or_platform_unknown', 'conclusion_reason'],
            'warning': '模板不是执行结果；attempts为空、断言未覆盖时不能pass。'}


def markdown_cases(cases: list[dict]) -> str:
    result = ['# 160 项试用场景', '',
              '先读START；下面的expect只供操作者核对，不发给产品模型。原120项仅替换命名前缀，历史requires是待核对的条件，不能当成永久不可用或当前已具备的事实。', '']
    group = None
    for case in cases:
        if group != case['group']:
            group = case['group']
            result += [f'## {GROUP_NAMES[group]}', '']
        result += [f'<a id="{case["id"]}"></a>', f'### {case["id"]} {case["title"]}', '',
                   f'类型：{MODE_NAMES[case["mode"]]}；角色：{", ".join(case["roles"])}；环境：`{case["environment"]}`。', '',
                   f'前提：{case["requires"]}', '',
                   '前置产物：' + (', '.join(case['depends_on']) or '按场景准备'), '', '步骤：', '']
        result += [f'{number}. {step}' for number, step in enumerate(case['steps'], 1)]
        result += ['', '逐条发送内容：' if case['messages'] else '无固定模型消息；按页面或工程步骤执行。', '']
        for message in case['messages']:
            result += [message['label'], '', '```text', message['text'], '```', '']
        result += ['独立验收：', ''] + ['- ' + expected for expected in case['expect']]
        if case['reference_keys']:
            result += ['', '参考结果键：' + ', '.join(f'`{key}`' for key in case['reference_keys'])]
        if case['engineering_commands']:
            result += ['', '补充工程命令（只在隔离环境，不能顶替真实模型）：', '', '```sh']
            result += [shlex.join(command) for command in case['engineering_commands']]
            result += ['```']
        result += ['', '收尾：' + case['cleanup'], '']
        result += ['- ' + note for note in case['notes']]
        result += ['']
    return '\n'.join(result).rstrip() + '\n'


def coverage_markdown(areas: list[dict]) -> str:
    lines = ['# 功能与场景映射', '',
             '43个覆盖主题包含当前功能、专项边界和跨能力任务；映射是执行计划，不是已通过证明。每项案例至少映射一个主题。', '',
             '| 编号 | 主题 | 对应场景 |', '| --- | --- | --- |']
    for area in areas:
        links = ' '.join(f'[{identifier}](CASES.md#{identifier})' for identifier in area['case_ids'])
        lines.append(f'| {area["id"]} | {area["title"]} | {links} |')
    return '\n'.join(lines) + '\n'


def long_note() -> str:
    lines = ['# 本轮长文演练说明', '',
             '本文件完全合成，仅用于本轮独立文档，不修改正式零售口径。', '',
             '## 首部定义', '',
             '演练对象是包裹。达标率分母只含已交付且完成质量核对的包裹；未知状态不等于不达标。时间采用UTC半开区间，空分母返回NULL。这里没有实际平台表名或成本数据。', '']
    for number in range(1, 141):
        lines += [f'## 演练检查记录 {number:03}', '',
                  '本段说明记录阅读和交接过程，不能据此推导任何真实交易。操作者分别记录对象、版本、已阅读片段与仍未确认的缺口。阅读本段不表示已经读取其他段落，也不授予查询执行权。历史摘录需要当前版本重新核对。', '']
    lines += ['## 尾部排除规则', '',
              '排除重复回补的演练记录、待交付记录和质量状态未知记录。只对本轮演练生效，不能覆盖合成零售的订单退款率、支付客户数或金额单位。正文未提供的加工规则仍是缺口。', '']
    return '\n'.join(lines)


CSS = """
:root{color-scheme:light;--ink:#173148;--muted:#5d7182;--line:#d7e1e8;--accent:#176b70}*{box-sizing:border-box}body{margin:0;background:#f5f7f8;color:var(--ink);font:15px/1.75 system-ui,-apple-system,sans-serif}a{color:#126b78}main{max-width:1180px;margin:auto;padding:30px 28px 70px}header{padding:28px 0 24px;border-bottom:1px solid var(--line)}.eyebrow{font-size:12px;letter-spacing:.12em;color:var(--accent)}h1{font-size:34px;line-height:1.3;margin:12px 0}h2{font-size:21px}.lead{max-width:850px;color:var(--muted)}.stats{display:flex;flex-wrap:wrap;gap:12px;margin:22px 0}.stat{background:white;border:1px solid var(--line);padding:13px 18px;min-width:120px;border-radius:8px}.stat strong{font-size:25px;display:block;color:var(--accent)}.notice{padding:16px 20px;background:#eaf4f3;border-left:3px solid var(--accent);border-radius:3px;overflow-wrap:anywhere}.links{display:flex;flex-wrap:wrap;gap:16px;margin:18px 0}.toolbar{background:#fff;border:1px solid var(--line);border-radius:10px;padding:18px;margin:26px 0;display:grid;gap:14px}.filters{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}label{font-size:13px;color:var(--muted);display:grid;gap:5px}input,select,textarea,button{font:inherit}input,select,textarea{border:1px solid #b9c9d4;background:white;border-radius:5px;padding:9px;color:var(--ink);min-width:0;max-width:100%}button{border:1px solid #a6bcc8;border-radius:5px;padding:8px 13px;background:#fff;color:var(--ink);cursor:pointer}button:hover{background:#eaf3f4}.actions{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.progress{font-variant-numeric:tabular-nums;color:var(--muted);overflow-wrap:anywhere}.case{background:white;border:1px solid var(--line);border-radius:8px;margin:12px 0;scroll-margin-top:15px}.case summary{cursor:pointer;padding:17px 20px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;list-style:none;line-height:1.55}.case summary::-webkit-details-marker{display:none}.case summary::before{content:'+';color:var(--accent);font-size:19px}.case[open] summary::before{content:'−'}.cid{font-size:12px;color:var(--muted);min-width:32px}.title{font-weight:650;flex:1;min-width:150px}.tag{font-size:11px;border-radius:4px;padding:2px 7px;background:#eef3f6;color:#4d687a}.tag.mode-engineering{background:#fff1dc;color:#815610}.case-body{padding:0 22px 22px;overflow-wrap:anywhere}.meta{font-size:13px;color:var(--muted)}ol,ul{padding-left:23px}li+li{margin-top:7px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f3f6f8;border:1px solid #e2e9ee;border-radius:5px;padding:13px;font:13px/1.7 ui-monospace,SFMono-Regular,monospace;max-width:100%}.message{margin:15px 0}.message small{color:var(--muted)}.copy{padding:5px 10px;font-size:12px}.expect{padding:13px 17px;background:#edf5f8;border-left:3px solid #6093a7;margin:18px 0}.expect strong{font-size:13px}.record{display:grid;grid-template-columns:200px minmax(0,1fr);gap:13px;padding-top:15px;border-top:1px solid var(--line)}.record textarea{min-height:80px;resize:vertical;width:100%;font-size:13px}.note{font-size:13px;color:#6f6651}.empty{padding:28px;text-align:center;color:var(--muted)}[hidden]{display:none!important}:focus-visible{outline:3px solid #1b8390;outline-offset:3px}footer{font-size:13px;color:var(--muted);border-top:1px solid var(--line);padding-top:20px;margin-top:30px}
@media(max-width:650px){main{padding:18px 15px 45px}h1{font-size:27px}.filters{grid-template-columns:repeat(2,minmax(0,1fr))}.case summary{padding:15px}.case-body{padding:0 15px 18px}.record{grid-template-columns:1fr}.stat{padding:10px 14px;min-width:105px}.toolbar{padding:13px}.title{min-width:130px}}
@media print{body{background:white}.toolbar,.record,.copy{display:none}main{max-width:none;padding:0}.case{break-inside:avoid}details:not([open]) .case-body{display:block}}
"""


JS = """
const cases=JSON.parse(document.getElementById('case-data').textContent), states=JSON.parse(document.getElementById('state-data').textContent);
const cards=[...document.querySelectorAll('.case')], $=id=>document.getElementById(id); let records={};
function key(){return 'data-agent-dogfood-20261019:'+($('run-id').value.trim()||'unassigned')}
function load(){try{records=JSON.parse(localStorage.getItem(key())||'{}')}catch{records={}};for(const c of cards){const r=records[c.dataset.id]||{};c.querySelector('.status').value=states.includes(r.status)?r.status:'not_run';c.querySelector('textarea').value=r.notes||''}filter()}
function save(){for(const c of cards){records[c.dataset.id]={status:c.querySelector('.status').value,notes:c.querySelector('textarea').value}}try{localStorage.setItem(key(),JSON.stringify(records))}catch{$('message').textContent='浏览器未允许本地存储，请及时导出记录。'}filter()}
function filter(){const q=$('search').value.trim().toLowerCase(),g=$('group').value,m=$('mode').value,r=$('role').value,s=$('state').value;let visible=0;const counts=Object.fromEntries(states.map(x=>[x,0]));for(let i=0;i<cards.length;i++){const c=cards[i],data=cases[i],status=c.querySelector('.status').value;counts[status]++;const show=(!g||data.group===g)&&(!m||data.mode===m)&&(!r||data.roles.includes(r))&&(!s||status===s)&&(!q||JSON.stringify(data).toLowerCase().includes(q));c.hidden=!show;if(show)visible++} $('progress').textContent=`显示 ${visible}/160 · 未执行 ${counts.not_run} · 通过 ${counts.pass} · 失败 ${counts.fail} · 部分 ${counts.partial} · 环境阻塞 ${counts.blocked_environment} · 授权阻塞 ${counts.blocked_authorization} · 未定 ${counts.inconclusive}`;$('empty').hidden=visible!==0}
for(const id of ['search','group','mode','role','state'])$(id).addEventListener('input',filter);
$('run-id').addEventListener('change',load);for(const c of cards){c.querySelector('.status').addEventListener('change',save);c.querySelector('textarea').addEventListener('input',save)}
document.addEventListener('click',async e=>{const button=e.target.closest('[data-copy]');if(!button)return;const text=$(button.dataset.copy).textContent;try{await navigator.clipboard.writeText(text);button.textContent='已复制输入内容';setTimeout(()=>button.textContent='复制输入内容',1500)}catch{$('message').textContent='请选中这段输入内容复制；独立验收部分不要发送给产品模型。'}});
$('export').addEventListener('click',()=>{save();const data={schema:1,kind:'manual_notes',package_id:'data-agent-dogfood-20261019',run_id:$('run-id').value||null,exported_at:new Date().toISOString(),not_formal_evidence:true,note:'完整attempt/断言/证据请另写records/results-template.json；本文件只是手册笔记。',cases:cases.map(c=>({case_id:c.id,...records[c.id]}))};const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='dogfood-notes-'+($('run-id').value||'unassigned').replace(/[^a-zA-Z0-9_-]/g,'_')+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)});
$('expand').addEventListener('click',()=>cards.filter(c=>!c.hidden).forEach(c=>c.open=true));$('collapse').addEventListener('click',()=>cards.forEach(c=>c.open=false));load();
"""


def html_guide(cases: list[dict]) -> str:
    esc = html.escape
    options = lambda values: ''.join(f'<option value="{esc(key)}">{esc(label)}</option>' for key, label in values.items())
    output = ['<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
              '<title>Data Agent · 160项Dogfood试用包</title><link rel="icon" href="data:,"><style>' + CSS + '</style></head><body><main>',
              '<header><div class="eyebrow">DATA AGENT / DOGFOOD 2026-10-19</div><h1>把功能走完，把复杂问题问到底</h1>',
              '<p class="lead">160项逐步操作、独立预期和接续记录。先核对环境与授权，再按批执行。所有场景初始未测试，旧报告不继承通过。</p>',
              '<div class="stats"><div class="stat"><strong>120</strong>原场景保留</div><div class="stat"><strong>24</strong>修复与SDK回归</div><div class="stat"><strong>16</strong>复杂连续任务</div><div class="stat"><strong>43</strong>覆盖主题</div></div></header>',
              '<div class="links"><a href="START.md">开始与执行标准</a><a href="AGENT_PROMPT.md">给其他Agent的Prompt</a><a href="coverage.md">覆盖映射</a><a href="OPERATIONS.md">环境准备</a><a href="reference/GRADING.md">独立评分</a></div>',
              '<p class="notice">准备时入口 <a href="http://127.0.0.1:27173/#workbench">27173 工作台</a>：Flash/off、Mem0、词法检索。只确认Alice/Bob；Carol、Pro、混合检索与故障场景需另核前提。不要在用户当前环境做全量维护或故障注入。验收答案不能上传给产品Agent。</p>',
              '<section class="toolbar" aria-label="案例筛选"><label>本轮run_id<input id="run-id" value="" placeholder="填写本轮唯一名称，按名称分开保存笔记"></label>',
              '<label>查找案例<input id="search" type="search" placeholder="ID、标题、问题、预期或关键词"></label><div class="filters">',
              '<label>分组<select id="group"><option value="">全部分组</option>' + options(GROUP_NAMES) + '</select></label>',
              '<label>类型<select id="mode"><option value="">全部类型</option>' + options(MODE_NAMES) + '</select></label>',
              '<label>角色<select id="role"><option value="">全部角色</option><option value="bob">Bob</option><option value="carol">Carol</option><option value="alice">Alice</option></select></label>',
              '<label>记录状态<select id="state"><option value="">全部状态</option>' + options({state: state for state in STATES}) + '</select></label></div>',
              '<div class="actions"><button id="expand">展开筛选结果</button><button id="collapse">收起全部</button><button id="export">导出手册笔记</button></div>',
              '<div class="progress" id="progress" aria-live="polite"></div><div id="message" class="note" aria-live="polite"></div>',
              '<small>笔记只存在本浏览器。正式执行仍要保存results.json的attempt、逐条断言和证据。不要在笔记里填凭据。</small></section>',
              '<div id="empty" class="empty" hidden>没有符合筛选条件的场景。</div>']
    for case in cases:
        identifier = case['id']
        output += [f'<details class="case" id="{identifier}" data-id="{identifier}"><summary><span class="cid">{identifier}</span><span class="title">{esc(case["title"])}</span><span class="tag mode-{case["mode"]}">{MODE_NAMES[case["mode"]]}</span><span class="tag">{esc(", ".join(case["roles"]))}</span></summary><div class="case-body">',
                   f'<p class="meta">{esc(case["requires"])}<br>环境：{esc(case["environment"])}；前置产物：{esc(", ".join(case["depends_on"]) or "按步骤准备")}</p>', '<ol>']
        output += ['<li>' + esc(step) + '</li>' for step in case['steps']]
        output += ['</ol>']
        for number, message in enumerate(case['messages'], 1):
            mid = f'message-{identifier}-{number}'
            output += [f'<div class="message"><small>{esc(message["label"])}</small><pre id="{mid}">{esc(message["text"])}</pre><button class="copy" data-copy="{mid}">复制输入内容</button></div>']
        output += ['<div class="expect"><strong>独立验收 · 仅操作者核对，不发送给产品模型</strong><ul>']
        output += ['<li>' + esc(expected) + '</li>' for expected in case['expect']]
        output += ['</ul></div>']
        if case['reference_keys']:
            output += ['<p class="meta">参考键：' + esc(', '.join(case['reference_keys'])) + '</p>']
        if case['engineering_commands']:
            commands = '\n'.join(shlex.join(command) for command in case['engineering_commands'])
            output += ['<p class="note">补充工程命令，只在隔离环境；不替代真实模型。</p><pre>' + esc(commands) + '</pre>']
        output += ['<p class="meta">收尾：' + esc(case['cleanup']) + '</p>']
        output += ['<p class="note">' + esc(note) + '</p>' for note in case['notes']]
        output += ['<div class="record"><label>本轮状态<select class="status">' + options({state: state for state in STATES}) + '</select></label><label>步骤、问题和证据位置<textarea placeholder="写实际现象、没覆盖的分支与证据路径；不要只写正常。"></textarea></label></div></div></details>']
    output += ['<footer>资料准备不是业务通过。完整规范、独立来源、包指纹与结果模板均在同目录；当前状态只在仓库docs/CURRENT.md维护。</footer></main>']
    for name, value in [('case-data', cases), ('state-data', STATES)]:
        safe = json.dumps(value, ensure_ascii=False).replace('<', '\\u003c')
        output += [f'<script id="{name}" type="application/json">{safe}</script>']
    output += ['<script>' + JS + '</script></body></html>']
    return '\n'.join(output) + '\n'


def outputs(cases: list[dict], areas: list[dict]) -> dict[str, str]:
    return {'CASES.md': markdown_cases(cases), 'coverage.md': coverage_markdown(areas),
            'guide.html': html_guide(cases), 'records/results-template.json': json_text(result_template(cases)),
            'fixtures/long-note.md': long_note()}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--case', dest='case_id')
    parser.add_argument('--list', dest='group', nargs='?', const='all', choices=['all', *GROUP_NAMES])
    args = parser.parse_args()
    cases = read_json('scenarios.json')['cases']
    if args.case_id:
        selected = [case for case in cases if case['id'] == args.case_id]
        if not selected:
            parser.error('未知case_id')
        print(json_text(selected[0]), end='')
        return 0
    if args.group:
        for case in cases:
            if args.group in {'all', case['group']}:
                print(f'{case["id"]}\t{case["mode"]}\t{case["title"]}')
        return 0
    areas, manifest = read_json('coverage.json')['areas'], read_json('manifest.json')
    summary = validate(cases, areas, manifest)
    for name, content in outputs(cases, areas).items():
        path = BASE / name
        if args.check:
            assert path.is_file() and path.read_text() == content, f'生成材料过期: {name}'
        else:
            path.write_text(content)
    hashes = {path.relative_to(BASE).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
              for path in sorted(BASE.rglob('*')) if path.is_file() and path.name != 'manifest.json'
              and '__pycache__' not in path.parts}
    if args.check:
        assert hashes == manifest['files'], '包文件或指纹发生变化，请重新生成并核对'
    else:
        manifest['files'] = hashes
        (BASE / 'manifest.json').write_text(json_text(manifest))
    print(json.dumps({'passed': True, 'kind': 'preparation_only', **summary, 'files': len(hashes)}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (AssertionError, OSError, ValueError, KeyError, sqlite3.Error) as error:
        print(json.dumps({'passed': False, 'kind': 'preparation_only', 'error': str(error)}, ensure_ascii=False))
        sys.exit(1)
