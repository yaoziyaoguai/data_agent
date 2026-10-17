#!/usr/bin/env python3
"""独立核验三个月分析资料；答案不进入模型允许列表。"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sqlite3
import subprocess
import sys

ROOT = Path(__file__).resolve().parent
PROJECT = ROOT.parents[2]


def build_database() -> sqlite3.Connection:
    connection = sqlite3.connect(':memory:')
    for name in ('schema.sql', 'seed.sql', 'etl.sql'):
        connection.executescript((ROOT / name).read_text(encoding='utf-8'))
    return connection


def verify() -> dict[str, object]:
    checks = []

    def compare(name: str, actual: object, expected: object) -> None:
        check = {'name': name, 'passed': actual == expected}
        if actual != expected:
            check.update(actual=actual, expected=expected)
        checks.append(check)

    for name, command in (
        ('seed_reproducible', [sys.executable, str(ROOT / 'generate.py'), '--check']),
        ('catalog_reproducible', [sys.executable, str(PROJECT / 'scripts/build_semantic_catalog.py'), '--source-directory', str(ROOT), '--check']),
    ):
        completed = subprocess.run(command, capture_output=True, text=True, timeout=30, check=False)
        compare(name, completed.returncode, 0)
    compare('same_five_table_ddl', hashlib.sha256((ROOT / 'schema.sql').read_bytes()).hexdigest(),
            hashlib.sha256((ROOT.parent / 'schema.sql').read_bytes()).hexdigest())
    manifest = json.loads((ROOT / 'knowledge-manifest.json').read_text(encoding='utf-8'))
    compare('knowledge_input_excludes_answers', sorted(manifest['knowledge_files']), ['business-guide.md', 'etl.sql', 'schema.sql'])
    compare('independent_materials_excluded', all(name in manifest['excluded_from_model_context'] for name in ('evaluation/**', 'verify.py', 'generate.py')), True)
    connection = build_database()
    try:
        def rows(sql: str) -> list[list[object]]:
            return [list(row) for row in connection.execute(sql)]

        compare('counts', rows('''SELECT (SELECT COUNT(*) FROM raw_order_lines),
          (SELECT COUNT(DISTINCT order_id) FROM raw_order_lines),
          (SELECT COUNT(*) FROM raw_payments), (SELECT COUNT(*) FROM demo_order_detail),
          (SELECT COUNT(*) FROM dim_customers),(SELECT COUNT(*) FROM customer_tags)'''), [[39, 30, 66, 39, 8, 8]])
        compare('foreign_keys', rows('PRAGMA foreign_key_check'), [])
        cases = json.loads((ROOT / 'evaluation/cases.json').read_text(encoding='utf-8'))['cases']
        for case in cases:
            cursor = connection.execute((ROOT / 'evaluation' / case['sql_file']).read_text(encoding='utf-8'))
            compare(case['id'], {'columns': [column[0] for column in cursor.description], 'rows': [list(row) for row in cursor.fetchall()]}, {'columns': case['columns'], 'rows': case['rows']})
        tagged_condition = "d.is_test=0 AND d.paid_amount_cents>0 AND d.paid_at>='2026-01-01T00:00:00Z' AND d.paid_at<'2026-04-01T00:00:00Z'"
        compare('quarter_tagged_dedup', rows(f'''SELECT COUNT(DISTINCT d.customer_id),SUM(d.paid_amount_cents-d.refunded_amount_cents)
          FROM demo_order_detail d WHERE {tagged_condition}
          AND EXISTS(SELECT 1 FROM customer_tags t WHERE t.customer_id=d.customer_id AND t.tag IN('vip','newsletter'))'''), [[5, 244250]])
        naive = rows(f'''SELECT SUM(d.paid_amount_cents-d.refunded_amount_cents) FROM demo_order_detail d
          JOIN customer_tags t ON t.customer_id=d.customer_id WHERE {tagged_condition} AND t.tag IN('vip','newsletter')''')[0][0]
        compare('many_tags_amplify_naive_join', naive > 244250, True)
        compare('raw_events_match_etl_amounts', rows('''WITH payments AS (
          SELECT order_id,line_id,SUM(CASE WHEN event_type='charge' THEN amount_cents ELSE 0 END) paid,
          SUM(CASE WHEN event_type='refund' THEN amount_cents ELSE 0 END) refunded
          FROM raw_payments WHERE event_status='success' AND event_at<'2026-04-04T00:00:00Z' GROUP BY order_id,line_id)
          SELECT d.order_id,d.line_id FROM demo_order_detail d LEFT JOIN payments p ON p.order_id=d.order_id AND p.line_id=d.line_id
          WHERE d.paid_amount_cents<>COALESCE(p.paid,0) OR d.refunded_amount_cents<>COALESCE(p.refunded,0)'''), [])
        baseline = rows('SELECT * FROM demo_order_detail ORDER BY order_id,line_id')
        connection.executescript((ROOT / 'etl.sql').read_text(encoding='utf-8'))
        compare('etl_repeatable', rows('SELECT * FROM demo_order_detail ORDER BY order_id,line_id'), baseline)
        compare('order_dimensions_consistent', rows('''SELECT order_id FROM raw_order_lines GROUP BY order_id
          HAVING COUNT(DISTINCT COALESCE(customer_id,'<anonymous>'))>1 OR COUNT(DISTINCT channel)>1 OR COUNT(DISTINCT is_test)>1'''), [])
    finally:
        connection.close()
    files = list(ROOT.glob('*.*')) + list((ROOT / 'evaluation').rglob('*.*'))
    return {'passed': all(check['passed'] for check in checks), 'checks': checks,
            'scope': '独立SQLite资料及参考核算；不证明模型理解、Agent规划或生产数据准确率',
            'fingerprints': {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest() for path in files if path.is_file()},
            'officialRequests': 0}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()
    result = verify()
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'passed': result['passed'], 'checks': len(result['checks']), 'officialRequests': 0}, ensure_ascii=False))
    for check in result['checks']:
        if not check['passed']:
            print(json.dumps(check, ensure_ascii=False, default=str))
    return 0 if result['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
