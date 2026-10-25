# 多任务答案定稿、组合与v2集成

前置：04活动任务投影/历史用途、06完整工具2。需求 D03/D08/D09/D13/D15、C01/C02/C03/C04/C05/C07、A01/A02/A04；职责 M05/M06/M07/M08/M11/M12。合同为17.4的消息归属、分别交付和自然回答定稿。

## 结果与范围

同一消息包含两项分析时，每项按自己的来源范围调查、回答；切任务或中断恢复不丢前项答案，不把互斥来源混成新结论。仍只有原Pi会话、原用户消息、24次预算和一个最终output_id。

修改Pi `tools/data-tools.ts`、`session/deliver.ts`、检查点/输出；Rust `analysis_answers.rs`、`finish_run.rs`、context_authority及route组合，runtime outputs/runs、相应Schema/迁移、工作台展示和测试。复用工具账本和输出尝试，不另建答案账本、不强制保存报告、不新增模型汇总调用。

## 具体步骤

1. 消除单一answer槽随后续工具被清空的问题；每任务定稿保留宿主引用，不保存另一份可改正文。查询答案引用成功present_analysis_answer回执，继续验证数字/查询/来源；普通解释引用真实完整助手消息及持久输出片段。
2. 原route增加可选finalize_current_answer，仅声明完成并切换。M11按SDK调用绑定助手条目及实际已持久片段范围，不能让模型自报chunk/正文位置。先核对01留下的真实Pi事件顺序证据，在最终接入再次验证输出已持久；若锁定SDK无法支持该交接，给出调用轨迹和最小合同调整，不以message_end、换会话或额外模型调用代替。该助手消息只允许这一个route控制调用。
3. Rust核验当前任务、范围指纹、消息终止原因不是error/aborted/length、片段连续完整、前序工具结算且没有同条混杂检索/写入；同事务冻结本任务part并切换活动任务。普通route不定稿，message_end不自动当完成。
4. 最后任务仍用原无工具自然final；查询结果仍沿答案工具，不强迫普通解释调用它。新answer_parts是有界、有序的原引用，绑定task_ref/生成范围/实际来源，边界从实际消息任务集合推导，不能为拆任务新增费用额度。
5. finish_run逐part核验当前可交付性，正文取原回执/输出，确定性加任务标题和分隔后同output_id一次原子提交。不能模型拼总论、追加跨任务比较/合计/因果。部分失效明确失败/未完成，不静默删掉后称全部完成。
6. 切到任务B后，模型可见A完成控制信息和宿主引用，不见A受限正文；最终组合也不能不分任务再注入后续上下文。按任务来源核验，不继续用整个run来源并集。
7. A已定稿、B中断后恢复沿原part引用；失败/取消仅影响相应任务，原已完成部分不重放副作用。SDK操作身份、origin run、budget scope、会话都保留。
8. 06资产、范围、容量、历史、旧调用兼容与本包交付测试均通过后，在已连接新公共集合的专用验收实例验证新消息tool_contract_version=2，并形成可切换版本；默认切换由08按索引先行顺序完成。既有登记v1操作继续按原合同；不同时维护两套可任意选择的新业务实现。

## Pi事件与输出持久化验证

基线锁定Pi1.3的agent-loop先完成assistant消息并发message_end，再执行工具；但AgentSession先通知公开订阅者再写SessionManager，且公开回调不await。项目output-stream另有异步缓冲。因此**不能在message_end订阅回调里直接冻结答案**。

优先在route的异步工具execute边界，用原SDK调用ID通过SessionManager的getBranch/getEntry定位所属完整assistant条目，再await现有output.drain确认片段持久，复用invokeRecorded/checkpoint/journal原链提交。实现前重新核对锁定源码，不把本段当新SDK保证。工具当前顺序执行不证明消息里只有一个route，必须检查整条assistant的toolCall集合。

本地协议小样至少包含中文/emoji正文→message_end→单route→下一任务；检查输出写库失败不冻结/不切任务、同条混工具拒绝、length/abort/缺chunk拒绝、冻结后丢回执按原身份恢复。证明后再扩大到answer_parts完整链；这证明SDK与宿主交接，不证明真实模型每次都会正确选择定稿时机。

## 验收必须观察完整交付

- 同消息A只用文档A、B只用文档B：A定稿→B被中断→恢复；刷新后两份答案各一次，内容完整，B实际模型输入无A正文。
- “我先查一下”出现message_end不定稿；error/aborted/length、缺chunk、前序工具未结算或同条混工具均不定稿。
- 普通route不冻结；最后任务自然回答定稿；查询答案数字核验未绕过。
- A已经通过显式route或成功present_analysis_answer回执冻结成part，B后续保存确认不清空A。未冻结的普通工具前文字仍可能是调查过程，保存后需模型正常给完整final；保留“不猜拼调查正文”及“纯保存确认可以短答”的旧回归，不要求每个回答必须保存。
- 后续B的检索/写入不能清空A；最终某part失效不能静默消失；只有确定性分隔，无额外模型汇总。
- 取消A不取消同会话B；新条件出现，旧查询晚到仍归原任务/条件；全部沿原24次计数和3次临时失败规则。
- 新v2消息、旧v1恢复、历史分析复述、个人记忆和已选Skill一并回归。

## 检查与交接

扩展 tests/runtime `check-answer-state.mjs`；tests/mvp `check-final-answer.mjs`、`check-grounded-answers.mjs`、`check-answer-phase.mjs`、`check-result-notification-answers.mjs`、`check-mixed-task-cancellation.mjs`、`check-mixed-task-pi-continuation.mjs`、`check-mixed-task-bridge-cancellation.mjs`、`check-conversation-timeline.mjs`。用真实持久输出与provider输入断言，不只验证字符串拼接。

关闭时记录新消息v2的可切换位置/条件、旧操作接回路径、每part来源追踪和故障恢复结果。数据结构仅向兼容版本回退；旧单槽writer不能继续写新part状态。08完整升级演练仍必做，本包局部通过不代替它。
