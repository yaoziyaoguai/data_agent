"""核对模块设计覆盖、文档引用与生成图来源；不验证尚未实现的业务。"""
from pathlib import Path
import hashlib
import json
import re
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / 'docs/architecture'
names = ['implementation-design.md', 'implementation-views.md', 'knowledge-modules.md', 'runtime-modules.md']
documents = {name: (BASE / name).read_text() for name in names}
links = 0
for name, text in documents.items():
    assert not any(line.rstrip() != line for line in text.splitlines()), name
    assert not re.search(r'^(<<<<<<<|=======|>>>>>>>)', text, re.M), name
    for raw in re.findall(r'\]\(([^)]+)\)', text):
        if re.match(r'^[a-zA-Z][a-zA-Z0-9+.-]*:', raw):
            continue
        rel, _, anchor = unquote(raw).partition('#')
        target = (BASE / rel).resolve() if rel else BASE / name
        assert target.is_relative_to(ROOT) and target.exists(), (name, raw)
        if anchor and target.suffix == '.md':
            headings = re.findall(r'^#+\s+(.+)$', target.read_text(), re.M)
            slugs = {re.sub(r'[^\w\-\s]', '', s.lower()).replace(' ', '-') for s in headings}
            assert anchor in slugs, (name, raw)
        links += 1

modules = []
graph_sources = {}
for name, text in documents.items():
    modules.extend(re.findall(r'^## (?:\d+\. )?(M\d{2})\b', text, re.M))
    for match in re.finditer(r'```mermaid\n([\s\S]*?)```', text):
        heading = re.findall(r'^#{2,3} (.+)$', text[:match.start()], re.M)[-1]
        graph_id = re.match(r'([VFS]\d{2})\b', heading)
        assert graph_id, (name, heading)
        graph_id = graph_id[1]
        assert graph_id not in graph_sources, graph_id
        graph_sources[graph_id] = match[1]
expected_modules = [f'M{i:02}' for i in range(1, 13)]
assert sorted(modules) == expected_modules, modules
expected_graphs = {f'{prefix}{i:02}' for prefix, count in [('V', 3), ('F', 13), ('S', 12)] for i in range(1, count + 1)}
assert set(graph_sources) == expected_graphs, set(graph_sources) ^ expected_graphs

# V02 使用显式节点与依赖边，检测声明出的图中是否有循环。
edges = re.findall(r'^\s*(\w+)(?:\[.*?\])?\s*-->\s*(\w+)', graph_sources['V02'], re.M)
assert len(edges) >= 10
adj = {}
for a, b in edges:
    adj.setdefault(a, []).append(b)
visited, visiting = set(), set()
def visit(node):
    assert node not in visiting, f'V02 循环依赖：{node}'
    if node in visited:
        return
    visiting.add(node)
    for child in adj.get(node, []):
        visit(child)
    visiting.remove(node)
    visited.add(node)
for node in adj:
    visit(node)

report = json.loads((BASE / 'implementation-diagram-checks.json').read_text())
assert report['status'] == 'passed'
assert {d['id'] for d in report['diagrams']} == expected_graphs
for name, digest in report['sources'].items():
    assert hashlib.sha256((BASE / name).read_bytes()).hexdigest() == digest, f'{name} 图册已过期'
for graph_id in expected_graphs:
    assert (BASE / 'module-diagrams' / f'{graph_id}.svg').is_file(), graph_id
print(json.dumps({'status': 'passed', 'modules': len(modules), 'diagrams': len(expected_graphs), 'local_links': links,
                  'dependency_edges': len(edges), 'scope': '文档覆盖/链接/图来源和声明依赖无环；不证明实际代码边界'}, ensure_ascii=False))
