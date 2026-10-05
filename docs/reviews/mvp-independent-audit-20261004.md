# MVP 独立复审：实现与既定要求的差距

日期：2026-10-04  
结论：**需要修复后重新审查，不能关闭当前 I2-MVP。** 本轮确认 9 项实现问题：3 项 P1、6 项 P2。P1 应优先处理；P2 也是既定行为的缺陷，并非新增功能要求。

## 审计依据与范围

依据为 [AGENTS.md](../../AGENTS.md)、[系统设计第 17–21 节](../semantic-retrieval-design.md)、[模块实现设计](../architecture/implementation-design.md)、[知识模块契约](../architecture/knowledge-modules.md)、[运行模块契约](../architecture/runtime-modules.md)和当前源码。先从要求检查入口、事务、状态和失败分支，再核对测试有没有证明对应行为。

本轮有两路未参与相应实现的独立只读审查：查询链路、Pi 运行与恢复。主审复核调用链，并亲自重跑两个 Pi 探针、平台内存探针和契约检查。没有以实现者总结作为通过依据。

审计开始时重新计算了上一轮审查范围：226 个输入文件，SHA-256 为：

```text
94b3f181f65dc5cabefd3bfb65240778d95edf2619ed5e2a5d1687bc4509228a
```

它与上一轮记录一致。因此，以下问题存在于当时已审查的代码中，不能归因于后来代码变化。历史测试通过仍是有效的局部事实，但“本地范围没有未解决阻断问题”的判断已被本次反例推翻。

本轮不修业务源码。只保存审计材料、将 CURRENT 的审查状态置为 pending；保留原审查与原日志，不回写历史结论。

## 1. 确认的问题

### IA01 · P1：只修改 SQL 时，旧草稿仍能确认执行

- **要求：**系统设计第 18.2 节、运行模块 M07 的 save_draft_in_tx 要求新版本替代受影响的旧待确认请求；AGENTS 第 5、6 条要求确认固定版本且旧请求不覆盖新状态。
- **触发：**业务条件已经正确，模型先给 SQL A，再仅修正 JOIN 或聚合写法生成 SQL B，task_id 和 condition_version 不变。
- **实现：**[queries/store.rs](../../crates/data-agent/src/modules/queries/store.rs):55–64 只增加 draft_version 并插入新请求，没有记录替代关系或作废旧请求。第 81–97 行只比较用户确认参数与旧请求自身的版本；[query_workflow.rs](../../crates/data-agent/src/use_cases/query_workflow.rs):43–51 检查的条件版本仍然有效。因此 A 和 B 都能进入 queued。
- **影响：**用户回到旧卡片或旧页面，仍可执行已被纠正的 SQL。
- **证据范围：**完整静态调用链。现有 check-query-boundaries.mjs:130–136、152、177、201 在同任务同条件下创建并分别确认多份 SQL，证明入口允许这种状态；本轮未实跑 MySQL。
- **修复与验收：**明确区分“新增独立查询”和“修订哪份草稿”，在服务端原子替代实际被修订的请求。D15 允许一个分析包含多个独立查询，不能简单把同任务的所有草稿都作废。补 SQL-only 修订、旧卡片确认、多查询共存和并发确认反例。

### IA02 · P1：清除人工文档覆盖，会先保存坏值再返回错误

- **要求：**知识模块 M02 的 effective_value 必须有明确取值规则；AGENTS 第 4、7 条要求边界数据有效、人工编辑可靠。
- **触发：**在语义管理中新建一个人工文档，编辑正文，点击“清除人工覆盖”。
- **实现：**[KnowledgePage.tsx](../../apps/web/src/features/knowledge/KnowledgePage.tsx):120–123 对这种文档显示清除按钮。[knowledge/store.rs](../../crates/data-agent/src/modules/knowledge/store.rs):212 创建的 suggestion 是空对象；第 175–178 行清除时直接读取不存在的 suggestion.value，Rust serde_json 得到 null，并在第 197 行保存新版本。
- **提交顺序：**[use_cases/knowledge.rs](../../crates/data-agent/src/use_cases/knowledge.rs):123 先提交事务，随后 [data_routes.rs](../../apps/api/src/data_routes.rs):74–78 调用响应校验。[schema.json](../../packages/contracts/schema.json):1336 要求 effective_value 为 string，因而返回 invalid_input，但数据库已经变化。
- **影响：**用户看见保存失败，实际版本却已推进；再次读取该对象、或返回包含该对象的知识列表时仍会被响应契约拒绝。旧正文在历史版本中，不能描述为不可恢复的删除。
- **证据范围：**完整静态路径，加实际 JS 契约探针：原人工条目通过，清除后 null 被拒绝。探针只验证输出形状，不冒称执行了 Rust 存储或数据库。
- **修复与验收：**为无来源、无建议的条目明确清除语义，确保生成的正式对象在提交前有效。补“纯人工正文 → 清除 → 读取对象/列表 → 再编辑”及失败不落坏状态的测试。

### IA03 · P1：停用依据后，历史 SQL 和说明仍可重新进入模型

- **要求：**AGENTS 第 7 条、系统设计第 18.4 节、运行模块的恢复依据规则要求失效资料及派生内容不能经旧工具结果重新进入新运行。
- **触发：**Q1 已执行成功，其 knowledge_refs 包含 K1。维护者停用 K1 后，同一用户在同一会话发新消息，模型调用 get_query(Q1)。
- **实现：**[data_tools.rs](../../crates/data-agent/src/use_cases/data_tools.rs):109–114 调用结果读取，依据检查会失败；该错误被包装成 results.error 后继续执行。第 365–371 行仍返回完整 query，包括历史 SQL、summary、parameters 和 knowledge_refs。
- **为何后续检查拦不住：**新运行的授权快照在 K1 停用后建立，本来就不包含它。[context_authority.rs](../../crates/data-agent/src/use_cases/context_authority.rs):45–73 只合并当前有效集合，没有把此次取回内容的失效依赖加入检查。
- **影响：**上下文虽已重建，旧口径仍能经查询工具回流，模型可能继续用它解释或生成新 SQL。本项是同用户同会话的依据有效性问题，不声称跨用户泄露。
- **证据范围：**主审与查询审查者分别复核完整静态链；未实跑 MySQL 或模型。
- **修复与验收：**向模型返回查询正文前检查其依据；依据失效时只返回必要状态与原因。补停用、改版后的新运行 get_query 实际载荷断言，不能只检查旧查询不允许确认。

### IA04 · P2：多工具恢复再次中断后，会永久漏接未完成工具

- **要求：**运行模块 M08、A02、C05 要求恢复接回原 SDK 调用和 operation_id，未决副作用不能靠重新生成回答跳过。
- **触发：**一个 assistant 消息包含两个工具。恢复成功接回第一个；登记第二个后、业务提交前再次中断。
- **实现：**[deliver.ts](../../apps/agent/session/deliver.ts):42 仅在最后消息为 assistant 时回放。接回第一个后，第 55–70 行追加 toolResult；[data-tools.ts](../../apps/agent/tools/data-tools.ts):98–108 为第二个登记的检查点已以 toolResult 结尾。再次恢复跳过整个回放分支。
- **影响：**第二个工具保持 registered，最终提交被 [runtime/store.rs](../../crates/data-agent/src/modules/runtime/store.rs):201–208 拒绝。之后重复恢复仍无法补上，最终耗尽交付重试。
- **实际探针：**运行真实 deliver、dataTools、SessionManager 和锁定 Pi SDK，替换 RustTransport 为内存账本并禁止网络。主审重跑得到 checkpointLastRole=toolResult；第一工具 succeeded，第二工具 registered；第二次运行没有再接回第二工具，finish 返回 version_conflict。
- **修复与验收：**识别最后一轮 assistant 中尚未匹配结果的调用，沿原身份接回；补双工具、多个中断点、重复恢复及副作用次数断言。探针中的 Rust 终态检查为内存替身，还需实际数据库恢复测试。

### IA05 · P2：恢复分支绕过 Pi 的溢出压缩处理

- **要求：**AGENTS 第 12 条要求复用 Pi 的会话续接、上下文压缩及恢复；应验证它们的组合。
- **实现：**[deliver.ts](../../apps/agent/session/deliver.ts):209–211 在恢复时直接调用底层 session.agent.continue()。锁定 Pi 1.0.0 的 AgentSession._runAgentPrompt 在正常 prompt 后执行 _handlePostAgentRun，里面包含溢出压缩与继续生成；直接调用底层 continue 不经过这段处理。
- **实际对照：**相同合成历史，内存 provider 首次生成返回 request_too_large: model_input_limit。正常输入：2 次生成、1 次 SDK 摘要、成功提交。恢复输入：1 次生成、0 次摘要、model_run_failed。两路均运行实际桥接和 SDK；主审已重跑，无网络、无官方请求。
- **影响：**长会话恢复后的大上下文或大工具结果可能直接失败，而正常路径能自行压缩完成。
- **修复与验收：**核对当前 SDK 提供的会话级继续方式，保留原恢复链与预算并经过原生完成后处理；补恢复和压缩的组合测试。不要为此另写一套压缩器。

### IA06 · P2：平台明确拒绝 SQL 后，会进入持续重提循环

- **要求：**AGENTS 第 6 条、系统设计第 19.7 节要求区分明确失败与回执未知，并有有限重试。
- **触发：**检查通过后平台能力改变，提交返回明确的 sql_not_supported，平台没有创建查询记录。
- **实现：**[query_workflow.rs](../../crates/data-agent/src/use_cases/query_workflow.rs):140–145 将普通错误统一记为 submission_unknown。随后 lookup 返回 not_available，第 151–154 行调用 retry_missing_in_tx；[queries/store.rs](../../crates/data-agent/src/modules/queries/store.rs):204–209 将状态改回 queued。这个循环没有次数或截止条件。
- **影响：**查询一直待查证，持续请求平台，无法进入可供修订的失败状态。
- **证据范围：**主审直接执行原 Platform 类的内存 SQLite 探针：检查 SELECT ABS(-1) 成功，再在探针进程收紧函数白名单，实际 submit 返回 sql_not_supported，lookup 返回 not_available。Rust 循环来自完整静态状态转移，未运行实际 Worker/MySQL。
- **修复与验收：**明确拒绝进入失败终态；未知回执继续查证。补检查后能力变化、明确拒绝不重提、真正未知不重复执行的测试。

### IA07 · P2：SQL 执行失败没有诊断，模型无法据此修正

- **要求：**系统设计第 14、15 节要求给模型足够的真实错误，支持调查、修改 SQL、再次展示确认。
- **实现：**[platform-mock/server.py](../../apps/platform-mock/server.py):82 捕获 sqlite3.Error 后只设置 failed，第 92 行回执没有错误字段。语法检查在第 47–48 行也统一压成 sql_not_supported。
- **实际反例：**原 Platform.compile 接受 SELECT ABS(-9223372036854775808) AS n；提交 running，lookup 返回 failed，但没有 integer overflow 或其他诊断。主审在纯内存 SQLite 重跑了该结果。
- **影响：**正式页面和 get_query 只收到“失败”，无法区分溢出、超时或语法问题。本项针对已接受的合成平台也应具备的失败行为，不要求现在接入真实 Datasight。
- **修复与验收：**保存适当处理后的错误类别与诊断，贯穿平台回执和工具结果。补编译错误、执行错误、超时三类结果，以及修订后必须重新确认。

### IA08 · P2：删除会话会阻止已发模型请求结算

- **要求：**系统设计第 19.8 节、运行模块模型账本契约允许晚到可靠 usage 结算原调用，不授予新的执行权。
- **触发：**模型请求已经发送，用户在响应或结算前删除会话，随后原 call_attempt_id 带可靠 usage 回来。
- **实现：**[model_calls.rs](../../crates/data-agent/src/use_cases/model_calls.rs):64 调用普通 lock_conversation_in_tx；[conversations/store.rs](../../crates/data-agent/src/modules/conversations/store.rs):64–66 对 deleted 会话返回 not_available，导致第 69 行结算不可达。
- **影响：**可靠用量无法入账，原费用预留持续占用同一 trial 额度。它会影响其他会话的可用额度；本轮没有证据表明它会绕过费用上限。
- **证据范围：**完整静态分支与提交顺序。取消运行的晚到结算例外存在，但会话删除在更早的检查处将它拒绝；未实跑数据库。
- **修复与验收：**在保留归属及原尝试绑定检查的前提下允许收尾结算；补删除与可靠 usage 交错、重复结算、无新请求权限的测试。

### IA09 · P2：Skill 选择的操作 ID 冲突会返回虚假的成功

- **要求：**AGENTS 第 6 条和知识模块 M09 的 select_skill_in_tx 要求稳定幂等；同操作重传不能改变请求身份或谎报结果。
- **触发：**同一用户用 operation_id=X 选择 Skill A，之后把同一个 X 用于另一份 Skill B 或另一个会话。
- **实现：**[assets/store.rs](../../crates/data-agent/src/modules/assets/store.rs):151–155 只用 ON DUPLICATE KEY UPDATE 更新 asset_version，随后返回本次输入资产 selected=true。[迁移 002](../../migrations/202610040002_mvp_workflows.sql)以 id 为主键，并有 owner/conversation/asset 唯一键；冲突时不会把旧行的 asset_id 或 conversation_id 改成新请求，也没有异参拒绝或原回执读取。
- **影响：**接口说 B 已选择，实际记录仍是 A；若版本不同，还可能使 A 的选择失效。前端通常生成随机 UUID，所以这主要是请求重放和接口一致性边界，不声称普通点击每次都会触发。
- **证据范围：**入口、SQL、唯一约束及读取链静态确认；未跑 MySQL。已有测试只覆盖普通选择、过期版本和另一用户，未覆盖同 ID 异参。
- **修复与验收：**按用户及操作保存请求指纹和原回执；同 ID 异参拒绝，同参重传返回原结果。补跨资产、跨会话冲突和回执与实际选择一致性测试。

## 2. AGENTS.md 的执行情况

| 约定 | 本轮判断 |
| --- | --- |
| 高内聚、低耦合、私有 store | 当前 Rust 模块有私有存储与具名 use_cases；本轮模块依赖、SQL 位置和表 owner 检查通过，7 个检查器反例通过。未发现需要重拆微服务才能修复的问题。 |
| 跨语言契约单一真源 | Rust/TypeScript 生成结果与 JSON Schema 一致；实际 JS 校验跑过 94 个已有用例。IA02 说明校验存在不等于事务提交时机正确。 |
| 确认与版本由程序保证 | 条件修订已有保护，但 SQL-only 修订缺少替代关系，见 IA01。 |
| 幂等、恢复、失败分类、预算 | 有持久账本和租约；IA04–IA06、IA08–IA09 说明组合边界仍有缺口。 |
| 语义依据有效、人工编辑受保护 | 已有来源/建议/人工分层；IA02、IA03 违反正常维护与失效内容约束。 |
| 复用 Pi | 确实使用 createAgentSession、SessionManager、prompt、compact、abort，未发现另造 Agent 规划循环。IA04、IA05 是桥接适配不完整。 |
| 测试来自要求、不能自报完成 | 前述测试不能覆盖本轮反例，尤其“恢复通过”和“压缩通过”不能推出“恢复中的压缩通过”。旧通过记录必须保留其局部范围。 |
| 命名与范围 | 抽查未发现将临时步骤编号当业务模块名的情况；这是抽查结论，不代表所有名称均经完整语言审校。36 项要求继续保留。 |

本轮未重新检查完整视觉和无障碍体验，不能对奖项品质作结论。查询并发确认、结果过期等既定要求仍需实际集成证据，不能因静态无新发现而视为通过。

## 3. 已知未完成范围继续保留

这些不是本次新增 bug：

1. AC08：真实 DeepSeek 在取数、分析、纠错、引用和语义预填上的业务质量尚未验收。原小样不能代替完整业务评价；本轮官方请求为 0。
2. AC09：全目录通用导入、Embedding/Milvus 组合检索、千表召回/延迟/成本、真实平台/认证及获准试用仍未完成。现有目录为 31 个合成对象：5 表、13 字段、3 指标、8 文档、2 关系。来源处理还依赖手编 semantic-catalog，字段结构刷新含固定样例表逻辑。
3. D04、C06 等扩大范围原本就分配到 I3，不能说本轮才被偷偷删掉；但它们仍属于既定完整范围，也不能把当前固定样例闭环称为全部 MVP。
4. 新模型费用额度尚未获明确选择。先修复上述本地问题即可推进，不需要为完成本次审计再请求费用授权。

## 4. 本轮实际执行与证据限制

| 检查 | 本轮结果 | 证明范围 |
| --- | --- | --- |
| 审查范围指纹重算 | 226 文件，与旧记录一致 | 代码范围一致，不代表旧审查结论正确 |
| check_architecture.py 与 tests/architecture | 退出 0，7 项通过 | 既有模块边界规则和反例 |
| npm run contracts:check | 退出 0 | 生成类型未漂移 |
| 94 组 JS 契约 + 人工文档 null 探针 | 退出 0；null 被当前契约拒绝 | JS 运行时契约，未重新编译 Rust |
| 多工具恢复探针 | 第二工具未被再次接回，finish 拒绝 | 真实桥接/SDK，Rust 账本为内存替身 |
| 恢复与压缩对照探针 | 正常成功，恢复失败 | 真实桥接/SDK 与内存 provider |
| 平台拒绝和运行错误探针 | 明确拒绝 + lookup 缺失；执行失败无错误诊断 | 实际 Platform 类、纯内存 SQLite |
| make verify-delivery | 完整退出 0，15 项检查器测试通过 | 只核对记录与要求覆盖，不证明上述缺陷已修复 |

探针命令与输出保存在本机忽略目录 .local/checks/mvp-independent-audit-20261004-probes.json；机器可读的审查索引为 [mvp-independent-audit-20261004.json](mvp-independent-audit-20261004.json)。

本轮没有重跑 MySQL、浏览器、构建或真实模型验收，没有读取凭据、调用外部模型、提交或推送 Git。完整静态路径、实际内存探针和历史集成证据在本报告中分别注明。

## 5. 后续修复顺序

先修 IA01–IA03 的用户确认、正式知识和失效依据边界，再修 IA04–IA09 的恢复、平台失败、结算和幂等。将对应反例加入现有验收命令，在修复后的代码上重新独立审查；通过后再进行已获授权范围内的真实业务验收。不得通过删除场景、放宽版本校验或改成固定演示答案关闭问题。
