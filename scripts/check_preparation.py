#!/usr/bin/env python3
"""离线核对验收编号、预填引用和文档链接；不验证 Agent 或调用外部服务。"""

from __future__ import annotations

import json
import re
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[1]
SOURCES = ROOT / 'docs/sources'


def main() -> int:
    errors: list[str] = []
    checks = 0

    def check(condition: bool, label: str) -> None:
        nonlocal checks
        checks += 1
        if not condition:
            errors.append(label)

    manifest = json.loads((SOURCES / 'knowledge-manifest.json').read_text())
    knowledge = set(manifest['knowledge_files'])
    allowed = knowledge | set(manifest['optional_synthetic_data_files'])
    for name in allowed:
        path = (SOURCES / name).resolve()
        check(path.is_relative_to(SOURCES) and path.is_file(), f'知识文件不可读取：{name}')
        check('evaluation' not in path.relative_to(SOURCES).parts, f'答案进入知识允许列表：{name}')
    check('evaluation/**' in manifest['excluded_from_model_context'], '缺少验收答案排除规则')

    for filename, prefix, count in [('cases.json', 'Q', 13), ('behavior-cases.json', 'B', 8), ('prefill-cases.json', 'P', 5)]:
        document = json.loads((SOURCES / 'evaluation' / filename).read_text())
        ids = [case['id'] for case in document['cases']]
        check(len(ids) == len(set(ids)), f'{filename} 编号重复')
        check(set(ids) == {f'{prefix}{i:02}' for i in range(1, count + 1)}, f'{filename} 编号范围改变，请同步映射')
        if prefix == 'Q':
            for case in document['cases']:
                sql_path = (SOURCES / 'evaluation' / case['sql_file']).resolve()
                check(sql_path.is_relative_to(SOURCES / 'evaluation') and sql_path.is_file(), f'{case["id"]} 缺参考 SQL')

    prefill = json.loads((SOURCES / 'evaluation/prefill-cases.json').read_text())
    check(set(prefill['knowledge_inputs']) <= knowledge, '预填使用了非默认知识输入')
    check(prefill['evaluation_only'] is True, '预填参考必须标记为验收专用')
    source_quotes = 0
    for case in prefill['cases']:
        for field in ['required_facts', 'unknowns', 'forbidden_claims', 'manual_override']:
            check(bool(case.get(field)), f'{case["id"]} 缺 {field}')
        for statement in case['required_facts'] + case['unknowns']:
            check(bool(statement.get('sources')), f'{case["id"]} 有无出处的参考')
            for source in statement['sources']:
                source_quotes += 1
                name = source['file']
                valid = name in knowledge and bool(source['quote'])
                check(valid and source['quote'] in (SOURCES / name).read_text(), f'{case["id"]} 原文引用失效：{name}')

    design = (ROOT / 'docs/semantic-retrieval-design.md').read_text()
    scenario_ids = re.findall(r'^\| (S\d{2}) /', design, flags=re.M)
    check(scenario_ids == [f'S{i:02}' for i in range(1, 6)], '起步流程必须唯一使用 S01–S05')
    check(not re.search(r'^\| B\d{2} /', design, flags=re.M), '设计重新占用了行为题 B 编号')

    link_count = 0
    for relative in ['README.md', 'docs/CURRENT.md', 'docs/development.md', 'docs/semantic-retrieval-design.md', 'docs/mvp-readiness-audit-20261002.md', 'docs/sources/README.md']:
        path = ROOT / relative
        for raw in re.findall(r'\]\(([^)]+)\)', path.read_text()):
            target = unquote(raw)
            if re.match(r'^[a-zA-Z][a-zA-Z0-9+.-]*:', target):
                continue
            rel, _, anchor = target.partition('#')
            dest = (path.parent / rel).resolve() if rel else path
            link_count += 1
            check(dest.is_relative_to(ROOT) and dest.exists(), f'{relative} 失效链接：{raw}')
            if anchor and dest.is_file() and dest.suffix == '.md':
                headings = re.findall(r'^#+\s+(.+)$', dest.read_text(), flags=re.M)
                slugs = {re.sub(r'[^\w\-\s]', '', heading.lower()).replace(' ', '-') for heading in headings}
                check(anchor in slugs, f'{relative} 失效标题：{raw}')

    print(json.dumps({'status': 'failed' if errors else 'passed', 'checks': checks, 'source_quotes': source_quotes,
                      'document_links': link_count, 'scope': '准备材料静态核对；不包含 Agent 行为、预填生成或模型接入', 'errors': errors}, ensure_ascii=False))
    return int(bool(errors))


if __name__ == '__main__':
    raise SystemExit(main())
