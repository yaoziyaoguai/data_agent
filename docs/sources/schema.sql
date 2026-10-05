-- 完全虚构的零售样例；离线执行方言：SQLite 3。
-- 金额单位为分；时间为 UTC；此脚本不定义应用 MySQL 存储。
PRAGMA foreign_keys = ON;

CREATE TABLE dim_customers (
    customer_id TEXT PRIMARY KEY,
    customer_name TEXT NOT NULL,
    region TEXT
);
CREATE TABLE raw_order_lines (
    order_id TEXT NOT NULL,
    line_id INTEGER NOT NULL CHECK (line_id > 0),
    customer_id TEXT REFERENCES dim_customers(customer_id),
    product_id TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    ordered_at TEXT NOT NULL,
    channel TEXT NOT NULL CHECK (channel IN ('web', 'app', 'store')),
    is_test INTEGER NOT NULL CHECK (is_test IN (0, 1)),
    source_status TEXT NOT NULL CHECK (source_status IN ('placed', 'cancelled')),
    PRIMARY KEY (order_id, line_id)
);
-- 一笔订单行可有多次支付/退款；每个事件金额已分摊至对应订单行。
CREATE TABLE raw_payments (
    payment_event_id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL,
    line_id INTEGER NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN ('charge', 'refund')),
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    event_at TEXT NOT NULL,
    event_status TEXT NOT NULL CHECK (event_status IN ('success', 'failed', 'pending')),
    FOREIGN KEY (order_id, line_id) REFERENCES raw_order_lines(order_id, line_id)
);
-- 同一客户可属于多个标签；该表不参加主表加工。
CREATE TABLE customer_tags (
    customer_id TEXT NOT NULL REFERENCES dim_customers(customer_id),
    tag TEXT NOT NULL,
    PRIMARY KEY (customer_id, tag)
);
CREATE TABLE demo_order_detail (
    order_id TEXT NOT NULL,
    line_id INTEGER NOT NULL,
    customer_id TEXT,
    product_id TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    paid_amount_cents INTEGER NOT NULL CHECK (paid_amount_cents >= 0),
    refunded_amount_cents INTEGER NOT NULL CHECK (refunded_amount_cents BETWEEN 0 AND paid_amount_cents),
    paid_at TEXT,
    order_date TEXT NOT NULL,
    channel TEXT NOT NULL,
    region TEXT,
    is_test INTEGER NOT NULL CHECK (is_test IN (0, 1)),
    order_status TEXT NOT NULL CHECK (order_status IN ('paid', 'refunded', 'cancelled', 'unpaid')),
    PRIMARY KEY (order_id, line_id)
);
