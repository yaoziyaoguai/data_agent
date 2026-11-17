# 09 交付收尾根因审计与执行包复审

日期：2026-11-06。本轮审计上一位实施者的真实交付，并编制下一包；不改产品代码，不启动整套dogfood，不提交、推送或部署。入口为[执行包](../execution/semantic-runtime/dogfood-delivery-repairs.md)，当前状态只在[CURRENT](../CURRENT.md)维护。

## 1. 已核基线与证据限度

分支`codex/semantic-maintenance-prototype`，HEAD `04d27d06ba7b97d4cf3e288d4cf9e6300ef491a9`。上一轮scope的61份文件在本轮审计开始时全部SHA匹配。审计使用相对上一轮1041份实际接手文件快照的产品delta，不将全部未提交改动视作上一轮新增。

固定21核心为20 pass / 1 partial，J19未完成正式说明交付；获准调整来源前提的唯一续聊轨迹pass。A03正式用户报告pass，但两个自动通知失败，需独立修。100项与十轨迹没有全部通过，也不是本轮要求全跑。

本地复审覆盖：答案选择、原生Pi settle/恢复、工具候选与Rust最终提交/组合；结构DDL与entry依赖、历史来源读取；预填可见材料；当前消息草稿门；旧registered决定恢复；报告和结果卡轮询；来源目录排序与剩余维护错误路径。核对受影响测试的断言，不以测试数量和上一位passed代替业务判断。

本轮诊断目录：`.local/checks/dogfood-delivery-audit-20261106/`。主要文件为`observed-facts.json`、`delivery-probe.mjs`、`delivery-probe-result.json`、`delivery-code.txt`、`implementation-delta.patch`。

已运行本地诊断，退出码1，两个目标反例均RED：

- 真实Rust成功回执含通知原三元组及两个任务来源，实际Node `notificationAnswer`返回undefined。
- 实际Node/Pi通过回环协议得到完整自然`stop`，流式内容完整，但提交内容是控制摘要。

上述诊断外部请求0，不访问真实provider/数据库/页面。Rust行为依据原真实记录与源码，未来修复仍须真实Rust接缝验证。诊断中的`checkpointEdited`只作原始记录，不能用字符串搜索断言压缩检查点的投影行为。

## 2. 确认的问题与责任

### 2.1 正常完整解释被等待状态覆盖：高优先级

真实J19 attempt `J19-605987be-6865-4cee-9f14-b45f9dc98a59`，run `d670e5b6-bc18-4726-ac72-3bec3c156331`，274682ms后finished，5次模型调用settled。模型生成3001字五类业务说明；正式output `33715154-4482-49af-b877-3cce9d8ef938`和普通重开只有71字控制摘要。原七稿保持待确认且全部未执行。

Oracle要求核最终消息身份后，本地补读原生Pi文件，纠正了上一轮总结的证据遗漏：模型实际在条目`4f341120`发出`finalize_current_answer=true`，但该助手条目只有工具调用、没有正文，在登记前被Node以`answer_output_incomplete`拒绝；只查持久工具表看不到这次尝试。随后`0cb33f51`为3001字`stop`、无toolCall完整最终消息，其正文SHA与流式文本一致；`4e9a336b`直接把它context_edit为71字摘要。证据为本轮`J19-rejected-finalize.json`和`J19-native-entries.json`，不把模型“从未尝试定稿”当根因。

根因链：`apps/agent/session/deliver.ts`的`selectDelivery`在无grounded候选时取`workspace.control()` → `agent_before_settle`按这一选择投影 → `commitAnswer`优先control而非已完成自然final。两个恢复快路同样可能仅凭waiting控制状态完成提交。

上一轮让同任务也能显式`finalize_current_answer`，仅提供绕过入口，没有消除默认路径吞正文的问题。要求模型多记一条工具协议，不能修复已经正常完成的正文被宿主丢弃。

**归类：交付合同职责混淆与工程接线问题。** 不是MySQL/Milvus/Pi选型不适合，也没有证据表明靠换模型或加资源才能解决。Pi已生成完整答案；应用错误地把“查询还没执行”理解成“只能展示控制摘要”。

修复：完整原生final可作为解释交付，查询状态和执行权仍由Rust维护；控制摘要仅覆盖真正无完整正文的合法控制交付。同步恢复与Pi投影选择，删除强制同任务额外定稿指令。跨任务显式冻结、旧持久handoff和查询来源核验保留。

### 2.2 合法多任务来源被通知接入层误拒：高优先级

证据：上一轮`real-verification/A03-result-wake-failure-tools.json`。run `fd49e239-e9f2-43f9-b0ee-f3bf34d9f94f`中，两个`get_query`成功、两次`present_analysis_answer`返回200且有完整正文和实际sources，最终仍`answer_sources_required`。

本轮再从原生会话核两条通知事件及实际工具顺序：第一条绑定query `0ae1b8b9-9695-421f-9999-41724c19f364` / task `1f9ec73f-acb6-4f3d-84af-d7fd5b8e64bf` / condition 2；第二条绑定query `22bd2b9c-586b-43a5-8abd-d778e1c11664` / task `99a9a1e2-9793-4b3d-a8be-fc23b50f04d5` / condition 4。两条最后一次成功答案均包含自己原三元组及另一查询来源，之后只有正常stop，无使候选失效的新工具；两run最终failed。抽取证据为`A03-notification-bindings.json`，这是对两个通知各自的核对，不能把一个run里的两次成功工具当成两个通知。

根因链：`data-tools.ts`只在sources唯一task/version时设置`AnswerCandidate.taskRef` → `notificationAnswer`要求唯一taskRef等于通知任务 → 混合来源候选永远不满足。Rust `finish_run.rs`的单答案路径只要求sources中包含原query/task/condition，因此两端消费同一回执的含义不一致。

**归类：Node消费者内部模型过窄，属于接口语义和工程实现错误。** 不能诊断成模型漏来源，不能靠重发或额外补轮掩盖。

同因限制还在Rust `task_answers.rs::original_text_in_tx`和`compose_in_tx`：均要求全部来源task/version等于答案part owner。Oracle提出后，本地核对已有原工具`task_id/task_condition_version`、原通知查询绑定、`analysis_answers::check_in_tx`与scope检查，确认交付owner和来源集合可以分开，无需新业务能力或新表。

修复：增加宿主可选`DataToolOutcome.answer_task_ref`，表示原工具登记的候选归属；不能在通知run里把所有答案改绑通知任务。普通候选/冻结用原登记，实际通知单答案/末项用原通知query与scope，已冻结恢复用原handoff。Node不从sources唯一性反推归属。保全部source三元组，Rust单答案、冻结读取、组合整体覆盖及finish推进一起接线；删除“所有source必须等于owner”的错误限制。B冻结正文合法覆盖通知A时，不另造A正文，只处理实际交付owner与原通知条件，其他来源任务不自动结清。旧receipt只在可证明身份时补返回投影，原存储字节不改。不能用额外模型补轮要求单源回答掩盖接口问题。

### 2.3 来源整理失败仍缺足以归因的原始证据：需有限诊断

上一轮`source-boundaries-queue-terminal.json`列出13个来源状态，包含invalid_prefill、invalid_input、model_unknown和partial。它不代表全系统所有来源都失败。来源整理与对象预填分开判断。

`source_preparation.rs`现有记录只留粗错误码；`preparation/store.rs::fail_preparation_in_tx`清frozen_batch/pending_draft。当前没有原拒绝草稿，无法进一步确认是对象引用、revision、区间、Schema、模型输出还是接入问题。已证的缺口是诊断信息不足，不能声称所有失败根因已找到。

先找已有wire和冻结材料，能复原则离线validator重放。确无材料时只在原失败边界保留简洁stage/reason，不建观测平台，不默认持久完整提示/正文。仅有必要时以现有显式入口运行一个已知终态代表来源；issued/unknown保原身份和预留，不能重发。下一包写清诊断出口及停止条件，避免扩大成整库维护试验。

### 2.4 正文还有粒度说明冲突：效果验收不能只数保存字数

Oracle发现J19原文先说明入口按自身时间、可无完整会话，末尾却概括“五条都以合格轮次为基准”。本地核对`docs/sources/cockpit/documents/time-quality.md:13`已经明确入口例外，`metrics-analysis.md`也区分wake/session/turn日期；正文前半部分本身已采用该例外。因此不能把这项直接归为语义资料缺失，更不能据一句尾注宣布七稿SQL错误。

目前确认的是模型生成说明内部不一致。修后必须对照实际SQL和已读资料核解释；先不因此增加专用提示、判定模型或新校验规则。若新attempt仍出现，再据实际provider输入定位是否有一般性资料/提示冲突；没有证据不扩大范围，也不因正文成功持久化而判通过。

## 3. 漂移与四条规则核对

未找到应整体推倒的技术选型或大范围新增业务能力。上一轮以下修复有具体失败依据，应保留：

| 修改 | 核对结论 |
| --- | --- |
| 结构用途与显式知识引用分开，entry范围贯穿历史 | 有真实stale/撤权误伤依据；不能删成按最新版本直接放行 |
| 预填发送/引文/裁剪共用可见材料 | 解决模型实际可见而validator不认的片段；不是为理论场景加保护 |
| 当前消息草稿门与执行确认门分开 | 删除已证过度阻断；原执行授权保留 |
| 同v2旧registered命令方言恢复 | 已登记操作的真实兼容窗口，保持原身份；不扩展为新协议框架 |
| 报告与结果卡完成后单在途轮询 | 修实际撤权残留；没有证据要求重写UI/订阅框架 |
| 宽JSON目录先投影元数据再排序 | 原MySQL HY001明确复现；不需另建缓存或增加DB参数 |

需要删除的过度限制是“waiting/control一概压过正常final”“普通同任务说明必须额外显式定稿”以及“答案来源任务都必须等于交付任务”。一份part的交付归属、原条件和适用范围仍唯一，所有真实来源均需有权使用；后者不是“只允许单任务来源”。

不因为用户反感防御性编程而删除当前来源、版本、权限、已登记操作和unknown保护。没有证据的并发补偿、新容错层、额外分类模型和测试矩阵不进入执行包。

## 4. Oracle交叉审查

本轮使用`oracle-web`，配置身份沿doctor报告，最高5/5；只发送公开合成证据和项目源码，没有凭据、真实公司资料或私密对话。三轮串行：先核独立根因，再审合并执行包，最后仅核新增的原输出绑定接线及审包修订；不允许外部并行代理。

第一轮session为`dogfood-delivery-roots-1106`，18m42s正常完成，日志两次核`Power, item 5 of 5 (slider ARIA)`。答复保存于本轮`oracle-roots-answer.md`，会话地址仅在本地审计元数据；准确PID已退出，临时Profile副本已删除，证据为`oracle-roots-cleanup.json`。

| 外审意见 | 本地复核与处置 |
| --- | --- |
| 普通final不应靠额外route才能保存 | 与本地RED和Rust等待相位实现一致，采纳 |
| 需核3001字是否完整最终条目，不能累计所有delta | 原生条目stop/无工具/SHA已核，并发现此前遗漏的本地定稿拒绝；补入证据 |
| 需分别核两条通知原绑定及最后候选是否失效 | 两条各自通知/回执/末条顺序已核，采纳 |
| 混源同因限制还有冻结读取与组合末项 | 本地确认；初稿把来源唯一性误当单任务part合同，已纠正为交付归属与来源分责，覆盖相关消费者 |
| J19原文前后粒度说明冲突 | 核原正文确实存在；列修后语义验收，不因正文能保存就判业务pass；暂不据此宣称SQL也错 |
| 维护缺原响应不能凭usage猜因 | 采纳有限诊断；保unknown/partial，不扩整库重试 |
| 既有依赖/权限/恢复修复不应整体删除 | 与本地delta核对一致，不发起无依据清理重构 |

第二轮session为`dogfood-delivery-package-1106`，17m25s正常完成，最高5/5，答复`oracle-package-answer.md`，准确PID退出且临时Profile已删除，见`oracle-package-cleanup.json`。结论为`needs_revision`，没有把它改写为ready。逐项处置如下：

| 审包发现 | 本地核实及最终要求 |
| --- | --- |
| 删除恢复控制快路仍无法恢复已完成候选，可能多调用模型 | 核实`completedAssistant/completedTask`只有本次事件赋值，已消费toolResult不在pendingCalls。包第3.5节要求先恢复原有效候选，后决定是否派发RECOVERY_NOTICE，保结果不可用例外 |
| 自然末项原attempt与当前attempt不等，不能只删相等判断 | 已读runtime完整实现：原`attempt_chunks`核同output/会话/恢复链，`bound_output_text`核片段及SHA。组合直接复用原绑定；单自然提交目前缺承载位置，因此补可选`FinishRun.output_binding`复用已有类型，Pi custom entry只记录位置。此小接口补充进入定向复审 |
| 通知run全部候选改绑通知owner会再次破坏B冻结 | 采纳，包第4节区分原登记候选、实际通知交付目标、旧冻结归属；新字段不承担通知目标的替代标签 |
| 漏改Rust整体覆盖与有parts时的状态推进 | 核实`delivery_coverage_in_tx`/`compose_in_tx`要求owner覆盖，`finish_run`有parts时跳过通知分支。补这些消费者和两条有区分度接缝，不扩成状态矩阵 |
| 认为verify-delivery必须等真实核心通过 | 不采纳其事实判断。Makefile与check_delivery.py及本轮实测均证明active时只检查声明，真正执行绑定验收的是verify-increment。采纳其避免重复总gate的意图，在第6节明确两者职责和条件化顺序 |

第三轮session为`dogfood-delivery-closure-1106`，5m50s正常完成，最高5/5，结论为**ready（执行规格可实施）**。答复为`oracle-package-closure-answer.md`，输入SHA在`oracle-package-closure-inputs.json`，准确Chrome PID退出、临时Profile已删除，见`oracle-package-closure-cleanup.json`。它核定两处可选宿主字段有具体消费者需要，不建议为了少字段强行用单项answer_parts承载单自然输出；三种归属、Rust整体覆盖与finish推进、限定测试和gate顺序均可实施，没有提出新增阻断项。

本地最终又核了检查点发布位置：仅Pi本地落盘不足以更新Rust恢复leaf，现有范围刷新还要求成功context_reset。因此在包第3.5节明确利用现有finish准备阶段保存合法候选检查点，再进行原来源核验与正式原子提交；不伪造route、不新增保存端点，不用测试手工构造数据库检查点冒充产品恢复。这是对已送审“真实持久到可恢复leaf”的具体落点补充，第三轮未逐字审阅该后加段落；实施后仍必须以真实接缝证明。未据此新增第四轮咨询或扩大任务。

## 5. 执行与验收取舍

使用dev_co衔接原增量，diagnosing-bugs建立两个零真实调用反例，contract-first核对消费者需求与Rust既有合同。本轮只规划候选归属和原自然输出绑定两处宿主字段，复用既有类型；未修改wire Schema或产品代码，实现和合同验证交下一位实施者。SDK已提供custom entry及恢复分支，runtime已提供同链原片段读取，不增加Agent或恢复框架。

下一包按“自然正文 → 通知来源 → 有限维护诊断 → 受影响真实补验 → 限定独审/交付”连续执行。工程补在原测试接缝；主要真实补验是J19及结果通知，已有20项及轨迹按影响复用。100项/十轨迹继续后置，不新增累计测试费用审批。

预期调整必须显式记录：旧测试把“未显式定稿正文被全部覆盖”视为正确；新预期是正常完整正文保留、文本不改变查询执行状态。其依据是原用户解释需求、真实3001→71丢失和Rust已经单独维护等待相位，不能依据修改后的输出倒写验收。

最终本地复核覆盖：候选/通知/冻结归属一致、原输出绑定与旧请求兼容、正文覆盖与任务推进分责、各验证入口和停止条件、相对路径及产品未修改。`make verify-materials verify-delivery`通过：材料静态检查532项、声明与要求覆盖有效、检查器16项单测通过；`git diff --check`及本包相对链接检查通过。日志为本轮`materials-delivery-final.log`，自审记录为`local-package-checks.json`，最终文档身份见`final-documents.json`。61份前包scope复核中，仅本轮设计文档变化，产品/测试/合同文件未改。没有执行产品工程套件、真实产品模型或新业务验收；主09保持active、整体review pending、evidence null。编包通过不等于J19或通知已修。
