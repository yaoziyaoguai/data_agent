# Dogfood 报告修复与收口执行包

版本：2026-11-16，可用性审计后收口，已完成本地与 Oracle Power 5/5 交叉审包并按意见修订。本文替代 11 月 15 日的接续顺序；已完成工作不重做，历史失败与审查保留。唯一当前状态在 [CURRENT](../../CURRENT.md)，问题证据和本次审包取舍在[可用性审计](../../reviews/data-agent-readiness-audit-20261116.md)。本文是实施规格，不代表产品已修或真实验收已通过；Oracle 审查的是提交草稿，最终修订由本地逐项核对。

## 入口与边界

**启动必读：**项目 `AGENTS.md`、CURRENT 最新摘要和 `delivery.increment`、本文“入口与边界”“执行顺序”。**当前任务必读：**该任务章节、指向的源码及测试。完整历史、原始日志和设计仅在定位具体问题时展开；不从头读取 CURRENT 全部历史，不重开九阶段。

接手分支应为 `codex/local-trial-closure`，HEAD 接手值 `04d27d0`，重新核对后工作。所有命令在 AGENTS 指定的唯一仓库执行；保留累计未提交改动，不 reset、不维护第二份工作副本、不把累计 HEAD diff 当作本轮范围。先保存本轮待改文件的 before/after 与测试环境，沿既有 `.local/checks/`、`.local/dogfood-runs/` 存证，不新建审计平台。

目标是修正已证协议问题、收口有原始失败的稳定性问题、补当前核心能力及维护闭环，最后取得当前完整验收。以下约束始终有效：

- Pi 1.3.0 是唯一 Agent、工具循环、会话、压缩、恢复、重试和取消机制。Rust 保持权限、来源/版本、任务/结果归属、原 operation/origin/scope、费用和幂等责任。
- 正常新消息不恢复累计调用数、默认累计费用或总时长硬上限。连续 3 次临时失败停止、成功清零、不可重试错误、取消、单请求超时和端点容量仍有效；旧冻结 scope 不被改写。
- 本次 dogfood 原 100 元是显式试用总授权，非产品默认门。不得清账、清 unknown、换 trial、给旧操作换 scope 补额度、擅自互挪子帽或延期。当前没有新增收费授权；先完成无外发工作。
- 修一般原因；先写能复现问题的行为检查，再作最小修正。外部入口校验一次，内部传类型；保留新的权限/版本/状态变化所需校验。禁止额外 Agent、强制工具流水线、试题专用答案、通用保护层、无实际复用的简单 helper。
- 原 50 条验收、core_21、必过来源轨迹、100 项/10 轨迹完整分母、独立参考与原失败 attempt 均保留。只修有独立依据的错误测试前提，须记录原值、新值、证据、影响；不得删场景、放宽业务断言、换 mock 代替真实义务。
- 使用已安装 dev_co 承接；修复用 TDD；跨语言接口确有变化时用 contract-first，同源生成。只同步直接受影响文档和图，不重构全仓文档。
- 不升级模型/SDK/存储，不重做检索架构，不加生产认证、Datasight 接入、邀请、实时活动 UI。提交、推送、部署和日常服务更新另按用户授权。

**已完成且不得重新开工：**默认配置四类升级生命周期、数据库测试独立隔离、标题来源规范表示、模型真实停用与输入保留、P06 合法范围纠错及零泄露、当前 S01/S02/S03、P05/P07、产品 Skill 七步已有证据。代码/输入未受影响的证据可明确继承；思考回放修改影响的真实行为另作最小复验。P06 已有 `check-evidence-source.mjs:323–400` 的越界纠正、Unicode、同版分页、旧版/失权负控，不重复造同一测试。

## 执行顺序

| 顺序与章节 | 交付结果 | 依赖 / 停止边界 |
| --- | --- | --- |
| 一、协议回放 | 移除 ready 切换时删 thinking 的应用逻辑，实际 SDK 序列化验证 | 免费先做；付费 S08 放到三的授权门后 |
| 二、稳定性 | 两项首败完成定点诊断；有证据才修；Bridge 保留可定位故障点 | 历史原因仍未知时准确保留，不为“必须已修”制造改动；当前失败仍按原标准处理 |
| 三、核心补验 | 无外发步骤先补；授权后代表链、记忆和复杂口径、来源续接 | 一、二相关工程通过后开收费代表；失败先定位，不盲扩样 |
| 四、维护闭环 | 分片估计与实际收费上界分清，预留/结算同源，最小真实维护闭环 | 免费工程可在三等待授权时继续；启用收费维护须有效专项范围 |
| 五、交付收口 | 当前报告、独审、原 50 条完整验收、可启动交付说明 | 工程与业务证据分别给结论；未过不得关闭 I3/09 |

连续推进可执行工作，不在每个任务通过后等批准；授权不足只阻止相关外发。任务三、四的收费请求可以一次向用户列明，避免逐条打断。每个有意义的出口更新 CURRENT 的短状态与证据入口。实现命名用业务含义，顺序和用例编号不进入新函数、类、模块或测试名称。

## 一、修正 provider 思考内容回放

**根因与用户影响：**`task-projection.ts` 在同轮来源由未就绪变为就绪时删除前面 assistant 的全部 thinking 块，所有 provider 共用。工具调用仍保留，原 SessionManager 未改，但实际请求被改写。DeepSeek tools 回放要求原 `reasoning_content`；Claude 工具回合要求完整原 thinking/signature。空字符串不是已经产生的内容。当前是协议不一致已证，尚未证明它已经引起真实 HTTP 400；S08 一次成功也不能证明删除必要。

**必读入口：**`apps/agent/session/task-projection.ts` 的 `context_with_system`、`apps/agent/provider/configured.ts`、`apps/agent/tools/data-tools.ts` 的 `controlFacts`、`apps/agent/session/resources.ts`；`tests/runtime/check-request-context.mjs` 的同轮 route 测试；锁定 SDK 的 OpenAI completions 与 Anthropic 序列化。协议链接见审计报告。`.local/audits/data-agent-readiness-20261116/thinking-projection-probe.json` 是零网络复现，不是 provider 拒绝证明。

1. **先纠正测试依据并取得 RED：**用真实 Pi/provider 序列化接缝，在来源未就绪→工具 route→同轮就绪后断言先前非空 reasoning、tool call ID、tool result 完整对应。删除“旧 thinking 必须消失 / reasoning_content 必须等于空串”的错误期待。只改这项协议预期，不降低来源门与上下文隔离。记录公开协议、改前失败、改后通过。
2. **删除错误职责：**移除为删除 thinking 而引入的查找/状态/过滤分支；只删除因该处理废弃的变量。保留技能段投影、当前宿主事实、工具可见性、来源未决限制、context_reset、权限撤回与恢复，以及隐藏期的 `session_before_compact` 保护。不能把原隐藏投影整个撤掉，也不能把 SDK 历史/压缩替换成全量永久透传；保真针对准入后可发送的合法工具回合，不放回失权资料。
3. **让最新事实生效：**保持 route 成功回执与当前宿主参考中的 ready 同源，保留合法工具集。重复执行说明可以在这条已触及路径收为一处通用规则；不新增题目模板、不强制 tool_choice、不自动替模型执行 SQL。
4. **实际第二协议：**除默认 DeepSeek 外，复用项目已有已支持 provider 接缝，至少核一个不同协议；优先 Anthropic thinking/signature 工具回合。要求真实 SDK 转换后的请求证据，不能只给同一对象改 provider 标签。不为此新增模型服务或付费。缺少可运行接缝时如实保缺口，不冒 pass。
5. **边界回归：**来源未决/成功解锁/错误 ready/待 reset/已 reset、重启恢复和现有权限负控继续通过。保 Pi 原生 compaction/retry/abort；不把合成服务的正确回放冒充真实模型效果。

**检查：**`node tests/runtime/check-request-context.mjs`、`node tests/runtime/check-configured-provider.mjs`、`node tests/runtime/check-request-policy.mjs`，以及现有来源/恢复绑定中实际受影响的命令。若新增第二协议用例，优先放进前两条已有入口，使原验收绑定确实执行它。

**出口：**删逻辑的 before/after、两协议原生请求证据、原权限及恢复回归零失败；真实 S08 和来源续接仍在三记录，不先宣布效果恢复。

## 二、收口稳定性和异常诊断

### 准备租约负例的锁等待

**已知：**48 条非成绩门的 `#06 CORE09-PREPARATION-LEASE` 首次运行中，正常准备、过期拒绝已过；错误 owner 负例 `renew_claim` 等待约 49.5 秒后锁超时，预期 `lease_lost`。实际锁持有者未记录，不能宣称是 Defender、正常心跳坏了或已经修好。

**入口：**`crates/data-agent/tests/tool_contract_version.rs` 两个 `delivery_preparation_*`、`modules/jobs/store.rs::renew_claim`、`use_cases/deliver_run.rs`；原日志 `.local/delivery/non-scoreboard-48-logs/06-CORE09-PREPARATION-LEASE-attempt1.log`。

- 先核同场景事务、取消/失败的释放路径，复用原隔离库。仅定点重现；在原测试诊断接缝记录 DB 时间、job/owner/epoch、持有与释放时点、阻塞者及等待 SQL 类别，不打印参数/凭据。检查 `innodb_trx` / 可用锁等待视图前核本机权限，禁止给生产加轮询。
- 若证实 fixture 持锁未释放，修测试资源生命周期；若生产事务或 select 退出留下问题，只修原 owner/组合路径。先保存可判别证据再选修法，不预先加重试、锁管理框架或拉长产品 TTL。
- 保持等待超过 TTL 仍有效、attempt 不增加、错误 owner/旧 epoch/真正过期必拒、原身份不变。环境单次往返已超过原测试前提时留准确实测阻塞，不能修改通过标准。

### 固定睡眠后领取为空

**已知：**`#46 CONTRACT-RECOVERY-SUITE` 首败在延后 200ms 后固定睡眠 250ms，`claim_due` 得到 None。时序前提脆弱已见，具体一次失败的时钟/锁原因未记录。

**最小修复：**在原 fixture 依据数据库实际到期/可领取状态作有界等待，首次有效领取后核同一 job/cid/message，严格保留 `lease_epoch == initial_job.lease_epoch + 1`、`attempts == 0`、原合同版本及后续超 TTL 行为断言；后续替换领取的独立 epoch/attempt 断言也保持。等待位置在被测 TTL 计时之前，首次成功后不再领取或重启整个场景，不能改变生产延后。超时仍真实失败并输出所等状态，不改成任意 Some 即通过。#06 历史锁持有者最终仍未知时，保存诊断范围及当前验证结果；原因未知本身不新增验收门，当前完整检查再失败则仍须定位，不能反写历史为已修。

**本节检查：**先 `node tests/mvp/check-tool-contract-version.mjs --filter=delivery_preparation_ --label=lease-preparation-audit`，再无 filter `node tests/mvp/check-tool-contract-version.mjs --label=contract-recovery-closure`，保原完整 7 项及组合顺序。保留两项首败，不把第二次 exit 0 写成首次无失败。相同原因未改时停止重跑并换诊断假设。

### Bridge 的一次未定位异常

**已知：**P06-02 epoch1 中断、epoch2 完成；原日志仅有 `unexpected_error / error_kind=Error / reason=other`。已证诊断缺口，不足以认定原异常原因。原轨迹为 `.local/dogfood-runs/qa-repair-20261115T065901Z/attempts/P06-02/`，运行日志在 `.local/dogfood-runs/qa-20261114T010142Z/runtime/`。

**入口：**`apps/agent/transport/server.ts` 的 catch、现有 `client.ts` 错误分类、`deliver.ts` 生命周期及 `tests/runtime/check-bridge.mjs`（由 configured-provider 检查接入）。先核保存的关联轨迹；若仍不足，在现有单一错误边界保留安全的失败阶段/错误类别/稳定调用点。沿真实 throw 路径实现，不为每层加 try/catch，也不把任意 Error.message/stack、请求或资料正文回显给用户/日志。不得新建日志平台或新增自动重试。

**验收：**本地已知普通 Error 的注入能定位到实际阶段，受控错误码保持；秘密/资料哨兵不进入日志或响应，失败不被写成 finished。由 `check-configured-provider` 的真实 Bridge 接缝覆盖。原 P06 历史原因若无法还原，仍写 unknown；最小诊断修复可以完成，不能为它无限重跑付费 P06。后续代表链若再次发生，必须沿新证据定位而非靠恢复掩盖。

## 三、补核心能力，先免费再收费

**当前证据：**截至本包入口，100 项是 18 pass / 1 partial / 1 blocked_authorization / 80 not_run，10 轨迹是 1 partial / 9 not_run。grader 只验记录和引用，不判业务语义。core_21 为 8 pass、13 not_run；P02/G01 的资料或合成权限证明按适用义务使用，不强行制造真实模型样本。

**入口：**`docs/dogfood/cockpit/{scenarios.json,GRADING.md,OPERATIONS.md,integrated-trajectories.json}`、[原 QA 方案](dogfood-qa.md)、原报告 `qa-repair-20261115T065901Z/`。原已批准补充提问（含 J06/J19）从 CURRENT/对应记录查原文，不自行追加诱导答案。修复后的原题产生新 attempt，保留旧失败及来源；新报告目录不等于新 trial。

### 无外发工作

| 未完项 | 应补证据 | 成本边界 |
| --- | --- | --- |
| P01 | 正常身份入口、角色可见/不可见及恢复导航 | 无需模型 |
| A14 | 复用产品已生成 Skill，公私独立副本、维护/选用边界，逐断言映射原七步 | 需要实际选用的步骤按现有证据或后续授权，不为 UI 标签假定全免费 |
| A15 | 选中方法附件、权限/版本/恢复后可读；必须另证模型真实读取并采用正文 | UI/隔离可以免费；模型采用不能用 descriptor/路径代替 |
| G03 | 接受纠错建议尚未生效，负责人核对编辑并保存才生效 | 手工操作可以先做；保存可能触发外部整理/索引，须禁外发或有相应授权，不冒充完整新索引通过 |
| G08 | 用已有查询/报告核平台读取权和语义维护权互不授予；撤回后原结果读取按合同拒绝 | 复用现有产物，无需为权限断言新取数 |

先逐断言核证据有效性，再补缺失交互；服务若已停，先做离线核证及隔离无外发工程，不能拿读报告替代浏览器实际操作。必要试用服务沿原隔离数据库/账本恢复且所有收费派发保持关闭，避免自动跑到期任务；不更新日常服务。

### 收费授权检查点

11 月 16 日快照仅供核对：原总 100 元保守占用 78.449600 元，名义余 21.550400 元；chat 可用 2.764856 元，小于下一最坏预留约 2.789152 元；maintenance/embedding 原期限已到；三笔聊天 unknown 与一笔 embedding unknown 保留。实际开跑必须重读各原 trial/scope/operation、有效期和在途状态，不用此静态数值授权。

免费工作完成并列清样本/通道后，请用户明确是否在**原总额剩余范围内重新分配子帽及更新有效期**，说明 chat、维护模型、embedding、Mem0 的实际收费归属、预计次数、保守预留与停止条件。不先要求新 100 元，也不擅自延长。若总额不足再请求具体追加；批准前不发官方请求。一次新的收费范围批准不允许抹掉旧 unknown 或以新身份重做已接收操作。

### 有效授权后顺序

1. **代表链：**一条原 S08 从原话草稿→明确执行→平台恰好提交一次→原 Pi 结果解释→刷新后数值/依据保持。保原 cloud 242/263、edge 144/161 等独立参考对应条件，不把这些数写进模型提示。另以必过 `time-and-definition-continuation` 的相关片段覆盖来源/多任务续接，复用其余有效片段；不用另造一组同义题。
2. **复杂口径：**J01 候选关联不放大分母，J06 首次/最终成功，J19 NULL/零耗时/合法跳阶段，A03 跨条件来源组合。由产品交互完成原题，核实际 SQL/结果/解释；外部 coding agent 不可直接取数代替 Agent 能力。
3. **记忆与剩余采用：**A09 修订、A10 遗忘、A11 跨用户隔离、A12 近义召回，及上表尚缺的 A14/A15 模型采用；沿现有真实 Mem0 和 Pi Skill，不加记忆编排。`personal-memory-and-skills` 已有 Skill 断言，补缺失记忆片段，不重做七步。
4. **原消息断点：**T02 拆分 pass 证明第三句局部日期分离，不证明原第二句已恢复。先读原 message/receipt 和待澄清状态；已接收的不重发、不换 ID、scope；按现有失败/恢复合同查证。若旧调用 unknown 无回执或必须由用户补充，明确记录对应消息缺口，不造“自动补跑所有失败消息”功能。该部分不能冒充 T02 已完成的拆分断言，也不倒改原 pass。
5. **逐轨迹核费和留失败：**完成一次轨迹就核所有实际收费通道。代表失败暂停依赖它的收费链，先按请求/召回/材料交付/工具/平台/答案分层定位；独立免费工作继续。修一般原因后有针对性复验，禁止盲试同题直到过。

**报告标准：**原 21 项与 `time-and-definition-continuation` 不缩减；100/10 保完整状态，不要求 100/100。P04 原问题未明问系统内部会话，本次缺显式对照保 partial，非 core_21、不追加系统硬编码；G09 部分越界已拒、后段授权阻塞如实保持，不将非核心变成新的全部完成门。映射已有通过证据须写代码/输入/依赖有效性，不能只复制结论。

## 四、解除语义维护的具体阻塞

**当前问题：**`--prefill disabled` 仍关闭真实自动整理/预填。公开 tokenizer/template 的本地计数不能证明托管 API 输入计费上界；也不以证明供应商私有模板逐 token 相同为无限前置。分片质量、服务接受容量、计费预留是不同责任。

**入口：**`modules/ingestion/prefill.rs::prepare_submission`、`prefill/input_tokens.rs`、`resources/deepseek/README.md`；`modules/runtime/model_calls/{mod.rs,store.rs}` 的 maintenance reserve/settle；`use_cases/{source_preparation,semantic_prefill}.rs`；`tests/mvp/check-prefill-materials.mjs` 的现有完整材料/field-evidence、整理和共享 embedding 检查。

1. **先定义适用事实：**核实际 endpoint、冻结型号/思考协议、输入/上下文和输出上限、最高适用单价及计费口径，给公开一手依据和单位。不要把 profile 中本地 `input_limit` 自称服务端强制输入上限；也不能把上下文窗口盲减 max output 当已证输入计费上界。依赖外部限制的结论标明适用型号/版本。
2. **最小可实施方案：**继续用公开 BPE 和原分批作准备估计；在原 maintenance owner 内用有依据的服务输入上界、同次实际输出 cap 与最高适用价格作显式试用预留，实际 usage 结算。若服务仅公布总上下文上界，用保守且有据的输入上界，不臆测更紧公式。优先复用现有冻结 profile/容量信息；确需传一个独立计费上界时沿原准备→reserve→settle 链传明确类型，不借此建通用 token/预算服务。
3. **同次调用的事实一致：**一致指调用身份、单位与约束，**不是本地估计必须等于服务收费上界**。`reserve_maintenance_in_tx` 当前按 profile.input_limit，settle 也拿它判断输入越界，不能只改预留数而让正常 usage 被错误标 breached。准备、预留、派发、结算都绑定原 trial、型号/价格身份、有据服务输入上界和实际输出 cap；在原协议替身截获派发 JSON，核真实输出限制及计费口径。先查原调用已有的不可变 profile 关联或充分快照，足够就复用；结算不能回退到当前选择的 profile。仅在现有记录确实不足时加最少字段/迁移，不复制模型配置体系。旧 issued 沿原冻结配置和既有恢复/结算规则，缺少新字段不得填当前新上界冒充历史；旧 unknown 保留原身份、状态、占用，不因迁移重发、释放或新增解账能力。不修改既有 trial 指纹蒙混换配置。
4. **先免费证实：**保留此前两类“字节合法但超过旧预留”的反例，完整 system/schema/草稿/supports 装配、中文/长 SQL/首中尾/人工值和引用质量仍过。协议替身覆盖“实际用量高于本地估计但在有据上界内”、超界、超输出、usage 缺失以及旧 issued/unknown 兼容；已有证据足够时复用。**有效 usage 已知但超界时，须经实际 owner 返回后读取已提交数据库：真实费用入账、仅本调用预留释放、call settled、trial breached，后续 reserve 拒绝；不能只断言 budget_exhausted。**本地已核 `semantic_prefill.rs:121–125、231–235` 与 `source_preparation.rs:341–343、374–376` 已先 commit 再处理 settled 错误；保留这些出口，按实际缺失补行为证据，不把它预判成新产品问题或再造事务。usage 缺失仍走原 unknown 占用，不能伪造费用或释放。替身证明接线，服务上界另需独立依据；不能缩小正常上下文或删除大材料过测试。
5. **有授权后最小真链：**一份批准合成来源新增→整理→正式采纳/保存→异步索引→检索回源；修改同一来源后再核新版本与原人工值保护。手动同步入口、只存最新来源及按变更整理保持，不全量重建或新增定时同步。模型和 embedding 通道均须有效；真实一次成功不证明所有输入硬上界。

**出口：**服务上界证据、同次预算/派发/结算测试、代表材料质量与一条真实维护闭环。没有适用上界或未获授权，明确仅维护收费通道未开放，交付表述为“已有资料可分析”；工程先完成到该边界。V3.2 注释与已固定资产版本不一致可顺手修，禁止借此升级资产或新增分词框架。

## 五、最终交付与服务边界

1. **收报告：**新聚合仍列完整 100/10，每条区分新跑/继承/部分/未跑/授权阻塞，保原失败和 unknown。S08 原理修复、两首败、Bridge 历史原因、维护、core_21/来源轨迹逐项给证据，不能一句“48 绿”代替。按既有 grade.py 和独立人工语义复核核对。
2. **更新文档：**只更新 CURRENT 短摘要、README 当前可用/不可用和启动边界、受影响契约/图；正常运行政策、显式试用预算分开。若仅修错误或测试，不重画架构。fixture EOF 空行可以小修；改字节则刷新相应 manifest，不能靠统一重生成掩盖测试资料变化。
3. **有效验证环境：**用仓库 Node 26.8.1、锁定依赖和原 Docker context；MySQL harness 串行。免费检查在清真实 provider 环境的子 shell 执行。Rust 改后先重建 API/Worker 再跑相关 E2E，未改不反复重建；未知二进制来源先核指纹。现有生成和验证命令见下表。
4. **独立实现审查：**冻结本轮 before/after、合同/测试/报告；由未负责实现者核对协议、权限、原身份、有限范围、测试依据与实证。用 `scripts/check_delivery.py` 既有 JSON 格式及当前 scope_sha256，不能由实施者冒签、复制旧 passed 或把本次 Oracle 审包当实现独审。
5. **完整出口：**保持 CURRENT 原 50 条 expected、requirements、核心列表与超时值。新聚合文件存在后才能更新前两条报告路径；映射新增断言到原检查入口，必要新增独立检查也不得删旧义务。审查/绑定全部确定且必过业务证据齐备后串行 `make verify-delivery`、`make verify-increment`。后者自身带 complete 逻辑，不使用 `make verify-increment --complete`。已知必过成绩缺证据时先交付工程结果和具体缺口，不反复运行注定在成绩门失败的全流程；这不豁免最终完整50条。运行期间不改被冻结文件。失败先定位，不用两次自动重跑的最终绿遮住首败，不扩大 timeout 求绿。
6. **完成判定：**分别报告工程完成、真实核心能力、维护可用、I3/09 完成状态。验收失败/授权缺口时保持 active，具体列出未完成义务；不删除对应入口绕过失败。只有完整当前收据和审查匹配才关闭增量。
7. **本地使用交付：**本包交付正确启动命令、所需模式/端口/版本清单及未开通通道，不自行更新日常服务。用户授权后，在同一版本确认 Web/API/Worker/Pi/索引/记忆/资料，再从页面作一条已验证普通查询冒烟并刷新核持久结果。合成平台本地试用不等于 Datasight、生产认证或真实公司数据已接通。

| 变更范围 | 使用原有命令 |
| --- | --- |
| Schema 实际变化 | `npm run contracts:generate`、`npm run contracts:check`、`make verify-contracts` |
| Rust 实际变化 | `cargo build --offline --locked -p data-agent-api -p data-agent-worker` 后运行受影响 harness |
| 通用工程出口 | `make verify-contracts verify-code verify-architecture` |
| 维护材料 / 预算 / 索引 | `node tests/mvp/check-prefill-materials.mjs`、`node tests/mvp/check-shared-embedding.mjs`；原 field-evidence/source/document-preparation 模式从 Makefile/CURRENT 取，不臆造选项 |
| 两项成绩 | 沿 CURRENT 前两条 grade.py 命令，保 require-pass 原列表，只在真实新报告就绪后替换报告路径 |
| 最终声明 / 实际验收 | `make verify-delivery`、`make verify-increment` |

## 单列候选：在对话里显示实时执行活动

这是用户 2026-11-16 的可行性询问，**不加入本包修复验收或实施授权**。目前正文增量和查询状态可显示，Workbench 只有“正在处理/生成回答/解读结果”的粗提示；活跃 snapshot 约 700ms 刷新。Pi 1.3.0 已有 `tool_execution_start/update/end`，deliver 只消费结束事件做容量/答案处理，尚未连成面向用户的活动列表。

推荐后续范围：复用 Pi 原生事件、Rust 已有会话归属/事件与状态读取、Workbench 刷新，展示真实的检索、补读、查询提交/等待/结果等可折叠活动。活动仅作展示，不驱动业务、不成为第二套任务状态机。工具返回不等于平台查询完成，后者由现有 QueryCard/平台状态确认；不新增 WebSocket/日志平台，不额外调用模型生成播报，不展示内部 thinking、原始参数或整份工具结果，不伪造百分比。当前问题修复与它独立，后续用户确认后再细化契约/UI验收。
