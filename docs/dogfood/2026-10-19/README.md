# Data Agent 全功能 Dogfood 试用包

版本：2026-10-19；产品代码基线与材料指纹见 `manifest.json`。本包只准备试用材料，**本轮 160 项均初始化为 `not_run`**，不继承旧试用的通过状态。

先读 [START.md](START.md)，把 [AGENT_PROMPT.md](AGENT_PROMPT.md) 交给执行 Agent。完整场景见 [手册](guide.html)、[Markdown 清单](CASES.md) 或 [scenarios.json](scenarios.json)。给 Agent 按批读取 JSON，可减少上下文；不必一次加载整本手册。

| 内容 | 范围 |
| --- | --- |
| 原有场景 | B01–B41、M01–M20、C01–C22、A01–A08、X01–X10、E01–E19，共 120 项 |
| 修复与升级回归 | R01–R24，覆盖范围、口径、单位、粘贴 SQL、历史缺口、长结果、澄清、检索、预填和 Pi 1.3 |
| 复杂连续任务 | Z01–Z16，跨任务、查询、报告、记忆、Skill、维护、权限、恢复和长上下文 |
| 功能映射 | [coverage.md](coverage.md)，43 个覆盖主题，每项有对应场景 |
| 环境与准备 | [OPERATIONS.md](OPERATIONS.md)、[环境模板](environment.template.json)、本机忽略目录的 `ENVIRONMENT.local.json` |
| 独立参考 | [reference/expected-results.json](reference/expected-results.json)、[评分规则](reference/GRADING.md)，不进入产品模型输入 |
| 执行记录 | [结果模板](records/results-template.json)、[问题模板](records/ISSUE_TEMPLATE.md)、[交接模板](records/HANDOFF_TEMPLATE.md) |

本包覆盖当前已实现的用户入口和重要能力边界，不宣称穷尽所有自然语言输入。真实 Datasight、生产认证、自动发现新表、来源变化自动同步、任意附件解析与生产容量仍不在已实现结论内，见 [SCOPE.md](SCOPE.md)。

本机准备时的真实环境入口是 `http://127.0.0.1:27173/`，Flash/off、Mem0、词法检索、合成分析数据。它不是所有场景都可直接执行的隔离沙箱：**不要在用户正在使用的环境改表负责人、停用基线资料、注入故障、删除索引或重启服务**。

材料复核（不调用模型，不操作服务）：

```sh
python3 docs/dogfood/2026-10-19/build.py --check
python3 docs/dogfood/2026-10-19/build.py --case R04
python3 docs/dogfood/2026-10-19/build.py --list regression
```

原 120 项完整冻结副本为 [legacy-cases.json](legacy-cases.json)。新清单只将其 `DF1014` 命名前缀替换成 `{{run_prefix}}`，原 SQL、日期、数值和验收预期保持。新 R/Z 场景是补充，不把变体成功倒填为原案例成功。

文档链接以仓库根目录执行命令；资料来自从零构造的合成样例。本包不含凭据、真实业务资料或旧私密会话。材料生成与静态核对只证明包可读、引用一致和独立样例可计算，**不证明产品或真实模型已通过试用**。
