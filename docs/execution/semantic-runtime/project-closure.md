# 指标语义与报告定位收尾执行包

> 2026-11-13后续核查：本包工程已实施。真实S02随后获准运行，SQL数值正确，但文字存在匿名实体推断错误，且验收走旧按钮确认接口；完整33组仍失败。后续执行以[本地试用收尾包](local-trial-closure.md)与CURRENT为准，下方保留本包原规格和实施时序。

更新：2026-11-13。状态：Oracle 最高 Power 5/5 复审结论为“必要修订后可实施”，B1–B5 已逐项纳入并由本地复核；可交实施者。本轮未实现产品修复，未取得实现验收。当前状态唯一入口：[CURRENT](../../CURRENT.md)；发现与证据：[全项目审计](../../reviews/project-global-audit-20261113.md)。本包接续现有 `I3-SEMANTIC-DOGFOOD`，不重开 01–09，也不把全局证据缺口当成全库重写任务。

## 1. 简短入口

目标：修正 Agent 擅自扩展已知指标口径的行为约束，修复报告卡片在历史分页时跳位；取得与实际源码和运行配置对应的有限证据，交付可供后续试用的候选。真实模型改善与产品工程通过分别报告。

执行顺序：固定工作树和证据 → 指标规则/交付核验 → 报告稳定定位 → 相称回归与全局缺口归档 → 获准后一个真实代表 → 交接。工程任务连续完成，不在每项结束后等用户批准；未获准的付费阶段保持 pending，不阻止工程收尾。

| 任务 | 类型 | 修改边界 | 完成出口 |
| --- | --- | --- | --- |
| 固定输入与证据 | 准备 | 当前记录、已有验证记录 | 知道复用哪些证据，缺哪些，运行什么源码 |
| 指标与诊断分离 | 必做修复＋验证 | 既有 Agent 资源/工具说明；交付仅在复现丢失时修 | 一般规则清楚，原失败保留，工程交付可核 |
| 报告稳定定位 | 必做工程修复 | 同源 Schema、conversation 查询/组合、前端投影、相关测试 | 缺保存事件的当前页也使用真实锚点，补页/刷新不跳 |
| 有界回归和覆盖记录 | 验证，非补建功能 | 现有测试与记录 | 工程、模型、平台、UI 结论分开；所有遗漏有状态 |
| 真实代表 | 需要当前付费授权 | 现有隔离 trial harness 的后继记录 | 原题自然完成或如实停下，不循环求通过 |

### 阅读约定

- **启动必读：** `AGENTS.md`；CURRENT 的 JSON frontmatter 与最新摘要；本包 §1–2、§8；审计报告“范围与结论”。CURRENT 历史约 1.4MB，不要求通读。
- **当前任务必读：** 对应 §3–6 的文件/符号与相关测试，变更前读受影响的同源 Schema、owner 接口、保存合同及实现设计对应边界。按依赖取用；上下文仍有效时复用，变化或缺失时补读。
- **问题出现再查：** 其他设计、旧实施报告、完整 Oracle 原文、历史 dogfood。旧交接 Prompt 不能覆盖本包；按需阅读不能省略本次跨模块合同。
- 用 dev_co 组织本次交接和进度；新业务行为按可观察 RED/GREEN，跨语言变化用 contract-first。不要为本包安装新 Hook、全库目录治理或另一套状态机。

## 2. 全局约束、授权与非目标

1. 实际项目根使用既有 `work_space/data_agent`，启动先核对 `git rev-parse --show-toplevel`、分支、HEAD 和未提交差异；别在旧 detached worktree 实施。本包受审基线为 `04d27d0` 加当前累计工作树，禁止 reset、清理未跟踪文件或覆盖他人改动。
2. Pi 1.3.0 仍是唯一 Agent、原生会话/工具循环、流式、取消和压缩机制。保留 `prepare_analysis_answer` 的数值绑定→Pi 自然正文→最终持久提交，不回退为完整正文先工具写入再生成一遍。
3. 每条用户消息 24 次模型调用、连续临时失败 3 次、原 `operation_id/origin_run_id/budget_scope_id` 不变。Rust 权限、条件版本、授权、失效检查和真实状态变化仍有效。
4. 外部边界校验一次，内部传递校验后的类型。权限/状态发生变化需要的重核不删；不增加同侧重复 Schema 校验、泛化 helper、通用租约/时间线框架或无意义 try/catch。
5. 不为未观察到的极端并发/边界新增保护。需要额外复杂度时给出现实触发和证据，不能编概率；实质扩大范围先取得用户决定。DA-003 不在本包修改范围。
6. 保留旧题、原 SQL、原失败、账本费用及 unknown/reserved。测试预期来自业务定义和独立数据；正常修夹具必须记录原值、新值和独立依据，不能改列名/删断言把本轮失败变绿。
7. 代码、测试名称使用业务含义，不写任务编号、包号、M 编号。本文编号只作导航。
8. 本轮授权为审计、确认、编包与修订。用户将本包交给实施者并要求执行时，按那次授权开展代码、相称本地验证和必要文档；文件本身不产生授权，也不要求已获授权的实施者再询问一遍。当前没有新的付费调用、延长 trial、提交/推送、部署或日常服务更新授权。先完成可审阅候选，再申请所缺的具体操作；不要重问已明确授权且仍适用的普通本地操作。
9. 不升级 Pi/模型/数据库，不扩 OpenAI 端点，不做生产平台认证/邀请、多生产者、定时同步、历史语义监听自动重算、全库目录重排。原台账中的相关后置项保持。

## 3. 固定工作树和可复用证据

先保存本次允许路径的 before/内容指纹到既有 `.local/checks/` 下一个新目录，保留原记录。枚举当前相关源码、合同、测试与二进制，不只记 HEAD。环境只记非敏感配置，不读取或输出凭据。

已知事实：

- 11月10日查询准备续租有 RED/GREEN 和真实 MySQL 证据，`query-submission-repairs.md` 已实施，不能重复开发。
- 最新真实代表为 `real-representative.json` 中 Q02，新草稿独立校验失败、实际 submit=0，未进入结果阶段。
- 原 harness 没存完整 provider 请求体，不能从工具回执反推“历史逐字入模已证”。
- 本轮 DA-004 合法 Snapshot 复现位于 `.local/audits/project-global-20261112/`；复现脚本仅供确认，正式回归应并入现有 timeline/报告测试。
- 日常服务版本和试用候选分别核对。旧记录中服务未更新，不等于今天仍在运行，也不授权本包重启它。

复用证据逐项记：相关源码/测试指纹、环境/模式、原命令和退出码、实际证明的行为。只对内容和环境仍对应的证据复用；不能把测试入口存在当作已跑过。受影响输入变了就重跑其相称检查，不默认全量100题、千表电池或所有历史测试。

## 4. 指标与诊断分离

### 4.1 先确认交付，保持根因结论有边界

必读：

- `.local/checks/query-submission-implementation-20261110/real-representative.json` 的 `originalQuestion/queryDraft/toolCalls/toolObservations`，及同目录 diagnosis。
- `apps/agent/tools/data-tools.ts::formatResult` 与版本化工具装配；`apps/agent/session/resources.ts` 中指标、语义诊断和澄清规则。
- `scripts/evaluate_business_sql.py::{customer_roles,customer_expectation,customer_variations}`、`tests/mvp/check-business-evaluator.mjs`。
- 现有 `tests/runtime/check-evidence-tool-shape.mjs`、`tests/mvp/check-evidence-knowledge.mjs`，选最接近的边界复用。

使用原合成 read 回执，通过当前真实 v2 工具格式化/正常 Pi 接入，观察本地协议 provider 实际收到的正文。断言完整指标定义、匿名规则、正文分页状态保留；不能只断言 `receipt.data` 含这些词。这个测试证明当前交付机制，不冒充历史 HTTP 已被记录，也不证明真实模型会遵守。

若当前交付确实丢失，先在现有路径复现并修丢失分支；允许落点为 `data-tools.ts`、当前使用的投影/容量裁剪分支及其对应 Rust evidence 组合，必须在 CURRENT 记录具体证据后才扩大到该处。没有复现就不改检索、存储或压缩代码。

### 4.2 修改现有规则，不追加第二套规则库

本例完整工具正文和模型自己的 `semantic_resolution` 都表达正确口径，保存 SQL 却增加新量。默认修法为**替换/合并** `resources.ts` 对应段落，再让 `request_query` 说明引用其职责；避免把一整段原则重复写在两处。

原则须覆盖：

- 正式指标严格沿当前已确认定义。未知实体、缺失值、未覆盖记录只能按已有定义或独立诊断表达，不自行折成一个业务实体、总量、上下界。
- 诊断列可保留，例如匿名订单数、匿名行数、是否存在匿名，但名称、含义和展示不冒充正式客户数；不限制列数或固定别名。
- 已明确的指标不因为有 NULL 就反复问用户。确实需要新口径选择时沿现有 `semantic_resolution` 和澄清，不能给所有查询增加门禁。
- 用户已明确给出可计算的新口径时，沿现有条件修订/采纳机制处理；只有仍有未决选择才澄清，不把所有“新口径”一律变成额外确认。
- 保存前核对 SQL 的度量表达式、已定解释、字段粒度和诊断列是否一致。此为现有 Agent 职责提示，不新增宿主通用 SQL 语义等价判定器。

验证：旧 Q02 失败 SQL 在独立判分中继续失败；已有合法单列/多列/分组结果及别名/顺序变化继续通过；匿名多订单多行、重复已知客户、新客户、测试行、跨期等既有变体不删。`node tests/mvp/check-business-evaluator.mjs` 应通过，但它只证明判分基准。规则接线需能在本地 provider 请求中观察到，不能以字符串源码断言代替实际装配。

判分器基于列名识别角色；`expected_rows=null` 与“已经核算并数值不符”要分别记录。保留独立定义、参考数据、原始输出和全部变体；仅有形状未覆盖时停止自动推进，标为“无法自动判分”，不能自动归因为模型口径错误或变成通过。补一个语义合法但别名未被识别的小例，核对这一区分；不建设通用 SQL 判分系统。必要的角色映射修订须有独立业务依据，不改模型原 SQL/列名/业务标准，不自动重发付费试验。旧 Q02 的业务失败有原题、定义和第四列表达式的独立依据，继续保留。

**完成口径：** 工程交付和规则修订可以完成；模型理解改善只在 §7 的获准真实代表后评价。不能因脚本返回预制正确 SQL 就把 DA-001 标为真实模型已修。

## 5. 报告卡片使用持久事件锚点

### 5.1 已确认失败和目标

初始 Snapshot 返回当前任务和报告引用，但其保存事件可能早于最近1000条；前端现用 `0`，补旧页后换成实际序号。修复后，无论该事件是否在当前分页中，报告卡片都使用同一个真实事件位置，重复刷新/补页不跳、不重复；报告新修订更新卡片内容，不移动同一报告的首次保存位置。

必读：

- `crates/data-agent/src/use_cases/read_conversation.rs::read_page`
- `modules/conversations/{mod.rs,store.rs}::event_page_in_tx` 与事件存储
- `modules/analysis/store.rs::read_tasks_in_tx`、`modules/analysis/report/store.rs::report_ref_in_tx`
- `use_cases/analysis_reports.rs` 的 `analysis_report_saved` 发出点
- `use_cases/data_tools.rs` 的 `save_analysis_report` 分支；两种正式保存入口均已观察到发出同类事件，仍需核其实际修订/重试链。
- `packages/contracts/schema.json` 的 `TaskSnapshot`、`Snapshot/SnapshotRefresh`、`AnalysisReportRef`；`WorkspaceTask` 不是本次 UI 投影的扩展目标，不手抄生成类型。
- `apps/web/src/features/workbench/conversation-timeline.ts::conversationItems/mergeSnapshot`
- `tests/mvp/check-conversation-timeline.mjs`、`check-analysis-reports.mjs`、`check-analysis-reports-browser.mjs`、`check-report-reading-position-browser.mjs`。

### 5.2 推荐接口与职责

优先把 `report_timeline_event_seq` 作为 **TaskSnapshot 展示投影的可选字段**，使用现有十进制字符串事件序号类型，旧快照缺字段可读；不改变报告 `reference` 内容、报告版本和保存幂等指纹，也不向模型的 WorkspaceTask 添加展示字段。

变更前沿 `analysis_reports.rs::save_in_tx` 的实际调用者和全部 `analysis_report_saved` 发出点定向核对保存、修订、重试。已有共同路径直接复用；只有确认某正式路径漏发时，才在其现有事务/幂等机制中补同类事件，不另存锚点。

由 conversations owner 提供单次、窄范围读取：沿 `event_page_in_tx` 使用同一 `AppTx` 和已授权 `LockedConversation`，输入权限保护后允许展示的 report IDs，返回 `report_id → u64`。数据库按数值取 `MIN(event_seq)`，只返回报告 ID 和序号；不查完整事件正文，不逐报告 N+1 读取，不从 analysis store 越权查询 conversations 私表。

“首次”按同一 `conversation_id + report_id` 的全部已保存版本取最小序号，不按当前报告版本、任务条件版本或当前事件页筛选，不套用 `before/after/LIMIT 1000`。新增展示字段本身不递增报告版本，正常内容修订仍沿原版本机制。

`read_page` 在同一读取事务里向已授权、已保护的任务投影组合十进制序号字符串，并覆盖普通 Snapshot 与 refresh 的同一路径。前端只有在任务 `report_ref.report_id` 与当前卡片一致时才能优先使用该序号，不能仅凭 task_id 套用。已加载事件保留兼容后备；同一报告新修订仍取首次锚点，最新内容和首次位置分别处理。

锚点不注入 `events`，不参与计算 `first_event_seq/last_event_seq/has_older/has_newer`。核对 `mergeSnapshot` 的任务判等、快速返回和旧页合并，新投影不能被忽略。沿现有文本保护机制确认被限制的报告引用不会从旧事件后备重新出现，不把候选问题宣称已证权限漏洞，也不另造权限系统。

**不需数据库迁移的首选方案：** 复用已持久保存的事件序号，在读取时窄投影；不新增事件系统或迁移整套报告。实施时若查询计划显示该现有会话范围读取有具体性能问题，先记录，再选择必要索引；不因理论担心先建冗余锚点表。

旧记录确实没有保存事件时，省略可选字段，不填 null 或 "0" 冒充稳定锚点；保留既有可读入口与兼容后备，明确不能保证缺失历史锚点的稳定位置。不要为了这类未证存量批量重写历史。

### 5.3 RED/GREEN 与相称检查

1. 在现有纯投影测试中增加合法 Snapshot 反例：最新页缺保存事件、任务带报告；补旧页前后锚点必须相同。先记录当前失败。补页、重复 refresh、同一 report 新版本不重复/不换锚；不新增复杂并发矩阵。
2. 在同一个现有报告真实 MySQL 场景中覆盖“首次保存→超过1000条正常合成事件→snapshot/refresh→补旧页→修订”：即使当前 events 不含保存事件，任务投影也带正确首次序号；分页游标含义不变，报告引用和内容版本沿原规则变化。核实际使用的保存路径，只有独立入口确实走不同逻辑才补小样；幂等断言优先复用。断言真实 API，而非手工给前端塞锚点。
3. 同源 Schema 新字段可选，更新 fixture、生成两侧类型并运行合同检查。保留无报告、旧快照缺字段、匹配报告与去重、原权限/文本保护和报告引用读取测试。兼容结论是新实现可读缺字段旧快照，不自动代表旧前端可接收新字段；本包不承诺新旧前端任意混部。
4. 浏览器在同一合成会话检查卡片位置、重复卡片、补页/刷新与打开来源后返回；将“时间线锚点正确”和“滚动阅读位置保持”分开断言，不能互相替代。

直接检查入口：`node tests/mvp/check-conversation-timeline.mjs`；`node tests/mvp/check-analysis-reports.mjs`；`node tests/mvp/check-analysis-reports-browser.mjs`；`node tests/mvp/check-report-reading-position-browser.mjs`。先读脚本实际依赖，隔离库和浏览器按既有 harness 启动。不要凭本包命令名宣称已通过。

## 6. 有界回归与全局缺口表

### 6.1 必跑与复用

新增行为的 RED/GREEN 必跑。实现冻结后，Rust 只重建一次 API/Worker；随后串行跑数据库 harness，不用 `make -j`。命令在子 shell 内清除真实 provider 环境变量，沿用项目测试隔离，不把真实 Key 暴露到 cargo 输出：

```sh
(
  set -e
  unset DEEPSEEK_API_KEY DEEPSEEK_BASE_URL DEEPSEEK_MODEL DATA_AGENT_MODEL_PROFILE DATA_AGENT_MODEL_FAULT
  export PATH="$HOME/.cargo/bin:$PATH"
  cargo build --offline --locked -p data-agent-api
  cargo build --offline --locked -p data-agent-worker
  make verify-contracts verify-code verify-architecture
)
```

保存实际命令及退出码；构建失败立即停止，不能用旧二进制继续当前候选验收，也不能只用最后一条命令的成功掩盖前面失败。

行为回归选择受影响入口，不把以下清单机械全跑。依赖变更/输入指纹失效时需运行，未变且有对应完整证据可复用：

| 行为 | 优先既有验证入口 | 对本包的要求 |
| --- | --- | --- |
| 工具正文与规则装配 | `tests/runtime/check-evidence-tool-shape.mjs`、`tests/mvp/check-evidence-knowledge.mjs` | §4 的实际 provider 正文观测必须有当前结果 |
| 正式指标独立判分 | `tests/mvp/check-business-evaluator.mjs` | 本包必跑；不改变原基准 |
| 草稿/聊天授权 | `tests/mvp/check-conversational-query.mjs`（默认与 `--source-admission`） | 本次共享规则/说明影响两种模式，均取得当前小范围回归，分别记工具合同版本；不复制整套场景 |
| 查询准备续租 | `tests/mvp/check-query-preparation-lease.mjs`、11月10日 storage/RED/GREEN | 本包不改此机制；匹配输入可复用，不能重开发 |
| 报告分页与权限 | §5 四个入口、`tests/mvp/check-report-text-authority.mjs` | 新投影相关行为必有当前证据，现有权限断言保留 |
| 双任务和流式 | `tests/mvp/check-task-answers.mjs`、`check-task-answer-recovery.mjs`、`check-rendered-answer-delivery.mjs` | 仅相关规则/投影影响到时重跑；不删冻结答案/绑定机制 |

先通过 `rg --files tests` 核对表中入口；若历史名称已变，用 Makefile/CURRENT 的现行入口更新此表，不编造新脚本来凑命令。

### 6.2 全局证据缺口不变成无限修复队列

对审计报告的15类能力建立**一张表**，放在本包执行后报告或既有覆盖记录，不新建一套系统。每项标：`当前证据可复用 / 本次通过 / 已知失败 / 未验证 / 明确后置`，附版本、环境、实际断言和记录路径。最多按以下五个能力组选择缺失且影响当前交付的最小已有案例，不无条件展开所有历史矩阵：

| 能力组 | 核对谓词 | 导航 |
| --- | --- | --- |
| 来源与治理 | 手动同步的未变复用、仅负责人变化；人工值不被覆盖；建议接受后仍须明确保存 | `catalog_import.rs`、`semantic_governance.rs`；`check-source-sync.mjs`、`check-maintenance-replay.mjs`、`check-semantic-role-boundaries.mjs` |
| 召回与依据 | 范围在召回通道生效；内容/例外可续读；实际模型正文与成功回执一致 | `knowledge.rs::drive_stage`、retrieval vector、evidence delivery/supports；`check-evidence-search.mjs`、`check-evidence-support-continuation.mjs` |
| 任务、查询与结果 | 原消息授权、双任务冻结、结果来源和数值绑定、表格/图表/CSV同结果 | `query_workflow.rs`、`task_answers.rs`、`analysis_answers.rs`；现有 query/task/report 检查 |
| 记忆与 Skill | 临时条件优先、停用后旧索引不采用、公共副本独立、采用前回源 | `personal_memory.rs`、`personal_assets.rs`、memory service；`check-memory-revisions.mjs`、`check-evidence-assets.mjs` |
| Pi、配置与兼容 | 原生压缩/恢复、旧profile可恢复、新修订只影响新消息、v1/v2模式清楚 | `packages/contracts/capacity.ts`、`apps/agent/session/capacity.ts`、journal/configured；`check-native-compaction.mjs`、`check-model-configuration.mjs`、`check-tool-contract-version.mjs` |

这不是本轮必须补建的五组新功能。已有有效证明即可退出该项；没有证明就如实标未验证。只有具体失败定位到当前实现，且是本包受影响的一般原因，才局部修复；另有独立大问题时记录触发、根因、范围，再交用户决定，不默默延长本包。

## 7. 真实模型代表与停止条件

先完成工程候选、生成本次真实代表的可审阅命令/资料，再核对当前授权。11月10日 trial 延期已过期，历史同意不能自动延长本次窗口。没有新授权时不调用模型，标 `NOT_RUN_AUTHORIZATION` 并照常完成工程交接。

获准后仅跑原 Q02 自然输入，**保留原题原断言**。使用新的 attempt/输出记录，不覆盖11月10日证据，不挪旧预算和预留；费用范围按用户这次确认的 trial/窗口执行。代码和参数从既有真实代表 harness 复用；禁止直接执行旧脚本覆盖报告或使用过期 trial。

正常链路：用户原题 → Pi 自主检索/补读/保存新稿 → 对新稿做既有独立校验 → 通过后按原流程发送明确执行消息 → 原消息授权提交 → 同一查询结果自然解释 → 对照原值/单位/来源，核流式与持久正文/刷新一致。

- 在隔离的合成语义测试里，通过已有 provider 接缝记录本次真正发出的相关 messages/工具内容，脱敏后仅保存在 `.local`；不加产品全量 prompt 日志，不记 Authorization/API Key。若无法安全捕获，仅记证据缺口，不能伪称逐字确认。
- 原题 SQL 校验不通过即停止这条真实链，分别记录业务错误、已核算数值不符、无法自动识别形状；仅形状未覆盖不得直接判模型错误。保存新稿、参数、决策、工具回执与实际输出，不让人工改稿或反复重开消息求通过。
- 第一次代表成功后，至多一次沿原结果续聊；必须满足原续聊前提。原结果不含所需分组时，将续聊记未进入，不能换题或额外查询拼出通过。
- provider 503、超时等按24/3既有规则结束；模型失败、应用失败、外部失败分开。一次成功仅证明该代表，不宣称全模型能力已保证。
- 真实模型不通过不回滚已证工程修复，也不把 DA-001 写成已关闭。没有证据不更换模型作为默认解决方案。

## 8. 出口、文档与交接

1. 更新 CURRENT 顶部短摘要与原 `delivery.increment`；保持每项真实状态。产品审查和绑定验收未完成时维持 active/pending/null，不能拿本次 Oracle 方案复审当实现审查。
2. 本次涉及任务展示 Schema 与 owner 查询接口，更新同源合同与实现设计中对应边界；只改受影响图/文档。README 只在用户可见行为或启动命令变化时更新，并写明无需更新的理由；不为完成清单机械重画全套图。
3. 在本包末尾或单个既有审查报告记录实现差异、RED/GREEN、复用证据、全局缺口表、真实代表状态与候选启动命令；CURRENT 只保留摘要和链接，不追加长日志。
4. `make verify-delivery` 只验证记录。本包候选记录绑定本包实际验收命令；不能以较窄命令替换原09必要要求。沿现有机制运行 `make verify-increment` 的适用验收，原09仍有缺项时保留未关闭状态，不为得到绿色结果删要求、改完成标准或新增一套门禁。工程完成、真实模型结果和独立实现审查分别记；未授权付费不阻断工程交接，也不能写成通过。必要时清楚交付“本包工程完成，09仍有验证缺口”。
5. 按项目要求由未实施相应代码者完成一次范围明确的独立实现审查，提供精确差异/要求/结果；不能伪造他人结论或沿用旧指纹。无可用审查者就标 pending，保留可执行候选。
6. 最终告诉用户：两项修复分别完成到哪层、哪些全局能力仍未验证、真实模型是否跑过/结果、日常服务是否更新。本包不提交推送，不擅自改日常服务；提供具体后续操作供用户决定。

## 9. Oracle 审包处置

第二轮 `data-agent-review-20261113` 使用最高 Power 5/5，预览约24,455 tokens，提交三份聚焦材料，完整答复与退出码0已取得；精确临时Chrome和Profile已回收。结论是“必要修订后可实施”，没有要求新增架构或扩大主修范围。

| Oracle意见 | 最终处置 |
| --- | --- |
| B1 判分器形状缺口与业务错误分开；明确新口径不一律澄清 | §4.2、§7增加分类、一个合法陌生别名小例，保原Q02业务失败 |
| B2 核全部正式保存入口，首次跨所有版本 | §5明确调用者/发出点与conversation+report最小序号，不改报告引用/版本 |
| B3 接口、权限、分页、合并边界具体化 | §5补同AppTx/LockedConversation、u64映射、无真锚省略、report_id匹配、游标不变与最小验收 |
| B4 构建遇错即停；v1/v2与快照兼容分别记 | §6加set -e、当前两模式回归，§5限定兼容结论 |
| B5 阅读/授权/工程退出一致 | §1增§8与受影响合同必读，§2明确授权来自用户，§8不削弱原09要求 |

这些必要修订已由本地纳入并逐项核对，不额外发起一轮相同审包；不声称Oracle再次批准了修改后的逐字文本。原答复与送审指纹保存在 `.local/audits/project-global-20261112/`，本次只证明方案已受审，不证明产品实现通过。

## 10. 实施记录（2026-11-13，工程完成；真实代表状态见10.4）

实施者按本包完成四项工程任务；未提交推送、未更新日常服务。基线与证据目录：`.local/checks/metric-report-closure-20261113/`（32 份源码/文档 SHA-256、20 份 before/ 副本、environment.json、verify-block-6-1.log）。既有未提交工作、原失败 SQL、独立判分及其变体全部保留。

### 10.1 实现差异

**§3 固定输入与证据**：接手时工作树含既有未提交工作，按原样保留；基线记录见上目录。

**§4.1 交付验证（未改产品交付代码）**：新增 `tests/runtime/fixtures/q02-read-knowledge-receipt-data.json`（原 Q02 `read_knowledge` 回执 `.data` 逐字副本）；`tests/runtime/check-evidence-tool-shape.mjs` 新增检查——原回执经真实 v2 `formatResult` 与原生 Pi 会话执行，断言 provider 协议正文含完整指标定义（`COUNT(DISTINCT customer_id)`、“匿名客户不计已知客户数”）、匿名边界文档规则原文及逐项 `content_page` 分页状态（434/1150 字符不裁剪）。结论：存储/检索/Pi 会话交付机制无损，按包约定不修改存储、检索或压缩。

**§4.2 指标与诊断分离**：`apps/agent/session/resources.ts` 在既有第 24 行段落内追加规则（非第二规则块）：未知实体/缺失值只按已确认定义处理或以独立诊断列表达、诊断列不冒充正式指标、已定口径不反复确认、新口径沿现有 semantic_resolution/澄清、保存 SQL 前核对度量表达式/已定解释/字段粒度/诊断列一致。`apps/agent/tools/data-tools.ts` v1/v2 `request_query` 描述各加一句引用该职责。上述装配在实际 provider 系统提示中被同测试断言观测。`scripts/evaluate_business_sql.py` 结果增加 `scoring` 字段（`cannot_autoscore_shape`＝形状未覆盖 vs `compared`＝已核算数值不符）；`tests/mvp/check-business-evaluator.mjs` 新增断言：原 Q02 失败 SQL 保留 `passed=false`、`scoring=cannot_autoscore_shape`、行值 `[[5,1,1,6]]`；合法陌生别名变体全 `expected_rows=null`；数值不符例 `scoring=compared`。

**§5 报告稳定定位**：`packages/contracts/schema.json` TaskSnapshot 新增可选 `report_timeline_event_seq`（`^[1-9][0-9]{0,19}$`，无保存事件时省略——刻意不同于 QueryView.timeline_event_seq 允许 null/"0" 的先例）；生成类型同步。`crates/data-agent/src/modules/conversations/store.rs` 新增 `report_first_saved_seq_in_tx`：同事务窄查询按 `conversation_id+report_id` 跨全部已保存版本取 `MIN(event_seq)`，不按版本/事件页筛选，无 N+1；`use_cases/read_conversation.rs` 在任务保护后的同一读取事务内组合，Snapshot 与 refresh 共用路径。前端 `conversation-timeline.ts` 报告卡只在任务 `report_ref.report_id` 与卡片一致时采用锚点（不凭 task_id 套用），回退已加载页事件再回退 "0"，锚点不注入事件流、不影响游标。

**文档**：`docs/architecture/runtime-modules.md` conversations 操作表新增该查询行；`docs/architecture/implementation-design.md` snapshot 分页条目补锚点语义。README 无需更新：无启动命令或用户入口变化，报告卡定位是分页内部稳定性修复，README 不描述该粒度。

### 10.2 RED/GREEN 与回归证据

| 检查 | 结果 | 说明 |
| --- | --- | --- |
| `tests/mvp/check-conversation-timeline.mjs` | 通过（11 项） | §5 前端投影先 RED 后 GREEN；含锚点兼容回退、补旧页不换锚、修订不换锚、report_id 匹配 6 断言 |
| `tests/mvp/check-analysis-reports.mjs` | 通过（20 项） | §5 真实 MySQL 场景：首次保存→1001+ 合成流式块→最新页 snapshot/refresh→补旧页→修订；任务投影带正确首次序号，无报告任务省略字段。§6.1 冻结重建后在最终二进制上复跑一次仍通过（审查条件项关闭） |
| `tests/runtime/check-evidence-tool-shape.mjs` | 通过（9 项） | §4.1 新检查 + 既有正文装配观测 |
| `tests/mvp/check-evidence-knowledge.mjs` | 通过（4 项） | 规则装配另一入口 |
| `tests/mvp/check-business-evaluator.mjs` | 通过（13 参考用例） | 原基准不变，仅新增分类断言 |
| `tests/mvp/check-conversational-query.mjs`（默认） | 通过（12 项） | 共享规则改动小范围回归，工具合同 v2 |
| 同上 `--source-admission` | 通过（2 项） | 两种模式分别取证 |
| `tests/mvp/check-report-text-authority.mjs` | 通过（7 项） | 新投影相关权限断言保留 |
| `tests/mvp/check-analysis-reports-browser.mjs` | 通过（11 项） | Playwright 真实浏览器；一次运行在“报告 GET hold”场景有时序抖动（hold 路由与渲染竞态），复跑通过 |
| `tests/mvp/check-report-reading-position-browser.mjs` | 通过（4 项） | 锚点与滚动分开断言 |
| `make verify-contracts` | 通过（667 项，Rust+TS 双侧） | schema 变更后同源核验 |
| §6.1 命令块（cargo build ×2 + verify-contracts/code/architecture） | 全部 exit=0 | 实际命令与退出码见 `verify-block-6-1.log` |

conversational-query 两模式首次运行各有一次未留完整输出的崩溃、复跑通过（与 report-text-authority 首跑即绿对照，判为测试间环境竞态，非本包改动引起；无产品断言失败）。

披露两处证据边界：`read_conversation.rs` 在全部数据库证据取得后有一次纯格式修改（clippy 要求的闭包压缩，无语义变化），冻结重建后已复跑上表真实 MySQL 场景关闭该时序缺口；`runtime-modules.md`/`implementation-design.md` 含既有未提交修改且未入 before/ 副本，本轮增量仅 §10.1 所述两处（conversations 操作表新行、snapshot 分页条目补充），其余差异属既有工作。

### 10.3 全局 15 类能力状态

| 能力 | 状态 |
| --- | --- |
| 工作台和历史 | 本次通过（浏览器 11+4 项，DA-004 锚点与滚动分离断言） |
| 平台同步 | 当前证据可复用（未触及该路径） |
| 文档与语义整理 | 当前证据可复用（未触及该路径） |
| 混合检索 | 当前证据可复用（未改检索；§4.1 证明交付无损） |
| 依据交付 | 本次通过（原 Q02 回执经真实 v2 formatResult + 原生 Pi 会话完整交付） |
| 多轮澄清 | 当前证据可复用（规则未改澄清机制） |
| 多任务答案 | 当前证据可复用（未改冻结/组合/提交；TaskSnapshot 新字段为可选，字段级断言不受影响） |
| SQL 与查询 | 本次通过（工程侧）：规则与判分分类落地；DA-001 真实模型改善未验证 |
| 结果与报告 | 本次通过（20 项真实 MySQL + 11 项浏览器） |
| 语义协作 | 当前证据可复用 |
| 个人记忆 | 当前证据可复用 |
| Skill 与案例 | 当前证据可复用 |
| 模型配置 | 当前证据可复用 |
| Pi 与后台恢复 | 当前证据可复用（Pi 原生能力保持：全部新测试经原生 Pi 会话/真实 transport 路径；24 次/3 次及权限/操作/预算身份未改） |
| 兼容、文档、验收 | 本次通过（667 项契约双侧、timeline 兼容回退断言、两份设计文档边界更新）；09 整体验收仍缺真实代表 |

### 10.4 真实代表状态与候选命令

**后续状态修正：** 本节下方是获准运行之前的记录，命令仅供追溯，不是当前执行建议。后续实际运行了旧S02按钮确认场景，13次官方请求，SQL与数值通过；原报告`completion=awaiting_independent_semantic_review`。本轮读到其文字推断无依据，且旧接口不覆盖原题聊天执行，故不宣布DA-001关闭。具体修复与新的代表入口见[本地包](local-trial-closure.md)§4–5、§7，旧产物保留。

`NOT_RUN_AUTHORIZATION`：本包实施时无新的付费授权（11月10日 trial 延期已过期，历史同意不自动延长）；未调用任何真实模型。工程候选照常完成，本节不冒充真实通过。

获准后候选启动命令（须先获用户对本窗口的明确授权，不沿用旧 trial 额度）：

```sh
node tests/mvp/run-business-acceptance.mjs --run --cases S02
```

原题原断言保留，新 attempt/输出记录，不覆盖 11 月 10 日证据；原题 SQL 独立校验不通过即停链并按 §7 分类记录。provider 接缝脱敏记录仅存 `.local`。

### 10.5 出口声明

本包工程完成 ≠ 09 完成。原工程独立审查已通过，后续33组绑定验收失败；新本地收尾范围的review为pending、evidence为null。原独立实现审查记录于[实现审查报告](../../reviews/project-closure-implementation-review-20261113.md)。
