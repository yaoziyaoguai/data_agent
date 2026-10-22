#!/usr/bin/env python3
"""从当前座舱知识允许清单生成目录；不读取种子、生成规范或验收答案。"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import sqlite3
from typing import Any

ROOT = Path(__file__).resolve().parent


def digest(body: str) -> str:
    return hashlib.sha256(body.encode('utf-8')).hexdigest()


def identifier(prefix: str, value: str) -> str:
    result = prefix + value
    if len(result) > 64:
        result = prefix + value[:36] + '-' + digest(value)[:12]
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', result):
        raise ValueError(f'不合法对象ID: {result}')
    return result


def entry(name: str, label: str, value: str, source: str, quote: str,
          location: str, structure: dict | None = None, **facts: Any) -> dict:
    body = {
        'entry_id': name, 'path': name, 'label': label,
        'source_facts': {'value': value, 'quote': quote, 'source_id': source, 'version': '1',
                         'location': location, 'complete': True,
                         'classification': 'source_text' if source in {'schema', 'etl'} else 'authored_definition',
                         **facts},
        'suggestion': {}, 'human_override': None, 'effective_value': value, 'review_state': 'unverified',
    }
    if structure is not None:
        body['source_facts']['structured_value'] = structure
        body['source_facts']['structured_evidence'] = [{'source_id': source, 'version': '1',
                                                       'location': location, 'quote': quote}]
        body['effective_structure'] = structure
    return body


def missing(name: str, label: str, source: str, gap: str) -> dict:
    return {'entry_id': name, 'path': name, 'label': label,
            'source_facts': {'source_id': source, 'version': '1', 'location': name,
                             'complete': False, 'gap': gap},
            'suggestion': {}, 'human_override': None, 'effective_value': '', 'review_state': 'unverified'}


def object_(ident: str, kind: str, name: str, entries: list[dict], source: str,
            related: list[str] | None = None) -> dict:
    return {'id': ident, 'kind': kind, 'name': name, 'version': '1', 'state': 'enabled',
            'entries': entries, 'related_ids': list(dict.fromkeys(related or [])),
            'source_id': source, 'source_version': '1', 'updated_by': 'synthetic-import'}


def read_sources(directory: Path, verify_hashes: bool = True) -> tuple[dict, dict[str, str]]:
    manifest = json.loads((directory / 'knowledge-manifest.json').read_text(encoding='utf-8'))
    names = manifest['knowledge_files']
    if manifest.get('synthetic') is not True or len(names) != len(set(names)):
        raise ValueError('知识清单必须显式标注synthetic，且不能重复文件')
    if not {'schema.sql', 'etl.sql', 'business-guide.md'} <= set(names):
        raise ValueError('缺少DDL、ETL或业务索引')
    if sum(name.startswith('documents/') for name in names) < 10:
        raise ValueError('独立业务文档不足10份')
    sources = {}
    for name in names:
        path = Path(name)
        if path.is_absolute() or '..' in path.parts or not (name in {'schema.sql', 'etl.sql', 'business-guide.md'}
                or (path.parent == Path('documents') and path.suffix == '.md')):
            raise ValueError(f'文件不是知识来源: {name}')
        sources[name] = (directory / name).read_text(encoding='utf-8')
    if set(manifest['source_ids']) != set(names) or len(set(manifest['source_ids'].values())) != len(names):
        raise ValueError('来源ID与允许文件必须一一对应')
    if any(source.startswith('document-') for source in manifest['source_ids'].values()):
        raise ValueError('原文source_id不能使用知识文档保留前缀document-')
    hashes = {name: digest(body) for name, body in sources.items()}
    if verify_hashes and manifest.get('knowledge_files_sha256') != hashes:
        raise ValueError('知识来源内容与清单指纹不一致')
    return manifest, sources


def definitions(sources: dict[str, str], manifest: dict) -> list[tuple[dict, str, str]]:
    result = []
    for name, body in sources.items():
        for match in re.finditer(r'(?m)^```semantic-definitions\n(.*?)\n```$', body, re.S):
            for line in match.group(1).splitlines():
                if line.strip():
                    value = json.loads(line)
                    result.append((value, manifest['source_ids'][name], line.strip()))
    return result


def etl_nodes(schema: str, etl: str) -> list[dict]:
    nodes = []
    for target, sql in re.findall(r'(?ms)^-- target: (\w+)\s*\n(.*?)^-- end-target\s*$', etl):
        reads: set[str] = set()
        db = sqlite3.connect(':memory:')
        try:
            db.executescript(schema)
            # 仅追踪加工输入，不把空库INSERT的外键核查误标为数据血缘。
            db.execute('PRAGMA foreign_keys = OFF')
            def record(action, first, _second, _database, _trigger):
                if action == sqlite3.SQLITE_READ:
                    reads.add(first)
                return sqlite3.SQLITE_OK
            db.set_authorizer(record)
            db.executescript(sql)
        finally:
            db.close()
        nodes.append({'target_table': target, 'upstream_tables': sorted(reads - {target}),
                      'sql': sql.rstrip(), 'source_id': 'etl', 'location': 'target: ' + target})
    if len({node['target_table'] for node in nodes}) != len(nodes):
        raise ValueError('ETL目标重复')
    return nodes


def table_ref(name: str) -> dict:
    return {'object_id': 'table-' + name, 'version': '1'}


def build_catalog(directory: Path = ROOT) -> dict:
    manifest, sources = read_sources(directory)
    source_by_id = {manifest['source_ids'][path]: body for path, body in sources.items()}
    schema = sources['schema.sql']
    table_ddls = {name: ddl for ddl, name in re.findall(r'(CREATE TABLE (\w+)\s*\(.*?\n\);)', schema, re.S)}
    if len(table_ddls) < 20:
        raise ValueError('实际表不足20张')
    db = sqlite3.connect(':memory:')
    try:
        db.executescript(schema)
        columns = {table: {row[1]: row for row in db.execute(f'PRAGMA table_info("{table}")')} for table in table_ddls}
        foreign_keys = {table: list(db.execute(f'PRAGMA foreign_key_list("{table}")')) for table in table_ddls}
        actual_unique_keys = {
            table: {tuple(row[2] for row in db.execute(f'PRAGMA index_info("{index[1]}")'))
                    for index in db.execute(f'PRAGMA index_list("{table}")')
                    if index[2] and index[3] != 'pk' and not index[4]}
            for table in table_ddls
        }
    finally:
        db.close()
    records = definitions(sources, manifest)
    tables = {r['table']: (r, source, quote) for r, source, quote in records if r['kind'] == 'table'}
    fields = {(r['table'], r['name']): (r, source, quote) for r, source, quote in records if r['kind'] == 'field'}
    metrics = [(r, source, quote) for r, source, quote in records if r['kind'] == 'metric']
    if len(tables) != sum(r['kind'] == 'table' for r, _, _ in records) or set(tables) != set(table_ddls):
        raise ValueError('表定义重复或没有覆盖所有实际表')
    if len(fields) != sum(r['kind'] == 'field' for r, _, _ in records) or set(fields) != {(t, c) for t in columns for c in columns[t]}:
        raise ValueError('字段定义重复或没有覆盖所有实际列')
    nodes = {node['target_table']: node for node in manifest.get('etl_nodes', [])}
    if set(nodes) != set(re.findall(r'(?im)^-- target: (\w+)\s*$', sources['etl.sql'])):
        raise ValueError('ETL节点元信息与实际加工目标不一致')
    result = []
    for table, (definition, source, quote) in tables.items():
        actual_primary = [name for name, row in sorted(columns[table].items(), key=lambda item: item[1][5]) if row[5]]
        if definition['primary_key'] != actual_primary:
            raise ValueError('文档主键与DDL不符: ' + table)
        if {tuple(key) for key in definition.get('unique_keys', [])} != actual_unique_keys[table]:
            raise ValueError('文档唯一键与DDL不符: ' + table)
        declared_keys = [definition['primary_key'], *definition.get('unique_keys', [])]
        structure = {'kind': 'table', 'grain': definition['grain'], 'unique_keys': declared_keys,
                     'time_columns': definition['time_columns'], 'default_filters': definition['default_filters'],
                     'constraints': definition.get('checks', [])}
        if any(c not in columns[table] for key in declared_keys for c in key):
            raise ValueError('唯一键引用不存在的列: ' + table)
        if any(t['column'] not in columns[table] for t in definition['time_columns']):
            raise ValueError('时间语义引用不存在的列: ' + table)
        description = definition['description'] + '\n\n行粒度：' + definition['grain'] + '\n时间口径：' + definition['time_basis']
        entries = [entry('description', '表含义', description, source, quote, table, structure),
                   entry('ddl', '表结构', table_ddls[table], 'schema', table_ddls[table], 'CREATE TABLE ' + table)]
        if table in nodes:
            node = nodes[table]
            if node['sql'] not in sources['etl.sql'] or not set(node['upstream_tables']) <= set(tables):
                raise ValueError('加工SQL或上游不是实际来源: ' + table)
            entries.append(entry('etl', '加工SQL', node['sql'], 'etl', node['sql'], node['location'],
                                 target_table=table, upstream_tables=node['upstream_tables']))
        else:
            entries.append(missing('etl', '加工SQL', 'schema', '这是合成源事实或维度；本包未提供上游生成程序作为知识，不能据此声称真实平台没有加工。'))
        result.append(object_('table-' + table, 'table', table, entries, 'schema'))
    for (table, name), (definition, source, quote) in fields.items():
        actual = columns[table][name]
        if actual[2].upper() != definition['type'].upper() or bool(actual[3]) == definition['nullable']:
            raise ValueError(f'文档类型/NULL与DDL不符: {table}.{name}')
        references = definition.get('references')
        actual_references = [(key[2], key[4]) for key in foreign_keys[table] if key[3] == name]
        if references and (references['table'], references['column']) not in actual_references:
            raise ValueError(f'文档外键与DDL不符: {table}.{name}')
        if actual_references and not references:
            raise ValueError(f'文档缺少外键: {table}.{name}')
        ddl_line = next(line.strip().rstrip(',') for line in table_ddls[table].splitlines()
                        if line.strip().startswith(name + ' '))
        structure = {'kind': 'field', 'table': table_ref(table), 'column': name, 'unit': definition.get('unit')}
        meaning = definition['meaning']
        if 'enum' in definition:
            meaning += '\n允许值：' + '、'.join(str(v) for v in definition['enum'])
        meaning += '\n空值：' + ('允许NULL；按以上字段含义解释，不能自动当成零或失败。' if definition['nullable'] else '不允许NULL。')
        entries = [entry('meaning', '字段含义', meaning, source, quote, table + '.' + name, structure,
                         table=table, column=name),
                   entry('type', '字段类型', ddl_line, 'schema', ddl_line, table + '.' + name,
                         table=table, column=name)]
        result.append(object_(identifier('field-', table.removeprefix('syn_') + '-' + name), 'field', table + '.' + name,
                              entries, source, ['table-' + table]))
    metric_ids = set()
    for definition, source, quote in metrics:
        ident = identifier('metric-', definition['id'])
        if ident in metric_ids:
            raise ValueError('指标ID重复: ' + ident)
        metric_ids.add(ident)
        if not set(definition['tables']) <= set(tables):
            raise ValueError('指标引用不存在的表: ' + ident)
        prose = definition['description']
        entries = [entry('definition', '指标口径', prose, source, quote, definition['id'], definition.get('structure')),
                   entry('aliases', '别名', '、'.join(definition['aliases']), source, quote, definition['id'])]
        if definition.get('sql'):
            sql = definition['sql']
            if sql not in source_by_id[source]:
                raise ValueError('指标SQL不是来源原文: ' + ident)
            entries.append(entry('sql', '计算SQL', sql, source, sql, definition['id']))
        result.append(object_(ident, 'metric', definition['name'], entries, source,
                              ['table-' + table for table in definition['tables']]))
    for name, body in sources.items():
        if not name.startswith('documents/'):
            continue
        title = next(line.removeprefix('# ').strip() for line in body.splitlines() if line.startswith('# '))
        source = manifest['source_ids'][name]
        related = ['table-' + table for table in tables if '`' + table + '`' in body]
        result.append(object_(identifier('document-', source), 'document', title,
                              [entry('body', '文档正文', body, source, body, '全文')], source, related))
    for table, keys in foreign_keys.items():
        groups: dict[int, list[tuple]] = {}
        for key in keys:
            groups.setdefault(key[0], []).append(key)
        for group in groups.values():
            group.sort(key=lambda key: key[1])
            target = group[0][2]
            join_keys = [{'left_column': k[3], 'right_column': k[4]} for k in group]
            left_names = [key['left_column'] for key in join_keys]
            record, source, quote = fields[(table, left_names[0])]
            unique_keys = [tables[table][0]['primary_key'], *tables[table][0].get('unique_keys', [])]
            cardinality = 'one_to_one' if any(set(left_names) == set(key) for key in unique_keys) else 'many_to_one'
            scope = '按声明外键关联；右侧主键/唯一键保证单个左侧非空引用至多匹配一行。可空引用保留未知，不用INNER JOIN静默丢弃。'
            structure = {'kind': 'relationship', 'left_table': table_ref(table), 'right_table': table_ref(target),
                         'join_keys': join_keys, 'cardinality': cardinality, 'scope': scope}
            text = '；'.join(f'{table}.{k["left_column"]} = {target}.{k["right_column"]}' for k in join_keys) + '\n' + scope
            signature = table + ':' + target + ':' + ','.join(left_names)
            result.append(object_(identifier('relationship-', signature.replace(':', '-').replace(',', '-')), 'relationship',
                                  table + ' → ' + target + '（' + ', '.join(left_names) + '）',
                                  [entry('join', '关联说明', text, source, quote, signature, structure)], source,
                                  ['table-' + table, 'table-' + target]))
    domain_quote = f'业务域标识：`{manifest["business_domain"]}`。'
    if domain_quote not in sources['business-guide.md']:
        raise ValueError('业务索引未声明统一业务域')
    ids = {obj['id'] for obj in result}
    if len(ids) != len(result):
        raise ValueError('目录对象ID重复')
    for obj in result:
        obj['entries'].append(entry('business_domain', '业务范围', manifest['business_domain'], 'business-guide',
                                    domain_quote, '业务域'))
        if not set(obj['related_ids']) <= ids:
            raise ValueError('对象关联缺失: ' + obj['id'])
        for item in obj['entries']:
            facts = item['source_facts']
            if facts.get('complete') and facts['quote'] not in source_by_id[facts['source_id']]:
                raise ValueError('来源引用不是原文: ' + obj['id'])
            if len(item['effective_value']) > 100000:
                raise ValueError('条目超过正文界限: ' + obj['id'])
    return {'synthetic': True, 'business_domain': manifest['business_domain'], 'primary_table': manifest['primary_table'],
            'source_files_sha256': {name: digest(body) for name, body in sources.items()},
            'source_bundle': [{'id': manifest['source_ids'][name], 'path': name, 'body': body, 'sha256': digest(body)}
                              for name, body in sources.items()],
            'objects': result}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--source-directory', type=Path, default=ROOT)
    args = parser.parse_args()
    try:
        if not args.check:
            manifest, sources = read_sources(args.source_directory, verify_hashes=False)
            manifest['knowledge_files_sha256'] = {name: digest(body) for name, body in sources.items()}
            manifest['etl_nodes'] = etl_nodes(sources['schema.sql'], sources['etl.sql'])
            (args.source_directory / 'knowledge-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        catalog = build_catalog(args.source_directory)
        content = json.dumps(catalog, ensure_ascii=False, indent=2) + '\n'
        destination = args.source_directory / 'semantic-catalog.json'
        if args.check:
            if not destination.exists() or destination.read_text(encoding='utf-8') != content:
                raise ValueError('目录与当前允许知识来源不同，请先更新生成物')
        else:
            destination.write_text(content, encoding='utf-8')
        kinds = {kind: sum(obj['kind'] == kind for obj in catalog['objects'])
                 for kind in ('table', 'field', 'metric', 'document', 'relationship')}
        print(json.dumps({'passed': True, 'objects': len(catalog['objects']), 'kinds': kinds,
                          'knowledge_sources': len(catalog['source_bundle']), 'mode': 'check' if args.check else 'generate'}, ensure_ascii=False))
        return 0
    except (OSError, ValueError, KeyError, StopIteration, sqlite3.Error) as error:
        print('座舱目录核对失败：' + str(error))
        return 1

if __name__ == '__main__':
    raise SystemExit(main())
