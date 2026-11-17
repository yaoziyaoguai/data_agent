# 端云识别与候选选择

业务域：公开合成座舱语音交互。此文是人工制定的实验定义，待维护者核对，不代表任何真实厂商标准。

一次请求可以产生端侧、云侧和重试的多个识别尝试，每次尝试又可返回多个候选。候选排序、置信度、首个可用候选和最终被采用候选需要分别保留。最终文本不能按“最后收到一行”或“分数最高一行”自行重建，应采用明确选择关系和当时有效的配置。

从零编写的命令、参考文本和应答只提供可公开的合成场景。本包只定义合成参考文本的规范化逐字一致，归一化规则与有效样本范围必须明确。字面差异不等同意图错误；数字写法、空格或标点的变化也不应在未声明的情况下被自动忽略。

比较时延时区分请求总时延、单次识别尝试耗时和最终候选可用时刻。重试、排队和端云并行会使这些时间不同，不能把多条attempt耗时加起来当成用户等待时长。失败尝试后成功仍是发生过重试的成功请求。

本包只定义synthetic_exact_text规范化逐字一致：按Unicode码点处理；移除ASCII空格、全角空格、TAB、CR、LF及字符集合“。！？!?，,．.”；仅ASCII A–Z转为小写，其他字符不变。不把“二十二”转成“22”，不做同义词替换或语义等价判断，不计算CER/WER。

reference_text仅在人工合成标签子集存在，NULL表示没有标签。分母中的有标签eligible轮次即使没有最终预测也要保留，不能INNER JOIN成功候选后再计算一致率。采用selected_for_nlu=1的最终候选，不能把最高confidence、candidate_rank最小或最先返回一条擅自当成最终选择；同时报告标签覆盖率。

## `syn_asr_attempt` · ASR处理尝试

ASR尝试的succeeded是处理状态，不保证该快照内候选行数大于零；最终采用哪条文本见asr_hypothesis.selected_for_nlu。最终ASR尝试按同轮快照内最大attempt_no选择，再判断结果；不能先筛成功再取最后一条。失败重试次数不能替代用户输入量。

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

## 首末尝试与候选统计默认

固定快照内先按每个事实自身的收到时点和业务时点确定可见集合，再按同轮最小/最大attempt_no选择首次/最终尝试。最终ASR成功率以全部有可见ASR尝试的合格轮次为分母；本定义的最终尝试率、全部尝试成功率与NLU候选选择率是不同统计，不能互相替代。

首末两项以相同的“有可见ASR尝试的合格轮次”为总体。下列规范指标的time_basis条目连接[概览](overview.md)中的合成资料活动期和固定快照；已有用户条件和任务时间优先，不能用请求当前时刻补快照。

## `asr_first_attempt_success_rate` · ASR首次尝试成功率

分子是快照内首次ASR尝试outcome为succeeded的合格轮次数，分母是有可见ASR尝试的全部合格轮次数。首次取同轮最小attempt_no，处理成功不等于转写正确。单位为ratio，空分母返回NULL。SQL以:start/:end选择turn.started_at的UTC半开区间，:snapshot为排他观察截点；父事实及每份ASR尝试分别核自身可见性。

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
), visible_attempts AS (
    SELECT a.*
    FROM syn_asr_attempt a JOIN qualified_turns t ON t.turn_id = a.turn_id
    WHERE a.received_at < :snapshot
      AND CAST(strftime('%s', t.started_at) AS INTEGER) * 1000 + a.finish_offset_ms
          < CAST(strftime('%s', :snapshot) AS INTEGER) * 1000
), first_last AS (
    SELECT turn_id, MIN(attempt_no) AS first_no, MAX(attempt_no) AS last_no
    FROM visible_attempts GROUP BY turn_id
)
SELECT COALESCE(SUM(a.outcome = 'succeeded'), 0) AS numerator,
       COUNT(*) AS denominator,
       CAST(SUM(a.outcome = 'succeeded') AS REAL) / NULLIF(COUNT(*), 0) AS value
FROM first_last b
JOIN visible_attempts a ON a.turn_id = b.turn_id AND a.attempt_no = b.first_no;
```

## `asr_final_attempt_success_rate` · ASR最终尝试成功率

分子是快照内最终ASR尝试outcome为succeeded的合格轮次数，分母仍是有可见ASR尝试的全部合格轮次数。先取同轮最大attempt_no，再判断状态；最终失败、取消和超时保留在分母，不能先过滤成功记录。此分母也不能被候选JOIN缩小。单位为ratio，空分母返回NULL，处理成功不等于识别正确。

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
), visible_attempts AS (
    SELECT a.*
    FROM syn_asr_attempt a JOIN qualified_turns t ON t.turn_id = a.turn_id
    WHERE a.received_at < :snapshot
      AND CAST(strftime('%s', t.started_at) AS INTEGER) * 1000 + a.finish_offset_ms
          < CAST(strftime('%s', :snapshot) AS INTEGER) * 1000
), first_last AS (
    SELECT turn_id, MIN(attempt_no) AS first_no, MAX(attempt_no) AS last_no
    FROM visible_attempts GROUP BY turn_id
)
SELECT COALESCE(SUM(a.outcome = 'succeeded'), 0) AS numerator,
       COUNT(*) AS denominator,
       CAST(SUM(a.outcome = 'succeeded') AS REAL) / NULLIF(COUNT(*), 0) AS value
FROM first_last b
JOIN visible_attempts a ON a.turn_id = b.turn_id AND a.attempt_no = b.last_no;
```

```semantic-definitions
{"kind":"metric","id":"asr_first_attempt_success_rate","name":"ASR首次尝试成功率","aliases":["首次ASR成功率","ASR首次成功率","首次尝试成功率"],"tables":["syn_voice_turn","syn_voice_session","syn_vehicle","syn_asr_attempt"],"numerator":"快照内首次ASR尝试outcome为succeeded的合格轮次数","denominator":"有可见ASR尝试的全部合格轮次数","unit":"ratio","scope":"非实验且遥测授权车辆、有效完整会话和valid轮次；按turn.started_at选择UTC半开区间，事实按各自时点及received_at排他快照核对。","empty_or_zero_rule":"空分母返回NULL；没有首次成功轮次时分子为0。","limitations":"首次按最小attempt_no选择；处理成功不是转写正确，不能先筛成功或按候选行数计算。","description":"ASR首次尝试成功率：快照内按同轮最小attempt_no选首次，再以outcome=succeeded计分子；全部有可见ASR尝试的合格轮次计分母。非实验、遥测授权车辆，有效完整会话和valid轮次；按turn.started_at的UTC半开区间及各事实自身快照筛选。空分母返回NULL，处理成功不等于转写正确。"}
{"kind":"metric","id":"asr_final_attempt_success_rate","name":"ASR最终尝试成功率","aliases":["最终ASR成功率","ASR最终成功率","最终尝试成功率"],"tables":["syn_voice_turn","syn_voice_session","syn_vehicle","syn_asr_attempt"],"numerator":"快照内最终ASR尝试outcome为succeeded的合格轮次数","denominator":"有可见ASR尝试的全部合格轮次数","unit":"ratio","scope":"非实验且遥测授权车辆、有效完整会话和valid轮次；按turn.started_at选择UTC半开区间，事实按各自时点及received_at排他快照核对。","empty_or_zero_rule":"空分母返回NULL；有尝试但最终未成功的轮次保留分母且不计分子。","limitations":"先按最大attempt_no选最终再判断状态；最终失败/取消/超时保留分母，候选JOIN不能缩小总体。","description":"ASR最终尝试成功率：快照内先按同轮最大attempt_no选最终，再以outcome=succeeded计分子；全部有可见ASR尝试的合格轮次计分母，最终失败、取消和超时仍在分母。非实验、遥测授权车辆，有效完整会话和valid轮次；按turn.started_at的UTC半开区间及各事实自身快照筛选。空分母返回NULL，不按候选JOIN缩小总体；处理成功不等于识别正确。"}
```

## `asr_recovered_turn_rate` · ASR重试救回轮次占比

指标：ASR重试救回轮次占比。
分子：首次未成功、最终成功且存在后续尝试的去重轮次数。
分母：有ASR可见尝试的全部合格轮次数。
单位：ratio。
范围：非实验且遥测授权车辆、有效完整会话和valid轮次；按turn.started_at的UTC半开区间，父事实、ASR尝试和候选分别按自身快照可见性筛选。
空值与零：分母为0时比例返回NULL；没有匹配救回轮次时分子为0。
限制：首末按快照内最小/最大attempt_no；首次即回退成功不并入救回分子。有回退或有重试本身不等于被救回；另有需要时再说明首次回退成功，不额外增加未请求指标。

以下参数化SQL使用:start、:end、:snapshot，不包含数据预期值。

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
), visible_attempts AS (
    SELECT a.*
    FROM syn_asr_attempt a JOIN qualified_turns t ON t.turn_id = a.turn_id
    WHERE a.received_at < :snapshot
      AND CAST(strftime('%s', t.started_at) AS INTEGER) * 1000 + a.finish_offset_ms
          < CAST(strftime('%s', :snapshot) AS INTEGER) * 1000
), first_last AS (
    SELECT turn_id, MIN(attempt_no) AS first_no, MAX(attempt_no) AS last_no
    FROM visible_attempts GROUP BY turn_id
), observed AS (
    SELECT b.turn_id,
           CASE WHEN f.outcome <> 'succeeded' AND l.outcome = 'succeeded'
                     AND b.last_no > b.first_no THEN 1 ELSE 0 END AS recovered
    FROM first_last b
    JOIN visible_attempts f ON f.turn_id = b.turn_id AND f.attempt_no = b.first_no
    JOIN visible_attempts l ON l.turn_id = b.turn_id AND l.attempt_no = b.last_no
)
SELECT COALESCE(SUM(recovered), 0) AS recovered_turns,
       COUNT(*) AS attempted_turns,
       CAST(SUM(recovered) AS REAL) / NULLIF(COUNT(*), 0) AS recovered_turn_rate
FROM observed;
```

## `final_successful_attempt_candidate_mean` · 最终成功ASR尝试平均候选数

指标：最终成功ASR尝试平均候选数。
分子：最终成功尝试在快照内可见的hypothesis_id行数合计。
分母：最终尝试outcome为succeeded的合格轮次数。
单位：candidate/attempt。
范围：非实验且遥测授权车辆、有效完整会话和valid轮次；按turn.started_at的UTC半开区间，父事实、ASR尝试和候选分别按自身快照可见性筛选。
空值与零：成功但没有可见候选行计0，保留在平均分母；没有最终成功尝试时均值为NULL。
限制：先在全部可见尝试中选最终，再筛succeeded。最终失败/取消/超时不进入候选平均总体；候选计数不按selected_for_nlu筛选，不用partial_result_count替代。ASR最终成功率仍以全部有可见尝试的合格轮次为分母，不能被候选JOIN缩小。

以下参数化SQL使用:start、:end、:snapshot，不包含数据预期值。

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
), visible_attempts AS (
    SELECT a.*
    FROM syn_asr_attempt a JOIN qualified_turns t ON t.turn_id = a.turn_id
    WHERE a.received_at < :snapshot
      AND CAST(strftime('%s', t.started_at) AS INTEGER) * 1000 + a.finish_offset_ms
          < CAST(strftime('%s', :snapshot) AS INTEGER) * 1000
), last_attempts AS (
    SELECT turn_id, MAX(attempt_no) AS last_no
    FROM visible_attempts GROUP BY turn_id
), final_attempts AS (
    SELECT a.* FROM visible_attempts a
    JOIN last_attempts l ON l.turn_id = a.turn_id AND l.last_no = a.attempt_no
), candidate_counts AS (
    SELECT h.asr_attempt_id, COUNT(h.hypothesis_id) AS candidates
    FROM syn_asr_hypothesis h
    JOIN final_attempts a ON a.asr_attempt_id = h.asr_attempt_id
    WHERE a.outcome = 'succeeded' AND h.received_at < :snapshot
    GROUP BY h.asr_attempt_id
)
SELECT COUNT(*) AS successful_final_attempts,
       COALESCE(SUM(COALESCE(h.candidates, 0)), 0) AS final_successful_candidates,
       CAST(SUM(COALESCE(h.candidates, 0)) AS REAL) / NULLIF(COUNT(*), 0) AS mean_candidates
FROM final_attempts a
LEFT JOIN candidate_counts h ON h.asr_attempt_id = a.asr_attempt_id
WHERE a.outcome = 'succeeded';
```

```semantic-definitions
{"kind":"metric","id":"asr_recovered_turn_rate","name":"ASR重试救回轮次占比","aliases":["重试救回占比","ASR救回率"],"tables":["syn_voice_turn","syn_voice_session","syn_vehicle","syn_asr_attempt"],"numerator":"首次未成功、最终成功且存在后续尝试的去重轮次数","denominator":"有ASR可见尝试的全部合格轮次数","unit":"ratio","scope":"非实验且遥测授权车辆、有效完整会话和valid轮次；按turn.started_at的UTC半开区间，父事实、ASR尝试和候选分别按自身快照可见性筛选。","empty_or_zero_rule":"分母为0时比例返回NULL；没有匹配救回轮次时分子为0。","limitations":"首末按快照内最小/最大attempt_no；首次即回退成功不并入救回分子。有回退或有重试本身不等于被救回；另有需要时再说明首次回退成功，不额外增加未请求指标。","sql":"WITH qualified_turns AS (\n    SELECT t.turn_id, t.started_at\n    FROM syn_voice_turn t\n    JOIN syn_voice_session s ON s.session_id = t.session_id\n    JOIN syn_vehicle v ON v.vehicle_id = s.vehicle_id\n    WHERE v.is_lab_unit = 0 AND v.telemetry_consent = 1\n      AND s.quality_state = 'valid' AND s.is_complete = 1\n      AND t.quality_state = 'valid'\n      AND t.started_at >= :start AND t.started_at < :end\n      AND s.started_at < :snapshot AND s.ended_at < :snapshot\n      AND t.finished_at < :snapshot\n      AND t.received_at < :snapshot AND s.received_at < :snapshot\n), visible_attempts AS (\n    SELECT a.*\n    FROM syn_asr_attempt a JOIN qualified_turns t ON t.turn_id = a.turn_id\n    WHERE a.received_at < :snapshot\n      AND CAST(strftime('%s', t.started_at) AS INTEGER) * 1000 + a.finish_offset_ms\n          < CAST(strftime('%s', :snapshot) AS INTEGER) * 1000\n), first_last AS (\n    SELECT turn_id, MIN(attempt_no) AS first_no, MAX(attempt_no) AS last_no\n    FROM visible_attempts GROUP BY turn_id\n), observed AS (\n    SELECT b.turn_id,\n           CASE WHEN f.outcome <> 'succeeded' AND l.outcome = 'succeeded'\n                     AND b.last_no > b.first_no THEN 1 ELSE 0 END AS recovered\n    FROM first_last b\n    JOIN visible_attempts f ON f.turn_id = b.turn_id AND f.attempt_no = b.first_no\n    JOIN visible_attempts l ON l.turn_id = b.turn_id AND l.attempt_no = b.last_no\n)\nSELECT COALESCE(SUM(recovered), 0) AS recovered_turns,\n       COUNT(*) AS attempted_turns,\n       CAST(SUM(recovered) AS REAL) / NULLIF(COUNT(*), 0) AS recovered_turn_rate\nFROM observed;","description":"指标：ASR重试救回轮次占比。\n分子：首次未成功、最终成功且存在后续尝试的去重轮次数。\n分母：有ASR可见尝试的全部合格轮次数。\n单位：ratio。\n范围：非实验且遥测授权车辆、有效完整会话和valid轮次；按turn.started_at的UTC半开区间，父事实、ASR尝试和候选分别按自身快照可见性筛选。\n空值与零：分母为0时比例返回NULL；没有匹配救回轮次时分子为0。\n限制：首末按快照内最小/最大attempt_no；首次即回退成功不并入救回分子。有回退或有重试本身不等于被救回；另有需要时再说明首次回退成功，不额外增加未请求指标。"}
{"kind":"metric","id":"final_successful_attempt_candidate_mean","name":"最终成功ASR尝试平均候选数","aliases":["平均候选数","最终成功平均候选数"],"tables":["syn_voice_turn","syn_voice_session","syn_vehicle","syn_asr_attempt","syn_asr_hypothesis"],"numerator":"最终成功尝试在快照内可见的hypothesis_id行数合计","denominator":"最终尝试outcome为succeeded的合格轮次数","unit":"candidate/attempt","scope":"非实验且遥测授权车辆、有效完整会话和valid轮次；按turn.started_at的UTC半开区间，父事实、ASR尝试和候选分别按自身快照可见性筛选。","empty_or_zero_rule":"成功但没有可见候选行计0，保留在平均分母；没有最终成功尝试时均值为NULL。","limitations":"先在全部可见尝试中选最终，再筛succeeded。最终失败/取消/超时不进入候选平均总体；候选计数不按selected_for_nlu筛选，不用partial_result_count替代。ASR最终成功率仍以全部有可见尝试的合格轮次为分母，不能被候选JOIN缩小。","sql":"WITH qualified_turns AS (\n    SELECT t.turn_id, t.started_at\n    FROM syn_voice_turn t\n    JOIN syn_voice_session s ON s.session_id = t.session_id\n    JOIN syn_vehicle v ON v.vehicle_id = s.vehicle_id\n    WHERE v.is_lab_unit = 0 AND v.telemetry_consent = 1\n      AND s.quality_state = 'valid' AND s.is_complete = 1\n      AND t.quality_state = 'valid'\n      AND t.started_at >= :start AND t.started_at < :end\n      AND s.started_at < :snapshot AND s.ended_at < :snapshot\n      AND t.finished_at < :snapshot\n      AND t.received_at < :snapshot AND s.received_at < :snapshot\n), visible_attempts AS (\n    SELECT a.*\n    FROM syn_asr_attempt a JOIN qualified_turns t ON t.turn_id = a.turn_id\n    WHERE a.received_at < :snapshot\n      AND CAST(strftime('%s', t.started_at) AS INTEGER) * 1000 + a.finish_offset_ms\n          < CAST(strftime('%s', :snapshot) AS INTEGER) * 1000\n), last_attempts AS (\n    SELECT turn_id, MAX(attempt_no) AS last_no\n    FROM visible_attempts GROUP BY turn_id\n), final_attempts AS (\n    SELECT a.* FROM visible_attempts a\n    JOIN last_attempts l ON l.turn_id = a.turn_id AND l.last_no = a.attempt_no\n), candidate_counts AS (\n    SELECT h.asr_attempt_id, COUNT(h.hypothesis_id) AS candidates\n    FROM syn_asr_hypothesis h\n    JOIN final_attempts a ON a.asr_attempt_id = h.asr_attempt_id\n    WHERE a.outcome = 'succeeded' AND h.received_at < :snapshot\n    GROUP BY h.asr_attempt_id\n)\nSELECT COUNT(*) AS successful_final_attempts,\n       COALESCE(SUM(COALESCE(h.candidates, 0)), 0) AS final_successful_candidates,\n       CAST(SUM(COALESCE(h.candidates, 0)) AS REAL) / NULLIF(COUNT(*), 0) AS mean_candidates\nFROM final_attempts a\nLEFT JOIN candidate_counts h ON h.asr_attempt_id = a.asr_attempt_id\nWHERE a.outcome = 'succeeded';","description":"指标：最终成功ASR尝试平均候选数。\n分子：最终成功尝试在快照内可见的hypothesis_id行数合计。\n分母：最终尝试outcome为succeeded的合格轮次数。\n单位：candidate/attempt。\n范围：非实验且遥测授权车辆、有效完整会话和valid轮次；按turn.started_at的UTC半开区间，父事实、ASR尝试和候选分别按自身快照可见性筛选。\n空值与零：成功但没有可见候选行计0，保留在平均分母；没有最终成功尝试时均值为NULL。\n限制：先在全部可见尝试中选最终，再筛succeeded。最终失败/取消/超时不进入候选平均总体；候选计数不按selected_for_nlu筛选，不用partial_result_count替代。ASR最终成功率仍以全部有可见尝试的合格轮次为分母，不能被候选JOIN缩小。"}
```

## 可机读定义

以下记录是上文的明确结构定义，目录生成器只复用这些定义并与实际DDL核对；没有种子安排或用例预期值。

```semantic-definitions
{"kind":"table","table":"syn_asr_attempt","label":"ASR处理尝试","grain":"一轮输入的一次端侧或云侧识别尝试","primary_key":["asr_attempt_id"],"unique_keys":[["turn_id","attempt_no"]],"description":"ASR尝试的succeeded是处理状态，不保证该快照内候选行数大于零；最终采用哪条文本见asr_hypothesis.selected_for_nlu。最终ASR尝试按同轮快照内最大attempt_no选择，再判断结果；不能先筛成功再取最后一条。失败重试次数不能替代用户输入量。","time_basis":"维度按快照读取；事实按各自文档时点与接收截止核对。","checks":["finish_offset_ms >= start_offset_ms","wall_ms=finish_offset_ms-start_offset_ms","queued_ms<=wall_ms"],"time_columns":[{"column":"received_at","role":"received"}],"default_filters":[]}
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
