# 本地试用收尾执行包

编制：2026-11-13。当前目标与实际完成状态只在 [CURRENT](../../CURRENT.md)。本包接续已完成工程实施的 [project-closure](project-closure.md)，处理真实解释、聊天执行验收和本地整套验收三个缺口。用户最新决定：**先使用现有本地环境**；本轮不建设阿里云、GitHub Actions 或其他部署设施。

审包状态：本轮 Oracle 最高 Power 5/5 已完成，结论为“必要小修后可执行”。候选状态复用、同实例浏览器采证两项必要修订已在本地核实并纳入 §5、§7；审查/验收顺序及计数口径也已说明。详见[审包记录](../../reviews/local-trial-package-review-20261113.md)。最终修订未再次发送 Oracle，不称为其逐字批准。编包与审包不代表以下产品代码已实现；旧报告锚点与指标/诊断分离修复保留，不重开九阶段。

## 1. 入口、顺序与完成层次

启动只读 `AGENTS.md`、CURRENT frontmatter/最新摘要、本包 §1–3。随后按当前任务读对应章节和源码。使用 `dev_co` 接续现有目标；行为改动用 `tdd` 的最小反例，确实改变跨语言合同才用 `contract-first`。不先通读 CURRENT 历史或全部执行包。

| 顺序 | 本次工作 | 完成证据 |
| --- | --- | --- |
| 1 | 固定证据、修正当前结论 | 原报告和失败收据保留，SQL、文字、交互与环境结论分别记 |
| 2 | 一般性的结果解释约束 | 实际 provider 输入包含规则，原度量/诊断不改；真实效果另测 |
| 3 | 原题走聊天授权的代表入口 | 无费用协议测试通过，明确消息授权、原查询结果解释和刷新一致 |
| 4 | 定位本地验收超时、取得当前工程证据 | 有原因与对照的局部修复或明确阻塞；满足条件后完整绑定验收 |
| 5 | 本地候选、一次真实代表及交接 | 候选命令/端口/版本明确；费用按有效授权；独审与残留限制明确 |

连续完成可进行的工作；一个检查通过不要求再等批准。付费、改变日常服务或其他权限缺口只阻止对应动作，不阻止工程、协议验证和候选准备。没有证据时不能宣布 09 完成，但也不把本包扩大为无限修复队列。

分别交付三层结果：①工程候选与局部验证；②当前完整绑定验收；③真实模型效果与本地试用。三者不能互相替代。一次真实代表也不能代表全部 100 题、所有模型或真实数据平台。

## 2. 有效约束与改动边界

- 保留全部已有未提交工作。接手重新核根目录、分支、HEAD、dirty 文件；不 reset/clean，不把另一 checkout 当当前主仓库。
- Pi 仍是唯一 Agent、工具循环、会话、压缩及恢复机制。每消息 24 次模型调用、连续临时失败 3 次、原 operation/origin/budget 保持。正常新用户消息有自己的预算；其结果唤醒沿原执行消息预算，不能转移旧副作用身份。
- 修已证的一般原因。外部边界一次校验；内部复用类型/合同。只用一次的简单逻辑就地写；不另建调度、评分、上下文或语义等价框架，不为理论极端场景增加保护层。
- 允许主要落点：`apps/agent/session/resources.ts`、现有工具说明、`tests/mvp/run-business-acceptance.mjs`、直接相关测试及文档。超时若定位到产品缺陷，只改原 owner/调用链；扩到新的模块职责前先说明证据与范围。
- `scripts/evaluate_business_sql.py` 的原独立参考与判分不改。合法 SQL 形状未被识别时如实标无法自动判分；不得改 SQL、期望值或删列求绿。
- 不重做报告锚点、共享检索、Pi 日志或查询准备续租。只有当前反例指向这些实现时才修相应原因。
- 不读取或发布密钥。当前包不授权新付费、提交推送、部署、停别的项目进程、重配 Defender 或覆盖日常服务。用户后续的明确授权按其实际范围执行，不重复问已获准动作。
- 当前试用仍是合成平台/合成业务材料。聊天模型、embedding、Mem0 各自的外部调用和费用分别记录；不能把“本地”当成不产生 API 费用。

## 3. 接手事实与证据固定

编包时 HEAD 为 `04d27d06ba7b97d4cf3e288d4cf9e6300ef491a9`，分支 `codex/semantic-maintenance-prototype`。这是大量未提交工作的基线，不是全部当前实现的提交版本。编包前快照与哈希在 `.local/audits/local-trial-package-20261113/`。

| 已核事实 | 依据与准确结论 |
| --- | --- |
| S02 数值已正确 | `.local/model-workflow/business-result.json`：`machinePassed=true`，独立结果 `[[5,1,1,1]]`，13 次官方请求；397 项源码哈希在编包时全部匹配 |
| 文字含越界推断 | 同报告解释：“正式客户数不含匿名支付者，故实际有付款行为的范围比 5 更大”。匿名记录可能来自已知的 5 人之一，严格大于 5 没有依据 |
| 真实链走了兼容确认接口 | `run-business-acceptance.mjs::confirm` 调 `/queries/{id}/confirm`；S02 原文是“等待按钮确认”。它不证明当前聊天授权执行流程 |
| 完整工程验收未通过 | `.local/delivery/I3-SEMANTIC-DOGFOOD-result.json` 为 failed；33 组执行到第 11 组，多目标查询结果唤醒在内部 20 秒等待超时 |
| 环境唯一根因尚未证实 | CPU、netext、MySQL 的历史观察是线索；没有充分对照证明只因宿主饱和，更不能因单跑绿就排除测试间干扰或时序错误 |
| 旧修复有独审证据 | [project-closure 实现审查](../../reviews/project-closure-implementation-review-20261113.md)保留原范围结论；新范围不能复用其指纹关闭 |

开始改动前，给本次输出建唯一 `.local/checks/local-trial-<时间>/` 目录，保存 before 哈希、报告及失败收据引用、当前进程/端口与构建身份。只收集本任务所需材料，不复制整个 `.local`、凭据目录或浏览器资料。

旧 `business-result.json` 默认会被 runner 覆盖；本轮新代表必须采用 §5 的独立输出，旧报告字节、失败 SQL、费用/预留与 trial 均保留。旧样本是“数值 pass、解释有缺陷、聊天路径未覆盖”，不改写成未运行或整体通过。

## 4. 修正结果解释的一般原因

### 读取与责任

先读 `resources.ts` 的指标/诊断段、`tools/data-tools.ts` 的相关说明，及旧包 §4 的实际正文交付证据。已确认完整定义能经 v2 回执交给 Pi；没有新的丢正文证据就不改检索、存储或压缩。

当前规则虽禁止把未知值折成总量，但真实回答在解释阶段仍把“存在匿名订单”推成“新增客户”。可以确认错误类型是实体识别与集合关系缺失时的越界推断，不能确认唯一根因是提示缺失。规则应覆盖 SQL 生成后的最终解释，并原位协调已有“总量或上下界”一句，不能仅要求保存 SQL 前核对，也不重复叠加提示。

### 最小实现

在已有段落中收紧这一个一般原则，不追加重复规则库：**记录存在不等于新增实体；身份缺失不能证明不同于已知实体，也不能证明多个缺失记录对应不同实体。只有去重键、粒度及包含/互斥关系足以支持时，才能合并实体数或给出精确值/严格上下界。**

保持可推导结论：本题可说“已知客户 5，存在匿名订单，实际去重人数无法确认”；不能说实际人数必定大于 5。已知 5 人可支持“至少 5 人”，不一概禁止有依据的界限。订单、行数和人数分开；不能把“不能识别匿名人数”误写成“无法回答已知客户数”。

不改合成资料去迎合输出，不写特定句子黑名单，不强制每个问题澄清，不增加第二模型评审或模型答案自动改写器。允许在有明确、不重叠实体依据的其他题目中正常求和。

### 证明什么

1. 用现有工具/规则装配接缝证明当前实际 provider 消息中保留完整口径和更新规则；覆盖实际 v2 路径，兼容 v1 说明不矛盾。字符串检查只证明装配，不宣称语言质量已改善。
2. 复用 `check-business-evaluator.mjs` 核原 Q02 与变体不变。已过期或受影响则重跑，否则记录有效来源。
3. 给后续独审固定三个简短判例：身份未知可能与已知重复；多个匿名订单可能同一人；明确证明互斥、同粒度的两个集合可相加。它们用于核规则是否过度限制，不建新的评测框架、不反灌到原题业务资料。
4. 真实模型是否改善只由 §7 的实际代表说明；若仍错，如实保留，不继续堆提示和付费求绿。

## 5. 补齐自然聊天代表入口

### 复用位置与兼容

在 `tests/mvp/run-business-acceptance.mjs` 复用 `fresh/ask/execute/verifySql`、harness 与原结果等待。保留现有默认 16 题及旧确认路径，标明它验证兼容接口，不再称它覆盖聊天执行。

新增一个明确的代表模式，建议 CLI 为 `--interaction conversation --cases S02 --output <唯一文件>`；这些参数**须先实现和测试，目前不可直接执行**。此模式限定已说明的 S02，不悄悄改变原 16 题的题意或质量分母。现有默认行为继续可用。`--output` 不覆盖已有输出；预先创建并确认本次文件后，后续只更新本次报告。

参考 `.local/checks/query-submission-implementation-20261110/run-real-representative.mjs` 的自然链与断言，但不能执行其硬编码旧 trial、库和输出，也不整份复制成第二套 runner。正式测试应进入 tracked `tests/`，`.local` 只存本次数据与证据。

### 固定交互

原题必须是：

> 查2026年1月整月支付客户数，保留未知客户边界。请先给出SQL草稿，等待我明确要求执行；此时不要提交查询。

获得本次 Pi 自主生成的新有效草稿，并按原 Q02 独立校验通过后，发送：

> [task:实际任务ID] 请执行刚才的SQL，时间及其他条件保持不变；完成后直接解释这次查询的原始结果。

任务 ID 只作既有路由标记，不夹带答案、SQL、工具顺序或绕过授权。禁止调用旧 confirm HTTP 接口代替这条消息，不人工调用 execute_query 替模型完成，不手改模型 SQL。

### 必须观测的链路

- 草稿阶段平台实际 submit 为 0；独立校验针对本 attempt 实际保存的 SQL/参数。
- 明确消息后：Rust 持久授权绑定这条 message_id、原 query/task/condition/draft 和本消息 budget_scope_id；结果通知继续沿该执行消息的预算。
- 平台实际收到一次 submit，且指向该查询；不能只数幂等处理后的平台记录。旧的未授权或旧版草稿不顺带执行。
- 结果通知经 Pi 正常读结果、生成解释、正式提交；流式、最终持久正文、重新取 snapshot 一致。API 轮询观测不能冒称真实浏览器验证；至少一次用本地浏览器刷新同一候选对话，核正式正文/查询卡，不再发模型消息。
- 结果值、单位、口径、来源和未知边界分别独审。样本报告中 SQL machine pass 与 semantic review fail 可以同时存在；不能将数值绿灯当作解释已通过。
- 原续聊仅在结果含已知/匿名两个分组及原规定度量时进入，至多一次，沿同任务/同结果、不新查询。前提不满足则记 `not_run_precondition_not_met`，不换题凑覆盖。

**浏览器接线已定位：** `harness({web:true})` 已提供 `h.url`，不另起一套开发服务。新模式沿此接缝对本次同库、同 conversation、同冻结候选做浏览器核验；登录沿现有测试办法，令牌不进报告。在 `h.close()` 之前读本次正式正文/查询卡并刷新，随后才保存完整采证结果并关闭本次进程。现有 `keep:true` 只保数据库，不保服务存活；不得先 close 再打开日常页面充当本次浏览器证据。记录候选指纹、库、conversation_id、API/页面地址与观察时点。解释失败后只停止追加模型消息/查询，已有输出的只读采证、报告落盘与资源收尾仍须完成；浏览器失败与原语义失败分别记录。

先以 `--check`、本地协议模型和真实隔离 MySQL 跑通该模式，明确 `officialRequests=0`。协议 fixture 只安排模型动作来验证宿主链；固定回复不算真实语言能力。非法输出路径/既有文件应在任何付费请求之前拒绝。`--audit --quality-review` 的现有全 16 题门槛保留，单代表不能冒充完整官方测量。

新模式复用非空 trial 时，保存账本 before/after，区分本次请求/费用增量与累计值。当前默认 runner 的 `officialRequests` 来自累计 `ledger.calls`，不能把旧 13 次算成本次新增请求。真实派发数量与本次预算分配/结算分别据已有 trace/账本说明；只补新模式的报告口径，不改旧报告、改旧费用或另建计费系统。

## 6. 本地整套验收超时：有界定位与修复

### 起点

先读失败收据指向的第 11 组日志，以及 `check-conversational-query.mjs` 中 `多目标查询结果唤醒` 周围的 pause/resume、finish 和 captured 选择。`harness.mjs::until` 默认 20 秒；外层命令没有达到其超时。恢复/换代是否使 captured 选择找错 run、上一个通知是否仍占会话、后台 query/outbox/lease 是否推进，要据事实核对。

历史日志可能有敏感本地路径，只作本地调查，不整包外发。一次最多围绕一个假设收证据：现有日志不足时，在该测试失败出口保存该隔离库的必要 query/job/outbox 状态、run/attempt/预算关联、相关进程是否存活及有限时序。沿 owner 或测试只读 SQL 观察，不增加产品监控框架。

### 执行顺序

1. 先复用当日已有单跑/串跑证据，不再盲跑 33 组。核失败序列是否同输入、同二进制，以及每条 harness 的 finally 是否真正退出其子进程/连接；MySQL 内存与 NAT 延迟同采。
2. 必要时做一组“最小失败前缀＋目标场景”和对应的独立目标对照，串行执行。若不能复现，记录差异，不无限重复等安静窗口。
3. 若是测试间残留或 captured 选择/同步前提错误，修本测试或 harness 对应原因。若产品在正常唤醒/恢复中不再前进，修原 owner 的一般原因并保留 RED/GREEN。
4. **等待预算不是业务 SLA。** 若有对照记录目标事件或正确终态实际到达，只是测试 20 秒低于该固定场景的合理等待，可以局部设定有依据、仍有限的测试等待；在 CURRENT“验收与要求变更”记录旧值、新值、测量依据及影响。CPU 高或中间状态变化本身不够。不得整体放大所有 timeout、延长产品租约或删幂等/结果断言换绿；没有目标事件正确到达的证据时不得归为“只是慢”。
5. 环境饱和证实且不能在当前授权内解除时，留当前失败收据、具体观测与下一条件。不要停其他项目任务、关 Defender 或批量删历史库；需要用户环境动作时先完成工程候选再提出具体需求。不能把各组分别通过拼成整套通过。

本包目标是当前 33 组原要求加本轮必要验证的有效结果；保留现有命令和需求映射。新行为的本地代表协议检查绑定新增验收，不能替换旧组。局部稳定且已取得当前范围独审后，再执行一次完整 `make verify-increment`；失败根据新证据处理，不循环全量。

## 7. 本地候选与真实代表

### 无费用的候选准备

先核当前日常服务的 PID、端口、启动参数、可证明版本；CURRENT 历史写有 19173，也有更早的 27173，不能按旧端口猜测或先杀进程。确认 `docker --context colima-data-agent` 的基础服务。数据库 harness 串行；Rust 变更后分别重建 API/Worker，并核新二进制身份，不能混用旧文件。

在子 shell 内清除真实 provider 环境变量，沿现有 `scripts/development.py` 准备独立端口和 runtime 目录；不再建启动器。可用以下**现存参数**先做 mock 启动检查，端口偏移须在实际检查空闲后确定：

```sh
python3 scripts/development.py --model mock --memory builtin --retrieval lexical \
  --public-content-retention latest_only --tool-contract-version 2 \
  --port-offset <已核空闲偏移> --runtime-dir .local/checks/<本次目录>/runtime --check
```

这只证明本地启动，不证明 hybrid、Mem0 或真实模型。候选实际模式和能力缺口必须列清。真实试用沿现有已获授权 profile/数据库使用 DeepSeek Flash/high、hybrid、Mem0、latest_only、工具合同 2，不静默降到 mock/词法再称能力完整，也不自动把历史库当新建库。

**启动前固定实际状态对应：** 在本次已有记录保存解析后的应用库、trial、平台账本目录、模型配置解密文件位置（不含内容）、Pi 会话根目录及相关候选引用、进程身份与版本。`development.py` 用 runtime 子目录保存平台账本，而 `journal.ts` 固定使用仓库 `.local/pi-sessions`；`harness` 也默认生成新的 platform 目录和模型配置 key 路径。换端口/runtime 不代表这些持久状态均已隔离。

MySQL 和 Pi 原生日志共同保留；运行目录不是缓存清理目标。复用非空 trial 库时，核清旧查询与原平台账本的对应，沿原模型配置解密文件和会话引用接回；不能静默把原平台账本替换成空目录，也不能用新 key 代替该库原配置密钥。优先使用已有 harness 配置接缝；确实缺少平台目录注入时，只补该 runner/harness 的一个明确参数，不新建状态搬迁框架，不复制整个 `.local`。

确认没有仍在推进该库任务或写入这些 Pi 会话的执行者，包括 Worker、已派发但尚未结束的 Pi Bridge/deliver；只看 Worker 已停不足以判断。共享 Pi 日志根目录本身不构成缺陷，不因此修改 journal。需要暂停已有服务但无授权时，仅交付独立无费用候选。原 S02 小夹具不得覆盖日常座舱语义；不为隔离改原 trial ID、迁走费用或清除未完成操作。

### 一次真实测量

先交付可审阅的具体命令、profile 身份（不含密钥）、库、端口、输入、预期调用范围和停止点，再核本轮有效费用授权。启动真实 profile 可能接回旧运行、处理索引或记忆任务；**启动前**就要核其可能费用，不能等发送代表消息才核。若恢复待办超出本次代表授权，先保留候选并明确缺口，不启动后再补授权。11月13日原测试 48 次/$1 的窗口不是任意未来运行许可；仍有效且范围覆盖才能沿用，不能自动延期、重建 trial 或清账。未授权则 `NOT_RUN_AUTHORIZATION`，工程与候选照常交接。

获准后执行 §5 的自然聊天代表一次，使用唯一输出；保留原错误样本。SQL业务失败、无法自动识别、授权/提交失败、解释错误、provider失败分别报告。SQL未通过即不执行；解释仍错则停止本次测量，不反复发消息补额或换模型求绿。符合前提才进行那一次原续聊。

真实报告单列：实际模型配置、输入源码指纹、消息/任务/查询/原操作身份、请求数与费用、原值与解释、浏览器证据、未进入环节。一次代表不是整套质量承诺。若模型仍有解释限制，工程可完成，但不能写“解释问题已修好”；说明已做改动、原样本结果与对试用的实际影响。

用户另行授权更新日常服务后，才用已验证候选参数替换本项目对应进程。更新前保存当前启动参数，更新后核构建身份、端口、配置模式、原会话读取及刷新；失败按原参数恢复，不清数据。不额外发送付费消息作为健康检查。

## 8. 验证出口与文档

本轮文档和测试可以直接完成。若仅改规则/Node测试，不为仪式重建 Rust；Rust 实际变化或二进制身份不符才构建。所有 shell 检查保留真实退出码，数据库检查串行。

基本检查（受影响部分必须有本版结果，其余按证据适用范围复用）：

```sh
(
  set -e
  unset DEEPSEEK_API_KEY DEEPSEEK_BASE_URL DEEPSEEK_MODEL DATA_AGENT_MODEL_PROFILE DATA_AGENT_MODEL_FAULT
  export PATH="$HOME/.cargo/bin:$PATH"
  make verify-contracts verify-code verify-architecture
  node tests/runtime/check-evidence-tool-shape.mjs
  node tests/mvp/check-business-evaluator.mjs
  node tests/mvp/check-conversational-query.mjs
  node tests/mvp/check-conversational-query.mjs --source-admission
)
```

新模式先实现后绑定真实 CLI：`node tests/mvp/run-business-acceptance.mjs --check --interaction conversation --cases S02 --output <本次新文件>`。精确输出路径写入本次记录；相同验收重跑仍给新报告身份，不覆盖已发布的失败证据。保留默认旧确认路径回归，其结果注明兼容接口。若仅改输出保存，也须有旧默认调用兼容证据。

- 更新 `README.md`、`docs/development.md` 中真实代表命令和证据解释：旧按钮链与当前聊天链分别表达；默认工具版本/正文保留策略须显式说明。无模块边界变化不重画架构图。
- CURRENT 只留短摘要、当前目标/决定、证据引用和下一动作。旧“真实未授权”、旧候选命令和“已确定CPU根因”标明已被后续事实修正；不删除历史。
- 保留原 33 组验收、原 requirement 和历史失败。补必要新验收；改变 verification_inputs 后，当前 review 标 pending，旧 passed 记录保留历史范围。实现冻结后由未实施者审查本轮精确差异与实际证据，不能由实施者伪造他人 JSON 或仅刷新旧 scope_sha256。
- 顺序固定为：完成局部验证与必要新报告→冻结实现、验收声明和验证输入→独审本轮差异及局部证据→一次完整绑定验收。独审此时不要求尚未生成的完整通过收据，也不要求真实模型语义全对。若真实代表此时未获授权，保留未运行后完成无费用工程出口；后续报告、代码或输入范围变化重新判断受影响证据，不手改旧审查指纹。
- `make verify-delivery` 只证明记录/需求覆盖；独审通过后才运行 `make verify-increment`。它不代替模型解释独审。缺少付费授权、原续聊前提或其他 09 要求时分别保留缺口，不把本包完成改成 09 全部完成。
- 未复现的新问题只记观察及影响；不得顺带建设云发布、SSO、通用评测、仓库整理或迁移整套历史证据。

最终交接包括：实际修改、测试与复用证据、超时原因的确定程度、真实模型是否运行及语义结论、本地候选启动/停止命令和对应 PID/端口、日常服务是否更新、剩余限制。详细实施记录写本包末尾或现有单一审查报告，CURRENT 只链接，不再贴长日志。

## 9. 实施记录

2026-11-13：以下保留实现冻结前已取得的工程证据。限定独审和随后完整绑定验收的最新结果见 CURRENT 及标准收据；不以本节局部绿灯替代整套结果。

本轮基线与原报告/失败收据的逐字副本在 `.local/checks/local-trial-20261113T075223Z/`；新本地分支为 `codex/local-trial-closure`，HEAD 仍为本包 §3 的提交，全部原未提交工作保留。原33组声明逐项不变，增加规则装配、CLI边界、自然聊天代表协议、固定fixture兼容、启动器等待五组，不替换原需求映射。

### 实际修改与验证入口

| 位置 | 本轮修改与证据边界 |
| --- | --- |
| `apps/agent/session/resources.ts` | 原位协调指标/诊断段，明确记录不等于新增实体、身份未知不证明互斥、匿名记录不证明彼此不同；约束覆盖最终解释，保留有依据的下界/集合合并。工具说明已引用同一系统规则，无需重复一套规则。 |
| `tests/runtime/check-evidence-tool-shape.mjs` | 实际provider消息装配先RED后GREEN，规则与原口径正文并存；新增资源文件哈希。只证明当前接线，不判真实语言质量。 |
| `tests/mvp/run-business-acceptance.mjs` | 新 `--interaction conversation --cases S02 --output`；默认16题及确认接口兼容。新模式核草稿零提交、消息授权、实际平台HTTP提交、原预算通知、Pi原会话与流式/正式/刷新；同harness浏览器在close前采证。复用trial时保原平台与配置密钥路径，费用分累计/增量/实际派发数，不重播种原模型目录。 |
| `tests/mvp/harness.mjs` | 仅新增 `platformDirectory` 注入，启动和平台重启共用；缺省路径保持，模型密钥沿原env接缝。 |
| `tests/mvp/check-conversational-query.mjs` | 仅在多目标通知段补有限采样：resume、首次pause前、finish后、失败出口，记录原查询/消息/预算/job/租约；20秒期限与原断言不变。失败后最多额外观察40秒只供诊断，仍抛原失败，不改判通过。 |
| `apps/agent/provider/synthetic-analysis.ts` | 协议替身识别本包固定执行消息，仍用真实宿主授权工具。默认16题回归暴露原v2 S01固定回答缺少原断言要求的加工来源解释，依据 `etl.sql` 的左连接/补零及业务说明3.2补齐“成功付款记录缺失时金额填0”；不改原题或断言。仅为可重复协议验证，不替代真实模型判断。 |
| `tests/mvp/check-business-conversation-cli.mjs` | 七个费用边界探针：无值的新CLI选项、无效交互/题目/缺输出/非法路径/已有报告，在读取profile前拒绝，原文件保留。RED/GREEN见本轮目录。 |
| `tests/mvp/check-business-conversation.mjs` | 同一runner的协议与浏览器验收，独立输出；官方请求0，单S02仍保留其他15题未测状态。 |
| `tests/runtime/check-business-protocol-fixture.mjs` | 固定策略的4项定向回归：S05明确净收入优先于泛称客户、S02仍查支付客户数，S01的v1/v2均保留实际资料支持的缺失/补零与未知边界。默认入口原S05失败及本定向GREEN分别留证，不冒称真实模型修复。 |
| `scripts/development.py`、`scripts/test_development.py` | 实测API健康事件在57.26秒到达后，仅将API启动等待25→75秒；其他服务仍25秒，业务租约/查询等待不改。新等待分配单测RED/GREEN，22项启动配置测试通过；旧失败与诊断观察保留。 |
| `README.md`、`docs/development.md` | 新旧交互模式、输出身份、原状态对应及费用边界；启动器默认合同1/archive，当前候选显式合同2/latest_only。无模块边界变化，不更新架构图。 |

### 解释规则独审判例

| 已有事实 | 允许的结论 | 不支持的结论 |
| --- | --- | --- |
| 5个已知去重身份与1条身份缺失记录 | 已知5人；至少5人；身份缺失者可能与已知者重复，实际去重人数未确定 | 因存在匿名记录，实际人数必定大于5 |
| 多条匿名订单，无法关联身份 | 分别报告订单/行数及身份缺口；可能来自同一人 | 每条匿名订单都新增1位客户 |
| 同范围、同粒度、各自去重且已证明互斥的两个集合 | 按已确认口径相加 | 一概禁止有依据的合并或上下界 |

### 有界超时采证

首次V1采证保留原断言并通过12项；采样在 `.local/checks/mvp-4ec504796fbb7b3a/multi-query-notifications.json`。首次pause前两条查询均succeeded/result_notified=1，通知job按原执行消息预算依次推进；两轮捕获约14.1秒、8.8秒。未复现旧超时，不据此确认CPU或Worker暂停为唯一根因，不改产品租约或20秒等待。原旧收据第11组确为等待超时；后续历史 `fullchain-10.log` 则是epoch `2 !== 1` 断言失败，旧“全部为超时”陈述不适用于全部实验。

V2另有一次原20秒超时，随后补同一批通知采样通过：`.local/checks/mvp-1ddf6d9b65502c5f/multi-query-notifications-v2.json`。第二次resume后的API回读曾耗时7.421秒，但两条查询均已成功且两个原通知job最终finished；这只是I/O/调度线索，不是NAT或CPU唯一原因的证明。保留原20秒以及全部提交/预算断言。最终版本从Worker恢复后计同一个20秒截止点，采样用时也计入，避免诊断隐式扩额；V1/V2分别在 `notification-v1-frozen.log`、`notification-v2-frozen.log` 再次通过12/2项。

候选启动为另一个明确观察：正常25秒截止失败；第一次临时延长观察75秒仍失败；第二次带本实例MySQL/PID状态采样的75秒观察在57.26秒收到正确API健康事件，并完成原页面/身份检查（`startup-state-observation.json`、`candidate-startup-state-observation.log`）。初始化前不会监听健康端口，采样中看到正常SQL执行，未看到待授予的元数据锁。由此只修启动器API阶段25→75秒；正式普通命令随后通过。不声称冷库或任意负载都能在75秒内启动，也不据该启动现象解释旧通知超时。

额外探查的旧 `check-synthetic-knowledge-reading.mjs` 在原退款分页fixture的初始断言失败（预期read_knowledge，实际先revise）；未到新度量用例。相关初始状态与分支未受本轮修改，文件已恢复到开工哈希；该探查不记通过、不替代原33组。本轮S01/S02/S05固定行为用新的 `check-business-protocol-fixture.mjs` 保留针对性回归，原失败样本与日志均保留。

### 冻结前验证

本节日志除另注均在 `.local/checks/local-trial-20261113T075223Z/`；调用为本地协议或mock，新增官方请求均0。

| 检查 | 实际结果 / 证据 |
| --- | --- |
| 契约、代码、架构 | `engineering-checks.log`：667双侧契约、fmt/Clippy、类型/Web构建、12项架构及锁序检查通过；最终fixture修改后的类型检查另见 `final-types-current.log`。未改Rust，不重建API/Worker。 |
| 规则装配 | `rules-red.log` → `rules-green-final.log`，原生Pi实际provider协议9项通过，含完整原Q02口径正文；只证接线。 |
| 独立判分 | `evaluator-cli.log`：13条参考、原反例与7项数据变体通过；判分器字节未动。 |
| CLI / 固定fixture | `cli-final-green.log` 7项；`business-fixture-green.log` 4项。CLI无值反例另有 `cli-missing-value-red.log`，S01/S05原失败保留 `default-16-red*`、`default-16-s05-red*`。 |
| 默认16题兼容 | `default-16-green2.log`：原默认入口完整16/16协议通过，官方0，不冒称真实语言质量或聊天授权覆盖。 |
| V1/V2聊天宿主边界 | 最终V1 `notification-v1-frozen.log` 12项；V2 `notification-v2-frozen.log` 2项，采样计入同一20秒预算。V2此前 `source-admission.log` 为原20秒超时，未删除；采样影响时序，不能据随后通过确认唯一根因。 |
| 最终聊天链与浏览器 | 首轮 `conversation-frozen.log` 保留；独审P2整改后以 `browser-history-red.log` → `browser-history-green.log` 核同名历史并存，最新完整报告 `.local/checks/business-conversation-ddb513e9-d8cf-43cb-aa22-23522913915f/result.json`。原题原授权句，草稿零submit、执行一次、原预算通知、同Pi会话、流式/正式/snapshot一致；浏览器用现有 `conversationStorageKey` 接缝按本次cid导航，保留两条题名前缀匹配的历史，当前查询卡/正式正文读取及刷新通过，收尾后进程关闭。原续聊前提不满足，未发消息/换题。 |
| 启动器 | `startup-wait-red.log` → `startup-wait-green.log`，22项配置/等待/收尾单测通过；正常命令 `candidate-startup-green.log` 通过页面和2个开发身份检查，API当次7.25秒、Bridge3.73秒、Web0.57秒就绪。 |
| 声明检查 | `verify-delivery-current.log` 通过，检查器16项通过；不当作38组实际验收。 |

### 限定独审整改

首次限定独审发现一个P2：以S02题目前缀点击历史，在复用原库时会同时匹配保留的旧S02与本次对话。原审查及其scope/patch逐字归档于本轮 `review-round-1/`。无费用协议先增加旧题名的历史夹具：RED时业务链通过、浏览器在conversation_read失败且匹配数2；随后沿现有历史浏览器接缝，用 `conversationStorageKey` 绑定本次cid再reload。GREEN匹配数仍为2、旧记录保持，实际读取的conversation/query/output与本次一致。该 fixture 只模拟历史碰撞，不冒称新运行了原付费库或真实语义。修复后重新冻结，交原独审者复核，未由实施者改写审查结论。

### 本地候选与真实代表

具体配置、命令及状态对应保存在本轮 `candidate.json` 与 `conversation-profile.json`。无费用候选使用独立runtime和端口：页面29173、API32780、Bridge32781、平台32790；mock/builtin/lexical，合同2/latest_only。它不证明hybrid、Mem0或真实模型。`--check` 启动后自行关闭；交互启动沿同一命令去掉 `--check`，Ctrl-C仅停止本次启动器及其子进程，数据与Pi日志保留。

原S02对应库、trial、平台目录、配置密钥文件及Pi会话引用已定位，详见本轮 `original-state-preflight.json`；原6项job与2个run均finished、查询succeeded、13项模型调用settled，没有发现该库待推进任务。新profile保留原trial/库/额度，未新建或延期。`trial-preflight.json` 核得 `budget_mode=request` 对应 `expires_at=null`、active、48次/$1上限、已用13次/136796 micros、预留0；空时间不是过期。本轮缺的是第二次测量的有效范围授权（`NOT_RUN_AUTHORIZATION`），不能把旧一次代表授权自动扩为本轮。原报告与费用字节保持，不以协议固定回复宣称解释已改善。`candidate.json` 中原隔离S02的核心runner命令仍是词法/builtin配置，未将它冒称完整hybrid/Mem0试用启动器；完整真实模式还须核对应索引、记忆持久状态和启动费用授权后才能启动。

当前日常服务仍在原PID与端口（页面19173、API22780、Bridge22781、平台22790、Mem0 22791）；其模式为DeepSeek/hybrid/Mem0/合同2/latest_only。它与独立无费用候选分别记录，未替换或停止日常服务。
