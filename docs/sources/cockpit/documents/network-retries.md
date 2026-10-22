# 网络、重试与失败归因

业务域：公开合成座舱语音交互。此文是人工制定的实验定义，待维护者核对，不代表任何真实厂商标准。

网络采样描述某个观察时刻的连接条件，不等于每个阶段都发生了相同网络状态。端侧可以在离线时完成一部分能力，云侧路径可能排队、超时、重试或回退。没有逐段网络事件时，不能凭一个总体网络标签推导精确离线时长或认定网络是故障原因。

请求身份、阶段身份和尝试身份分开：同一请求的多次尝试仍属于同一请求；首个成功和最终有效回执不一定是同一条。重试的分母应由请求总体或尝试总体明确给出，不能把两种“重试率”互换。

超时、拒绝、取消和未知回执保留各自含义。acceptance_state=unknown只表示提交回执不确定，不能据此断言动作未发生；需要结合相同operation_key的结果观测解释。没有进一步回执时保留未知，不直接改写为已失败。

edge_fallback_turn_rate统计存在endpoint_kind=edge且fallback_reason非none的轮次，表示回退到端侧；不是“云侧成功率”。同一轮多条重试记录只计一个分子。网络采样不提供连续断连子区间，无法凭相邻采样推导精确离线时长。

## `syn_network_observation` · 语音链路网络观测

网络采样与ASR尝试不是一一关系；时间邻近和相关不证明超时必由网络导致。

- 行粒度：一个会话内的网络状态采样
- 主键：`network_id`
- 唯一键：除主键外未额外声明
- 时间口径：维度按快照读取；事实按各自文档时点与接收截止核对。

| 字段 | SQLite 类型 / 空值 | 单位 | 含义与限定 |
| --- | --- | --- | --- |
| `network_id` | TEXT / NOT NULL | — | 网络观测主键。 |
| `session_id` | TEXT / NOT NULL | — | 所属会话。 引用`syn_voice_session.session_id`。 |
| `turn_id` | TEXT / NULL | — | 能关联的轮次，无则NULL。 引用`syn_voice_turn.turn_id`。 |
| `observed_at` | TEXT / NOT NULL | UTC RFC3339 second | 观测时间。 |
| `transport` | TEXT / NOT NULL | — | 传输类型。 允许值：cellular, wifi, none。 |
| `reachability` | TEXT / NOT NULL | — | 模拟可达性。 允许值：online, offline, degraded。 |
| `rtt_ms` | INTEGER / NULL | ms | 有测量时的RTT，无测量NULL。 下界：0。 |
| `loss_permille` | INTEGER / NULL | permille | 模拟丢包千分数，无有效测量NULL。 下界：0。 上界：1000。 |
| `signal_bucket` | TEXT / NOT NULL | — | 抽象信号档位。 允许值：weak, fair, good, not_applicable。 |
| `endpoint_scope` | TEXT / NOT NULL | — | 观测目标范围，不含真实域名/IP。 允许值：voice_cloud, general。 |
| `network_label` | TEXT / NOT NULL | — | 合成网络标签，不是SSID或运营商。 |
| `received_at` | TEXT / NOT NULL | UTC RFC3339 second | 该规范记录进入快照的接收时间；received_at必须早于snapshot_exclusive才可用于快照统计。 |
| `quality_state` | TEXT / NOT NULL | — | 记录质量；默认指标仅采用valid，invalid保留用于质量排查。 允许值：valid, invalid。 |

## `syn_error_event` · 交互链路错误事件

错误事件可重复反映同一个失败尝试，错误数不能当失败用户轮数；归因必须核对阶段状态与时间。

- 行粒度：一条可定位到轮次/阶段的合成错误观测
- 主键：`error_id`
- 唯一键：除主键外未额外声明
- 时间口径：维度按快照读取；事实按各自文档时点与接收截止核对。

| 字段 | SQLite 类型 / 空值 | 单位 | 含义与限定 |
| --- | --- | --- | --- |
| `error_id` | TEXT / NOT NULL | — | 错误事件主键。 |
| `session_id` | TEXT / NOT NULL | — | 所属会话。 引用`syn_voice_session.session_id`。 |
| `turn_id` | TEXT / NULL | — | 所属轮次；只有会话级错误时NULL。 引用`syn_voice_turn.turn_id`。 |
| `stage` | TEXT / NOT NULL | — | 发生阶段。 允许值：wakeup, frontend, asr, nlu, dialogue, route, action, tts, playback, network。 |
| `related_record_id` | TEXT / NULL | — | 该阶段对应的合成记录ID；由stage确定表，不能跨阶段随意关联。 |
| `occurred_at` | TEXT / NOT NULL | UTC RFC3339 second | 错误发生时点。 |
| `error_code` | TEXT / NOT NULL | — | 从零定义的SYN错误码，不是真实厂商DTC。 |
| `severity` | TEXT / NOT NULL | — | 体验影响分级，不是安全评级。 允许值：info, warning, error。 |
| `retryable` | INTEGER / NOT NULL | boolean | 当时是否允许重试；不保证后来已重试。 允许值：0, 1。 |
| `recovery_action` | TEXT / NOT NULL | — | 观测到的恢复动作。 允许值：none, retry, edge_fallback, clarify, query_receipt, stop_playback。 |
| `recovery_state` | TEXT / NOT NULL | — | 恢复状态，unknown不能写成成功。 允许值：not_started, succeeded, failed, unknown。 |
| `detail_text` | TEXT / NOT NULL | — | 从零构造的错误说明，不包含栈、密钥、URL或公司名称。 |
| `received_at` | TEXT / NOT NULL | UTC RFC3339 second | 该规范记录进入快照的接收时间；received_at必须早于snapshot_exclusive才可用于快照统计。 |
| `quality_state` | TEXT / NOT NULL | — | 记录质量；默认指标仅采用valid，invalid保留用于质量排查。 允许值：valid, invalid。 |

## 可机读定义

以下记录是上文的明确结构定义，目录生成器只复用这些定义并与实际DDL核对；没有种子安排或用例预期值。

```semantic-definitions
{"kind":"table","table":"syn_network_observation","label":"语音链路网络观测","grain":"一个会话内的网络状态采样","primary_key":["network_id"],"unique_keys":[],"description":"网络采样与ASR尝试不是一一关系；时间邻近和相关不证明超时必由网络导致。","time_basis":"维度按快照读取；事实按各自文档时点与接收截止核对。","checks":[],"time_columns":[{"column":"observed_at","role":"business"},{"column":"received_at","role":"received"}],"default_filters":["quality_state = 'valid'"]}
{"kind":"field","table":"syn_network_observation","name":"network_id","type":"TEXT","nullable":false,"meaning":"网络观测主键。"}
{"kind":"field","table":"syn_network_observation","name":"session_id","type":"TEXT","nullable":false,"meaning":"所属会话。","references":{"table":"syn_voice_session","column":"session_id"}}
{"kind":"field","table":"syn_network_observation","name":"turn_id","type":"TEXT","nullable":true,"meaning":"能关联的轮次，无则NULL。","references":{"table":"syn_voice_turn","column":"turn_id"}}
{"kind":"field","table":"syn_network_observation","name":"observed_at","type":"TEXT","nullable":false,"meaning":"观测时间。","unit":"UTC RFC3339 second"}
{"kind":"field","table":"syn_network_observation","name":"transport","type":"TEXT","nullable":false,"meaning":"传输类型。","enum":["cellular","wifi","none"]}
{"kind":"field","table":"syn_network_observation","name":"reachability","type":"TEXT","nullable":false,"meaning":"模拟可达性。","enum":["online","offline","degraded"]}
{"kind":"field","table":"syn_network_observation","name":"rtt_ms","type":"INTEGER","nullable":true,"meaning":"有测量时的RTT，无测量NULL。","unit":"ms","minimum":0}
{"kind":"field","table":"syn_network_observation","name":"loss_permille","type":"INTEGER","nullable":true,"meaning":"模拟丢包千分数，无有效测量NULL。","unit":"permille","minimum":0,"maximum":1000}
{"kind":"field","table":"syn_network_observation","name":"signal_bucket","type":"TEXT","nullable":false,"meaning":"抽象信号档位。","enum":["weak","fair","good","not_applicable"]}
{"kind":"field","table":"syn_network_observation","name":"endpoint_scope","type":"TEXT","nullable":false,"meaning":"观测目标范围，不含真实域名/IP。","enum":["voice_cloud","general"]}
{"kind":"field","table":"syn_network_observation","name":"network_label","type":"TEXT","nullable":false,"meaning":"合成网络标签，不是SSID或运营商。"}
{"kind":"field","table":"syn_network_observation","name":"received_at","type":"TEXT","nullable":false,"meaning":"该规范记录进入快照的接收时间；received_at必须早于snapshot_exclusive才可用于快照统计。","unit":"UTC RFC3339 second"}
{"kind":"field","table":"syn_network_observation","name":"quality_state","type":"TEXT","nullable":false,"meaning":"记录质量；默认指标仅采用valid，invalid保留用于质量排查。","enum":["valid","invalid"]}
{"kind":"table","table":"syn_error_event","label":"交互链路错误事件","grain":"一条可定位到轮次/阶段的合成错误观测","primary_key":["error_id"],"unique_keys":[],"description":"错误事件可重复反映同一个失败尝试，错误数不能当失败用户轮数；归因必须核对阶段状态与时间。","time_basis":"维度按快照读取；事实按各自文档时点与接收截止核对。","checks":[],"time_columns":[{"column":"occurred_at","role":"business"},{"column":"received_at","role":"received"}],"default_filters":["quality_state = 'valid'"]}
{"kind":"field","table":"syn_error_event","name":"error_id","type":"TEXT","nullable":false,"meaning":"错误事件主键。"}
{"kind":"field","table":"syn_error_event","name":"session_id","type":"TEXT","nullable":false,"meaning":"所属会话。","references":{"table":"syn_voice_session","column":"session_id"}}
{"kind":"field","table":"syn_error_event","name":"turn_id","type":"TEXT","nullable":true,"meaning":"所属轮次；只有会话级错误时NULL。","references":{"table":"syn_voice_turn","column":"turn_id"}}
{"kind":"field","table":"syn_error_event","name":"stage","type":"TEXT","nullable":false,"meaning":"发生阶段。","enum":["wakeup","frontend","asr","nlu","dialogue","route","action","tts","playback","network"]}
{"kind":"field","table":"syn_error_event","name":"related_record_id","type":"TEXT","nullable":true,"meaning":"该阶段对应的合成记录ID；由stage确定表，不能跨阶段随意关联。"}
{"kind":"field","table":"syn_error_event","name":"occurred_at","type":"TEXT","nullable":false,"meaning":"错误发生时点。","unit":"UTC RFC3339 second"}
{"kind":"field","table":"syn_error_event","name":"error_code","type":"TEXT","nullable":false,"meaning":"从零定义的SYN错误码，不是真实厂商DTC。"}
{"kind":"field","table":"syn_error_event","name":"severity","type":"TEXT","nullable":false,"meaning":"体验影响分级，不是安全评级。","enum":["info","warning","error"]}
{"kind":"field","table":"syn_error_event","name":"retryable","type":"INTEGER","nullable":false,"meaning":"当时是否允许重试；不保证后来已重试。","unit":"boolean","enum":[0,1]}
{"kind":"field","table":"syn_error_event","name":"recovery_action","type":"TEXT","nullable":false,"meaning":"观测到的恢复动作。","enum":["none","retry","edge_fallback","clarify","query_receipt","stop_playback"]}
{"kind":"field","table":"syn_error_event","name":"recovery_state","type":"TEXT","nullable":false,"meaning":"恢复状态，unknown不能写成成功。","enum":["not_started","succeeded","failed","unknown"]}
{"kind":"field","table":"syn_error_event","name":"detail_text","type":"TEXT","nullable":false,"meaning":"从零构造的错误说明，不包含栈、密钥、URL或公司名称。"}
{"kind":"field","table":"syn_error_event","name":"received_at","type":"TEXT","nullable":false,"meaning":"该规范记录进入快照的接收时间；received_at必须早于snapshot_exclusive才可用于快照统计。","unit":"UTC RFC3339 second"}
{"kind":"field","table":"syn_error_event","name":"quality_state","type":"TEXT","nullable":false,"meaning":"记录质量；默认指标仅采用valid，invalid保留用于质量排查。","enum":["valid","invalid"]}
```
