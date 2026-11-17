# 09 答案交付修复与有限收尾执行包

编包日期：2026-11-06。当前基线、执行进度和最终证据只在[CURRENT](../../CURRENT.md)维护。本包接续[上一包](dogfood-followup-repairs.md)已完成的工程工作，目标是解决正常说明被等待状态覆盖，以及合法查询答案被通知接入层拒绝的问题。审计依据见[根因与交叉审查报告](../../reviews/dogfood-delivery-root-cause-audit-20261106.md)。本文是实施规格，不是产品已修复证明。

## 1. 启动入口与完成边界

先读AGENTS、CURRENT最新摘要与`delivery.increment`、本包第1–2节。随后按任务读取第3–7节的代码和证据。不要从九阶段原包开头重做，也不要先加载全部历史日志。

接手基线：分支`codex/semantic-maintenance-prototype`，HEAD `04d27d06ba7b97d4cf3e288d4cf9e6300ef491a9`。上一轮限定审查的61份文件在本轮编包时全部SHA匹配；大量未提交变化属于继承工作。接手重新核对，不reset、不覆盖，不用HEAD全量diff归因本轮。

当前固定核心21项为20 pass / 1 partial，剩余J19；已批准补充来源前提的唯一续聊轨迹pass。A03用户报告成功，但两个自动结果通知失败，不能被核心表的pass掩盖。原100项/十轨迹保留为后置回归库，不自动全跑。

| 顺序 | 交付目标 | 任务必读 | 完成证据 |
| --- | --- | --- | --- |
| 基线 | 区分继承代码与本次修改，取得真实失败 | 本节、审计报告、本地诊断结果 | 当前文件指纹、既有接缝RED |
| 正常说明 | SQL等待确认时，正常完整正文可持久交付 | 第3节 | 普通final、恢复、刷新和SQL未执行 |
| 查询通知 | 已核验的多任务来源可证明原通知已被解释 | 第4节 | 实际Rust回执→Node→正式输出、原query/condition保持 |
| 维护诊断 | 说明残留失败哪些有原因、哪些缺证据 | 第5节 | 已有证据分类；必要时一个受控代表样本 |
| 验证收尾 | 受影响工程和必要真实路径完成 | 第6–7节 | 当版检查、独审、真实记录及清理 |

连续推进，不在每项结束后等用户批准。达到本包出口后停止，不自行增加第三轮优化或整套试用。

### 1.1 成功标准

1. 在同一任务中解释业务并保存待确认SQL，普通Pi完整最终回答无需额外`route + finalize_current_answer`即可交付。流式正文、正式输出、刷新后的历史与后续Pi上下文一致；SQL仍未执行。
2. 成功结果通知已经取得Rust核验通过的答案，且其真实来源包含通知原`query_id/task_id/condition_version`，Node不能因答案还包含另一任务的合法来源而判`answer_sources_required`。
3. 原冻结任务正文不丢失、不重复、不同任务来源不混装；旧操作、恢复、权限和原条件边界保持。
4. 维护失败按实际证据报告；已证一般原因在原模块内修复，无法重建的历史拒绝不得猜因或改判成功。
5. 工程修复、真实效果与剩余证据缺口分别交付。核心partial未消除时，不签主09完成。

## 2. 全局约束与不做的事

- Pi 1.3.0继续负责唯一模型/工具循环、会话、取消、压缩和恢复。复用原生最终消息事件、检查点投影和既有工具回执；不新增答案判断模型、文本分类器、计划器、自动定稿工具调用或第二套恢复循环。
- Rust继续负责权限、来源、查询状态、确认、幂等、原操作身份和预算。自然文本不能授执行权，也不能把查询状态改为成功。每用户消息24次调用、连续临时失败3次保持。
- 不新增业务工具、数据库表或迁移。合同只补两处已定位的宿主接线：`DataToolOutcome.answer_task_ref`复用`EvidenceTaskRef`表达原候选归属；`FinishRun.output_binding`复用`AssistantOutputBinding`接回无冻结前项的原自然输出。组合末项仍用既有`AnswerPartReference.output_binding`。按`contract-first`先改同源Schema再更新两端，旧字段缺省路径保持，不借此建立通用答案协议。
- 原题、原attempt、失败、partial、unknown、费用和原operation/origin保留。新的验证用新attempt，不改历史记录、不手工把正文补进旧output、不换账本或ID重发未知调用。
- 必要DeepSeek、整理模型、Embedding、Mem0沿本次09已有授权及原隔离环境执行；不增加逐题审批或测试累计费用门。服务商或现行账本的真实限制仍遵守；已确认的执行窗口恢复沿原ID和已用量处理，不补额。权限只覆盖09隔离实例及工程harness，不覆盖日常服务、部署或Git远程写入。
- 不改检索架构、切块、模型选型、容量配置、合成语义、指标定义、UI布局或已通过的权限轮询。除实际新证据外，不重做结构采用、预填材料、旧决定恢复等上一包工作。
- 四条工程规则：保护只用于已证故障/明确合同/可解释的普通风险；外部边界校验后内部传类型，不重复验证不变数据；简单单用逻辑就地写，真实复用或独立职责才抽取；`catch`仅为实际恢复、边界错误翻译和清理。不要以“理论更稳”为由增加低概率并发处理，不编造概率。
- 测试证明上述行为；扩现有接缝，不按状态组合穷举，不为行覆盖率堆案例。无相关变化不重复构建和昂贵回归。DB harness串行，保留编译缓存。

## 3. 正常解释与SQL状态分别交付

### 3.1 已证根因与落点

J19真实run生成3001字完整说明，最后正式输出只有71字控制摘要。该run的5次模型调用全部settled。本轮补读原生Pi记录发现：模型曾发出`finalize_current_answer=true`，但同条助手消息没有正文，被Node在登记前以`answer_output_incomplete`拒绝；随后它正常生成了`stop`、无工具调用的完整正文。条目`0cb33f51`随后被`context_edit`条目`4e9a336b`替成71字控制摘要。因此旧总结“模型没采用定稿协议”不完整，不能据只含已登记调用的工具日志继续归咎模型。

本轮本地诊断也通过实际Node/Pi和回环协议复现正常`stop`被control覆盖。最终正文与已保存流式正文SHA一致，不是累计过程文字拼接；原历史输出不人工回填。

必读文件：

- `apps/agent/session/deliver.ts`：`selectDelivery`、`commitAnswer`、前后两个恢复快路、`message_end`/输出片段绑定。
- `apps/agent/session/workspace-context.ts`：`deliveryContextEntries`、`applyDeliveryContext`、`agent_before_settle`。正式正文与Pi投影必须消费相同选择。
- `apps/agent/session/resources.ts`与`apps/agent/tools/data-tools.ts`：同任务必须额外定稿的指令。
- `crates/data-agent/src/use_cases/{finish_run,task_answers}.rs`：自然提交、任务等待相位、原冻结组合和控制来源。默认保持其查询状态/来源规则。
- `crates/data-agent/src/modules/runtime/{outputs,store}.rs`、`apps/agent/session/{checkpoint,journal,output-stream}.ts`：原片段绑定、恢复链读取及Pi检查点位置；第3.5节已核现有能力，不另造恢复存储。
- `tests/mvp/check-waiting-task-delivery.mjs`、`tests/mvp/check-control-context-edit.mjs`和`tests/runtime/check-answer-state.mjs`。
- [实现设计17.4相关合同](../../architecture/implementation-design.md#17-语义检索与上下文的实施合同2026-10-23)。本包纠正同任务普通最终回答必须额外定稿的限制；跨任务中途冻结及已保存格式继续有效。

### 3.2 交付选择合同

“正文完整”用SDK结构事实判断：当前适用助手条目`stopReason=stop`、无未完成`toolCall`、有非空文字，并且原消息、任务/版本和来源核验允许交付。不根据字数、关键词、“已完成”等句式或另一次模型评分猜测。

| 当前事实 | 允许的交付 | 不允许的替代 |
| --- | --- | --- |
| error、aborted、length或未完成工具组 | 沿原失败/取消/截断恢复处理 | 用旧候选或控制文字伪装完整成功 |
| 成功查询通知尚无覆盖原查询的有效答案，且结果未被查证为不可用 | 沿既有一次来源补正交回Pi | 自然末条或等待摘要绕过结果来源 |
| 已查证原结果过期、不可用或无权读取 | 沿既有`resultUnavailable`路径说明实际状态，保持原权限/错误处理 | 当成模型漏来源而强补轮、伪造结果或重跑查询 |
| 本轮仍有效任务均已有原冻结正文 | 原有序引用交付 | 再附同任务礼貌结尾或改写冻结正文 |
| 当前适用已核验答案 | 原回执正文；有前项时按原交付任务组合，完整保留每个来源身份 | 用来源任务反推交付owner，或丢前项 |
| 当前未冻结任务有正常完整自然final，同时SQL待确认/执行中 | 正常正文；已有别的冻结任务时保原前项 | 仅因waiting状态而替成控制摘要 |
| 没有可用的新正文，Pi已正常结束且只有合法控制/澄清事实需要呈现 | 原宿主控制投影与合法冻结前项 | 仅见数据库waiting就跳过尚未完成的Pi调查 |

表中错误处理、通知来源义务、任务覆盖分别适用，不能只写成一个不看归属的`natural ?? control`。特别保留上一轮DFR-002场景：B已冻结但A仍需控制说明时，不能只提交B；B的尾句也不能被当成A的正文。

### 3.3 实施动作与删除边界

1. 在原测试中补“完整自然解释 + 待确认SQL + 不额外定稿”的RED。测试必须穿过真正`deliver`，不能仅断言一个新helper的返回值。本轮`.local/checks/dogfood-delivery-audit-20261106/delivery-probe.mjs`可作定位参考，不直接把HTTP替身的成功当Rust业务通过。
2. 调整交付选择，去掉waiting状态对正常完整正文的无条件优先级。自然正文仍走现有`FinishRun.final_text`、输出片段和来源检查；Rust原`task_waiting_phase_in_tx`保持SQL等待相位。
3. `agent_before_settle`与finish使用同一候选规则。正常正文不得先在Pi投影里被控制摘要替掉、随后才在正式output中补回。利用现有闭包/同模块函数统一真实复用，不新建交付框架。
4. 核两个恢复快路，并按第3.5节补上候选恢复。仅去掉提前提交并不够：`completedAssistant/completedTask`目前只在本次`message_end`赋值，已消费成功toolResult也不在`pendingCalls`中。应在`RECOVERY_NOTICE`派发前恢复本输入仍有效的完整正文或成功候选；有原可交付内容时直接finish，不重新调用模型。只有waiting快照、工具未接回或调查未完成时仍由原Pi机制推进；全部原冻结项确已覆盖的零模型快路保留。
5. 删除resources和工具说明中“同任务正常最后回答必须再route定稿”的强制指令。跨任务中途定稿仍说明何时使用`finalize_current_answer`；旧已登记同任务handoff继续按原格式接回，不删兼容、清表或迁移历史。
6. 不新增“模型说已执行”的文本探测器。原测试若断言所有未显式定稿自然文字都必须被丢弃，将它改成真实产品不变量：文本不会生成执行授权、提交查询或改变查询结果，页面状态与原查询记录一致。记录旧值、新值、原因及独立依据，不静默改预期。
7. 不因为修自然正文而放宽`assert_natural_scope_in_tx`、结果来源门、撤权检查、冻结身份、输出完整性或SQL确认。

### 3.4 最小验证

扩原waiting接缝，一条普通完整说明同时检查正式输出/重读、任务仍waiting、查询未提交；保原显式冻结兼容和B冻结/A控制用例。沿原恢复接缝覆盖“完整final及原输出绑定已进可恢复检查点、finish尚未提交”：实际deliver与Rust finish恢复后模型调用增量为0，正文逐字一致，原entry/attempt/片段可追溯，SQL仍未执行。组合末项复用同一原绑定接缝，不另建恢复harness。已提交但响应未知复用原幂等用例，不能与尚未提交混为一条断言。沿原context-edit接缝确认下一轮/检查点读出的正文一致。复用原error/length/未完成工具和撤源负控，不另建排列矩阵。

本轮诊断的`checkpointEdited`只是对序列化字符串的粗检查，不能作为上下文正确或错误的证据。正式测试应使用Pi解码/投影结果，并观察实际下一次请求的相关内容。

### 3.5 恢复的具体接线

本地已核：`read_bound_output_in_tx`并不要求原attempt等于当前attempt；其私有`attempt_chunks`先核同一`output_id/conversation_id/recovery_chain_id`，再读取原片段，`bound_output_text`核连续前缀、范围与正文SHA。拦住组合自然末项的是`task_answers::compose_in_tx`额外的attempt相等检查。无前项的`finish_run`则只能读当前attempt片段，现有`FinishRun`没有携带原自然输出绑定的位置。这是两个具体缺口，不用新增恢复链或输出表。

1. **保存宿主位置，不复制正文。** 正常完整自然final经`output.drain()`确认片段后，用Pi 1.3.0已有`SessionManager.appendCustomEntry`保存原输入/恢复链、生成时task_ref及`AssistantOutputBinding`；使用业务名，如`data_agent_output_binding`。该custom entry不进入模型上下文，正文继续只存在原助手条目和输出片段。沿现有检查点导出/持久路径保存可恢复leaf，不读越过宿主已确认leaf的本地尾部，不另建提交日志、定时快照或恢复队列。普通流式未完成条目不能生成这个完成绑定。
2. **还原本输入最后仍有效的候选。** 从原生分支、原输入定位与有效context projection恢复`completedAssistant/completedTask`及原输出绑定；成功`present_analysis_answer`则取对应toolResult与SDK身份。后续工具调用/错误、任务版本或来源变化沿已有失效规则处理，不扫描到任意旧成功就交付，也不重新喂入被权限投影删除的文字。只恢复最后需要的候选，不重放全历史工具。
3. **已消费toolResult与pending call分开。** 尚未接回的工具仍走原`invokeRecorded`。已经成功写入检查点的答案回执无需重执工具；缺第4节的新归属字段时，用原SDK身份与原参数走`/internal/data/tools`现有成功receipt回放，取得补字段的返回副本，不再调用登记入口创建新操作。Rust复用原成功行和原指纹；没有原成功证据时不能把它当零模型可交付候选。候选恢复和正常工具成功应共用同一内部采用规则，不复制两套失效逻辑。
4. **无冻结前项的自然输出。** 为`FinishRun`增加可选`output_binding: AssistantOutputBinding`，只用于自然final；存在该字段必须有`final_text`，不能同时带`answer_parts`、`answer_sdk_tool_call_id`、`control_delivery_ref`或`final_start_chunk_seq`。Rust复用`checked_natural`、原scope/authority核验及`read_bound_output_in_tx`核原文相等，把原`OutputChunkRange`保存到原`read_binding`；不把旧正文附到新attempt空片段上，不重新广播旧delta。原无此字段提交保持原行为和序列化指纹，旧已提交请求原样接回。
5. **有冻结前项的自然末项。** 继续发原`AnswerPartReference.output_binding`。将“必须当前attempt”改为现有runtime已提供的同输出/同会话/同恢复链、片段范围及SHA验证，保stop、无工具、原task/version、scope与全部冻结前项；不是简单删除attempt检查后信任客户端正文。原读取单元保留旧attempt/片段身份，不重新冻结或修改原handoff。
6. **新旧检查点边界。** 新格式有完整正文及绑定时必须零模型接续。旧显式handoff及旧成功工具回执沿原持久证明兼容；旧自然检查点确实没有可证明输出位置时继续原Pi恢复，不伪造当前attempt绑定，也不为补齐所有历史形状建立迁移框架。无新内容、只有waiting状态的恢复，不能因此声明正文已完成。原commit已成功但响应未知时接回原commit结果，不重新组合或改变提交指纹。

**检查点发布落点。** 不能只追加本地custom entry，就声称它已进入Rust确认的恢复leaf。当前保存入口是工具登记、范围刷新和finish，范围刷新还要求原成功`context_reset`，不能伪造一次route/刷新来保存final。新自然输出绑定在现有`finish_run`准备阶段接入：先接回已提交请求；对尚未提交请求，在当前会话/运行/租约与原片段绑定有效的事务里保存候选检查点，再沿现有锁外来源核验和最终事务提交正文。候选检查点保存不代表正式答案通过，后续恢复仍核来源/条件；最终正文、read_binding与完成状态仍原子提交。复用原`save_checkpoint_in_tx`及其宿主authority，不建新端点、定时保存器或双份提交账本。原无字段路径保持，避免同一未变检查点在同一路径重复保存。恢复测试须在真实发布点之后、正式提交之前中断，不能由测试直接往数据库塞一份不存在的产品检查点；请求尚未到达宿主的本地尾部不承诺零模型恢复。

上述仅补应用输出位置与SDK检查点之间的薄接线。模型和工具推进、压缩、会话分支仍由Pi负责；不新增自动定稿模型、应用级Agent循环或恢复调度器。

## 4. 查询通知按实际来源覆盖判断

### 4.1 已证根因与接口职责

A03两次通知在`present_analysis_answer`成功后仍失败。已存真实回执包含两个任务的合法查询来源，其中明确包含通知原三元组；`data-tools.ts`却只在来源恰好属于一个task/version时填写`AnswerCandidate.taskRef`，`notificationAnswer`又强制匹配这个唯一引用。因此不是缺查询结果，也不能靠再提示模型“请给来源”修好。

Rust `finish_run.rs`的单答案路径已要求sources中存在原查询三元组，并不要求整份答案只能引用一个任务。`task_answers.rs::original_text_in_tx`和`compose_in_tx`却又要求每个source等于part的task/version。这是同因的另两处限制，需要一并修。**一份答案只有一个交付归属，不代表它只能引用该任务自己的结果。** 多份已核结果仍必须符合交付任务的原来源限制，不能自动合并各任务允许集。

| 边界/消费者 | 应保留或消费的信息 | owner |
| --- | --- | --- |
| 成功`present_analysis_answer`回执 | Rust已验正文及实际sources | Rust答案/结果用例 |
| Node内部候选 | 原sdkId、正文、原工具登记的task/condition、全部实际source三元组 | `data-tools.ts` |
| 结果通知覆盖 | 是否包含通知原query/task/condition三元组 | Node选择，Rust最终核对 |
| 单任务冻结/组合末项 | 固定交付task/condition及其scope；来源可有多个原任务，逐份核验 | 原task_answers合同 |
| 正式历史/权限 | 原回执来源、旧条件和输出单位 | Rust runtime/authority |

### 4.2 实施动作

1. 复用真实回执形状补Node候选RED；再在`tests/mvp/check-result-notification-answers.mjs`中让真实Rust产生两个任务的成功结果并返回合法混合来源，驱动真正Pi→finish。不能只把单测mock改成接受混源。
2. 先修合同语义。给`DataToolOutcome`增加可选宿主字段`answer_task_ref: EvidenceTaskRef`，只在成功`present_analysis_answer`回执使用；它表示**原工具登记的候选归属**，不是该run全部答案统一采用的通知目标，sources继续表示实际依据。模型参数不新增归属字段。Schema、生成边界类型和接入样本同源更新，不在Node手抄公开形状。连同第3.5节的输出绑定一次完成合同接线，随后按行为逐项RED/GREEN。
3. Rust使用首次登记工具行已有`task_id/task_condition_version`给出候选归属；`LockedTool`目前未暴露这两个列值，沿runtime owner的现有锁定读取带出即可，不在use_case写跨owner SQL，不新增表。新成功回执随原字段保存；旧receipt只补返回副本，原存储字节和幂等指纹保持。**禁止在通知run内把所有成功答案统一标成通知A**：模型可能先完成B并冻结B，再交付A的原条件答案。新字段与原登记矛盾应明确拒绝，不能靠另一种fallback静默覆盖。
4. 消费归属分三种：普通候选/普通显式冻结用原工具登记；真正承担通知的单答案或末项用原通知query绑定并核其适用scope；已冻结项恢复用原handoff/reference的owner和scope指纹。内部候选保留全部source三元组；通知覆盖核**同一条source**含原query/task/condition，不能对三个集合分别`includes`拼接。旧普通回执缺字段可由原登记证明，旧冻结项还可由原handoff证明；旧通知缺字段只要原通知身份和实际来源可证明，仍可沿通知路径交付，不依赖当前active task。只有相应原证明都不存在才明确不充分，来源恰好唯一不是owner证明。
5. 成功回执在现有外部边界解析一次，内部传明确类型；Node不重跑Rust逐来源核验。`invokeRecorded`、工具失败和新操作使旧候选失效的规则保留，不从模型参数生成来源权威。
6. Rust冻结读取和组合末项删除“全部source task/version等于part owner”的检查，按第4项各自消费绑定，复用既有`analysis_answers::check_in_tx`及scope/authority检查。逐个结果的本人/空间/同会话、原query/condition/result_ref、访问权、适用范围保持。`finish_run`无parts的单答案分支也要消费原候选归属/通知目标及适用scope，不能只放宽Node和组合。回执新字段有值时核其与原候选登记一致；通知目标可不同，但须独立满足原通知三元组和原scope，不另加“候选owner必须等于通知owner”的限制。原scope指纹、完整正文、旧前项和操作身份保持；不把多任务许可取并集，不把旧来源升级为新条件。
7. 已有冻结前项时，允许一个归属明确的末项合法引用多个原任务结果，整份正文不拆写、不改写；前项继续沿原引用显示一次。不能用“请模型改成单源再回答”绕过本次一般性修复，也不能丢前项改走单答案。旧单源组合和自然末项继续有效。
8. 一并处理`notificationCoveredByFrozen`、Rust `delivery_coverage_in_tx`、`compose_in_tx`整体覆盖检查和`finish_run`的refs构造，不能只修末项来源。区分三个事实：哪些任务有正文/控制交付；哪些实际采用的成功回执覆盖原通知；本次应推进哪些任务。owner为B的冻结答案实际覆盖通知A时，允许仅交付B原正文，不要求另造A part或重复生成A尾项。Node可用`source_query_ids`与原查询定位，Rust最终从实际采用的成功回执核原query/task/condition及原通知适用scope，不能信Node布尔值或只看query ID。有parts时，状态推进包含原显式owner与本次确已覆盖的原通知绑定；其他被引用来源任务不自动结清。A已修订、仍有待确认/运行中查询、开放澄清或生命周期限制时沿原规则处理，旧通知不能结清新条件。B的宽scope不能代替A的许可。不新建覆盖状态机、台账或协议，当前函数用既有引用/回执计算即可。
9. 选择、流式抑制、settle投影及finish采用一致资格。无冻结前项沿原单答案接口，有前项沿原组合接口；合法混源不应额外调用模型。只有实际来源不足才使用既有一次补正，不新增重试循环。

### 4.3 验证范围

复用原结果通知和冻结组合接缝，以下三种行为覆盖不同消费者，不能只用一个Node单测代替：

- 无前项：真实Rust成功回执含原通知及另一个合法来源，Node直接采用、正式原文持久、重开仍在，无来源补正补轮、无重复查询提交。恢复时成功toolResult已消费的候选也能接回，不再调用模型。
- 通知A处理中先present并冻结B，再交A原条件的混源末项：B保原登记owner，末项按原通知目标交付，两份正文各一次。把旧receipt缺新增字段的恢复放在这条接缝，核原存储字节不改，不另建兼容矩阵。
- 只有B的冻结正文、已实际覆盖原通知A：无A末项仍可提交；Rust覆盖检查通过，B按其交付推进，A仅按通知原条件推进，其他引用来源任务不结清。复用旧条件负控证明A新版本不被旧通知改变。

保原P≠Q、不同source允许集不可并用、结果不可用/过期/撤权和失败后候选失效负控。三元组交叉拼接、当前活动任务重绑旧答案、借B范围扩大A许可均不允许；不按排列组合增加测试，不建新harness。

## 5. 维护失败：有边界地定位，不重跑整库

上一轮`source-boundaries-queue-terminal.json`仍有`invalid_prefill`、`invalid_input`、`model_unknown`与partial记录。该文件是当时列出的13个来源状态，不证明全系统13份都发生同一种失败。来源整理`source_preparation`与对象预填`semantic_prefill`是两条路径，不能将前者继续失败算作后者修复无效。

当前证据可证明：失败时只保留粗错误码，`fail_preparation_in_tx`清除了frozen_batch/pending_draft；缺少原始拒绝草稿。不能凭token数量判断为上下文、JSON、引文或供应商问题。三笔维护issued未知仍保原调用和预留，call_state被清空不等于已结算。

### 5.1 首先只读

查看已有记录中能定位的source/revision/sequence、analysis或review阶段、调用状态与usage，检查现有本地wire是否保留对应材料。只取诊断所需的合成证据，不读或记录凭据。可恢复原响应时，用现有validator离线重放，先得到明确拒绝分支再改代码。

必读：`crates/data-agent/src/use_cases/source_preparation.rs`、`modules/ingestion/preparation/{mod,store}.rs`及`tests/mvp/check-semantic-preparation.mjs`。日志入口位于本包审计报告。

### 5.2 若历史证据不足

- 不补造历史根因，不把坏JSON统归模型弱，也不直接放宽校验。
- 允许在原边界增加最少的诊断信息：现有日志关联source/revision/sequence/call与阶段，记录拒绝分支及必要数字/位置。保持现有对外错误码；不记录完整模型正文、完整提示词或真实资料，不建表、留存平台、通用异常层或全局日志改造。
- 仅在可用原显式维护入口且该操作已知终态时，选择一个当前核心确实依赖、可代表失败类别的来源做必要新尝试；先确认材料和新日志能区分假设。未知issued先查证原调用，不能换ID重发。不能为凑日志启动所有文档或重建全部索引。
- 可复现的工程原因就在所属模块最小修复，复用原validator/维护接缝验证。若需要改变产品合同、引入新能力或重做维护架构，停止该分支并给具体证据与取舍，其余交付工作继续。
- 同一原因再次失败且无新证据时停止重复；保留实际缺口。单个样本成功不代表所有历史失败已修。

本任务的必要出口是有据分类及有限诊断，不把“所有维护记录全绿”新增为本包的无条件目标。新发现若确实阻断当前核心，不能绕过它签09完成。

## 6. 验证顺序与真实补验

### 6.1 工程检查

新增行为先在既有接缝取得RED，再实现GREEN。将本轮新增断言绑定到CURRENT原验收；`SAME-TASK-EXPLANATION`从“必须显式定稿”修订为本包自然final合同，新增通知来源覆盖绑定原脚本。旧GREEN不证明新断言。

下列是受影响检查的入口，不是要求每改一处都顺序重跑整列。开发中先跑能区分本次行为的原接缝/已有筛选；确有必要的完整检查在连贯边界运行。保存完整日志、真实退出码、代码/测试身份；输出只汇总失败片段。

```sh
node tests/runtime/check-answer-state.mjs
node tests/mvp/check-control-context-edit.mjs
node tests/mvp/check-waiting-task-delivery.mjs
node tests/mvp/check-result-notification-answers.mjs
node tests/mvp/check-task-query-answers.mjs
node tests/mvp/check-task-query-answers.mjs --history-permissions
```

其中历史权限检查用于确认新提交正文进入原输出来源绑定；已存在且指纹/行为仍适用的其他权限浏览器、语义结构、目录轮询结果可以复用。若第5节实际改维护代码，再执行原`check-semantic-preparation.mjs`和相关owner窄检查；没有改动不追加一轮。

本地测试在子shell清除真实provider变量后运行：`DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL`、`DEEPSEEK_MODEL`、`DATA_AGENT_MODEL_PROFILE`、`DATA_AGENT_MODEL_FAULT`。不得把真实密钥传到会打印环境的cargo集成测试。DB harness串行；Rust有变化才在连贯边界分别重建API/Worker并核harness实际二进制，纯Node修复不反复重建Rust。沿`colima-data-agent`既有设施，不因偶发慢直接改租约/断言/资源配置。

第3.5及4节改宿主字段，先运行原生成器与`make verify-contracts`；旧合同GREEN不能支持新形状。受影响工程在连贯边界执行`make verify-code verify-architecture`；文档可用`make verify-materials verify-delivery`核声明。**当前active增量的`verify-delivery`是静态声明/要求覆盖检查，不执行绑定验收；`verify-increment`才实际运行绑定命令。** 前者可以在J19仍partial时运行，本轮编包已实测通过；不能把两者当同一个总gate，也不能把编译或声明通过写成业务通过。

已有当版最小GREEN后可进入第6.2节，不必先把整列完整套件跑一遍再立即由正式gate重跑。达到正式出口时由`verify-increment`执行其已绑定全套；若真实核心仍partial，补齐本次已改工程所需的完整检查并留下工程证据，不跑已知会被核心成绩阻断的总gate。不为此改检查器、增加缓存跳过或取消验收绑定。

### 6.2 真实补验只围绕本轮影响

先确认本地交付两项已经GREEN，再恢复同一09隔离实例及当前v2、大容量模型配置。保原库、集合、trial、费用和unknown。既有执行窗口/权限恢复按原记录办理；不更换实验身份或重置成绩。

1. **J19原问题一个新attempt。** 原问题原文见`docs/dogfood/cockpit/CASES.md`的J19和既有attempt；不要给模型注入本包修法、手工添加定稿参数或另写更容易的问题。验证普通完整说明正式提交、重开仍在、Pi后续上下文一致；原七稿ID/SQL/参数/条件/待确认/未执行保持。新attempt如正常产生新的草稿，逐项如实记录，不把其当旧七稿被改写，也不执行这些稿。另核正文质量：原说明前面按入口自身时间统计并保留无完整会话入口，末尾却说“五条都以合格轮次为基准”，两者冲突。修后应按每份SQL实际粒度与资料解释，不把所有查询统一套到turn.started_at/有效完整会话。不能仅以3001字成功保存就判pass，不为此题新增产品特判；若资料/提示有一般性错误先举具体证据。
2. **零分母与J06。** 已批准补充问题和独立SQL证据继续保留。仅交付选择变化不要求重跑J06，也不重做J19已证SQL分支；新回答若实质改变SQL或口径，才核受影响部分，保留旧attempt。
3. **A03通知。** 先用原真实成功回执离线经过修后Node，确认错误不再出现；这只证明工程接入。真实补验优先读取原结果，以新且可审计的普通验证输入使用现有结果，不重发已失败通知、未知操作或已执行查询。需要新自动通知时，只用原授权合成查询在正常用户流程产生一轮，注明新attempt；不得借重跑T02/S03整链制造通知。既有通知原失败保留，当前A03用户报告pass不倒改。真实模型是否再次选择混合来源不能强制；确定性接缝负责证明混合来源，一次必要真实路径负责检查实际接入。
4. **代表性浏览器检查。** 使用既有隔离页面，核新正文、普通刷新和SQL等待/结果卡状态。没有UI源码变化不重跑整套浏览器回归。

授权继续沿原09所需真实调用，不设置新的测试累计费用审批。先跑一个有区分度的代表样本；出现新失败按证据定位，同题无新依据不反复重发。没有理由扩大模型窗口、换模型或加机器资源。

### 6.3 停止与总出口

- 两个已证问题的受影响工程检查及必要真实补验完成后冻结本轮delta，做一次未参与实施者的限定独审；实际修复新发现后仅补受影响复查。
- 核心仍partial时不运行已知必败的`verify-increment`，不造完成收据。保存工程完成与真实缺口，停止本包；静态`verify-delivery`通过不提升业务成绩，不把“再跑一次也许会好”当下一步。
- 核心与所绑定要求确已满足且限定独审对应当前指纹时，执行`make verify-increment`；按其当版结果更新完成状态，再用`make verify-delivery`核关闭记录及收据。预检查可复用匹配证据，正式gate会运行绑定命令，按项目规则完成，不私造缓存跳过或删验收。没有新改动/失败理由不反复跑总gate。
- 保留100项/十轨迹原记录、旧failed/partial/unknown。更新当前汇总只能引用新attempt的真实断言证据，不回写原成绩。
- 收尾只停本轮自有隔离服务，恢复本轮改变的权限和expiry，保已用费用、预留和配置。无在途不等于unknown已解决。共享基础设施不随手关闭。

## 7. 文档、审查与交付

同步实际受影响的实现设计17.4、资源/工具说明、CURRENT及执行包入口。README只修当前状态的过时表述。模块归属和数据链路未变时不用重画架构图；若图中确有“等待控制覆盖最终正文”的连线，修对应源和渲染，不批量重制图。

独审核对：完整正文与状态是否分责；正常finish、恢复和Pi投影是否一致；通知三元组是否来自同一source；有冻结前项是否丢失或混装；旧失败/未知是否被重发；是否仍有强制同任务定稿；是否引入重复解析、新helper框架、无依据重试或无关测试。审查结论只覆盖本轮指纹，不能继承上一轮passed。

最终报告逐项给出：

1. 修复和删除的错误限制，具体代码/接口落点。
2. 新增或调整断言的原值、新值、理由，实际RED/GREEN与证据身份。
3. 本地协议/真实Rust与存储/真实模型/浏览器分别验证了什么。
4. J19及通知的新结果，历史失败和unknown保留情况。
5. 维护失败哪些查明、哪些仍缺证据；09整体是否可关闭及依据。
6. 本轮自有服务、权限和执行窗口清理情况。

本包不包含提交、推送、部署和更新日常服务。完成或达到明确有证据的阻塞后留下可恢复记录，交回用户。
