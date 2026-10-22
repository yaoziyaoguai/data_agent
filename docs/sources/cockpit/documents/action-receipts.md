# 动作提交、效果与幂等

业务域：公开合成座舱语音交互。此文是人工制定的实验定义，待维护者核对，不代表任何真实厂商标准。

动作链区分创建命令、发送、对端接受、业务执行、效果确认和最终回执。接受请求不等于设备已完成动作；网络超时也不证明动作没有发生。对回执未知的操作应沿原身份查证，不能因看不到结果就换一个命令身份重做。

动作参数必须对应当时确认的意图、槽位及版本。用户后来改温度、座位或目标时，旧回执仍属于旧命令；不能把它作为新条件的成功证据。取消发出、取消被接受、执行已停止和动作已经完成同样需要区分。

本包只保存虚构命令与虚构回执，不连接车辆或执行真实设备动作。分析SQL读取这些记录，资料中的命令文本不授予任何外部操作权限。指标“执行成功”只能采用文档指定的最终执行/效果状态，不能用路由成功、HTTP接受或TTS提示“已完成”替代。

operation_key定义逻辑动作；invocation_id只定义传输尝试。一个operation可以有多次提交或重复回执，但不能据此增加动作数。最新可见观测在相同operation内按observed_offset_ms、observation_no、result_id倒序确定，最后两个键仅用于稳定解决同一偏移的并列。效果确认必须同时有succeeded回执和confirmed效果；accepted只是提交被接受。不存在回执或最新return_state为unknown时保持未知。

## `syn_action_invocation` · 动作提交尝试

提交成功、执行成功与效果确认是三层状态。重试传输不新增逻辑动作，unknown不能凭空重建operation。

- 行粒度：一个稳定operation的一次传输提交尝试
- 主键：`invocation_id`
- 唯一键：(operation_key, attempt_no)
- 时间口径：维度按快照读取；事实按各自文档时点与接收截止核对。

| 字段 | SQLite 类型 / 空值 | 单位 | 含义与限定 |
| --- | --- | --- | --- |
| `invocation_id` | TEXT / NOT NULL | — | 提交尝试主键。 |
| `turn_id` | TEXT / NOT NULL | — | 所属轮次。 引用`syn_voice_turn.turn_id`。 |
| `route_id` | TEXT / NOT NULL | — | 采用的最终路由。 引用`syn_skill_route.route_id`。 |
| `operation_key` | TEXT / NOT NULL | — | 同一逻辑动作稳定身份，重试必须沿用。 |
| `attempt_no` | INTEGER / NOT NULL | — | 同operation的传输尝试号。 下界：1。 |
| `action_name` | TEXT / NOT NULL | — | 合成动作名，对应意图定义。 |
| `argument_name` | TEXT / NOT NULL | — | 主要参数名，若无参数为none。 |
| `argument_value` | TEXT / NULL | — | 从合成槽位得到的主要参数，无参数NULL。 |
| `argument_unit` | TEXT / NULL | — | 参数单位，无则NULL。 |
| `submitted_offset_ms` | INTEGER / NOT NULL | ms | 相对turn起点的提交时间。 下界：0。 |
| `deadline_offset_ms` | INTEGER / NOT NULL | ms | 本次提交允许的截止偏移。 下界：0。 |
| `transport_kind` | TEXT / NOT NULL | — | 模拟调用协议类型。 允许值：local_bus, simulated_cloud。 |
| `acceptance_state` | TEXT / NOT NULL | — | 提交是否被接收；unknown不是未执行。 允许值：accepted, rejected, unknown。 |
| `idempotency_supported` | INTEGER / NOT NULL | boolean | 本包操作固定支持按operation_key查证。 允许值：0, 1。 |
| `timeout_ms` | INTEGER / NOT NULL | ms | 当前提交超时配置。 下界：0。 |
| `received_at` | TEXT / NOT NULL | UTC RFC3339 second | 该规范记录进入快照的接收时间；received_at必须早于snapshot_exclusive才可用于快照统计。 |

约束：

- `deadline_offset_ms >= submitted_offset_ms`
- `idempotency_supported=1`

## `syn_action_result` · 动作执行与效果回执

同operation可以有重复回执，但只对应一个效果实例。效果confirmed要求succeeded；成功回执不能因后来的轮询被改写成unknown。

- 行粒度：一次提交对应的一条结果观测，可先unknown后明确
- 主键：`result_id`
- 唯一键：(invocation_id, observation_no)
- 时间口径：维度按快照读取；事实按各自文档时点与接收截止核对。

| 字段 | SQLite 类型 / 空值 | 单位 | 含义与限定 |
| --- | --- | --- | --- |
| `result_id` | TEXT / NOT NULL | — | 回执观测主键。 |
| `invocation_id` | TEXT / NOT NULL | — | 所属提交尝试。 引用`syn_action_invocation.invocation_id`。 |
| `turn_id` | TEXT / NOT NULL | — | 所属轮次，须与提交一致。 引用`syn_voice_turn.turn_id`。 |
| `operation_key` | TEXT / NOT NULL | — | 稳定逻辑操作身份，须与提交一致。 |
| `observation_no` | INTEGER / NOT NULL | — | 同invocation的递增观测号。 下界：1。 |
| `observed_offset_ms` | INTEGER / NOT NULL | ms | 相对轮次起点的观测时间。 下界：0。 |
| `return_state` | TEXT / NOT NULL | — | 执行回执状态。 允许值：succeeded, failed, cancelled, unknown。 |
| `effect_state` | TEXT / NOT NULL | — | 效果是否被确认，不能仅由接收成功推断。 允许值：confirmed, not_observed, unknown。 |
| `effect_instance_id` | TEXT / NULL | — | 已确认效果的合成实例号；重放沿同一号，未确认NULL。 |
| `result_value` | TEXT / NULL | — | 合成效果值，无明确效果NULL。 |
| `result_unit` | TEXT / NULL | — | 效果单位，无则NULL。 |
| `error_code` | TEXT / NULL | — | 模拟错误分类，正常NULL。 |
| `replayed_receipt` | INTEGER / NOT NULL | boolean | 是否接回已知结果而非重复执行。 允许值：0, 1。 |
| `server_elapsed_ms` | INTEGER / NULL | ms | 有明确回执时的服务处理时长；unknown可NULL。 下界：0。 |
| `received_at` | TEXT / NOT NULL | UTC RFC3339 second | 该规范记录进入快照的接收时间；received_at必须早于snapshot_exclusive才可用于快照统计。 |

约束：

- `effect_state<>'confirmed' OR (return_state='succeeded' AND effect_instance_id IS NOT NULL)`

## 可机读定义

以下记录是上文的明确结构定义，目录生成器只复用这些定义并与实际DDL核对；没有种子安排或用例预期值。

```semantic-definitions
{"kind":"table","table":"syn_action_invocation","label":"动作提交尝试","grain":"一个稳定operation的一次传输提交尝试","primary_key":["invocation_id"],"unique_keys":[["operation_key","attempt_no"]],"description":"提交成功、执行成功与效果确认是三层状态。重试传输不新增逻辑动作，unknown不能凭空重建operation。","time_basis":"维度按快照读取；事实按各自文档时点与接收截止核对。","checks":["deadline_offset_ms >= submitted_offset_ms","idempotency_supported=1"],"time_columns":[{"column":"received_at","role":"received"}],"default_filters":[]}
{"kind":"field","table":"syn_action_invocation","name":"invocation_id","type":"TEXT","nullable":false,"meaning":"提交尝试主键。"}
{"kind":"field","table":"syn_action_invocation","name":"turn_id","type":"TEXT","nullable":false,"meaning":"所属轮次。","references":{"table":"syn_voice_turn","column":"turn_id"}}
{"kind":"field","table":"syn_action_invocation","name":"route_id","type":"TEXT","nullable":false,"meaning":"采用的最终路由。","references":{"table":"syn_skill_route","column":"route_id"}}
{"kind":"field","table":"syn_action_invocation","name":"operation_key","type":"TEXT","nullable":false,"meaning":"同一逻辑动作稳定身份，重试必须沿用。"}
{"kind":"field","table":"syn_action_invocation","name":"attempt_no","type":"INTEGER","nullable":false,"meaning":"同operation的传输尝试号。","minimum":1}
{"kind":"field","table":"syn_action_invocation","name":"action_name","type":"TEXT","nullable":false,"meaning":"合成动作名，对应意图定义。"}
{"kind":"field","table":"syn_action_invocation","name":"argument_name","type":"TEXT","nullable":false,"meaning":"主要参数名，若无参数为none。"}
{"kind":"field","table":"syn_action_invocation","name":"argument_value","type":"TEXT","nullable":true,"meaning":"从合成槽位得到的主要参数，无参数NULL。"}
{"kind":"field","table":"syn_action_invocation","name":"argument_unit","type":"TEXT","nullable":true,"meaning":"参数单位，无则NULL。"}
{"kind":"field","table":"syn_action_invocation","name":"submitted_offset_ms","type":"INTEGER","nullable":false,"meaning":"相对turn起点的提交时间。","unit":"ms","minimum":0}
{"kind":"field","table":"syn_action_invocation","name":"deadline_offset_ms","type":"INTEGER","nullable":false,"meaning":"本次提交允许的截止偏移。","unit":"ms","minimum":0}
{"kind":"field","table":"syn_action_invocation","name":"transport_kind","type":"TEXT","nullable":false,"meaning":"模拟调用协议类型。","enum":["local_bus","simulated_cloud"]}
{"kind":"field","table":"syn_action_invocation","name":"acceptance_state","type":"TEXT","nullable":false,"meaning":"提交是否被接收；unknown不是未执行。","enum":["accepted","rejected","unknown"]}
{"kind":"field","table":"syn_action_invocation","name":"idempotency_supported","type":"INTEGER","nullable":false,"meaning":"本包操作固定支持按operation_key查证。","unit":"boolean","enum":[0,1]}
{"kind":"field","table":"syn_action_invocation","name":"timeout_ms","type":"INTEGER","nullable":false,"meaning":"当前提交超时配置。","unit":"ms","minimum":0}
{"kind":"field","table":"syn_action_invocation","name":"received_at","type":"TEXT","nullable":false,"meaning":"该规范记录进入快照的接收时间；received_at必须早于snapshot_exclusive才可用于快照统计。","unit":"UTC RFC3339 second"}
{"kind":"table","table":"syn_action_result","label":"动作执行与效果回执","grain":"一次提交对应的一条结果观测，可先unknown后明确","primary_key":["result_id"],"unique_keys":[["invocation_id","observation_no"]],"description":"同operation可以有重复回执，但只对应一个效果实例。效果confirmed要求succeeded；成功回执不能因后来的轮询被改写成unknown。","time_basis":"维度按快照读取；事实按各自文档时点与接收截止核对。","checks":["effect_state<>'confirmed' OR (return_state='succeeded' AND effect_instance_id IS NOT NULL)"],"time_columns":[{"column":"received_at","role":"received"}],"default_filters":[]}
{"kind":"field","table":"syn_action_result","name":"result_id","type":"TEXT","nullable":false,"meaning":"回执观测主键。"}
{"kind":"field","table":"syn_action_result","name":"invocation_id","type":"TEXT","nullable":false,"meaning":"所属提交尝试。","references":{"table":"syn_action_invocation","column":"invocation_id"}}
{"kind":"field","table":"syn_action_result","name":"turn_id","type":"TEXT","nullable":false,"meaning":"所属轮次，须与提交一致。","references":{"table":"syn_voice_turn","column":"turn_id"}}
{"kind":"field","table":"syn_action_result","name":"operation_key","type":"TEXT","nullable":false,"meaning":"稳定逻辑操作身份，须与提交一致。"}
{"kind":"field","table":"syn_action_result","name":"observation_no","type":"INTEGER","nullable":false,"meaning":"同invocation的递增观测号。","minimum":1}
{"kind":"field","table":"syn_action_result","name":"observed_offset_ms","type":"INTEGER","nullable":false,"meaning":"相对轮次起点的观测时间。","unit":"ms","minimum":0}
{"kind":"field","table":"syn_action_result","name":"return_state","type":"TEXT","nullable":false,"meaning":"执行回执状态。","enum":["succeeded","failed","cancelled","unknown"]}
{"kind":"field","table":"syn_action_result","name":"effect_state","type":"TEXT","nullable":false,"meaning":"效果是否被确认，不能仅由接收成功推断。","enum":["confirmed","not_observed","unknown"]}
{"kind":"field","table":"syn_action_result","name":"effect_instance_id","type":"TEXT","nullable":true,"meaning":"已确认效果的合成实例号；重放沿同一号，未确认NULL。"}
{"kind":"field","table":"syn_action_result","name":"result_value","type":"TEXT","nullable":true,"meaning":"合成效果值，无明确效果NULL。"}
{"kind":"field","table":"syn_action_result","name":"result_unit","type":"TEXT","nullable":true,"meaning":"效果单位，无则NULL。"}
{"kind":"field","table":"syn_action_result","name":"error_code","type":"TEXT","nullable":true,"meaning":"模拟错误分类，正常NULL。"}
{"kind":"field","table":"syn_action_result","name":"replayed_receipt","type":"INTEGER","nullable":false,"meaning":"是否接回已知结果而非重复执行。","unit":"boolean","enum":[0,1]}
{"kind":"field","table":"syn_action_result","name":"server_elapsed_ms","type":"INTEGER","nullable":true,"meaning":"有明确回执时的服务处理时长；unknown可NULL。","unit":"ms","minimum":0}
{"kind":"field","table":"syn_action_result","name":"received_at","type":"TEXT","nullable":false,"meaning":"该规范记录进入快照的接收时间；received_at必须早于snapshot_exclusive才可用于快照统计。","unit":"UTC RFC3339 second"}
```
