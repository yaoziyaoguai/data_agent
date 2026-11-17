# 查询提交前失租与验收等待诊断（2026-11-10）

本轮沿`dev_co`及`diagnosing-bugs`定位上一轮未关闭的v1回归，再编制限定修复包。只做源码核对、隔离探针与文档；没有修改产品、日常服务、账本、凭据或真实模型配置。当前状态仍只在[CURRENT](../CURRENT.md)维护。

## 结论与归因边界

确认两项不同的问题：

1. **产品：查询准备耗时没有被租约机制覆盖。** `queries::claim_due`领取固定15秒查询租约；`query_workflow::process_due`随后做正文来源预检、会话/任务锁与提交前核验，期间无查询续租。`begin_submission_in_tx`按有效期拒绝已过期领取，因此慢准备可在尚未调用平台时不断失租。这条路径由v1/v2共用，不是Pi工具合同兼容错误。
2. **验证：消息capture默认20秒不足以涵盖慢环境下的Worker重新启动与真实准备。** 在同一隔离消息中，原等待已报超时，约25.5秒后仍收到了正确的run；当时不是消息丢失或Worker永久停摆。需修正该测试的等待预算，不能把capture超时直接解释成租约失效，也不能只延长测试时间掩盖第一项产品缺陷。

**历史那两次失败没有完整时序，无法证明其具体延迟一定由Defender、MySQL计算、连接池或某一条SQL引起。** 本轮以可控数据库响应延迟重现了同类故障，并核对了领取身份和状态，足以确定需修复的普通失败机制；不冒称找到了历史宿主性能波动的唯一来源。

原交互修复的12份产品/测试/合同输入指纹与上一轮`final-state.json`一致。原修复保持，不需要再改工具说明、错误投影、Pi循环或架构。

## 证据与最小复现

本地证据统一位于忽略目录`.local/checks/query-submission-diagnosis-20261110/`。探针从原`check-conversational-query.mjs`提取第一条单查询流程，复用真实API/Worker、MySQL与可执行合成SQLite平台；无产品模型调用。

| 探针 | 结果 | 证明范围 |
| --- | --- | --- |
| `minimal-v1.mjs` / `original.log` | EXIT=0；同一保存、直接授权、一次提交与结果通知流程通过 | 同一产品并非在所有环境下必失败，不重跑完整v1电池 |
| `delayed-v1.mjs` / `delayed.log` | 仅查询处理前启用250ms数据库下行分片延迟，EXIT=1，`query_worker_failure code=lease_lost`，平台提交0 | 提交前失租可重现；这轮SQL观测语法有误，不作为租约时间线证据 |
| `timed-delay.mjs` / `timed-delay.log`、`timed-delay.json` | 修正观测后69次有效采样、0观测错误；复现capture过早超时与查询失租，EXIT=1 | 正确消息迟到、同代次租约到期与零提交的完整局部时间线 |

延迟代理仅转发该探针的MySQL连接，不读取/记录协议载荷，不影响日常端口或其他数据库客户端；250ms是受控实验变量，不是历史环境实测值。所有测试库和本轮进程均由原harness关闭；本地日志保留。初版两个观测器的SQL错误及失败结果如实保存，未用于推算时序。`performance_schema`未返回该库digest统计，不能把空结果称为服务器执行时间0。

有效时间线以该探针开始后的单调时间记录：

- 第二次消息capture从3094ms开始；31828ms记录原20秒等待失败（其前还包含消息接收HTTP耗时），57311ms收到同一消息的run。总计约54.2秒，较超时晚25.5秒。
- 59592ms再次启用下行延迟；67446ms采到查询`queued / epoch=1 / submission_attempts=0`，租约尚余14364ms。
- 82054ms仍为同一`epoch=1`、同一个`lease_until`，余量已为-329ms；未发生续租或换代。
- 随后Worker报`query_worker_failure code=lease_lost`，平台SQLite提交记录为0；87.5秒结束观测。

准确汇总见`diagnostic-summary.json`，输入及探针指纹见`diagnostic-integrity.json`。诊断使用的延长观察窗口只用于确定超时后实际发生了什么，没有改正式测试或把原失败改成通过。

## 源码因果链与复用点

| 入口 | 当前行为 | 修复方向 |
| --- | --- | --- |
| `modules/queries/store.rs::claim_due` | 写入owner/epoch，15秒到期后允许重新领取 | 保留领取身份和期限；补同owner/epoch且仍有效的查询续租 |
| `use_cases/query_workflow.rs::process_due` | 领取后先做`check_text_results`，再锁会话/任务并`validate_text_in_tx`，最后才核租约、标submitting | 使慢准备与续租同时推进；保留全部业务重核 |
| `queries::begin_submission_in_tx` | 同epoch且未过期才能准备平台操作 | 不删除失租检查，不复活过期代次；提交准备事务内明确交接剩余期限 |
| `use_cases/deliver_run.rs::start_delivery` | 已用一个准备future和一个续租future并行`tokio::select!`，不在持锁future旁串行等待renew | 复用此结构；不新增守护线程、通用租约框架或Agent恢复器 |
| `tests/mvp/harness.mjs::capture` | `send`后使用默认20秒`until`；Worker每次恢复是新进程 | 给capture调用者提供有界等待参数，默认值保持；仅本次有实测依据的场景显式设置 |

查询租约属于应用数据业务，Pi不拥有MySQL查询领取状态。Pi继续负责Agent理解、工具循环、会话、压缩与模型恢复；本修复不应改Pi或将查询重试变成模型重问。

## 其他未完成项

- 真实代表未运行是工程前置未通过的结果；原trial已过期是随后需要处理的执行窗口，不是本次失租根因。保留原账本、限额、费用、预留与失败。
- 日常19173入口在审计时仍由11月7日启动的API/Bridge/Worker提供，磁盘二进制为11月10日。只有候选通过并按实际授权更新服务，才能交付最新版入口。
- OpenAI网络连通与09其他未完成项仍独立保留，不借本包扩做。

## 修复包审查

本地方案为[查询准备与试用收尾执行包](../execution/semantic-runtime/query-submission-repairs.md)。已核对本包入口、共享路径、等待修改与必要回归；补清续租的`lease_owner`来自Worker，当前job的`owner_id`是业务用户，不能混用。不改变Pi、公开工具合同或前端，也不增加通用租约框架。

Oracle单次咨询`query-preparation-package-20261110`已在附件前后两次确认`Power, item 5 of 5 (slider ARIA)`并提交至原会话（会话链接留存本地证据）。工具在共享45分钟期限退出，`browser-run-timeout`，Oracle退出码1；同会话恢复仅返回原日志。**用户随后从原会话回传完整审查答复，结论为“小修后可实施”。** 自动抓取失败的记录保持，不将恢复命令EXIT0写成抓取成功；没有重发问题、降低档位或引用其他会话答复。

原始运行证据为本地诊断目录下的`oracle-run.log`、`oracle-recovery.log`、`oracle-session-evidence.json`及`oracle-submission-hashes.json`；原提交稿为`package-as-submitted.md`。回传意见的来源及处置另存`oracle-returned-review-disposition.json`，不覆盖原抓取失败证据。精确会话的Chrome进程已退出、临时Profile已删除。

本地按当前源码逐项复核并采纳：

| 审查意见 | 源码核对与最终条款 |
| --- | --- |
| 明确Worker owner来源 | `claim_due`将worker写入lease_owner，job.owner_id来自业务用户；§4.1固定worker入参与job的query/epoch，不扩领取payload |
| 刷新语句自身核验有效期 | `begin_submission_in_tx`原SELECT后还有异步UPDATE；§4.2要求末尾刷新UPDATE自身包含query/epoch/未过期条件，无匹配返回lease_lost并回滚，不复跑来源预检 |
| 补事务交接局部验证 | §6.1复用真实MySQL领取fixture核余量减少后的刷新、过期/换代拒绝及回滚；不以会话锁E2E代替新增刷新行为的验证，不扩大矩阵 |
| 不把15秒写成commit回包后的保证 | §4.2改为数据库刷新时刻加15秒，保留平台5秒超时及后续观测不受固定时限保证的原边界 |
| 同代次和一次提交的判据准确 | `record_observation_in_tx`将租约置为约250ms后，合法lookup可以换代；同epoch只覆盖准备和首次提交承接。平台按query去重，单行账本不能证明单次请求；§6.1引用原queryProxy请求记录接缝统计实际submit，不复制故障场景 |

Oracle认可双future组合、局部120秒测试等待及原真实代表/账本/服务边界；本地核对后保持。补清54.2秒属于消息到达总耗时，不能当查询准备或数据库执行耗时。准备组合仍带出原conv/packet/authorization_error并保留平台前授权错误拦截，不重构unknown/lookup/cancel。

**执行包已完成交叉意见核对和本地定稿，可交实施。** Oracle未运行产品，也未逐字复审采纳后的最终文本；本地编包与本次审查不替代实施、真实模型或服务更新验收。不再需要取得答复、重复三次诊断或发起新一轮Oracle咨询。

回传意见前的文档出口保留：`make verify-delivery`及16项记录检查自测EXIT0，71个本地链接存在，相关12份产品/测试/合同输入及2份正式设计与上一轮快照一致。对应`verify-delivery-result.json`、`package-local-checks.json`。回传后的最终`make verify-delivery`及16项自测EXIT0；当前入口范围64个本地链接无缺失，旧待答指令、关键条款与文档差异核对通过，14份既有输入仍一致。记录为`package-final-checks.json`与`verify-delivery-reviewed-result.json`，最终文档指纹见`package-reviewed-handoff-state.json`；这些检查不代表产品修复通过。
