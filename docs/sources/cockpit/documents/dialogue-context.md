# 多轮、澄清、否定与换目标

业务域：公开合成座舱语音交互。此文是人工制定的实验定义，待维护者核对，不代表任何真实厂商标准。

syn_voice_turn记录一条输入及其终态；parent_turn_id指向需要沿用或取消的前一目标，独立新目标为NULL。同一会话可以多轮澄清，也可以切换目标，不能把session中相邻两轮都当作同一个任务。

syn_dialogue_transition保存轮内的状态迁移、迁移原因、上下文来源和user_decision。追问槽位时，provided表示本轮提供了回答，unanswered表示仍未回答，cancelled表示取消；不能只看到后一轮存在就把追问视为已解决。context_turn_id和槽位source_turn_id说明承接关系，不能依据时间接近自行补造关联。

这些记录足以核对已声明的状态和来源，不提供真实用户原话。final_response_text是合成应答，不能代替实际意图或效果回执。分析多轮达成情况时，要先说明按session、根目标或turn计数，并保留尚待澄清的目标。

final_outcome的eligible集合是completed、clarification_pending、rejected、failed、unknown；cancelled和no_speech单列，不进入任务达成率分母。clarification_pending代表目标尚待用户补充，不直接等于技术故障。parent_turn_id描述承接关系，否定、修改或换目标仍须查看状态迁移及上下文来源。

## `syn_voice_turn` · 用户交互轮次

任务达成率eligible为completed/clarification_pending/rejected/failed/unknown，排除cancelled/no_speech。识别一致性只用标签子集；completed、播报成功与满意不是同一指标。

- 行粒度：同会话的一条用户输入及任务终态记录
- 主键：`turn_id`
- 唯一键：(session_id, turn_no)
- 时间口径：维度按快照读取；事实按各自文档时点与接收截止核对。

| 字段 | SQLite 类型 / 空值 | 单位 | 含义与限定 |
| --- | --- | --- | --- |
| `turn_id` | TEXT / NOT NULL | — | 轮次主键。 |
| `session_id` | TEXT / NOT NULL | — | 所属多轮会话。 引用`syn_voice_session.session_id`。 |
| `turn_no` | INTEGER / NOT NULL | — | 同会话从1递增轮号。 下界：1。 |
| `parent_turn_id` | TEXT / NULL | — | 需要沿用或取消的前一目标轮次，独立新目标NULL。 引用`syn_voice_turn.turn_id`。 |
| `started_at` | TEXT / NOT NULL | UTC RFC3339 second | 本轮输入开始时点；turn_date按其UTC日期。 |
| `finished_at` | TEXT / NOT NULL | UTC RFC3339 second | 本轮任务处理结束时点。 |
| `input_kind` | TEXT / NOT NULL | — | 输入形态。 允许值：command, follow_up, cancel, silence。 |
| `reference_text` | TEXT / NULL | — | 人工从零构造的转写参考；无标签NULL，不是模型预测或真实录音转写。 |
| `reference_intent_id` | TEXT / NULL | — | 人工合成意图标签；无标签NULL。 引用`syn_intent_catalog.intent_id`。 |
| `label_origin` | TEXT / NOT NULL | — | 人工标签来源，至少一个参考非空才为synthetic_authored。 允许值：synthetic_authored, none。 |
| `locale` | TEXT / NOT NULL | — | 本轮locale。 允许值：zh-CN, en-US。 |
| `seat_zone` | TEXT / NOT NULL | — | 输入音区。 允许值：driver, front_passenger, rear。 |
| `input_ms` | INTEGER / NOT NULL | ms | 合成输入持续时长；无原始音频。 下界：0。 |
| `terminal_offset_ms` | INTEGER / NOT NULL | ms | 从轮次起点到任务终态的单调偏移。 下界：0。 |
| `task_latency_ms` | INTEGER / NOT NULL | ms | 输入结束到任务终态的耗时，不含用户输入时长。 下界：0。 |
| `first_audio_latency_ms` | INTEGER / NULL | ms | 输入结束到首个可听播报的耗时；没有首音为NULL。 下界：0。 |
| `final_outcome` | TEXT / NOT NULL | — | 任务执行终态；completed不代表意图一定识别正确或用户满意。 允许值：completed, clarification_pending, rejected, cancelled, no_speech, failed, unknown。 |
| `final_response_text` | TEXT / NULL | — | 从零构造的系统已组织答复文本；无答复NULL，不保证TTS或实际播放成功。 |
| `received_at` | TEXT / NOT NULL | UTC RFC3339 second | 该规范记录进入快照的接收时间；received_at必须早于snapshot_exclusive才可用于快照统计。 |
| `quality_state` | TEXT / NOT NULL | — | 记录质量；默认指标仅采用valid，invalid保留用于质量排查。 允许值：valid, invalid。 |

约束：

- `finished_at >= started_at`
- `terminal_offset_ms >= input_ms`
- `task_latency_ms = terminal_offset_ms - input_ms`

## `syn_dialogue_transition` · 对话状态变化

一个会话可多目标；状态迁移记录不能替代用户原话。澄清回答、取消和新目标分别保留，不能把未回答当同意。

- 行粒度：一轮内的一次对话状态迁移
- 主键：`transition_id`
- 唯一键：(turn_id, transition_no)
- 时间口径：维度按快照读取；事实按各自文档时点与接收截止核对。

| 字段 | SQLite 类型 / 空值 | 单位 | 含义与限定 |
| --- | --- | --- | --- |
| `transition_id` | TEXT / NOT NULL | — | 状态迁移主键。 |
| `turn_id` | TEXT / NOT NULL | — | 所属轮次。 引用`syn_voice_turn.turn_id`。 |
| `transition_no` | INTEGER / NOT NULL | — | 同轮迁移顺序。 下界：1。 |
| `from_state` | TEXT / NOT NULL | — | 迁移前状态。 允许值：listening, understanding, awaiting_slot, ready, executing, completed, cancelled, failed, unknown, rejected, no_speech。 |
| `to_state` | TEXT / NOT NULL | — | 迁移后状态。 允许值：listening, understanding, awaiting_slot, ready, executing, completed, cancelled, failed, unknown, rejected, no_speech。 |
| `reason` | TEXT / NOT NULL | — | 迁移原因。 允许值：parsed, missing_slot, slot_filled, user_cancel, new_goal, action_receipt, timeout, policy_rejected, silence。 |
| `offset_ms` | INTEGER / NOT NULL | ms | 相对轮次起点的迁移时间。 下界：0。 |
| `context_turn_id` | TEXT / NULL | — | 被沿用或取消的原目标轮次，独立目标NULL。 引用`syn_voice_turn.turn_id`。 |
| `clarification_slot` | TEXT / NULL | — | 本次追问的槽位名，无追问NULL。 |
| `clarification_text` | TEXT / NULL | — | 从零构造的澄清文本，无追问NULL。 |
| `user_decision` | TEXT / NOT NULL | — | 本次是否真实提供/取消/未回答。 允许值：provided, cancelled, unanswered, not_required。 |
| `context_preserved` | INTEGER / NOT NULL | boolean | 是否保留原目标的已知约束。 允许值：0, 1。 |
| `received_at` | TEXT / NOT NULL | UTC RFC3339 second | 该规范记录进入快照的接收时间；received_at必须早于snapshot_exclusive才可用于快照统计。 |

## 可机读定义

以下记录是上文的明确结构定义，目录生成器只复用这些定义并与实际DDL核对；没有种子安排或用例预期值。

```semantic-definitions
{"kind":"table","table":"syn_voice_turn","label":"用户交互轮次","grain":"同会话的一条用户输入及任务终态记录","primary_key":["turn_id"],"unique_keys":[["session_id","turn_no"]],"description":"任务达成率eligible为completed/clarification_pending/rejected/failed/unknown，排除cancelled/no_speech。识别一致性只用标签子集；completed、播报成功与满意不是同一指标。","time_basis":"维度按快照读取；事实按各自文档时点与接收截止核对。","checks":["finished_at >= started_at","terminal_offset_ms >= input_ms","task_latency_ms = terminal_offset_ms - input_ms"],"time_columns":[{"column":"started_at","role":"business"},{"column":"finished_at","role":"business"},{"column":"received_at","role":"received"}],"default_filters":["quality_state = 'valid'"]}
{"kind":"field","table":"syn_voice_turn","name":"turn_id","type":"TEXT","nullable":false,"meaning":"轮次主键。"}
{"kind":"field","table":"syn_voice_turn","name":"session_id","type":"TEXT","nullable":false,"meaning":"所属多轮会话。","references":{"table":"syn_voice_session","column":"session_id"}}
{"kind":"field","table":"syn_voice_turn","name":"turn_no","type":"INTEGER","nullable":false,"meaning":"同会话从1递增轮号。","minimum":1}
{"kind":"field","table":"syn_voice_turn","name":"parent_turn_id","type":"TEXT","nullable":true,"meaning":"需要沿用或取消的前一目标轮次，独立新目标NULL。","references":{"table":"syn_voice_turn","column":"turn_id"}}
{"kind":"field","table":"syn_voice_turn","name":"started_at","type":"TEXT","nullable":false,"meaning":"本轮输入开始时点；turn_date按其UTC日期。","unit":"UTC RFC3339 second"}
{"kind":"field","table":"syn_voice_turn","name":"finished_at","type":"TEXT","nullable":false,"meaning":"本轮任务处理结束时点。","unit":"UTC RFC3339 second"}
{"kind":"field","table":"syn_voice_turn","name":"input_kind","type":"TEXT","nullable":false,"meaning":"输入形态。","enum":["command","follow_up","cancel","silence"]}
{"kind":"field","table":"syn_voice_turn","name":"reference_text","type":"TEXT","nullable":true,"meaning":"人工从零构造的转写参考；无标签NULL，不是模型预测或真实录音转写。"}
{"kind":"field","table":"syn_voice_turn","name":"reference_intent_id","type":"TEXT","nullable":true,"meaning":"人工合成意图标签；无标签NULL。","references":{"table":"syn_intent_catalog","column":"intent_id"}}
{"kind":"field","table":"syn_voice_turn","name":"label_origin","type":"TEXT","nullable":false,"meaning":"人工标签来源，至少一个参考非空才为synthetic_authored。","enum":["synthetic_authored","none"]}
{"kind":"field","table":"syn_voice_turn","name":"locale","type":"TEXT","nullable":false,"meaning":"本轮locale。","enum":["zh-CN","en-US"]}
{"kind":"field","table":"syn_voice_turn","name":"seat_zone","type":"TEXT","nullable":false,"meaning":"输入音区。","enum":["driver","front_passenger","rear"]}
{"kind":"field","table":"syn_voice_turn","name":"input_ms","type":"INTEGER","nullable":false,"meaning":"合成输入持续时长；无原始音频。","unit":"ms","minimum":0}
{"kind":"field","table":"syn_voice_turn","name":"terminal_offset_ms","type":"INTEGER","nullable":false,"meaning":"从轮次起点到任务终态的单调偏移。","unit":"ms","minimum":0}
{"kind":"field","table":"syn_voice_turn","name":"task_latency_ms","type":"INTEGER","nullable":false,"meaning":"输入结束到任务终态的耗时，不含用户输入时长。","unit":"ms","minimum":0}
{"kind":"field","table":"syn_voice_turn","name":"first_audio_latency_ms","type":"INTEGER","nullable":true,"meaning":"输入结束到首个可听播报的耗时；没有首音为NULL。","unit":"ms","minimum":0}
{"kind":"field","table":"syn_voice_turn","name":"final_outcome","type":"TEXT","nullable":false,"meaning":"任务执行终态；completed不代表意图一定识别正确或用户满意。","enum":["completed","clarification_pending","rejected","cancelled","no_speech","failed","unknown"]}
{"kind":"field","table":"syn_voice_turn","name":"final_response_text","type":"TEXT","nullable":true,"meaning":"从零构造的系统已组织答复文本；无答复NULL，不保证TTS或实际播放成功。"}
{"kind":"field","table":"syn_voice_turn","name":"received_at","type":"TEXT","nullable":false,"meaning":"该规范记录进入快照的接收时间；received_at必须早于snapshot_exclusive才可用于快照统计。","unit":"UTC RFC3339 second"}
{"kind":"field","table":"syn_voice_turn","name":"quality_state","type":"TEXT","nullable":false,"meaning":"记录质量；默认指标仅采用valid，invalid保留用于质量排查。","enum":["valid","invalid"]}
{"kind":"table","table":"syn_dialogue_transition","label":"对话状态变化","grain":"一轮内的一次对话状态迁移","primary_key":["transition_id"],"unique_keys":[["turn_id","transition_no"]],"description":"一个会话可多目标；状态迁移记录不能替代用户原话。澄清回答、取消和新目标分别保留，不能把未回答当同意。","time_basis":"维度按快照读取；事实按各自文档时点与接收截止核对。","checks":[],"time_columns":[{"column":"received_at","role":"received"}],"default_filters":[]}
{"kind":"field","table":"syn_dialogue_transition","name":"transition_id","type":"TEXT","nullable":false,"meaning":"状态迁移主键。"}
{"kind":"field","table":"syn_dialogue_transition","name":"turn_id","type":"TEXT","nullable":false,"meaning":"所属轮次。","references":{"table":"syn_voice_turn","column":"turn_id"}}
{"kind":"field","table":"syn_dialogue_transition","name":"transition_no","type":"INTEGER","nullable":false,"meaning":"同轮迁移顺序。","minimum":1}
{"kind":"field","table":"syn_dialogue_transition","name":"from_state","type":"TEXT","nullable":false,"meaning":"迁移前状态。","enum":["listening","understanding","awaiting_slot","ready","executing","completed","cancelled","failed","unknown","rejected","no_speech"]}
{"kind":"field","table":"syn_dialogue_transition","name":"to_state","type":"TEXT","nullable":false,"meaning":"迁移后状态。","enum":["listening","understanding","awaiting_slot","ready","executing","completed","cancelled","failed","unknown","rejected","no_speech"]}
{"kind":"field","table":"syn_dialogue_transition","name":"reason","type":"TEXT","nullable":false,"meaning":"迁移原因。","enum":["parsed","missing_slot","slot_filled","user_cancel","new_goal","action_receipt","timeout","policy_rejected","silence"]}
{"kind":"field","table":"syn_dialogue_transition","name":"offset_ms","type":"INTEGER","nullable":false,"meaning":"相对轮次起点的迁移时间。","unit":"ms","minimum":0}
{"kind":"field","table":"syn_dialogue_transition","name":"context_turn_id","type":"TEXT","nullable":true,"meaning":"被沿用或取消的原目标轮次，独立目标NULL。","references":{"table":"syn_voice_turn","column":"turn_id"}}
{"kind":"field","table":"syn_dialogue_transition","name":"clarification_slot","type":"TEXT","nullable":true,"meaning":"本次追问的槽位名，无追问NULL。"}
{"kind":"field","table":"syn_dialogue_transition","name":"clarification_text","type":"TEXT","nullable":true,"meaning":"从零构造的澄清文本，无追问NULL。"}
{"kind":"field","table":"syn_dialogue_transition","name":"user_decision","type":"TEXT","nullable":false,"meaning":"本次是否真实提供/取消/未回答。","enum":["provided","cancelled","unanswered","not_required"]}
{"kind":"field","table":"syn_dialogue_transition","name":"context_preserved","type":"INTEGER","nullable":false,"meaning":"是否保留原目标的已知约束。","unit":"boolean","enum":[0,1]}
{"kind":"field","table":"syn_dialogue_transition","name":"received_at","type":"TEXT","nullable":false,"meaning":"该规范记录进入快照的接收时间；received_at必须早于snapshot_exclusive才可用于快照统计。","unit":"UTC RFC3339 second"}
```
