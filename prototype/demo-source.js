// 全部内容从零编写；由公开合成样例 schema.sql / etl.sql 生成，不执行 SQL。
const demoSource = {
  "table": "demo_order_detail",
  "revision": "retail-synthetic-20261003-v1",
  "ddl": "-- 完全虚构的零售样例；离线执行方言：SQLite 3。\n-- 金额单位为分；时间为 UTC；此脚本不定义应用 MySQL 存储。\nPRAGMA foreign_keys = ON;\n\nCREATE TABLE dim_customers (\n    customer_id TEXT PRIMARY KEY,\n    customer_name TEXT NOT NULL,\n    region TEXT\n);\nCREATE TABLE raw_order_lines (\n    order_id TEXT NOT NULL,\n    line_id INTEGER NOT NULL CHECK (line_id > 0),\n    customer_id TEXT REFERENCES dim_customers(customer_id),\n    product_id TEXT NOT NULL,\n    quantity INTEGER NOT NULL CHECK (quantity > 0),\n    ordered_at TEXT NOT NULL,\n    channel TEXT NOT NULL CHECK (channel IN ('web', 'app', 'store')),\n    is_test INTEGER NOT NULL CHECK (is_test IN (0, 1)),\n    source_status TEXT NOT NULL CHECK (source_status IN ('placed', 'cancelled')),\n    PRIMARY KEY (order_id, line_id)\n);\n-- 一笔订单行可有多次支付/退款；每个事件金额已分摊至对应订单行。\nCREATE TABLE raw_payments (\n    payment_event_id TEXT PRIMARY KEY,\n    order_id TEXT NOT NULL,\n    line_id INTEGER NOT NULL,\n    event_type TEXT NOT NULL CHECK (event_type IN ('charge', 'refund')),\n    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),\n    event_at TEXT NOT NULL,\n    event_status TEXT NOT NULL CHECK (event_status IN ('success', 'failed', 'pending')),\n    FOREIGN KEY (order_id, line_id) REFERENCES raw_order_lines(order_id, line_id)\n);\n-- 同一客户可属于多个标签；该表不参加主表加工。\nCREATE TABLE customer_tags (\n    customer_id TEXT NOT NULL REFERENCES dim_customers(customer_id),\n    tag TEXT NOT NULL,\n    PRIMARY KEY (customer_id, tag)\n);\nCREATE TABLE demo_order_detail (\n    order_id TEXT NOT NULL,\n    line_id INTEGER NOT NULL,\n    customer_id TEXT,\n    product_id TEXT NOT NULL,\n    quantity INTEGER NOT NULL,\n    paid_amount_cents INTEGER NOT NULL CHECK (paid_amount_cents >= 0),\n    refunded_amount_cents INTEGER NOT NULL CHECK (refunded_amount_cents BETWEEN 0 AND paid_amount_cents),\n    paid_at TEXT,\n    order_date TEXT NOT NULL,\n    channel TEXT NOT NULL,\n    region TEXT,\n    is_test INTEGER NOT NULL CHECK (is_test IN (0, 1)),\n    order_status TEXT NOT NULL CHECK (order_status IN ('paid', 'refunded', 'cancelled', 'unpaid')),\n    PRIMARY KEY (order_id, line_id)\n);\n",
  "sql": "-- 合成演示快照截止 2026-02-04T00:00:00Z，区间右侧不含截止时点。\n-- 在事务内完整重建，避免将重复运行误算为新增业务记录。\nBEGIN;\nDELETE FROM demo_order_detail;\nWITH line_payments AS (\n    SELECT order_id, line_id,\n           SUM(CASE WHEN event_type = 'charge' THEN amount_cents ELSE 0 END) AS paid,\n           SUM(CASE WHEN event_type = 'refund' THEN amount_cents ELSE 0 END) AS refunded,\n           MIN(CASE WHEN event_type = 'charge' THEN event_at END) AS paid_at\n    FROM raw_payments\n    WHERE event_status = 'success'\n      AND event_at < '2026-02-04T00:00:00Z'\n    GROUP BY order_id, line_id\n), order_totals AS (\n    SELECT order_id, SUM(paid) AS paid, SUM(refunded) AS refunded\n    FROM line_payments\n    GROUP BY order_id\n)\nINSERT INTO demo_order_detail\nSELECT l.order_id, l.line_id, l.customer_id, l.product_id, l.quantity,\n       COALESCE(p.paid, 0), COALESCE(p.refunded, 0), p.paid_at,\n       SUBSTR(l.ordered_at, 1, 10), l.channel, c.region, l.is_test,\n       CASE WHEN l.source_status = 'cancelled' THEN 'cancelled'\n            WHEN COALESCE(t.paid, 0) = 0 THEN 'unpaid'\n            WHEN t.refunded = t.paid THEN 'refunded'\n            ELSE 'paid' END\nFROM raw_order_lines AS l\nLEFT JOIN line_payments AS p ON l.order_id = p.order_id AND l.line_id = p.line_id\nLEFT JOIN order_totals AS t ON l.order_id = t.order_id\nLEFT JOIN dim_customers AS c ON l.customer_id = c.customer_id\nWHERE l.ordered_at < '2026-02-04T00:00:00Z';\nCOMMIT;\n",
  "columns": {
    "dim_customers": [
      {
        "name": "customer_id",
        "type": "TEXT",
        "description": "客户标识；匿名订单为 NULL。",
        "line": 6
      },
      {
        "name": "customer_name",
        "type": "TEXT",
        "description": "虚构客户名称，仅用于演示。",
        "line": 7
      },
      {
        "name": "region",
        "type": "TEXT",
        "description": "客户地区，来自客户维度；未知为 NULL。",
        "line": 8
      }
    ],
    "raw_order_lines": [
      {
        "name": "order_id",
        "type": "TEXT",
        "description": "订单标识；同一订单可有多条商品行。",
        "line": 11
      },
      {
        "name": "line_id",
        "type": "INTEGER",
        "description": "订单内的商品行编号，与 order_id 组成唯一键。",
        "line": 12
      },
      {
        "name": "customer_id",
        "type": "TEXT",
        "description": "客户标识；匿名订单为 NULL。",
        "line": 13
      },
      {
        "name": "product_id",
        "type": "TEXT",
        "description": "商品标识。",
        "line": 14
      },
      {
        "name": "quantity",
        "type": "INTEGER",
        "description": "当前订单行购买数量，正整数。",
        "line": 15
      },
      {
        "name": "ordered_at",
        "type": "TEXT",
        "description": "合成来源字段。",
        "line": 16
      },
      {
        "name": "channel",
        "type": "TEXT",
        "description": "购买渠道：web、app 或 store。",
        "line": 17
      },
      {
        "name": "is_test",
        "type": "INTEGER",
        "description": "测试订单标记：1 为测试，0 为正常。",
        "line": 18
      },
      {
        "name": "source_status",
        "type": "TEXT",
        "description": "合成来源字段。",
        "line": 19
      }
    ],
    "raw_payments": [
      {
        "name": "payment_event_id",
        "type": "TEXT",
        "description": "支付或退款事件的唯一标识。",
        "line": 24
      },
      {
        "name": "order_id",
        "type": "TEXT",
        "description": "订单标识；同一订单可有多条商品行。",
        "line": 25
      },
      {
        "name": "line_id",
        "type": "INTEGER",
        "description": "订单内的商品行编号，与 order_id 组成唯一键。",
        "line": 26
      },
      {
        "name": "event_type",
        "type": "TEXT",
        "description": "事件类型：charge 支付，refund 退款。",
        "line": 27
      },
      {
        "name": "amount_cents",
        "type": "INTEGER",
        "description": "事件分摊到订单行的金额，以整数分保存。",
        "line": 28
      },
      {
        "name": "event_at",
        "type": "TEXT",
        "description": "事件发生时间，UTC。",
        "line": 29
      },
      {
        "name": "event_status",
        "type": "TEXT",
        "description": "事件状态：success、failed 或 pending。",
        "line": 30
      }
    ],
    "customer_tags": [
      {
        "name": "customer_id",
        "type": "TEXT",
        "description": "客户标识；匿名订单为 NULL。",
        "line": 35
      },
      {
        "name": "tag",
        "type": "TEXT",
        "description": "合成来源字段。",
        "line": 36
      }
    ],
    "demo_order_detail": [
      {
        "name": "order_id",
        "type": "TEXT",
        "description": "订单标识；同一订单可有多条商品行。",
        "line": 40
      },
      {
        "name": "line_id",
        "type": "INTEGER",
        "description": "订单内的商品行编号，与 order_id 组成唯一键。",
        "line": 41
      },
      {
        "name": "customer_id",
        "type": "TEXT",
        "description": "客户标识；匿名订单为 NULL。",
        "line": 42
      },
      {
        "name": "product_id",
        "type": "TEXT",
        "description": "商品标识。",
        "line": 43
      },
      {
        "name": "quantity",
        "type": "INTEGER",
        "description": "当前订单行购买数量，正整数。",
        "line": 44
      },
      {
        "name": "paid_amount_cents",
        "type": "INTEGER",
        "description": "当前订单行成功支付金额，整数分。",
        "line": 45
      },
      {
        "name": "refunded_amount_cents",
        "type": "INTEGER",
        "description": "当前订单行截至快照的成功退款金额，整数分。",
        "line": 46
      },
      {
        "name": "paid_at",
        "type": "TEXT",
        "description": "当前订单行首次成功支付时间，UTC；未付款为 NULL。",
        "line": 47
      },
      {
        "name": "order_date",
        "type": "TEXT",
        "description": "下单日期，来自 ordered_at 的日期部分。",
        "line": 48
      },
      {
        "name": "channel",
        "type": "TEXT",
        "description": "购买渠道：web、app 或 store。",
        "line": 49
      },
      {
        "name": "region",
        "type": "TEXT",
        "description": "客户地区，来自客户维度；未知为 NULL。",
        "line": 50
      },
      {
        "name": "is_test",
        "type": "INTEGER",
        "description": "测试订单标记：1 为测试，0 为正常。",
        "line": 51
      },
      {
        "name": "order_status",
        "type": "TEXT",
        "description": "订单状态：paid、refunded、cancelled 或 unpaid。",
        "line": 52
      }
    ]
  }
};
