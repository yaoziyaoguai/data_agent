# 合成播报、首音与打断

业务域：公开合成座舱语音交互。此文是人工制定的实验定义，待维护者核对，不代表任何真实厂商标准。

文本组织、TTS合成、开始播报和播报完成属于不同阶段。syn_tts_request保存模拟合成状态与首块时刻；syn_playback_segment保存实际模拟播放开始、播放长度和缓冲时长。first_audio_latency_ms使用播放首音相对用户输入结束的耗时，不能用TTS请求开始代替。

播放结束原因只有completed、barge_in、user_stop和device_error；completion_state区分complete、interrupted与failed。打断关联由syn_interruption_event明确保存。播报中断不一定使目标失败，因为动作可能已经确认；新的输入也不能仅因时间接近就被归为打断来源。

本包不保存真实音频，不支持听感、音色或发音质量评分。可核对的是片段顺序、计划时长、实际时长、缓冲与结束原因。应答长度不同时，要区分生成性能和内容长度带来的播放时长差异。

first_audio_latency_ms从用户输入结束计算到实际playback首音，不是到tts_request开始或first_chunk。task_latency_ms也从输入结束算起；input_ms单独保存，不能重复相加。没有首音的轮次为NULL，不是零延迟。首音分位数的样本可包含澄清提示，报告P95时同时给出首音覆盖率。

## `syn_tts_request` · 播报合成请求

TTS成功不等于已经播出，也不证明任务执行正确；不保存原始或合成音频。

- 行粒度：一轮中的一次模拟文本合成请求
- 主键：`tts_id`
- 唯一键：(turn_id, attempt_no)
- 时间口径：维度按快照读取；事实按各自文档时点与接收截止核对。

| 字段 | SQLite 类型 / 空值 | 单位 | 含义与限定 |
| --- | --- | --- | --- |
| `tts_id` | TEXT / NOT NULL | — | TTS请求主键。 |
| `turn_id` | TEXT / NOT NULL | — | 所属轮次。 引用`syn_voice_turn.turn_id`。 |
| `action_result_id` | TEXT / NULL | — | 回答动作结果时的依据回执；澄清/错误提示可NULL。 引用`syn_action_result.result_id`。 |
| `attempt_no` | INTEGER / NOT NULL | — | 同轮TTS尝试号。 下界：1。 |
| `response_kind` | TEXT / NOT NULL | — | 系统答复类型。 允许值：answer, clarification, error, status。 |
| `response_text` | TEXT / NOT NULL | — | 从零构造的系统文本，不来自真实用户或公司。 |
| `voice_profile` | TEXT / NOT NULL | — | 虚构发声配置，不对应真实人物。 允许值：synthetic_voice_a, synthetic_voice_b。 |
| `endpoint_kind` | TEXT / NOT NULL | — | 合成位置。 允许值：edge, cloud。 |
| `start_offset_ms` | INTEGER / NOT NULL | ms | 请求开始偏移。 下界：0。 |
| `first_chunk_offset_ms` | INTEGER / NULL | ms | 首次可播数据偏移，未产出NULL。 下界：0。 |
| `finish_offset_ms` | INTEGER / NOT NULL | ms | 请求结束偏移。 下界：0。 |
| `wall_ms` | INTEGER / NOT NULL | ms | TTS处理耗时。 下界：0。 |
| `simulated_audio_ms` | INTEGER / NOT NULL | ms | 模拟语音持续时长；没有音频文件。 下界：0。 |
| `outcome` | TEXT / NOT NULL | — | 合成结果。 允许值：succeeded, failed, timeout, cancelled。 |
| `error_code` | TEXT / NULL | — | 模拟错误，无错误NULL。 |
| `received_at` | TEXT / NOT NULL | UTC RFC3339 second | 该规范记录进入快照的接收时间；received_at必须早于snapshot_exclusive才可用于快照统计。 |

约束：

- `finish_offset_ms>=start_offset_ms`
- `wall_ms=finish_offset_ms-start_offset_ms`

## `syn_playback_segment` · 播报播放片段

片段播放中断不自动使已经确认的动作失败。首音指标读取实际播放开始，不能用TTS请求开始替代。

- 行粒度：一次TTS结果的一段实际模拟播放
- 主键：`playback_id`
- 唯一键：(tts_id, segment_no)
- 时间口径：维度按快照读取；事实按各自文档时点与接收截止核对。

| 字段 | SQLite 类型 / 空值 | 单位 | 含义与限定 |
| --- | --- | --- | --- |
| `playback_id` | TEXT / NOT NULL | — | 播放片段主键。 |
| `tts_id` | TEXT / NOT NULL | — | 所属TTS请求。 引用`syn_tts_request.tts_id`。 |
| `turn_id` | TEXT / NOT NULL | — | 所属轮次。 引用`syn_voice_turn.turn_id`。 |
| `segment_no` | INTEGER / NOT NULL | — | 同TTS中的播放片段号。 下界：1。 |
| `output_zone` | TEXT / NOT NULL | — | 播放音区。 允许值：driver, front, all。 |
| `start_offset_ms` | INTEGER / NOT NULL | ms | 首个可听播放相对turn起点的偏移。 下界：0。 |
| `finish_offset_ms` | INTEGER / NOT NULL | ms | 本片段结束偏移。 下界：0。 |
| `planned_ms` | INTEGER / NOT NULL | ms | 该片段原计划播放时长。 下界：0。 |
| `played_ms` | INTEGER / NOT NULL | ms | 实际可听时长。 下界：0。 |
| `buffering_ms` | INTEGER / NOT NULL | ms | 播放中的模拟等待时长。 下界：0。 |
| `end_reason` | TEXT / NOT NULL | — | 结束原因。 允许值：completed, barge_in, user_stop, device_error。 |
| `completion_state` | TEXT / NOT NULL | — | 片段播放是否完整。 允许值：complete, interrupted, failed。 |
| `volume_pct` | INTEGER / NOT NULL | percent | 合成音量百分比。 下界：0。 上界：100。 |
| `received_at` | TEXT / NOT NULL | UTC RFC3339 second | 该规范记录进入快照的接收时间；received_at必须早于snapshot_exclusive才可用于快照统计。 |

约束：

- `finish_offset_ms >= start_offset_ms`
- `played_ms <= planned_ms`
- `finish_offset_ms-start_offset_ms=played_ms+buffering_ms`

## `syn_interruption_event` · 播报打断事件

打断是播放层事件，与用户取消动作不同。新的输入可以沿用、替换或清除原目标，不能跨会话串指代。

- 行粒度：对某条播放片段的一次打断观测
- 主键：`interruption_id`
- 唯一键：除主键外未额外声明
- 时间口径：维度按快照读取；事实按各自文档时点与接收截止核对。

| 字段 | SQLite 类型 / 空值 | 单位 | 含义与限定 |
| --- | --- | --- | --- |
| `interruption_id` | TEXT / NOT NULL | — | 打断主键。 |
| `session_id` | TEXT / NOT NULL | — | 所属会话。 引用`syn_voice_session.session_id`。 |
| `interrupted_turn_id` | TEXT / NOT NULL | — | 被打断播报的轮次。 引用`syn_voice_turn.turn_id`。 |
| `playback_id` | TEXT / NOT NULL | — | 被打断的播放片段。 引用`syn_playback_segment.playback_id`。 |
| `triggering_turn_id` | TEXT / NULL | — | 新输入触发时的后继轮次；手动停止可NULL。 引用`syn_voice_turn.turn_id`。 |
| `occurred_at` | TEXT / NOT NULL | UTC RFC3339 second | 打断发生时点。 |
| `trigger_kind` | TEXT / NOT NULL | — | 打断触发方式。 允许值：new_utterance, button_stop, policy。 |
| `offset_in_playback_ms` | INTEGER / NOT NULL | ms | 从该播放片段开始到打断的偏移。 下界：0。 |
| `stop_latency_ms` | INTEGER / NOT NULL | ms | 发出停止请求到播放停止的模拟耗时。 下界：0。 |
| `stop_confirmed` | INTEGER / NOT NULL | boolean | 播放停止是否收到确认。 允许值：0, 1。 |
| `action_was_already_confirmed` | INTEGER / NOT NULL | boolean | 打断时原动作是否已确认；不能因为打断撤销该事实。 允许值：0, 1。 |
| `context_policy` | TEXT / NOT NULL | — | 对原目标上下文的处理。 允许值：carry, replace, clear。 |
| `received_at` | TEXT / NOT NULL | UTC RFC3339 second | 该规范记录进入快照的接收时间；received_at必须早于snapshot_exclusive才可用于快照统计。 |

## 可机读定义

以下记录是上文的明确结构定义，目录生成器只复用这些定义并与实际DDL核对；没有种子安排或用例预期值。

```semantic-definitions
{"kind":"table","table":"syn_tts_request","label":"播报合成请求","grain":"一轮中的一次模拟文本合成请求","primary_key":["tts_id"],"unique_keys":[["turn_id","attempt_no"]],"description":"TTS成功不等于已经播出，也不证明任务执行正确；不保存原始或合成音频。","time_basis":"维度按快照读取；事实按各自文档时点与接收截止核对。","checks":["finish_offset_ms>=start_offset_ms","wall_ms=finish_offset_ms-start_offset_ms"],"time_columns":[{"column":"received_at","role":"received"}],"default_filters":[]}
{"kind":"field","table":"syn_tts_request","name":"tts_id","type":"TEXT","nullable":false,"meaning":"TTS请求主键。"}
{"kind":"field","table":"syn_tts_request","name":"turn_id","type":"TEXT","nullable":false,"meaning":"所属轮次。","references":{"table":"syn_voice_turn","column":"turn_id"}}
{"kind":"field","table":"syn_tts_request","name":"action_result_id","type":"TEXT","nullable":true,"meaning":"回答动作结果时的依据回执；澄清/错误提示可NULL。","references":{"table":"syn_action_result","column":"result_id"}}
{"kind":"field","table":"syn_tts_request","name":"attempt_no","type":"INTEGER","nullable":false,"meaning":"同轮TTS尝试号。","minimum":1}
{"kind":"field","table":"syn_tts_request","name":"response_kind","type":"TEXT","nullable":false,"meaning":"系统答复类型。","enum":["answer","clarification","error","status"]}
{"kind":"field","table":"syn_tts_request","name":"response_text","type":"TEXT","nullable":false,"meaning":"从零构造的系统文本，不来自真实用户或公司。"}
{"kind":"field","table":"syn_tts_request","name":"voice_profile","type":"TEXT","nullable":false,"meaning":"虚构发声配置，不对应真实人物。","enum":["synthetic_voice_a","synthetic_voice_b"]}
{"kind":"field","table":"syn_tts_request","name":"endpoint_kind","type":"TEXT","nullable":false,"meaning":"合成位置。","enum":["edge","cloud"]}
{"kind":"field","table":"syn_tts_request","name":"start_offset_ms","type":"INTEGER","nullable":false,"meaning":"请求开始偏移。","unit":"ms","minimum":0}
{"kind":"field","table":"syn_tts_request","name":"first_chunk_offset_ms","type":"INTEGER","nullable":true,"meaning":"首次可播数据偏移，未产出NULL。","unit":"ms","minimum":0}
{"kind":"field","table":"syn_tts_request","name":"finish_offset_ms","type":"INTEGER","nullable":false,"meaning":"请求结束偏移。","unit":"ms","minimum":0}
{"kind":"field","table":"syn_tts_request","name":"wall_ms","type":"INTEGER","nullable":false,"meaning":"TTS处理耗时。","unit":"ms","minimum":0}
{"kind":"field","table":"syn_tts_request","name":"simulated_audio_ms","type":"INTEGER","nullable":false,"meaning":"模拟语音持续时长；没有音频文件。","unit":"ms","minimum":0}
{"kind":"field","table":"syn_tts_request","name":"outcome","type":"TEXT","nullable":false,"meaning":"合成结果。","enum":["succeeded","failed","timeout","cancelled"]}
{"kind":"field","table":"syn_tts_request","name":"error_code","type":"TEXT","nullable":true,"meaning":"模拟错误，无错误NULL。"}
{"kind":"field","table":"syn_tts_request","name":"received_at","type":"TEXT","nullable":false,"meaning":"该规范记录进入快照的接收时间；received_at必须早于snapshot_exclusive才可用于快照统计。","unit":"UTC RFC3339 second"}
{"kind":"table","table":"syn_playback_segment","label":"播报播放片段","grain":"一次TTS结果的一段实际模拟播放","primary_key":["playback_id"],"unique_keys":[["tts_id","segment_no"]],"description":"片段播放中断不自动使已经确认的动作失败。首音指标读取实际播放开始，不能用TTS请求开始替代。","time_basis":"维度按快照读取；事实按各自文档时点与接收截止核对。","checks":["finish_offset_ms >= start_offset_ms","played_ms <= planned_ms","finish_offset_ms-start_offset_ms=played_ms+buffering_ms"],"time_columns":[{"column":"received_at","role":"received"}],"default_filters":[]}
{"kind":"field","table":"syn_playback_segment","name":"playback_id","type":"TEXT","nullable":false,"meaning":"播放片段主键。"}
{"kind":"field","table":"syn_playback_segment","name":"tts_id","type":"TEXT","nullable":false,"meaning":"所属TTS请求。","references":{"table":"syn_tts_request","column":"tts_id"}}
{"kind":"field","table":"syn_playback_segment","name":"turn_id","type":"TEXT","nullable":false,"meaning":"所属轮次。","references":{"table":"syn_voice_turn","column":"turn_id"}}
{"kind":"field","table":"syn_playback_segment","name":"segment_no","type":"INTEGER","nullable":false,"meaning":"同TTS中的播放片段号。","minimum":1}
{"kind":"field","table":"syn_playback_segment","name":"output_zone","type":"TEXT","nullable":false,"meaning":"播放音区。","enum":["driver","front","all"]}
{"kind":"field","table":"syn_playback_segment","name":"start_offset_ms","type":"INTEGER","nullable":false,"meaning":"首个可听播放相对turn起点的偏移。","unit":"ms","minimum":0}
{"kind":"field","table":"syn_playback_segment","name":"finish_offset_ms","type":"INTEGER","nullable":false,"meaning":"本片段结束偏移。","unit":"ms","minimum":0}
{"kind":"field","table":"syn_playback_segment","name":"planned_ms","type":"INTEGER","nullable":false,"meaning":"该片段原计划播放时长。","unit":"ms","minimum":0}
{"kind":"field","table":"syn_playback_segment","name":"played_ms","type":"INTEGER","nullable":false,"meaning":"实际可听时长。","unit":"ms","minimum":0}
{"kind":"field","table":"syn_playback_segment","name":"buffering_ms","type":"INTEGER","nullable":false,"meaning":"播放中的模拟等待时长。","unit":"ms","minimum":0}
{"kind":"field","table":"syn_playback_segment","name":"end_reason","type":"TEXT","nullable":false,"meaning":"结束原因。","enum":["completed","barge_in","user_stop","device_error"]}
{"kind":"field","table":"syn_playback_segment","name":"completion_state","type":"TEXT","nullable":false,"meaning":"片段播放是否完整。","enum":["complete","interrupted","failed"]}
{"kind":"field","table":"syn_playback_segment","name":"volume_pct","type":"INTEGER","nullable":false,"meaning":"合成音量百分比。","unit":"percent","minimum":0,"maximum":100}
{"kind":"field","table":"syn_playback_segment","name":"received_at","type":"TEXT","nullable":false,"meaning":"该规范记录进入快照的接收时间；received_at必须早于snapshot_exclusive才可用于快照统计。","unit":"UTC RFC3339 second"}
{"kind":"table","table":"syn_interruption_event","label":"播报打断事件","grain":"对某条播放片段的一次打断观测","primary_key":["interruption_id"],"unique_keys":[],"description":"打断是播放层事件，与用户取消动作不同。新的输入可以沿用、替换或清除原目标，不能跨会话串指代。","time_basis":"维度按快照读取；事实按各自文档时点与接收截止核对。","checks":[],"time_columns":[{"column":"occurred_at","role":"business"},{"column":"received_at","role":"received"}],"default_filters":[]}
{"kind":"field","table":"syn_interruption_event","name":"interruption_id","type":"TEXT","nullable":false,"meaning":"打断主键。"}
{"kind":"field","table":"syn_interruption_event","name":"session_id","type":"TEXT","nullable":false,"meaning":"所属会话。","references":{"table":"syn_voice_session","column":"session_id"}}
{"kind":"field","table":"syn_interruption_event","name":"interrupted_turn_id","type":"TEXT","nullable":false,"meaning":"被打断播报的轮次。","references":{"table":"syn_voice_turn","column":"turn_id"}}
{"kind":"field","table":"syn_interruption_event","name":"playback_id","type":"TEXT","nullable":false,"meaning":"被打断的播放片段。","references":{"table":"syn_playback_segment","column":"playback_id"}}
{"kind":"field","table":"syn_interruption_event","name":"triggering_turn_id","type":"TEXT","nullable":true,"meaning":"新输入触发时的后继轮次；手动停止可NULL。","references":{"table":"syn_voice_turn","column":"turn_id"}}
{"kind":"field","table":"syn_interruption_event","name":"occurred_at","type":"TEXT","nullable":false,"meaning":"打断发生时点。","unit":"UTC RFC3339 second"}
{"kind":"field","table":"syn_interruption_event","name":"trigger_kind","type":"TEXT","nullable":false,"meaning":"打断触发方式。","enum":["new_utterance","button_stop","policy"]}
{"kind":"field","table":"syn_interruption_event","name":"offset_in_playback_ms","type":"INTEGER","nullable":false,"meaning":"从该播放片段开始到打断的偏移。","unit":"ms","minimum":0}
{"kind":"field","table":"syn_interruption_event","name":"stop_latency_ms","type":"INTEGER","nullable":false,"meaning":"发出停止请求到播放停止的模拟耗时。","unit":"ms","minimum":0}
{"kind":"field","table":"syn_interruption_event","name":"stop_confirmed","type":"INTEGER","nullable":false,"meaning":"播放停止是否收到确认。","unit":"boolean","enum":[0,1]}
{"kind":"field","table":"syn_interruption_event","name":"action_was_already_confirmed","type":"INTEGER","nullable":false,"meaning":"打断时原动作是否已确认；不能因为打断撤销该事实。","unit":"boolean","enum":[0,1]}
{"kind":"field","table":"syn_interruption_event","name":"context_policy","type":"TEXT","nullable":false,"meaning":"对原目标上下文的处理。","enum":["carry","replace","clear"]}
{"kind":"field","table":"syn_interruption_event","name":"received_at","type":"TEXT","nullable":false,"meaning":"该规范记录进入快照的接收时间；received_at必须早于snapshot_exclusive才可用于快照统计。","unit":"UTC RFC3339 second"}
```
