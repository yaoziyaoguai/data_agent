# Dogfood 修复包实现审查（2026-11-15）

- **性质**：独立只读实现审查。审查代理未参与本轮产品、测试或文档实现，与 2026-11-14 的[编包审查](dogfood-repair-package-review-20261114.md)相互独立——编包审查针对修复方案，本记录针对实施结果。
- **依据**：[执行包](../execution/semantic-runtime/dogfood-report-repairs.md)六项任务、[修复提示](../execution/semantic-runtime/DOGFOOD_REPAIR_PROMPT.md)确认的政策约束、`docs/CURRENT.md` 各任务节声明。
- **范围与方法**：逐任务对照声明与实现源码（Rust 三 store、Node 工具目录/交付链、Python 平台守卫、schema 契约、迁移 SQL、测试与既有失败记录）；五条政策底线逐条核对；机器可查记录（回执 JSON、迁移、验收日志、`command-13.log` 11-13 失败 6 项与当前场景对照）。范围指纹 `df8d7d…ea3`（`scripts/check_delivery.py` review_scope，覆盖 registry、AGENTS.md 与 38 组验收声明的全部输入；CURRENT.md 不参与该指纹；含 verify-increment 首轮与次轮暴露后按当前合同修正的 history-permissions 断言、tool_contract_version 重放期望之 tests 终态）。
- **结论**：**passed**。任务一/二/三/四/六符合，任务五主体符合；findings 1 项 minor 已补证、3 项表述 note 已修正、其余为观察或既有遗留记录。

## 逐任务判定

| 任务 | 判定 | 关键依据 |
| --- | --- | --- |
| 一 运行政策 | 符合 | 三条签发路径 Option 感知（runtime/store.rs:626-631、model_calls/store.rs:223-228、provider_calls/store.rs:110-116）；迁移仅放宽列无 UPDATE（旧 scope 冻结，check-request-policy.mjs:75、82）；无 48/100 类新上限；连续 3 次熔断、取消不重试、单请求超时、成本上限保留（model_calls/store.rs:229-231、376-394；check-request-policy.mjs:184、201、214） |
| 二 工具参数 | 符合 | prepareArguments 单点拒绝 `source_limits === null`（data-tools.ts:424-436）；契约单一来源 allOf 重构（schema.json AnalysisUpdate/CurrentAnalysisUpdate）；Rust 按 `(name, tool_contract_version)` 选 schema（use_cases/data_tools.rs:521-524）；真实 Pi 前置拒绝用例（check-source-limits.mjs:414-489） |
| 三 就绪状态投影 | 符合 | workspace-context.ts:66 新表头、data-tools.ts:352-359 controlFacts 随成功回执更新；resources.ts/task-projection.ts 同口径；KnowledgePage.tsx 非本轮改动且无矛盾 |
| 四 CTE 只读授权 | 符合 | ReadGuard 物理表白名单+语句局部虚拟关系独立连接探测（platform-mock/server.py:92-124、303、350）；拒绝草稿落库带诊断（queries/store.rs:188-205） |
| 五 资料与维护证据 | 主体符合（1 minor 已补证） | manifest 本地重算 0 不匹配；A13 参数化 SQL 仅 syn_* 合成表；52 条逐字节不变+新增 1；q1–q5 支撑各项数字；q6 全库聚合当时未落盘→已补跑一致 |
| 六 check-answer-state 重修 | 符合 | 22/22、networkAttempts 0；11-13 失败 6 项与当前场景一一对应无删场景；`assert.rejects`→`isError` 为错误码强化；逐请求工具目录断言（:158-160）与 retiredPresent 零 Rust 调用（:298-300）；v1 重放通道完整（:498-504、deliver.ts:517-523） |

## 五条政策底线

1. 取消正常任务累计上限、不新增累计成本/时长硬顶、保留既有熔断：**符合**（见任务一依据）。
2. 无新框架/重复校验/无证据并发守卫；不换 mock、不删场景、不放宽断言、不改题面：**符合**。
3. present_analysis_answer 退役不向 v2 新调用开放：**符合**（Node 目录层强制+测试双向约束；Rust 注册层不硬禁为观察记录，与执行包机制一致）。
4. 代码/测试无阶段/任务/M 编号：**符合**（check-source-limits.mjs:11 "04切片2" 为本轮之前遗留，不清洗）。
5. 面向公开分享的合成材料：**符合**（A13 仅合成表；manifest/expected-results 合成口径；未见真实业务数据、凭据或个人路径）。

## findings 与处置

| 级别 | 内容 | 处置 |
| --- | --- | --- |
| minor | 全库 566/565/1 聚合当时未落盘（q6 有 SQL 无输出） | 沿原只读通道补跑落盘 `q6-all-targets.out`，数字与声明一致；CURRENT 任务五节注明 |
| note | 任务二"15属性"实为 14 | CURRENT 已修正 |
| note | 任务五"53条字节不变"实为 52 不变+新增 1 | CURRENT 已修正 |
| note | 审查时点无任务六记录 | 本轮收口补齐（任务六节+verification.reason） |
| note | Rust 注册层不硬禁 v2 present 注册 | 观察记录，不改（强制点与测试约束在位） |
| note | check-source-limits.mjs 头部既有阶段编号注释 | 早于本轮，不清洗 |
| note | answer-state-contract 目录并存 11-03 遗留工件 | 证据目录保留历史，不删除 |
| 后续 | verify-increment 首轮失败：`--history-permissions` 乙 delta 拼接断言隐含 v1 前提（同 attempt 仅乙正文）；v2 下甲渲染定稿与乙自然尾项共用 attempt 输出流，投影按 unit 权限分别替换（甲隐藏、乙逐字保留，committed 与 includes 断言均过） | 判定非产品缺陷、非放宽：断言预期按 v2 合同修正为隐藏提示+secondBody（仍 strictEqual 全文），复跑 passed、officialRequests 0；记录补入 JSON resolved_findings，scope 指纹随之重算 |
| 后续 | verify-increment 次轮（command-27）失败：`registered_legacy_decisions` 重放幂等断言要求重放回执与首次回执全量相等，而 `replay_receipt` 按设计移除动态事实字段 `frozen_notification_covered`（通知覆盖以启动/刷新的当前事实为准，Node 侧配套） | 判定产品行为正确、测试期望过期：修正为断言首次回执该字段值为 false + 重放回执与剥离该字段后的首次回执全量严格相等（create/revise 两处，强度不降），单独复跑 passed、officialRequests 0。另无 filter 全量组合跑暴露 3 个失败，均不在 38 组验收命令范围（验收仅两条 filter 命令且分别绿），失败点在本轮修改点之前且属其他测试或存储错误，与本轮修改无因果；如实记录不在本包定性 |

## 局限

- 只读审查未运行测试/构建/迁移；22/22 基于保存回执与源码静态核对。
- 工作树整体未提交（HEAD 04d27d0），本轮/早前边界依赖 mtime 与回执时间戳。
- MySQL 迁移效果、manifest 生成脚本、verify-increment 全链、真实 provider 行为未独立核验；真实付费复验不在本审查范围。

机器可读记录：[dogfood-repair-implementation-review-20261115.json](dogfood-repair-implementation-review-20261115.json)（scope_sha256 与 check_delivery.py review_scope 一致）。
