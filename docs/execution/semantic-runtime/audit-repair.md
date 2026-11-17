# 05–08 审计问题修复与升级收尾执行包

编制日期：2026-10-31。用途：交给下一位 coding agent，接续已有实现，修复已证问题并完成 08 的正式验收。**本包是待执行规格，不是修复完成报告。当前进度、实际授权和验收状态只在 [CURRENT](../../CURRENT.md)。**

本轮编包不修改产品或测试。实施者收到用户交付的执行任务后，在本包范围内连续推进，完成 08 后停止；不自动进入 09，不重新实施 01–08，不把历史绿色记录当成本轮通过。

## 1. 入口、结果与边界

启动必读仅有：

1. 根目录 [AGENTS.md](../../../AGENTS.md)。
2. CURRENT 顶部最新决定、`delivery.increment` 和“05–08 审计问题执行包”小节；不先通读历史。
3. 本文件第 1–3 节及当前工作项；[交接提示](CONTINUATION_PROMPT.md)只组织执行，不另定义合同。
4. [审计报告](../../reviews/semantic-runtime-audit-20261031.md)的结论与当前工作项；需要独立证据时查[独立审查](../../reviews/semantic-runtime-closure-review-20261031.md)。

当前工作项必读资料在第 4 节逐项列出。正式业务依据仍为[实现设计](../../architecture/implementation-design.md)第 17.4–17.8 节、[Pi 复用约束](pi-reuse.md)及原 05–08 详细包。只在问题涉及时展开其他章节、原型和日志；不重启架构选型或访谈。

完成后，用户可观察到：

- 来源不同或未知、需要分别交付的多任务，不会因只提交最后一个答案而全部变成已回答；合法单任务和同来源综合回答仍自然结束。
- 公共检索内容裁剪后，已核验的额外个人记忆仍有身份及补读入口；Rust 保存的最终回执与模型实际看到的内容一致。
- 依据正文和支持慢读不占会话锁；搜索支持沿原搜索期限，部分结果和未完成原因如实交付。
- 历史报告能区分“条件变化”和“读取失败”，失败可重试，正文未加载时不声称已经展示旧内容。
- 已有的冗余锁、死入口和同侧重复结构校验确实被替换或删除；必要权限、版本、原操作与恢复边界保持。
- 08 的旧状态升级、兼容恢复和切换在同一冻结版本下完成正式验收。真实模型质量、真实平台和 09 整体 dogfood 仍未由本包证明。

### 不做的内容

- 不改存储选型、模块划分、模型策略或 SDK 版本；不加图服务、问题重写/重排模型、第二个 Agent 循环、摘要器或恢复服务。
- 不重做已完成的同步、整理、索引建设；千表是检索底库规模，局部修复不要求每次重建全量索引。
- 不增加记忆游标服务、答案正文库、长期双索引、通用迁移框架或旧语义变更监听。
- 不实现未证的 `stale_source` 批量 catch；目前未找到通过正常受支持写入触发的反例。
- 不执行 09，包括杀死并重启 Node 的综合 dogfood；已有父进程 abort/redeliver 和 Worker 重派不能写成该项通过。
- 不付费调用真实模型/embedding，不提交推送，不发布部署，不更新日常服务，不改用户主库或真实配置。发现必须增加这些操作时说明具体阻塞，继续其他独立工作。

## 2. 接手事实与工作归属

编包时分支为 `codex/semantic-maintenance-prototype`，HEAD 为 `04d27d06ba7b97d4cf3e288d4cf9e6300ef491a9`。工作树包含此前多个阶段的大量未提交改动。接手先核实际状态，**不要 reset、覆盖或把全部 HEAD 差异算作这次审计的修改**。

本地审计资料目录为 `.local/audits/semantic-runtime-20261031-60e76a2d/`：

- `before-manifest.json` 与 `before/`：上一轮审计接手快照。
- `audit-only-stop-manifest.json`：用户要求暂停修复时的 24 份变化清单，不是完成收据。
- 各问题的 RED、局部 GREEN 和 Oracle 原始答复：按审计报告索引取用。

这些文件在忽略目录中，不能假定另一台机器已有；缺少时保留证据缺口，使用现有正式测试重建最小反例，不伪造历史输出，也不为恢复快照回退当前产品。历史 Oracle 两批最高 Power 5/5 已完成，属于**问题审计**；没有把本执行包另送 Oracle 复审，不宣称有该项结论。

| 工作项 | 接手时的实际状态 | 下一动作 |
| --- | --- | --- |
| 多任务有冻结项时漏第三任务 | `task_answers::compose_in_tx` 已修改，曾有 22 项局部 GREEN；后来脚本新增无冻结项 RED，全集不再是绿色 | 保留修复，合并验证两种提交形态 |
| 多任务无冻结项时错误结清 | 产品未修；正式 HTTP/MySQL 已证 RED | 从最终业务提交入口修复 |
| Mem0 额外记忆裁剪丢失 | 产品未修；实际 Pi/provider 与冻结回执已证 RED | 修现有最终分配，不建第二条交付路径 |
| 正文/支持持锁和搜索支持期限 | 已改，三类锁探测及期限、停用、重放曾局部 GREEN | 检查已有三段式接线，完成当前版本回归 |
| SQL 期限和 exact 覆盖状态 | 已改 `knowledge.rs`/`data_tools.rs`，尚未重建或 GREEN | 核实际事实与输出，补状态反例 |
| 历史报告错误/重试 | 已去掉部分 `!changed` 门控，曾 7 项浏览器 GREEN；无正文时的提示未修，503 夹具不完整 | 修提示并补合法服务错误证据 |
| 候选预算同步包装、死入口 | 已简化/删除，曾编译通过；当前预算/进度回归未完 | 核删除后调用链与原不变量 |
| 同侧 TaskInput/scan 重复校验 | 最后一批删除未验证 | 保边界校验，完成传输/续读负控 |
| Clippy 无用 `vec!` | 已改数组，早先 `verify-code` 通过 | 当前树重新静态检查 |
| 08 总验收 | 原第三轮前五组过，第六组 Clippy 失败，后两组未执行 | 修复稳定后执行原八组及受影响绑定，不拼旧结果 |

### 文件责任与允许修改范围

沿用 `I2-COMPATIBLE-UPGRADE`，不新开并行增量。开工时更新 CURRENT 的目标、非目标、实际允许路径、验收和待审状态；不要带着“只审计不修改”的旧声明直接写代码。编包时已留下的验收绑定只是待执行清单。

- **Rust 组合入口由一人顺序整合：** `crates/data-agent/src/use_cases/{finish_run,task_answers,source_limits,data_tools,evidence_delivery,knowledge,knowledge_supports,context_authority}.rs`。优先调用已有 owner 接口；确需窄查询时在所属模块公开接口和私有 store 内实现，不在组合层写裸 SQL。
- **相关 owner：** `modules/{analysis,runtime,retrieval,knowledge}`；只改本包问题直接依赖的函数及冗余导出。`modules/jobs/store.rs` 的旧 raw 短游标锁已有饥饿反例，不在本次候选预算去锁范围。
- **Pi 接入由一人整合：** `apps/agent/tools/update-analysis-task.ts`、必要的 `tools/data-tools.ts`、`session/deliver.ts` 与 `transport/client.ts`。保已实现的检查点、输出 drain 和任务投影，未找到新缺陷不重写。
- **UI：** `apps/web/src/features/workbench/AnalysisReport.tsx` 及对应浏览器测试；不重新设计工作台。
- **测试/证据：** 第 4、5 节明确列出的现有脚本、直接相关 Rust 测试、Makefile 绑定、CURRENT 和受影响设计/开发文档。复用测试 harness 和本地协议入口。
- **Schema/迁移默认不新增。** 当前发现可沿现有合同处理；若发现跨语言字段确实缺失，先给出可达反例和必要变化，使用 `packages/contracts` 真源生成，单一 owner 顺序整合，不能手改 generated 或顺手升级依赖。

可以由同一人完成全部工作；不要求并行。确需有界委派时明确独立文件归属，说明共享工作树、不得撤销他人改动。所有数据库 harness 串行，不能一边审查冻结输入一边继续修改。

## 3. 全程约束与执行节奏

使用已安装 `dev_co` 保持当前交接；新增行为按 `tdd` 做最小反例→修复→相关回归。已有 RED 和已改代码先核证据，不为制造红灯回退产品；未证的新增分支先补可达用例。合同有实际变化才使用 `contract-first`。

1. **防过度防御：** 只修当前要求、已证普通失败或可解释实际路径。新提理论低概率边界先说明触发、证据、影响、代价并请用户决定；概率未知就写未知。不能先加保护再补理由。
2. **入口单次校验：** 相同值、相同约束、同侧不重复验结构。Rust/Node 接收边界、持久化导入、锁外 I/O 后的权限/版本/租约重核属于不同责任，必须保留。
3. **拒绝过早抽象：** 简单单用逻辑默认内联；仅真实复用、明确 owner 责任或明显隔离复杂度才抽取。不得新增万能 helper、配置层或调度框架。
4. **控制复杂度：** 错误默认直接传播；只在明确恢复、边界翻译或补有用上下文时 catch。不能吞错误返回空成功，也不能在多层重复记录/重试。

Pi 仍是唯一 Agent、会话、循环、压缩、取消及恢复机制；核锁定版本，不升级。每消息 24 次模型调用、连续临时失败 3 次保持。检索原 10 秒工作期限、1000 唯一候选及在途预留、5 轮、30 主读保持；必要支持沿既有每回执 50 项与容量规则，不额外造限制。账本结算/最终提交可晚于工作期限，不把它写成 HTTP 必须十秒完成。

本包顺序：**任务交付完整性 → 个人记忆裁剪 → 依据读取与覆盖状态 → 冗余实现复核 → 报告状态 → 冻结和 08 收尾**。前五项分别留下代码、反例与下一动作，不在每个小改后跑整套升级或千表电池。Rust 修改合并到一个可验证切片后再构建；未改源码的重复构建不是新证据。

## 4. 逐项实施与验收

### 4.1 任务交付完整性

**目标与依据：** [07](task-answers.md)步骤 4、5、7及实现设计 17.4；对应审计行为问题 4、5 / 独立审查 SR-01。任务更新和普通 route 不能冒充已交付答案。

**代码入口：** `finish_run.rs` 的自然 final / `answer_parts` 分支和后续 task phase 更新；`task_answers.rs::compose_in_tx`；`modules/runtime/store.rs::delivery_task_refs_in_tx`；现有 `source_limits.rs` 和 analysis 来源范围查询；`deliver.ts` 的 frozen parts 装配。

**实施边界：**

- 在最终业务提交事务内，对 v2 本消息/恢复链的有效交付任务核验。已有 parts 的正常 final 和无 final 两种路径都检查未取消任务覆盖，复用现有规则。
- 除下面已明确的宿主结果通知例外，**所有没有 `answer_parts` 的 v2 最终提交**都核验交付范围，包括普通 `final_text` 和 `answer_sdk_tool_call_id` 指向成功 `present_analysis_answer` 回执两种来源。不能只给无工具自然 final 加检查，留下成功答案工具引用的旁路；也不能借普通 route 把需要分别交付的任务全部结清。按原任务条件版本取得明确范围：多个任务只有范围确实一致时允许原自然综合回答；未知/缺失不能当成无限制。
- 比较 `allowed_sources` 的集合含义；顺序和 `origin_message_ids` 不改变范围。复用已有来源解析/查询责任，不建第二套范围系统，不从正文猜任务完成。
- 保留 v1、普通单任务、两个明确 `source_limits=null`、同一明确允许集合的自然综合路径；不强迫它们增加 route/答案工具/报告或模型汇总。
- 宿主结果通知仍只交付和推进原查询条件版本，不能要求它给所有历史任务提交 parts。正式取消、未结算未知操作、`waiting_clarification` 保持原语义；不以 `active_task` 替代本消息任务集合。
- 拒绝在提交/消费/阶段推进之前发生，并由事务保证原子性。普通 route 仍只切换，不自动冻结；不自动拼接调查文字补答案。

**验收：**

| 场景 | 必须观察到的结果 |
| --- | --- |
| A 已冻结，B 自然 final，C 有效但漏交 | `409 invalid_evidence`；无 committed 正文、无整消息消费，不把 C 标 answered |
| A/B/C 都有合法交付引用 | 同 `output_id` 一次提交三份原文，各一次；不加模型调用 |
| A/B 不同明确来源、无冻结项、只交 B | 正式 HTTP 拒绝；A/B 不因本次失败一起 answered，消息不 consumed |
| A/B 不同明确来源、无冻结项、仅提交 B 的成功答案工具引用 | 新增核验分支，先通过正式工具取得 B 的合法回执，再证明最终提交不能绕过覆盖检查；保留单任务成功答案回执正控，不跳过数字/来源核验伪造回执 |
| 多任务包含旧未知来源范围 | 不视为同范围自然综合；保留单任务旧行为及原有效性边界 |
| 双 null / 相同来源集合不同顺序 | 保原自然综合，无额外工具或强制定稿；来源消息身份不同不改变判断 |
| A 已冻结、B 正式取消、C 恢复回答/澄清 | A+C 正确交付；澄清仍 waiting_clarification；取消 B 不删 C、不重放未知副作用 |
| 查询结果通知、旧查询晚到 | 只推进原 query/condition，不能把当前新任务或新条件结清 |

从 `tests/mvp/check-task-answer-boundaries.mjs` 的现有 RED 开始，跑完整脚本确认后续正控实际到达。保留此前 20 项；不要把“22 项曾通过”当当前脚本通过。成功答案工具引用分支尚未运行：复用 `check-task-query-answers.mjs` 的合法回执构造，在现有边界脚本补最小正负控；若另一条现有业务门已经正确拒绝，则记录其实际依据，不重复加防护。

`check-result-notification-answers.mjs` 原样只覆盖单任务 failed/cancelled/撤权通知，尚不能证明新 v2 多任务检查的例外。保留原三类断言，在同一脚本扩展：显式启用并断言持久 run 的 v2，同会话另有不同明确来源的有效任务，原查询条件随后已修订，通知沿原 query/condition 交付。核其他任务和新条件不被结清、原查询与预算不重做；不能只核通知文案。新增范围以该实际提交路径为限，不另建通知测试框架。

随后用第 5 节的任务正控检查真实 Pi/provider、持久输出和刷新；若只改 Rust guard，不无故重写 Node 输出链。

### 4.2 保留裁剪后的个人记忆

**目标与依据：** [06](evidence-delivery.md)个人资产/最终容量/恢复合同及实现设计 17.6.1；对应审计问题 2 / SR-02。

**代码入口：** `data_tools.rs` 合并 Mem0 候选与资产目录；`evidence_delivery.rs::search_reply` 的资产最小回执和后续填充；现有个人资产类型、`asset_after` 与 `read_knowledge` 的个人资产补读分支。沿原 object_id/version、entry_id 与各正文/范围/原话分页，不加同义工具。

**实施边界：**

- 目录项与已核验的额外 Mem0 项进入同一份现有分配，按资产身份/版本去重。不能只从 `delivery.assets["order"]` 重建完整记忆集合。
- 目录总数和 `asset_after` 仅由实际目录消费决定；额外命中不虚增目录总数、不挪目录游标。同一项既在目录又被召回只交一次。
- 保现有最小身份/版本/补读位置；足够时补正文，不足时如实表达原有裁剪状态。若连最小合法回执都装不下，沿现有容量错误/压缩处理，不静默丢项、不创建新的游标服务。
- 最终字节/token提示由 Rust 统一分配、裁剪和冻结；Node 仅包装，不能再裁一遍。已成功操作恢复即接回原回执，不用新预算重算。

**先修测试前提再修一般原因，不能改答案迁就结果：**

`check-evidence-search-assets.mjs` 的既有 RED 已证明 A 丢失，实际是 A+B/26 支持与 B/46 支持。其后尚未到达的 `supportCount === 50` 不能随手改成 46 或直接删掉。

将证明目的分开，复用现有脚本/夹具，避免造测试框架：

1. **实际容量触发裁剪：** 保持原小预算路径，明确有内容被裁，A/B 的身份和可补读性仍存在；小正文确实有充足预算时保原全文断言。核实际预算和序列化大小，不能硬编码此次观测的 46 为合同。
2. **容量充足的支持数量上限：** 在独立合成配置中证明 A+B 和 50 条支持实际装得下，原 50 项上限和未交支持游标继续验证。不调大产品默认容量或上限。

任何测试前提调整在 CURRENT“验收与要求变更”记原值、新值、独立容量证据和未变的业务断言。

**必需证据：** 真实工具登记→Rust 持久回执→Pi 实际 provider 输入逐字段相等；目录外 A、目录 B、重复身份去重、仅目录推进、当前权限/版本核验保持；同 batch 共享余量、较小余量恢复不重剪、原生压缩成败仍沿原规则。运行 `check-evidence-search-assets.mjs`、`check-evidence-response-budget.mjs` 和现有资产/回执回归，Mem0 候选可使用已授权的本地协议替身，不能写成真实 Mem0 或模型质量通过。

### 4.3 正文/支持读取与覆盖状态

**目标与依据：** [05](hybrid-retrieval.md)统一推进/期限、[06](evidence-delivery.md)最终可见支持、实现设计 17.5–17.6.1；对应审计问题 1、3 / SR-03。

**代码入口：** `data_tools.rs` 的 search/read_knowledge/read_source；`knowledge.rs` 的 `StageReads`、`search_stage_outside_lock`、`rank_common`/窗口排序与 `scan_progress`；`knowledge_supports.rs`；`context_authority.rs` 及 knowledge 窄投影。

**已有修改先核实：**

- 准备正文前提交持会话/run/tool 锁的事务；慢 I/O 锁外执行；最终新事务按原锁序核 run/lease、operation、指纹、任务/条件、来源、权限及实际交付依赖，再保存回执与采用记录。
- 搜索支持复用主搜索绝对期限，超期保已取得主命中与原支持位置，partial 和 unknown 分开；普通读取没有新加十秒期限。
- 当前源引用重核使用 `source_reference_objects_in_tx` 的窄投影；已无消费者的整 body `current_objects_in_tx` 已删。不能删除最终有效性检查，也不能重新加载全部正文作为一般核验。
- 内部未知支持总数保持 `Option`/unknown，不能伪造成 0 或从空数组推断已无例外。

**覆盖修复需完成验证：**

- `deadline` 来自原推进链实际发生的期限事实，覆盖 SQL 后备、范围/元信息、正文及支持。不能只从 Milvus cursor 反推，不能仅看回包时间晚就算工作超期。
- `exact` 表示对已召回且核验候选执行 ID/名称优先比较的状态，**不是第三路召回、第三张 RRF 票或全库精确穷尽**。
- 分别证明正常匹配、成功空候选、前置失败/匹配前超期、恢复窗口、仅资产目录。不能用“候选数等于零”把上游失败伪报成功；状态取实际路径，资产目录不声称跑了公共 exact。
- 不修改成功空召回不触发 SQL 的规则；SQL 仅在词法明确不可用时替代词法票，现有融合和排序约束不变。

**验收：**

1. `check-evidence-support-lease.mjs`：真实 API/隔离 MySQL，暂停真实支持 SQL，独立连接在延迟期间能取得 conversation 行锁；search/read_knowledge/read_source 三类都实际走到正文读取。正常放行后交付正文；搜索支持超期交主命中、partial、原游标；并发停用在最终事务拒绝；同 operation 重放第一次回执。
2. SQL 一 owner 成功、一 owner 等到期限，知识明确 `supports_complete=true, supports=[]`：仍保合法命中，并报告 bounded/deadline，不用支持超时替代 SQL 期限证据。
3. `check-evidence-search.mjs` 与 `check-evidence-search-compact-capacity.mjs`：核 exact 与目录/恢复状态。后者原 SQL-only 通道数组增加 exact 的期望变更应明确引用正式 coverage 合同，不能据实现反写答案。
4. 原知识/原文/陈述、支持续读、权限/停用、回执重放及容量检查保留；完整组由第 5 节执行，不在每次改字段后全跑。

锁探测阈值用于区分被长读锁住和可及时获取，不将宿主偶发延迟包装成产品性能承诺。发生测试超时时保存同期事务/进程证据；不能沿历史习惯直接归因 Defender。

### 4.4 验证冗余实现确实已收敛

**依据与入口：** [Pi复用约束](pi-reuse.md)；`modules/retrieval/vector.rs` 的 CandidateBudget 及相关 mod/store 导出；`knowledge.rs`；`update-analysis-task.ts` / `transport/client.ts`；原 SearchSelection/SearchContinuation 接收入口。

- 候选预算由单一 `drive_stage` owner 使用普通可变所有权；异步页只带预留数值，回接统一记账。核不再保无用 Arc/Mutex、旧 candidate 查询及 `drive_launched_stage` 包装。
- 保唯一身份、跨通道在途预留、共享五轮、30 主读占用和失败不退款、原 Embedding 结算等待。JoinSet/select 有就绪通道不被慢页阻塞的职责，不能因“复杂”删除。
- `update-analysis-task` 同侧不再显式重复验 TaskInput；实际 ToolInvocation POST 的边界仍递归验参数。dataTools 参数与外层信封不是一份对象，不能类推全部删除。
- 公共 scan 在外层接收验证后内部用类型；当前分片/索引目标、权限、任务及修订变化仍核验。持久内容导入和 SDK 严格恢复仍保留。
- 接口失去消费者时删除对应导出/私有代码，不加兼容包装保存死入口；不机械拆文件、不追逐行数。

**验收：** Rust `modules::retrieval::vector::tests`、`check-retrieval-progress.mjs`、`check-retrieval-deep-advance.mjs`、`make verify-pi-transport` 与 evidence 游标/重放检查。核坏新输入在边界拒绝、旧已登记调用按原回执恢复、不因新 Schema 换 ID 重发；已变状态仍拒绝。保原检查点健康导出/损坏/写盘失败证据，由 08 compatible restore 复验，不重造日志框架。

### 4.5 历史报告显示状态与工程检查

**依据与入口：** 实现设计 17.4 历史使用合同、[08](compatible-upgrade.md)验收矩阵；`AnalysisReport.tsx`、`check-analysis-reports-browser.mjs`，以及已改的 `source_current_compatibility.rs` 测试。

- 条件变化提示可以在正文加载前存在；“以下为已存内容”只有确实存在经本次核验可显示的正文时出现。
- 读取中、合法服务错误、重试入口与条件变化独立。重试成功显示原存档，不自动重跑查询，不用未经当前权限核验的缓存兜底。
- 新增浏览器 503 夹具按实际 `AppError` 合同构造；目前 `{code:"unavailable"}` 只能证明坏响应/边界错误，不能作为合法服务失败的唯一证据。可以保留坏响应场景，但必须分开命名和报告。
- 保原七项浏览器行为：已存金额/点数、窄屏、迟到响应、结果有效期、历史回顾、用户隔离等原断言，不因加状态用例删旧场景。
- `source_current_compatibility.rs` 的数组替换属于工程清理，核 Clippy 即可，不扩展无关风格修整。

**验收：** 在 changed 状态下，加载时无虚假旧正文提示；标准 503 显示错误和重试；重试来自真实 API 成功响应后才显示原正文；权限失效保持不可读，图表/明细过期不影响合法已存报告文本的既定规则。对应浏览器检查完整通过，保截图和结果日志。

## 5. 验证顺序与正式绑定

### 环境及最小命令

所有命令在仓库根执行。用现有已核验 Node 26/Cargo；缺环境先诊断，不顺手升级。下列 PATH 是当前机器入口，其他宿主只替换工具路径，不能改变产品配置：

```sh
env -u DEEPSEEK_API_KEY -u DEEPSEEK_BASE_URL -u DEEPSEEK_MODEL \
  -u DATA_AGENT_MODEL_PROFILE -u DATA_AGENT_MODEL_FAULT -u DATABASE_URL \
  PATH="/opt/homebrew/opt/node/bin:$HOME/.cargo/bin:$PATH" \
  make verify-code
```

其余测试/构建使用同一 `env` 前缀，清除继承的真实提供方和数据库选择；不要读取或打印 `.env`、口令、key。Docker 使用 `--context colima-data-agent`。harness 使用专用合成 MySQL 库、必要的专用 Milvus 集合和本地协议提供方；不拿主库代替缺失测试环境。

Rust 变更后，首次相应 E2E 前分别构建并确认二进制时间；后续未改相关输入可复用构建产物：

```sh
cargo build --offline --locked -p data-agent-api
cargo build --offline --locked -p data-agent-worker
```

上述两条同样套用 `env` 前缀。DB harness 串行，`verify-architecture` 也含数据库，不用 `make -j`。父 Node 提供协议服务时不得用同步 exec 卡死服务。测试结束只清理自己创建的进程、库和集合，失败日志保留。

### 从窄验证到一次正式收尾

1. 接手先静态预检 `make verify-code`，确认最后一批改动可构建；这不是修复验收。已知错误修最小原因，不盲跑长电池等末尾再发现 Clippy。
2. 按第 4 节逐项最小 RED/已有证据→GREEN→直接相关正控；观察正式回执、状态和 provider 输入，避免只测 helper。
3. 所有行为修复稳定后，核正式绑定覆盖下表，补文档并冻结输入。不要提前完整跑原八组一遍再立即重复作为“正式”。
4. 独立审查当前源码、要求、测试预期和已有窄证据，确认后按第 6 节生成范围记录，再实际运行 `make verify-increment`。该命令会执行绑定，旧局部报告不能代替。

### 必须保留的 08 八组

| CURRENT 验收 ID | 已存在命令 | 编包时超时秒数 | 证明范围 |
| --- | --- | --- | --- |
| UPGRADE-CURRENT | `make verify-upgrade-current` | 1800 | current/精确旧档、回填、latest-only、身份和元数据 |
| UPGRADE-FROZEN | `make verify-upgrade-frozen` | 1200 | 在途冻结、实际终态释放、未知/费用/晚到结算 |
| UPGRADE-RESTORE | `make verify-compatible-restore` | 1800 | 原 Pi 会话/leaf、旧profile、v1/v2、权限、历史、资产和升级答案 |
| UPGRADE-INDEX | `make verify-upgrade-index` | 1800 | 公共集合一次切换、旧停写、范围/尾部、个人资产保留 |
| UPGRADE-CONTRACT | `make verify-contracts` | 300 | 同源合同与生成/边界 |
| UPGRADE-CODE | `make verify-code` | 600 | 格式、Clippy、类型及构建检查 |
| UPGRADE-BOUNDARIES | `make verify-architecture` | 300 | owner/依赖边界和锁序 |
| UPGRADE-FLOW | `make verify-runtime-flow verify-recovery` | 900 | 基础推进、恢复、原身份 |

这些超时是既有测试执行限制，不是产品阈值。只在完整日志证明健康组的实际运行需要更多时间时调整并记录依据；不能扩大超时掩盖挂起，也不能缩短产品期限加速测试。

### 受影响修复的绑定矩阵

CURRENT 已有下列 11 组待执行绑定，保留；本包要求将缺少的 4 组现有脚本补入同一增量（开工时更新，编包不执行）。同时把报告验收补映射到 D02/C02/C08，并将尚未列入增量的 C08 加入 requirements；这是补齐既有历史展示/UI要求的追踪，不增加功能。需求含义见[覆盖表](coverage-and-validation.md)，不能借收尾删除其他需求。

| ID / 命令 | 要求与证明范围 |
| --- | --- |
| RETRIEVAL-BUDGET：`cargo test --offline --locked -p data-agent --lib modules::retrieval::vector::tests` | D07/C06/A06：唯一预算 owner、在途预留和共享限额 |
| RETRIEVAL-PROGRESS：`node tests/mvp/check-retrieval-progress.mjs` | D04/D07/C06/A06：实际推进、就绪通道和期限 |
| RETRIEVAL-ADVANCE：`node tests/mvp/check-retrieval-deep-advance.mjs` | D04/D07/C06/A06：失效补取、后页与耗尽 |
| EVIDENCE-READ：`make verify-evidence-delivery` | D06/D07/C02/C06/C07/A02/A06/A09：三类读取、支持/游标、锁外与最终核验；已含 support-lease |
| EVIDENCE-SEARCH：`make verify-evidence-search` | D04/D06/D07/C02/C06/A06/A09：Mem0 裁剪、exact/期限、容量/续读；已含 search-assets 和 compact-capacity |
| EVIDENCE-ASSETS：`node tests/mvp/check-evidence-assets.mjs` | D10/D11/D12/C02/A09/A10：记忆/Skill 归属和采用 |
| EVIDENCE-REPLAY：`node tests/mvp/check-evidence-replay-boundaries.mjs` | D07/C01/C05/A02/A09：原操作/原回执、参数与重放 |
| EVIDENCE-AUTHORITY：`node tests/mvp/check-authority.mjs` | D07/D10/D11/D12/C02/A02/A09/A10：来源、权限与恢复 |
| TASK-COVERAGE：`node tests/mvp/check-task-answer-boundaries.mjs` | D08/D09/D13/C01/C04/A01/A04：有/无冻结项漏答与兼容自然回答 |
| REPORT-RETRY：`node tests/mvp/check-analysis-reports-browser.mjs` | 保原映射并补 D02/C02/C08：历史显示、合法失败、重试与用户隔离 |
| PI-BOUNDARY：`make verify-pi-transport` | D03/D07/C07/A03：单边界校验、旧登记与回执 |
| **补入 EVIDENCE-BUDGET：**`node tests/mvp/check-evidence-response-budget.mjs` | D03/D07/C01/C05/A02：同 batch 共享余量、较小预算恢复、原生压缩、实际 provider |
| **补入 TASK-NOTIFICATION：**`node tests/mvp/check-result-notification-answers.mjs` | D08/D09/C04/C05/A04：先按4.1扩展显式v2、多任务及旧条件晚到，保原三类通知；原脚本通过不能代替新增guard例外证据 |
| **补入 TASK-CANCELLATION：**`node tests/mvp/check-mixed-task-cancellation.mjs` | D08/D09/A01/A04：同会话任务独立取消 |
| **补入 TASK-RESUMED-CLARIFICATION：**`node tests/mvp/check-task-answer-scope.mjs --new-task=clarify --null-task` | D08/D09/C01/C02/C05/A01/A02/A04：A 冻结、B 取消、C 新建/澄清恢复、实际输入和两次刷新 |

补入命令都已存在；新增场景在对应脚本中写成可运行后才计证据。新增组超时参考同脚本的历史完整运行和当前场景规模，在冻结前填入 CURRENT，不能假造通过时间。第一个 EVIDENCE-BUDGET 与最后任务恢复组避免只覆盖纯 HTTP guard；08 restore 已覆盖一般升级多任务正反例，不再机械追加整个 07 电池。

如本次实际改到 `deliver.ts` 的输出/事件或恢复处理，则按具体影响从 `make verify-task-answers`、`verify-task-answer-regression`、`verify-task-answer-scope` 选取缺失行为并补绑定；如果只是 Rust 提交检查，不无条件重复三套完整组。已有规范内容/融合/索引未改时不重跑全部 05 千表建设；候选预算及推进已改的相关检查不可省略。

## 6. 文档、独立审查与关闭

本包不授予实施者自行签独立 passed。请未参与相应实现的审查者核对：

- 六类行为问题、两类复杂度问题和工程阻断均有处置及证据，没有把未验证的改动写成完成。
- 原 05–08 合同和架构/原型入口仍一致；没有重建 Agent、加功能、篡改预期或为未证边界增保护。
- source 限制的比较、结果通知、自然综合、取消/澄清和当前版本门保持；Mem0 身份/目录游标、最终容量/原回执和三段式事务一致。
- 本包内所有测试预期调整有独立依据；特别核 50 支持的预算前提、exact 字段合同、合法 AppError。
- 最新生成合同、源码、测试、验收绑定和文档都已冻结，范围指纹对应这份输入，而非旧报告。

**编包复核记录：** 本包经过上一轮独立审查者的只读可执行性复核。两处建议已纳入4.1/5：无parts检查覆盖成功答案工具引用；结果通知脚本补显式v2、多任务及旧条件晚到。它们是待执行的验证要求，不是已取得产品RED/GREEN，也不代替上述实现审查。其他范围/命令/停止点未发现新的实质冲突；本包没有另送Oracle。

受影响文档更新位置：

- `docs/architecture/implementation-design.md`：必要时补 final 覆盖规则、exact 的局部含义和读取状态；历史报告旧段落若仍说 condition_changed 永不带正文，按已确认 17.4 合同消除矛盾，不能反向改新行为。
- `evidence-delivery.md`、`task-answers.md`、`compatible-upgrade.md`、`pi-reuse.md`：只同步本次明确的接线/验收，不重写完整规格。
- `docs/development.md` / 根 README：实际能力、兼容顺序与本地验收入口变化才改；不写已部署或整个 dogfood 通过。
- 图源仅在边界/拓扑实际变化时改。本次锁外 I/O 应恢复到既有三段式图，无需为了留痕重画架构。
- CURRENT 保存唯一当前状态、已删除旧职责、实际文件/接口、命令与完整日志、剩余未验证层级和停止点。

检查器接口以 `scripts/check_delivery.py` 为准。范围摘要可由审查者在仓库根按现有公开函数计算（只输出摘要，不生成结论）：

```sh
python3 - <<'PY'
from pathlib import Path
from scripts.check_delivery import read_delivery, review_scope
root = Path.cwd()
print(review_scope(root, read_delivery(root)))
PY
```

实际审查者确认后，记录 `reviewer`、`summary`、`conclusion`、`scope_sha256`，指向 CURRENT 的 review.record。旧 `compatible-upgrade-count-review-20261031.json` 仅在重新审查且当前摘要匹配时才可用于本次；不得只刷新哈希。文档编包、自审、Oracle旧答复和静态检查不代替该独立实现审查。

先完成 `make verify-materials verify-delivery`，再由 `make verify-increment` 实际执行全部绑定并生成收据。输入变化、失败、超时、缺证或审查不匹配时保持 active/pending 或对应未完成状态；不能手写总 passed。有修复时重新做受影响审查，冻结后再走原检查器，不改检查器以接纳旧收据。

正式收据通过且与当前冻结输入一致后，按既有规则更新 `increment.status=complete`、review 和 evidence，最后 `make verify-delivery` 确认关闭记录有效。**完成 08 后停止，不开启 09。**

## 7. 停止条件和交付格式

只有这些情况需要停相应工作并说明：缺少不可替代环境/权限；正常路径出现与已确认业务合同真正冲突的选择；必须做不在授权内的付费、数据破坏或部署；独立审查不可用；重复尝试没有新证据。其他独立工作继续。不能仅因任务大、一次失败或历史环境问题就停止，也不能无限重试。

中断时在 CURRENT 记录：当前工作项、已改文件、已到达断言/完整退出码、失败根因是否已证、原操作/测试资源身份、下一条最小命令。长日志留忽略目录；不新增另一份当前计划，不把“已准备测试”写成“已运行通过”。

最终向用户交付：

1. 每项已证问题的根因、修复/删除及对应证据，未解决项单列。
2. 08 正式收据与独立审查位置，输入版本、完整退出结果和证据层级。
3. 测试前提/期望调整的理由，确认没有扩大产品上限、删场景或更换 mock 冒充通过。
4. 相关文档入口及未改架构图的原因；未做真实模型、真实平台、09、Git和部署的准确边界。
5. 停在 08 关闭或明确未关闭的状态，等待用户安排下一轮 dogfood；不自动开始新阶段。
