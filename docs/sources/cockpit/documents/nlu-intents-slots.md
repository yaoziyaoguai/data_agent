# 意图、槽位与归一化

业务域：公开合成座舱语音交互。此文是人工制定的实验定义，待维护者核对，不代表任何真实厂商标准。

NLU解释采用的识别文本，产出意图候选及槽位。识别文本来源、意图候选版本、最终选择、槽位原文和规范值都需要可关联。没有被选择的候选不是已执行指令；缺少必需槽位时可以继续澄清，不能把默认值说成用户已经确认。

槽位的原始取值和规范值承担不同职责。例如自然语言数字可归一化为温度或音量，但单位、范围和目标座位必须保留。本包只保存槽位原值和规范值，没有原文字符跨度字段，不能推断文本span或音频位置。取值是否解决和校验状态分别记录；validation_state区分valid、missing、out_of_range与ambiguous。

意图达成率必须使用本包定义的有效请求或有效解析尝试作为分母，并明确采用哪一层最终状态。一个请求可能有多个候选、多个槽位和多次修订，直接JOIN这些事实再COUNT会放大结果。置信度变化只能支持模型输出分布的描述，不能替代执行回执。

reference_intent_id是人工合成标签，predicted_intent_id是模型输出；不能用预测填充缺失reference。比较时采用selected_for_dialogue=1的最终解析，缺预测仍保留在有标签有效分母。槽位是否必需由syn_intent_catalog中的required_slot_names和校验规则决定，不能把空字符串、NULL和已确认的默认值混成一类。

## `syn_nlu_attempt` · 意图理解尝试

解析成功仍可缺少必填槽位；对话澄清不是工具执行成功。意图一致率对reference_intent_id非空子集核对，不能拿预测当真值。

- 行粒度：一轮的一次意图/槽位解析
- 主键：`nlu_attempt_id`
- 唯一键：(turn_id, attempt_no)
- 时间口径：维度按快照读取；事实按各自文档时点与接收截止核对。

| 字段 | SQLite 类型 / 空值 | 单位 | 含义与限定 |
| --- | --- | --- | --- |
| `nlu_attempt_id` | TEXT / NOT NULL | — | NLU尝试主键。 |
| `turn_id` | TEXT / NOT NULL | — | 所属轮次。 引用`syn_voice_turn.turn_id`。 |
| `hypothesis_id` | TEXT / NOT NULL | — | 实际解析的转写候选。 引用`syn_asr_hypothesis.hypothesis_id`。 |
| `attempt_no` | INTEGER / NOT NULL | — | 同轮NLU尝试序号。 下界：1。 |
| `recognizer_id` | TEXT / NOT NULL | — | component=nlu的合成配置。 引用`syn_recognizer_model.recognizer_id`。 |
| `endpoint_kind` | TEXT / NOT NULL | — | 实际端云位置。 允许值：edge, cloud。 |
| `start_offset_ms` | INTEGER / NOT NULL | ms | 相对turn起点的开始偏移。 下界：0。 |
| `finish_offset_ms` | INTEGER / NOT NULL | ms | 结束偏移。 下界：0。 |
| `wall_ms` | INTEGER / NOT NULL | ms | finish-start单调耗时。 下界：0。 |
| `queued_ms` | INTEGER / NOT NULL | ms | 包含在wall_ms内的等待时长。 下界：0。 |
| `outcome` | TEXT / NOT NULL | — | 理解尝试状态。 允许值：succeeded, ambiguous, failed, timeout, cancelled。 |
| `predicted_intent_id` | TEXT / NULL | — | 模型预测意图；未得出或歧义时可NULL，不是真值。 引用`syn_intent_catalog.intent_id`。 |
| `confidence_permille` | INTEGER / NULL | permille | 预测置信度，无预测NULL。 下界：0。 上界：1000。 |
| `missing_required_slots` | INTEGER / NOT NULL | count | 必填且未解决槽位数，须与slot_value一致。 下界：0。 |
| `context_used` | INTEGER / NOT NULL | boolean | 是否使用前文补充解析。 允许值：0, 1。 |
| `selected_for_dialogue` | INTEGER / NOT NULL | boolean | 同轮至多一条交给对话管理的结果。 允许值：0, 1。 |
| `error_code` | TEXT / NULL | — | 模拟错误，无错误NULL。 |
| `received_at` | TEXT / NOT NULL | UTC RFC3339 second | 该规范记录进入快照的接收时间；received_at必须早于snapshot_exclusive才可用于快照统计。 |

约束：

- `finish_offset_ms >= start_offset_ms`
- `wall_ms=finish_offset_ms-start_offset_ms`
- `queued_ms<=wall_ms`

## `syn_slot_value` · 槽位提取与补全

上下文补槽必须保留source_turn_id；NULL、空串和未解决分别解释。不能把未回答的必填值用默认值悄悄补上。

- 行粒度：一次NLU尝试中的一个已声明槽位
- 主键：`slot_id`
- 唯一键：(nlu_attempt_id, slot_name)
- 时间口径：维度按快照读取；事实按各自文档时点与接收截止核对。

| 字段 | SQLite 类型 / 空值 | 单位 | 含义与限定 |
| --- | --- | --- | --- |
| `slot_id` | TEXT / NOT NULL | — | 槽位记录主键。 |
| `nlu_attempt_id` | TEXT / NOT NULL | — | 所属理解尝试。 引用`syn_nlu_attempt.nlu_attempt_id`。 |
| `turn_id` | TEXT / NOT NULL | — | 须与NLU所属轮次一致。 引用`syn_voice_turn.turn_id`。 |
| `slot_name` | TEXT / NOT NULL | — | 槽位名，来自意图定义。 |
| `raw_value` | TEXT / NULL | — | 合成输入中提取的原值；缺失NULL。 |
| `normalized_value` | TEXT / NULL | — | 归一化文本值；未解决NULL。 |
| `value_kind` | TEXT / NOT NULL | — | 归一化值类型。 允许值：text, decimal, boolean。 |
| `value_unit` | TEXT / NULL | — | 单位，如degree_c；无单位NULL。 |
| `resolution_source` | TEXT / NOT NULL | — | 槽位取值出处，missing不能冒充用户采用。 允许值：utterance, context, default, missing。 |
| `confidence_permille` | INTEGER / NULL | permille | 合成置信度；无取值NULL。 下界：0。 上界：1000。 |
| `is_required` | INTEGER / NOT NULL | boolean | 是否本意图必填槽位。 允许值：0, 1。 |
| `is_resolved` | INTEGER / NOT NULL | boolean | 是否已有可用取值；不等于范围校验一定成功。 允许值：0, 1。 |
| `validation_state` | TEXT / NOT NULL | — | 槽位规则校验结果。 允许值：valid, missing, out_of_range, ambiguous。 |
| `source_turn_id` | TEXT / NULL | — | 来自上下文时的真实源轮次，其他NULL。 引用`syn_voice_turn.turn_id`。 |
| `received_at` | TEXT / NOT NULL | UTC RFC3339 second | 该规范记录进入快照的接收时间；received_at必须早于snapshot_exclusive才可用于快照统计。 |

## 可机读定义

以下记录是上文的明确结构定义，目录生成器只复用这些定义并与实际DDL核对；没有种子安排或用例预期值。

```semantic-definitions
{"kind":"table","table":"syn_nlu_attempt","label":"意图理解尝试","grain":"一轮的一次意图/槽位解析","primary_key":["nlu_attempt_id"],"unique_keys":[["turn_id","attempt_no"]],"description":"解析成功仍可缺少必填槽位；对话澄清不是工具执行成功。意图一致率对reference_intent_id非空子集核对，不能拿预测当真值。","time_basis":"维度按快照读取；事实按各自文档时点与接收截止核对。","checks":["finish_offset_ms >= start_offset_ms","wall_ms=finish_offset_ms-start_offset_ms","queued_ms<=wall_ms"],"time_columns":[{"column":"received_at","role":"received"}],"default_filters":[]}
{"kind":"field","table":"syn_nlu_attempt","name":"nlu_attempt_id","type":"TEXT","nullable":false,"meaning":"NLU尝试主键。"}
{"kind":"field","table":"syn_nlu_attempt","name":"turn_id","type":"TEXT","nullable":false,"meaning":"所属轮次。","references":{"table":"syn_voice_turn","column":"turn_id"}}
{"kind":"field","table":"syn_nlu_attempt","name":"hypothesis_id","type":"TEXT","nullable":false,"meaning":"实际解析的转写候选。","references":{"table":"syn_asr_hypothesis","column":"hypothesis_id"}}
{"kind":"field","table":"syn_nlu_attempt","name":"attempt_no","type":"INTEGER","nullable":false,"meaning":"同轮NLU尝试序号。","minimum":1}
{"kind":"field","table":"syn_nlu_attempt","name":"recognizer_id","type":"TEXT","nullable":false,"meaning":"component=nlu的合成配置。","references":{"table":"syn_recognizer_model","column":"recognizer_id"}}
{"kind":"field","table":"syn_nlu_attempt","name":"endpoint_kind","type":"TEXT","nullable":false,"meaning":"实际端云位置。","enum":["edge","cloud"]}
{"kind":"field","table":"syn_nlu_attempt","name":"start_offset_ms","type":"INTEGER","nullable":false,"meaning":"相对turn起点的开始偏移。","unit":"ms","minimum":0}
{"kind":"field","table":"syn_nlu_attempt","name":"finish_offset_ms","type":"INTEGER","nullable":false,"meaning":"结束偏移。","unit":"ms","minimum":0}
{"kind":"field","table":"syn_nlu_attempt","name":"wall_ms","type":"INTEGER","nullable":false,"meaning":"finish-start单调耗时。","unit":"ms","minimum":0}
{"kind":"field","table":"syn_nlu_attempt","name":"queued_ms","type":"INTEGER","nullable":false,"meaning":"包含在wall_ms内的等待时长。","unit":"ms","minimum":0}
{"kind":"field","table":"syn_nlu_attempt","name":"outcome","type":"TEXT","nullable":false,"meaning":"理解尝试状态。","enum":["succeeded","ambiguous","failed","timeout","cancelled"]}
{"kind":"field","table":"syn_nlu_attempt","name":"predicted_intent_id","type":"TEXT","nullable":true,"meaning":"模型预测意图；未得出或歧义时可NULL，不是真值。","references":{"table":"syn_intent_catalog","column":"intent_id"}}
{"kind":"field","table":"syn_nlu_attempt","name":"confidence_permille","type":"INTEGER","nullable":true,"meaning":"预测置信度，无预测NULL。","unit":"permille","minimum":0,"maximum":1000}
{"kind":"field","table":"syn_nlu_attempt","name":"missing_required_slots","type":"INTEGER","nullable":false,"meaning":"必填且未解决槽位数，须与slot_value一致。","unit":"count","minimum":0}
{"kind":"field","table":"syn_nlu_attempt","name":"context_used","type":"INTEGER","nullable":false,"meaning":"是否使用前文补充解析。","unit":"boolean","enum":[0,1]}
{"kind":"field","table":"syn_nlu_attempt","name":"selected_for_dialogue","type":"INTEGER","nullable":false,"meaning":"同轮至多一条交给对话管理的结果。","unit":"boolean","enum":[0,1]}
{"kind":"field","table":"syn_nlu_attempt","name":"error_code","type":"TEXT","nullable":true,"meaning":"模拟错误，无错误NULL。"}
{"kind":"field","table":"syn_nlu_attempt","name":"received_at","type":"TEXT","nullable":false,"meaning":"该规范记录进入快照的接收时间；received_at必须早于snapshot_exclusive才可用于快照统计。","unit":"UTC RFC3339 second"}
{"kind":"table","table":"syn_slot_value","label":"槽位提取与补全","grain":"一次NLU尝试中的一个已声明槽位","primary_key":["slot_id"],"unique_keys":[["nlu_attempt_id","slot_name"]],"description":"上下文补槽必须保留source_turn_id；NULL、空串和未解决分别解释。不能把未回答的必填值用默认值悄悄补上。","time_basis":"维度按快照读取；事实按各自文档时点与接收截止核对。","checks":[],"time_columns":[{"column":"received_at","role":"received"}],"default_filters":[]}
{"kind":"field","table":"syn_slot_value","name":"slot_id","type":"TEXT","nullable":false,"meaning":"槽位记录主键。"}
{"kind":"field","table":"syn_slot_value","name":"nlu_attempt_id","type":"TEXT","nullable":false,"meaning":"所属理解尝试。","references":{"table":"syn_nlu_attempt","column":"nlu_attempt_id"}}
{"kind":"field","table":"syn_slot_value","name":"turn_id","type":"TEXT","nullable":false,"meaning":"须与NLU所属轮次一致。","references":{"table":"syn_voice_turn","column":"turn_id"}}
{"kind":"field","table":"syn_slot_value","name":"slot_name","type":"TEXT","nullable":false,"meaning":"槽位名，来自意图定义。"}
{"kind":"field","table":"syn_slot_value","name":"raw_value","type":"TEXT","nullable":true,"meaning":"合成输入中提取的原值；缺失NULL。"}
{"kind":"field","table":"syn_slot_value","name":"normalized_value","type":"TEXT","nullable":true,"meaning":"归一化文本值；未解决NULL。"}
{"kind":"field","table":"syn_slot_value","name":"value_kind","type":"TEXT","nullable":false,"meaning":"归一化值类型。","enum":["text","decimal","boolean"]}
{"kind":"field","table":"syn_slot_value","name":"value_unit","type":"TEXT","nullable":true,"meaning":"单位，如degree_c；无单位NULL。"}
{"kind":"field","table":"syn_slot_value","name":"resolution_source","type":"TEXT","nullable":false,"meaning":"槽位取值出处，missing不能冒充用户采用。","enum":["utterance","context","default","missing"]}
{"kind":"field","table":"syn_slot_value","name":"confidence_permille","type":"INTEGER","nullable":true,"meaning":"合成置信度；无取值NULL。","unit":"permille","minimum":0,"maximum":1000}
{"kind":"field","table":"syn_slot_value","name":"is_required","type":"INTEGER","nullable":false,"meaning":"是否本意图必填槽位。","unit":"boolean","enum":[0,1]}
{"kind":"field","table":"syn_slot_value","name":"is_resolved","type":"INTEGER","nullable":false,"meaning":"是否已有可用取值；不等于范围校验一定成功。","unit":"boolean","enum":[0,1]}
{"kind":"field","table":"syn_slot_value","name":"validation_state","type":"TEXT","nullable":false,"meaning":"槽位规则校验结果。","enum":["valid","missing","out_of_range","ambiguous"]}
{"kind":"field","table":"syn_slot_value","name":"source_turn_id","type":"TEXT","nullable":true,"meaning":"来自上下文时的真实源轮次，其他NULL。","references":{"table":"syn_voice_turn","column":"turn_id"}}
{"kind":"field","table":"syn_slot_value","name":"received_at","type":"TEXT","nullable":false,"meaning":"该规范记录进入快照的接收时间；received_at必须早于snapshot_exclusive才可用于快照统计。","unit":"UTC RFC3339 second"}
```
