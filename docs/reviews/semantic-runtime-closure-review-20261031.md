# 05–08 收尾独立审查（2026-10-31）

状态：审计完成，保留未解决问题和验证缺口。用户最新要求是先找出问题、不继续修复；08 保持 active，09 排除。本文不签 passed/关闭 JSON，不冻结验收指纹，也不授权继续执行修复或关闭验收。

审查者未参与本轮实现，仅阅读源码、合同、测试与已有记录。本次更新核对主代理已经执行的正式 HTTP/MySQL RED 及实际 provider 收据；审查者未运行数据库/Cargo、未启动 Oracle、未修改业务代码。只有实际收据已到达的断言计入证据，测试源码不等于运行通过。

审查依据为 `AGENTS.md`、`docs/CURRENT.md` 顶部声明、`docs/execution/semantic-runtime/{hybrid-retrieval,evidence-delivery,task-answers,compatible-upgrade,pi-reuse}.md`、`docs/architecture/implementation-design.md` 第 17.4–17.8 节。旧原型仅用于核对工作台的任务、条件、来源、查询及历史入口；后续正式合同优先。09 不在范围。

本轮差异以 `.local/audits/semantic-runtime-20261031-60e76a2d/before/` 为接手快照核对，未将全部未提交文件归为本轮修改。用户改口前的修改清单由同目录 `audit-only-stop-manifest.json` 保存；它是暂停点清单，不是验收签名。当前任务和授权以 `docs/CURRENT.md` 顶部 goal_revision 115 为准，历史“继续修复/冻结后关闭”叙述已被本次审计指令替代。

## 待解决发现

### SR-01 · P1 · 无冻结项的多任务结束仍可绕过覆盖检查

置信度：100。完整调用链与主代理运行的正式 HTTP/隔离合成 MySQL RED 一致；本审查者已读取完整收据和失败日志，未自行重复运行。

触发：同一消息已经归属任务 A、B，两者采用不同的明确来源范围。A 普通 `route` 到 B，未设置 `finalize_current_answer`；随后只输出 B 的自然最终回答。普通 route 不冻结是合法控制动作，不能把该动作本身改成自动定稿。

路径：`apps/agent/session/deliver.ts:404` 仅在 `frozen.length > 0` 时构造 `answer_parts`。没有冻结项时，`crates/data-agent/src/use_cases/finish_run.rs:124` 直接接受 `final_text`，不会进入 `task_answers::compose_in_tx` 的全任务覆盖检查。随后 `crates/data-agent/src/modules/runtime/store.rs:42` 从恢复链全部成功的 `update_analysis_task` 回执取得任务引用；`finish_run.rs:194` 至 `:218` 可以把 A、B 均推进到 `answered` 并消费原消息。A 没有正式答案仍被当作整个消息已交付。

要求依据：17.4 的不同来源任务须分别保存已核验答案并由宿主组合；07 步骤 5、7 禁止遗漏未完成任务后冒称全部交付。新增的“已有 A 冻结项、B final、C 遗漏”检查只覆盖已有冻结项分支。

实际结果：预期 `409 invalid_evidence`，实际 `200`。提交前 `frozen=[]`、`answer_parts` 缺失、消息 `pending`、A/B 均 `investigating`；提交后仅 B 的“合成乙按自己的条件完成解释。”成为 committed 正文，消息变为 `consumed`，A/B 均变为 `answered`。同一 `output_id`、任务条件和预算身份保持，模型调用及官方请求均为 0。这证明缺陷在宿主提交/状态转换，不依赖模型质量或偶发并发。

证据：`.local/audits/semantic-runtime-20261031-60e76a2d/task-unfrozen-audit.log`、同目录 `task-unfrozen-red.json`，原收据 `.local/checks/task-answer-boundaries.json`。运行到此反例即退出；此前单任务 v1/v2 自然 final、普通 route 省略/false 四项检查通过，未知范围、相同范围、明确无限制等新增场景没有运行，不能报为通过。

产品尚未修复。保留的业务边界是：普通 route 不自动定稿；明确 `source_limits=null` 才表示无限制，未知/缺失不等同无限制；同一明确来源集合可自然综合，集合顺序及 `origin_message_ids` 不改变范围；正式取消与 `waiting_clarification` 各保原语义。`finish_run.rs:189` 已有宿主结果通知分支，只推进原查询版本，不能把本反例外推为所有查询结果通知也必须提交全部当前任务 parts。此处只记录判断边界，不继续实施。

### SR-02 · P1 · 支持裁剪静默丢失目录外已核验 Mem0 命中

置信度：100。正式 Rust 回执和实际 Pi/provider 输入已有同一 RED，当前产品分支未修复。

触发：搜索已核验个人记忆 A 来自 Mem0，目录页只有 B；知识命中的支持数量或字节量触发最终容量裁剪。`crates/data-agent/src/use_cases/evidence_delivery.rs:239` 从 `delivery.assets["order"]` 重建 `assets`，只选目录成员；随后 `:280` 附近将 `personal_memories` 替换成该列表的记忆子集。A 不属于目录顺序，因此从已成功核验的原回执消失，且 `next_asset_after` 不能表达它的续读位置。

实际结果：未触发裁剪的页有 A+B、26 项支持、11628B；触发裁剪的页只剩 B、46 项支持、18101B，两页 `asset_total=1`、`next_asset_after=null`。两次实际 provider 输入均在缺陷断言前完成了与 Rust 持久回执逐字段相等的检查，因此不是 Node 包装或展示层二次截断。当前失败停在记忆身份断言，不能声称已经验证“最终恰好 50 项支持”；46 项是此次实际观测。

证据：`.local/audits/semantic-runtime-20261031-60e76a2d/memory-clipping-red.json`、同目录 `memory-clipping-red.log`，原收据 `.local/checks/evidence-search-assets-mem0-red.json`；断言位置为 `tests/mvp/check-evidence-search-assets.mjs:64–75`。3 次本地 provider 协议调用、0 次官方请求；Mem0 候选由本地协议提供，归属、版本与正文仍由正式存储核验。要求依据为 06 的个人资产与公共检索独立交付、容量裁剪后身份和续读位置保持。

### SR-03 · P2 · v2 覆盖声明遗漏 exact 步骤和 SQL 后备期限

置信度：100，限于改动前的正式接口 RED。用户改口前已写入相关输出修改，但尚未重建或得到 GREEN，因此本项仍未闭合。

旧输出仅从 Milvus 游标装配通道/期限；SQL 后备一 owner 完成、另一 owner 等待到原绝对期限时，明确 `supports=[]` 的正常知识场景返回 `search_coverage.state=bounded`、`reasons=[]`，丢失真实 deadline 原因。另一个正式接口反例中通道列表仅包含 `bm25=not_configured`、`dense=not_configured`，没有合同要求的 exact 步骤状态。

证据：`.local/audits/semantic-runtime-20261031-60e76a2d/sql-coverage-known-supports-red.log` 和同目录 `sql-coverage-red.log`。两个失败分别记录期限原因遗漏和 exact 输出缺失，不能把早先无关的软提示排序反例当成本项证据。

当前静态差异：`knowledge.rs` 已增加 `StageReads.exact_checked`，在实际 `rank_common/rank_window` 后标记，并向 `scan_progress` 写入 deadline/exact；`data_tools.rs` 已消费这些字段。exact 仅覆盖已召回并核验候选的 ID/名称精确比较，不是独立 SQL/网络召回或第三张 RRF 票，`searched` 不表示穷尽。新代码还有“未到期限且候选数为零”映射 available 的空集分支；成功空集与通道失败、元信息超期、恢复窗口及资产目录状态尚未由此次运行证明。本文不将这些未验证修改写成已修复。

## 已核对的实现边界

| 范围 | 静态核对结果 | 当前证据与缺口 |
| --- | --- | --- |
| 05 候选预算 | `CandidateBudget` 的修改由唯一 `drive_stage` owner 执行；异步页仅带预留值，回接时统一记账。改为普通可变所有权未删除唯一身份、在途预留、五轮、30 主读及 Embedding 收尾。 | 本项为静态结论，未据此签署当前预算、进度、通道与期限组合通过。 |
| 05 exact 状态 | `retrieval::rank_common` 对已召回并核验的对象做 ID/名称精确比较；它不是独立物理召回，也不产生第三张 RRF 票。新追踪和输出代码已写入，实施现已停止。 | 原输出缺失已有 RED；最新空范围、资产目录、元信息超期及恢复窗口声明未验证，见 SR-03。 |
| 06 锁边界 | v2 search/read_knowledge/read_source 准备正文前提交持会话/run/tool 锁的事务。最终另开事务重核租约/run、原工具指纹和 operation、活动任务、来源门及最终交付 authority；采用记录延至该事务。 | 主代理已记录新回归及 10 项原代表回归；本审查者未重复运行，不将它们扩大为最新工作树总通过。 |
| 06 支持与期限 | search 支持沿原绝对期限；超时不丢已取得主命中，保存原支持位置，partial 与 unknown/完整性声明分开。读取工具没有擅自增加新的十秒规则。 | 已静态核对最终回执、支持续读和原操作重放路径；SQL 后备期限声明的独立 RED 见 SR-03。 |
| 06 容量与资产 | Rust 最终裁剪并冻结回执；v2 Node 直接 JSON 包装。目录外 Mem0 额外项在裁剪分支被遗漏，产品未修。 | 实际 provider 与冻结回执相等后发生身份丢失 RED，见 SR-02；不能将整体容量交付判为通过。 |
| 06 依赖核验 | `context_authority::validate_in_tx` 改读窄 `source_reference_objects_in_tx`；公开接口仍保当前版本与 legacy 来源引用，随后沿原有效依赖索引校验。未发现新锁外路径漏登记 raw/支持/个人资产的静态证据。 | 静态结论不替代最终事务失效、任务范围及资产选用变化的执行证据。 |
| 07 已冻结答案 | route 以完整 SDK 消息/持久片段或成功答案回执为依据；Rust 冻结在原工具账本，组合仅取原正文并加标题/分隔。已有冻结项时新的任务覆盖修改符合合同。 | 主代理已记录该分支 22 项局部 GREEN 与取消恢复正控；SR-01 的无冻结项路径仍为 RED，不能扩大成所有提交形态完整。 |
| 08 current 与旧档 | 当前同修订从 current 读取；有旧档按指定旧修订回退，缺旧档不把当前正文冒充旧版。新修订元数据与旧全文保留策略分开；本轮未引入通用迁移服务。 | 没有本次最终八组升级总收据，不能由所读代码或旧局部记录关闭 08。 |
| 08 历史展示 | 后续合同允许条件/普通语义改版后回顾已存报告；`AnalysisReport` 的加载失败重试不再被条件变化提示遮住。原型中旧状态演示不能反向要求隐藏所有旧正文。 | 主代理已记录 7 项浏览器 GREEN；仅代表对应 UI 场景，不是 08 八组升级验收或整个当前工作树通过。 |

## Pi 复用与四条复杂度约束

已从实际安装的三个 `@earendil-works/pi-*` 包核实版本均为 1.3.0，并阅读其 `AgentSession` 事件持久化与 `SessionManager._appendEntry/_persist` 路径。

- `session/deliver.ts` 使用 `createAgentSession`、`session.prompt` 和原生 retry/abort/compact。未发现第二套模型与工具循环、任务规划器或模型摘要器。
- `checkpoint.ts` / `journal.ts` 使用原生 SessionManager 和 JSONL；健康导出引用不整本读回，打开/导入与故障出口保留严格校验和 fsync。SDK 内存 leaf 先于写盘推进的实际事实仍被故障路径处理。
- 半轮 `invokeRecorded` 只恢复原工具登记和回执后交回 Pi；任务投影用原生 compaction 边界移出不适用正文。这些是应用的权限与副作用身份职责，不能当作重复框架删除。
- `output-stream` 的缓冲/drain 对应公开订阅不等待异步写库的实际 SDK 边界；route 在异步 execute 中等待 drain 后绑定，不能改成 message_end 即自动完成。
- 候选预算的 Arc/Mutex 和无消费者包装已删除；必要的 JoinSet/select、同一搜索期限、唯一候选/在途预留、失败时等待已发 Embedding 结算均有已确认业务要求。
- 需要区分同侧同值结构校验与释放锁后观察新状态。后者不是冗余。当前 `knowledge.restore_search_stage_outside_lock` 和 `vector.restore_scan` 已删除重复结构检查，外层 SearchSelection/SearchContinuation 校验及当前范围、分片、目标、修订核验仍保留。改口前这次删除尚未重新构建或运行回归，不报为验证通过。
- 基础 `update-analysis-task.ts` 的 `invokeRecorded` 与 execute 现在均无独立 TaskInput 显式校验；每次真实 `ToolInvocation` POST 仍由 `RustTransport.post` 校验包括 TaskInput 的信封。草稿中“execute 仍重叠”的描述已过时。最后这次删除未重新跑类型/传输回归；没有据此推断可感知性能收益。
- 现有异常处理主要承担明确业务状态翻译、故障出口保护、原拒绝回执接回和有限恢复，未据未知概率提出新的防护框架。

## 未立项的候选与证据限制

`knowledge_supports` 可产生 `stale_source`，批量 read 的单项转换未直接列该码。但当前知识读取会先经 `assert_source_in_tx` 的有效依赖索引发现来源失效并转为 `stale_knowledge`。尚未找到通过正常受支持写入即可绕过该前置核验的输入，因此不把该候选列为缺陷，也不建议扩大 catch 吞掉服务故障。

`tests/mvp/check-evidence-response-budget.mjs` 的断言实际覆盖同批两个读工具、原回执丢失、较小提示恢复、原生摘要成功/失败和 provider 输入；`tests/runtime/check-checkpoint-journal.mjs` 包含 append/first_flush/fsync 与原生 compaction 追加故障。文件存在只说明检查范围；本文没有将其记为本次最终通过，也不安排继续运行。

主代理已完成两批 Oracle，日志为 `.local/audits/semantic-runtime-20261031-60e76a2d/oracle/retrieval-evidence-run.log` 与 `answers-upgrade-run.log`，均记录 `Power, item 5 of 5 (slider ARIA)`。07/08 外部审查确认的是已有冻结项漏交第三任务及报告错误状态；当时零冻结项因缺完整底层实现仅列待核。SR-01 由后续完整本地代码与正式 RED 升级为已证，不将 Oracle 先前的待核表述冒充已确认。浏览器退出及临时 profile 清理由主代理负责并已在 CURRENT 记录，本审查者没有另启会话。

本轮到审计报告为止。Mem0 裁剪和无冻结项漏答仍未改产品；exact/deadline 及最后两处重复校验删除是已写入、未验证状态。主代理早先的锁边界代表回归、已冻结项覆盖局部 GREEN、UI GREEN 与 verify-code 各自有版本范围，不能覆盖之后追加的修改。旧 05/06/07 passed 是历史证据，不能拼接成此次关闭证据；08 未关闭，也没有新的 passed JSON 或最终验收指纹。真实模型质量、企业逐资源 ACL/出域策略、真实平台与部署均未由这次合成审查证明；09 按用户要求排除。
