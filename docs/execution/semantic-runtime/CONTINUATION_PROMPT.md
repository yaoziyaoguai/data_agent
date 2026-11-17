# 本地全能力 Dogfood 交接

更新：2026-11-14。当前执行包：[dogfood-qa.md](dogfood-qa.md)；唯一状态：[CURRENT](../../CURRENT.md)。本次是100元人民币总预算的本地探索QA，只报告实际问题。Oracle最高5/5审包的三项必要修订已核实纳入，最终稿本地复核；详见包§9。下方历史实施Prompt不再作为当前执行指令。

```text
在Data Agent主工作目录继续，保留现有未提交工作。先读AGENTS.md、docs/CURRENT.md的frontmatter和最新短摘要、docs/execution/semantic-runtime/dogfood-qa.md §1–4；随后按当前能力阅读原语音用例、评分依据及对应章节，不通读全部历史。

用户已授权这次本地dogfood的产品API费用合计最多100元人民币，涵盖聊天、压缩/恢复/重试、整理、embedding和Mem0等全部通道。按方案先冻结真实费率、换算依据与所有持久子预算，总分配不超过95元、5元余量不自动分配。还要证明每次预留足够且新增外发先取得预留；所有启动配置显式绑定本轮资源，核全部trial次数/费用/有效期，按§3处理一小时到期，不能靠重启延期。优先沿现有Flash/high、hybrid、真实Mem0和正常大容量配置；每消息24次、连续临时失败3次不变。不得把100元当100美元，不给每个trial各100元，不换ID补额、不清旧费用。已有授权范围内不逐条请求批准。

使用本机已安装dev_co完成最小准备，随后实际加载qa-only/gstack-qa-only的报告模式（browser + functional），遵守其探索和采证流程。本包明确采用长程覆盖目标，不用默认15分钟替代整轮任务。只在本轮隔离实例/合成对象上操作；实际PID、库、平台账本、配置密钥路径、索引、记忆和Pi引用先对应好。不要更新日常服务。缺少受控预算的收费通道先阻塞，仍继续独立的可执行能力。

当前工程未全部收口：38组前12通过，第13有6个旧v2夹具失败，后25未跑；真实新聊天未验证。先做无费用资料/配置前置，再跑真实座舱S01→S02正常链。基础答案交付、权限或预算失败时停止依赖它的收费链并记录，继续独立UI/能力；不要为了开跑修夹具或重跑全套38组。

正常链通过后，按方案§5尽早做完整Skill链及一条复杂综合轨迹，然后按依赖与覆盖缺口交错展开各能力、原100项、10综合轨迹与至少6个有依据的自主探索；预算/依赖停止条件优先。G10清理在其他计划动作与证据落盘之后。保留各自完整分母、原题和断言。完整覆盖是目标，达到预算或缺前提的项目如实列未测，不能用mock替代真实能力。特别执行§6：让产品Data Agent依据实际分析生成Skill草稿，正常界面核对保存，新会话显式选用并完成另一个任务；核实际加载/使用、无自动执行授权、私人隔离、公共副本和停用。测试reference/expect/报告始终只给操作者，不能灌给产品、记忆或Skill。

只试用、定位、采证与报告，不修产品/测试、不改题洗绿、不安装全局技能、不提交推送/云部署。失败保留原始attempt，至多做一次有明确价值且安全的复现，不反复换话术求过。

唯一报告根为.local/dogfood-runs/<本轮run_id>/，按方案输出REPORT.md、原100项results、10轨迹结果、Skill链、探索记录、费用与运行身份，以及QA技能的截图/checkpoint/capture。数据正确、解释正确、交互完成分开判；真实模型、协议替身、真实存储、合成平台分别说明。根因未证实就写假设，不把所有超时归环境。

结束前用原grade.py检查记录完整性、核所有账本的已花/预留/unknown和在途，保留问题产物与Pi日志；只停止自己启动的进程。CURRENT仅更新简短摘要和报告入口，不复制长日志。即使环境或预算阻塞也给完整状态报告，最后告诉用户报告位置、最重要的问题、花费与未覆盖项，供下一轮定位修复。
```

# 历史交接：本地试用收尾（已执行，有未闭合验收）

更新：2026-11-13。当前执行包：[local-trial-closure.md](local-trial-closure.md)；唯一状态：[CURRENT](../../CURRENT.md)。用户最新决定先用本地环境，云与GitHub Actions已撤出本轮。Oracle最高5/5已审包，两项必要修订已核实纳入，最终稿本地复核；具体边界见执行包顶部及审包记录。

```text
接续Data Agent现有主工作目录，完成 docs/execution/semantic-runtime/local-trial-closure.md。使用dev_co；先读AGENTS.md、CURRENT frontmatter及最新短摘要、本包§1–3，再按当前任务展开源码，保留现有未提交工作，不reset/clean，不重开九阶段。

旧指标/诊断分离与报告锚点已实施，保留。当前三项缺口：真实SQL数值正确但最终文字把匿名记录推成新增客户；旧S02走按钮确认而非原题聊天执行；33组绑定验收内部等待超时且唯一环境根因未证实。按包连续处理一般解释规则、现有runner中的自然聊天代表模式、有界超时定位、当前工程验收及本地候选。

保持Pi唯一循环/会话/压缩/恢复、每消息24次和连续临时失败3次、原operation/origin/budget；不新建评分Agent、框架或部署设施。外部边界校验一次，不堆低概率防护/无意义helper。新行为先最小RED再GREEN；数据库harness串行，Rust真正变更才重建。默认16题兼容入口、原题/独立预期/旧失败/费用都保留，新代表必须写唯一输出。SQL数值通过不能代表解释通过，协议模型不能代表真实效果。候选要核应用库、原平台账本、配置解密文件及Pi会话/执行者对应；浏览器复用harness的web入口，在close前核同一对话。真实服务启动可能触发恢复和维护费用，必须在启动前核授权。

先完成无需费用的工程与具体候选。付费代表和日常服务更新只按本次实际有效授权执行；旧trial窗口不自动延期，不杀别的项目进程，不改变Defender，不提交推送。没有授权只暂停对应动作并给具体命令，继续其他可完成工作。原续聊前提不满足就明确未进入，不换题补查询。

保持原33组和要求映射；新增本轮必要协议验证。实现冻结后完成未实施者的限定独审，绑定当前指纹，再运行完整verify-increment，不拼零散通过、不篡改旧审查记录。源码、工程、模型语义、浏览器、本地服务各自说明证据；09未满足就保持active。

完成后交代改动、验证/复用、超时根因确定程度、真实模型结果或未运行原因、本地候选启动/停止命令及端口版本、日常服务是否更新和剩余限制。CURRENT只更新短摘要与链接，详细结果落在本包末尾或现有审查记录。完成本包后停止，不扩展云部署或额外评测。
```

# 历史交接：指标语义与报告定位（工程已实施）

更新：2026-11-13。当时执行包：[project-closure.md](project-closure.md)；审计：[全项目Oracle审计](../../reviews/project-global-audit-20261113.md)；唯一状态：[CURRENT](../../CURRENT.md)。Oracle最高5/5已给出“必要修订后可实施”，B1–B5已纳入；无需重开方案审计。下面旧Prompt仅留作历史，不重复实施。

```text
接续当前Data Agent主工作目录的收尾工作，执行 docs/execution/semantic-runtime/project-closure.md。保留已有大量未提交修改，不reset、不覆盖，先确认当前根目录、分支与HEAD。

使用dev_co。先读AGENTS.md、CURRENT的frontmatter和最新短摘要、执行包§1–2、§8及审计报告结论；后续按当前任务逐节读取源码/测试，变更前读受影响同源Schema、owner接口与保存合同，不通读1.4MB历史或重开九阶段。

本包两项具体修复：已确认指标与未知/缺失诊断不能混成未经确认的业务总量；报告卡片必须取得与事件分页无关的稳定历史锚点。先按§3固定当前输入、复用匹配证据，随后连续完成§4–6。当前交付是否丢正文先用真实工具接缝确认，没复现不改存储/检索/压缩。报告锚点按同源Schema和owner边界推进，RED/GREEN证明API、投影和浏览器实际行为。

保持Pi唯一Agent/压缩/恢复、每消息24次和连续临时失败3次、原授权/operation/origin/budget。保留失败SQL、原判分与变体，不改题凑绿，不为Worker身份查询候选加防护。数据库harness串行，Rust冻结后统一构建；只重跑受影响或证据失效的检查，不盲跑全量历史。

付费阶段按§7核当前授权；旧trial已到期，不能自动延期或重开。未授权就标NOT_RUN_AUTHORIZATION，仍完成本包工程、必要文档和可审阅候选。不要提交推送、更新日常服务或清理他人工作。Oracle方案通过不等于代码独审通过。

在CURRENT只留短摘要和链接，详细结果放现有对应记录；分别交代工程修复、真实模型、平台/浏览器证据和未验证能力。按§8完成相称检查和独立实现审查，不能把本包完成写成整个09完成。完成授权的工程收尾后交接。
```

## 历史交接：查询准备与试用收尾（已实施，真实代表失败停止）


更新：2026-11-10。唯一当前记录为[CURRENT](../../CURRENT.md)，本次范围是[查询准备与试用收尾执行包](query-submission-repairs.md)，根因在[诊断报告](../../reviews/query-submission-root-cause-20261110.md)。Oracle审包状态以该包顶部和CURRENT为准。原工具说明、控制投影、Pi工具门修复已完成，不重新实施下方历史Prompt。

本包工程及一次[限定独审](../../reviews/query-submission-implementation-review-20261110.md)已完成：有效领取并行续租、事务末尾自身核有效性后刷新、局部测试等待已落地，RED/GREEN、真实MySQL局部、默认v1、v2及query-text-authority有最终EXIT0。夹具和启动失败原样保留；不重做下面历史实施或重新Oracle审包。

本包已按有界结果停止，不自动接续§7或重跑驱动。用户在工程后批准原trial延期2小时，只改expires_at至2026-11-10 10:06:55.336 UTC，其余列在延期事务中完全不变。唯一新attempt `1d9a9d05-2bf4-4159-a188-4d064bfbad2e`在实际保存的新query `5faff637-ace6-4a85-a591-7a19966e2fa6`独立Q02校验处失败：新稿额外把已知客户数加匿名存在1作为展示度量，完整四列形状未获独立验证；原始结果[5,1,1,6]、expected_rows=null。所读定义要求COUNT(DISTINCT customer_id)，匿名不能补成统一客户参与UV。实际submit0，明确执行/自动结果解释/续聊未进入，不改SQL或独立预期求过。

实际10次真实DeepSeek请求、270182输入/7375输出tokens，新增89908微美元，全部settled；最终原trial为43次分配/366307已花费/348644原预留，原上限/指纹及旧失败、旧query/task/operation/budget均保留。详情在`.local/checks/query-submission-implementation-20261110/real-representative.json`、`real-representative-diagnosis.json`、`trial-final-state.json`和最终快照。后续只有收到明确接续指令才继续，先处理这次有证据的新增度量与独立校验边界，不重做查询准备续租或原交互，不复活旧稿、清账、人工执行或循环新建消息。

候选构建、原日常PID/端口和具体启动步骤在同目录`candidate-startup.md`及`daily-service-version.json`。日常API/Bridge/Worker仍11月7日进程，未更新；仅在当前实际授权下操作服务。09保持active/review pending/evidence null，OpenAI与其余09缺口不扩。已通过工程输入若未变不重跑，先核CURRENT与最终指纹；不提交推送，完成本包结果后停止。

## 历史实施交接（工程已执行）

以下为原实施规格导航，不作为再次开工指令。

```text
接续本仓库的查询准备与试用收尾，保留现有未提交工作，不reset。

先读AGENTS.md、docs/CURRENT.md的frontmatter和最新“查询提交与验收等待诊断”节，再读docs/execution/semantic-runtime/query-submission-repairs.md §1–3。按当前任务展开§4–7和源码，不重读九阶段或重做旧交互修复。使用dev_co；保持Pi 1.3.0原生能力和原业务合同。

本次Oracle最高5/5咨询query-preparation-package-20261110的完整答复已经用户回传，本地已采纳并核对“小修后可实施”的必要意见。无需重新等审查、咨询Oracle或诊断全项目，直接按以下范围实施。

本轮只处理两个已证问题：查询领取15秒后慢准备期间无人续租，导致平台提交前lease_lost；这条测试capture默认20秒会把仍在推进的消息误报超时。历史宿主迟延具体来源未知，不能归因Defender或只放宽等待掩盖产品缺陷。

按包连续完成：最小RED → M07原owner/epoch的有效租约续租，复用deliver_run的两个future并行模式，覆盖准备到提交事务交接 → 局部、明确的测试等待预算 → 相称回归和一次限定独审 → 原单条真实代表及成功后的至多一次续聊。

续租owner来自process_due的worker入参，不是job.owner_id。事务末尾刷新UPDATE自身核query/epoch/未过期，失败沿原事务回滚；15秒从数据库刷新时刻算，不承诺commit回包后仍完整剩余15秒。续租和交接刷新不额外增加submission_attempts，原queued→submitting计数保持。来源/权限/版本核验、原authorization_error拦截、平台5秒调用和unknown/cancel规则保持。不复活过期/换代领取、不重授权、不换query/budget；不要写成tick分支阻塞准备future，也不要抽通用租约/Agent恢复框架。

局部MySQL验证需覆盖续租条件和事务交接刷新/拒绝/回滚，复用原fixture。慢准备回归的同owner/epoch限制只覆盖准备和首次提交承接，后续正常lookup换代允许；以实际平台submit请求计数证明一次提交，不能仅看submission_attempts或去重后的单条平台记录。不新增复杂并发矩阵。

原控制投影、工具说明、流式、短游标与Pi压缩已完成，只按影响复用证据。新租约回归、默认v1、限定v2和query-text-authority按包执行；数据库harness串行，Rust冻结后统一重建，不重跑100题、29组或历史全量。保原业务断言，测试等待改动记录原值、新值及实测依据。

不堆推测性防护、重复校验、无意义helper或try/catch。旧失败、SQL、费用、unknown与预留保留。先完成无需延期的代码和工程验证，再按原包§7读回同trial当前窗口；确需延期才申请同账本必要窗口，不重复询问已授权服务、不清账或换ID。

真实代表必须核验本次保存的新有效草稿，Pi经正常消息自主执行并自动解释；不能人工route/执行或循环重开消息求通过。按CURRENT分别报告工程、真实代表、续聊和运行版本。09其余缺口保留active/pending/null；不扩OpenAI网络，不提交推送，不擅自更新日常服务。准备具体候选与启动步骤，完成本包后停止。
```

## 历史交接：任务续接修复（2026-11-10，代码已落地）

更新：2026-11-10。唯一当前记录为[CURRENT](../../CURRENT.md)，详细要求以[任务续接修复执行包](interaction-continuation-repairs.md)为准；审计和两轮Oracle最高5/5处置见[审计记录](../../reviews/interaction-trial-readiness-audit-20261109.md)，本包实施独审见[限定记录](../../reviews/interaction-continuation-implementation-review-20261110.md)。本包按失败停止条件停下，工程v1回归未闭合、真实代表未进入；下面仅为后续明确接续时的恢复入口，不将局部GREEN或独审无确定缺陷称为工程通过。

```text
继续本仓库的任务续接修复，按 docs/execution/semantic-runtime/interaction-continuation-repairs.md 连续完成，保留现有未提交工作。

启动先读 AGENTS.md、docs/CURRENT.md 的 frontmatter 和最新“任务续接与试用就绪审计”节、新执行包§1–3；按当前任务再读§4–8及相关源码。使用已安装 dev_co；涉及跨语言形状时沿 contract-first 与现有同源Schema。不要重读全部历史九包，不重新执行原六组修复。

基线为 codex/semantic-maintenance-prototype / 04d27d0 加现有未提交改动，先核对是否已有更新。两轮Oracle最高5/5审包及修订已完成。2026-11-10修复、消费者RED/GREEN、v2真实Rust/MySQL单/批量和一次限定独审已执行；当前停止原因见CURRENT顶部“任务续接修复实施”，不得重做下面已经完成的代码或继续无新证据重跑。

后续获得接续指令时，先定位默认v1未闭合回归：conversational-v1-after-diagnosis.log为EXIT1，query_worker_failure code=lease_lost，平台提交0；前一轮capture超时也保留。当前770ms MySQL读和零锁采样不证明失败根因。只沿归档的领取15秒查询租约→来源/权限preflight→提交前有效性边界取新证据，不单纯提高阈值、扩大测试矩阵或修改权限门。工程尚未通过，真实代表未进入；原trial已过期但延期不是当前唯一前提，不应先申请延期或付费试跑。

以下为原包实施顺序与仍须保持的验收标准；具体哪些已完成只看CURRENT：
1. 统一v2来源准入与执行说明。来源未就绪时先完成必要归属，只有宿主source_context_ready=true后才恢复工具、读回草稿并执行原请求。route成功本身不够；不自动补null、不改条件或重造草稿。v1直接执行兼容及批量确认/关联/授权的原事务保持。
2. 在原task-projection里保留task_context_required的可信固定hint及必要控制身份/版本/状态，仍隔离SQL、条件与旧正文。错误不解锁工具；Pi本地未知工具不伪造Rust回执。不要新增自动route、工具重试循环或恢复框架。
3. 复用两个既有测试接缝，先最小RED再GREEN。消费者测试接生产attachToolGate，在同一Pi会话/消息中经回执与必要刷新实际派发后续工具；v1断言必须实际执行。v2批量从两份未确认草稿开始，先非法后项证明零新增，再合法集合各一次提交，保原消息/预算和此前route基线。区别合同替身与真实Rust/MySQL证据。
4. 完成本包相称检查与一次未参与实施者的限定独审。复用仍有效的流式/压缩/恢复证据，相关接线改变才补对应回归。数据库harness串行，Rust改完统一重建一次，不全跑100题、29组或历史电池。
5. 工程通过后，沿已有有效真实模型授权、同trial/库和原限额，追加一条修复后attempt；旧会话原稿已superseded，不能复活。独立核验本次实际保存的新有效SQL，再让Pi通过正常消息自主完成明确执行、一次平台提交、原结果自动解释及正文/刷新一致。通过后至多一条原结果续接。失败保留证据，禁止人工route/执行或循环开新消息补额。

只修有证据的常见失败；不为理论边界加防护，不重复校验已验证结构，不抽单次无意义helper，不堆try/catch或测试矩阵。复用Pi 1.3.0原生循环、活动工具、会话、压缩与恢复，保持每消息24次、连续临时失败3次及原操作/来源/预算身份。

原失败、SQL、费用、unknown和预留保留。接手读回当前账本，正常已授权调用不逐条重问；若原窗口已过期，只申请同账本必要延期，不换ID或清账。在此之前先完成不依赖延期的代码和本地验证。

逐项在CURRENT记录实际结果、指纹、退出码和缺口。09仍active/review pending/evidence null，OpenAI网络与09其他缺口不顺带扩做。不提交推送或更新日常服务；准备具体候选版本和启动步骤，服务更新另按当前实际授权。完成本包结果后停下，不继续扩评测。
```

## 历史交接：模型派发与 OpenAI（2026-11-06，不作为当前指令）

唯一当前状态为 [CURRENT](../../CURRENT.md)。主包为 [provider-delivery-repairs](provider-delivery-repairs.md)，审计依据为 [readiness audit](../../reviews/provider-delivery-readiness-audit-20261106.md)。先读根 AGENTS、CURRENT frontmatter 和最新摘要，再按具体任务展开；不重读历史九包或重做本包。

本包工程、相称本地验证及真实代表已执行。最终独审、当版指纹和停止状态以 CURRENT 及其引用的最终报告为准。09 仍 active：真实通知失败、OpenAI 缺新凭据，不能凭固定21核心原记录pass关闭。没有运行 verify-increment 或生成完成收据；本包停止后不自动启动新消息、真实重试或下一修复。

已落地的工程：

- 模型 payload/reserve/send/provider/finalize 分阶段结构化诊断；相同阶段去重，provider 与 finalize 同时失败各保留一条。原外部错误码、每消息24次、连续临时失败3次和原结算 payload/身份保持。
- RustTransport 通过私有符号给原异常附受控 HTTP 元信息，不改变 SyntaxError/TimeoutError 等原类型。Bridge 沿原日志记录 finish/host_request/delivery、固定路径、状态、耗时和有限原因，删除旧诊断开关下任意 error.message 输出；HTTP/Worker错误协议和恢复策略保持。该补修在真实失败之后完成，仅有本地 RED/GREEN，不能反推本次真实错误就是超时。
- 原模型页明确选择 OpenAI 时默认 Responses、展示官方地址例子并保留已输入地址/可编辑协议。精确 gpt-6.1-sol/high 的原管理保存、五档/容量/费率、同一Pi会话工具往返、reasoning/call_id、usage 与配置冻结均已通过合成端点和浏览器检查。
- 通知 scope 的一次正常入口核对形成合法反例：宽范围B冻结答案命中窄A查询，但还含A范围外文档。新增可选 `DataToolOutcome.frozen_notification_covered` 与同名 `WorkspaceContext`，复用 Rust 原控制义务计算的原通知 scope 核验结果。Node不再仅凭query ID判断覆盖；B保留、A按自身scope交付。恢复/刷新重算当前事实，旧回执返回副本省略历史覆盖值，原字节和引用不改。

本地证据在 `.local/checks/provider-delivery-implementation-20261106/`。667合同、默认通知10场景/55本地回合、混源owner、受限自然恢复和历史、控制上下文、完整预算/unknown/取消、代码与架构检查通过。最后的宿主元信息补修另有零数据库/零官方请求的 Bridge/配置协议/传输回归及类型检查。精确适用版本和复用理由见最终 verification 与独审；不能把本地合成通过称作真实模型通过。

真实效果分别保留：

1. DeepSeek 新补充 attempt `A03-ff1322be-d4ed-4cd0-aec2-f3129514bd3a` 最终 fail；原A03原题、断言和聚合pass不改。新只读草稿在唯一明确执行消息后一次提交成功，结果为458个样本、6430ms。通知首轮4次成功模型调用、get_query和present_analysis_answer成功后，Bridge返回unexpected_error；三次原生恢复零新增模型调用，最终retry_exhausted，无正式结果解释。原发布Pi leaf含成功答案候选及context_edit，但原Finish请求/异常未留存，具体底层原因未知。不可归为供应商失败、超时或历史A03同一原因，不手工改failed job/账本重做。
2. 费用为22条新settled模型账本行：17次agent调用加5次knowledge_embedding，账本增量809673微美元、预留增量0、新unknown0。17份DeepSeek wire逐参数指纹匹配全部17次agent调用；其余5条是辅助embedding，不能把22与17的用途差异叫作5次聊天捕获缺失。原3230/118/80行、29unknown、3维护issued及预留保留。
3. 原管理员GET确认没有OpenAI服务，用户未提供新授权私密注入。因此OpenAI真实调用、J19原题新attempt及原定一次读取日表追问均为0，配置零写；没有使用曾贴出的Key。接入工程完成不证明账户可用性或J19新模型解释精度。新Key只能经原管理页或用户明确指定的私密入口注入。
4. 原J19七稿未改未执行；旧正文对valid/invalid的泛化限制保留。新DeepSeek草稿也单列播放finish截点表达精度限制，未改SQL迎合结果。

自有隔离服务已停止，五端口释放；原有其他API进程和共享MySQL/Milvus/MinIO/etcd未动。expiry、权限、默认与原配置保持。主线程后续只做本地证据分类/只读对账和工程诊断补修，没有追加真实模型消息或SQL提交。最终清理与保全证据见 `real-verification/final-outcome.json`、`comparison-final-cleanup.json`、`ledger-wire-purpose-reconciliation.json` 和 `shutdown-final.json`。

后续只有收到新的明确接续指令或私密凭据后才继续相应分支。候选恢复须沿原宿主发布leaf、同output/消息/恢复链/SDK操作及原budget；不能伪造检查点、改原failed/unknown或换ID补额。权限、原scope、条件版本与SQL确认继续由Rust核验；Pi仍是唯一循环、会话、压缩与恢复机制。

不提交、推送、部署、发布网站或更新日常服务。实际下一动作、未满足的必要真实项和当前审查状态只在CURRENT维护。
