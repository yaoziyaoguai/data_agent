# 09 交付与 OpenAI 接入审计

本轮审计基线为 `codex/semantic-maintenance-prototype`、`04d27d06ba7b97d4cf3e288d4cf9e6300ef491a9` 及接手时工作树。上一包的 26 个范围文件 SHA256 全部匹配。当前状态以 [CURRENT](../CURRENT.md) 为准，实施入口见 [连续执行包](../execution/semantic-runtime/provider-delivery-repairs.md)。

本轮完成源码、已有真实记录和四个零官方请求的本地检查。Oracle 以最高 5/5 分别审查根因和合并执行包，两轮均已返回完整答复。第二轮要求局部修订后交接，相关意见已逐项落实并本地核对，见第 7 节。本轮编辑范围为审计文档、执行包、接手入口与当前记录，产品实施由下一执行者完成。

## 1. 上一包做到哪里

| 能力 | 本轮核对结果 | 证据边界 |
| --- | --- | --- |
| SQL 等待期间交付完整自然回答 | 已实现 | J19 正式正文 2865 字，普通刷新、重开及宿主确认的 Pi 投影同文 |
| 真正发布的候选检查点恢复 | 有工程证据 | 原输出身份与来源核验仍在，未发布本地 tail 按 Pi 继续 |
| 答案归属、结果通知目标与实际来源分责 | Node/Rust 均有接线 | 合法混源、冻结组合及旧回执回放有相应工程检查 |
| 冻结答案来源与当前活动范围隔离 | 已按职责分开 | 纯交付查证与当前运行取证登记分开，受限恢复有证据 |
| 维护失败阶段诊断 | 已实现并检查 | 可定位未来失败，历史缺失的拒绝材料仍无法恢复 |
| 必要真实结果通知 | 尚有缺口 | 新 A03 辅助 attempt 在下一次实际 provider 发送前失败 |
| 09 总完成 | 仍未达到 | 固定 21 核心记录均 pass，另列的必要真实路径仍 failed |

本轮未发现足以推翻上一包自然正文、输出绑定或来源分责实现的证据。原登记、通知三元组、来源权限和最终提交校验均承担已确认合同。当前审查范围内没有确认需要删除的新框架或过度保护层。

## 2. 已证工程问题与尚未恢复的历史原因

### 2.1 发送前异常被压成同一错误

`apps/agent/provider/controlled.ts` 的 `errorCode`、reserve 的 catch、SDK error 事件转换及外层 catch，会把多个宿主发送前失败改写为 `model_request_failed`。`apps/agent/transport/client.ts::post` 目前也没有留下定位所需的端点、HTTP 状态或传输异常类别。用户看到运行失败，接手者却无法知道实际失败环节。

本轮通过真实 `guardedModelStream` 和 Pi 协议接缝注入了五种情况，官方请求和数据库调用均为零。

| 注入位置与原因 | 当前结果 |
| --- | --- |
| reserve 的 `TimeoutError` | `model_request_failed` |
| reserve 的 `TypeError` | `model_request_failed` |
| reserve 的 `lease_lost` | `model_request_failed` |
| send 的 `model_receipt_unknown` | `model_request_failed` |
| reserve 的 `budget_exhausted` | 正确保留为 `model_budget_exhausted` |

这证明错误信息丢失这一共同工程原因。历史 A03 的具体底层异常仍缺证据，不能将其中某次注入当作原事件重现。修复从原错误转换处的有界诊断入手，随后按实际命中原因改动。宿主接口超时、供应商超时、明确拒绝和发送状态未知分别记录，沿原调用与结算身份处理。

本地证据在 `.local/checks/provider-delivery-audit-20261106/dispatch-reproduction.json`，可复现脚本为同目录 `diagnose-dispatch.mjs`。

### 2.2 A03 的事实边界

新辅助 attempt 为 `A03-0e520368-2792-4eb8-833f-116f3c2f513c`。第一笔真实模型请求成功并已结算，随后两次 `read_analysis_task` 和两次 `get_query` 返回 `task_context_required`。四个错误均作为原生 `toolResult/isError` 回到 Pi。

下一轮没有第二条持久模型调用记录，也没有第二次 provider wire。最终为 `model_request_failed`，无正式新答案。约 10069ms 与宿主 HTTP 的 10000ms 限制接近，只能提供排查线索。现有模型页的 600 秒供应商超时控制另一段调用，修改它无法直接改变宿主接口时限。

任务归属与来源范围门承担既有业务合同。J19 同轮已展示模型收到拒绝、route 后继续的成功过程。当前证据支持保留任务门和 Pi 原生错误回执，补齐发送前失败诊断。旧 A03 case pass、两条旧通知失败和本次辅助失败各保原身份。

原证据位于 `.local/checks/dogfood-delivery-implementation-20261106/real-verification/A03-failure-boundaries.json`、`A03-new-call-and-tool-facts.json` 和 `A03-current-native-failure-entries.json`。

## 3. J19 还有一处模型解释错误

新正文把日表概括为三类事实的 valid/invalid 计数，实际保存 SQL 的输出列为 `activity_date`、`valid_wakes`、`invalid_wakes`、`valid_sessions`、`valid_turns` 和 `vehicles`。对其他两类 invalid 列的泛化超出了原 SQL。

本轮进一步核对最终实际 provider 请求，消息索引 34 和 73 的历史成功工具回执已经包含该查询 ID 和完整 SQL 投影。由此可以排除“本次请求完全没有这份 SQL”这一解释。当前 `resources.ts` 也已有说明与实际 SQL 一致的要求。能确认的是模型在已有依据下仍概括错误，内部注意或推理原因无法从输出反推。

该发现撤回了本地初始的“未补读 SQL 因而错误”的推测。执行包采用同材料的 OpenAI 针对性验证，保留原 SQL、正文和成绩身份。这里没有依据增设每轮强制 `get_query`、SQL 审稿器或自动改写旧正文。若新模型也出现同类错误，留下实际材料与差异供后续产品取舍。

取证为 `.local/checks/provider-delivery-audit-20261106/j19-projection-context.json`，最终输入文件 SHA256 为 `6f0822525c4ab351e44c7218c4883f1bc3016c1f6b77cf23578ff1db5ee39b0e`。原 J19 pass 只覆盖原两条断言及正式交付，说明精度限制单列。

## 4. OpenAI 已具备接入基础，补实际配置与验证

现有超级管理员页面已包含 OpenAI、Responses、API Key 输入、模型定义、思考档位、容量和费率。Rust 已有加密保存、版本冻结、配置权限及启停处理。Node 使用 Pi 1.3.0 的 `ModelRuntime.registerProvider` 和原生 `openai-responses`。本轮配置协议检查通过三类原生协议，官方请求为零。

### 4.1 本次需要处理的配置问题

`ModelConfigurationPage.tsx` 切到 OpenAI 时保留原 `draft.api`。从新建表单会保留 Chat Completions，从 Anthropic 切换时可保留 Messages。这是可达的表单默认问题，建议将明确选择 OpenAI 时的初值设为 Responses，继续允许管理员按实际服务编辑支持的协议。

Oracle 另指出已知型号配错协议后，`configured.ts` 会走目录外配置分支。这个行为同时服务已有兼容端点，不能直接将所有目录 API 差异一律拒绝。当前包通过正确的 OpenAI 配置、所选型号的 Pi 目录能力检查和真实原生协议验证完成接入。通用型号能力注册表、Rust 复制整份 SDK 目录及全供应商协议禁用均超出当前需要。

### 4.2 型号和容量建议

建议首个可选模型采用 `gpt-6.1-sol`、Responses、`high`，支持档位按官方和本机锁定目录核对为 `low/medium/high/xhigh/max`。选择 high 是本次质量验证的建议，官方默认 medium 也可由管理员选择。账户能否使用该型号尚待新密钥的实际小样验证。[官方型号](https://developers.openai.com/api/docs/models/gpt-6.1-sol) [官方部署说明](https://developers.openai.com/api/docs/guides/deployment-checklist)

官方声明 1,050,000 tokens 总窗口和 128,000 tokens 最大输出。本机 Pi 目录仍为 272,000 总窗口，应用已支持显式 `context_window` 覆盖。采用已存在的容量合同，建议配置 C=1,050,000、I=900,000、O=128,000、8MiB、600 秒，由原公式推导压缩预留。真实端点极限仍属于后置压力验证。[官方容量](https://developers.openai.com/api/docs/models/gpt-6.1-sol)

两项配置费率只能表达应用侧折算。官方还区分缓存和长输入档，当前输入总量包含缓存，输出总量包含推理消耗。执行包明确费率单位与估算口径，复用实际 usage，范围限定在现有配置及结算机制。[官方价格](https://developers.openai.com/api/docs/pricing)

用户贴在会话中的凭据没有写入文件、发送给 Oracle 或用于请求。建议撤销后重新生成，通过原管理页或授权的本机私密入口注入。公开资料和交接 Prompt 仅使用占位符。

## 5. Oracle 提出的条件性疑点

`notificationCoveredByFrozen()` 用 `source_query_ids` 判断已覆盖通知，Rust `covered_notification_in_tx()` 还核原通知 scope。若一个宽范围任务的冻结答案包含通知查询及通知范围外的其他来源，两处可能产生不同判断。

本轮已核对两处实现差异，尚未以完整正常入口证明该组合可达及会造成提前结束。现有冻结、route、恢复链还有来源约束，局部条件差异不足以签成新缺陷。该项记录为候选，当前执行包只允许在现有通知接缝做一次有界可达性核对。成立且影响当前合法多任务交付时，沿既有宿主覆盖判断补最小接线。需要新增业务规则或复杂罕见并发保护时，先交回用户判断。若正常入口的前置条件已明确排除该组合，记录阻断位置并以不可达结束。若限定核对仍不能证明可达或不可达，保留未证结论并结束本包内排查，不升级为必修或整套回归。

Oracle 对旧回执回放污染受限范围、未发布 tail 误恢复的其他疑虑，也缺完整反例。上一包相应代表检查已有证据，本轮复用其范围，不据此新增恢复框架。

## 6. 当前维护残留

已列示 13 个来源分别为 3 个 `invalid_prefill`、2 个 `invalid_input`、3 个 `model_unknown` 和 5 个 partial。历史拒绝草稿缺失，无法逐个倒推出原错误。上一包已补阶段/原因诊断并经过 6 项 Worker 检查。

本包保留该事实和原 29 个 unknown、3 笔维护 issued 及预留。当前核心确需且有新证据的单个来源，可沿既有入口处理。整库重跑、清除未知、换账本补额和新增后台整理框架均排除在本包外。

## 7. 本地检查与交叉审计

本轮实际执行如下。

| 检查 | 结果 | 证明范围 |
| --- | --- | --- |
| 上一包 26 个文件指纹核对 | 全匹配 | 旧工程证据与接手源码对应 |
| `node tests/runtime/check-configured-provider.mjs` | exit 0，12 次本地端点请求 | 三类协议、usage、503、容量和服务修订隔离 |
| `node tests/runtime/check-answer-state.mjs` | exit 0，21 项 | 当前 Pi、工具和交付逻辑的已建代表接缝 |
| `diagnose-dispatch.mjs` | 完整输出五项观察 | 确认发送前错误信息丢失，官方/数据库请求 0 |
| J19 最终实际输入核对 | SQL 投影已包含 | 缩小为有依据仍概括错误的模型质量问题 |
| `openai-plan-check.mjs` | exit 0，官方/数据库请求 0 | 通过真实 Pi 目录与 `configuredModel` 构造 Responses，请求输出 128000、store=false、strict=false，high 由 configuration_update 传递，容量公式可行 |

默认 shell 最初使用 Node 22.23.1。核对 `.node-version` 后，四项可执行检查均使用锁定的 Node 26.8.1 完整重跑并退出 0，最终证据分别为同目录下的 `configured-provider-node26.log`、`answer-state-node26.log`、`dispatch-reproduction-node26.log` 和 `openai-plan-check-node26.log`。只有 `CONTINUATION_PROMPT.md` 因本轮更新交接入口而改变上一包范围指纹，其余 25 个范围文件在最终核对中匹配，见 `post-doc-scope-check.json`。

OpenAI 探针首次将顶层 `reasoning.effort` 等同有效档位而断言失败。读取锁定 SDK 后已确认该型号的原生 `configuration_update` 策略，并按真实协议修正诊断脚本。产品没有为此修改，首次失败属于探针假设错误，不计产品 RED。最终证据为 `.local/checks/provider-delivery-audit-20261106/openai-plan-check.json`。

Oracle 第一轮会话 `provider-delivery-root-audit-20261106` 已完成，日志两次确认 `Power, item 5 of 5 (slider ARIA)`，并捕获提交后的完整答案。其临时 Chrome PID 已退出，临时 Profile 已删除。答复位于 `.local/checks/provider-delivery-audit-20261106/oracle-root-answer.md`。

交叉结果如下。

- 采纳发送前阶段诊断、历史根因保持未知、保留上一包输出/来源主链、OpenAI 复用 Pi Responses 和最小多轮工具验证。
- J19 按本轮新取证收敛为模型解释精度问题，撤回强制重读的初始推测。
- 通知 scope 差异保留为条件性可达性核对，尚未列为确定产品缺陷。
- OpenAI 保存期通用能力校验与新增预设体系予以收窄，先沿已有配置和实际 SDK 接入完成所选型号。
- 本轮没有运行真实模型、启动日常服务或执行 `verify-increment`。API 账户可用性、必要真实通知及 09 完成仍由实施后的对应证据确认。

Oracle 第二轮会话 `provider-delivery-plan-audit-20261106` 对合并包完成最高 5/5 复审，两次 ARIA 档位确认及完整提交答复已保存。结论为 `needs_revision`，要求修订真实验收分工和执行措辞后交接。答复位于 `.local/checks/provider-delivery-audit-20261106/oracle-plan-answer.md`，会话与浏览器清理证据为 `oracle-plan-session.json`。该会话 Chrome PID 已退出，临时 Profile 已删除。

按本地代码与实际取证核对后，已落实以下修订。

1. 原 J19 输入已有完整 SQL，准确直接回答可通过解释精度检查。原定一次补充追问明确要求读取已保存 SQL 与状态，由它验证实际工具往返，分别记录两项结果。
2. OpenAI 新 attempt 显式选择型号和 high，以新用户消息创建并核对冻结 profile，沿原任务和七份草稿继续。旧消息恢复消费其原配置。
3. 诊断 RED/GREEN 观察结构化诊断。既有正确的 Responses、容量及 high 构造直接补充通过证据，避免为了 RED 改动错误语义。
4. scope 疑点分别记录已被前置排除、已证可达及尚未证实三种结论，一次核对后按证据退出。
5. Oracle 提及的 base_url 展示疑点经核为附件渲染差异，原文件已是纯配置值。原 Rust 费率计算单位已核为微美元，并补入执行包。

上述为对 Oracle 局部修订要求的本地落实，未再发起第三轮咨询。最终文档检查为 `make verify-materials verify-delivery`，只核材料和增量声明，结果见 `.local/checks/provider-delivery-audit-20261106/materials-delivery-final.log`。
