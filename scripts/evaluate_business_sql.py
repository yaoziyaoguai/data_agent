#!/usr/bin/env python3
"""独立核算模型生成SQL；只在验收端读取标准答案，不进入Agent上下文。"""
import json
import math
from pathlib import Path
import re
import sqlite3
import sys

ROOT = Path(__file__).resolve().parents[1]
READ_ACTIONS = {sqlite3.SQLITE_SELECT, sqlite3.SQLITE_READ, sqlite3.SQLITE_FUNCTION, sqlite3.SQLITE_RECURSIVE}


def read_query(db, sql, parameters=None):
    db.set_authorizer(lambda action, *_: sqlite3.SQLITE_OK if action in READ_ACTIONS else sqlite3.SQLITE_DENY)
    cursor = db.execute(sql, parameters or {})
    return [list(row) for row in cursor.fetchall()], [v[0] for v in cursor.description]


def customer_expectation(db, columns, known):
    """主指标及可选匿名边界逐列绑定；不能扫描哪列恰好等于参考数。"""
    anonymous, _ = read_query(db, """SELECT COUNT(DISTINCT order_id), COUNT(*) FROM demo_order_detail
        WHERE customer_id IS NULL AND is_test=0 AND paid_amount_cents>0
          AND paid_at>='2026-01-01T00:00:00Z' AND paid_at<'2026-02-01T00:00:00Z'""")
    if len(columns) == 1:
        return [[known]]
    expected, roles = [], set()
    for column in columns:
        name = column.lower()
        if re.search(r'unknown|anonymous|未知|匿名', name):
            if re.search(r'^(has|any|exists)_(unknown|anonymous)', name):
                role, value = 'anonymous_present', int(anonymous[0][1] > 0)
            elif re.search(r'order|订单', name):
                role, value = 'anonymous_orders', anonymous[0][0]
            elif re.search(r'line|row|行', name):
                role, value = 'anonymous_lines', anonymous[0][1]
            else:
                return None
        elif re.search(r'customer|客户|^uv$', name):
            role, value = 'known_customers', known
        else:
            return None
        if role in roles:
            return None
        roles.add(role)
        expected.append(value)
    return [expected] if 'known_customers' in roles else None


def customer_variations(db):
    """独立改变客户去重和匿名粒度；参考SQL不来自模型输出。"""
    cursor = db.execute("SELECT * FROM demo_order_detail WHERE is_test=0 AND paid_amount_cents>0 AND customer_id IS NOT NULL LIMIT 1")
    template = dict(zip((v[0] for v in cursor.description), cursor.fetchone()))
    variations = [
        ('anonymous_order_with_two_lines', [{'order_id': 'evaluation-anonymous', 'line_id': line, 'customer_id': None} for line in (1, 2)]),
        ('existing_customer_new_order', [{'order_id': 'evaluation-existing'}]),
        ('new_known_customer', [{'order_id': 'evaluation-known', 'customer_id': 'evaluation-customer'}]),
        ('test_customer_excluded', [{'order_id': 'evaluation-test', 'customer_id': 'evaluation-test-customer', 'is_test': 1}]),
        ('outside_period_excluded', [{'order_id': 'evaluation-outside', 'customer_id': None, 'paid_at': '2026-03-01T00:00:00Z'}]),
    ]
    for name, additions in variations:
        db.set_authorizer(None)
        for patch in additions:
            row = {**template, 'paid_amount_cents': 100, 'refunded_amount_cents': 0, 'order_status': 'paid', 'paid_at': '2026-01-15T12:00:00Z', 'order_date': '2026-01-15', **patch}
            db.execute('INSERT INTO demo_order_detail (' + ','.join(row) + ') VALUES (' + ','.join('?' for _ in row) + ')', tuple(row.values()))
        yield name
    db.set_authorizer(None)
    db.execute('DELETE FROM demo_order_detail WHERE customer_id IS NULL')
    yield 'no_anonymous_customers'
    db.set_authorizer(None)
    for patch in ({'order_id':'evaluation-anonymous-test-only','is_test':1}, {'order_id':'evaluation-anonymous-outside-only','paid_at':'2026-03-01T00:00:00Z'}):
        row={**template,'customer_id':None,'paid_amount_cents':100,'refunded_amount_cents':0,'order_status':'paid','paid_at':'2026-01-15T12:00:00Z',**patch}
        db.execute('INSERT INTO demo_order_detail ('+','.join(row)+') VALUES ('+','.join('?' for _ in row)+')',tuple(row.values()))
    yield 'only_test_or_outside_anonymous_customers'


def refund_expectation(db, case_id, columns):
    """比率及可选分子/分母按列含义核算，列序不由参考SQL限定。"""
    start,end=('2026-03-01T00:00:00Z','2026-04-01T00:00:00Z') if case_id=='Q10' else ('2026-01-01T00:00:00Z','2026-02-01T00:00:00Z')
    if case_id=='Q05':
        values,_=read_query(db,'SELECT SUM(refunded_amount_cents),SUM(paid_amount_cents) FROM demo_order_detail WHERE is_test=0 AND paid_amount_cents>0 AND paid_at>=:start AND paid_at<:end',{'start':start,'end':end})
        numerator,denominator=values[0]
    else:
        # 独立按集合定义核算，不复用被检SQL或参考SQL的聚合结构。
        rows,_=read_query(db,'SELECT order_id,paid_amount_cents,refunded_amount_cents,paid_at FROM demo_order_detail WHERE is_test=0')
        paid_orders={order for order,paid,_,time in rows if paid>0 and time is not None and start<=time<end}
        refunded_orders={order for order,_,refunded,_ in rows if refunded>0}
        numerator,denominator=len(paid_orders & refunded_orders),len(paid_orders)
    ratio=numerator/denominator if denominator else None
    if len(columns)==1:return [[ratio]]
    expected,roles=[],set()
    for column in columns:
        name=column.lower()
        if re.search(r'ratio|rate|比例|率',name):role,value='ratio',ratio
        elif re.search(r'refund|退款|分子',name):role,value='numerator',numerator
        elif re.search(r'paid|paying|payment|支付|付款|分母',name):role,value='denominator',denominator
        else:return None
        if role in roles:return None
        roles.add(role);expected.append(value)
    return [expected] if 'ratio' in roles else None


def refund_variations(db, case_id):
    db.set_authorizer(None)
    cursor=db.execute('SELECT * FROM demo_order_detail WHERE is_test=0 AND paid_amount_cents>0 LIMIT 1')
    template=dict(zip((v[0] for v in cursor.description),cursor.fetchone()))
    month='2026-03' if case_id=='Q10' else '2026-01'
    for name,paid,refunded in [('new_paid_order',1000,0),('new_fully_refunded_order',100,100)]:
        db.set_authorizer(None)
        row={**template,'order_id':'evaluation-ratio-'+name,'line_id':1,'paid_amount_cents':paid,'refunded_amount_cents':refunded,'paid_at':month+'-15T12:00:00Z','order_date':month+'-15','order_status':'refunded' if refunded else 'paid'}
        db.execute('INSERT INTO demo_order_detail ('+','.join(row)+') VALUES ('+','.join('?' for _ in row)+')',tuple(row.values()))
        yield name
    outside='2026-04' if case_id=='Q10' else '2026-02'
    for name,patches in [
        ('same_order_other_month_refund', [
            {'order_id':'evaluation-cross-line-month','line_id':1,'refunded_amount_cents':0,'paid_at':month+'-10T12:00:00Z'},
            {'order_id':'evaluation-cross-line-month','line_id':2,'refunded_amount_cents':100,'paid_at':outside+'-02T12:00:00Z'},
        ]),
        ('refunded_order_outside_paid_set', [
            {'order_id':'evaluation-outside-refund','line_id':1,'refunded_amount_cents':100,'paid_at':outside+'-02T12:00:00Z'},
        ]),
    ]:
        db.set_authorizer(None)
        for patch in patches:
            row={**template,'paid_amount_cents':100,'order_date':month+'-05','order_status':'paid',**patch}
            db.execute('INSERT INTO demo_order_detail ('+','.join(row)+') VALUES ('+','.join('?' for _ in row)+')',tuple(row.values()))
        yield name
    db.set_authorizer(None)
    db.execute('DELETE FROM demo_order_detail WHERE substr(paid_at,1,7)=?',(month,))
    yield 'zero_denominator'


def refund_rows_match(actual,expected,columns):
    if expected is None or len(actual)!=1 or len(actual[0])!=len(expected[0]):return False
    ratio_index=0 if len(columns)==1 else next((i for i,c in enumerate(columns) if re.search(r'ratio|rate|比例|率',c.lower())),None)
    if ratio_index is None:return False
    empty=expected[0][ratio_index] is None
    for index,(value,wanted) in enumerate(zip(actual[0],expected[0])):
        if index==ratio_index and isinstance(value,(int,float)) and isinstance(wanted,(int,float)):
            # 独立Q05参考保留四位小数；只对比率允许半个末位误差，金额和计数仍精确。
            if not math.isclose(value,wanted,rel_tol=0,abs_tol=0.00005+1e-12):return False
        elif empty and index!=ratio_index and wanted in (0,None):
            # 空集SUM返回NULL，COUNT返回0；两者都不能把主比率改成0。
            if value not in (0,None):return False
        elif value!=wanted:return False
    return True


def net_revenue_expectation(db, columns, channel, tagged=False):
    tags = " AND EXISTS (SELECT 1 FROM customer_tags t WHERE t.customer_id=demo_order_detail.customer_id AND t.tag IN ('vip','newsletter'))" if tagged else ''
    amounts, _ = read_query(db, """SELECT SUM(paid_amount_cents), SUM(refunded_amount_cents),
        SUM(paid_amount_cents-refunded_amount_cents) FROM demo_order_detail
        WHERE is_test=0 AND paid_amount_cents>0
          AND paid_at>='2026-01-01T00:00:00Z' AND paid_at<'2026-02-01T00:00:00Z'
          AND (:channel IS NULL OR channel=:channel)""" + tags, {'channel': channel})
    paid, refunded, net = amounts[0]
    def displayed(value, name):
        # 只按明确单位名称换算，不能因为某一列数值碰巧等于答案就选中它。
        yuan = re.search(r'yuan|rmb|cny|元', name.lower()) is not None
        return (value / 100 if value is not None else None) if yuan else value
    if len(columns) == 1:
        return [[displayed(net, columns[0])]]
    expected, roles = [], set()
    for column in columns:
        name = column.lower()
        if re.search(r'net|revenue|净收入', name): role, value = 'net', net
        elif re.search(r'refund|退款', name): role, value = 'refund', refunded
        elif re.search(r'paid|payment|支付|付款', name): role, value = 'paid', paid
        else: return None
        unit = 'yuan' if re.search(r'yuan|rmb|cny|元', name) else 'cents'
        key = (role, unit)
        if key in roles: return None
        roles.add(key)
        expected.append(displayed(value, name))
    return [expected] if any(role == 'net' for role, _ in roles) else None


def net_revenue_variations(db):
    db.set_authorizer(None)
    cursor = db.execute('SELECT * FROM demo_order_detail WHERE is_test=0 AND paid_amount_cents>0 LIMIT 1')
    template = dict(zip((v[0] for v in cursor.description), cursor.fetchone()))
    variations = [(c + '_new_order', {'channel': c}) for c in ('web', 'app', 'store')]
    variations += [('outside_period', {'paid_at': '2026-03-01T00:00:00Z'}), ('test_excluded', {'is_test': 1})]
    for name, patch in variations:
        db.set_authorizer(None)
        row = {**template, 'order_id': 'evaluation-net-'+name, 'line_id': 1,
               'paid_amount_cents': 900, 'refunded_amount_cents': 123, 'order_status': 'paid',
               'paid_at': '2026-01-15T12:00:00Z', 'order_date': '2026-01-15', **patch}
        db.execute('INSERT INTO demo_order_detail ('+','.join(row)+') VALUES ('+','.join('?' for _ in row)+')', tuple(row.values()))
        yield name


def evaluate(sample):
    cases = json.loads((ROOT / 'docs/sources/evaluation/cases.json').read_text())['cases']
    scoped_net = sample['case_id'] == 'net_revenue_scope'
    if scoped_net and sample.get('channel') not in (None, 'web', 'app', 'store'):
        return {'case_id': sample['case_id'], 'passed': False, 'error': 'invalid_channel'}
    reference = {'id': 'net_revenue_scope', 'expected_rows': None} if scoped_net else next(c for c in cases if c['id'] == sample['case_id'])
    with sqlite3.connect(':memory:') as db:
        for name in ('schema.sql', 'seed.sql', 'etl.sql'):
            db.executescript((ROOT / 'docs/sources' / name).read_text())
        try:
            rows, columns = read_query(db, sample['sql'], sample.get('parameters'))
            expected = reference['expected_rows']
            variations = []
            if scoped_net or reference['id'] == 'Q06':
                tagged = reference['id'] == 'Q06'
                channel = sample.get('channel') if scoped_net else None
                expected = net_revenue_expectation(db, columns, channel, tagged)
                for name in net_revenue_variations(db):
                    actual, variant_columns = read_query(db, sample['sql'], sample.get('parameters'))
                    wanted = net_revenue_expectation(db, variant_columns, channel, tagged)
                    variations.append({'name': name, 'passed': wanted is not None and actual == wanted, 'rows': actual, 'expected_rows': wanted})
            if reference['id'] == 'Q02':
                expected = customer_expectation(db, columns, reference['expected_rows'][0][0])
                reference_sql = (ROOT / 'docs/sources/evaluation' / reference['sql_file']).read_text()
                for name in customer_variations(db):
                    actual, variant_columns = read_query(db, sample['sql'], sample.get('parameters'))
                    known, _ = read_query(db, reference_sql)
                    wanted = customer_expectation(db, variant_columns, known[0][0])
                    variations.append({'name': name, 'passed': wanted is not None and actual == wanted, 'rows': actual, 'expected_rows': wanted})
            if reference['id'] in ('Q04','Q05','Q10'):
                expected=refund_expectation(db,reference['id'],columns)
                for name in refund_variations(db,reference['id']):
                    actual,variant_columns=read_query(db,sample['sql'],sample.get('parameters'))
                    wanted=refund_expectation(db,reference['id'],variant_columns)
                    variations.append({'name':name,'passed':refund_rows_match(actual,wanted,variant_columns),'rows':actual,'expected_rows':wanted})
        except (sqlite3.Error, TypeError, ValueError) as error:
            return {'case_id': reference['id'], 'passed': False, 'error': type(error).__name__}
        finally:
            # 仅允许本验收器收尾自己的内存数据变体；模型SQL始终在只读authorizer下执行。
            db.set_authorizer(None)
    def normal(values):
        return sorted(values, key=lambda row: json.dumps(row, ensure_ascii=False))
    matched=refund_rows_match(rows,expected,columns) if reference['id'] in ('Q04','Q05','Q10') else expected is not None and normal(rows)==normal(expected)
    return {'case_id': reference['id'], 'passed': matched and all(v['passed'] for v in variations),
            'rows': rows, 'expected_rows': expected, 'columns': columns, 'data_variations': variations,
            'evidence_kind': 'independent_synthetic_result',
            'limitation': '只证明该SQL在独立合成数据上的结果；语言解释、引用和适用边界另需审查。'}


if __name__ == '__main__':
    print(json.dumps(evaluate(json.load(sys.stdin)), ensure_ascii=False))
