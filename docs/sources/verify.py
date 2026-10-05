#!/usr/bin/env python3
"""在内存中验证合成数据、加工和参考查询；不调用 Agent 或外部服务。"""

from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def build_database() -> sqlite3.Connection:
    connection = sqlite3.connect(':memory:')
    for name in ('schema.sql', 'seed.sql', 'etl.sql'):
        connection.executescript((ROOT / name).read_text(encoding='utf-8'))
    return connection


def rows(connection: sqlite3.Connection, sql: str) -> list[list[object]]:
    return [list(row) for row in connection.execute(sql).fetchall()]


def verify() -> dict[str, object]:
    cases = json.loads((ROOT / 'evaluation/cases.json').read_text(encoding='utf-8'))['cases']
    checks: list[dict[str, object]] = []

    def compare(check_id: str, actual: object, expected: object) -> None:
        passed = actual == expected
        check: dict[str, object] = {'id': check_id, 'passed': passed}
        if not passed:
            check.update(actual=actual, expected=expected)
        checks.append(check)

    connection = build_database()
    try:
        for case in cases:
            cursor = connection.execute((ROOT / 'evaluation' / case['sql_file']).read_text(encoding='utf-8'))
            actual_columns = [column[0] for column in cursor.description]
            actual_rows = [list(row) for row in cursor.fetchall()]
            compare(case['id'], {'columns': actual_columns, 'rows': actual_rows},
                    {'columns': case['expected_columns'], 'rows': case['expected_rows']})

        compare('I01_counts', rows(connection, '''SELECT
            (SELECT COUNT(*) FROM raw_order_lines),
            (SELECT COUNT(DISTINCT order_id) FROM raw_order_lines),
            (SELECT COUNT(*) FROM raw_payments),
            (SELECT COUNT(*) FROM demo_order_detail),
            (SELECT COUNT(*) FROM dim_customers),
            (SELECT COUNT(*) FROM customer_tags)'''), [[15, 13, 20, 15, 7, 8]])
        compare('I02_foreign_keys', rows(connection, 'PRAGMA foreign_key_check'), [])
        compare('I03_line_payment_aggregation', rows(connection, '''SELECT
            paid_amount_cents, refunded_amount_cents, paid_at FROM demo_order_detail
            WHERE order_id = 'O1001' AND line_id = 1'''), [[2000, 0, '2026-01-05T08:05:00Z']])
        compare('I04_cancelled_unpaid_full_refund', rows(connection, '''SELECT order_id,
            paid_amount_cents, refunded_amount_cents, paid_at, order_status
            FROM demo_order_detail WHERE order_id IN ('O1004', 'O1005', 'O1006') ORDER BY order_id'''),
            [['O1004', 2500, 2500, '2026-01-10T10:05:00Z', 'refunded'],
             ['O1005', 0, 0, None, 'cancelled'], ['O1006', 0, 0, None, 'unpaid']])
        compare('I05_unknown_customer_region', rows(connection, '''SELECT order_id, customer_id, region
            FROM demo_order_detail WHERE order_id IN ('O1008', 'O1012') ORDER BY order_id'''),
            [['O1008', None, None], ['O1012', 'C006', None]])
        compare('I06_failed_payment_ignored', rows(connection, '''SELECT paid_amount_cents
            FROM demo_order_detail WHERE order_id = 'O1003' '''), [[4000]])
        compare('I07_order_dimensions_consistent', rows(connection, '''SELECT order_id
            FROM raw_order_lines GROUP BY order_id
            HAVING COUNT(DISTINCT COALESCE(customer_id, '<anonymous>')) > 1
               OR COUNT(DISTINCT ordered_at) > 1 OR COUNT(DISTINCT channel) > 1
               OR COUNT(DISTINCT is_test) > 1 OR COUNT(DISTINCT source_status) > 1'''), [])

        baseline = rows(connection, 'SELECT * FROM demo_order_detail ORDER BY order_id, line_id')
        connection.executescript((ROOT / 'etl.sql').read_text(encoding='utf-8'))
        compare('I08_etl_repeatable', rows(connection, 'SELECT * FROM demo_order_detail ORDER BY order_id, line_id'), baseline)

        # 截止时点上的事件应被排除，不能把右开区间写成包含端点。
        connection.execute("INSERT INTO raw_payments VALUES ('BOUNDARY', 'O1010', 1, 'refund', 100, '2026-02-04T00:00:00Z', 'success')")
        connection.commit()
        connection.executescript((ROOT / 'etl.sql').read_text(encoding='utf-8'))
        compare('I09_snapshot_excludes_boundary', rows(connection, 'SELECT * FROM demo_order_detail ORDER BY order_id, line_id'), baseline)

        # 反例确认：错误 JOIN 会放大金额，避免样例过于简单而掩盖缺陷。
        bad_join = rows(connection, '''SELECT SUM(d.paid_amount_cents - d.refunded_amount_cents)
            FROM demo_order_detail AS d JOIN customer_tags AS t ON d.customer_id = t.customer_id
            WHERE d.paid_at >= '2026-01-01T00:00:00Z' AND d.paid_at < '2026-02-01T00:00:00Z'
              AND d.is_test = 0 AND t.tag IN ('vip', 'newsletter')''')
        compare('I10_join_counterexample', bad_join, [[18200]])
        compare('I11_main_field_count', len(rows(connection, 'PRAGMA table_info(demo_order_detail)')), 13)
    finally:
        connection.close()

    source_files = [ROOT / name for name in ('schema.sql', 'seed.sql', 'etl.sql', 'business-guide.md', 'knowledge-manifest.json', 'verify.py')]
    source_files.extend(sorted((ROOT / 'evaluation').glob('*.json')))
    source_files.extend(sorted((ROOT / 'evaluation/queries').glob('*.sql')))
    fingerprints = {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest()
                    for path in source_files if path.name != 'verification.json'}
    return {
        'verified_at_utc': datetime.now(timezone.utc).isoformat(),
        'environment': {'python': sys.version.split()[0], 'sqlite': sqlite3.sqlite_version, 'database': 'in_memory'},
        'scope': '合成数据、SQLite加工、13条参考SQL及11项边界检查；不包含Agent行为或模型接入',
        'status': 'passed' if all(check['passed'] for check in checks) else 'failed',
        'checks_passed': sum(bool(check['passed']) for check in checks),
        'checks_total': len(checks),
        'checks': checks,
        'file_sha256': fingerprints,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report', type=Path, help='将本次验证结果写入指定 JSON 文件')
    args = parser.parse_args()
    report = verify()
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({key: report[key] for key in ('status', 'checks_passed', 'checks_total', 'environment', 'scope')}, ensure_ascii=False))
    for check in report['checks']:
        if not check['passed']:
            print(json.dumps(check, ensure_ascii=False))
    return 0 if report['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
