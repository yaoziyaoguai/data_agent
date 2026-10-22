# 唤醒与入口决策

业务域：公开合成座舱语音交互。此文是人工制定的实验定义，待维护者核对，不代表任何真实厂商标准。

syn_wakeup_attempt的一行是一次入口触发观测，trigger_kind区分唤醒词、按键和连续输入。candidate_detected表示是否产生候选；accepted表示是否接受并关联会话。拒绝观测没有session_id，所以统计入口时不能先INNER JOIN完整会话，否则会把拒绝记录排除。

入口接受率按定义覆盖全部可见有效入口，并应按trigger_kind分组解释。若问题专指唤醒词，需要显式限定wake_word；按键不经历同样的声学检测。confidence_permille是合成分数，accepted是系统决策，reference_is_intended是独立人工合成标签，三者不可互相替代。未提供标签时不能证明真唤醒，也不能把无标签当成负标签。

入口之后没有语音只说明后续输入状态，不能凭此断言环境噪声、误触或用户放弃。当前包提供入口观测，没有所有实际声音机会或原始音频，因此不能外推真实环境中的漏唤醒率。



## `syn_wakeup_attempt` · 语音入口触发尝试

没有音频或真实唤醒词。准确性分析只覆盖reference_is_intended非空子集，不能把accepted当真值。

- 行粒度：一次唤醒或按键入口触发观测
- 主键：`wakeup_id`
- 唯一键：除主键外未额外声明
- 时间口径：维度按快照读取；事实按各自文档时点与接收截止核对。

| 字段 | SQLite 类型 / 空值 | 单位 | 含义与限定 |
| --- | --- | --- | --- |
| `wakeup_id` | TEXT / NOT NULL | — | 入口尝试主键。 |
| `vehicle_id` | TEXT / NOT NULL | — | 设备。 引用`syn_vehicle.vehicle_id`。 |
| `build_id` | TEXT / NOT NULL | — | 触发时build。 引用`syn_software_build.build_id`。 |
| `session_id` | TEXT / NULL | — | 接受后关联会话；拒绝/漏唤醒时NULL。 引用`syn_voice_session.session_id`。 |
| `started_at` | TEXT / NOT NULL | UTC RFC3339 second | 触发观测时点。 |
| `trigger_kind` | TEXT / NOT NULL | — | 触发入口。 允许值：wake_word, button, continuous。 |
| `seat_zone` | TEXT / NOT NULL | — | 触发音区。 允许值：driver, front_passenger, rear。 |
| `candidate_detected` | INTEGER / NOT NULL | boolean | 检测器是否产生候选。 允许值：0, 1。 |
| `accepted` | INTEGER / NOT NULL | boolean | 是否接受候选并进入会话。 允许值：0, 1。 |
| `reject_reason` | TEXT / NOT NULL | — | 未接受的分类。 允许值：none, not_detected, false_trigger, debounce, policy。 |
| `confidence_permille` | INTEGER / NULL | permille | 合成候选置信度千分数，未检测为NULL。 下界：0。 上界：1000。 |
| `reference_is_intended` | INTEGER / NULL | boolean | 人工合成是否为有效唤醒标签；无标签NULL。 允许值：0, 1。 |
| `label_origin` | TEXT / NOT NULL | — | 标签来源，仅人工合成或无标签。 允许值：synthetic_authored, none。 |
| `decision_ms` | INTEGER / NOT NULL | ms | 触发到入口决策的单调耗时。 下界：0。 |
| `received_at` | TEXT / NOT NULL | UTC RFC3339 second | 该规范记录进入快照的接收时间；received_at必须早于snapshot_exclusive才可用于快照统计。 |
| `quality_state` | TEXT / NOT NULL | — | 记录质量；默认指标仅采用valid，invalid保留用于质量排查。 允许值：valid, invalid。 |

约束：

- `(accepted=1 AND candidate_detected=1 AND session_id IS NOT NULL AND reject_reason='none') OR (accepted=0 AND session_id IS NULL AND reject_reason<>'none')`

## 可机读定义

以下记录是上文的明确结构定义，目录生成器只复用这些定义并与实际DDL核对；没有种子安排或用例预期值。

```semantic-definitions
{"kind":"table","table":"syn_wakeup_attempt","label":"语音入口触发尝试","grain":"一次唤醒或按键入口触发观测","primary_key":["wakeup_id"],"unique_keys":[],"description":"没有音频或真实唤醒词。准确性分析只覆盖reference_is_intended非空子集，不能把accepted当真值。","time_basis":"维度按快照读取；事实按各自文档时点与接收截止核对。","checks":["(accepted=1 AND candidate_detected=1 AND session_id IS NOT NULL AND reject_reason='none') OR (accepted=0 AND session_id IS NULL AND reject_reason<>'none')"],"time_columns":[{"column":"started_at","role":"business"},{"column":"received_at","role":"received"}],"default_filters":["quality_state = 'valid'"]}
{"kind":"field","table":"syn_wakeup_attempt","name":"wakeup_id","type":"TEXT","nullable":false,"meaning":"入口尝试主键。"}
{"kind":"field","table":"syn_wakeup_attempt","name":"vehicle_id","type":"TEXT","nullable":false,"meaning":"设备。","references":{"table":"syn_vehicle","column":"vehicle_id"}}
{"kind":"field","table":"syn_wakeup_attempt","name":"build_id","type":"TEXT","nullable":false,"meaning":"触发时build。","references":{"table":"syn_software_build","column":"build_id"}}
{"kind":"field","table":"syn_wakeup_attempt","name":"session_id","type":"TEXT","nullable":true,"meaning":"接受后关联会话；拒绝/漏唤醒时NULL。","references":{"table":"syn_voice_session","column":"session_id"}}
{"kind":"field","table":"syn_wakeup_attempt","name":"started_at","type":"TEXT","nullable":false,"meaning":"触发观测时点。","unit":"UTC RFC3339 second"}
{"kind":"field","table":"syn_wakeup_attempt","name":"trigger_kind","type":"TEXT","nullable":false,"meaning":"触发入口。","enum":["wake_word","button","continuous"]}
{"kind":"field","table":"syn_wakeup_attempt","name":"seat_zone","type":"TEXT","nullable":false,"meaning":"触发音区。","enum":["driver","front_passenger","rear"]}
{"kind":"field","table":"syn_wakeup_attempt","name":"candidate_detected","type":"INTEGER","nullable":false,"meaning":"检测器是否产生候选。","unit":"boolean","enum":[0,1]}
{"kind":"field","table":"syn_wakeup_attempt","name":"accepted","type":"INTEGER","nullable":false,"meaning":"是否接受候选并进入会话。","unit":"boolean","enum":[0,1]}
{"kind":"field","table":"syn_wakeup_attempt","name":"reject_reason","type":"TEXT","nullable":false,"meaning":"未接受的分类。","enum":["none","not_detected","false_trigger","debounce","policy"]}
{"kind":"field","table":"syn_wakeup_attempt","name":"confidence_permille","type":"INTEGER","nullable":true,"meaning":"合成候选置信度千分数，未检测为NULL。","unit":"permille","minimum":0,"maximum":1000}
{"kind":"field","table":"syn_wakeup_attempt","name":"reference_is_intended","type":"INTEGER","nullable":true,"meaning":"人工合成是否为有效唤醒标签；无标签NULL。","unit":"boolean","enum":[0,1]}
{"kind":"field","table":"syn_wakeup_attempt","name":"label_origin","type":"TEXT","nullable":false,"meaning":"标签来源，仅人工合成或无标签。","enum":["synthetic_authored","none"]}
{"kind":"field","table":"syn_wakeup_attempt","name":"decision_ms","type":"INTEGER","nullable":false,"meaning":"触发到入口决策的单调耗时。","unit":"ms","minimum":0}
{"kind":"field","table":"syn_wakeup_attempt","name":"received_at","type":"TEXT","nullable":false,"meaning":"该规范记录进入快照的接收时间；received_at必须早于snapshot_exclusive才可用于快照统计。","unit":"UTC RFC3339 second"}
{"kind":"field","table":"syn_wakeup_attempt","name":"quality_state","type":"TEXT","nullable":false,"meaning":"记录质量；默认指标仅采用valid，invalid保留用于质量排查。","enum":["valid","invalid"]}
```
