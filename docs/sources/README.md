# 合成资料入口与历史零售回归夹具

日常默认已切换到[座舱语音资料](cockpit/README.md)：28表、421字段、26指标和14份文档；配套[100项递进Dogfood](../dogfood/cockpit/README.md)。本目录根部五表和`analysis/`只保留已有回归所需的输入与独立答案，不再用于默认演示。

## 历史零售夹具

本目录全部业务材料从零构造，不包含真实公司元数据、加工 SQL、订单、客户或内部链接。样例只有演示用途，不复制任何真实业务口径。

## 文件与用途

| 文件 | 用途 |
| --- | --- |
| `schema.sql` | SQLite 3 的源表和 `demo_order_detail` DDL |
| `seed.sql` | 13 个虚构订单、15 个订单行、20 个付款/退款事件、7 个客户、8 个标签关系 |
| `etl.sql` | 生成快照：成功事件先按行汇总，再关联订单行与唯一客户 |
| `business-guide.md` | 字段、单表、跨表业务的长说明，可被章节引用 |
| `knowledge-manifest.json` | 允许构成知识输入的文件列表；不包含验收答案 |
| `semantic-catalog.json` | 从允许的三份知识来源生成的语义目录及来源内容指纹，保留原文、派生依据和未知 |
| `evaluation/` | 独立参考查询、手工核算的预期结果、行为要求和预填参考；默认不对模型检索开放 |
| `evaluation/prefill-cases.json` | 五个代表字段的预填事实、可核对出处、未知、禁止断言及人工修改保护要求 |
| `verify.py` | 标准库脚本，内存中建 SQLite、运行加工、逐题比较结果并检查边界 |

核心表的粒度是一订单行，主键为 `(order_id, line_id)`。金额为整数分，时间为 UTC。快照截止 `2026-02-04T00:00:00Z`。主表直接上游是 `raw_order_lines`、`raw_payments`、`dim_customers`；`customer_tags` 是查询时的一对多关联表。

## 本地验证

在仓库根目录运行：

```sh
python3 scripts/build_semantic_catalog.py --check
python3 scripts/test_semantic_catalog.py
python3 docs/sources/verify.py
```

目录检查是只读操作：来源或生成物变化时返回非零，不改写旧目录。确认来源修改后，运行 `python3 scripts/build_semantic_catalog.py` 更新生成物。`--source-directory <目录>` 可在隔离的合成资料副本上生成或检查；该目录必须包含相同的知识允许列表。

如需保存本次运行证据：

```sh
python3 docs/sources/verify.py --report docs/sources/evaluation/verification.json
```

只使用 Python 标准库和进程内存，不需要数据库服务、不读取凭据、不调用模型，不写入业务数据库。脚本失败会返回非零退出码。原有13条独立参考与11项数据边界保持，另核对目录可复现、三个目录指标与独立参考数值一致、零订单的退款率为空值，共29项；目录工具的8项检查还覆盖只读行为、错误类型、知识输入隔离和来源定位。

离线查询方言是 **SQLite 3**。项目的 **MySQL** 用来保存 Agent 应用记录；两者用途不同。这个样例不代表真实数据平台的 SQL 能力，也不代表 Pi 或 DeepSeek 已经接入成功。

## 知识与验收分开

应用导入知识时按 `knowledge-manifest.json` 的允许列表读取，不要递归索引整个目录。整个 `evaluation/` 都是独立验收资料，不进入索引、提示词或 Skill；参考答案不会自动成为已验证案例。各项用途如下：

- `queries/` 和 `cases.json`：参考 SQL 和预期数值，供离线脚本核对。
- `behavior-cases.json`：保留 B01–B08 编号，之后验证澄清、确认、个人偏好保存与复用等交互；当前脚本不执行这些行为。
- `prefill-cases.json`：保留 P01–P05 编号，之后检查自动预填是否有依据、是否保留未知，以及重新预填是否保护人工修改。只允许用合成包中的 DDL、加工 SQL 和业务说明作为知识输入；每条参考附相对路径及可匹配原文。人工修改样本仅用于验收界面行为，不扩充业务事实。

预填按事实和依据判定，不要求生成文字逐字一致。JSON 可解析、出处存在，只能证明参考材料可核对，不能证明自动预填已通过。这些脚本不执行真实 Agent 或预填服务；它们的结果不能由29项离线 SQL、边界与目录检查的通过数推断。

当前离线验证范围是合成数据、加工逻辑、参考 SQL 和预期结果的一致性。真实模型工具调用、SQL 确认、权限隔离、后台恢复、大目录检索都需要后续工程实现后分别验证。

## 独立的多月分析样例

`analysis/` 沿用相同五表和加工定义，使用另一份从零生成的种子，覆盖2026年1月至3月的付款、跨期退款和客户多标签。该目录有自己的知识允许列表、来源指纹、目录与独立核算；原13条参考答案和29项核算保持。

```sh
python3 docs/sources/analysis/generate.py --check
python3 scripts/build_semantic_catalog.py --source-directory docs/sources/analysis --check
python3 docs/sources/analysis/verify.py
```

`analysis/evaluation/` 的趋势、渠道变化贡献、标签去重及退款发生时间答案只用于验收，不进入模型输入。模型可以通过获准查询读取实际合成数据；业务说明提供数据范围和口径，不预告生成器安排的变化或业务原因。

## 目录中的来源分类

DDL 和加工 SQL 保存可逐字核对的原文。业务说明、指标别名、计算 SQL 和关联解释属于人工制定的合成业务定义，统一放在 `business-guide.md`，目录标记为 `authored_definition`，不能冒称平台注释或模型验证结果。字段类型的规范显示由实际 DDL 确定，原始声明保存在来源事实中，派生方法和引用保存在建议中。

未提供来源表加工 SQL 时明确留空并记录缺口，不能把“当前没有材料”写成“该表不存在加工”。所有生成条目保持待核对状态；模型预填和人工覆盖由应用流程另行保存。生成器只读取清单和三份知识材料，`verify.py` 则可以读取独立验收材料，将目录中的计算 SQL 与独立答案比较；两者用途不同。
