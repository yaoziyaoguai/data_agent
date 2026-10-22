# 时间、质量与快照

业务域：公开合成座舱语音交互。此文是人工制定的实验定义，待维护者核对，不代表任何真实厂商标准。

业务时刻、收到时刻和采样时刻用于不同问题。默认观察按规范定义的会话或请求队列选择半开区间；分析事件发生日时必须明确改用对应业务时间。跨午夜请求不能被收到日期或日志归档分区悄悄改标。

快照只采用当时已发生且已收到的事实。晚到记录可以用于独立质量诊断，但不能混入该快照的业务分子、分母。日汇总是明确快照下的派生结果；若用户要非整日范围或另一快照，应回到原始事实，不能把同一天的汇总简单裁成小时值。

短操作的精确耗时来自单调时钟毫秒值，UTC时间字符串负责定位。缺失耗时表示没有可靠测量，不是零耗时。重复记录、重试和多个合法候选需要按各自主键及语义判断；发现相同请求ID下有多行并不能直接认定数据重复。

来源不足、记录未完成、字段不适用、收到时间超出快照和被质量规则排除应分别说明。不得把空结果当作故障不存在，也不能把部分保存的结果当成总体。

本包turn.started_at合成锚点与整秒对齐，所有*_offset_ms相对该锚点；received_at生成在该事实完成之后至少一秒。子事实可独立晚到，不保证各阶段的收到顺序等于业务顺序。普通体验指标限定非实验且授权车辆、有效完整session和valid轮次。唤醒入口可能被拒绝而没有session，入口指标按自身started_at及质量/车辆资格计算，不能强行INNER JOIN完整session。

日表syn_daily_voice_experience的activity_date并列保存三种日期队列：session_count按session.started_at日，wake计数按wakeup.started_at日，turn计数按turn.started_at日。拒绝唤醒的build来自该wake自身冻结值。跨午夜时同日turn/wake之比不是同批请求漏斗；活跃语音车辆必须有有效turn，不能把wake-only或session-only行纳入。syn_daily_stage_latency与syn_daily_intent_outcome按turn日归属。

## `syn_voice_session` · 语音交互会话

同会话可多轮澄清、打断或换目标。会话数、turn数与各阶段attempt数分别统计。

- 行粒度：一次连续的多轮座舱语音会话
- 主键：`session_id`
- 唯一键：除主键外未额外声明
- 时间口径：维度按快照读取；事实按各自文档时点与接收截止核对。

| 字段 | SQLite 类型 / 空值 | 单位 | 含义与限定 |
| --- | --- | --- | --- |
| `session_id` | TEXT / NOT NULL | — | 会话主键。 |
| `vehicle_id` | TEXT / NOT NULL | — | 所属合成车辆。 引用`syn_vehicle.vehicle_id`。 |
| `build_id` | TEXT / NOT NULL | — | 开始时冻结的build。 引用`syn_software_build.build_id`。 |
| `policy_id` | TEXT / NOT NULL | — | 本会话冻结策略。 引用`syn_runtime_policy.policy_id`。 |
| `started_at` | TEXT / NOT NULL | UTC RFC3339 second | 会话起点。 |
| `ended_at` | TEXT / NOT NULL | UTC RFC3339 second | 会话终点。 |
| `duration_ms` | INTEGER / NOT NULL | ms | 会话墙钟整秒区间的精确毫秒长度。 下界：0。 |
| `entry_kind` | TEXT / NOT NULL | — | 进入方式。 允许值：wake_word, button, continuous。 |
| `locale` | TEXT / NOT NULL | — | 会话locale。 允许值：zh-CN, en-US。 |
| `seat_zone` | TEXT / NOT NULL | — | 主要发起音区。 允许值：driver, front_passenger, rear。 |
| `motion_state` | TEXT / NOT NULL | — | 当时行驶状态分类。 允许值：parked, moving。 |
| `network_at_start` | TEXT / NOT NULL | — | 起点网络状态，不代替后续网络观测。 允许值：online, offline。 |
| `end_reason` | TEXT / NOT NULL | — | 会话结束原因。 允许值：idle, user_cancel, session_timeout, system_end。 |
| `is_complete` | INTEGER / NOT NULL | boolean | 是否收到完整会话尾记录。 允许值：0, 1。 |
| `received_at` | TEXT / NOT NULL | UTC RFC3339 second | 该规范记录进入快照的接收时间；received_at必须早于snapshot_exclusive才可用于快照统计。 |
| `quality_state` | TEXT / NOT NULL | — | 记录质量；默认指标仅采用valid，invalid保留用于质量排查。 允许值：valid, invalid。 |

约束：

- `ended_at > started_at`

## 可机读定义

以下记录是上文的明确结构定义，目录生成器只复用这些定义并与实际DDL核对；没有种子安排或用例预期值。

```semantic-definitions
{"kind":"table","table":"syn_voice_session","label":"语音交互会话","grain":"一次连续的多轮座舱语音会话","primary_key":["session_id"],"unique_keys":[],"description":"同会话可多轮澄清、打断或换目标。会话数、turn数与各阶段attempt数分别统计。","time_basis":"维度按快照读取；事实按各自文档时点与接收截止核对。","checks":["ended_at > started_at"],"time_columns":[{"column":"started_at","role":"business"},{"column":"ended_at","role":"business"},{"column":"received_at","role":"received"}],"default_filters":["quality_state = 'valid'","is_complete = 1"]}
{"kind":"field","table":"syn_voice_session","name":"session_id","type":"TEXT","nullable":false,"meaning":"会话主键。"}
{"kind":"field","table":"syn_voice_session","name":"vehicle_id","type":"TEXT","nullable":false,"meaning":"所属合成车辆。","references":{"table":"syn_vehicle","column":"vehicle_id"}}
{"kind":"field","table":"syn_voice_session","name":"build_id","type":"TEXT","nullable":false,"meaning":"开始时冻结的build。","references":{"table":"syn_software_build","column":"build_id"}}
{"kind":"field","table":"syn_voice_session","name":"policy_id","type":"TEXT","nullable":false,"meaning":"本会话冻结策略。","references":{"table":"syn_runtime_policy","column":"policy_id"}}
{"kind":"field","table":"syn_voice_session","name":"started_at","type":"TEXT","nullable":false,"meaning":"会话起点。","unit":"UTC RFC3339 second"}
{"kind":"field","table":"syn_voice_session","name":"ended_at","type":"TEXT","nullable":false,"meaning":"会话终点。","unit":"UTC RFC3339 second"}
{"kind":"field","table":"syn_voice_session","name":"duration_ms","type":"INTEGER","nullable":false,"meaning":"会话墙钟整秒区间的精确毫秒长度。","unit":"ms","minimum":0}
{"kind":"field","table":"syn_voice_session","name":"entry_kind","type":"TEXT","nullable":false,"meaning":"进入方式。","enum":["wake_word","button","continuous"]}
{"kind":"field","table":"syn_voice_session","name":"locale","type":"TEXT","nullable":false,"meaning":"会话locale。","enum":["zh-CN","en-US"]}
{"kind":"field","table":"syn_voice_session","name":"seat_zone","type":"TEXT","nullable":false,"meaning":"主要发起音区。","enum":["driver","front_passenger","rear"]}
{"kind":"field","table":"syn_voice_session","name":"motion_state","type":"TEXT","nullable":false,"meaning":"当时行驶状态分类。","enum":["parked","moving"]}
{"kind":"field","table":"syn_voice_session","name":"network_at_start","type":"TEXT","nullable":false,"meaning":"起点网络状态，不代替后续网络观测。","enum":["online","offline"]}
{"kind":"field","table":"syn_voice_session","name":"end_reason","type":"TEXT","nullable":false,"meaning":"会话结束原因。","enum":["idle","user_cancel","session_timeout","system_end"]}
{"kind":"field","table":"syn_voice_session","name":"is_complete","type":"INTEGER","nullable":false,"meaning":"是否收到完整会话尾记录。","unit":"boolean","enum":[0,1]}
{"kind":"field","table":"syn_voice_session","name":"received_at","type":"TEXT","nullable":false,"meaning":"该规范记录进入快照的接收时间；received_at必须早于snapshot_exclusive才可用于快照统计。","unit":"UTC RFC3339 second"}
{"kind":"field","table":"syn_voice_session","name":"quality_state","type":"TEXT","nullable":false,"meaning":"记录质量；默认指标仅采用valid，invalid保留用于质量排查。","enum":["valid","invalid"]}
```
