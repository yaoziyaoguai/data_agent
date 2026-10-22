# 端云识别与候选选择

业务域：公开合成座舱语音交互。此文是人工制定的实验定义，待维护者核对，不代表任何真实厂商标准。

一次请求可以产生端侧、云侧和重试的多个识别尝试，每次尝试又可返回多个候选。候选排序、置信度、首个可用候选和最终被采用候选需要分别保留。最终文本不能按“最后收到一行”或“分数最高一行”自行重建，应采用明确选择关系和当时有效的配置。

从零编写的命令、参考文本和应答只提供可公开的合成场景。本包只定义合成参考文本的规范化逐字一致，归一化规则与有效样本范围必须明确。字面差异不等同意图错误；数字写法、空格或标点的变化也不应在未声明的情况下被自动忽略。

比较时延时区分请求总时延、单次识别尝试耗时和最终候选可用时刻。重试、排队和端云并行会使这些时间不同，不能把多条attempt耗时加起来当成用户等待时长。失败尝试后成功仍是发生过重试的成功请求。

本包只定义synthetic_exact_text规范化逐字一致：按Unicode码点处理；移除ASCII空格、全角空格、TAB、CR、LF及字符集合“。！？!?，,．.”；仅ASCII A–Z转为小写，其他字符不变。不把“二十二”转成“22”，不做同义词替换或语义等价判断，不计算CER/WER。

reference_text仅在人工合成标签子集存在，NULL表示没有标签。分母中的有标签eligible轮次即使没有最终预测也要保留，不能INNER JOIN成功候选后再计算一致率。采用selected_for_nlu=1的最终候选，不能把最高confidence、candidate_rank最小或最先返回一条擅自当成最终选择；同时报告标签覆盖率。

## `syn_asr_attempt` · ASR处理尝试

ASR成功只表示产生候选；最终采用哪一条见asr_hypothesis.selected_for_nlu。失败重试次数不能替代用户输入量。

- 行粒度：一轮输入的一次端侧或云侧识别尝试
- 主键：`asr_attempt_id`
- 唯一键：(turn_id, attempt_no)
- 时间口径：维度按快照读取；事实按各自文档时点与接收截止核对。

| 字段 | SQLite 类型 / 空值 | 单位 | 含义与限定 |
| --- | --- | --- | --- |
| `asr_attempt_id` | TEXT / NOT NULL | — | ASR尝试主键。 |
| `turn_id` | TEXT / NOT NULL | — | 所属轮次。 引用`syn_voice_turn.turn_id`。 |
| `attempt_no` | INTEGER / NOT NULL | — | 同轮ASR从1递增尝试号。 下界：1。 |
| `recognizer_id` | TEXT / NOT NULL | — | component=asr的合成配置。 引用`syn_recognizer_model.recognizer_id`。 |
| `endpoint_kind` | TEXT / NOT NULL | — | 实际端云位置。 允许值：edge, cloud。 |
| `start_offset_ms` | INTEGER / NOT NULL | ms | 相对turn起点的处理开始偏移。 下界：0。 |
| `finish_offset_ms` | INTEGER / NOT NULL | ms | 处理结束偏移。 下界：0。 |
| `wall_ms` | INTEGER / NOT NULL | ms | finish_offset_ms-start_offset_ms。 下界：0。 |
| `queued_ms` | INTEGER / NOT NULL | ms | wall_ms中的排队部分。 下界：0。 |
| `outcome` | TEXT / NOT NULL | — | 识别尝试结果。 允许值：succeeded, failed, timeout, cancelled。 |
| `fallback_reason` | TEXT / NOT NULL | — | 启用该次尝试的原因。 允许值：none, cloud_timeout, network_unavailable, model_failure。 |
| `timeout_ms` | INTEGER / NOT NULL | ms | 本次生效超时配置。 下界：0。 |
| `is_streaming` | INTEGER / NOT NULL | boolean | 是否模拟流式识别。 允许值：0, 1。 |
| `partial_result_count` | INTEGER / NOT NULL | count | 模拟中间转写次数，不作为最终候选数。 下界：0。 |
| `error_code` | TEXT / NULL | — | SYN前缀模拟错误，无错误NULL。 |
| `received_at` | TEXT / NOT NULL | UTC RFC3339 second | 该规范记录进入快照的接收时间；received_at必须早于snapshot_exclusive才可用于快照统计。 |

约束：

- `finish_offset_ms >= start_offset_ms`
- `wall_ms=finish_offset_ms-start_offset_ms`
- `queued_ms<=wall_ms`

## `syn_asr_hypothesis` · ASR候选及最终选择

不能把最高置信候选当人工真值。转写一致率需reference_text非空并采用同一归一化；无标签不进入正确率分母。

- 行粒度：一次成功ASR尝试的一条候选转写
- 主键：`hypothesis_id`
- 唯一键：(asr_attempt_id, candidate_rank)
- 时间口径：维度按快照读取；事实按各自文档时点与接收截止核对。

| 字段 | SQLite 类型 / 空值 | 单位 | 含义与限定 |
| --- | --- | --- | --- |
| `hypothesis_id` | TEXT / NOT NULL | — | 候选主键。 |
| `asr_attempt_id` | TEXT / NOT NULL | — | 所属ASR尝试。 引用`syn_asr_attempt.asr_attempt_id`。 |
| `turn_id` | TEXT / NOT NULL | — | 冗余轮次引用，必须与ASR尝试一致。 引用`syn_voice_turn.turn_id`。 |
| `candidate_rank` | INTEGER / NOT NULL | — | 该尝试内从1递增候选排名。 下界：1。 |
| `hypothesis_text` | TEXT / NOT NULL | — | 人工构造的模拟识别文本，不来自公司用户。 |
| `normalized_text` | TEXT / NOT NULL | — | 统一空白及公开数字格式后的文本，规范由文档定义。 |
| `confidence_permille` | INTEGER / NOT NULL | permille | 合成置信度。 下界：0。 上界：1000。 |
| `is_final` | INTEGER / NOT NULL | boolean | 是否该尝试的最终候选，非partial流式片段。 允许值：0, 1。 |
| `selected_for_nlu` | INTEGER / NOT NULL | boolean | 同轮至多一条最终被NLU采用的候选，不必rank=1。 允许值：0, 1。 |
| `selection_reason` | TEXT / NOT NULL | — | 选择原因的日志标签，不证明选对。 允许值：rank, context_bias, fallback, not_selected。 |
| `locale` | TEXT / NOT NULL | — | 候选locale。 允许值：zh-CN, en-US。 |
| `received_at` | TEXT / NOT NULL | UTC RFC3339 second | 该规范记录进入快照的接收时间；received_at必须早于snapshot_exclusive才可用于快照统计。 |

## 可机读定义

以下记录是上文的明确结构定义，目录生成器只复用这些定义并与实际DDL核对；没有种子安排或用例预期值。

```semantic-definitions
{"kind":"table","table":"syn_asr_attempt","label":"ASR处理尝试","grain":"一轮输入的一次端侧或云侧识别尝试","primary_key":["asr_attempt_id"],"unique_keys":[["turn_id","attempt_no"]],"description":"ASR成功只表示产生候选；最终采用哪一条见asr_hypothesis.selected_for_nlu。失败重试次数不能替代用户输入量。","time_basis":"维度按快照读取；事实按各自文档时点与接收截止核对。","checks":["finish_offset_ms >= start_offset_ms","wall_ms=finish_offset_ms-start_offset_ms","queued_ms<=wall_ms"],"time_columns":[{"column":"received_at","role":"received"}],"default_filters":[]}
{"kind":"field","table":"syn_asr_attempt","name":"asr_attempt_id","type":"TEXT","nullable":false,"meaning":"ASR尝试主键。"}
{"kind":"field","table":"syn_asr_attempt","name":"turn_id","type":"TEXT","nullable":false,"meaning":"所属轮次。","references":{"table":"syn_voice_turn","column":"turn_id"}}
{"kind":"field","table":"syn_asr_attempt","name":"attempt_no","type":"INTEGER","nullable":false,"meaning":"同轮ASR从1递增尝试号。","minimum":1}
{"kind":"field","table":"syn_asr_attempt","name":"recognizer_id","type":"TEXT","nullable":false,"meaning":"component=asr的合成配置。","references":{"table":"syn_recognizer_model","column":"recognizer_id"}}
{"kind":"field","table":"syn_asr_attempt","name":"endpoint_kind","type":"TEXT","nullable":false,"meaning":"实际端云位置。","enum":["edge","cloud"]}
{"kind":"field","table":"syn_asr_attempt","name":"start_offset_ms","type":"INTEGER","nullable":false,"meaning":"相对turn起点的处理开始偏移。","unit":"ms","minimum":0}
{"kind":"field","table":"syn_asr_attempt","name":"finish_offset_ms","type":"INTEGER","nullable":false,"meaning":"处理结束偏移。","unit":"ms","minimum":0}
{"kind":"field","table":"syn_asr_attempt","name":"wall_ms","type":"INTEGER","nullable":false,"meaning":"finish_offset_ms-start_offset_ms。","unit":"ms","minimum":0}
{"kind":"field","table":"syn_asr_attempt","name":"queued_ms","type":"INTEGER","nullable":false,"meaning":"wall_ms中的排队部分。","unit":"ms","minimum":0}
{"kind":"field","table":"syn_asr_attempt","name":"outcome","type":"TEXT","nullable":false,"meaning":"识别尝试结果。","enum":["succeeded","failed","timeout","cancelled"]}
{"kind":"field","table":"syn_asr_attempt","name":"fallback_reason","type":"TEXT","nullable":false,"meaning":"启用该次尝试的原因。","enum":["none","cloud_timeout","network_unavailable","model_failure"]}
{"kind":"field","table":"syn_asr_attempt","name":"timeout_ms","type":"INTEGER","nullable":false,"meaning":"本次生效超时配置。","unit":"ms","minimum":0}
{"kind":"field","table":"syn_asr_attempt","name":"is_streaming","type":"INTEGER","nullable":false,"meaning":"是否模拟流式识别。","unit":"boolean","enum":[0,1]}
{"kind":"field","table":"syn_asr_attempt","name":"partial_result_count","type":"INTEGER","nullable":false,"meaning":"模拟中间转写次数，不作为最终候选数。","unit":"count","minimum":0}
{"kind":"field","table":"syn_asr_attempt","name":"error_code","type":"TEXT","nullable":true,"meaning":"SYN前缀模拟错误，无错误NULL。"}
{"kind":"field","table":"syn_asr_attempt","name":"received_at","type":"TEXT","nullable":false,"meaning":"该规范记录进入快照的接收时间；received_at必须早于snapshot_exclusive才可用于快照统计。","unit":"UTC RFC3339 second"}
{"kind":"table","table":"syn_asr_hypothesis","label":"ASR候选及最终选择","grain":"一次成功ASR尝试的一条候选转写","primary_key":["hypothesis_id"],"unique_keys":[["asr_attempt_id","candidate_rank"]],"description":"不能把最高置信候选当人工真值。转写一致率需reference_text非空并采用同一归一化；无标签不进入正确率分母。","time_basis":"维度按快照读取；事实按各自文档时点与接收截止核对。","checks":[],"time_columns":[{"column":"received_at","role":"received"}],"default_filters":[]}
{"kind":"field","table":"syn_asr_hypothesis","name":"hypothesis_id","type":"TEXT","nullable":false,"meaning":"候选主键。"}
{"kind":"field","table":"syn_asr_hypothesis","name":"asr_attempt_id","type":"TEXT","nullable":false,"meaning":"所属ASR尝试。","references":{"table":"syn_asr_attempt","column":"asr_attempt_id"}}
{"kind":"field","table":"syn_asr_hypothesis","name":"turn_id","type":"TEXT","nullable":false,"meaning":"冗余轮次引用，必须与ASR尝试一致。","references":{"table":"syn_voice_turn","column":"turn_id"}}
{"kind":"field","table":"syn_asr_hypothesis","name":"candidate_rank","type":"INTEGER","nullable":false,"meaning":"该尝试内从1递增候选排名。","minimum":1}
{"kind":"field","table":"syn_asr_hypothesis","name":"hypothesis_text","type":"TEXT","nullable":false,"meaning":"人工构造的模拟识别文本，不来自公司用户。"}
{"kind":"field","table":"syn_asr_hypothesis","name":"normalized_text","type":"TEXT","nullable":false,"meaning":"统一空白及公开数字格式后的文本，规范由文档定义。"}
{"kind":"field","table":"syn_asr_hypothesis","name":"confidence_permille","type":"INTEGER","nullable":false,"meaning":"合成置信度。","unit":"permille","minimum":0,"maximum":1000}
{"kind":"field","table":"syn_asr_hypothesis","name":"is_final","type":"INTEGER","nullable":false,"meaning":"是否该尝试的最终候选，非partial流式片段。","unit":"boolean","enum":[0,1]}
{"kind":"field","table":"syn_asr_hypothesis","name":"selected_for_nlu","type":"INTEGER","nullable":false,"meaning":"同轮至多一条最终被NLU采用的候选，不必rank=1。","unit":"boolean","enum":[0,1]}
{"kind":"field","table":"syn_asr_hypothesis","name":"selection_reason","type":"TEXT","nullable":false,"meaning":"选择原因的日志标签，不证明选对。","enum":["rank","context_bias","fallback","not_selected"]}
{"kind":"field","table":"syn_asr_hypothesis","name":"locale","type":"TEXT","nullable":false,"meaning":"候选locale。","enum":["zh-CN","en-US"]}
{"kind":"field","table":"syn_asr_hypothesis","name":"received_at","type":"TEXT","nullable":false,"meaning":"该规范记录进入快照的接收时间；received_at必须早于snapshot_exclusive才可用于快照统计。","unit":"UTC RFC3339 second"}
```
