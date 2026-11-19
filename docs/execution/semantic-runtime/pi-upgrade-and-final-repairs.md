# 来源发现与两轮草稿收口执行包

本包收口两件事。第一，用户点名字段或资料时，Pi 发给模型的工具说明会讲清楚首批缺少目标时怎样查，以及怎样根据用户许可定范围。第二，合成用例能在真实存储里辨认两个正式字段和一个平台来源，按获准原文保存两版草稿。交付范围为工程修改和免费验证。真实模型能否自主完成原题，由原题复验判定。

## 接手与取舍

先读仓库 `AGENTS.md`、[CURRENT 最新节](../../CURRENT.md)和本包。在项目原工作目录核对分支 `codex/pi-140-final-repairs`、接手 HEAD `e12eb60`、工作树和相关文件内容。9 个前轮变更路径已逐项核对，另有更早的未提交成果。新增的 `tests/mvp/check-source-selection-cursors.mjs` 也属于这些成果。完整 Git 差异包含多轮工作。启动时记录本轮实际输入指纹，交付时单列本轮差异。执行包及证据更新于 2026-11-18。

| 已核实的基线 | 本轮用途 |
| --- | --- |
| 旧 API 在同一 MySQL 签发的精读 `rc1`，升级后交付原第二页的同一正文、修订和区间。结束旧消息，新消息在新的运行和恢复链里接回原任务，也读到同一页。普通旧游标及原操作重放通过。 | 保留现有 Rust 实现并做兼容回归。无关文档新增、换版、撤权和切任务均有对照。精读的整目录 SQL 由 1 次降至 0 次。 |
| 精读实际完成时 `exact=available`。没有定位的获准原文仍保留覆盖缺口，有效同批项可读。 | 保留原正负控及两种原文 owner、精确引用和最终权限复核。 |
| `check-request-context.mjs` 有 20 个场景通过、2 个在 v2 身份检索指引处失败。本地协议首个请求也因这处失败返回 400。 | 先复现，再改模型实际收到的说明。这个 400 来自本地测试供应商的断言。 |
| 仅在隔离探针补入缺失指引后，新结算场景才到达“应有一条”断言，实得三条。另一个仅运行该场景的诊断逐项核实这三条，11 次本地协议请求、两次精确补读、两版草稿、平台零提交。 | 正式通过要求仓库原入口整组退出 0，运行时清除诊断注入。该探针曾有一次整组运行在 worker 捕获输入时超时，收据保留。 |
| 实际 Flash/high 来源 08 的宽查首批 20/198，三项正式定义在第六页。任务只选了四个表目录，两次保存被 `waiting_clarification` 拒绝。 | 原来源仍为 `partial`。能确定第一次选错范围的位置。新的指引对真实选择的影响待独立复验。 |

本轮产品改动限 [dataTools 中 v2 的 search_knowledge.description](../../../apps/agent/tools/data-tools.ts)。测试改动限 [现有来源场景](../../../tests/mvp/check-source-search-admission.mjs)。用已有 [Pi 请求断言](../../../tests/runtime/check-request-context.mjs) 验收模型实际看到的说明。沿用 Pi 1.4.0 的工具选择、会话、恢复和压缩。身份搜索、排序、Schema、Rust 权限、版本绑定、操作身份和预算机制按当前业务合同运行。保留原问题、实际发送文本、独立参考 SQL、判据、50 条验收及历史结果。此次不涉及 Git 提交、推送、部署、日常服务或付费复验。

## 先补模型能看到的来源指引

1. 对照 `dataTools` 中合同 v2 的说明、`assertSourceSearch` 和来源场景中的本地 HTTP 接收端。用当前工作树重现请求检查失败，留下实际出站 `tools[].function.description` 和对应参数结构的合成证据。历史日志匹配输入时用于跳过重复调查。
2. 在同一条 v2 说明内改写。身份目录按空白分词，任一词可匹配，在知识对象和平台来源各自的序列中按稳定 ID 续页。已知表、字段或资料名时可以用限定名窄查。已知知识对象种类可用 `kinds`，找无知识对象的平台来源应省略 `kinds`。同名字段以 `source_keys` 区分目录和正式定义，`roots_complete` 表示这条身份的贡献根描述是否完整。目录身份与根都不授读取权。
3. 当 `bounded` 带 `next` 且所需目标仍缺时，Pi 可窄查或续页。任务范围根据当前用户明确的指令或该任务可合法继承的范围填写 `conditions.source_limits`。许可确实不明时沿用澄清。已满足目标就可以继续。限定字段原文使用回执的 `object_id/object_version` 构造 `source_selection[{object_id,version}]`，再用真实 citation 调 `read_source`。用户给定的来源限制始终生效。保留原说明已有的身份与取证各自的游标、原文类型与筛选、支持内容和完整性、个人资产续页等含义。
4. 用实际序列化请求验收声明前、来源就绪后和同会话恢复三处。身份查询的 `cursor` 与选择参数可用，未声明阶段仍隐藏正文读取。就绪时有 `read_source(citation)`。原首批 `bounded/next`、贡献根和对象版本进入后续请求，越权读取仍拒绝。保留现有断言。下方备选文案已通过两处来源测试和 Anthropic 投影测试中的全部 9 条既有文案正则。最终以实际 Pi 请求、完整工具与行为断言为准。产品文案用一般业务语言，样例名称、原题答案、固定工具顺序均留在测试层。

<details>
<summary>一条可直接试用的 v2 说明</summary>

```text
view=source_identity只列身份，未读正文，无语义召回。空白分词任一匹配，稳定ID分页。完整字段名、表名或文档名窄查。对象可筛kinds，无对象平台源按名/ID查并省略kinds。source_keys区分同名目录与正式定义，roots_complete仅述根是否齐全。bounded带next且目标仍缺，窄查或续页再按获准来源定conditions.source_limits，许可不明先问。限读原文用object_id/object_version填evidence的source_selection（version取object_version），取citation再read_source。不扩许可，不授派生知识/结构采用权。两视图cursor不互用。默认evidence遵来源门，kinds=document只取文档原文，平台原文不筛种类或选匹配table。hits按相关性返knowledge_entry/source_excerpt，用ref/citation补读，raw不可作知识ref。content_state指本项，support_state与supports_complete分别指支持交付、提取完整性，unknown仍可能有例外。search_coverage示覆盖，空结果不能判不存在。本人有效资产用query=*或asset_after单独翻页。
```

旧说明和这条候选的 UTF-8 大小分别为 1091 B 和 1084 B。此处只计算说明字符串，正式验收仍测序列化后的整个 HTTP 请求。

</details>

## 再修三条身份的夹具预期

先让指引通过，再运行正式的 `source-selection` 场景并保留首次到达 `checkSettlementContinuation` 的 `3 !== 1` 和三条实际回执。独立预期来自当前夹具的两条 `definitionId`、共同的 `source_id`，及查询不带 `kinds` 时的平台来源合同。可按需看 [目录 owner 查询](../../../crates/data-agent/src/modules/knowledge/store.rs) 与 [平台身份枚举](../../../crates/data-agent/src/use_cases/source_identity.rs)。

直接在 `settlement-rules-identity` 的消费位置替换“长度 1、取首项”。查询之前，按建夹具时的对象 ID、名称、版本和完整的 `{kind,id}` 根对构造预期。复用已有 `settlement.fields`、源名及建目录时用到的版本。断言采用独立预期，后续工具入参使用实际回执。只数三条、按返回顺序取首条、从 `rules.hits` 生成预期，都会漏掉此缺陷。

| 合成输入中的身份 | 必须断言的事实 |
| --- | --- |
| 两个正式字段对象 | 正好各出现一次，ID 集合等于 `settlement.fields` 的两个 `definitionId`，名称与版本对应各自夹具，`kind=field`、`roots_complete=true`。逐字段核对贡献根精确集合 `[{kind:"platform",id:settlement.source},{kind:"platform",id:"schema"}]`，含各自类型和 ID。按身份和集合比较，宽查询原有稳定顺序断言继续执行。 |
| 一个平台来源 | 本项同时缺省 `object_id` 和 `object_version`，名称等于 `settlement.source`，`roots_complete=true`，唯一根为该平台来源。从这条回执取得 `{kind,id}`，结合本轮合成用户明确指定的来源及 `origin_message_ids` 声明任务范围。DDL 虽出现在字段的贡献根中，任务允许集仅含用户指定的平台来源。用户只要两个字段时，后续仍按两个对象精读。 |
| 整页 | 三项都是 `source_identity`，无缺项、重复或额外身份。本夹具此查询已查完，核 `searched` 和 `next=null`。此前宽查的 `bounded / candidate_limit / next`、同名目录字段与正式字段的窄查断言保留。 |

继续通过同一入口走完两轮。选中版本和 citation 来自真实回执。首份精读只有两个获准定义和各自例外，把每个 `read_source` 的来源、修订、Unicode 区间和正文与其对应的精读命中逐项比较。下一次送给本地协议模型的实际请求中也应有这些回执，并无无关字段正文。核对真实存储的任务与条件版本、两份 SQL、参数、UTC、截点和替代关系。只换月份，五月稿 `superseded`、六月稿 `awaiting_confirmation`，两者 `not_submitted`，平台提交记录为 0。报告说明此处的动作和 SQL 来自脚本。11 次是曾观察到的请求数，不设为通过门槛。

## 按原入口验证并交接

用隔离 MySQL、现有本地 Milvus 及本地协议供应商串行验收。本机 Docker 上下文为 `colima-data-agent`。核对 API/Worker 与被验代码匹配后直接复用。若二进制确实过期，分别构建 `cargo build --offline --locked -p data-agent-api` 和 `cargo build --offline --locked -p data-agent-worker`。在用于全部验证的子 shell 中清除真实供应商配置及诊断注入，由每个夹具设置自己的工具合同。

```sh
export PATH="$HOME/.cargo/bin:$PATH"
unset DEEPSEEK_API_KEY DEEPSEEK_BASE_URL DEEPSEEK_MODEL DATA_AGENT_MODEL_PROFILE DATA_AGENT_MODEL_FAULT
unset DATA_AGENT_TOOL_CONTRACT_VERSION NODE_OPTIONS
run_evidence=$(mktemp -d "$PWD/.local/checks/source-discovery-XXXXXX")
mkdir -p "$run_evidence/selected-red" "$run_evidence/selected-green" "$run_evidence/default-green"
```

在指引修复、夹具尚未修正时，给专项命令设置 `DATA_AGENT_SOURCE_CHECK_DIRECTORY="$run_evidence/selected-red"`。夹具修正后，专项和默认组分别写 `selected-green`、`default-green`。分开保存真实退出码和完整日志，保留整组超时和单场景结果。

| 顺序 | 命令与通过依据 |
| --- | --- |
| 出站及两轮草稿 | `node tests/runtime/check-request-context.mjs`、`node tests/mvp/check-source-search-admission.mjs source-selection`、`node tests/mvp/check-source-search-admission.mjs`。含原先五次请求的用例及新场景都执行。从源码和真实存储核三条身份、两段原文、两版草稿、零提交。 |
| 原容量与 Pi | `node tests/mvp/check-large-tool-context.mjs`、`node tests/mvp/check-native-compaction.mjs`、`make verify-pi-transport`（已含 Anthropic 工具 Schema）。原 128 KiB 用例以默认 v1 的旧参数形状运行，两份各 8192 字正文逐字交付，六正文确实无法容纳时，超限请求发出数为 0。历史峰值 131057 B，仅余 15 B。原 96 KiB 用例显式 v2，核六轮同会话原生压缩、摘要/普通请求和原操作身份。记录本次实际序列化峰值及对应版本。在 v2 来源场景的现有本地 HTTP 接收端，逐请求累计原始正文 Buffer 的字节数，或对完整按 UTF-8 解码的 `raw` 取 `Buffer.byteLength(raw, "utf8")`。在现有测试收据记录请求阶段、合同版本、原上限 131072 B 和实测峰值。重新序列化 `providerRequests` 会丢失原始转义或空白信息。 |
| 来源与兼容 | `node tests/mvp/check-source-recall.mjs`、`node tests/mvp/check-source-limits.mjs`、`node tests/mvp/check-source-scope-equivalence.mjs`。用 `node tests/mvp/check-source-selection-cursors.mjs .local/checks/pi140-remaining.JBtWF18y/legacy-api` 验证真旧程序签发的两类 `rc1` 与新程序同页。旧二进制 SHA-256 为 `d025d96b13811ddc8ab84c999a65b759570fd1ed9325c851d2974f13fd0a3189`。普通无参入口只覆盖当前程序。若历史文件不在执行机，说明兼容实跑缺口并引用已有跨消息收据，继续完成两项修复。 |
| 工程与冻结 | `make verify-code verify-architecture verify-delivery`、`git diff --check`。将 CURRENT 的 50 个完整验收对象与冻结的 `original-acceptance.json` 深比较，复核原题/参考、两容量夹具、成绩和账本哈希。静态声明检查和既有核心 21 成绩各自报告。 |

发生容量失败时先核实际工具合同、HTTP 请求组成、原正文与超限路径。仅在本次 v2 说明内消除重复表达。保持原字节门、历史、完整正文和原生压缩条件。若证据指向其他模块，先交付该失败样本和必要的改动范围。测试中用过的内存注入和仅执行新场景的探针只用于定位。正式验收运行仓库中的原入口。

`original-acceptance.json` 比较源为 `docs/CURRENT.md` frontmatter 的 `delivery.increment.acceptance`，逐项包括命令参数、期望和时限。`baseline.json.hashes` 记录 `docs/dogfood/` 的 106 个、`docs/sources/` 的 67 个原输入。`original-record-update-integrity.json.record_sha256` 对应 `.local/dogfood-runs/qa-usability-20261116/` 中的 `results.json`、`trajectory-results.json` 和 `budget.json`。原 128/96 KiB 测试文件本身也核对冻结指纹。

完成后在 [CURRENT](../../CURRENT.md) 的“验收与要求变更”记录原单条预期、三条新预期、独立依据和对新合成测试的影响，再登记正式命令和未验项。验收结果绑定最终改动指纹，留给未实施者复核。**两项工程修改以正式免费回归通过为收口条件。** I3 另按原业务验收判定。 来源 08 原两句及获准前提需另有有效授权才用 Flash/high 复验。真实 OpenAI Responses/high 及 J19 正式解释另有证据缺口。此前逐条 49/50 对应上一版。上述业务证据仍缺时，I3 保持 `active`、完整审查 `pending`、完成收据空。原门与独审都具备后再执行 `make verify-increment`。

## 证据入口

本地可查 `.local/audits/pi140-cursor-implementation-20261118T172629-SaNOBQ/audit.json`（原题、前后指纹、同库及跨消息游标、两个红测和隔离诊断），以及 `.local/checks/pi140-closure-20261118/`（原 50 条绑定、原题取证、两容量日志、成绩及账本指纹）。正式业务边界见[实现设计](../../architecture/implementation-design.md)和[原验收记录](../../reviews/data-agent-final-closure-review-20261117.md)。

本次 Oracle Web 以 Power 5/5 审核了两项实施顺序及其证据，结论为“可执行”。终稿采纳了两条具体修订。三身份的预期值取自查询前的夹具，平台来源同时核对两个对象字段均缺省。v2 容量按接收端原始 HTTP 正文字节取证，并记录版本、阶段、上限。本地已逐项核对 owner 查询、平台枚举、合成回执与接收端代码。Oracle 原答和确认记录在本机 `.local/audits/source-discovery-closure-20261118T180614-XHOv4S/`。此次审查对象为执行包，最终实现由未参与编码者另行复核。

## 交接 prompt

```text
在本机 Data Agent 原仓库接手“来源发现与两轮草稿”收口。先读 AGENTS.md、docs/CURRENT.md 最新节，再读 docs/execution/semantic-runtime/pi-upgrade-and-final-repairs.md。核对当前分支和未提交工作，按包连续完成两项修复。

先复现 v2 工具指引未进入实际 Pi 请求的问题，只改 search_knowledge 的 v2 说明，保留现有请求断言。再从正式 source-selection 入口复现 3 !== 1，用查询前的夹具事实精确断言两个正式字段和唯一平台来源。按用户许可和真实回执限定来源，两次定点补读后保存替代草稿，核实旧稿作废、新稿待确认、平台零提交。

按执行包串行跑隔离 MySQL、本地协议、原 128/96 KiB、Pi 传输、来源范围和真旧 rc1 回归。保留原题、判据、阈值、权限与 Pi 原生循环，正式运行清除诊断注入。收尾更新 CURRENT，交付本轮差异、原命令退出码、证据位置和未验项。此次授权为两项工程修改和免费验证。来源 08 和整体 I3 按原业务门单独报告。
```
