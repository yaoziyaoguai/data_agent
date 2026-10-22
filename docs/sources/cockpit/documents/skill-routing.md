# 能力与技能路由

业务域：公开合成座舱语音交互。此文是人工制定的实验定义，待维护者核对，不代表任何真实厂商标准。

syn_skill_route把某条NLU结果交给目标能力。outcome区分selected、rejected与failed，is_final_route标记最终路由；找到入口不表示动作已经完成。route_kind记录local、cloud或fallback，不能仅凭某条记录更早返回就认定它是最终选择。

导航、媒体、空调和座舱设置只是本包的目标能力。每条路由关联实际nlu_attempt_id、intent_id和capability_id；执行尝试再通过route_id引用它。统计时区分路由尝试数、去重轮次数和逻辑动作数，避免把多次尝试当成多个用户目标。

运行策略的endpoint_preference只约束ASR/NLU选择，不改变目标动作服务所在位置。比较回退效果时使用相同轮次总体，再查看最终状态与耗时；只比较成功回退样本会产生选择偏差。没有实验分配时，路径差异只支持相关性描述。



## `syn_skill_route` · 能力路由尝试

路由selected只说明找到处理入口，不表示动作执行或效果确认。

- 行粒度：一轮理解结果的一次技能路由
- 主键：`route_id`
- 唯一键：(turn_id, attempt_no)
- 时间口径：维度按快照读取；事实按各自文档时点与接收截止核对。

| 字段 | SQLite 类型 / 空值 | 单位 | 含义与限定 |
| --- | --- | --- | --- |
| `route_id` | TEXT / NOT NULL | — | 路由尝试主键。 |
| `turn_id` | TEXT / NOT NULL | — | 所属轮次。 引用`syn_voice_turn.turn_id`。 |
| `nlu_attempt_id` | TEXT / NOT NULL | — | 依据的NLU结果。 引用`syn_nlu_attempt.nlu_attempt_id`。 |
| `attempt_no` | INTEGER / NOT NULL | — | 同轮路由尝试顺序。 下界：1。 |
| `capability_id` | TEXT / NOT NULL | — | 拟采用能力组。 引用`syn_voice_capability.capability_id`。 |
| `intent_id` | TEXT / NOT NULL | — | 拟执行意图。 引用`syn_intent_catalog.intent_id`。 |
| `skill_code` | TEXT / NOT NULL | — | 虚构技能实现编码，不是实际产品服务名。 |
| `route_kind` | TEXT / NOT NULL | — | 本地、云端或回退路由。 允许值：local, cloud, fallback。 |
| `start_offset_ms` | INTEGER / NOT NULL | ms | 路由开始偏移。 下界：0。 |
| `finish_offset_ms` | INTEGER / NOT NULL | ms | 结束偏移。 下界：0。 |
| `wall_ms` | INTEGER / NOT NULL | ms | 路由耗时。 下界：0。 |
| `outcome` | TEXT / NOT NULL | — | 路由结果。 允许值：selected, rejected, failed。 |
| `is_final_route` | INTEGER / NOT NULL | boolean | 同轮至多一个最终选中的路由。 允许值：0, 1。 |
| `reject_reason` | TEXT / NOT NULL | — | 拒绝原因；未拒绝为none。 允许值：none, unsupported, missing_slot, policy, unavailable。 |
| `received_at` | TEXT / NOT NULL | UTC RFC3339 second | 该规范记录进入快照的接收时间；received_at必须早于snapshot_exclusive才可用于快照统计。 |

约束：

- `finish_offset_ms >= start_offset_ms`
- `wall_ms=finish_offset_ms-start_offset_ms`

## 可机读定义

以下记录是上文的明确结构定义，目录生成器只复用这些定义并与实际DDL核对；没有种子安排或用例预期值。

```semantic-definitions
{"kind":"table","table":"syn_skill_route","label":"能力路由尝试","grain":"一轮理解结果的一次技能路由","primary_key":["route_id"],"unique_keys":[["turn_id","attempt_no"]],"description":"路由selected只说明找到处理入口，不表示动作执行或效果确认。","time_basis":"维度按快照读取；事实按各自文档时点与接收截止核对。","checks":["finish_offset_ms >= start_offset_ms","wall_ms=finish_offset_ms-start_offset_ms"],"time_columns":[{"column":"received_at","role":"received"}],"default_filters":[]}
{"kind":"field","table":"syn_skill_route","name":"route_id","type":"TEXT","nullable":false,"meaning":"路由尝试主键。"}
{"kind":"field","table":"syn_skill_route","name":"turn_id","type":"TEXT","nullable":false,"meaning":"所属轮次。","references":{"table":"syn_voice_turn","column":"turn_id"}}
{"kind":"field","table":"syn_skill_route","name":"nlu_attempt_id","type":"TEXT","nullable":false,"meaning":"依据的NLU结果。","references":{"table":"syn_nlu_attempt","column":"nlu_attempt_id"}}
{"kind":"field","table":"syn_skill_route","name":"attempt_no","type":"INTEGER","nullable":false,"meaning":"同轮路由尝试顺序。","minimum":1}
{"kind":"field","table":"syn_skill_route","name":"capability_id","type":"TEXT","nullable":false,"meaning":"拟采用能力组。","references":{"table":"syn_voice_capability","column":"capability_id"}}
{"kind":"field","table":"syn_skill_route","name":"intent_id","type":"TEXT","nullable":false,"meaning":"拟执行意图。","references":{"table":"syn_intent_catalog","column":"intent_id"}}
{"kind":"field","table":"syn_skill_route","name":"skill_code","type":"TEXT","nullable":false,"meaning":"虚构技能实现编码，不是实际产品服务名。"}
{"kind":"field","table":"syn_skill_route","name":"route_kind","type":"TEXT","nullable":false,"meaning":"本地、云端或回退路由。","enum":["local","cloud","fallback"]}
{"kind":"field","table":"syn_skill_route","name":"start_offset_ms","type":"INTEGER","nullable":false,"meaning":"路由开始偏移。","unit":"ms","minimum":0}
{"kind":"field","table":"syn_skill_route","name":"finish_offset_ms","type":"INTEGER","nullable":false,"meaning":"结束偏移。","unit":"ms","minimum":0}
{"kind":"field","table":"syn_skill_route","name":"wall_ms","type":"INTEGER","nullable":false,"meaning":"路由耗时。","unit":"ms","minimum":0}
{"kind":"field","table":"syn_skill_route","name":"outcome","type":"TEXT","nullable":false,"meaning":"路由结果。","enum":["selected","rejected","failed"]}
{"kind":"field","table":"syn_skill_route","name":"is_final_route","type":"INTEGER","nullable":false,"meaning":"同轮至多一个最终选中的路由。","unit":"boolean","enum":[0,1]}
{"kind":"field","table":"syn_skill_route","name":"reject_reason","type":"TEXT","nullable":false,"meaning":"拒绝原因；未拒绝为none。","enum":["none","unsupported","missing_slot","policy","unavailable"]}
{"kind":"field","table":"syn_skill_route","name":"received_at","type":"TEXT","nullable":false,"meaning":"该规范记录进入快照的接收时间；received_at必须早于snapshot_exclusive才可用于快照统计。","unit":"UTC RFC3339 second"}
```
