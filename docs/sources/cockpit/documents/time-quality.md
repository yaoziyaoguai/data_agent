# 时间、质量与快照

业务域：公开合成座舱语音交互。此文是人工制定的实验定义，待维护者核对，不代表任何真实厂商标准。

业务时刻、收到时刻和采样时刻用于不同问题。默认观察按规范定义的会话或请求队列选择半开区间；分析事件发生日时必须明确改用对应业务时间。跨午夜请求不能被收到日期或日志归档分区悄悄改标。

快照只采用当时已发生且已收到的事实。晚到记录可以用于独立质量诊断，但不能混入该快照的业务分子、分母。参与存在性、反存在性、计数或聚合的每份子事实都按自身received_at和适用业务时点裁剪，先过滤再做MAX、EXISTS或JOIN；父轮次在快照内不保证TTS、播放或前端记录也在快照内。维表不机械套用它没有的received_at。日汇总用其snapshot_exclusive核对派生版本；非整日范围或另一快照应回到原始事实，不能把同一天的汇总简单裁成小时值。

短操作的精确耗时来自单调时钟毫秒值，UTC时间字符串负责定位。缺失耗时表示没有可靠测量，不是零耗时。重复记录、重试和多个合法候选需要按各自主键及语义判断；发现相同请求ID下有多行并不能直接认定数据重复。

来源不足、记录未完成、字段不适用、收到时间超出快照和被质量规则排除应分别说明。不得把空结果当作故障不存在，也不能把部分保存的结果当成总体。

本包turn.started_at合成锚点与整秒对齐，所有*_offset_ms相对该锚点；received_at生成在该事实完成之后至少一秒。子事实可独立晚到，不保证各阶段的收到顺序等于业务顺序。普通体验指标限定非实验且授权车辆、有效完整session和valid轮次。唤醒入口可能被拒绝而没有session，入口指标按自身started_at及质量/车辆资格计算，不能强行INNER JOIN完整session。

日表syn_daily_voice_experience的activity_date并列保存三种日期队列：session_count按session.started_at日，wake计数按wakeup.started_at日，turn计数按turn.started_at日。拒绝唤醒的build来自该wake自身冻结值。跨午夜时同日turn/wake之比不是同批请求漏斗；活跃语音车辆必须有有效turn，不能把wake-only或session-only行纳入。syn_daily_stage_latency与syn_daily_intent_outcome按turn日归属。

## 省略年份时的分析范围

未另指定年份时，优先沿用本任务已经确定的年份；任务尚未确定时，只能在相关且已获准读取的资料能唯一确定分析年份时采用，并说明依据。仍有多个可能年份就保留一个该问题等待选择。不能从系统当前年、题号或某条无关样例补年；用户改了目标或产生新冲突时重新核对，已经回答且未改变的问题不重复提问。

本套资料的活动期和固定排他快照以[概览](overview.md)的“合成数据范围与固定快照”段为准；指标的time_basis条目从该段派生，不另维护日期默认。分析月份、观察快照和请求时刻各有职责。缺省且资料适用时可采用该事实依据，不能把未写快照理解成请求的当前时刻；实际采用的值及来源须保存到任务条件。

## 子事实存在性按自身快照核对

下面按合格轮次检查“没有可见TTS”，只说明固定观察边界内的存在性，不把缺TTS直接判为执行失败。参数:start/:end是UTC半开区间，:snapshot是排他快照。

```sql
WITH qualified_turns AS (
    SELECT t.turn_id, t.started_at
    FROM syn_voice_turn t
    JOIN syn_voice_session s ON s.session_id = t.session_id
    JOIN syn_vehicle v ON v.vehicle_id = s.vehicle_id
    WHERE v.is_lab_unit = 0 AND v.telemetry_consent = 1
      AND s.quality_state = 'valid' AND s.is_complete = 1
      AND t.quality_state = 'valid'
      AND t.started_at >= :start AND t.started_at < :end
      AND s.started_at < :snapshot AND s.ended_at < :snapshot
      AND t.finished_at < :snapshot
      AND t.received_at < :snapshot AND s.received_at < :snapshot
), visible_tts AS (
    SELECT r.turn_id
    FROM syn_tts_request r JOIN qualified_turns t ON t.turn_id = r.turn_id
    WHERE r.received_at < :snapshot
      AND CAST(strftime('%s', t.started_at) AS INTEGER) * 1000 + r.finish_offset_ms
          < CAST(strftime('%s', :snapshot) AS INTEGER) * 1000
)
SELECT COUNT(*) AS turns_without_visible_tts
FROM qualified_turns t
WHERE NOT EXISTS (SELECT 1 FROM visible_tts r WHERE r.turn_id = t.turn_id);
```

## 真实零、缺行与缺测分别解释

聚合得到的0不能独自证明真实零。结合来源的实际覆盖窗口、完整性约定或有意义的记录存在性判断：有完整稀疏汇总合同的缺行可以合法表示零，缺行本身也不能自动判为漏采；范围超出覆盖或覆盖未知时保留缺口。耗时必须同时说明有效测量样本，无测量样本的均值为NULL，不能用0毫秒或0%代替。合法跳阶段、没有记录、处理失败和没有测量是不同状态。

以下日汇总诊断保留行存在性及测量样本；是否构成真实零仍取决于上述覆盖依据，不给所有查询强加行数门槛。参数须为UTC整日边界，非整日回到原始事实。

```sql
SELECT COUNT(*) AS summary_rows,
       COALESCE(SUM(attempt_count), 0) AS observed_attempts,
       SUM(latency_samples) AS measured_samples,
       CAST(SUM(latency_sum_ms) AS REAL) / NULLIF(SUM(latency_samples), 0) AS mean_ms
FROM syn_daily_stage_latency
WHERE stage = :stage AND snapshot_exclusive = :snapshot
  AND turn_date >= substr(:start, 1, 10) AND turn_date < substr(:end, 1, 10)
HAVING :start = substr(:start, 1, 10) || 'T00:00:00Z'
   AND :end = substr(:end, 1, 10) || 'T00:00:00Z'
   AND :start < :end;
```

### 日表键域与零轮次核对

本包syn_daily_voice_experience是稀疏日表：ETL的键来自合格turn、合格session和合格wakeup的UTC活动日/车辆/冻结build并集。合格且未接受的sessionless wake会产生`wakeup_attempt_count`大于0、`turn_count`等于0的合法行；session-only也可有零轮次。只用turn生成fact_days会把这些行丢掉。三类队列的业务日期各自归属，不能用turn日期替代wake或session的日期。

以下SQL对请求范围返回一行核对结果：保留三类原事实键域，以及日表行数、零值和测量样本。summary_rows为0时日表SUM保留NULL，有日表且轮次合计为0时返回0；两者不能混同。observed_keys描述当前可见原事实，不是采集完整性证明。日表必须与:snapshot一致，UTC整日范围才可比较；另一快照或非整日范围回到原始事实，不能把不匹配解释为零或直接判漏采。

```sql
WITH valid_sessions AS (
    SELECT s.* FROM syn_voice_session s
    JOIN syn_vehicle v ON v.vehicle_id = s.vehicle_id
    WHERE v.is_lab_unit = 0 AND v.telemetry_consent = 1
      AND s.quality_state = 'valid' AND s.is_complete = 1
      AND s.started_at < :snapshot AND s.ended_at < :snapshot
      AND s.received_at < :snapshot
), qualified_turns AS (
    SELECT t.*, s.vehicle_id, s.build_id
    FROM syn_voice_turn t JOIN valid_sessions s ON s.session_id = t.session_id
    WHERE t.quality_state = 'valid'
      AND t.started_at >= :start AND t.started_at < :end
      AND t.finished_at < :snapshot AND t.received_at < :snapshot
), visible_wakes AS (
    SELECT w.* FROM syn_wakeup_attempt w
    JOIN syn_vehicle v ON v.vehicle_id = w.vehicle_id
    WHERE v.is_lab_unit = 0 AND v.telemetry_consent = 1
      AND w.quality_state = 'valid'
      AND w.started_at >= :start AND w.started_at < :end
      AND w.started_at < :snapshot AND w.received_at < :snapshot
), observed_keys AS (
    SELECT substr(started_at, 1, 10) AS activity_date, vehicle_id, build_id FROM qualified_turns
    UNION SELECT substr(started_at, 1, 10), vehicle_id, build_id FROM visible_wakes
    UNION SELECT substr(started_at, 1, 10), vehicle_id, build_id FROM valid_sessions
          WHERE started_at >= :start AND started_at < :end
), daily_rows AS (
    SELECT d.* FROM syn_daily_voice_experience d
    JOIN syn_vehicle v ON v.vehicle_id = d.vehicle_id
    WHERE v.is_lab_unit = 0 AND v.telemetry_consent = 1
      AND d.snapshot_exclusive = :snapshot
      AND d.activity_date >= substr(:start, 1, 10) AND d.activity_date < substr(:end, 1, 10)
)
SELECT (SELECT COUNT(*) FROM observed_keys) AS observed_keys,
       COUNT(*) AS summary_rows,
       (SELECT COUNT(*) FROM qualified_turns) AS observed_turns,
       (SELECT COUNT(*) FROM visible_wakes) AS observed_wakes,
       SUM(turn_count) AS summarized_turns,
       SUM(wakeup_attempt_count) AS summarized_wakes,
       SUM(completed_latency_samples) AS measured_samples,
       CAST(SUM(completed_latency_sum_ms) AS REAL) / NULLIF(SUM(completed_latency_samples), 0) AS mean_task_ms
FROM daily_rows
HAVING :start = substr(:start, 1, 10) || 'T00:00:00Z'
   AND :end = substr(:end, 1, 10) || 'T00:00:00Z'
   AND :start < :end;
```

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
| `locale` | TEXT / NOT NULL | — | 会话locale，不保证等于各轮次locale；轮次语言字段默认见多轮文档，不能用本列自动替换。 允许值：zh-CN, en-US。 |
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
{"kind":"field","table":"syn_voice_session","name":"locale","type":"TEXT","nullable":false,"meaning":"会话locale，不保证等于各轮次locale；轮次语言字段默认见多轮文档，不能用本列自动替换。","enum":["zh-CN","en-US"]}
{"kind":"field","table":"syn_voice_session","name":"seat_zone","type":"TEXT","nullable":false,"meaning":"主要发起音区。","enum":["driver","front_passenger","rear"]}
{"kind":"field","table":"syn_voice_session","name":"motion_state","type":"TEXT","nullable":false,"meaning":"当时行驶状态分类。","enum":["parked","moving"]}
{"kind":"field","table":"syn_voice_session","name":"network_at_start","type":"TEXT","nullable":false,"meaning":"起点网络状态，不代替后续网络观测。","enum":["online","offline"]}
{"kind":"field","table":"syn_voice_session","name":"end_reason","type":"TEXT","nullable":false,"meaning":"会话结束原因。","enum":["idle","user_cancel","session_timeout","system_end"]}
{"kind":"field","table":"syn_voice_session","name":"is_complete","type":"INTEGER","nullable":false,"meaning":"是否收到完整会话尾记录。","unit":"boolean","enum":[0,1]}
{"kind":"field","table":"syn_voice_session","name":"received_at","type":"TEXT","nullable":false,"meaning":"该规范记录进入快照的接收时间；received_at必须早于snapshot_exclusive才可用于快照统计。","unit":"UTC RFC3339 second"}
{"kind":"field","table":"syn_voice_session","name":"quality_state","type":"TEXT","nullable":false,"meaning":"记录质量；默认指标仅采用valid，invalid保留用于质量排查。","enum":["valid","invalid"]}
```
