# 语义检索与运行闭环修复执行包（前轮历史规格）

> 2026-11-01状态更新：本包原范围已取得30条去重命令通过收据；以下保留当时规格及实施中补充，不再作为当前开工清单。后续复审发现的八处缺口转入[delivery-repairs.md](delivery-repairs.md)，唯一当前状态在CURRENT。

编制及实施中补充日期：2026-10-31。当前状态、授权和验收只在 [CURRENT](../../CURRENT.md)。本包接续已经完成原 23 组验收的 05–08，处理[关闭后复审](../../reviews/semantic-runtime-closed-stage-audit-20261031.md)的 R01–R14、两项已确认交互取舍，以及直接相关的验证/文档缺口。**以下是当时执行规格的历史记录，不是当前开工清单。**

本包完成后停止。09 的 [整体验收](integrated-dogfood.md)仍保留原任务和场景，不在本包执行，也不因本包通过宣布真实模型效果或整个项目完成。原 [audit-repair](audit-repair.md)及其收据是上一轮历史依据，不能继续照它的旧问题清单开工。

**有效决定：R02 的单份/合并容量分离、R07 的候选窗去重生命周期已由用户确认，CURRENT 已记录；不再等待或重复请求这两项决定。Oracle最高5/5已完成草稿审查，结论为“有条件可执行”；后续修订及本次实施中补充经本地核对，未再次发送Oracle，不能称为Oracle直接批准最终稿。详见[交叉审计记录](../../reviews/semantic-closure-package-review-20261031.md)。**

## 1. 启动、顺序和完成边界

### 启动必读

1. 根目录 [AGENTS.md](../../../AGENTS.md)。
2. CURRENT 顶部最新决定、`delivery.increment` 与“关闭后复审修复实施”小节。
3. 本包第 1–3 节。随后只展开当前工作项、对应原阶段规格和实现设计相关章节。
4. [复审报告](../../reviews/semantic-runtime-closed-stage-audit-20261031.md)的结论、证据等级和当前问题。历史日志按需查询，不先通读所有历史。

使用已安装 `dev_co` 保持单一开发目标；新增/修改行为按 `tdd` 做最小反例、实现、相关回归。跨语言字段或语义确实变化时使用 `contract-first`，从 `packages/contracts/schema.json` 生成两侧类型，不手改 generated。

### 本次交付

| 顺序 | 连贯工作项 | 问题与补证 | 主责任 |
| --- | --- | --- | --- |
| 1 | 最终提交和自然交互 | R01、R02、R09、R10；D1、D2 | Rust 最终事务与 Node/Pi 交付 |
| 2 | 同修订重新整理 | R03、R04、R05 | ingestion/knowledge/runtime owner |
| 3 | 个人资产和必要支持 | R06、R08、R11；50 项独立上限 | Rust 证据分配、资产来源、Pi read |
| 4 | 深翻页与覆盖事实 | R07、R12、R13、R14 | 唯一检索推进及 v2 装配 |
| 5 | 冗余、文档和正式收口 | 同侧 read 校验、状态说明、必要图注；全部问题对账 | 单一整合者与独立实现审查者 |

连续推进，不在每个工作项结束时等批准。每个连贯切片更新 CURRENT 的实际变化、检查、未完成项和下一动作。共享 `data_tools.rs`、`knowledge.rs`、`source_limits.rs`、`finish_run.rs`、`session/deliver.ts`、Schema/迁移和 CURRENT 由一人顺序整合；不要求多代理并行。

完成的含义：14 项都有代码/删除落点和对应当前版本证据，两项交互取舍经过正常路径与刷新验证，独立实现审查及本增量正式收据通过。真实模型、真实平台、09、发布上线分别保留未验证状态。

### 实施中检查后的回补要求（2026-10-31）

以下是已有 R02/D1/D2 与架构约定的实现偏差和验证缺口，不新增产品功能或第六个工作项。接收补充时，完成当前正在运行的单项检查并保留真实退出码；若在编辑，则先保存当前小改和未完成位置，再转入回补，不等整组做完。不要 kill 进程、重启开发会话或重做已完成的全部工作。若检查无进展，按第9节诊断，不无条件等候或盲目重跑。

先核对最新代码及同参数检查证据：并发实施期间已修好的项只核对覆盖，不重复实现。由当前实施者在 CURRENT 更新实际状态：第一组保留已有实现和局部通过的历史，但这些补充验收通过前不得视为关闭；其余工作进度保留。检查者只更新本执行包，不并行修改 CURRENT 或产品代码。

**先回补控制交付的四个问题，按下面因果链组织有界切片：**

1. **Pi 上下文编辑不能选中旧轮答案。** `apps/agent/session/workspace-context.ts` 的 `agent_before_settle` 当前未检查 `outcome`，且在整个 `contextEntries` 中寻找最后一条无工具调用的 assistant。调用真实产品钩子的合成反例已证明：旧轮有正文、本轮仅有工具调用时，`error`、`aborted`、`completed` 三种 outcome 都会返回指向旧轮正文的 `context_edit`。这证明模型可见历史存在被误改的路径，不据此声称 UI 持久旧答案已经被改。按第4节原合同，只在成功结束、无待执行工具且目标确属本轮时编辑；失败/取消不得向前回扫旧答案或冻结正文。成功但无本轮合适目标时沿既定 Pi 宿主消息路径处理，不新建上下文管理器。补正式钩子反例及实际检查点恢复/下一轮输入验证，证明旧正文保留、成功控制交付仍可用。
2. **恢复必须接回原持久控制投影。** `task_answers.rs::control_delivery_in_tx` 将 `execution_state`、`confirmation_state` 及其状态文案纳入指纹；`deliver_run.rs` 启动/恢复重新计算当前投影，`deliver.ts` 恢复快路采用新指纹，而 `stored_control_delivery_in_tx` 只在原成功工具回执里找该指纹。源码链显示：queued 正常推进到 running 后恢复，可能生成原回执里不存在的指纹并被 `invalid_evidence` 拒绝；本次未另跑该数据库反例。先用正式路径验证，再接回已有持久操作事实、投影与原提交身份；实时状态只作为有观察时点的状态展示，不重造原提交身份。保权限/条件有效性重核，不忽略错误、不增账本、监听器或重试服务。验收 queued→running 后恢复成功，原 commit/operation/output 与检查点一致，未知提交不重复编辑或派发。
3. **控制确认不能结清尚未解释的分析。** `finish_run.rs` 控制分支仍进入公共任务收尾；无 parts 时取整轮任务引用，`task_waiting_phase_in_tx(...).unwrap_or("answered")` 在查询已 succeeded 时会落到 answered。源码链显示：投影生成后、finish 前查询完成，可能仅交付控制短句就结清分析；本次未另跑该数据库反例。只由真实交付的分析正文/冻结引用推进相应任务的分析完成，其余沿原任务和结果通知机制处理，不增加状态框架。测试必须制造 queued→succeeded 发生在投影之后、finish 之前：合法控制事实仍可提交，但未解释的任务不变成 answered；混合“已冻结分析＋另一个等待任务”分别推进，原结果通知仍能交付分析。
4. **把工具回执读取放回 runtime owner。** `task_answers.rs::stored_control_delivery_in_tx` 直接对 `tool_calls` 执行 `sqlx::query_scalar` 并使用 `tx.connection()`。本地 `python3 scripts/check_architecture.py` 已实际 exit 1，报告“SQL或底层连接位于私有store之外”和“协调层持有通用SQL入口”。将存储读取放进 runtime 私有 store，经窄业务读取接口提供原控制事实，可与上述控制恢复身份修正一起完成。不新增 allowlist，不绕检查，不造通用 repository/helper；架构检查和控制恢复正控均须通过。

**再补齐两处已有验收缺口：**

- **R02 跨越真正的旧下游容量。** 当前 `check-task-answer-boundaries.mjs` 的两份 7998 字正文组合实算为 16023 Unicode 字符、55835 UTF-8 字节，尚未跨越旧 `ChatMessage` 的 32000 字符和 `TEXT` 的 65535 字节。它可证明不再共享 8000 槽，不能证明扩列/历史合同有效。保留该正控，补合法组合实际超过这两个旧门槛，以及最多24项合法组合；通过正式提交、输出事件、历史读取与浏览器刷新核对原文，保中文/非 BMP、旧冻结恢复与超单份上限拒绝。测试应覆盖实际格式开销，不提高产品模型额度或 API 入站上限。
- **恢复回归失败必须归因并复验。** `.local/checks/semantic-closure/r08-check-task-projection--recover-receipt.log`（本地检查时最后修改为2026-10-31 21:38）记录 `Nothing to compact (session too small)`，调用来自 `DATA_AGENT_TEST_COMPACT` 路径的 `deliver.ts` 与 `check-task-projection.mjs`。它是一次真实失败，但尚不能据此认定产品回归或环境问题。先查最新同参数完整日志；仍未解决时，区分产品变化、测试前置条件与 Pi 状态，按原因修正后同参数复验。不删场景、不降断言、不 catch 吞错，也不用另一条恢复检查的绿日志替代；测试前置修正须记录独立依据。

以上补证纳入已有最终提交/容量、WAITING-DELIVERY 和恢复验收，不另造一套收口流程。先跑最小反例及受影响检查，回补后续接 CURRENT 的原工作断点，再完成第7–9节；不在回补完成后停下等待批准。

### 基线与历史证据

- 编包基线：`codex/semantic-maintenance-prototype`，HEAD `04d27d06ba7b97d4cf3e288d4cf9e6300ef491a9`。接手重新核对；大量继承未提交工作全部保留，不 reset、不覆盖，不把全部 HEAD diff 当本轮修改。
- 08 原收据 `.local/delivery/I2-COMPATIBLE-UPGRADE-result.json`：23 组真实通过，SHA256 `5febfaeae29fe147a1fa7ba0176582d035fe2ef840344a894ee53596c360577c`。它证明原断言通过，不能证明本轮新增路径。本包接续已建立的 `I2-SEMANTIC-CLOSURE-REPAIRS` 修复增量，不重复创建、不覆盖旧收据、不伪造复用审查，也不把 08 历史改为“从未通过”。
- 已运行反例位于 `.local/audits/semantic-runtime-closure-20261031/`：`repro-natural-answer-authority.mjs`、`repro-frozen-answer-length.mjs`、`repro-scope-set.mjs`、`repro-memory-capacity.mjs`、`repro-allowed-skill.mjs`，各有 JSON 与完整日志。反例命中时 exit 1 是 RED，不能当脚本异常忽略。
- 其余问题是静态调用链确认，实施先做正式可达反例。忽略目录在其他机器可能缺失；缺失时重建最小合成反例，不冒称历史实测、不回退产品制造 RED。

## 2. 已确认的行为与删除边界

用户已确认前次报告的两项推荐：

**D1：跨来源的纯控制确认可以简短交付。** 两条 SQL 已保存/已提交、仍待确认或等待结果时，不必为了回复状态强制给每个任务生成分析答案。依据是宿主持久操作/等待状态，不能识别正文中的“已保存”、让模型自报控制消息或借 `route` 清空完成义务；等待任务保持等待。跨来源分析结论仍须按任务交付。

**D2：持久且可见的任务卡可以承担澄清交付。** A 的开放问题已经保存并在任务卡实际可见，B 已回答时，最终正文可以简短提醒 A 待澄清，不强迫再复制整段问题。A 仍为 `waiting_clarification`。不存在、旧版、不可读或未可靠显示的问题不享受该判断；有 parts 和无 parts 使用同一标准。

必须删除的过度限制：

- 受限任务统一清空所有已选 Skill 的捷径，改为核实际资产依赖；不能把受限任务等同于禁用 Skill。
- 用有序列表而非集合判断相同来源；重复项/输入顺序不能制造新权限差异。
- 用当前活动条件版本限制宿主原查询结果的合法交付；保原 query/condition 绑定。
- SQL 后备没执行却把它的 24 词限制算进成功混合检索覆盖。
- 同侧同值的重复结构校验，以及只为防上述合法组合而叠加的旁路。替换职责后删除失效旧分支。

**已经确认的合同修正：**R02保单份8000 Unicode字符，将多份宿主合并容量按最多24项、标题与格式推导为384281字符，输出列扩MEDIUMTEXT，assistant历史合同相应放宽，user仍32000。R07删除全查询累计history及对应全局1000终点，改为候选窗内精确去重、跨新窗允许另一通道晚到的同身份重现；每次调用原限额保持。后者是明确的能力取舍，不冒称纯清理；按已确认决定记录旧值、新值与影响，再更新原跨窗断言，不重复向用户确认。

保留必要约束：权限、资产选择/版本、来源限制、SQL 执行授权、当前与历史用途区分、原 operation/origin/budget/output 身份、未知回执不重发、锁外工作后的最终有效性重核。Pi 是唯一 Agent、会话、压缩、取消及恢复机制；锁定版本不升级。每消息 24 次模型调用、连续临时失败 3 次保持。

检索单次 10 秒工作期限、1000 唯一候选含在途预留、5 轮、30 主内容读取，以及每回执 50 支持均保持；它们不等于整个会话/查询所有翻页累计只能 1000 条。容量按宿主实际余量，不抬高默认模型/检索上限掩盖错误。

### 四条实现规则

1. 仅处理当前要求、已证失败和有实际调用链的普通路径。新提极低概率保护必须先给触发、证据、影响、成本，请用户决定；未知概率不得编数字。不得新增 ABA、外部日志篡改、跨机争写或 hash 碰撞防护。
2. 外部数据在相应信任边界校验一次，内部传已验证类型。跨进程、恢复导入及状态变化后的业务重核不是重复结构校验，不一并删除。
3. 简单单用逻辑就地实现；只为实际复用、owner 责任或复杂度隔离抽取。禁止通用 helper、调度器、清洗框架、答案/检索会话服务。
4. catch 仅用于明确恢复、边界错误翻译或有效上下文；错误默认直接传播，不吞错假成功、不多层重复重试。

## 3. 修改范围与接口纪律

| 责任 | 允许修改的入口 | 限制 |
| --- | --- | --- |
| 提交/任务 | `use_cases/{finish_run,task_answers,analysis_answers,source_limits}.rs`；`modules/{analysis,conversations,queries,runtime}`的直接相关公开操作和私有 store | 不另造任务完成账本；组合层不写裸 SQL |
| Pi 接入 | `apps/agent/session/{deliver,checkpoint,journal,task-projection,output-stream,workspace-context}.ts`、`apps/agent/tools/data-tools.ts`的直接相关接入 | checkpoint/journal已支持原生context_edit；优先复用，仅修实际集成缺口，不重写日志或SDK |
| 整理/归档 | `use_cases/{source_fanout,source_preparation,knowledge_embeddings}.rs`；`modules/ingestion/preparation/`、`modules/knowledge/{preparation,store.rs}`及原账本 owner | 不清旧账本/历史，不增加第二套 epoch |
| 依据/资产 | `use_cases/{data_tools,evidence_delivery,knowledge_supports,deliver_run,personal_assets,context_authority,source_limits}.rs`及 assets/knowledge owner | 基于已有 dependencies/authority；支持目录/指纹在knowledge私有store，不在组合层写SQL |
| 检索 | `use_cases/knowledge.rs`、`modules/retrieval/{mod.rs,vector.rs,search_reply.rs}`、v2 装配 | 不建服务器检索会话、第三张融合票或新的检索后端 |
| 合同/持久化 | `packages/contracts`；必要新增迁移 | 只为本包实际字段/兼容需要；不得改已执行迁移或手改生成文件 |
| UI/历史 | 现有工作台澄清任务卡、`conversation-timeline.ts`、`AnalysisReport.tsx`；`use_cases/read_conversation.rs`及conversations/runtime的实际历史消费者 | 先验证；仅修D2显示和R02真实容量缺口，不重设计工作台 |
| 验证/文档 | 本包逐项测试、Makefile、CURRENT、README、development、相关设计/图源和03–08受影响条款 | 09文件保持；03只核同修订整理，04只核受限资产；图意变化才生成，不机械重画 |

应用代码和测试名称用业务含义。R 编号、包号只保留在文档/验收映射，不进入类、函数、变量、目录或数据库对象名称。

## 4. 最终提交和自然交互

依据：实现设计 17.4、17.5、17.8，[07](task-answers.md)、[Pi 复用](pi-reuse.md)；要求 D02/D03/D08/D09/D13、C01–C05/C07/C08、A01/A02/A04/A09/A10。

### R01：普通 final 的提交前 authority

- 入口 `finish_run.rs::finish_run`、`context_authority::{check_run_results,assert_checked_run_in_tx,assert_run_in_tx}`、`task_answers::check_results`。
- 将自然 final 纳入同一最终有效性责任。若需平台/结果读取，沿已有“取引用→提交短事务→锁外查证→重锁原会话/run→核当前状态”的路径，不在会话锁中做外部 I/O。已完成的同 commit 重放仍接原事实，不能重新核后改写原成功。
- 自然正文、成功答案工具引用和 parts 均不能跳过自身适用 authority。普通失效必须在最终 commit、消息消费、任务结清前拒绝；不要在各层重复添加同类 guard。
- 不把所有交付统一套上全run来源并集：逐任务冻结正文仍核自己的已保存authority；D1宿主控制正文只核实际采用的控制事实及展示字段，不能因此豁免普通模型分析。
- RED/GREEN：有效读取→普通 final 成功；读取→正式停用/撤权→final 拒绝且三类持久状态未推进；合法历史用途正控；parts 与成功答案工具引用原正控；同 commit 重放一次。复用 `check-task-answer-boundaries.mjs`、`check-authority.mjs`、`check-context-dependencies.mjs`。

### R02：答案定稿与合并容量

- 入口 `task_answers::{finalize_in_tx,compose_in_tx}`、`FinishRun`/`AnswerPartReference`、输出存储与实际 SSE/历史读取合同。
- 修复目标是“合法定稿的正文可以原样组合交付”。本包把**每份答案正文的 8000 字符**与**多任务合并产物**分开：单份及 v1 自然 final 仍受现有 8000 约束，多份已核验正文不再共同挤占一个 8000 槽。合并长度由实际最多 24 个合法 part、宿主标题和分隔推导并有界；不把单篇可生成内容、模型窗口或请求次数放大。
- 已核当前标题取任务goal，Schema最多8000字符；组合格式每项`## `+标题+两个换行，分隔为两个换行+`---`+两个换行。24项上界为`24×(8000+8000+5)+23×7=384281` Unicode字符，UTF-8正文最多1537124字节。此数是已有单项/标题/数量上限推导，不是增加模型可生成额度；实际组合使用实际项数。
- 已发现两个真实下游限制：`migrations/202610030001_runtime.sql`的`assistant_outputs.final_text TEXT`最多65535字节；`ChatMessage.text`统一最多32000字符。新增迁移只将该输出列扩到MEDIUMTEXT；Schema按角色区分assistant合并容量与user原32000上限，保持用户输入规则。核SSE/Event、Snapshot、历史投影、浏览器刷新接受实际合并原文；JSON转义字节与字符分开计算。
- 普通分析的`FinishRun.final_text`在parts路径仍只绑定新末项原文，保持单份8000；完整合并正文由Rust产生，不经512KiB HTTP请求体上传。因此不扩大API全局body limit，不批量修改其他TEXT列，不给全部字符串升上限。D1控制提示也不超过8000且不复制长任务goal：现行最多23个冻结前项加一段控制提示，仍落在上述24项推导内；它不是分析part，不能伪造任务完成引用。实现核对实际分隔格式，控制路径不能另开无界尾注。
- 冻结准入校验与每项组合校验使用相同单位（Unicode 字符，区别 UTF-8 字节）。既有 7998 字冻结项也必须恢复成功；不清冻结记录、不截正文、不增加汇总模型/新输出库，不要求用户重做旧任务。最终宿主组合保持原 output 与各份引用/版本。
- 验收：7900 正控；7998+标题+末项成功；两份各接近 8000 的正常回答原样出现；单份 8001 拒绝；有/无新末项、旧冻结项恢复、中文/非 BMP、刷新各一次；最大合法引用数的输出/事件/历史读取合同测试。扩展 `check-task-answer-boundaries.mjs`、`check-task-answer-recovery.mjs`及合同样本，不抬产品默认输出上限。
- 这是本包取消不必要“多份合用单份槽”的明确合同修正；记录旧/新规则与影响，不能悄悄改所有 `8000` 常量。
- 按已确认决定同步删除Schema `FinishRun.answer_parts`描述里的“总长仍限8000”，以及对应实现/测试旧预期。`output_chunks.body`继续装单份片段，无证据不扩列。合并长正文只用于正式交付/历史，不能整体塞回Pi作为跨任务统一依据；下一轮仍按任务投影及引用续接。

### R09：来源是集合

- `source_limits::SourceGate::allowed_keys` 返回排序去重视图；复用 `task_answers` 消费，不再新建规范化框架，不改持久消息出处。
- 正式工具写入 `[S]`/`[S,S]`、不同顺序等价集合均可自然综合；不同集合、unknown、未授权来源仍拒绝。测试覆盖原数据中已有重复，不靠把 Schema 改成拒绝重复来避开存量问题。

### R10：通知以原查询为依据

- `deliver.ts` 的 `needsResultAnswer/deferResultAnswer/commitAnswer`，`data-tools.ts` 的答案候选，以及 Rust `analysis_answers`/`finish_run`。
- Node 是否已有合格结果答案，以宿主 notification 的 query、task、condition 与成功回执 sources 匹配；不能以之后 `route` 的 active version 判定。保 Rust 最终来源与归属检查，不能旧结果新绑。
- 必须同时处理两个真实消费者：`data-tools.ts` 当前候选只保存`text/sdkId`，`answerTask`取工具调用前的active快照，`currentAnswer()`再次按active过滤；`deliver.ts`再用`deferResultAnswer()`比较active。候选应携成功回执已经由Rust核验的`sources`，通知路径以原query/task/condition匹配该回执。正常任务定稿仍核自己的活动归属，不能全局删除归属检查；只删`deferResultAnswer`比较不足以修复此项，不新增第二套候选账本。
- 同时核`needsResultAnswer()`用冻结part判断已答的分支，及`commitAnswer()`有冻结项时从active构造末项的分支：必须能证明覆盖通知原query，不能同task/version的另一查询冒充，也不能把Q/v1包装成active v2。只在正式路径可达的分支改，不为假想组合再建答案注册表。
- 在 `check-result-notification-answers.mjs` 中使用**真实 Node 工具 route**：Q 属 A/v1→A 更新 v2→结果唤醒→route A/v2→取得 Q/v1 合法答案→提交；再测 route 后同输入恢复。核持久正文属于 v1、v2和别的任务不结清、Q未重执行、预算/操作不换。保首次晚到、failed/cancelled/撤权负控。不用只在 HTTP helper 中 revise 冒充 Node active ref 已更新。
- 增加同一task/version下Q与另一查询P的对照：只有P的成功答案不满足Q的通知；最终以真实sources判断，不猜正文含了Q的数字。

### D1、D2：完成分析与交付控制状态分开

- 优先复用 message task refs、成功工具回执、query waiting phase 与开放澄清记录，在最终事务统一计算“本轮需要答案的任务”和“已可靠交付控制状态/澄清的任务”。这里计算一次，natural/parts 共用；只在确有共享责任时抽窄函数，不增加持久完成账本。
- D1固定为**现有宿主投影→宿主短正文→Pi原生context edit→原FinishRun提交**，不再把关键链路留成“必要时再想”。由Rust在现有最终交付用例计算资格及短正文：只依据本轮消息关联、原任务/条件和实际成功操作/查询事实。未提交、进入队列、平台运行及提交未知分别表达，不能仅看`waiting_*`就放行任意模型文字。依已确认D1，控制确认不结清仍等待的分析。
- 最小合同接线：从同源Schema新增宿主专用可选`control_delivery`投影，包含正文、原任务/条件及成功操作/查询引用、这些事实的指纹；沿现有`WorkspaceContext`提供初始/恢复值，相关成功`DataToolOutcome`更新该投影（缺省不更新，显式null清除）。在Rust所有相关状态已落库的现有投影出口计算，不增加HTTP端点、模型工具或持久账本。只有本轮确有控制确认或合格澄清、且其余义务均由已冻结答案解释时才给该值；有待分析漏项则不给，只有冻结项时沿既有纯引用提交，不额外生成提示。不得仅凭投影存在去改写正常分析答案。
- 内部`FinishRun`增加`control_delivery_ref`绑定这个宿主投影；由Rust回读已持久的原操作事实和投影，核对其指纹、正文及当前业务有效性，不能用实时查询状态重造原指纹。该引用不是权限凭据，不能靠模型`control=true`或文字“已保存”取得豁免。纯控制路径中`final_text`是宿主短正文；若同时有冻结`answer_parts`，它是控制提示而不是新增分析part，Rust组合原冻结正文加该提示。正常分析的`final_text`仍是新末项原文，来源/版本照旧核验；Schema与compose须明确区分，不能按`final_text.is_some()`统一多算一份分析答案。
- 控制投影绑定已持久、可回读的操作事实及其原版本，不把request_clock或可自行推进的实时查询状态混入稳定提交身份。短句准确区分保存草稿、加入队列、确认受理与未知回执；若引用运行状态，标明是所引回执的观察。查询在投影后正常从排队走到完成，不应使“已加入队列”这一事实失效，也不能据此将分析置answered；最终仍重核权限、任务条件及有无真正漏答。补此普通进展正控，不新增状态监听或重试器。
- Node取得宿主投影后，在导出最终检查点前处理模型可见正文。正常活动会话优先沿现有inline extension接Pi1.3的`agent_before_settle`，在成功结束且无待执行工具时返回`context_edit` draft与`continue:false`，只替换可确认为本轮的末条分析正文；成功但无本轮合适条目才返回宿主`custom_message` draft，失败/取消不回扫旧轮正文。已核SDK的边界提交同时追加会话记录并刷新活动上下文，不能只直接调用manager后假设活动内存已更新，也不调用SDK私有方法或手写agent.state。没有活动会话的恢复快速提交复用原编辑；确需补入时使用`SessionManager.appendContextEdit`及原检查点接口。短正文沿原`outputStream`保存，再将同一正文/控制引用/编辑后的checkpoint交给同一次`FinishRun`。`checkpoint.ts`经`journal.ts`保存引用/leaf，后者已接受`context_edit`，不另写会话格式或清洗器；同会话下一次provider输入也须采用Pi更新后的投影，不能只修重启。
- 恢复复用原commit/operation/output及已有context edit，未知提交时不能再造一份编辑条目、改变请求指纹后重试原commit。原始Pi追加日志可保留原生成记录，但模型可见投影不能把被替代分析当作已交付结论；usage、工具身份和冻结正文不删除。用实际导出、同输入恢复和后续provider输入验证，不凭SDK声明宣称兼容通过。
- D2 用原 task card/开放问题身份与版本作为可见交付，分析义务只覆盖实际需要本轮答案的任务；任务仍待澄清。已有冻结分析正文不能因此被丢弃。最终简短提示是展示选择，不能靠检测某个字符串认定已交付。
- D2的“可见”由持久查询合同和浏览器刷新回归证明，不是每轮等待浏览器ack或要求用户看过。沿当前任务卡显示已有问题，不增加阅读回执、可见性服务或完成账本；不让API使用者因未打开浏览器而停摆。
- Node必须同时改`deliver.ts`恢复快速提交（当前只认取消/冻结）和`commitAnswer()`（当前有parts就强制构造active末项）。允许A已冻结、B当前问题由任务卡承担时，只交已有冻结引用、不伪造B分析part；可省略提示，或走上面的宿主控制提示。`pendingTaskCreation`及未结算操作保护保留，先接回已登记的新建任务，不能仅凭旧workspace快照提前完成。
- Schema中“原消息其余任务均已取消才可省略新末项”的说明随D2更新；`task_answers::{assert_natural_scope_in_tx,compose_in_tx}`共用交付义务判据，已冻结正文永远不能因任务后来等待澄清就被省略。原“组合不追加Pi消息”仍约束分析合并正文；D1必要的宿主控制消息是明确限定的接入，不允许跨来源合并分析重新进入Pi。
- 正控：两个不同来源任务均已保存、均已提交、一个待确认另一个待查询；A待澄清/B已回答；A已冻结/B待澄清；自然/parts 及刷新一致。负控：任务仍需分析却漏答、只有文字“已保存”而无成功操作、澄清未持久/旧版/不可见，不能消费整条消息冒充完成。
- D1增加有真实等待事实但模型末条包含未核验混源分析的反例：正式结果仅保宿主状态，下一轮及重启输入不以该分析为已交付事实；补context edit后提交前中断、commit成功但应答丢失的原身份恢复。D2补有冻结项且无新分析末项的普通/恢复两路，不增加模型调用。
- 复用 `check-task-answer-boundaries.mjs`、`check-task-answer-scope.mjs`、`check-mixed-task-cancellation.mjs`、现有会话浏览器测试；浏览器须实际刷新读持久卡，不能只看 API 返回有问题。

## 5. 同修订重新整理

依据：实现设计 17.2、17.3、17.8 及 embedding 冻结合同，[03](semantic-preparation.md)、[08](compatible-upgrade.md)；要求 D04/D05/D06/D07、C02/C05/C07、A02/A05/A07/A09/A10。

### R03：新整理批次与原批恢复

- `ingestion/preparation/store.rs::reopen_preparation_in_tx` 不重置已有 `batch_sequence`；正常 `begin_batch_in_tx` 沿单调序列开新批。原批恢复仍沿冻结 sequence。
- `source_preparation.rs` 的应用 operation 同样使用该批稳定 sequence，并与分析/复核身份来自同一冻结批，不只用重复的 `batch_start`。`PendingBatch`可携现有持久sequence，不新建epoch表。现有`apply_and_advance`将应用与推进放在同事务，核明这一事实后处理旧applying批的恢复；没有证据需要时不添加新旧ID映射层。不要改业务记录跳过幂等冲突，不换trial/budget洗掉旧账目。
- 本地已回源确认`apply_and_advance`的应用、依赖登记和`complete_batch_in_tx`共用同一tx至commit；`PendingBatch`有新批构造和旧applying恢复构造两处，两处都须带对应持久sequence，不能只改新建路径。作业settle在其后独立短事务，不将它误说成与应用全在一笔事务。
- 补完整普通链：D/v1准备 ready且成果已成功应用→实际依赖变化→原文仍v1→扇出重开→新分析/复核/应用成功；新的逻辑批有不同调用/应用身份，同批丢回执/重启恢复仍相同且只应用一次。覆盖已知 failed 可重开；issued/review/applying/unknown 原保护保持。不靠手改数据库强造正常 ready。
- 复用 `tests/mvp/check-document-preparation.mjs`、`check-source-preparation.mjs`、`crates/data-agent/tests/source_fanout_failed_recovery.rs`；正式反例可独立命名 `check-source-repreparation.mjs`，不是重新执行全量同步。

### R04：current 派生内容与 legacy 档案

- 删除同修订整理中的 `DELETE FROM knowledge_versions`；调整 knowledge owner 的保存责任，使 current/陈述/关系能更新，而已经存在的同版完整 legacy archive 原样保留。普通修订的 archive/latest-only 行为不变。
- 明确精确历史读取走已有档案；current 派生视图走 current。原文未变不升原文修订，自动整理不是新原文版本。不得把 ignore duplicate 当通用吞错：首次档案插入与已存在同版派生更新各有明确写入意图。
- archive模式D/v1完整快照哈希→同版整理应用新陈述/关系→current已更新且旧档字节不变；旧精确读取仍旧内容；随后v2正常新版本；latest-only不开始保存每次完整派生历史。保人工值、原 source revision。扩展 `check-source-upgrade.mjs --case public-retention --archive` 与当前读取/历史测试。

### R05：保同版索引身份和冻结 profile

- 删除知识同版本待办的delete/reinsert。沿原row/target identity更新新内容需要的工作状态，保首次冻结`embedding_profile`、原调用账本、费用/调用数和单调租约代次，不靠换配置/清账补额。raw目标不受知识整理影响。
- **不能只删DELETE后保留无条件INSERT（当前实现会冲主键），也不能改成INSERT IGNORE就任由旧indexed不动。** 同修订派生保存需明确的owner内更新语义；新派生内容必须确实再次推进知识投影。现有Embedding调用身份已有请求参数指纹，先复用它区分新文本和相同输入，缺字段才补最小合同。
- `vector_attempts`是当前投影工作单元的重试次数，不是付费账本；不能要求同对象版本永远累加而在第三次合法重整后永久不可领取。相同输入恢复保重试次数，已知终态后真实新内容按原规则开启新的尝试周期；issued/unknown不可因重整重发原调用，lease_epoch不归零。增加“同版至少4轮成功内容变化仍可更新”正控及“同输入连续故障不绕过原重试上限”负控，不新增更高限额。
- 状态必须按真实变化更新：内容未变不重排、不清次数；已知终态且投影输入改变时按原消费者重新pending，并使旧indexed/成功projection回执不再代表新内容已索引；相同输入恢复沿旧状态/尝试/账本；issued/unknown沿原查证规则，不能保存一次就清空。首次profile和原费用始终保留，不让coverage读取旧成功事实冒充新投影。
- 真实消费者验收：A 首次冻结→同版整理→环境 B，新文本仍用 A；清空当前配置仍可沿 A 恢复；原 indexed 变更内容后投影确实更新；同参数 settled复用、issued/unknown不多发；raw待办及其进度不变。不要声称此前一定重复收费或加未证 ABA 保护。
- 复用 `check-shared-index-todo.mjs`、`check-frozen-job-inputs.mjs`、`check-public-index-upgrade.mjs`、`check-shared-embedding.mjs`及 `index_recovery.rs`。必须走整理应用到 Worker 的真实链，不只测 embed 叶函数。

## 6. 个人资产和必要支持

依据：实现设计 17.5、17.6.1，[06](evidence-delivery.md)；要求 D06/D10/D11/D12、C01/C02/C05/C07、A02/A09/A10。

### R06：最小资产身份不能静默消失

- `evidence_delivery.rs::search_reply` 在最终分配中区分目录项与已核验额外 Mem0 命中。目录项可以沿目录游标延期；无目录续读承载的额外项必须至少保 object/version/补读位置。
- 先为所有已核验额外项保留不可静默删除的最小集合，再用余量交原目录前缀并正确保其cursor；正文仍按相关要求裁剪。同一资产双路去重，不继续把额外项放在一个可从尾部删除的混合数组里。
- 连最小合法集合也装不下就沿现有 `tool_response_capacity`→Pi原生处理；不能删除额外项后返回成功，不靠重新调用 Mem0 假定一定召回相同结果，不加 Mem0 游标服务。
- 将已有约1000B RED迁入 `check-evidence-search-assets.mjs`：实际宿主分配1200B正控、1000B边界（以实际序列化与必要最小集合推导，数字不是产品固定下限）；相同资产双路去重；目录游标仅消费目录；成功持久回执与Pi输入一致；失败不冻结伪成功；同operation原成功回放不重裁。
- 同批共享余量、原生压缩及小预算恢复沿 `check-evidence-response-budget.mjs`、`check-tool-capacity-compaction.mjs` 原正负控。不提高最小回执预算来遮住错误。

### R08：可用的 Skill 按真实来源筛选

- 删除 `deliver_run`/`data_tools` 的受限任务全清 Skill；descriptor、初始候选、native read和附件共同使用已有资产dependencies/字段authority核验。
- 修 `personal_assets`/`data_tools` 将资产自身ID错交knowledge贡献根的问题；复用 `source_limits::authority_within_in_tx` 的资产分支，不另写资产→知识ID映射。合法同源资产可用；未选、停用、改版、依赖未知、空来源独立内容及越界来源保持拒绝。
- 同一个只依赖D的已选Skill：无限制和仅D均可descriptor/native read/分页；仅E拒绝，D+E混合依赖在只D下拒绝；未选不借批量工具绕过。包含正确元信息但未知内容来源的人工Skill继续拒绝，不重新引入原整次search409。
- 只删除已知范围下`gate.is_some()`的全面排除，保`scope_known=false`的未知处理；必须向`authority_within_in_tx`传真实资产身份/authority，不能传空对象利用空集合放行。当前分支还清memories并用else跳过Mem0合并：一起按实际资产来源过滤合法目录/额外项，未知或越界项排除但不拖累合法搜索整次409。补来源可证明的同源记忆与已选Skill在启动投影、后续派发及恢复中的正控，不能只修descriptor。
- `check-agent-library.mjs`、`check-evidence-assets.mjs`、`check-source-limits-memory.mjs`和 `check-derived-source-dispatch.mjs` 扩展正式路径。`memory_retrieval` 按真实含义补合同说明，不再笼统宣称“所有资产均排除”；优先保字段兼容，不为了文案另造控制状态。

### R11：先交可完整容纳的短条件

- `evidence_delivery` 的支持分配在既有有界支持集合内，先保本轮可完整放入的短支持，再用余量分片长支持；不启动额外检索或预读整个支持库。`knowledge_supports.rs::read_in_tx`当前遇`next_offset`就break，短条可能根本未进入分配器；须先沿owner取得本页最多50项有界元信息/长度及原位置，识别可交短项，再读取选中正文。不能只改输出排序，也不能一次预读全部长正文。
- 当前`SupportCursor`只有`next/content_offset`，`next_cursor`按输出数组下标推目录位置，不能安全乱序。实施采用有界当前页：保存原起点/末端、已消费完毕成员位置和当前目录内容绑定；短条先交，最多一条长条用余量分片并记原位置+Unicode offset。成员位表示该项已无剩余内容，不代表本回执完整交付。当前页全部消费完才推进到页末并丢弃成员状态；集合最多50项，不积累所有历史/正文或新建服务。
- 最后分片可能`offset>0,next_offset=null,complete=false`：游标应完成该成员并推进，但support_state仍按本次可见内容计算，不能误标整条delivered。此前页短支持也不能算成本页已交付依据。`SupportPage`、search/read分配与cursor必须共同携原位置，而不是重排后的数组下标。
- 同原文revision内重整会改变支持目录，这是R04与R11的正常组合。已核`knowledge::store::persist`会更新`knowledge_revisions.fingerprint`，包括当前派生对象；优先由同一knowledge owner窄读该现成指纹绑定cursor，不新增表/全局epoch或重新取全文。实施先证明同版支持变化确会改变该值；若旧数据缺指纹，只在当前有界页内保稳定成员/内容绑定，不能猜它未变。变化后沿`stale_cursor`拒绝旧offset套新成员，不扩建历史正文。
- 游标必须从**原目录位置**生成，不从排序后的输出下标生成；首个未交长项不得被后面短项越过。旧游标按旧顺序/偏移接续，新增格式只作必要版本分支；范围、修订/条件绑定保持。不同命中共享每回执50上限，同一回执重复引用不多计；先前页的短支持不能算本次delivered。补同一命中内长/短重排，不能只测不同命中间调序。
- 正式反例：同一命中首条长条件、后两条短例外，首条长于上游8192读取页，回执预算足以交短例外但装不下长条；首回执短例外完整、长条partial且可续。另补两个长项加短项、末片推进但不冒称整条delivered、旧cursor中途偏移及同revision支持变化后不串项。续页取得全部原文，Unicode偏移/unknown含义保持。扩展 `check-evidence-support-continuation.mjs`、`check-evidence-supports.mjs`，不能只测分配数组。

### 50项数量上限独立证明

`check-evidence-search-assets.mjs` 新增容量足够的26+25条短支持：实测全部51条原本能装进字节额度，正式结果仅50条，第51条有合法续读。它与小字节预算裁剪是两组不同证明；不删原两轮，不把恰好50条输入或51长条只能装23条解释为数量上限已验。

## 7. 深翻页与覆盖事实

依据：实现设计17.6–17.6.1，[05](hybrid-retrieval.md)、[06](evidence-delivery.md)；要求 D04/D06/D07、C02/C05/C06/C07、A02/A06/A09。

### R07：有界窗口续页，不积累整个查询历史（能力取舍已确认）

- 入口 `SearchContinuation::{snapshot,next_history,rank_window}`、`drive_stage`、scan位置与v2 cursor编码。原合同要求有界本窗信息，也写了分页去重；`search_continuation.rs`已有“窗口完成后只留原身份摘要去重”的跨窗预期。全查询history无限累加导致固定终点必须修，但改为仅同窗精确去重是能力取舍，不能声称旧要求从未包含跨窗去重。
- 目标采用**窗口生命周期**：当前窗仍有未交项时，保所有必要身份、原排名和已退成员；窗耗尽后释放该窗去重记录，游标仅保通道/分片已消费位置、必要未交引用与原范围/修订。删除全查询 `next_history` 累加和对应全局1000门，不能把删除上限解释成保留无界数组。
- 候选窗是捕获并保持排名的有界集合，不等于单个HTTP回执。跨通道同一个当前候选窗内去重；容量拆成多页不能重交或漏交。后续新窗中另一通道晚到的相同稳定身份可以重现，不再承诺全查询恰一次。唯一候选计数仍按本次调用/窗口定义，不声称知道全查询首次出现身份数，不新增全查询重复判断。通道必须实际前进，不能空成功重传同cursor；不用offset增长虚构安全淘汰证明。
- 旧cursor薄转换：按原格式/原上限校验→保当前成员、排名、真实offset→将本窗中命中旧history的成员并入本窗retired→释放全查询history，不再累计。不能直接清空history导致当前窗旧抑制成员重新交付。成功旧回执原样重放，不从头重查代替续页，scope/target/revision变化不伪装成正常翻页。
- RED/GREEN两层：纯类型场景跨越1000累计退休身份且后面仍有窗；正式工具长文/多entry超过1200位置直到末项可读，每调用原限额保持。加BM25第1/dense第1201才到的同身份、两路逆序、失效多交付少、非BMP、同窗末项、旧cursor有效pending集合及大小不随总页数增长。单窗不漏/不重/原排名断言保留；已有跨窗不重复预期按已确认决定显式更新，并记录旧值、新值和影响。
- 复用 `search_continuation.rs`、`check-evidence-search-continuation.mjs`、`check-retrieval-deep-advance.mjs`；深链反例可新增 `check-search-continuation-lifetime.mjs`，不建千张表验证一篇长文的游标生命周期。

### R12：只计算实际执行通道的限制

- `retrieval::query_terms` 的24词是SQL后备候选规则；`knowledge.rs`无条件 `!terms.complete` 改为SQL实际参与时才影响覆盖。BM25仍接完整问句，不为修状态改分词或查询语义。
- 两处无条件分支都处理；依据是SQL是否实际参与当前候选窗，不能只看本次续页有没有新发SQL。原窗确受SQL截词限制时，恢复/续页沿现有sql_active及真实来源事实保持该限制，不因未重新发SQL就丢状态。
- 健康BM25+dense、current索引、>24去重词项、无其他限额，正式v2不得因SQL截词报bounded；BM25明确失败→SQL替代才体现其截词限制；成功空BM25不额外启动SQL。

### R13：未知覆盖与已知滞后分开

- `knowledge.rs`覆盖检查记录实际完成/期限/错误；`data_tools.rs`从事实装配。只确认过旧投影/漏索引才报`index_lag`，没完成则保未核完及真实deadline/通道原因。
- 分别保存已证滞后与未完成原因，不能用`incomplete && !deadline`反推滞后。先查到真实lag、后又到deadline时两者都保留；单纯超时未查到lag则不能标lag。当前公开`index_lag`/`deadline`已能表达这些场景，不默认扩enum。
- 优先复用当前公开coverage/reasons可表达状态；只有表达缺口时最小增补Schema/生成类型。保本题已读合法正文，不删期限或伪造searched。
- 正控current；已查证stale→lag；时间耗尽/读取超时→未核完且非lag。正式接口场景把其他有界原因排除后断言目标原因，不只改enum单测。

### R14：部分通道失败原因不丢

- `vector`已保存的分片失败沿结果类型传入v2；某片成功不抹掉另片失败。允许通道仍有可用正文，同时coverage bounded并列出实际原因；不把局部失败改成全败，不增SQL第三张票。
- 已回源确认失败在`scan_progress.milvus[*].shards[*].failed`中存在；优先修`data_tools.rs`最终装配，不默认增加中间类型或Schema。部分成功时通道available与原因channel_unavailable可以并存，分别表示可用正文及未覆盖的失败分片。
- 一片成功一片明确失败、全成功、全失败、正常耗尽对照；验证最终v2及Pi可见状态，而非只断言内部`bounded`。
- R12–R14扩展 `check-retrieval-channel-coverage.mjs`、`check-retrieval-channel-faults.mjs`、`check-evidence-search.mjs`。保原SQL/deadline/exact与来源范围断言。

## 8. 收敛重复实现与文档

- `apps/agent/tools/data-tools.ts`：原生read参数在入口decode后，把生成类型传给格式化逻辑；删正常路径第二次相同decode。恢复/跨进程入口仍校验自己的不可信输入。跑 `make verify-pi-transport`，不能以删除负控或把参数改any消除报错。
- 支持测试重复不变量循环、`AnalysisReport`冗余判空仅在已读相关代码时小范围清理；不为两行清理另起重构，不移动无关模块。
- 同步 README、`docs/development.md`、`docs/architecture/README.md`、系统/实现设计相关合同、03同修订整理及04受限资产的直接相关条款、05–08详细规格及CURRENT。明确原23组已通过、本轮修复是否完成、09仍未做、真实效果仍未验，不留下“08未关闭”和“全已解决”的冲突说明。历史AGENT_PROMPT只更新接续入口，不重写当时日志。
- 原型主要布局保持；D1/D2改变的状态流程/图注以及最终提交、同修订整理、Skill来源过滤节点需与新合同一致。若图意改变，改图源再运行现有render/check；无变化记录为何不重画。09文件不改，原综合轨迹已涵盖这些能力。

## 9. 验证、冻结与停止

本地命令环境：Node26；`PATH="/opt/homebrew/bin:$HOME/.cargo/bin:$PATH"`。在子shell中unset真实模型/provider与DATABASE_URL变量后运行检查；不要读/打印`.env`。集成测试使用harness隔离合成库、原本地协议替身，Docker使用`colima-data-agent`；DB harness串行，不`make -j`。真实Milvus与真实embedding/模型是不同证据，不混称。

Rust改到可测试切片后先分别 `cargo build --offline --locked -p data-agent-api`、`cargo build --offline --locked -p data-agent-worker`；记录二进制/源码版本。后续输入未变不重复构建；Make目标中的增量构建允许自然复用。失败先看完整退出码、到达断言和当前环境，不把所有超时归给Defender，不盲跑同一大电池。

### 验收绑定

沿用原23组回归作为本增量受影响基线，原收据只保历史。新反例优先加入已有绑定脚本，使其实际到达；新增脚本在创建并验证后才写入CURRENT的command，不用不存在的命令占位通过。至少补足：

| 新增行为组 | 覆盖问题 | 入口与证据 |
| --- | --- | --- |
| 最终提交与容量 | R01/R02/R09、D1/D2 | 扩展TASK-COVERAGE/恢复脚本；API/MySQL+实际Node；D2浏览器刷新 |
| 原查询通知归属 | R10 | 扩展TASK-NOTIFICATION，实际Node route/恢复 |
| 同修订再整理 | R03 | 正式source→ready→依赖变化→Worker新批；新增绑定如需 |
| 同版档案与冻结索引 | R04/R05 | 扩展UPGRADE-CURRENT/FROZEN/INDEX；完整消费者与旧档哈希 |
| 最小资产/支持优先级 | R06/R11、50项补证 | 扩展EVIDENCE-SEARCH/BUDGET；新增支持续页绑定如未被目标包含 |
| 同源Skill | R08 | 扩展EVIDENCE-ASSETS及agent-library/受限来源组合 |
| 续页生命周期 | R07 | Rust+正式工具深链，新旧cursor、反向通道、实际后页 |
| 覆盖原因 | R12/R13/R14 | 现有channel coverage/fault脚本需明确纳入本增量 |
| 同侧read校验 | 清理 | PI-BOUNDARY原坏输入/恢复正负控 |

原23组名称和命令从旧声明/收据读取，不凭摘要重拼漏组。实际绑定必须覆盖本包每一行；同一命令覆盖多个问题可映射多项，不为R编号机械造14个测试文件。超时根据实际测量设定，区分套件时长与产品期限；不得改业务断言换取收口。

以下是编包时规划的4个新增验收入口；是否已创建、绑定和通过，以 CURRENT 及当前代码的有效证据为准，不把历史占位状态当成接续时的进度。实施者可在覆盖相同正式路径的既有脚本内扩展并绑定该脚本，不能留下`command: null`关闭增量，也不为保留文件名重复造测试。

| 验收组 | 正式入口的默认落点 | 必须经过的路径 |
| --- | --- | --- |
| SOURCE-REPREPARATION | `node tests/mvp/check-source-repreparation.mjs` | 正式准备→ready→依赖变化→同修订重开→Worker应用，包含同批恢复 |
| ASSET-SOURCE-REUSE | `node tests/mvp/check-skill-source-limits.mjs` | 真实Node descriptor/native read/附件与Rust资产authority，受限同源正控及越界负控 |
| SEARCH-CONTINUATION-LIFETIME | `node tests/mvp/check-search-continuation-lifetime.mjs` | 正式工具跨窗口深链、真实续页位置与有限cursor，不能只测序列化 |
| WAITING-DELIVERY | `node tests/mvp/check-waiting-task-delivery.mjs` | D1/D2正式提交、Pi恢复和浏览器刷新，任务阶段与持久正文一致 |

### 正式收口

1. 当前切片最小检查→相关回归；产品、测试、合同、必要文档齐备后只冻结一次有意义的候选版本。
2. 新增/改变的测试预期在CURRENT“验收与要求变更”记旧值、新值、原合同或本包明确修正、证据和影响。尤其R02合并容量、R07去重生命周期、D1/D2不能静默改期望。
3. 未参与相应实现的独立审查者核R01–R14、D1/D2、删除边界、旧能力和实际运行结果。项目格式`reviewer/summary/conclusion/scope_sha256`，范围来自真实冻结输入；不能只刷新旧报告hash。Oracle本次执行包审查不代替未来实现审查。
4. `make verify-materials verify-delivery`校验材料和声明；`make verify-increment`实际运行新声明全部绑定，取得当前指纹收据。失败、超时、未运行、过期均不complete；修复后先复验受影响项、刷新独立审查，再按项目规定取得完整收据，不能无变化反复跑。
5. 完成后新修复increment置complete并`make verify-delivery`确认。原08收据不覆盖；09仍待实施。最终交付逐问题根因/修复或删除/证据、残留缺口、文档入口和未验证层级。

缺少实际授权的付费、Git提交推送、部署、日常服务更新、破坏性数据操作不执行。只有真实产品冲突、不可替代环境/授权、独立审查不可用或重复尝试无新证据时停对应工作，其他独立项继续；不能任务大就停在第一项，也不能写“所有问题都修好了”掩盖未验。
