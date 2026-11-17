# 语义交付剩余缺口修复执行包

编包日期：2026-11-01。唯一当前状态、授权和验收绑定在 [CURRENT](../../CURRENT.md)。本包接续已取得 30 条去重命令通过收据的 `I2-SEMANTIC-CLOSURE-REPAIRS`，只处理复审确认的 **7 处实现问题及 1 处 Pi 集成缺口**。原 [14 项修复规格](closure-repairs.md)及通过收据保留历史身份，不能从头重做，也不能用旧通过替代新反例。

本包草稿已完成 Oracle 最高5/5审查，结论为“需小改”；四项明确化意见已回源核对并纳入，最终修订由本地复核，未再次送外审。详见[交叉核对](../../reviews/semantic-delivery-package-review-20261101.md)。本轮编包不实施产品修复。下一实施者完成本包后停止，**09 的 [整体验收](integrated-dogfood.md)原文和任务不变，不执行**。新增量为 `I2-SEMANTIC-DELIVERY-REPAIRS`，初始 `planned`、审查 `pending`、证据 `null`；收到用户实施指令后转 `active`。编包及 Oracle 审包不等于实现验收。

## 1. 入口与有效边界

启动必读：根目录 [AGENTS](../../../AGENTS.md)、CURRENT 顶部最新决定和 `delivery.increment`、本包第 1–3 节。然后按当前切片读第 4–9 节及其源码，不先通读全部历史。问题与证据层级见 [本轮审包记录](../../reviews/semantic-delivery-package-review-20261101.md)；[CONTINUATION_PROMPT](CONTINUATION_PROMPT.md)只提供接续入口，不另维护计划。

- 编包时分支 `codex/semantic-maintenance-prototype`，HEAD `04d27d06ba7b97d4cf3e288d4cf9e6300ef491a9`。接手重新核对，保留全部继承未提交改动；不得 reset、覆盖或清理其他工作。
- 原关闭证据：`.local/delivery/I2-SEMANTIC-CLOSURE-REPAIRS-result.json`，2026-11-01 北京时间 19:48:14 完成，31 条验收映射为 30 条实际命令；复审时 `make verify-delivery` 确认匹配。旧审查范围指纹 `7607161f3a0c9f783f966b5623d8da62088beae893bafab9ae9a0e1f872a28bd` 只证明当时范围，不能用于本包。
- 已确认的 R02、R07、D1、D2 均不重问：每份正文 8000 Unicode 字符，最多 24 项宿主合并上界 384281，user 仍 32000；候选窗内精确去重、跨新窗允许晚到同身份重现；宿主控制确认不结清分析；持久可见任务卡可承担澄清。
- 保 Pi 锁定版本 1.3 为唯一 Agent、循环、压缩、取消和恢复机制；保原 `operation/origin/budget/output` 身份、每消息 24 次调用及连续临时失败 3 次。MySQL 正式内容、Milvus 公共索引、Mem0 个人记忆和 Pi 原生 Skill 不换型。
- 保单搜索 10 秒工作期限、1000 唯一候选含预留、5 轮、30 主内容读取及每回执 50 支持；不得将它们变成跨页累计限额，也不提高默认模型或请求容量掩盖失败。
- 不重做来源同步、整理/归档、索引配置、R02 扩列或资产治理；不新增业务功能、服务、后台监听、第二账本、通用恢复/答案/检索会话框架，不升级依赖。
- 本包执行范围为代码、相称本地验证及直接相关文档；不授权付费模型/embedding、commit/push、部署、更新日常服务、主库操作或破坏性清理。

### 防止防护和测试膨胀

1. **新增防护先对应原因。** 必须指出本包哪条已复现行为、哪项明确合同或哪条可达普通调用链需要它。只有“理论上更安全”就不写。未证实的小概率场景只记候选，说明触发、证据、影响与复杂度后请用户决定；不知道概率就写未知，不编数字。不顺手添加 ABA、碰撞、外部篡改、跨机争写等保护。
2. **入口校验一次。** 相同边界、相同数据、相同约束不叠校验；内部传已验证类型。权限/版本已变化后的提交重核、恢复导入和新跨进程边界各有独立责任，不能当重复删除。
3. **不提前造抽象。** 简单单用逻辑默认内联；只有真实复用、存储 owner 或明确复杂度隔离才抽取。替换已有判断就删失效旧分支，不能叠一层“保险”后两套并存。`try/catch` 只用于明确恢复、边界错误翻译或有效上下文，禁止吞错转成功和层层重试。
4. **测试只证明行为。** 每切片从一个最小反例开始，再保该修复确实影响的正常路径/负控。优先扩展下文现有脚本；没有现成接缝才建具业务名称的小脚本。禁止为覆盖率、私有 helper、字段转存或同一断言在单测/HTTP/E2E 三层重复堆测试；禁止为本包补全无关边界矩阵。
5. **验证不靠反复碰运气。** 最小反例→最小实现→相关回归逐条推进。代码未变不无故重建；DB harness 串行，不 `make -j`。最终输入稳定后才做正式全绑定验收；失败先定位到命令/阶段/退出码，先单项复验，再按原交付规则取得最终收据，不为每个小改跑整套。不得把超时自动归因于 Defender，也不加通用重试/退出兜底“治”未知挂起。
6. **审查也要删除膨胀。** 独立审查对每个新增防护、helper、catch 和测试说明其对应缺口；删本轮没有依据或重复的新增内容。旧必要业务检查与旧验收不能借“精简”删掉。无需自动开多代理评审面板；只在冻结后的关键增量安排未参与实现的审查者。

## 2. 任务导航与责任

| 顺序 | 用户可见结果 | 对应缺口 | 主要入口 | 依赖 |
| --- | --- | --- | --- | --- |
| 1 | 控制确认不带失效文字，新的保存事实不会沿用旧条数 | 1、5 | `task_answers.rs`、`data_tools.rs`、`deliver_run.rs` | 无 |
| 2 | 中断后先接回待执行操作，再结束本轮 | 2 | `session/deliver.ts`、现有 runtime 恢复 | 1 的身份语义 |
| 3 | 原条件结果能与另一任务已冻结答案一起交付 | 3 | `task_answers.rs::compose_in_tx` | 原查询来源合同 |
| 4 | 压缩、下一轮和重启中的正文与正式交付一致 | 6、7 | `workspace-context.ts`、`deliver.ts` | 1–3 的最终交付选择 |
| 5 | 支持末页只报告本回执实际完整性 | 4 | `data_tools.rs`、`evidence_delivery.rs`、`knowledge_supports.rs` | 现有窗口游标 |
| 6 | 原深翻页场景经 Pi 完成，容量失败有真实归因 | 8 | `session/capacity.ts`、正式工具与原深翻页脚本 | 5；若触及上下文还依赖 4 |

由一个整合者顺序拥有共享入口、`packages/contracts`、Makefile 和 CURRENT，不并行编辑它们。每切片出口更新 CURRENT 的已改文件、证据层级/退出码、剩余项和下一步；连续执行不等逐片批准，不因上下文压缩重开目标。

允许范围以 CURRENT 为准：上述 use_cases，直接相关 `analysis/conversations/queries/runtime/knowledge` 公开操作及私有 store，Pi session/tools/transport/provider 的必要接线，相关测试和合同/文档。检索 owner 仅在缺口 8 的测量证实它承担根因时改。没有依据不要触碰 ingestion、迁移或前端；若真正合同需要新增字段，先说明消费者与兼容影响，再走同源 Schema，不预建新格式。实现/测试名称用业务含义，缺口编号只用于文档。

## 3. 接口与证据纪律

使用 `dev_co` 接续本目标，`tdd` 组织纵向反例，`contract-first` 仅处理实际边界变化。`packages/contracts/schema.json` 是唯一跨语言合同真源，生成 Rust/TS 类型，不能手写平行定义或手改 generated。

| 边界 | 提供者 → 消费者 | 本包保持或补齐的语义 |
| --- | --- | --- |
| `WorkspaceContext.control_delivery` | Rust 启动/恢复 → Node | 提供可合法展示的持久控制投影；不能先装入未保护 goal 再仅保护旁边的 tasks |
| `DataToolOutcome.control_delivery` | Rust 正常/重放回执 → Node | 缺省沿现合同“不更新”，显式 null 清除，非 null 更新；只对成功回执采用。成功回执抑制失效控制投影必须显式 null，不能省略；不把所有失败回执改成更新控制。新操作事实和原操作重放分开 |
| `FinishRun.control_delivery_ref` | Node → Rust 最终事务 | 引用宿主持久投影，核自身文字来源和实际事实；不是权限凭据，不借此豁免未核验分析 |
| `AnswerPartReference`/答案工具 sources | Pi 工具 → Rust 组合 | 查询通知按原 query/task/condition 核验；不能用当前 active 版本替换历史绑定 |
| `support_state`/支持游标 | Rust 读取/裁剪 → Pi | delivered 只代表本回执交齐；cursor 耗尽或累计读齐不等于本回执完整 |
| `ResponseBudget`/最终 provider wire | Pi 接入 → Rust 工具 → provider | 预算、实际回执、固定开销和压缩后请求需对上；真正压缩与重试由 Pi 执行 |

缺口 1–5 已有真实 Rust/MySQL 或 Node/Pi 接续反例；6–7 是真实 SDK 投影与产品 hook 的反例，**不是完整 provider E2E**；8 是正式深链测试改走内部直工具后留下的 Pi 集成缺口，容量具体根因尚未证实。

本机反例在 `.local/audits/semantic-closure-current-20261101/`，均为合成材料，官方请求 0。这些文件可能不随 Git 交接，下面每项已给重建步骤；缺文件时重建正式最小反例，不能回退产品制造红灯或伪称历史已跑。诊断脚本可留 `.local`；只把能稳定证明行为的最小场景并入正式测试，不复制整套探针成为永久框架。

## 4. 控制正文来源与新操作事实（缺口 1、5）

当前根因：`task_answers::control_delivery_in_tx` 用未保护的 goal/question 组装正文；重放/组合只接指纹和任务覆盖，没有文字 authority。`reconnect_control_delivery_in_tx` 只按 task/version 集合回旧投影，在读当前查询前返回，导致同任务新保存第二条 SQL 仍显示第一条事实。

先读：实现设计 17.4、17.5、17.8；`context_authority::{protect_task_context_in_tx,validate_text_in_tx}`、`analysis::task_text_authorities_in_tx`；`task_answers::{control_delivery_in_tx,reconnect_control_delivery_in_tx,stored_control_delivery_in_tx,compose_in_tx}`；`deliver_run` 两个投影出口、`data_tools` 成功及重放出口；runtime 的 `control_deliveries_in_tx`。

**修改与删除边界：**

- 控制事实与被展示的文字分别承担原有责任。复用字段 authority：只将可读 goal/开放问题传入投影；来源不可用时沿既有字段保护处理，不能把旁路原文留在 `control_delivery`。正文被缩短也不能免除其来源。
- 首次生成、启动/恢复、回执重放、最终 finish 均沿同一规则；状态变化后的最终重核是必要业务校验，不在每层重新 decode 同一 JSON。最终若引用文字已失效，沿现错误合同拒绝，且 commit/consume/answered 不推进；不能悄悄改旧指纹的正文后称原回执重放成功。原持久成功回执与本次可见投影分开：若成功回执按字段保护抑制控制投影，显式返回 `control_delivery:null` 撤下 Node 旧候选，省略字段仍只是“不更新”。若沿既有错误合同拒绝，沿原失败/当前上下文处理，不能将其当成功重放后继续用旧候选结束；不把所有失败回执都改成更新 control。此断言并入同一 authority 反例，不新建控制缓存测试体系。
- 保持合法纯控制确认：无关来源变化不能通过“全 run 依赖并集”误拒合法事实；不把去掉标题/问题文字后仍正确的控制操作一律禁用。普通任务数据的原字段保护继续生效。
- 区分“接回同一已完成操作的投影”与“成功的新操作产生新事实”。利用现有工具操作/持久回执身份和查询事实，删除仅按 task/version 对所有新操作复用旧投影的捷径。恢复不因 queued→running 重造原指纹；新 SQL 则不能遗漏新 query_id。无需新表、新历史服务或给所有读取生成新投影。“原样重放”指在仍有效的授权/来源下保原持久事实与身份；来源失效后，当前交付可按既有保护抑制或拒绝，不得因此覆盖成功存储，也不能继续暴露不可读正文。
- 存储查询留 runtime/analysis 等 owner 私有 store，组合层只用窄接口，不新增裸 SQL 或架构 allowlist。涉及结果回源时沿现有锁外查证、重入短事务核当前状态的路径，不在补控制文字检查时把平台 I/O 放进会话锁。

**最小反例与验收：**

1. 正式文档→任务目标/澄清→控制回执→正式停用文档→重放→finish。普通 `data`、顶层控制、Workspace 和最终输出均不再外泄失效标记；引用原失效正文的提交失败，三类终态不推进。保合法纯控制和不相关资料变化的正控。证据：`control-authority.json` / `probe-control-authority.mjs`。
2. 同任务同条件保存 SQL A、SQL B：两个不同 query_id 成功，第二份控制事实确实包括新操作，条数/指纹与新事实一致；分别重放原 A、原 B 的成功调用仍回各自持久事实，不多保存。queued→running 恢复沿原事实。证据：`probes.json:new_control_operation_reuses_old_facts` / `probe-current.mjs`。

优先扩展 `tests/mvp/check-waiting-task-delivery.mjs`、`check-task-text-authority.mjs` 或 `check-evidence-replay-boundaries.mjs` 中合适的公开接缝；一个场景只设一个主证明，不把相同断言复制三份。登记/执行/读取走正式 API；必要的运行账本只作为恢复身份辅助观测。

## 5. 待执行工具先接续（缺口 2）

根因：`deliver.ts` 已计算 `pendingCalls`，但恢复快提交只排除 `pendingTaskCreation`，普通 `request_query` 等登记未执行调用被跳过。Rust 拒绝未结算操作正确，不能放宽 finish。

- 先读 `deliver.ts` 的恢复快路、pending 工具续接和 `taskTool`，以及现有 `check-task-answer-recovery.mjs`、`check-recovery-continuation.mjs`、`check-waiting-task-delivery.mjs`。
- 快路资格必须与原工具接续一致：需要继续的调用先进入现有路径；只有已结清或原取消合同明确无需执行的操作才可快提交。把只保护“新建任务”的局部判断纳入真实 pending 判据，不叠另一套工具状态机。
- 不重新生成 operation/origin，不用新 run 给旧操作补预算；unknown 沿原查证路径，不为证明恢复成功重派未知副作用。没有 pending 的控制/冻结恢复仍应零额外模型调用。
- RED：第一条 SQL 已保存，第二条 `request_query` 仅登记，断点后真实 Worker 恢复，实际 Node deliver。当前立即 finish `version_conflict` 且第二条 `registered, execution_started=0`。
- GREEN：第二条沿原身份执行或按原规则查证，恰一份副作用，正式交付包含应有事实；原 commit/output 不改。与“无 pending 的恢复快提交”和既有 cancelled/unknown 负控一起验证，不新增所有工具×所有状态笛卡尔积。证据：`control-recovery.json` / `probe-control-recovery.mjs`。

## 6. 历史结果与冻结答案组合（缺口 3）

根因：`task_answers::compose_in_tx` 接受 `notification_matches`，随后 `scope_in_tx` 又要求任务当前条件版本等于原结果版本；单答案路径已修，组合出口仍拒绝合法旧通知。

- 先读 `task_answers::{scope_in_tx,compose_in_tx}`、`analysis_answers` 原查询来源判断、`finish_run` 结果通知分支、`deliver.ts::notificationAnswer` 与 `tests/mvp/check-result-notification-answers.mjs`。
- 旧通知严格按原 query/task/condition 及其实际结果来源、历史用途核验，复用已修单答案合同。不能为省事让普通当前答案绕过版本检查，也不能把旧结果绑定到新条件、去掉 task 生命周期或权限检查。
- 组合中新通知末项的 scope/goal authority 和展示标题必须来自正确用途，不先套当前 v2 scope，也不能放行正文后仍用 current.goal 给旧结果冠以新条件标题。已回源确认 `generated_text_authority_in_tx(run.id,{})` 读取的是 runtime 的 run authority 快照，`merge_run_in_tx` 会向其中合并来源；历史末项不能用这一整轮来源集合替代自己的实际依据。成功 `present_analysis_answer` 末项复用 `analysis_answers::check_in_tx`、原 query 文字来源及结果/历史用途核验责任，按现有锁外查证/短事务接口整合，不复制校验器。B冻结项仍独立核自身引用；普通当前答案仍保当前版本/scope，不能全局删除 generated-text authority。
- 历史标题优先采用已有可核验历史文字；现存记录没有历史 goal 时，用宿主生成的中性“原条件查询结果”及已有原查询/条件引用表达用途，不用当前 v2 goal，不为了标题加历史快照表。自然文本仍不能冒充已核验查询答案。
- RED：Q 属 A/v1，A 改为 v2；真实 Pi 先为 B 定稿，再 route A/v2，get_query 和 present 成功解释 Q/v1，最后提交 B 冻结项＋A/v1 答案。当前最后一步 `version_conflict`。
- GREEN：一次正式交付含 B 原文及“合成旧条件金额99。”，对应 Q/v1；A/v2 保未被旧通知结清，不影响其他任务/原预算。保原“同任务同版本另一个 query 不能冒充”、取消/撤权及单答案正控；刷新或持久历史读回核对应两份正文。复用原通知测试，不新建另一通知框架。证据：`late-query.json` / `probe-late-query.mjs`。

## 7. Pi 上下文与最终交付一致（缺口 6、7）

根因一：`workspace-context.ts` 以最后一个 user 条目定位本轮，Pi 压缩后只有 `[compactionSummary, assistant]` 时直接 return，未核验草稿残留。根因二：hook 只看控制候选存在，而 `deliver.ts::commitAnswer` 选择 grounded 优先，两者会分别写“已保存”和“结果99”。

先读当前锁定 Pi 的 `AgentBeforeSettleEvent/BoundaryState/SessionBoundaryDraft` 及 `SessionManager.buildSessionProjection/appendContextEdit` 公共接口；再读 `workspace-context.ts`、`deliver.ts`、`checkpoint.ts`/`journal.ts` 的已有接线，以及 `check-control-context-edit.mjs`、`check-waiting-task-delivery.mjs`、`check-native-compaction.mjs`。不要升级 SDK 规避定位。

**实施合同：**

- 正式提交和 settle hook 使用同一交付选择事实：已核验分析、已冻结项和纯控制各沿现合同。grounded 合法存在时，旧 control 候选不能覆盖它；不能通过无条件清空控制丢掉其他等待任务。若需共享局部判断，这是两处实际复用，不新建“答案管理器”或新持久状态。这份局部选择还须包含通知答案优先及原 `needsResultAnswer()` 未完成义务；`outcome:completed` 只表示当前活动成功，不等于宿主已可结束。按锁定SDK核 `continue`、`pendingMessages`、`canContinue`：后者表示上下文可继续，不是必须再调用模型；不能为应用编辑设置 `continue:true` 或触发额外整理调用，也不能覆盖SDK原本排队续接。
- 本轮定位使用当前运行已有身份与 Pi 原生条目/投影，不假定 user 必然保留，也不从全部历史向前找到任意 assistant 就改。可用现有运行前检查点及本轮消息事件建立明确边界；恢复沿原检查点/操作，禁止另造持久轮次账本。不能确认本轮归属不等于“本轮没有正文”，不得直接追加控制消息并宣称草稿已消除；先回源确定原条目映射并用下述正式输入验证。
- 成功结束且没有待接续动作时，通过 Pi 原生 `context_edit` 处理**可确认为本轮**的未核验正文；确实没有需要替换的本轮正文时才用原生宿主消息补控制事实。单纯追加“以上作废”却保留被替代草稿当事实，不算修复。失败/取消/排队消息/冻结前项/旧轮正文不被回扫改写。
- hook 草稿沿 SDK 公共边界提交，使活动上下文与导出的 checkpoint 一致。点名覆盖 `deliver.ts` 在创建 workspace extension 前直接 finish 的恢复快路：先处理需接续工具，再在导出 checkpoint 前用已有公开 `SessionManager.appendContextEdit`/宿主消息与 checkpoint 接口完成适用投影，不能依赖本次未执行的 hook；原身份与零额外模型调用保持。这里的“同会话”指现有逻辑会话/checkpoint续接，不要求把按run创建的对象改成常驻会话服务。禁止直接修改 SDK 私有状态、自写压缩器、手改追加日志或增加模型调用整理答案。
- 不把整份跨来源合并分析重新塞给模型；这里只修控制投影与单份已核验答案的选择/可见性，不改变原来源隔离规则。

**验证收敛：**

1. 先将 `context.json:compacted_control` 与 `grounded_answer_after_control` 两个真实 SDK/hook 反例并入现有小检查；确认一个在无 user 投影时消除目标草稿，另一个保留“已核验结果为99”。原 error/aborted/本轮无正文不改旧答负控保留。
2. 再用现有本地协议模型，经过真实 deliver 和 Pi 原生压缩/settle，观察**同会话下一次 provider 实际输入及导出后重启输入**。纯控制不带被替代草稿，grounded 不被旧等待文案覆盖；正式持久正文与所选交付一致，冻结前项/原工具/usage身份保持。
3. 这两层各证明不同责任，不在每层复制整套边界矩阵。不能只调用 hook 返回草稿就宣称 Pi 已应用，也不能只看 UI。现有重启/丢回执用例能承载就复用，未知提交不重复添加编辑/改 commit 指纹；不要为所有可能中断点再造一套故障注入。

## 8. 按本回执计算支持完整性（缺口 4）

根因：`data_tools.rs` 初装配与 `evidence_delivery::knowledge_support_page` 最终裁剪用 first_offset、长内容偏移、next_cursor 判定完整；同一窗口此前已交完的短成员不参与判定，第三回执只有一条也能误报 delivered。

- 先读实现设计 17.5/17.6、`knowledge_supports::SupportPage/SupportSelection` 和原窗口 `consumed` 含义，再读以上两个装配出口及 `check-evidence-support-continuation.mjs`。
- delivered 必须由**当前序列化回执**实际完整支持或合法内嵌映射证明。之前回执已交成员只影响游标推进，不算本回执正文。沿现有窗口/成员/完整性事实传递，不加跨页已读账本，不重读全部支持。
- 同一判断贯穿 search 和 read 的初装配/最终容量裁剪，删各自误判的旧分支；合法 unknown 与无需支持情形沿原合同，不把所有续页一律当错误或永远 partial。
- RED：同一陈述三条短支持，每次预算只能装一条，三次回执数量 1/1/1，当前状态 partial/partial/delivered。GREEN 为本例三份均 partial，末页游标可正常耗尽；充足预算同回执全交三条为 delivered，合法内嵌支持仍能完整。不要把 partial 解释成要求模型无限重读。
- 保原长条末片、Unicode 位置、旧 cursor 与同修订指纹、50 项上限及回执重放测试，不再单独扩建支持排列组合全集。search/read 同一失败原因选最小公共证明，另一路只补必要装配集成断言。证据：`probes.json:short_supports_last_receipt` / `probe-current.mjs`。

## 9. 关闭 Pi 深翻页集成缺口（缺口 8）

事实：`check-search-continuation-lifetime.mjs` 用真实 MySQL/Milvus 和直接内部工具证明两个候选窗、1202 dense 位置及末项可读，注释同时记录 Pi 第二页容量错误后改为直调。它是有效后端证据，**不能顶替 Pi 集成**。固定 schema 双编码是否根因尚未证实；同 131072 配置的其他 Pi 分页已能成功，不能直接删估算或加大默认值。

### 先做一次有区分力的诊断

1. 复用原夹具、scope、v2 工具集与容量配置，将原错误经真实 Node/Pi 正式工具链重现。参考 `check-evidence-search-continuation.mjs`、`check-evidence-search-compact-capacity.mjs` 的本地协议端点，不能换少量候选或宽松预算称同题通过。
2. 先标出首个失败步骤、产生错误的组件/边界，再与成功分页对照相同时点。记录数值和合成标记：实际已发送 provider wire 字节、system/工具定义/历史/cursor 各占用、`protocolBytes`、`ResponseBudget`、实际工具回执、压缩前后 Pi 投影及剩余调用数；工具预算阶段已拒绝时，没有该步骤已发送的 provider 请求，不能虚构。将 `request-size.ts` 请求预检与 `capacity.ts` 工具余量分别定位。字节实测、token估算、本地协议端点的合成usage分开标明，不能把合成usage称真实模型计量，也不因两个 stringify 就认定重复。诊断不进默认生产日志、不打印凭据。
3. 同步纠正原深链测试第15–17行的未证归因注释：只记录该夹具 Pi 分页曾出现 `tool_response_capacity`、直工具只证明后端，具体原因待对照；根因确认再更新，保1202位置与原断言。按证据分支处理：宿主重复或过量预留→修该分配；固定真实输入本就装不下→如实判定配置/夹具是否符合当前容量合同，不能删场景或擅改产品上限；Pi 接入未按原生溢出/压缩机制重试→修薄接线；测试模型摘要/续读协议错误→给独立依据修夹具，保原行为断言。若需用户改变真实行为/容量配置才可解，带实测数值提出最小选择，不假称完成。

### 必须达到的出口

- 同题经实际 Pi 进行搜索、续页和末项补读，原后端断言仍成立：同窗不重不漏、跨窗允许同身份重现、位置前进、末项可读、每调用既有限额、游标不随累计页数增长。
- 恰当压缩后继续同一会话/原预算/原操作；不会第二页永久容量失败，也不会靠反复摘要耗光 24 次。旧成功回执重放不重剪；真的固定开销不足仍明确失败，不 catch 成空成功。
- 保原直接工具测试作为后端层证明；不要复制整份千候选建库逻辑来凑第二套，优先同文件最小路径参数或现有夹具复用。新增参数须实际用于区别两种集成接缝，不抽通用评测框架。
- 若改 `capacity.ts`，回归同批多工具共享余量、真实载荷检查、原生压缩及旧成功回执小预算恢复。若实测只需改夹具，产品容量代码保持。09不替它补验。

## 10. 验证绑定、收口与交接

### 先小后大，不复制旧 30 条电池

本包选取受影响基线，新增断言须先红后绿或明确已有反例证据。CURRENT 中新行为初始 `command:null`，脚本真正包含相应断言后再绑定；已存在的同名脚本通过不代表新验收已具备。一个脚本覆盖多个相关缺口时共用同一 argv，由检查器去重，不包装另一层重复运行。测试超时按实际正常耗时核定，不能因无进展直接扩大超时。

| 验收 ID（只用于声明） | 覆盖 | 优先入口及最少结果 |
| --- | --- | --- |
| CONTROL-TEXT-AUTHORITY | 1 | 等待交付/任务文字授权既有脚本：首次/重放/finish的失效标记与合法控制正控 |
| CONTROL-OPERATION-FACTS | 5 | 等待交付脚本：A/B新事实不同，各自重放原样 |
| CONTROL-PENDING-RECOVERY | 2 | 既有恢复脚本：登记第二工具→Worker/Node接回→唯一副作用/正确交付 |
| HISTORICAL-ANSWER-COMPOSITION | 3 | `check-result-notification-answers.mjs`：B冻结＋Q/A-v1，A-v2未结清 |
| CONTROL-COMPACTED-CONTEXT | 6 | SDK小反例＋正式Pi链中的下一轮/重启输入，无遗留草稿 |
| GROUNDED-CONTEXT-PRECEDENCE | 7 | 同正式链已核验答案优先，不被旧控制改写 |
| SUPPORT-RECEIPT-COMPLETENESS | 4 | `check-evidence-support-continuation.mjs`：三短条分三回执均partial，全交delivered |
| PI-DEEP-CONTINUATION | 8 | 原深链场景经Pi完整执行，预算诊断与末项/游标证据，不用直调替代 |

受影响回归复用已有 `verify-contracts`、`verify-code`、`verify-architecture`、`verify-pi-transport`，以及 CURRENT 绑定的任务交付/恢复、依据读取/搜索、容量/原生压缩/authority 脚本。没有改来源准备、索引写入或存储升级，不自动重跑其全套历史电池；实际触及才补说明和对应回归，不删全项目要求映射。

环境：Node 26，PATH 含 `/opt/homebrew/bin` 与 `$HOME/.cargo/bin`。测试在子 shell 清除真实 `DEEPSEEK_API_KEY DEEPSEEK_BASE_URL DEEPSEEK_MODEL DATA_AGENT_MODEL_PROFILE DATA_AGENT_MODEL_FAULT DATABASE_URL`；沿 harness 隔离合成库和本地协议 provider。Docker context `colima-data-agent`。仅在 Rust 相关源码改变后分别重建 API、Worker，核实被 harness 使用的二进制，再串行跑 DB 验证。不得改现有租约/期限让机器抖动时“通过”。

### 文档和正式关闭

1. 逐缺口交代最小修复、删除的旧逻辑、断言、证据层级和未验部分。只同步实际改变的合同、05–08/Pi复用条款及必要 README/图注；架构拓扑未变不机械重画。09文件 SHA256 保持 `ebcdc8798f6d63dcad8c399d95822a0db1e8103b44bcce9c305b9c9541c01e74`。
2. 修正文档过度归因：第三轮 `UPGRADE-FROZEN` 日志只完成 prefill-timeouts 七模式中的前四个，没有 suite 最终通过。记录“第4模式收尾/第5初始化或后续阶段无输出，原因未定位；后续重跑通过”；不得说组内全部完成、只是退出挂起或已证 Defender。旧审查者原结论不代改，追加勘误并链接新证据。
3. 完成最小及相关检查后，核当前输入/断言再冻结；未参与实现的审查者核八项闭环、四条规则、Pi复用及测试是否证明正式路径。使用新 `scope_sha256` 和审查记录，不能复制旧 passed 或自行扮演另一审查者。
4. `make verify-materials verify-delivery` 只证明材料/声明；全部行为命令绑定且独立审查通过后，`make verify-increment` 执行本包最终绑定，取得 `.local/delivery/I2-SEMANTIC-DELIVERY-REPAIRS-result.json`。成功后置 complete 再 `make verify-delivery` 核关闭；失败、超时或 Pi 仍只直工具层通过则保持 active，明确阻断。
5. 本包完成即停止。最终给出八项逐项结论、真正未验证层级、修改/删除范围和证据；不进入09、不提交推送、不更新日常服务，不因为本地合成协议通过宣称真实模型效果已验。
