# Dogfood 中断后审计与接续依据

日期：2026-11-15。范围：上次收口实施的实际差异、免费工程证据、最新真实试用回执及停止位置。此次只做本地审计和交接文档，没有修改产品、重新运行付费试用或再次咨询 Oracle。此前 Oracle 审包意见见[原记录](dogfood-closure-package-review-20261115.md)，不能当作对本轮新增代码的独立审查。

当前状态以 [CURRENT](../CURRENT.md) 为准；实施顺序与约束仍由[现有执行包](../execution/semantic-runtime/dogfood-report-repairs.md)维护。本报告保存发现和依据，不另设完成状态。

## 结论与审计边界

上个实施者已经修复了主要兼容和测试前提问题，并跑通 S01 草稿、S02 执行与刷新、S03 条件修订。当前没有依据要求重做架构或重新启动九阶段。仍有真实能力失败、一个错误的权限试用接线、维护输入计量的外部依据缺口，以及试用结果未汇总、完整验收未完成。

审计没有用累计 HEAD 差异判断上轮范围。上轮起点为 `.local/checks/dogfood-closure-20261115T032354Z/before-manifest.json`，另有 `before/`、`before-recovered/` 和 `provisional-before-after-boundary.json`；逐文件内容比较划定 26 个既有文件变更及 13 个新增文件。此次审计起点与定点复现保存在 `.local/audits/dogfood-interruption-20261115/`。所有材料均来自合成座舱试用，不包含真实业务资料。

### 已有证据可以保留

| 已完成部分 | 核实结果及限制 |
| --- | --- |
| 默认模型配置升级 409 | 默认引导走账本 owner 的 `ensure_default_trial`，已有 trial 保留；显式重配置继续严格核对。四类配置生命周期有 RED/GREEN，完整模型配置 14 项通过。 |
| 合同测试错领与短租约夹具 | 每例独立库，原 7 项组合通过；短租约前先准备连接/锁，保留超过 TTL 的实际等待、旧 epoch 和真正过期拒绝。生产续租算法未改；历史失败的唯一原因仍未证，不能倒推为 Defender。 |
| 标题来源与模型停用 | 来源规范表示期待修正且保留重排/null 断言；停用改用实际管理 API。另修 Workbench 对 `model_unavailable` 的明确拒绝处理，原草稿/请求身份保留；浏览器 9 项通过。 |
| 有合法数据库前提的工程检查 | 完整 lib 213 项及 source-recall 通过；合同、代码、架构和受影响局部回归有对应日志。局部通过不能代替最终 50 条完整验收。 |
| 真实正常取数链 | S01/S02/S03 有当前证据；S02 恰一次提交、结果 430/31，刷新后保留正文。T01 两句澄清分离另有通过证据，尚未进入总成绩。 |
| 维护预填容量 | 两个合法输入超出 token 预留的反例已补，并实现派发前计量、相应批次处理及免费回归；公开 tokenizer 与托管 API 模板的映射尚未证实，真实维护仍关闭。 |

工程证据入口：`.local/checks/dogfood-closure-20261115T032354Z/` 的 `model-configuration-report.json`、`default-upgrade-green.json`、`request-policy-green.log`、`contract-isolation-green.log`、`lease-claim-green.log`、`lease-recovery-green.log`、`conversation-reliability-green.json`、`agent-library-green.log`、`free-engineering-gates.log`。复用前核对对应输入和环境；不存在“全部已过”的新总收据。

## 文档定点读取：越界后没有足够信息纠正

**影响与优先级：高。** P06 连续八次 `read_source` 返回笼统的 `invalid_input`，丢失完整链路需要的资料并反复尝试。问题可影响其他长文档调查。

**已证根因：**模型将精确 citation 区间当成“最多读取这么多字符”，自行填写超过原文的长度；回执没有说明越界字段及合法范围，模型无法据此修正。八次请求均从 offset 0 开始：

| 来源及坐标体系 | 请求 length | owner 当前 source_length |
| --- | --- | --- |
| platform / dialogue-context，两次 | 30000 | 11435 |
| platform / vad-segmentation | 30000 | 4878 |
| document / dialogue-context | 30000 | 11450 |
| document / vad-segmentation | 30000 | 4893 |
| document / skill-routing | 5000 | 4823 |
| document / feedback-outcome，两次 | 6000、4096 | 4018 |

document owner 的文本包括 body、分隔符和业务域，坐标与 platform 原文不同，不能互换。这里的长度按现有 owner 字符语义计算，不用 UTF-8 字节替代。已核对本次源资料未变。

代码：`crates/data-agent/src/use_cases/knowledge_sources.rs::read_citation_window_in_tx` 在同版有权回源后拒绝 `offset + requested_length > total_length`；`limit` 只限制一次交付正文。该校验正确。`apps/agent/tools/data-tools.ts` 的工具说明及失败回执未给可执行的纠错信息。

证据：原 `attempts/P06-01/trace/native-observable-calls.json` 与 `tool-calls.json`；本轮逐次对照见 `.local/audits/dogfood-interruption-20261115/source-range-root-cause.json`。试用根目录为 `.local/dogfood-runs/qa-repair-20261115T065901Z/`。

**修复方向：**保留精确区间、权限、修订及内容上限语义；在现有 owner/回执边界返回可纠正的范围原因。仅在同版且有读取权时交付已核实长度或合法区间，工具说明区分 `citation.locator.length` 与单页 `limit`。沿同源 Schema 扩展必要错误字段，内部不重复验同一值。不静默裁掉非法原区间，不输出整篇全文，不新建 Agent 重试循环。`content_state=complete` 仍表示请求区间交付完整，不改成整篇已读。

**验收：**保留原越界拒绝；从返回信息构造的合法范围能成功分页；同时覆盖 platform/document 各自坐标、中文/emoji、尾页、旧修订、失权不泄露长度。免费工程检查通过后，以 P06 原题验证模型是否能利用纠错信息完成需要的资料读取；不能靠驱动脚本代写工具调用。普通字段问题仍只补相关段落。

## 权限试用：捕获模式用了错误的合成模型配置

**优先级：高，但属于试用接线。** G01 的语义维护权限部分已有证据，查询权限分离尚未实际推进到平台提交，不能把整项报成产品权限失败或通过。

**已证根因：**`attempts/G01-01/run-g01.mjs` 使用 `capture:true`，在当前进程的 `deliveryDispatch` 中执行 `deliver`。`tests/mvp/harness.mjs` 从资料 manifest 推导 `DATA_AGENT_DEMO_PROFILE=cockpit_voice`，但该 env 只给子进程；当前进程由清空环境的启动方式运行，没有这个变量。`apps/agent/provider/synthetic-analysis.ts` 因而落入旧零售策略，不能识别座舱指标，一直返回 `update_analysis_task(action=route, task_id=null)`。

原 Pi 日志有 169 次 update 和一次 search，未走到查询提交，0 付费。以保存的首次 search 回执做无网络动作选择复现：不设 profile 返回 route/null，设为 cockpit_voice 后读取 `metric-task_completion_rate.definition`。本轮结果见 `.local/audits/dogfood-interruption-20261115/g01-profile-replay.json`；这是最小空 workspace 下的下一动作验证，不是完整权限链通过。首次诊断样本曾漏填 `memories`，补齐后复现成功。

**修复方向：**优先沿现有真实 bridge 子进程执行，使模型配置和服务环境一致；若必须捕获模式，明确传给实际执行 `deliver` 的进程，并在本例结束恢复环境。只修现有试用驱动/测试接缝，不改生产查询规则，不给真实 Agent 加累计次数或成功空转计数器，不用真实付费模型掩盖合成测试配置错误。

**验收：**原 G01 问题和用户身份保持，经产品交互到达真实 Rust 权限边界及合成平台；有查询权而无语义维护权、语义维护权不等于平台执行权分别有实际回执。若使用合成模型，报告必须明确，不能冒称真实模型自主完成。

## 明确要求执行：工具已送达，模型仍未调用

**影响与优先级：高。** S08 两次明确要求执行后仍 `not_submitted`、`submission_attempts=0`，随后产品 Skill 所需的分析结果也拿不到。

**已排除：**S08-02 实际派发记录的第 14 次请求已经包含 `get_query`、`execute_query` 和其余共 19 个工具；最新宿主事实 ready=true，任务/查询/条件版本正确，最后用户输入 hash 对应原执行要求。`tool_choice:null` 在此日志表示未显式设置，不是强制禁止工具。实际 system hash 与本地重放 payload 一致，现有系统规则也已要求 ready 后继续 get→execute，不能再笼统归因为“没给工具”或“没写执行规则”。

**尚未确认：**完整实际工具 schema、消息序列化、历史 false 与最新 true 的上下文关系，以及模型对这份输入的选择。现有线上取证只保形状/hash，派生重放并非原始完整 wire 重放。把剩余原因直接写成模型能力差仍然越过证据。

证据：`attempts/S08-02/trace/exact-execution-wire.json`、`chronological-native-calls-and-wire.json`、`assessment.json`；本地 `.local/checks/dogfood-closure-20261115T032354Z/execution-tool-replay-payloads.json`。代码入口：`apps/agent/session/{deliver,resources,workspace-context,task-projection}.ts`、`apps/agent/tools/data-tools.ts` 与 configured provider 的实际派发接缝。

**下一步：**先利用原 Pi 会话和现有 provider 接缝无费用重建实际投影，逐项核对 schema、消息顺序、最新 route 回执及执行规则。如果还需新真实请求才能确定，仅对合成资料做一次定向、最小必要的本地 payload 捕获，排除凭据；不新增永久全量提示词日志。明确假设和改动后才做原预算内的单变量真实复验，避免第三次无差别重试。

**修复边界与验收：**修已证一般原因，不按 S08 文案强制选工具、不绕过 Rust 授权直接执行、不把“按钮可用”当聊天执行通过、不另造规划器或自动执行器。原话能够经 Pi 自主调用、当前查询版本执行恰一次、得到真实合成平台结果且刷新保留答案；未要求执行的草稿仍不提交。恢复、重复调用、旧条件和权限回归保持。

## 语义解释：已交付资料的适用范围和例外仍被误用

**P05，高优先级，错误已证。** time-quality 文档 10740 字符分 8192+2548 两页完整交付。模型先泛称几类时间不能换算/校核，随后又给锚点换算；又否认 session 的 ended_at-started_at 能推导 duration_ms，而原资料明确该字段是会话墙钟整秒区间的精确毫秒长度。通用“短操作单调时钟”警告被扩大到所有同名 duration 字段。这是读取后解释范围和例外的错误，不能归为资料缺失，也不能仅靠增加召回量解决。

来源：`docs/sources/cockpit/documents/time-quality.md` 的 turn 锚点和 session 例外；`attempts/P05-01/` 的原工具回执和最终回答。修复前仍须核对最终实际模型上下文有没有把已读内容覆盖、截断或与其他定义并列成冲突。若交付无误，优先简化现有规则，让一般规则、对象限定与明确例外一起被采用；不要写入本题答案或再加一个模型审核阶段。

**P07，中优先级。** 能澄清“成功率”的含义且未擅自生成/执行 SQL，但只覆盖 ASR、任务完成、TTS 播放，缺少 NLU 理解和动作效果层。该轮主要是 5 次搜索和一次 knowledge 补读，并未完整读 metrics-analysis 原文。需区分相关片段是否未交付、交付后未采用，针对实际缺口修正。不能为了补两项解释把全量资料塞入上下文。

**P04，较低优先级。** 主外键、业务一对多与重试候选解释正确，但未显式区分业务 session/turn 和 Data Agent conversation/task。目前是说明缺项，未证已把它们当作同一记录。保留 partial，避免无依据扩大成数据模型重构。

**验收：**P05/P07 原题重新取真实答案，逐条与独立资料比对；相邻反例覆盖同名字段不同定义、一般规则有对象例外、用户问多种口径时先解释再澄清、不要求就不执行。P04补足应有说明即可。不得改独立参考、把答案写进系统提示、强加全文阅读或新增必经“自检模型”。

## 维护预填：工程计数已做，真实端点映射仍有缺口

**优先级：中高，维护功能不能宣称完成。** 新增 `ingestion/prefill/input_tokens.rs`、`tokenizers=0.22.1` 和约 12.7 MB 的两个公开 tokenizer，覆盖已复现的 token 预留反例。输入在 prepare-before-reserve 检查，沿原批次缩减，未新建网络计数服务。依赖已关闭默认 HTTP/训练特性；资产来源、hash 与许可已记录。

问题是公开模型编码、角色/function 模板和当前托管 API 的对应关系尚未证实。公开模板的精确 BPE 计数不自动等于托管端点输入的无条件上界。`input_upper` 等表述需和实际保证一致，不能以本地 Python/Rust 一致宣称收费输入已全覆盖。`.local/checks/dogfood-closure-20261115T032354Z/published-encoding-static-review.md` 早于最终模块，不能用作新增实现的最终独审。

**处理方式：**先无费用核实官方协议/固定型号依据和当前实际装配；无法取得映射保证时，比较是否可用现有分批与有依据的保守计量满足原要求，明确容量影响。不要无依据删除已解决反例的实现，也不要扩建模型模板框架、盲加安全倍数或换小窗口。完成固定资产与新增依赖的独立审查，并跑原预填材料、字段、来源/文档整理回归。

真实维护仍关闭，原维护/embedding 试用通道期限为 2026-11-15 12:00 UTC（北京时间 20:00），已到期，不得自动延长或开新 trial。聊天运行内的检索按原聊天账本核算，不能把维护期限误当所有聊天工作的阻塞。若还需真实维护样本，列明最小样本、费用和时间范围另行取得授权；独立工程和聊天问题继续。

## 报告与中断恢复：已有结果没有完整汇总

原 `results.json` 保留 100 项，目前 4 pass、2 partial、2 fail、92 not_run；轨迹文件 10 项全为 not_run。这些数字低估实际取证进度：P02 资料 UI/hash、P06 partial、T01 pass、G01 权限部分已有独立 assessment，尚未汇总。需要逐项核原证据后更新，不把未测全改成 blocked，也不把旧版本 pass 直接迁入。

T02 第二句已 HTTP 200 接收，最后结果未归档。下一位先查 `.local/audits/dogfood-interruption-20261115/report-reconciliation.json` 的原 conversation/message/request 身份：有结果则读回；未完成则按原 Pi/operation 恢复。不得重发第二句，也不能假定第三句已经发送。

最后保存的账本在 T02 第二句之前：已花加 unknown 合计约 38.30 元，聊天通道当时余约 42.92 元；这不是当前余额。重新读取原账本与后续结算后才能继续付费。总额仍 100 元，通道子帽不能互挪；F08 原 47 微美元 unknown 不清零、不换 operation 重发。详细来源在 `report-reconciliation.json`。

产品生成 Skill 七步尚未开始，不能用手写 Skill 验收。原 21 核心要求、100 项/10 轨迹完整分母、产品 Skill、未参与实现者独审和当前 50 条完整 `make verify-increment` 出口均保留。此次审计不出具实现通过结论，I3 保持 active、review pending、evidence null。

## 范围判断

本轮核到的主要差异仍在原 owner、既有测试及 SDK 接缝，没有证据表明新建了第二套 Agent 或重做存储架构。预填 tokenizer 属于有反例支撑但保证范围未闭合的实现，应专项确认，不能简单归为“漂移应删”或“已经解决”。租约诊断日志和定向派发取证应保持既有显式开关，收口核对无默认全量内容/凭据记录；不因诊断一时需要扩成常驻观测平台。

下一步不需要重新选择模型、数据库或 SDK。先处理已有明确根因、完成执行语境定位和质量修复，再闭合必要真实证据及报告。付费维护期限是独立授权问题，不能用它阻塞可继续的无费用修复。
