# 前端分段与输入结束

业务域：公开合成座舱语音交互。此文是人工制定的实验定义，待维护者核对，不代表任何真实厂商标准。

syn_frontend_segment记录人工合成的speech、silence和noise片段。每个轮次内片段按segment_no排序，不重叠且连续覆盖input_ms。duration_ms等于end_offset_ms减start_offset_ms；统计合成语音时长使用segment_kind并在轮次粒度汇总，不把片段数当成轮次数。

speech_detected是模拟VAD判定，segment_kind是人工给出的类别，二者不必相同。clipped_ms表示该片段被截去的长度，不能大于duration_ms。没有音频文件，不能重新听音判断VAD边界，也不能把这些合成标签当成真实声学性能。

短时长以相对轮次起点的单调毫秒字段为准，UTC字符串用于选择观察期。no_speech、cancelled与failed分别保存为轮次终态；是否进入某个成功率分母，以该指标的eligible定义为准。



## `syn_frontend_segment` · 前端VAD分段

片段同轮不重叠且连续覆盖input_ms。片段数不等于用户轮数，不能由模拟VAD标签声称真实声学能力。

- 行粒度：一轮输入中的一个模拟语音/静音/噪声片段
- 主键：`segment_id`
- 唯一键：(turn_id, segment_no)
- 时间口径：维度按快照读取；事实按各自文档时点与接收截止核对。

| 字段 | SQLite 类型 / 空值 | 单位 | 含义与限定 |
| --- | --- | --- | --- |
| `segment_id` | TEXT / NOT NULL | — | 片段主键。 |
| `turn_id` | TEXT / NOT NULL | — | 所属轮次。 引用`syn_voice_turn.turn_id`。 |
| `segment_no` | INTEGER / NOT NULL | — | 同轮片段序号。 下界：1。 |
| `segment_kind` | TEXT / NOT NULL | — | 人工合成片段类别，不来自实际音频。 允许值：speech, silence, noise。 |
| `start_offset_ms` | INTEGER / NOT NULL | ms | 相对turn起点的片段起始偏移。 下界：0。 |
| `end_offset_ms` | INTEGER / NOT NULL | ms | 片段终止偏移，排他。 下界：0。 |
| `duration_ms` | INTEGER / NOT NULL | ms | end_offset_ms-start_offset_ms。 下界：0。 |
| `speech_detected` | INTEGER / NOT NULL | boolean | 模拟VAD是否判为语音。 允许值：0, 1。 |
| `endpoint_reason` | TEXT / NOT NULL | — | 前端结束该片段的原因。 允许值：speech_end, silence_threshold, input_end, manual_stop。 |
| `clipped_ms` | INTEGER / NOT NULL | ms | 该片段被截去的时长，不超过duration_ms。 下界：0。 |
| `feature_frame_count` | INTEGER / NOT NULL | count | 模拟特征帧计数，仅作日志字段，不生成音频。 下界：0。 |
| `noise_bucket` | TEXT / NOT NULL | — | 合成环境档位。 允许值：quiet, moderate, noisy。 |
| `received_at` | TEXT / NOT NULL | UTC RFC3339 second | 该规范记录进入快照的接收时间；received_at必须早于snapshot_exclusive才可用于快照统计。 |
| `quality_state` | TEXT / NOT NULL | — | 记录质量；默认指标仅采用valid，invalid保留用于质量排查。 允许值：valid, invalid。 |

约束：

- `end_offset_ms > start_offset_ms`
- `duration_ms=end_offset_ms-start_offset_ms`
- `clipped_ms <= duration_ms`

## 可机读定义

以下记录是上文的明确结构定义，目录生成器只复用这些定义并与实际DDL核对；没有种子安排或用例预期值。

```semantic-definitions
{"kind":"table","table":"syn_frontend_segment","label":"前端VAD分段","grain":"一轮输入中的一个模拟语音/静音/噪声片段","primary_key":["segment_id"],"unique_keys":[["turn_id","segment_no"]],"description":"片段同轮不重叠且连续覆盖input_ms。片段数不等于用户轮数，不能由模拟VAD标签声称真实声学能力。","time_basis":"维度按快照读取；事实按各自文档时点与接收截止核对。","checks":["end_offset_ms > start_offset_ms","duration_ms=end_offset_ms-start_offset_ms","clipped_ms <= duration_ms"],"time_columns":[{"column":"received_at","role":"received"}],"default_filters":["quality_state = 'valid'"]}
{"kind":"field","table":"syn_frontend_segment","name":"segment_id","type":"TEXT","nullable":false,"meaning":"片段主键。"}
{"kind":"field","table":"syn_frontend_segment","name":"turn_id","type":"TEXT","nullable":false,"meaning":"所属轮次。","references":{"table":"syn_voice_turn","column":"turn_id"}}
{"kind":"field","table":"syn_frontend_segment","name":"segment_no","type":"INTEGER","nullable":false,"meaning":"同轮片段序号。","minimum":1}
{"kind":"field","table":"syn_frontend_segment","name":"segment_kind","type":"TEXT","nullable":false,"meaning":"人工合成片段类别，不来自实际音频。","enum":["speech","silence","noise"]}
{"kind":"field","table":"syn_frontend_segment","name":"start_offset_ms","type":"INTEGER","nullable":false,"meaning":"相对turn起点的片段起始偏移。","unit":"ms","minimum":0}
{"kind":"field","table":"syn_frontend_segment","name":"end_offset_ms","type":"INTEGER","nullable":false,"meaning":"片段终止偏移，排他。","unit":"ms","minimum":0}
{"kind":"field","table":"syn_frontend_segment","name":"duration_ms","type":"INTEGER","nullable":false,"meaning":"end_offset_ms-start_offset_ms。","unit":"ms","minimum":0}
{"kind":"field","table":"syn_frontend_segment","name":"speech_detected","type":"INTEGER","nullable":false,"meaning":"模拟VAD是否判为语音。","unit":"boolean","enum":[0,1]}
{"kind":"field","table":"syn_frontend_segment","name":"endpoint_reason","type":"TEXT","nullable":false,"meaning":"前端结束该片段的原因。","enum":["speech_end","silence_threshold","input_end","manual_stop"]}
{"kind":"field","table":"syn_frontend_segment","name":"clipped_ms","type":"INTEGER","nullable":false,"meaning":"该片段被截去的时长，不超过duration_ms。","unit":"ms","minimum":0}
{"kind":"field","table":"syn_frontend_segment","name":"feature_frame_count","type":"INTEGER","nullable":false,"meaning":"模拟特征帧计数，仅作日志字段，不生成音频。","unit":"count","minimum":0}
{"kind":"field","table":"syn_frontend_segment","name":"noise_bucket","type":"TEXT","nullable":false,"meaning":"合成环境档位。","enum":["quiet","moderate","noisy"]}
{"kind":"field","table":"syn_frontend_segment","name":"received_at","type":"TEXT","nullable":false,"meaning":"该规范记录进入快照的接收时间；received_at必须早于snapshot_exclusive才可用于快照统计。","unit":"UTC RFC3339 second"}
{"kind":"field","table":"syn_frontend_segment","name":"quality_state","type":"TEXT","nullable":false,"meaning":"记录质量；默认指标仅采用valid，invalid保留用于质量排查。","enum":["valid","invalid"]}
```
