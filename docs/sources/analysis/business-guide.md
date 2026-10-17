# 虚构零售业务说明

本说明、表、SQL 和数据全部由项目自行构造，供公开演示和离线验收使用。它没有真实公司的业务规则，也没有真实订单或个人资料。

## 1. 本样例回答什么

演示一家虚构零售商通过网页、应用和门店销售商品。用户可以查看已支付金额、净收入、支付客户数，或按渠道、客户地区分析。核心表 `demo_order_detail` 是订单行明细，供语义维护页面展示字段、指标和依据。资料规模很小；它不能证明在大规模目录里检索也准确。

数据快照截止 **2026-04-04 00:00:00 UTC，不含截止时刻**。付款数据覆盖2026年1月至3月，成功退款事件延伸至2026年4月2日；4月不是完整交易月份。种子数据不随当前日期变化。此处“2026 年 1 月”使用 `[2026-01-01T00:00:00Z, 2026-02-01T00:00:00Z)`，金额单位为整数分。输出给人阅读时可除以 100 得到元，计算和验收保留分，避免浮点金额误差。

## 2. 一行代表什么

`demo_order_detail` 的一行是一张订单中的一个商品行。主键是 `(order_id, line_id)`。同一订单可能有多个商品行，同一客户也会反复下单，所以：

- 订单数用 `COUNT(DISTINCT order_id)`。
- 已知客户数用 `COUNT(DISTINCT customer_id)`，不把匿名购买强行合并成一个客户。
- 商品件数用 `SUM(quantity)`；行数、订单数、件数含义不同。
- `paid_amount_cents` 和 `refunded_amount_cents` 已分摊到行，可以按行相加。
- 同一订单各行的客户、渠道、下单时间和测试标记在本样例中一致；生成器和验收会核对这一点。

## 3. 上游与加工

### 3.1 订单行 `raw_order_lines`

提供订单、行、客户、商品、数量、下单时间、渠道、测试标记和源订单状态。取消订单保留；没有付款的行也保留。主表 `order_date` 由 `ordered_at` 截取 UTC 日期，不能因此把它自动当成收入统计日期。

### 3.2 付款事件 `raw_payments`

一个订单行可能有多次付款或退款。`event_type='charge'` 表示付款，`event_type='refund'` 表示退款。每笔事件已按订单行分摊，金额始终为正数；类型决定它是加付款还是加退款。

加工先筛选快照截止前 `event_status='success'` 的事件，再按 `(order_id, line_id)` 汇总，再与订单行关联。失败和等待中的事件不计金额。直接把事件表关联回订单行后重复累加行金额，会重复计算。

`paid_at` 是这一个订单行首笔成功付款的 UTC 时刻；本样例一行的分次付款都在同一天，且不存在同一 `(order_id, line_id)` 跨月分次付款。同一订单的不同行可以在不同月份首次付款，不能假定它们的 `paid_at` 同月。没有成功付款时，`paid_at` 为 `NULL`，两个金额为 0。

### 3.3 客户 `dim_customers`

按唯一 `customer_id` 左连接，补充当前快照的客户地区。匿名购买没有客户 ID；已知客户也可能没有地区。两类未知地区都保留 `NULL`，不能猜成默认地区。此维表没有历史拉链，本样例的地区分析表示当前快照地区，不承诺还原交易时地区。

### 3.4 标签 `customer_tags`

这是查询时可用的附加表，不参加主表加工。同一客户可以有多个标签，关联基数是一对多。筛选“有 VIP 或订阅标签的客户”时用 `EXISTS`，或者先得到去重的客户列表再关联。如果直接连接标签明细，一个同时有两种标签的客户，其订单金额会出现两遍。

## 4. 字段说明

| 字段 | 类型 | 业务含义与注意事项 |
| --- | --- | --- |
| `order_id` | TEXT | 虚构订单标识；订单数应去重 |
| `line_id` | INTEGER | 订单内行号，和订单号一起唯一 |
| `customer_id` | TEXT，可空 | 已知客户标识；空值表示匿名购买，不能补成一个统一客户参与 UV |
| `product_id` | TEXT | 虚构商品标识，不提供商品分类维表 |
| `quantity` | INTEGER | 下单件数；没有单独的退货件数，不能推导净售出件数 |
| `paid_amount_cents` | INTEGER | 成功付款累计金额，已分摊到当前行，整数分 |
| `refunded_amount_cents` | INTEGER | 截至快照的成功退款累计金额，已分摊到当前行，整数分 |
| `paid_at` | TEXT，可空 | 当前行首笔成功付款时刻，UTC；收入和支付客户的默认时间依据 |
| `order_date` | TEXT | UTC 下单日期；用于下单分析，不是支付收入的默认日期 |
| `channel` | TEXT | `web`=网页、`app`=应用、`store`=门店 |
| `region` | TEXT，可空 | 当前客户快照地区；空值在展示上可以叫“未知”，存储保留 NULL |
| `is_test` | INTEGER | 1 为测试交易，0 为普通交易；业务统计默认只取 0，明确查测试交易时可改 |
| `order_status` | TEXT | 整单状态：`paid`=有付款且未全退，`refunded`=整单全退，`cancelled`=取消，`unpaid`=尚无成功付款 |

`order_status` 是整单状态。同一订单的某行全部退款，整单仍可能只是部分退款。判断一行退款金额应看金额字段，不能把 `order_status='refunded'` 当作“出现过退款”的过滤条件。

## 5. 三个示例指标

### 5.1 支付归属净收入

- 指标标识：`net_revenue`
- 别名：净收入 收入 净收
- 时间：按 `paid_at` 选支付期间，排除测试交易。
- 计算：`SUM(paid_amount_cents - refunded_amount_cents)`。
- 单位：分；展示为元时除以 100。
- 边界：全退订单保留，贡献 0；部分退款扣除实际退款；取消和未付订单没有 `paid_at`，不会计入。
- 退款按原付款期间归属。例如 1 月付款、2 月退款，在当前快照中会减少 1 月净收入。

这是“截至快照、按付款月归属”的业务指标。若用户问“2 月实际退款流水”或“当月现金净流入”，应按 `raw_payments.event_at` 计算；不能用主表累计退款替代退款发生时间。

计算 SQL（本说明人工制定的合成指标定义；`:start` 和 `:end` 是 UTC 半开区间参数）：

```sql
SELECT SUM(paid_amount_cents - refunded_amount_cents) AS net_revenue
FROM demo_order_detail
WHERE is_test = 0 AND paid_amount_cents > 0
  AND paid_at >= :start AND paid_at < :end;
```

### 5.2 月支付客户数

- 指标标识：`paying_customers`
- 别名：UV 支付客户 月客户
- 在整个月的已支付、非测试行上执行 `COUNT(DISTINCT customer_id)`。
- 同一客户多次下单、多行商品只计一次；匿名客户不计已知客户数。
- 全额退款客户仍曾成功付款，保留在该指标内；如用户要求“未全退客户”，属于不同口径，需要明确。
- 不能把每天的客户数相加得到月客户数；同一客户可能跨天出现。

计算 SQL（本说明人工制定的合成指标定义，时间参数含义同上）：

```sql
SELECT COUNT(DISTINCT customer_id) AS paying_customers
FROM demo_order_detail
WHERE is_test = 0 AND paid_amount_cents > 0
  AND paid_at >= :start AND paid_at < :end;
```

### 5.3 订单退款率

- 指标标识：`refund_rate`
- 别名：退款率 订单退款比例

这是一个已经命名清楚的示例指标：

- 分母：期间内有成功付款的非测试订单数，按订单去重。
- 分子：分母中的订单，截至快照至少有一行成功退款。先确定期间付款的订单集合，再检查这些订单的全部行；退款行不必在同一付款月份。
- 计算：退款订单数 / 已支付订单数；零分母返回 `NULL`，同时说明无已支付订单。
- 全额和部分退款订单都计分子；匿名订单仍计订单数。

如果用户只说“退款率”，还不能知道他要的是订单退款率、退款金额占支付金额比例，还是退款客户占支付客户比例。Agent 应先查已有会话约定或用户采用的指标；缺少约定时询问分母，用户明确后再生成相应 SQL。不能把名称相似当成已经确认了口径。

计算 SQL（本说明人工制定的合成指标定义，时间参数含义同上）：

```sql
SELECT COUNT(DISTINCT CASE WHEN EXISTS (
    SELECT 1 FROM demo_order_detail AS r
    WHERE r.order_id = demo_order_detail.order_id
      AND r.is_test = 0 AND r.refunded_amount_cents > 0
) THEN order_id END) * 1.0 / NULLIF(COUNT(DISTINCT order_id), 0) AS refund_rate
FROM demo_order_detail
WHERE is_test = 0 AND paid_amount_cents > 0
  AND paid_at >= :start AND paid_at < :end;
```

## 6. 可填写与可推断的范围

接口能够直接给出表结构、主键、加工 SQL、血缘和原始注释。SQL 分析可以支持“先汇总支付再连接”“付款状态筛选”“金额空值补 0”等建议。业务解释如收入归属、匿名客户处理、标签用途仍需要本说明这样的依据。页面应分别保存原始事实、模型建议和人工修改，保留出处、版本、修改人和生效范围。

人工可补充、纠正全部语义。人工修改标记表示内容来自人工修订，不自动等于业务结果已验证。涉及结果的指标另记录验收证据。

本说明本身也是人工制定的合成业务来源。指标别名、计算 SQL 和关联解释以本文为唯一规范来源，目录生成器只引用对应原文，不另写一套规则。引用本文说明的是“合成业务定义”，不能标成数据平台已有注释或模型已经验证的业务结论。DDL 类型的确定派生另记录原始声明和派生方法；未提供的来源表加工 SQL 保持未知。

## 7. 样例覆盖及边界

样例专门包含：多行订单、多次付款、失败/等待付款、取消未付、测试交易、匿名客户、未知地区、跨月下单支付、跨月退款、部分退款、整单全退、单行全退但整单未全退、跨天重复客户、一对多标签。

它不模拟税费、运费、折扣分摊算法、货币兑换、订单取消后付款、退款超过付款、同一订单行跨月分次付款、客户合并或历史地区变化。这些不是已经支持的能力。真实平台接入时必须重新确认其数据契约和 SQL 方言，不能把这个简化样例当成真实平台规格。

## 8. 作为 Agent 知识使用

业务域标识：`合成零售`。本说明与其DDL、加工SQL生成的所有合成知识对象都属于该业务域；这是一条明确样例约定，不由表名推断。

知识输入可以包含本说明、`schema.sql`、`etl.sql` 和明确允许展示的合成种子；实际是否给模型完整行数据仍由应用的数据范围控制。

`evaluation/` 保存独立参考 SQL、预期结果与验收问题，默认不进入索引、提示词或 Skill。离线脚本验证了样例本身，不代表 Agent 已通过检索、澄清、SQL 确认或执行状态验证。

### 可计算语义定义

以下是本合成业务明确制定的结构约定，版本引用对应首次导入的对象。引用变更后需要维护者核对，不能自动把旧约定套到新版本。自然语言和结构一起维护；复杂指标的完整 SQL 仍以上文为准。订单行与标签的直接关联是多对多，与客户到标签的一对多不同。

```semantic-structure
[
  {
    "object_id": "table-demo_order_detail",
    "entry_id": "description",
    "structure": {
      "kind": "table",
      "grain": "一张订单中的一个商品行",
      "unique_keys": [
        [
          "order_id",
          "line_id"
        ]
      ],
      "time_columns": [
        {
          "column": "paid_at",
          "role": "payment"
        },
        {
          "column": "order_date",
          "role": "order"
        }
      ],
      "default_filters": [],
      "constraints": []
    }
  },
  {
    "object_id": "table-raw_order_lines",
    "entry_id": "description",
    "structure": {
      "kind": "table",
      "grain": "一张订单中的一个商品行",
      "unique_keys": [
        [
          "order_id",
          "line_id"
        ]
      ],
      "time_columns": [
        {
          "column": "ordered_at",
          "role": "order"
        }
      ],
      "default_filters": [],
      "constraints": []
    }
  },
  {
    "object_id": "table-raw_payments",
    "entry_id": "description",
    "structure": {
      "kind": "table",
      "grain": "一次订单行付款或退款事件",
      "unique_keys": [
        [
          "payment_event_id"
        ]
      ],
      "time_columns": [
        {
          "column": "event_at",
          "role": "event"
        }
      ],
      "default_filters": [],
      "constraints": []
    }
  },
  {
    "object_id": "table-dim_customers",
    "entry_id": "description",
    "structure": {
      "kind": "table",
      "grain": "一个已知客户",
      "unique_keys": [
        [
          "customer_id"
        ]
      ],
      "time_columns": [],
      "default_filters": [],
      "constraints": []
    }
  },
  {
    "object_id": "table-customer_tags",
    "entry_id": "description",
    "structure": {
      "kind": "table",
      "grain": "一个客户的一种标签",
      "unique_keys": [
        [
          "customer_id",
          "tag"
        ]
      ],
      "time_columns": [],
      "default_filters": [],
      "constraints": []
    }
  },
  {
    "object_id": "field-paid_amount_cents",
    "entry_id": "meaning",
    "structure": {
      "kind": "field",
      "table": {
        "object_id": "table-demo_order_detail",
        "version": "1"
      },
      "column": "paid_amount_cents",
      "unit": "分"
    }
  },
  {
    "object_id": "field-refunded_amount_cents",
    "entry_id": "meaning",
    "structure": {
      "kind": "field",
      "table": {
        "object_id": "table-demo_order_detail",
        "version": "1"
      },
      "column": "refunded_amount_cents",
      "unit": "分"
    }
  },
  {
    "object_id": "field-quantity",
    "entry_id": "meaning",
    "structure": {
      "kind": "field",
      "table": {
        "object_id": "table-demo_order_detail",
        "version": "1"
      },
      "column": "quantity",
      "unit": "件"
    }
  },
  {
    "object_id": "relationship-payments",
    "entry_id": "join",
    "structure": {
      "kind": "relationship",
      "left_table": {
        "object_id": "table-raw_order_lines",
        "version": "1"
      },
      "right_table": {
        "object_id": "table-raw_payments",
        "version": "1"
      },
      "join_keys": [
        {
          "left_column": "order_id",
          "right_column": "order_id"
        },
        {
          "left_column": "line_id",
          "right_column": "line_id"
        }
      ],
      "cardinality": "one_to_many",
      "scope": "直接订单行关联原始付款事件；汇总付款事件后关联的形状不同，不能沿用此基数。"
    }
  },
  {
    "object_id": "relationship-tags",
    "entry_id": "join",
    "structure": {
      "kind": "relationship",
      "left_table": {
        "object_id": "table-demo_order_detail",
        "version": "1"
      },
      "right_table": {
        "object_id": "table-customer_tags",
        "version": "1"
      },
      "join_keys": [
        {
          "left_column": "customer_id",
          "right_column": "customer_id"
        }
      ],
      "cardinality": "many_to_many",
      "scope": "订单行与客户标签均可能重复customer_id；仅筛选客户标签时优先EXISTS或去重客户列表。"
    }
  },
  {
    "object_id": "metric-net_revenue",
    "entry_id": "definition",
    "structure": {
      "kind": "metric",
      "table": {
        "object_id": "table-demo_order_detail",
        "version": "1"
      },
      "expression": "SUM(paid_amount_cents - refunded_amount_cents)",
      "input_grain": "订单商品行",
      "time_column": "paid_at",
      "unit": "分",
      "required_filters": [
        "is_test = 0",
        "paid_amount_cents > 0"
      ],
      "dimensions": [
        "channel",
        "region"
      ]
    }
  },
  {
    "object_id": "metric-paying_customers",
    "entry_id": "definition",
    "structure": {
      "kind": "metric",
      "table": {
        "object_id": "table-demo_order_detail",
        "version": "1"
      },
      "expression": "COUNT(DISTINCT customer_id)",
      "input_grain": "订单商品行",
      "time_column": "paid_at",
      "unit": "人",
      "required_filters": [
        "is_test = 0",
        "paid_amount_cents > 0"
      ],
      "dimensions": [
        "channel",
        "region"
      ]
    }
  }
]
```
