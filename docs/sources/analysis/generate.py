#!/usr/bin/env python3
"""生成独立分析用的虚构种子；--check 只核对文件，不写入。"""

from __future__ import annotations

import argparse
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CUSTOMERS = (
    ('C2001', '合成客户甲', 'east'), ('C2002', '合成客户乙', 'west'),
    ('C2003', '合成客户丙', 'east'), ('C2004', '合成客户丁', 'north'),
    ('C2005', '合成客户戊', 'south'), ('C2006', '合成客户己', 'west'),
    ('C2007', '合成客户庚', None), ('C2008', '合成客户辛', 'north'),
)
TAGS = (
    ('C2001', 'vip'), ('C2001', 'newsletter'), ('C2002', 'newsletter'),
    ('C2003', 'vip'), ('C2005', 'newsletter'),
    ('C2006', 'vip'), ('C2006', 'newsletter'), ('C2008', 'new_customer'),
)
# 只在种子生成中保存数值安排，业务知识不包含生成情节或参考结论。
MONTHS = (
    ('2026-01', (60000, 30000, 20000), (5000, 2000, 1000),
     ('2026-02-06', '2026-01-28', '2026-03-06'),
     (('C2001', 'C2002', 'C2003'), ('C2001', 'C2004', 'C2005'), ('C2006', 'C2007', None))),
    ('2026-02', (42000, 55000, 25000), (3000, 4000, 2000),
     ('2026-03-09', '2026-03-14', '2026-02-24'),
     (('C2001', 'C2002', 'C2008'), ('C2003', 'C2004', 'C2005'), ('C2001', 'C2006', 'C2007'))),
    ('2026-03', (50000, 65000, 28000), (5000, 3000, 1000),
     ('2026-04-01', '2026-03-26', '2026-04-02'),
     (('C2001', 'C2002', 'C2003'), ('C2004', 'C2005', 'C2008'), ('C2001', 'C2006', None))),
)


def literal(value: object) -> str:
    if value is None:
        return 'NULL'
    if isinstance(value, int):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def insert(table: str, row: tuple[object, ...]) -> str:
    return f'INSERT INTO {table} VALUES ({", ".join(literal(value) for value in row)});'


def render_seed() -> str:
    statements = ['-- 从零构造的独立三个月零售数据；金额为整数分，时间为UTC。', 'BEGIN;']
    statements.extend(insert('dim_customers', customer) for customer in CUSTOMERS)
    statements.extend(insert('customer_tags', tag) for tag in TAGS)
    for month, gross_values, refunds, refund_dates, customer_groups in MONTHS:
        for channel_index, channel in enumerate(('web', 'app', 'store')):
            gross = gross_values[channel_index]
            order_amounts = (gross * 40 // 100, gross * 35 // 100, gross - gross * 40 // 100 - gross * 35 // 100)
            for order_index, order_amount in enumerate(order_amounts):
                order = f'A{month.replace("-", "")}_{channel}_{order_index + 1}'
                day = (8, 15, 22)[order_index]
                ordered_at = f'{month}-{day:02}T08:00:00Z'
                amounts = (order_amount * 60 // 100, order_amount - order_amount * 60 // 100) if order_index == 0 else (order_amount,)
                for line, amount in enumerate(amounts, 1):
                    statements.append(insert('raw_order_lines', (order, line, customer_groups[channel_index][order_index], f'P{channel_index + 1}{line}', line, ordered_at, channel, 0, 'placed')))
                    charges = (amount * 30 // 100, amount - amount * 30 // 100) if order_index == 1 else (amount,)
                    for event, charge in enumerate(charges, 1):
                        statements.append(insert('raw_payments', (f'{order}_{line}_charge_{event}', order, line, 'charge', charge, f'{month}-{day:02}T{8 + event:02}:05:00Z', 'success')))
                    if order_index == 0 and line == 1:
                        statements.append(insert('raw_payments', (f'{order}_refund', order, line, 'refund', refunds[channel_index], refund_dates[channel_index] + 'T12:00:00Z', 'success')))
                    if order_index == 1:
                        statements.append(insert('raw_payments', (f'{order}_failed', order, line, 'charge', 900, f'{month}-{day:02}T08:01:00Z', 'failed')))
    for order, month, customer, channel, status, is_test, amount, payment_status in (
        ('ATest', '2026-01', 'C2001', 'app', 'placed', 1, 77777, 'success'),
        ('AUnpaid', '2026-02', 'C2008', 'web', 'placed', 0, 3000, 'pending'),
        ('ACancelled', '2026-03', 'C2007', 'store', 'cancelled', 0, 2500, 'failed'),
    ):
        statements.append(insert('raw_order_lines', (order, 1, customer, 'PBoundary', 1, month + '-10T08:00:00Z', channel, is_test, status)))
        statements.append(insert('raw_payments', (order + '_charge', order, 1, 'charge', amount, month + '-10T09:00:00Z', payment_status)))
    statements.append('COMMIT;')
    return '\n'.join(statements) + '\n'


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    destination = ROOT / 'seed.sql'
    expected = render_seed()
    if args.check:
        matches = destination.exists() and destination.read_text(encoding='utf-8') == expected
        print('analysis seed reproducible' if matches else 'analysis seed differs')
        return 0 if matches else 1
    destination.write_text(expected, encoding='utf-8')
    print('analysis seed generated')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
