# 模型派发诊断、OpenAI 接入与 09 收尾执行包

本包承接上一轮已完成的答案交付工程，增加用户要求的 OpenAI 可选模型接入。目标是定位共同派发失败、完成现有管理入口的真实 OpenAI 工具会话，并用有限代表流程确认交付效果。

当前状态只在 [CURRENT](../../CURRENT.md) 维护。发现依据见 [本轮审计](../../reviews/provider-delivery-readiness-audit-20261106.md)。本包已按两轮 Oracle 最高 5/5 审查意见定稿，第二轮要求的局部修订及本地核对记录见审计报告第 7 节。

## 1. 启动入口与连续顺序

### 启动必读

1. 根目录 `AGENTS.md`。
2. `docs/CURRENT.md` 的 frontmatter、最新摘要和本包链接。
3. 本包第 1–2 节和第 7 节出口。
4. 本轮审计第 2–5 节，取得已证与待证问题的边界。

然后按当前任务读取相关源码与本包对应节。历史九包、100 题、完整设计及过去日志只在具体问题需要时展开。全局约束持续生效，连续实施允许沿宿主原生上下文机制恢复。

| 顺序 | 用户可观察结果 | 进入条件与位置 |
| --- | --- | --- |
| 派发失败诊断 | 运行失败能够定位到实际阶段和受控原因 | 第 3 节 |
| OpenAI 管理接入 | 超级管理员通过原页面保存服务与模型，普通对话可选用 | 第 4 节，可在等待故障证据时推进 |
| 交付接缝核对 | 已修正文与多任务来源保持有效，候选疑点有明确处置 | 第 5 节 |
| 针对性真实验证 | DeepSeek 交付缺口与 OpenAI 工具续答分别有当版证据 | 第 6 节，先完成相关本地检查 |
| 收尾 | 当前范围、真实缺口、09 状态和交接一致 | 第 7 节 |

沿顺序连续完成，阶段完成后更新 CURRENT 并继续。只有缺少实际凭据、权限或需要改变产品取舍的分支暂停，其余独立工程继续。

## 2. 全局合同与范围

### 2.1 基线与保留内容

接手预期为分支 `codex/semantic-maintenance-prototype`、HEAD `04d27d06ba7b97d4cf3e288d4cf9e6300ef491a9` 及继承工作树。先核对实际状态，保留全部未提交成果。上一包 26 文件 scope 位于 `.local/checks/dogfood-delivery-implementation-20261106/scope.json`，本轮审计已逐项匹配。

Pi 1.3.0 负责唯一模型/工具循环、会话续接、取消、流式事件、检查点及压缩。Rust 负责正式业务状态、身份、权限、来源、模型许可和结算。每消息 24 次模型调用、连续临时失败 3 次，以及原 operation、origin、budget、output 身份继续沿既有合同。

本包保留自然 final、宿主发布的输出绑定、候选 owner、原通知目标、实际 source 三元组及冻结来源纯查证。新的 OpenAI 配置通过现有服务/模型修订生效，原消息恢复继续消费其冻结配置。

### 2.2 四条工程约束

- 仅为当前要求、已证失败或有正常入口证据的原因修改产品。罕见边界或复杂并发保护须说明触发条件、证据与代价，取得用户决定后再做，不编造概率。
- 外部数据在对应信任边界校验，内部传递已验证类型。权限、状态或来源确有变化时继续执行必要业务检查。
- 一次性简单逻辑就地处理。有实际复用、独立职责或明显降低复杂度时才提取函数。实现命名使用业务含义。
- catch 用于边界错误转换、有效诊断或真实恢复。同一异常在同层重复记录、无根据重试和吞错成功均禁止。

### 2.3 明确排除的扩张

本包范围包括相称代码、验证、相关文档和已授权试用。提交、推送、部署及日常服务更新另依用户实际授权。

本包排除第二 Agent/规划器/压缩器、自动切换供应商、通用模型能力目录、密钥管理新系统、通用异常平台、全量日志留存、SQL 自动审稿器及新增计费引擎。全 100 题、十条压力轨迹、8MiB/600 秒真实极限和无关 Mem0/索引生命周期继续按原后置决定处理。

沿既有授权使用必要真实模型与辅助端点，保留原费用和账本。以代表样本先验证，再按新增证据推进。不得自行追加累计试用费用门或逐批审批。供应商实际拒绝、原未解决 unknown、明确授权边界仍按事实处理。

本轮用户贴出的 Key 已暴露。公开文件、命令参数、截图和日志仅使用 `<OPENAI_API_KEY>` 占位符。由用户撤销后生成的新 Key 通过原管理页或授权本机私密入口注入；缺 Key 时先完成全部独立工程，真实 OpenAI 一项标明待凭据。

## 3. 修复发送前错误信息丢失

### 3.1 当前事实与根因

真实 A03 首次模型请求成功，四次任务门拒绝已回交 Pi，下一轮实际 provider 发送前结束。缺第二账本行和 wire，原始异常缺失。约 10 秒仅是线索。

本地复现已证明 reserve 的 TimeoutError、TypeError、lease_lost，以及 send 的 model_receipt_unknown 都丢失为 model_request_failed。具体输入与观察见 `.local/checks/provider-delivery-audit-20261106/dispatch-reproduction.json`。

### 3.2 所属接口与必读文件

| 边界 | owner 与落点 | 本轮职责 |
| --- | --- | --- |
| Node → Rust 宿主 HTTP | `apps/agent/transport/client.ts::RustTransport.post` | 固定端点、状态、耗时和错误类别 |
| Pi → 模型许可/发送/结算 | `apps/agent/provider/controlled.ts::guardedModelStream` | 失败阶段与 call_attempt_id，覆盖错误前保留受控诊断 |
| 错误交付给 Worker | `session/deliver.ts`、`transport/server.ts`、`apps/worker/src/main.rs` | 仅在确需传递已有安全码时核对消费者 |
| 宿主预检与许可 | `use_cases/model_calls.rs` 及 `modules/runtime/model_calls/` | 出现对应证据才改，其余作代码导航 |

诊断输出属于现有本地结构化日志。初始修复无需新增公开 Schema、表、endpoint 或错误事件协议。若查明的原因确需跨进程字段变化，按 contract-first 修改 `packages/contracts` 并沿已有生成器更新消费者。

### 3.3 实施步骤

1. 将已有局部复现中代表性失败接入 `tests/runtime/check-configured-provider.mjs`。优先两项有区分度的断言，一项宿主 reserve 超时，一项 send 明确未知回执。补已有宿主业务码断言以证明能区分明确拒绝即可，避免枚举每个错误排列。RED/GREEN 观察捕获的结构化诊断，核对失败阶段、原调用关联和受控原因。不得靠改变原对外错误码或增加重试取得通过。
2. 在现有转换边界增加最少诊断。阶段至少区分 payload/容量准备、reserve、send 许可、实际 provider 请求与结算。记录 `run_id`、`call_attempt_id`、固定端点路径、耗时、`reserved/sent`、HTTP 状态及受控原因。只读已有输入中的关联 ID，禁止复制完整 input。
3. 原因使用有限类别，例如 timeout、network、已有 AppError code、invalid_response、other。任意 error.message、URL 参数、请求头、正文、工具结果和凭据均不得直接输出。实现方式可用局部变量或现有错误对象，避免通用日志层。一次失败在最能说明责任的边界记录一次。
4. 对外错误码和 Pi 重试保持既有含义。日志保真先成立，禁止将宿主发送许可未知简单改成可重试模型错误。需要接通 `model_receipt_unknown` 等已有安全码时，逐跳核对 provider → deliver → server → Worker，使用现有语义，保留原调用和预留。
5. reserve 请求超时只能说明客户端未得到回执，不能据此清账或断言服务端未处理。send 许可状态未知继续按原身份查证。结算重送沿原 payload/身份，禁止改为重新调用模型。
6. 通过有区分度的本地检查后，进入第 6 节代表流程。若再次失败，使用新日志定位具体端点和原因。只有实际命中的一般工程问题进入修复，相关 owner 中最小修改后复验。模型 request_timeout_ms 与宿主 HTTP 时限分别处理。

### 3.4 验收与停止

本地应能区分“宿主 reserve 超时”“宿主业务拒绝”“send 许可未知”和真实 provider 已发后的错误，日志提供原调用关联且无敏感内容。原预算、未知与取消行为仍可由已有检查证明。

历史原始异常已经丢失时，在报告中明确保留“历史 A03 具体底层原因未知”。后续代表流程成功只能证明当前链路通过。若新日志指向持续外部不可用，保留完整失败事实并停止该分支，避免重复同题期待偶然通过。

## 4. 沿现有页面接入 OpenAI

### 4.1 接口与所有权

| 部分 | 现有位置 | 本轮工作 |
| --- | --- | --- |
| 超级管理员配置页 | `apps/web/src/features/models/ModelConfigurationPage.tsx` | OpenAI 协议初值及必要说明 |
| 配置 API 与权限 | `use_cases/model_configuration.rs` | 沿原管理入口保存和读取 |
| 配置、密钥、冻结 | `modules/runtime/model_configuration/{mod,store,secrets}.rs` | 复用 AES-GCM、版本与选择流程 |
| 模型注册和能力 | `apps/agent/provider/configured.ts` | 复用 Pi 目录、原生 Responses、连接修订隔离 |
| 发送、usage、结算 | `provider/controlled.ts`、`provider/usage.ts` | 同一许可与结算链 |

已有 `/model-services`、`/model-definitions`、`/model-configuration` 和对话模型选择足够完成本任务。密钥继续由原 `DATA_AGENT_MODEL_KEY_FILE` 保护的存储机制管理，读取页面只返回 `credential_configured`。

### 4.2 页面最小改动

管理员明确将供应商切换为 OpenAI 时，接口协议初值设为 `openai-responses`。展示官方地址例子 `https://api.openai.com/v1`，用户已填写的地址按编辑操作保留。现有编辑、保存、启停、默认模型和对话选择流程继续使用。

沿当前组件直接修改，复用既有表单和 `check-model-configuration.mjs` 浏览器段。该局部修正无需页面重设计或增加新管理层级。保留已有兼容协议编辑能力，型号配置按实际能力填写。

### 4.3 首个模型的建议配置

这些是本包建议的初始值，采用前核对所用账户与官方能力。实际账户不支持时报告原拒绝，给用户选择，避免静默切换型号。

| 字段 | 值或操作 |
| --- | --- |
| provider_id | `openai` |
| api | `openai-responses` |
| base_url | `https://api.openai.com/v1` |
| model_id | `gpt-6.1-sol` |
| 展示名称 | `OpenAI GPT-6.1 Sol` |
| reasoning_supported | `true` |
| thinking_levels | `low`、`medium`、`high`、`xhigh`、`max` |
| default_thinking | `high`，用于本次质量验证 |
| context_window | `1050000` tokens |
| input_limit | `900000` tokens |
| output_limit | `128000` tokens，包含推理输出 |
| payload_bytes_limit | `8388608` bytes |
| request_timeout_ms | `600000` |
| capability_source | `admin_declared`，文档记录官方链接与核对日期 |
| API Key | 原管理页输入新生成的密钥，保存后仅显示配置状态 |
| 默认与选择 | 新增可选项；本次代表对话明确选它，空间默认沿用户的管理选择 |

模型容量来自 [官方型号页面](https://developers.openai.com/api/docs/models/gpt-6.1-sol)。工具调用及档位依据 [官方部署说明](https://developers.openai.com/api/docs/guides/deployment-checklist)。核对日期为 2026-11-06。

本机 Pi 1.3.0 已认识该型号及上述五档，但目录总窗口仍为 272000。应用现有显式 `context_window` 可使用官方已声明窗口，`endpointOutputLimit` 继续约束实际输出。沿现有公式，本组参数推导 trigger=879000、historyReserve=171000、toolReserve=21000、keepRecent=65536。复用 `packages/contracts/capacity.ts`，与 Rust 对应实现核对相同推导，禁止另写一套经验阈值。

现有两项费率是配置折算。对本组覆盖长输入的 Standard 请求，建议暂以输入 `5`、输出 `15` 美元/百万 tokens 记录保守估算，在文档中明确其含缓存写入及长输入的上界口径。页面会分别序列化为 `5000000`、`15000000` 微美元/百万 tokens。官方短输入普通费率为输入 2、输出 10，缓存及 >272k 输入另有档位。本轮已核 `modules/runtime/model_calls/store.rs::model_cost` 使用 `ceil((input_tokens × input_rate + output_tokens × output_rate) / 1000000)`，结果单位为微美元。实施时核对新消息冻结的实际费率版本，以真实 usage 记输入/输出，供应商账单另行对账。不得新增金额限制或精确分档计费框架。[价格依据](https://developers.openai.com/api/docs/models/gpt-6.1-sol)

### 4.4 Pi 复用与协议验收

已有 SDK 默认 `store:false`，通过原生 Responses 保留 reasoning encrypted_content、工具 call_id/result 和文本 phase。当前原生转换默认 `strict:false`。保留原生形状，避免自行拼第二份消息历史或新建 OpenAI SDK 调用链。

本轮实际载荷探针已确认该型号的有效 high 由 `input` 中末次 `configuration_update.reasoning.effort=high` 传递，顶层 `reasoning.effort=medium` 是 Pi 目录兼容策略的固定值。验证须核有效配置项及原生历史中的 `providerThinkingLevel`，不能只断言顶层等于 high，更不能据此手改 SDK 请求。上下文整理沿 Pi 的应用侧原生压缩，现有接入无需启用 Responses 托管自动压缩或 `/responses/compact`。实际探针见 `.local/checks/provider-delivery-audit-20261106/openai-plan-check.json`。

先扩展现有 `configured-model-capabilities.mjs` 与 `check-configured-provider.mjs` 的所选型号/原生协议接缝，证明以下行为。

- 实际请求使用 Responses、所选 model、高思考档和实际输出 cap，既有窗口覆盖送入 Pi 容量规划。
- 合成端点返回原生工具调用，真实 Pi/已有工具执行后回交同一 call_id，再产生正常最终答案。复用已有多轮工具 fixture 和 deliver harness，避免为每种字段新造测试服务。
- 同服务多轮保留原生推理项和工具关联，切换服务修订沿现有隔离行为处理。
- usage 中输入、缓存、输出与现有原始回执口径一致，推理消耗已包含在 output 内。

若实际 payload 显示本次所选配置不兼容，就在现有适配边界最小修复。正确参数可由当前管理合同表达时，直接配置并验证。不得以“所有已知型号的 API 一律相同”为假设增加全局拒绝，也不得复制 Pi 整份目录到 Rust。

## 5. 交付与说明精度核对

### 5.1 已完成接缝按影响复用

本轮 `check-answer-state.mjs` 已通过 21 项。上一包真实 Rust/MySQL 的自然正文、真正发布 leaf 恢复、混源及受限历史检查按匹配指纹复用。若本轮仅改 provider 日志和模型页面，开发期无需重新跑完整答案电池。实际修改交付代码时，再运行对应原接缝。

### 5.2 通知 scope 疑点只核一次

Oracle 提出 Node 冻结来源 query ID 命中和 Rust 原通知 scope 之间可能不一致。当前未证明正常入口可达。实施者可沿 `tests/mvp/check-result-notification-answers.mjs` 的 `mixed-frozen-cover` 现有接缝，定点检查“宽范围冻结答案含通知查询及通知原范围外来源”的正常流程。

先核来源裁决、route、成功 present 与 freeze 是否允许该组合。前置确实排除时记录实际阻断位置并结束，避免直改数据库伪造不可达状态。若确有合法完整反例导致提前结束，则复用 Rust 既有覆盖判定，在原回执或上下文边界交付本次通知的已核覆盖事实，Node 消费该事实。需要字段时先改同源 Schema，再改消费者。

修复范围限定在已证覆盖职责差异，保留每个任务原许可和实际来源。禁止删除原通知 scope 校验、合并 A/B 允许集或建立通用覆盖状态机。涉及新的产品规则或罕见复杂保护时，提交证据和取舍给用户，其余任务继续。若限定核对仍不能证明可达或不可达，保留未证结论并结束本包内排查。未证疑点不作为追加整套回归或无限延长本包的理由。

### 5.3 J19 已有 SQL，保留真实质量结论

本轮审计已证最终输入含实际 SQL。原正文仍把三类 valid/invalid 泛化过宽。现有资源规则已经要求说明与 SQL 一致，本包没有预定新的强制工具步骤或提示词堆叠。

第 6 节用 OpenAI 对同一来源、原七份未执行草稿和原题做针对性新 attempt。核正文实际列、各自统计粒度、时间/快照及零/缺失解释。原 SQL 无须为适配答案而变更，旧正文/attempt 保留。模型质量问题若继续出现，记录其具体差异和已交付材料，避免用工程规则伪装消除模型错误。

## 6. 验证顺序与真实执行

### 6.1 本地验证

诊断缺失和表单默认问题在原检查中取得 RED/GREEN。已正确的 Responses、容量覆盖和 high 表达补充通过证据即可。先核对 `.node-version` 并使用其锁定的 Node 26.8.1，本轮四项本地检查已在该版本重跑通过。当前模型管理、原生协议和答案状态检查入口如下，按本轮改动选用。

```sh
node tests/runtime/check-configured-provider.mjs
node tests/runtime/check-answer-state.mjs
node tests/mvp/check-model-configuration.mjs
```

修改交付范围时才扩展到原通知单案例或相应恢复分支。

```sh
node tests/mvp/check-result-notification-answers.mjs --case=mixed-frozen-cover
node tests/mvp/check-task-query-answers.mjs --mixed-owner
node tests/mvp/check-task-query-answers.mjs --natural-recovery --history-permissions
```

保存原成功检查的输入/代码身份和日志。DB harness 串行。子 shell 先清除真实 provider 环境变量，真实凭据只由授权的真实服务分支读取。Rust 有修改才在连贯边界分别重建 API 和 Worker，并核实际二进制；纯 Node 或文档变更无需反复重建 Rust。

合同变化先 `npm run contracts:generate`，再 `make verify-contracts`。连贯工程边界执行 `make verify-code verify-architecture`。页面变化沿原浏览器脚本核保存、选择、密码不回显、超级管理员可见及正常刷新，保相称截图。无需重跑全部移动端和无关页面。

### 6.2 真实验证以两个代表流程为主

沿原 09 隔离库、公共集合、合成语音资料及已批准执行窗口启动，保原 trial、账本、费用、unknown 和所有旧记录。禁止将试用服务改成日常默认实例。保存运行版本、配置版本、实际 provider/model/协议、usage、正式输出和来源身份。

**DeepSeek 交付代表**

完成派发诊断后，选择一个原授权合成查询，通过正常用户消息、保存草稿和明确执行产生一次新的结果通知，并让真实模型解释结果。复用原材料与条件，原已执行/失败/未知操作保持原身份，不手工重发旧通知。确认正式答案、普通刷新和后续读取。

这条流程负责验证实际结果唤醒与共同派发接线。确定性的混源组合由现有工程接缝证明，真实模型无需为命中测试而被强迫选择多来源。若用原已有结果的普通辅助消息代替，只能报告普通读取交付，自动通知缺口仍须单列。

出现失败先读取新阶段诊断，判断宿主、provider、业务拒绝、未知或内容问题。找到新的普通工程原因后修受影响点，再做针对性复验。相同失败且没有新增证据时结束该分支，保具体缺口。

**OpenAI 工具与解释代表**

通过原超级管理员入口保存 OpenAI 服务和模型。在对话中显式选定该型号及 high 档位后，以新用户消息创建运行，复用原任务、七份草稿和合法来源，核对新消息的宿主冻结 profile。旧 J19 消息的恢复或重试继续使用其原冻结配置。先用 J19 原题作一个新 attempt，核正文准确描述已有 SQL，并正常正式保存。

在同一对话追加原定的一次补充追问，将下列占位符替换成原日表草稿的真实 query_id。

> 请通过现有只读查询工具，读取日表草稿 <原 query_id> 当前已保存的 SQL 和执行状态，再解释它实际输出的计数列，保持未执行。

该追问沿正常权限和 route 路径，承接真实模型 → 工具 → 模型续答的验收。作为接入补充观察单列，原题成绩按原断言保存。检查续接仍在同一 Pi 会话、模型/思考档正确、原 SQL 与执行状态按原身份保存、usage 和结算完整。

解释精度与工具往返分别报告。J19 正确但未调用工具时，解释精度按实际结果记录，工具往返记为尚未覆盖。若上述一次明确读取的补充追问仍未发生真实工具往返，保留未验证结论，按第 7.3 节停止该分支，不重复原题追求命中。

OpenAI 成功证明该配置下的这组行为，DeepSeek 历史 A03 的底层原因仍按其证据表述。若首个调用出现认证、型号不可用或额度拒绝，停止对应 OpenAI 分支，交付其他已完成工作及精确所需输入。

两条代表流程之外，只根据新工程证据增加必要复验。没有新原因时不重跑全部 21 核心、100 题、十轨迹或后台整理队列。8MiB/600 秒只是已配置并通过本地容量合同，真实极限能力维持原后置标记。

## 7. 文档、独审与 09 出口

### 7.1 本次记录

更新 CURRENT 的目标、范围和当版证据。主 09 继续沿原 increment。保留原 27 项要求映射，CURRENT 已增加 provider 诊断/协议和 OpenAI 管理两项原有命令入口，共 29 项。实施者补齐新断言并在冻结前核验绑定命令确实执行它们。真实新 attempt 单列实际结果，不能只凭固定核心表已全 pass 关闭 09。

本包需求主要关联 D03、D07、D09、D16、D17、C01、C04、C05、C07、C08。原要求继续按实际覆盖引用。开发期的检查结果可以复用有效证据，正式出口仍按已有项目流程执行。

`docs/development.md` 和模型配置相关设计补 OpenAI 的实际配置入口、型号、容量、思考档及费率含义。README 只更正当前使用说明和状态。架构职责和链路无变化时沿用现图；发现图中具体过时边或标签才更新相应源与渲染。

### 7.2 一次限定独立审查

冻结本轮 delta 后，由未实施相应代码的审查者核对实际变化、原要求及证据。保留继承未提交文件，按本轮基线确认范围，避免把整个历史工作树当作新增改动。

独审重点为发送前诊断能否定位、敏感信息是否受控、未知回执是否仍保原身份、Pi 复用、OpenAI 实际配置和原生协议、普通正文/通知/冻结来源是否受影响，以及是否新增无依据保护、重复校验或测试堆积。报告遵循 `scripts/check_delivery.py` 的现有格式；实施者不得自签他人结论。新缺陷补修后仅复审受影响部分。

### 7.3 完成与有据停止

1. 工程通过、必要真实代表通过、当前 review 指纹有效后，执行一次 `make verify-increment`。它会实际运行已绑定检查，按当版结果更新状态，再以 `make verify-delivery`核关闭记录。
2. 必要真实项仍缺凭据或失败时，完成受影响工程检查，CURRENT 保留主 09 active、对应真实缺口和明确下一动作。此时不运行已知必败的完成 gate、不生成完成收据。
3. `make verify-materials verify-delivery` 可用于文档和增量声明核对，其结果只证明静态记录。
4. 收尾核自有进程、权限和临时 expiry。只停止本轮自有隔离服务，恢复本轮临时设置，保留真实费用、预留和新模型配置的已授权持久成果。
5. 最终交付列出实际修复、删除内容、检查与真实调用的区别、OpenAI 配置状态、J19 精度结果、A03 当前链路和历史未知、09 状态及阻塞。达到完整出口或有证据的停止条件后结束本包。
