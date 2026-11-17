# 全项目完成度、体验差异与09执行包独立审计（2026-11-02）

审计对象：分支 `codex/semantic-maintenance-prototype`，HEAD `04d27d0`，当前完整工作树（163 M / 3 D / 129 ??，审计前后未变）。09原文SHA256 `ebcdc879…1e74` 与交接记录一致。入口：[global-audit.md](../execution/semantic-runtime/global-audit.md)。

本次只读源码、文档与既有收据/日志元信息；**未运行任何测试或服务，未看当前渲染，未调用付费模型/Embedding/Mem0，未改产品、测试或09**。下文“已证实”指有源码行或收据记录直接支撑；“待验证”指静态推断或缺动态证据。历史收据只作证据定位，不当作本版通过。

## 结论

1. **01–08代码基本齐备，但产品默认运行形态尚未切到新合同。** `make dev` 默认仍是 v1 工具合同、词法检索、builtin 记忆、archive 保留；05–07 的 v2 检索/批量读、支持续读、多任务定稿和回执容量只在显式 `--tool-contract-version 2` 时启用（F1）。默认模拟演示仍按 v1 参数编写，切到 v2 后知识读取不符合 Schema（F2）。
2. **与已批准原型的差异：** 原型要点在源码中均能找到对应实现（结果先于SQL、复制SQL、单独停止、口径依据与返回对话、未保存保护、手机导航、发布为公共副本）。但原型相关浏览器回归的最近收据停在 10-10~10-13，早于01–08全部改造；100项和10条轨迹都没有窄屏/键盘/地址后退用例（F7）。视觉效果本次未验证。
3. **09方向正确，但现文本不可直接执行。** 有四个开工阻断：环境未规定新合同切换（F1）、10条综合轨迹没有冻结输入/预期/记录位且与 `grade.py` 的100项硬约束冲突（F3）、真实模型试验前提不存在（F5）、08升级演练没有在最新修复后复演（F6）。另需补齐需求映射（F8）、空库定义（F4）和 8MiB/600秒探针定义（F9）。
4. **真实效果层面没有证据：** 真实模型理解/SQL质量、真实中文向量召回、Mem0 提取、端点 8MiB/600秒，在当前版本均为未验证；旧 dogfood（`voice-cockpit-20261022` 100项中 pass10、partial5、fail2、not_run83）属于旧版本、旧检索，不计入本版。

## 1. 十五项能力对账

“代码具备”= 已核对入口源码，并有对应收据；括号内日期是该能力主测试最近一次通过收据的日期（只用于判断证据新鲜度）。

| # | 能力 | 实现程度 | 已查入口 / 证据 | 体验或效果缺口 | 09覆盖 |
| --- | --- | --- | --- | --- | --- |
| 1 | 工作台/历史/导航 | 代码具备：结果先于SQL、复制SQL、停止、口径依据、报告“返回对话”、未保存保护、手机导航弹层 | `QueryCard.tsx:122-175`、`WorkspaceShell.tsx:41-44`、`UnsavedChanges.tsx`；体验回归最近通过 10-10~10-13 | 当前渲染未看；01–08后无原型回归证据 | P01/T12/T15/A05；无窄屏/键盘/地址后退（F7） |
| 2 | 同步 | 代码具备：手动全量、后台分页、权威缺失才退休、负责人在完成时统一生效、raw索引与 `prepare_source` 同事务登记、进度含整理与两类索引 | `catalog_import.rs:17-215,315-392`（10-24） | 文档/指标不经平台同步，由启动时合成目录预置（F4）；只有合成平台 | P02、轨迹1/2；退休、平台侧负责人变化、改名后稳定身份未覆盖（F8） |
| 3 | 文档/语义整理 | 代码具备（入口已核，内部未深读） | `source_preparation.rs`、`knowledge_documents.rs`；`KnowledgeCreator.tsx` 可新建文档（11-01） | 真实模型整理质量未验证 | G04/G05/X07、轨迹1/2 |
| 4 | 检索 | 代码具备；默认词法，混合检索只能在 `--model deepseek` 下启用 | `knowledge.rs:25-40`；`development.py:146,159`（10-29~11-01；千表证据用协议向量） | 真实中文语义召回需要付费 Embedding，未验证 | P06/X08/G09/T14、轨迹7 |
| 5 | 依据交付 | v2 代码具备，默认 v1 不启用（F1） | `data-tools.ts:155-159`、`capacity.ts:91-138`、`evidence_delivery.rs:160-176`（11-01） | 单次回执实际封顶 96KiB（设计写“目标96KiB/硬256KiB”），可接受；真实 Pi 深翻页只有本地协议证据 | P06/T14/A15、轨迹6/7 |
| 6 | 多轮/澄清 | 代码具备：来源门，切换任务时按范围重新投影 | `source_limits.rs:577-621`、`task-projection.ts:26-50`、`data-tools.ts:248-252`（10-22~10-26） | 模型理解质量未验证 | S03/T01/T02/T08/X05、轨迹3 |
| 7 | 多任务答案 | 只有 v2 可用（`task_answers.rs:62`），默认未启用 | `deliver.ts:438-543`（11-01） | 真实模型多任务定稿未验证 | T01/T03/A03、轨迹4/6；“检查真实provider输入”没有可观察定义（F3） |
| 8 | SQL/查询 | 代码具备：聊天授权绑定当前真实用户原话，执行意图由模型判断；UI 无独立确认按钮 | `query_workflow.rs:220-312`；`QueryCard.tsx` | 部分回归收据较旧（query-workflow 10-09、boundaries 10-11） | S01/S02/T03–T07/T09/T11/T13、轨迹8 |
| 9 | 结果/报告 | 代码具备；未提交改动使条件变更后的报告正文仍可回看 | `AnalysisReport.tsx`（工作树 diff）；analysis-reports-browser 11-01，统计 10-18 | 图表/CSV 一致性与阅读位置的当前渲染未验证 | A01–A03、J/X 数值项、G08 |
| 10 | 语义维护/协作 | 代码具备（未深读） | 路由 `/semantic-corrections`、`/knowledge/{id}/maintainer`；浏览器收据 10-11/10-13 | 01–08后无 UI 回归证据 | G01–G06/G10 |
| 11 | 记忆 | 代码具备；真实 Mem0 路径存在（`infer=True`） | `apps/memory/service.py:22,70-71`、`personal_memory.rs:72-121`；mock 默认 builtin | Mem0 真实提取需要付费，未验证 | A07–A12、轨迹9 |
| 12 | Skill/案例 | 代码具备（未深读） | 收据 10-17 / 10-29 | 公共副本与来源有效性的当前版本证据较旧 | A04–A06/A13–A15、轨迹9 |
| 13 | 模型 | 代码具备：管理页默认 C=1M、I=900k；Schema 上限 8MiB/600s | `ModelConfigurationPage.tsx:32-33`、`schema.json:1500-1537`、`model_configuration/store.rs:340-381`（11-01） | 端点 8MiB/600秒未测；本机真实试验档过旧（F5） | P10/T10/G07、轨迹10（定义不足，F9） |
| 14 | Pi/后台 | 代码具备：原生压缩与重试，两处恢复快路 | `deliver.ts:255-273,83-103,377-394`、`worker/main.rs:201`（10-24~11-01） | 真实进程下的长会话未验证；快路判据重复（F10） | X07/X10/T13、轨迹5/6 |
| 15 | 升级 | 代码具备，11-01 演练通过 | `I2-SEMANTIC-CLOSURE-REPAIRS` 收据含 `verify-upgrade-*`；之后的修复没有复演（F6） | 默认仍 v1/archive，日常服务未切换 | 100项不涉及；只作09前置（F6） |

横向检查：`scripts/check_architecture.py` 只校验模块互导、SQL 位置和表归属，不检查事务内网络等待、锁序或协调层跨模块调用。抽查同步页读取、Memory 调用、Embedding/Milvus 写入，都在事务外（`catalog_import.rs:144-147`、`personal_memory.rs:92`、`knowledge.rs:839`），未发现违规；其余路径未查。

## 2. 实质发现（按影响排序）

### F1 09未规定新合同环境；按现有命令运行时测到的是旧 v1 合同 — **已证实，阻断09，09前修**

- **触发/后果：** 09 只写“前置：08升级演练通过”（`integrated-dogfood.md:3`），没有规定试用环境的启动参数。座舱操作说明给出的命令是 `development.py --model mock …`（`OPERATIONS.md:12`），默认值为 v1、词法检索、builtin、archive（`development.py:144-151`）。新消息合同由环境变量决定，缺省为 1（`deliver_run.rs:321-327`）。v1 下多任务定稿被拒（`task_answers.rs:62`），定稿参数被删除（`data-tools.ts:325,347`），v2 检索/读取与回执容量不加载（`data-tools.ts:155`、`deliver.ts:129`）。这样执行，09 会把05–07的核心能力排除在外，但结果仍可能被记成“通过”。另外，混合检索只允许和 `--model deepseek` 一起使用（`development.py:159`），因此第二层“本地provider＋真实Milvus”无法用启动器搭建，只能走测试 harness，09 没有写明。
- **要求：** 08“最后启用新消息v2”；09 要验证 05–08 的能力在整条链路中保持。
- **最小修法：** 09 增加一张环境矩阵，三层分别写启动方式和参数：工程/UI 层用启动器加 `--tool-contract-version 2 --public-content-retention latest_only`；本地完整链用 harness（协议 Embedding＋真实 Milvus）；真实层用新授权试验配置加 `--retrieval hybrid`。每层的观察项：`environment.json` 中 `tool_contract_version=2`；首条新消息的 `agent_runs.tool_contract_version=2`；公共集合名与 retention 正确。沿用旧数据的库要先按 `docs/development.md:154-157` 的顺序完成回填→latest_only→新索引→v2。通过标准：三层的上述观察都有记录。

### F2 默认模拟演示只按 v1 参数调用知识读取，切到 v2 后必然不符合 Schema — **静态已证实，运行表现待验证；09前修（阻断 v2 下依赖 mock 的 UI/工程项）**

- **触发/后果：** mock 直接把动作参数作为工具调用发出（`mock.ts:70-77`）。座舱演示读取指标和文档时用的是 v1 形状 `{object_id, entry_id, limit}`（`synthetic-cockpit.ts:40,50`；零售演示见 `synthetic-analysis.ts:335`）。v2 下 `read_knowledge` 换成 `KnowledgeReadInput`，必填 `items[{kind,ref}]`，并禁止多余字段（`data-tools.ts:158-159`，`schema.json` `KnowledgeReadInput/KnowledgeReadItem`）。结果是：README 快速开始的三条示例（`README.md:215`），以及需要 mock 产生草稿的 UI/工程用例（T10/T12/T15 等），在 v2 环境下会读取失败、产不出草稿。默认值改成 v2（08的终态）同样会使默认演示失效。现有启动器测试只核对环境变量（`scripts/test_development.py:140-281`），没有覆盖 mock 在 v2 下的行为。
- **最小修法：** mock 按 `run.tool_contract_version` 分支：v2 先 `search_knowledge` 取得命中的 `ref`，再 `read_knowledge{items:[{kind:"knowledge",ref}]}`；v1 原样保留。补一条 mock＋v2 冒烟，复用现有 harness，跑 README 三条示例。不需要新框架。

### F3 10条综合轨迹没有冻结输入/预期，也没有记录位，与判分工具冲突 — **已证实，阻断09，09前修**

- **触发/后果：** 轨迹只是散文描述（`integrated-dogfood.md:23-38`），没有 ID、消息、逐条预期、参考值、环境（隔离或日常）、依赖和清理顺序。09 要求沿用 `records/results-template.json`（`:42`），但模板和 `grade.py:45` 都要求“恰好100个用例ID”，轨迹写进去判分就报错。执行者只能边跑边编预期，这违反 09 自己的“输入/预期冻结”和“独立预期不能倒推模型输出”（`:19,38`），也无法保留完整分母和失败 attempt。部分轨迹会改资料或撤权（来源更新、人工保护、撤权残留），没有指明隔离环境。“检查真实provider输入”没有写判定标准。
- **最小修法：** 新增一份冻结的轨迹清单，例如 `docs/dogfood/cockpit/trajectories.json`。每条写明 id、环境、前置/依赖、逐步消息与操作、逐条 expect（需要数值时给参考 key 或独立计算方法）、cleanup，并写出可观察的 provider 输入判据。例如“互斥来源”一条：切到 B 后的请求里出现范围压缩边界，且不含 A 的工具回执；A 的定稿正文和数据库引用保持不变。记录用独立文件。`grade.py` 加一个参数校验轨迹集合（相同状态枚举、pass 必须有证据、mock 证据不能让模型项通过），100项校验保持不变。09 中“一个有语音口径歧义的多轮场景”（`:17`）要写成具体用例ID。

### F4 “空库到可回答”在现有启动方式下无法成立 — **已证实（启动预置），可行修法待验证；09前修**

- **触发/后果：** API 启动时执行 `knowledge::initialize`（`apps/api/src/main.rs:46`）。它会把合成语义目录 seed 进 `demo` 空间（`knowledge.rs:12-24,413-433`）；座舱目录共 543 个对象，含 28 表、421 字段、26 指标、14 文档。每次平台同步的第一页还会再调用一次 `sync_catalog`（`catalog_import.rs:141-143`）。因此不存在“空库”起点，“导入→暂停整理→只靠 raw 回答长文末尾定义”也无法与预置的已整理知识区分开。
- **最小修法：** 轨迹 1 改用一个独立的来源目录：复制座舱来源，semantic-catalog 的 `objects` 置空；经 harness 的 `sourceDirectory` 启动，文档通过语义管理新建。先做一次无付费的启动可行性检查（待验证：空对象目录能否通过 `register_catalog_in_tx`）。如果不可行，就把“空库”改写为“应用库中没有该来源的任何对象”，同时更新期望。

### F5 真实模型层的前提不存在：试验配置过旧，且隔离与预算规则冲突 — **已证实，阻断真实层；需用户授权**

- **触发/后果：** 本机唯一的真实试验配置 `.local/model-trial/configuration.json` 是旧档：input 4096、output 1024、无 `toolset`，绑定库 `data_agent_trial_dd59…`。启动器因此设置 `DATA_AGENT_TOOLSET=task`（`development.py:204,248`）。结果是 Worker 不跑同步和整理（`worker/main.rs:201`），聊天不注入数据工作区（`deliver_run.rs:131`），Pi 重试也被关闭（`deliver.ts:272`）。另外，09 要求“专用合成应用库”，START 又规定“不能复制 trial、重置数据库或换 ID”；预算账本存在 trial 库内，两条要求无法同时满足。09 写了“先核对授权”，但没有写出如何建立一个合格的试验配置。
- **最小修法（需授权）：** 由用户批准一份09专用试验：新 trial_id、专用库、`toolset=data`、按 §17.7 设置 I/O/payload/timeout，写明调用次数与费用上限，并把 Embedding 和 Mem0 的预算一并列入。09 写明：代表样本（P01–P09、S01→S02、指定歧义用例）跑完后，先报告实际消耗，再决定是否扩展到 L1–L6。授权之前，所有模型项记为 `blocked_authorization`。

### F6 08升级演练没有在当前代码上复演 — **已证实（收据），09前修（证据）**

- **触发/后果：** 最后一次 `make verify-upgrade-current/-frozen/compatible-restore/-index` 出现在 `I2-SEMANTIC-CLOSURE-REPAIRS` 收据中（2026-11-01T11:48Z）。之后的 `I2-SEMANTIC-DELIVERY-REPAIRS` 修改了控制回执合同（可缺省的 `text_authority` 和旧回执兼容）、恢复快路、历史结果组合和 SupportPage，这几处都直接涉及“旧会话/回执升级后恢复”。但它的 18 条命令不含升级演练。所以 09 的前置“08升级演练通过”在当前代码上没有证据。
- **最小修法：** 用当前代码重跑上述四个 make 目标（无付费、串行），通过后才算09前置成立。

### F7 原型体验回归没有当前证据，09也不覆盖窄屏/键盘/地址后退 — **已证实（收据与用例检索），09验证（关闭前必须完成）**

- **触发/后果：** `check-experience-optimization/-regressions`、`check-history-browser`、`check-conversation-experience-browser`、`check-evidence-return-browser`、`check-query-stop-browser`、语义维护三组浏览器测试，最近一次通过都在 10-08~10-13，之后后端合同大量改变。按关键词检索 100 项用例，“窄屏/键盘”命中 0 项；10 条轨迹同样没有。D13/C08 要求受影响的 UI 在桌面、窄屏、键盘下可用；本次也没有看当前渲染。
- **最小修法：** 09 第二层在 v2 环境运行 `make verify-mvp-browser verify-semantic-governance verify-source-ui verify-task-history`，以及上面列出的体验脚本（先确认 harness 会透传 v2 变量，待验证）。另存工作台、语义管理、我的积累、模型配置、同步进度的桌面与 390px 当前截图，逐项对照 `preview.html`。通过标准：脚本全部 exit 0，截图对照无退化。

### F8 用例与需求之间没有映射，“对全能力覆盖”无法核对 — **已证实，09前修（文档）**

- **触发/后果：** `scenarios.json` 和 `coverage.json` 只映射表、文档、层级，没有对应 D/C/A 编号；覆盖表第1节映射的是需求到执行包，不是到用例。按关键词抽查，以下内容在 100 项和 10 条轨迹中都没有：权威缺失表的退休、平台侧负责人变化、改名后身份稳定、窄屏/键盘、升级。抽查 G03–G05、X07、T05、T08，与新决定（旧分析保留、当前采用另行核验、接受建议不自动生效）没有冲突。
- **最小修法：** 在 `coverage.json` 或 09 附录加一张表：用例/轨迹 → D/C/A 编号与十五项能力。未覆盖的项要么指定现有工程测试作为证据，要么补进 F3 的轨迹清单。不新建测试平台。

### F9 8MiB/600秒验证没有可执行定义 — **已证实（文本），09前修；需授权**

- **触发/后果：** `integrated-dogfood.md:36` 只要求“验证获准端点实际8MiB接收和600秒链路/取消”，没有样本构造方式、预期观测（正常接收、413/连接重置、还是上下文超长错误）、费用估计、次数上限和记录位置。默认 profile 的载荷只有 128KiB（`model_configuration/store.rs:380`），要验证 8MiB 必须先建新配置。本地协议测试已经证明冻结、传递、取消（`runtime-capacity.md:38`），09 只需补真实端点这一段。
- **最小修法：** 定义两个探针，每个 1–2 次，并写入授权上限。(a) 接收探针：发约 8MiB 请求体，记录网关/端点返回的类别。采用哪种构造方式能避免大额计费，要先按供应商规则确认。(b) 时延与取消探针：高思考档单次请求，记录首事件等待时间与持续输出，在 T+N 秒取消，核对请求确实中止、预算按实际结算。

### F10 两处恢复快路的判据重复维护 — **已证实（代码），后置**

- `deliver.ts:83-103` 与 `:377-394` 用几乎相同的“所有输入任务已被冻结答案或控制投影覆盖”判据，分别在建会话前和接回 pending 调用后各写一遍。前一轮缺陷“快路跳过普通 pending 工具”就出在快路判据不一致。最小修法：提取一个共用判据函数供两处调用，保留建会话前快路的省开销作用。不阻断09。

### F11 README 状态过时 — **已证实，09收尾**

- `README.md:11` 仍写“08尚未关闭”，但 10-31 和 11-01 的收据都显示 08 已通过；同段“默认仍为archive和v1”是准确的。09 最后一步更新文档时一并修正，并说明 F2 修复前 mock 在 v2 下的限制。

## 3. 09结论与需要的修改

**结论：** 09 的分层推进、授权边界、attempt 保留、真实/替身证据分开，这些设计都是对的；现文本不能直接开工。

| 时机 | 必要动作 | 观察 / 通过标准 |
| --- | --- | --- |
| 09前修 | F1 环境矩阵与切换顺序 | 三层的 `environment.json`、首条 run 合同版本、集合与 retention 都有记录 |
| 09前修 | F2 mock 支持 v2，加冒烟 | README 三条示例在 v2 下 exit 0，产生草稿/回答 |
| 09前修 | F3 冻结轨迹清单、记录文件、判分参数；指定歧义用例ID | 轨迹文件在执行前定稿；判分能校验 100+10 |
| 09前修 | F4 空库来源目录或改写定义 | 无付费启动检查通过，或期望已改写 |
| 09前修 | F6 当前代码重跑四个升级目标 | 全部 exit 0，收据绑定当前指纹 |
| 09前修 | F8 需求映射；F9 探针定义 | 每个 D/C/A 都落到用例、轨迹或现有测试；探针写明样本、上限、判据 |
| 需授权 | F5 新试验配置与预算 | 用户批准记录；代表样本消耗报告后再决定是否扩展 |
| 09验证 | F7 浏览器回归与当前截图；真实模型代表样本与 L1–L6；真实向量/Mem0/端点探针 | 每项有本轮状态与证据；失败 attempt 保留 |
| 后置 | F10；D18 邀请/发布；真实平台接入 | 不计入09 |

## 4. 审计边界

- **已查：** 入口与09原文、导航、覆盖表第1节、座舱用例包（START/SCOPE/OPERATIONS/GRADING、100项清单、模板、grade/build）；启动器与开发文档；API 启动和路由；`catalog_import.rs` 全文；`deliver.ts`、`capacity.ts`、`workspace-context.ts`、`task-projection.ts` 全文；`data-tools.ts`、`deliver_run.rs`、`task_answers.rs`、`query_workflow.rs`、`source_limits.rs`、`knowledge.rs`、`model_configuration/store.rs`、`personal_memory.rs`、Memory 服务、mock provider、架构检查器的相关段落；UI 的 QueryCard、AnalysisReport 工作树 diff、WorkspaceShell 和关键字检索；收据与证据索引。
- **待验证：** F2 的运行表现；F4 空对象目录能否启动；F7 harness 是否透传 v2；所有视觉效果；所有真实模型、Embedding、Mem0、端点行为；性能。
- **未查：** `knowledge.rs`、`data_tools.rs`、`context_authority.rs`、`evidence_delivery.rs`、`task_answers.rs`、`analysis_*`/`historical_analysis.rs`、`semantic_governance.rs`、`skill_drafts.rs`/`personal_assets.rs` 的内部逻辑；migrations；平台 mock；Worker 续租细节；合同生成；各测试断言本身的质量。这些行只依据入口和历史收据，表中已注明“未深读”或以收据日期表示。按入口要求，本次没有另开 Agent 或 Oracle。
