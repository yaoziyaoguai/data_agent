// 基于全虚构零售资料整理的分析预填；仍需维护者核对。
const demoAnalysis = {
  "overview": {
    "description": [
      "订单行、截至快照的成功支付/退款事件及客户地区组成的全虚构明细，用于解释收入、支付客户和退款指标。",
      "合成加工 SQL 明确了三个来源与金额汇总方式。",
      [
        {
          "file": "sql",
          "start": 27,
          "end": 27
        }
      ]
    ],
    "grain": [
      "一行代表一个订单的一条商品行。支付事件先按 order_id、line_id 汇总；订单整体状态再回填到各商品行。",
      "DDL 声明组合主键；加工先聚合，再按对应键关联。",
      [
        {
          "file": "ddl",
          "start": 39,
          "end": 39
        },
        {
          "file": "sql",
          "start": 13,
          "end": 13
        },
        {
          "file": "sql",
          "start": 28,
          "end": 28
        }
      ]
    ],
    "unique_key": [
      "order_id + line_id",
      "样例 DDL 的组合主键。",
      [
        {
          "file": "ddl",
          "start": 53,
          "end": 53
        }
      ]
    ],
    "caveats": [
      "金额单位为分，不能再乘 quantity。收入按 paid_at 筛选；退款按截至快照的累计值回扣原支付订单。customer_tags 一对多，只在查询时按需关联。",
      "加工边界与合成业务说明共同约定。",
      [
        {
          "file": "sql",
          "start": 12,
          "end": 12
        },
        {
          "file": "sql",
          "start": 21,
          "end": 21
        }
      ]
    ]
  },
  "columns": {
    "order_id": {
      "role": "订单标识",
      "calculation": "l.order_id",
      "rule": "订单数使用 COUNT(DISTINCT order_id)，不能把商品行数直接当成订单数。",
      "refs": [
        {
          "file": "sql",
          "start": 20,
          "end": 20
        }
      ],
      "description": "订单标识；同一订单可有多条商品行。"
    },
    "line_id": {
      "role": "行标识",
      "calculation": "l.line_id",
      "rule": "仅在同一个 order_id 内唯一。",
      "refs": [
        {
          "file": "sql",
          "start": 20,
          "end": 20
        }
      ],
      "description": "订单内的商品行编号，与 order_id 组成唯一键。"
    },
    "customer_id": {
      "role": "客户标识 / 去重键",
      "calculation": "l.customer_id",
      "rule": "已知客户 UV 使用 COUNT(DISTINCT customer_id)，NULL 不计入；匿名订单收入仍计入。",
      "caution": "跨日或跨渠道的客户 UV 不可直接相加。",
      "refs": [
        {
          "file": "sql",
          "start": 20,
          "end": 20
        }
      ],
      "description": "客户标识；匿名订单为 NULL。"
    },
    "quantity": {
      "role": "数量",
      "calculation": "l.quantity",
      "caution": "paid_amount_cents 已是当前行总金额，不能再乘商品数量。",
      "refs": [
        {
          "file": "sql",
          "start": 20,
          "end": 20
        }
      ],
      "description": "当前订单行购买数量，正整数。"
    },
    "paid_amount_cents": {
      "role": "可求和金额",
      "calculation": "SUM(CASE WHEN event_type = 'charge' THEN amount_cents ELSE 0 END)，无事件时 COALESCE 为 0",
      "rule": "只包含快照截止前 success 事件；整数分。",
      "refs": [
        {
          "file": "sql",
          "start": 7,
          "end": 7
        },
        {
          "file": "sql",
          "start": 11,
          "end": 11
        },
        {
          "file": "sql",
          "start": 21,
          "end": 21
        }
      ],
      "description": "当前订单行成功支付金额，整数分。"
    },
    "refunded_amount_cents": {
      "role": "可求和金额",
      "calculation": "SUM(CASE WHEN event_type = 'refund' THEN amount_cents ELSE 0 END)，无退款为 0",
      "rule": "截至 2026-02-04T00:00:00Z 的累计退款；整数分。",
      "caution": "按 paid_at 统计的是支付订单的退款，不等于所选月份发生的退款事件。",
      "refs": [
        {
          "file": "sql",
          "start": 8,
          "end": 8
        },
        {
          "file": "sql",
          "start": 12,
          "end": 12
        }
      ],
      "description": "当前订单行截至快照的成功退款金额，整数分。"
    },
    "paid_at": {
      "role": "支付统计时间",
      "calculation": "MIN(CASE WHEN event_type = 'charge' THEN event_at END)",
      "rule": "UTC；以时间范围左闭右开筛选；未付款为 NULL。",
      "refs": [
        {
          "file": "sql",
          "start": 9,
          "end": 9
        }
      ],
      "description": "当前订单行首次成功支付时间，UTC；未付款为 NULL。"
    },
    "order_date": {
      "role": "下单日期",
      "calculation": "SUBSTR(l.ordered_at, 1, 10)",
      "rule": "只表示下单日，不替代支付时间。",
      "caution": "订单可以次月才支付；按它筛选会改变收入归属月份。",
      "issue": "需核对时间口径",
      "refs": [
        {
          "file": "sql",
          "start": 22,
          "end": 22
        }
      ],
      "description": "下单日期，来自 ordered_at 的日期部分。"
    },
    "channel": {
      "role": "分析维度",
      "calculation": "l.channel",
      "rule": "web：网页；app：应用；store：门店。",
      "refs": [
        {
          "file": "sql",
          "start": 22,
          "end": 22
        }
      ],
      "description": "购买渠道：web、app 或 store。"
    },
    "region": {
      "role": "分析维度",
      "calculation": "LEFT JOIN dim_customers 后取 c.region",
      "rule": "未知地区保留 NULL。",
      "caution": "没有匹配地区不代表不应计入总收入。",
      "refs": [
        {
          "file": "sql",
          "start": 30,
          "end": 30
        },
        {
          "file": "sql",
          "start": 22,
          "end": 22
        }
      ],
      "description": "客户地区，来自客户维度；未知为 NULL。"
    },
    "is_test": {
      "role": "常用过滤条件",
      "calculation": "l.is_test",
      "rule": "默认业绩分析保留 is_test=0。",
      "refs": [
        {
          "file": "sql",
          "start": 22,
          "end": 22
        }
      ],
      "description": "测试订单标记：1 为测试，0 为正常。"
    },
    "order_status": {
      "role": "订单整体状态",
      "calculation": "cancelled 优先；整单支付为 0 为 unpaid；整单退款等于支付为 refunded；其他为 paid。",
      "rule": "同一订单各行使用整单状态。",
      "caution": "部分退款仍可为 paid；仅一条商品行全退不意味着整单 refunded。退款订单数应检查金额。",
      "refs": [
        {
          "file": "sql",
          "start": 23,
          "end": 23
        },
        {
          "file": "sql",
          "start": 24,
          "end": 24
        },
        {
          "file": "sql",
          "start": 25,
          "end": 25
        }
      ],
      "description": "订单状态：paid、refunded、cancelled 或 unpaid。"
    }
  },
  "relations": [
    [
      "raw_order_lines",
      "订单行、数量、渠道与测试标记",
      "order_id + line_id",
      "订单行组合主键；过滤快照截止前的订单。"
    ],
    [
      "raw_payments",
      "支付与退款事件汇总",
      "先按 order_id + line_id 汇总后，再 LEFT JOIN",
      "仅成功事件；事件时间小于快照截止。不可直接将原始事件多行连到订单后求和。"
    ],
    [
      "dim_customers",
      "补充客户地区",
      "订单 customer_id = 客户 customer_id",
      "维度主键唯一；未匹配保留 NULL。"
    ]
  ],
  "issues": [
    {
      "id": "time",
      "scope": "column:order_date",
      "tab": "fields",
      "column": "order_date",
      "title": "下单日期与支付月份是否混用",
      "detail": "月末下单、次月支付的订单应按 paid_at 归入支付月份。"
    },
    {
      "id": "tag",
      "scope": "field:grain",
      "tab": "overview",
      "field": "grain",
      "title": "客户标签关联是否会重复金额",
      "detail": "customer_tags 为一对多，筛选标签建议使用 EXISTS 或明确新的结果粒度。"
    },
    {
      "id": "rate",
      "scope": "metric:order_refund_rate",
      "tab": "metrics",
      "metric": "order_refund_rate",
      "title": "退款率的分母需要明确",
      "detail": "本候选是订单退款率；金额退款率和客户退款率是另外两种定义。"
    }
  ],
  "metrics": [
    {
      "id": "net_revenue",
      "name": "净收入",
      "description": "所选支付订单截至样例快照的支付金额减退款金额。",
      "expression": "COALESCE(SUM(paid_amount_cents - refunded_amount_cents), 0)",
      "entity": "订单行金额",
      "filter": "paid_at >= '2026-01-01T00:00:00Z'   AND paid_at < '2026-02-01T00:00:00Z'   AND is_test = 0",
      "dimension": "channel、region；按需重新分组计算",
      "notes": "结果单位为分；显示元时除以 100。按原支付月归属，并扣除截至快照的退款；不等同本月收退款流水差额。",
      "sql": "-- SQLite 合成示例；支付月份使用 UTC。\nSELECT\n  COALESCE(SUM(paid_amount_cents - refunded_amount_cents), 0) AS net_revenue\nFROM demo_order_detail\nWHERE paid_at >= '2026-01-01T00:00:00Z'\n  AND paid_at < '2026-02-01T00:00:00Z'\n  AND is_test = 0;"
    },
    {
      "id": "paid_customer_uv",
      "name": "月支付客户 UV",
      "description": "所选支付月份内有成功支付的已知客户数。",
      "expression": "COUNT(DISTINCT customer_id)",
      "entity": "customer_id",
      "filter": "paid_at >= '2026-01-01T00:00:00Z'   AND paid_at < '2026-02-01T00:00:00Z'   AND is_test = 0",
      "dimension": "channel、region；按需重新分组计算",
      "notes": "匿名客户 NULL 不计入；跨日和跨渠道 UV 可能重叠，总体应重新去重。",
      "sql": "-- SQLite 合成示例；支付月份使用 UTC。\nSELECT\n  COUNT(DISTINCT customer_id) AS paid_customer_uv\nFROM demo_order_detail\nWHERE paid_at >= '2026-01-01T00:00:00Z'\n  AND paid_at < '2026-02-01T00:00:00Z'\n  AND is_test = 0;"
    },
    {
      "id": "order_refund_rate",
      "name": "订单退款率",
      "description": "所选已支付订单中发生过退款的订单比例。",
      "expression": "1.0 * COUNT(DISTINCT CASE WHEN refunded_amount_cents > 0 THEN order_id END) / NULLIF(COUNT(DISTINCT order_id), 0)",
      "entity": "order_id",
      "filter": "paid_at >= '2026-01-01T00:00:00Z'   AND paid_at < '2026-02-01T00:00:00Z'   AND is_test = 0",
      "dimension": "channel、region；按需重新分组计算",
      "notes": "返回 0–1 的比例；显示百分数时乘 100。分母为零返回 NULL，应解释无可计算的订单。部分退款包含在分子。",
      "sql": "-- SQLite 合成示例；支付月份使用 UTC。\nSELECT\n  1.0 * COUNT(DISTINCT CASE WHEN refunded_amount_cents > 0 THEN order_id END) / NULLIF(COUNT(DISTINCT order_id), 0) AS order_refund_rate\nFROM demo_order_detail\nWHERE paid_at >= '2026-01-01T00:00:00Z'\n  AND paid_at < '2026-02-01T00:00:00Z'\n  AND is_test = 0;"
    }
  ]
};
