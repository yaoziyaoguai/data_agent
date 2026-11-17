# 试用就绪审计

## 结论

最新真实 DeepSeek attempt 记录过正式解释保存失败。本轮后续已沿正常 Worker 恢复、Pi 文件会话、真实 Rust/MySQL 和合成平台完成隔离回放，正式正文保存、按原用户刷新读取、任务及通知推进均通过。当前可以安排带明确缺口的日常 dogfood，09 继续保持 `active`。历史异常的具体根因仍为 `unknown`，本轮产品代码改动为零。

界面浏览、语义资料查看和已有草稿可以作为有限试用范围，开始前需要恢复并确认访问入口。本轮检查时常用前端和上一轮自有试用端口均已停止。OpenAI 的配置界面和 Pi 协议接线有本地工程证据，实际账户调用仍待通过私密入口配置新密钥。

本轮自审与 Oracle 最高 Power 5/5 审查已完成。最近改动的职责划分与执行包基本一致，本轮范围内没有确认需要删除的新框架或无依据防护层。Oracle 对 SQL 时间条件的一项意见经后续领域核查撤回，具体依据见第 4 节。

## 后续提交核查

用户授权后，按第 7 节执行了隔离回放。最终检查使用原成功候选和查询结果，复制所需合成资料及会话到临时 MySQL 库，由真实 Worker 创建新的恢复 attempt。Pi 采用独立 journal 副本的 `pi_session` 存储引用，原 leaf 和历史条目保留，原 journal SHA256 复核一致。凭据连接使用符合合同的测试回复，其余正式提交、权限及来源核验、页面快照读取均沿真实 Rust/MySQL 与合成平台路径。

最终 `/internal/finish` 返回 HTTP 200，耗时 1626ms，完整恢复 RunEnvelope 为 27176 bytes。这些数值属于本轮回放。以下断言全部通过。

- 655 字正式正文与原成功候选逐字一致。
- 原 owner 通过会话快照重新读取时，正式答案完整可见。
- 通知 job 为 `finished`，所属任务为 `answered`。
- 重复提交同一 FinishRun 接回原成功回执，正式 committed 事件只有一份。
- 模型账本行数零新增，Node 调用只包含配置连接与正式提交。已有查询沿结果授权读取，查询执行零新增。

独立只读审查复核了上述断言与证据，并确认本次覆盖 Pi `pi_session` 入口。旧 `host_checkpoint` 兼容分支沿既有证据继承。记录见 `.local/checks/notification-commit-repair-20261106/runtime-storage-readback.log`、`runtime-storage-readback-result.json` 和 `replay-runtime.mjs`。

本轮逐步补齐回放时，修正了隔离副本的失败消息状态、缺失的公开服务元信息、测试连接字段、原 owner 和脚本引号。相关准备失败日志保留。最终完整通过结果单独记录。当前证据支持这条路径在当前条件下可用，历史失败的原始 HTTP 异常及耗时仍缺失，故障修复声明尚无依据。

通用性核对覆盖 `deliver.ts`、`RustTransport`、`finish_run.rs` 及相关答案来源组合。任务版本、查询引用、来源范围和正式输出决定交付，合成表名、458/6430 等题目答案及播放口径均未进入这些分支。业务定义来自语义资料，固定演示策略归属模拟模型，真实平台接入继续由平台适配器承接。

## 1. 审计范围与版本

- 基线为分支 `codex/semantic-maintenance-prototype`、HEAD `04d27d06ba7b97d4cf3e288d4cf9e6300ef491a9` 及当前工作树。
- 核对最近执行包、24 个范围文件、68 份证据引用，以及通知生成、Pi 恢复和正式提交的相关源码。24 个文件 SHA256 和 68 份证据的 SHA256/大小全部匹配。
- 更早阶段沿已有证据继承。本轮补跑本地 provider/Bridge 协议、答案状态及存量候选恢复，真实平台接入、全站视觉与长时间日常使用仍待各自验收。
- 本轮产物为审计报告、当前状态更新和本地验证材料。产品修复、服务启动和真实账户复验留待后续实施。

实施依据见[原执行包](../execution/semantic-runtime/provider-delivery-repairs.md)与[上一轮限定独审](provider-delivery-implementation-review-20261106.json)。本轮材料集中在 `.local/checks/provider-delivery-trial-audit-20261106/`。

## 2. 仍需处理的问题

### 历史正式解释保存失败的根因仍待实际运行确认

真实补充 attempt `A03-ff1322be-d4ed-4cd0-aec2-f3129514bd3a` 的执行顺序已经核实。

1. 一次只读查询成功，返回 `sample_count=458`、`first_audio_p95_ms=6430`。模型为真实 DeepSeek Flash/high，平台为现有合成 SQLite 适配器。
2. 首次结果通知有四次成功模型调用，`get_query` 和 `present_analysis_answer` 均成功。宿主发布了含成功候选的 Pi checkpoint。
3. 正式结果解释提交数为零。同一通知 job 四次 Bridge 返回 `500 unexpected_error`，后三次原生恢复均无新增模型调用，最终进入 `retry_exhausted`。
4. 失败后补充了宿主 HTTP 与 Bridge 阶段诊断，已有本地通过证据，真实故障仍待定位及复验。

当前定位范围是成功候选产生之后的交付与正式提交链。原始 FinishRun、RunEnvelope、HTTP 响应和内部异常缺失，具体根因尚未确定。`finish_run` 先保存候选 checkpoint，再执行正式回源核验与提交，这两个事务可分别成功或失败。应沿第二段取得实际错误，再决定改动。

原日志中的 `6430ms` 表示业务首包音频 P95。提交耗时、实际拒绝码和原请求大小仍缺证据。四次通知 job 尝试与模型临时失败次数属于不同记录，现有材料支持继续沿用原每消息 24 次调用和连续临时失败 3 次规则。

真实证据位于 `.local/checks/provider-delivery-implementation-20261106/real-verification/`，重点为 `final-outcome.json`、`native-checkpoint-and-safe-boundary.json`、`deepseek-persisted-projection-browser.json`。正式提交源码见 [finish_run.rs](../../crates/data-agent/src/use_cases/finish_run.rs)。

### OpenAI 真实可用性待配置与小样验证

原管理员查询结果中没有实际 OpenAI 服务，本轮 OpenAI 请求和 J19 新消息均为零。原模型页已支持选择 OpenAI 后采用 Responses 初值，精确型号与 `high` 档位有合成协议和浏览器证据。有效档位依照锁定 Pi 的 `configuration_update.reasoning.effort` 与原生历史 `providerThinkingLevel` 核验。

后续通过现有超级管理员页面私密配置新密钥，再沿原包限定代表场景验证真实工具往返。其完成度单独记录。曾贴在对话中的凭据按暴露凭据处理，凭据轮换由用户执行。

### 已有 SQL 的解释精度仍有质量缺口

原 J19 的模型输入已有完整 SQL，回答仍泛化出实际 SQL 中不存在的 `invalid` 列。该问题继续按解释精度记录。现有证据支持在修复交付后核对该代表题，通用 SQL 审稿器、强制补读流程和新 Agent 能力均缺少本轮需求依据。

### 当前试用入口需要恢复

本轮检查时 `5173`、`27173`、`19173`、`22780`、`22781`、`22790`、`22791` 均无监听。其他 owner 的 API 和共享设施保持各自归属。交给用户前，应启动选定实例，实际确认前端、API 与所选模型配置，并提供有效地址。

## 3. 实现与四条编程规则核对

| 本次实现 | 判断与依据 |
| --- | --- |
| HTTP 错误元信息和分阶段诊断 | 对应已发生的错误信息丢失。元信息位于 transport 边界，provider 和 Bridge 两处消费，私有 Symbol 保留原异常类型。日志采用固定路径、阶段、状态与有限原因。 |
| 按阶段保留 provider 与 finalize 失败 | 已有“provider 失败后结算也失败”的具体反例。局部诊断去重对应可解释的失败路径。 |
| Rust 提供 `frozen_notification_covered` | 复用 Rust 原有通知范围裁决，Node 消费同一结果。此前按 query ID 推断覆盖的逻辑已移除，职责更集中。 |
| 同源合同接线 | 字段同时存在于 `schema.json` 与生成的 Rust/TypeScript 类型，启动、刷新、恢复和工具回执均有接线。Oracle 的附件覆盖疑问已由现有产物补核。 |
| OpenAI 配置界面 | 复用原服务、模型管理、加密凭据、配置冻结和 Pi Responses。当前 delta 有明确业务用途。 |

上述判断限定于本轮改动与关联路径。正式提交时的权限、来源、条件版本和持久状态核验承担各自业务职责，应在取得具体失败原因后修命中的责任点。普通功能故障可据此收敛处理。

## 4. 撤回 SQL 时间条件缺陷判断

上一轮记录及 Oracle 都曾将“只有 `received_at < snapshot`，缺少单独的播放完成时间条件”列为 SQL 精度问题。本轮进一步核对领域资料后撤回此项。

合成资料明确规定每份事实的 `received_at` 晚于实际完成至少一秒，数据生成验证对 `playback_segment.finish_offset_ms` 也执行该不变量。因此 `finish_time < received_at < snapshot` 已蕴含所需完成时间约束。依据见 [时间与质量口径](../sources/cockpit/documents/time-quality.md)与[合成数据验证器](../sources/cockpit/verify_data.py)。

本轮以只读方式核对现有 1588 条播放事实，违例为零。原 SQL 与显式增加完成时间条件的 SQL 均返回 `[458, 6430]`。在当前已确认合成域内，这一项可以关闭，无需增加 SQL 修订或防护逻辑。该结论的适用前提是上述时间不变量。

证据为 `.local/checks/provider-delivery-trial-audit-20261106/sql-cutoff-equivalence.json`。原失败记录和原 SQL 保留，最新判断以本节为准。

## 5. 本轮验证及证明范围

| 检查 | 结果与范围 |
| --- | --- |
| 24 文件及 68 证据指纹 | 全部匹配，见 `scope-verification.json`、`evidence-verification.json`。 |
| 当前 configured provider 与默认 Bridge 接缝 | Node 26.8.1 下通过，14 次本地协议请求，官方请求零。日志为 `configured-provider.log`。 |
| 当前答案状态 | 21 项通过，使用真实 Pi/工具代码与受控宿主边界，官方及数据库请求零。日志为 `answer-state.log`。 |
| 保存候选的 Node 恢复 | 真实原生 journal 与成功回执重建最小 RunEnvelope，经当前 `deliver` 恢复 655 字候选，仅调用一次 `/internal/finish`，FinishRun 合同验证通过。官方及数据库请求零，原 journal SHA 保持。 |
| SQL 时间条件等价核对 | 只读现有合成数据库，1588 条事实满足不变量，两条 SQL 结果相同。 |
| 材料与增量声明 | `make verify-materials verify-delivery` 通过，覆盖静态材料和声明有效性。业务完成度仍由上列实际证据判定。 |

Node 恢复使用复制到自有临时文件的会话 header，宿主 finish 为受控边界，模型 profile 在重建输入中置空以验证已有候选可跳过模型。重建请求为 2006 bytes，该数值只描述本轮构造。真实 Rust/MySQL 最终事务与原完整历史 HTTP 载荷仍待核验。证据为 `replay-notification-node.mjs`、`node-replay-result.json` 和 `node-replay.log`。

## 6. Oracle 交叉审计处理

会话 `provider-delivery-trial-audit-20261106` 已完整返回，Power 5/5 由控件 ARIA 状态核实，临时浏览器与 profile 已清理。完整答复及会话状态保存为本轮目录下 `oracle-answer.md`、`oracle-session.json`、`oracle.log`。

- 采纳其首要判断，正式解释保存失败阻断完整日常试用，09 保持 active。
- 采纳其定位顺序，利用已有候选和 Pi 恢复路径，继续回放到真实 Rust 提交边界，取得首个具体错误。
- 已补核其材料缺口，新字段同源合同和精确型号/high 的证据均存在，相关工程结果可以在原证明范围内复用。
- SQL 时间条件建议经本地领域不变量和只读等价验证撤回，见第 4 节。Oracle 当时收到的材料缺少这项依据。
- Oracle 自述的边界提取回放使用其 Node 24 环境和合成合同替身，只作为审查参考。本项目执行证据采用第 5 节列出的本地结果。

## 7. 最小后续工作

1. 复用现有恢复 harness，在隔离副本中将存量候选送到真实 Rust 正式提交路径，记录首个实际错误、受控 HTTP 状态及事务结果。provider 发送和查询重执行次数应为零。
2. 根据命中原因修改所属实现，再验证候选保存、正式正文提交、刷新读取及通知状态推进。原失败 attempt 保留其身份与结果。
3. 恢复选定试用实例，确认访问地址。DeepSeek 完整流程先满足上述交付检查，OpenAI 另按私密配置及限定代表验证记录。

该路径以现有失败为验收目标。全量 100 题、十条综合轨迹和极限容量测试继续沿原取舍安排。
