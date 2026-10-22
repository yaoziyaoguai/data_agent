# 指标公式与分析口径

业务域：公开合成座舱语音交互。此文是人工制定的实验定义，待维护者核对，不代表任何真实厂商标准。

先固定分析问题、粒度、时间队列、资格范围、最终状态和单位，再选择表与SQL。一个完整语音链路会有一对多的候选、槽位、阶段尝试、动作回执和播放片段；应先各自聚合到请求或目标粒度再关联，不能直接把所有事实连起来求和。

比例必须保留分子和分母，汇总时按实际分母加权。均值应采用总量除以样本数，P95按本包定义的原始非空样本和最近秩位置计算，不能对分组P95求平均。分母为零时返回NULL；无记录、零次成功和没有测量是不同情况。

阶段漏斗要说明同一批入口请求在每一步的可见状态。条件分支不一定经过全部阶段；端侧快捷路径或用户取消可以合法跳过环节，不能将所有缺失下游行当作技术失败。某阶段attempt成功也不等同请求最终成功。

趋势和分组差异只能支持记录范围内的比较。版本、网络、语言、入口、座位和命令类别往往同时变化，未提供实验设计时只能提出待验证解释。正文中的差值、占比和耗时换算应来自实际SQL或同范围受控统计，派生计算应保留可复算的公式、分母与单位。

下面SQL是公开口径范式，不含任何本次数据的预期数值。参数:start、:end为UTC半开区间，:snapshot必须与所用快照一致。使用日表的范式要求start/end均为UTC整日边界；小时或任意局部时间范围应回到原始轮次事实。比例原值为0–1，若展示百分比，在SQL里显式乘以100并声明单位。

ASR/意图的一致率只在人工标签子集有定义，且缺预测仍留分母；覆盖率单独报告。动作确认率以operation去重；阶段率以attempt计数；播报率以片段计数。这些比例的分母不同，不能相互替代或直接串成一个全链路成功率。

## `syn_daily_voice_experience` · 语音交互日体验汇总

不同事实分别按所属轮次或独立入口日期聚合，不能将attempt/候选/槽位直接联接后重复SUM。轮次跨午夜按本轮开始日，阶段后续日期不能改归属。

- 行粒度：一个UTC活动日、车辆及各事实冻结build的并列计数
- 主键：`activity_date`, `vehicle_id`, `build_id`
- 唯一键：除主键外未额外声明
- 时间口径：activity_date按各指标明确的起点；轮次及阶段按turn.started_at日期。

| 字段 | SQLite 类型 / 空值 | 单位 | 含义与限定 |
| --- | --- | --- | --- |
| `activity_date` | TEXT / NOT NULL | UTC date | UTC活动日期：轮次按started_at；唤醒按自身started_at；会话数按session.started_at。 |
| `vehicle_id` | TEXT / NOT NULL | — | 车辆维度。 引用`syn_vehicle.vehicle_id`。 |
| `build_id` | TEXT / NOT NULL | — | 事件当时冻结build。 引用`syn_software_build.build_id`。 |
| `session_count` | INTEGER / NOT NULL | count | 当日开始的有效完整语音会话数。 下界：0。 |
| `wakeup_attempt_count` | INTEGER / NOT NULL | count | 当日可见valid入口尝试数。 下界：0。 |
| `wakeup_accepted_count` | INTEGER / NOT NULL | count | 被接受的入口数。 下界：0。 |
| `wakeup_labeled_count` | INTEGER / NOT NULL | count | 有人工有效唤醒标签的尝试数。 下界：0。 |
| `wakeup_false_accept_count` | INTEGER / NOT NULL | count | 标签为非有效唤醒但被接受的次数。 下界：0。 |
| `turn_count` | INTEGER / NOT NULL | count | 当日开始的有效轮次数。 下界：0。 |
| `eligible_turn_count` | INTEGER / NOT NULL | count | completed/clarification_pending/rejected/failed/unknown轮次数。 下界：0。 |
| `task_completed_count` | INTEGER / NOT NULL | count | final_outcome=completed的轮次数，不代表标签正确或满意。 下界：0。 |
| `clarification_count` | INTEGER / NOT NULL | count | final_outcome=clarification_pending的轮次数。 下界：0。 |
| `failed_turn_count` | INTEGER / NOT NULL | count | final_outcome=failed次数。 下界：0。 |
| `unknown_turn_count` | INTEGER / NOT NULL | count | final_outcome=unknown次数。 下界：0。 |
| `cancelled_turn_count` | INTEGER / NOT NULL | count | cancelled次数，排除eligible。 下界：0。 |
| `no_speech_turn_count` | INTEGER / NOT NULL | count | no_speech次数，排除eligible。 下界：0。 |
| `rejected_turn_count` | INTEGER / NOT NULL | count | rejected次数，进入eligible。 下界：0。 |
| `completed_latency_sum_ms` | INTEGER / NOT NULL | ms | completed轮次task_latency_ms合计。 下界：0。 |
| `completed_latency_samples` | INTEGER / NOT NULL | count | completed且任务时延非空的样本数。 下界：0。 |
| `first_audio_latency_sum_ms` | INTEGER / NOT NULL | ms | 实际有首音的非空时延合计。 下界：0。 |
| `first_audio_samples` | INTEGER / NOT NULL | count | 实际有首音的样本数，不等于completed数。 下界：0。 |
| `asr_labeled_turn_count` | INTEGER / NOT NULL | count | eligible且reference_text非空的轮次数，含无预测的失败轮。 下界：0。 |
| `asr_exact_match_count` | INTEGER / NOT NULL | count | 上述标签轮中最终选中归一化文本与参考归一化完全一致数。 下界：0。 |
| `intent_labeled_turn_count` | INTEGER / NOT NULL | count | eligible且reference_intent_id非空的轮次数，含没有预测的失败轮。 下界：0。 |
| `intent_match_count` | INTEGER / NOT NULL | count | 上述标签轮中最终采用预测意图与人工标签相等数。 下界：0。 |
| `feedback_count` | INTEGER / NOT NULL | count | 当日轮次获得可见valid明确反馈的数目。 下界：0。 |
| `positive_feedback_count` | INTEGER / NOT NULL | count | 其中positive反馈数。 下界：0。 |
| `playback_interruption_count` | INTEGER / NOT NULL | count | 当日轮次的实际播放打断事件数。 下界：0。 |
| `snapshot_exclusive` | TEXT / NOT NULL | UTC RFC3339 second | 本次汇总的排他快照上界。 |

约束：

- `wakeup_accepted_count<=wakeup_attempt_count`
- `wakeup_false_accept_count<=wakeup_labeled_count`
- `eligible_turn_count=task_completed_count+clarification_count+failed_turn_count+unknown_turn_count+rejected_turn_count`
- `turn_count=eligible_turn_count+cancelled_turn_count+no_speech_turn_count`
- `asr_exact_match_count<=asr_labeled_turn_count`
- `intent_match_count<=intent_labeled_turn_count`
- `positive_feedback_count<=feedback_count`

## `syn_daily_stage_latency` · 语音阶段日尝试汇总

用于尝试负载和耗时均值，不能把attempt成功率当请求成功率；P95必须读取原始符合条件样本，不平均分组P95。

- 行粒度：一个轮次归属日、阶段、端云位置与build的统计
- 主键：`turn_date`, `stage`, `endpoint_kind`, `build_id`
- 唯一键：除主键外未额外声明
- 时间口径：所有阶段按所属turn的started_at归属日。

| 字段 | SQLite 类型 / 空值 | 单位 | 含义与限定 |
| --- | --- | --- | --- |
| `turn_date` | TEXT / NOT NULL | UTC date | voice_turn.started_at的UTC日期。 |
| `stage` | TEXT / NOT NULL | — | 可比的处理尝试阶段，VAD输入时长不混入。 允许值：asr, nlu, route, action, tts。 |
| `endpoint_kind` | TEXT / NOT NULL | — | 实际处理位置。 允许值：edge, cloud。 |
| `build_id` | TEXT / NOT NULL | — | 轮次会话冻结build。 引用`syn_software_build.build_id`。 |
| `attempt_count` | INTEGER / NOT NULL | count | 该阶段所有可见尝试数。 下界：0。 |
| `distinct_turn_count` | INTEGER / NOT NULL | count | 这些尝试对应的去重轮次数。 下界：0。 |
| `succeeded_attempt_count` | INTEGER / NOT NULL | count | 成功尝试数；route selected按成功记，action只看明确成功回执。 下界：0。 |
| `failed_attempt_count` | INTEGER / NOT NULL | count | 明确失败尝试数。 下界：0。 |
| `timeout_attempt_count` | INTEGER / NOT NULL | count | 超时尝试数。 下界：0。 |
| `cancelled_attempt_count` | INTEGER / NOT NULL | count | 取消尝试数。 下界：0。 |
| `unknown_attempt_count` | INTEGER / NOT NULL | count | 动作回执未知等未定状态数。 下界：0。 |
| `ambiguous_attempt_count` | INTEGER / NOT NULL | count | NLU歧义次数，不能算技术失败。 下界：0。 |
| `rejected_attempt_count` | INTEGER / NOT NULL | count | 路由/动作被策略或前提拒绝的次数，不与执行失败混同。 下界：0。 |
| `latency_sum_ms` | INTEGER / NOT NULL | ms | ASR/NLU/route/TTS用wall_ms；action用提交到最新明确回执的offset差；非空样本合计，不把unknown填0。 下界：0。 |
| `latency_samples` | INTEGER / NOT NULL | count | 非空耗时样本数。 下界：0。 |
| `latency_min_ms` | INTEGER / NULL | ms | 非空耗时最小值，无样本NULL。 下界：0。 |
| `latency_max_ms` | INTEGER / NULL | ms | 非空耗时最大值，无样本NULL。 下界：0。 |
| `queued_sum_ms` | INTEGER / NOT NULL | ms | 存在排队字段的ASR/NLU排队耗时合计，其他阶段0。 下界：0。 |
| `snapshot_exclusive` | TEXT / NOT NULL | UTC RFC3339 second | 快照排他上界。 |

约束：

- `attempt_count=succeeded_attempt_count+failed_attempt_count+timeout_attempt_count+cancelled_attempt_count+unknown_attempt_count+ambiguous_attempt_count+rejected_attempt_count`
- `distinct_turn_count<=attempt_count`
- `latency_samples<=attempt_count`

## `syn_daily_intent_outcome` · 已选意图日结果汇总

仅包含已有最终预测意图的轮次，不能把该表行数当全部语音输入，也不能单用它评估意图准确率（无预测的标签轮仍应进入正确率分母）。

- 行粒度：一个轮次归属日、最终预测意图与build的统计
- 主键：`turn_date`, `intent_id`, `build_id`
- 唯一键：除主键外未额外声明
- 时间口径：turn_date；分类维度是最终预测意图。

| 字段 | SQLite 类型 / 空值 | 单位 | 含义与限定 |
| --- | --- | --- | --- |
| `turn_date` | TEXT / NOT NULL | UTC date | voice_turn.started_at的UTC日期。 |
| `intent_id` | TEXT / NOT NULL | — | 最终被对话管理采用的预测意图，不是人工标签。 引用`syn_intent_catalog.intent_id`。 |
| `capability_id` | TEXT / NOT NULL | — | 预测意图所属能力。 引用`syn_voice_capability.capability_id`。 |
| `build_id` | TEXT / NOT NULL | — | 会话冻结build。 引用`syn_software_build.build_id`。 |
| `selected_turn_count` | INTEGER / NOT NULL | count | 有该最终预测意图的轮次数。 下界：0。 |
| `task_completed_count` | INTEGER / NOT NULL | count | 其中任务completed数。 下界：0。 |
| `clarification_count` | INTEGER / NOT NULL | count | 其中需要澄清数。 下界：0。 |
| `rejected_count` | INTEGER / NOT NULL | count | 其中被拒绝数。 下界：0。 |
| `failed_count` | INTEGER / NOT NULL | count | 其中失败数。 下界：0。 |
| `cancelled_count` | INTEGER / NOT NULL | count | 其中取消数。 下界：0。 |
| `unknown_count` | INTEGER / NOT NULL | count | 其中结果未知数。 下界：0。 |
| `no_speech_count` | INTEGER / NOT NULL | count | 一般为0，保留最终状态分桶完整性。 下界：0。 |
| `logical_action_count` | INTEGER / NOT NULL | count | 关联的去重operation_key数，不把重试当新动作。 下界：0。 |
| `confirmed_effect_count` | INTEGER / NOT NULL | count | 其中有可见confirmed效果的去重operation_key数。 下界：0。 |
| `feedback_count` | INTEGER / NOT NULL | count | 可见明确反馈数。 下界：0。 |
| `positive_feedback_count` | INTEGER / NOT NULL | count | positive数。 下界：0。 |
| `snapshot_exclusive` | TEXT / NOT NULL | UTC RFC3339 second | 快照排他上界。 |

约束：

- `selected_turn_count=task_completed_count+clarification_count+rejected_count+failed_count+cancelled_count+unknown_count+no_speech_count`
- `confirmed_effect_count<=logical_action_count`
- `positive_feedback_count<=feedback_count`

## `active_voice_vehicles` · 语音活跃车辆数

指标：语音活跃车辆数。
分子：COUNT(DISTINCT vehicle_id)。
分母：不适用；按指标公式取得计数或分布值。
单位：vehicle。
范围：非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。
空值与零：比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。
限制：跨日期/build去重不能直接相加。

```sql
WITH eligible_turns AS (
    SELECT t.*, s.vehicle_id, s.build_id, s.policy_id
    FROM syn_voice_turn t
    JOIN syn_voice_session s ON s.session_id = t.session_id
    JOIN syn_vehicle v ON v.vehicle_id = s.vehicle_id
    WHERE v.is_lab_unit = 0 AND v.telemetry_consent = 1
      AND s.quality_state = 'valid' AND s.is_complete = 1
      AND t.quality_state = 'valid'
      AND t.started_at >= :start AND t.started_at < :end
      AND s.started_at < :snapshot AND s.ended_at < :snapshot
      AND t.started_at < :snapshot AND t.finished_at < :snapshot
      AND t.received_at < :snapshot AND s.received_at < :snapshot
)
SELECT COUNT(DISTINCT vehicle_id) AS active_voice_vehicles FROM eligible_turns;
```

## `valid_voice_turns` · 有效语音交互轮次

指标：有效语音交互轮次。
分子：COUNT(*)。
分母：不适用；按指标公式取得计数或分布值。
单位：turn。
范围：非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。
空值与零：比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。
限制：不把阶段attempt/候选/槽位当新用户请求。

```sql
WITH eligible_turns AS (
    SELECT t.*, s.vehicle_id, s.build_id, s.policy_id
    FROM syn_voice_turn t
    JOIN syn_voice_session s ON s.session_id = t.session_id
    JOIN syn_vehicle v ON v.vehicle_id = s.vehicle_id
    WHERE v.is_lab_unit = 0 AND v.telemetry_consent = 1
      AND s.quality_state = 'valid' AND s.is_complete = 1
      AND t.quality_state = 'valid'
      AND t.started_at >= :start AND t.started_at < :end
      AND s.started_at < :snapshot AND s.ended_at < :snapshot
      AND t.started_at < :snapshot AND t.finished_at < :snapshot
      AND t.received_at < :snapshot AND s.received_at < :snapshot
)
SELECT COUNT(*) AS valid_voice_turns FROM eligible_turns;
```

## `wakeup_acceptance_rate` · 入口接受率

指标：入口接受率。
分子：accepted=1次数。
分母：全部可见valid入口次数。
单位：ratio。
范围：按wakeup.started_at，默认非实验授权车辆。
空值与零：比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。
限制：不是唤醒正确率；按键与唤醒词应分组。

```sql
WITH visible_wakeup AS (
    SELECT w.* FROM syn_wakeup_attempt w
    JOIN syn_vehicle v ON v.vehicle_id = w.vehicle_id
    WHERE v.is_lab_unit = 0 AND v.telemetry_consent = 1
      AND w.quality_state = 'valid'
      AND w.started_at >= :start AND w.started_at < :end
      AND w.started_at < :snapshot AND w.received_at < :snapshot
)
SELECT COUNT(*) AS attempts, COALESCE(SUM(accepted), 0) AS accepted_attempts,
       CAST(SUM(accepted) AS REAL) / NULLIF(COUNT(*), 0) AS acceptance_rate
FROM visible_wakeup;
```

## `wakeup_false_accept_rate` · 有标签入口错误接受率

指标：有标签入口错误接受率。
分子：reference_is_intended=0且accepted=1次数。
分母：reference_is_intended=0次数。
单位：ratio。
范围：只取人工合成标签非空的valid入口。
空值与零：比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。
限制：不代表真实音频误唤醒率；必须报告标签覆盖率。

```sql
WITH visible_wakeup AS (
    SELECT w.* FROM syn_wakeup_attempt w
    JOIN syn_vehicle v ON v.vehicle_id = w.vehicle_id
    WHERE v.is_lab_unit = 0 AND v.telemetry_consent = 1
      AND w.quality_state = 'valid'
      AND w.started_at >= :start AND w.started_at < :end
      AND w.started_at < :snapshot AND w.received_at < :snapshot
)
SELECT COALESCE(SUM(CASE WHEN reference_is_intended = 0 AND accepted = 1 THEN 1 ELSE 0 END), 0) AS false_accepts,
       COALESCE(SUM(CASE WHEN reference_is_intended = 0 THEN 1 ELSE 0 END), 0) AS unintended_labeled_attempts,
       CAST(SUM(CASE WHEN reference_is_intended = 0 AND accepted = 1 THEN 1 ELSE 0 END) AS REAL)
         / NULLIF(SUM(CASE WHEN reference_is_intended = 0 THEN 1 ELSE 0 END), 0) AS false_accept_rate
FROM visible_wakeup;
```

## `wakeup_label_coverage` · 入口标签覆盖率

指标：入口标签覆盖率。
分子：reference_is_intended非空次数。
分母：全部可见valid入口次数。
单位：ratio。
范围：按wakeup.started_at。
空值与零：比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。
限制：无标签不能被当作负标签。

```sql
WITH visible_wakeup AS (
    SELECT w.* FROM syn_wakeup_attempt w
    JOIN syn_vehicle v ON v.vehicle_id = w.vehicle_id
    WHERE v.is_lab_unit = 0 AND v.telemetry_consent = 1
      AND w.quality_state = 'valid'
      AND w.started_at >= :start AND w.started_at < :end
      AND w.started_at < :snapshot AND w.received_at < :snapshot
)
SELECT COUNT(reference_is_intended) AS labeled_attempts, COUNT(*) AS attempts,
       CAST(COUNT(reference_is_intended) AS REAL) / NULLIF(COUNT(*), 0) AS label_coverage
FROM visible_wakeup;
```

## `task_completion_rate` · 语音任务达成率

指标：语音任务达成率。
分子：task_completed_count。
分母：eligible_turn_count。
单位：ratio。
范围：非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。 eligible=completed/clarification_pending/rejected/failed/unknown，排除cancelled/no_speech。 当前日表SQL仅接受:start与:end均为UTC整日边界的半开区间；小时或其他非整日范围必须从原始事实按同口径重算，不能截去时分秒。
空值与零：比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。
限制：是执行链终态，不证明意图正确、播报成功或用户满意。 日表SQL以HAVING核对整日参数，不合要求时不返回统计行，不把它解释成零样本。

```sql
SELECT COALESCE(SUM(task_completed_count), 0) AS numerator, COALESCE(SUM(eligible_turn_count), 0) AS denominator,
       CAST(SUM(task_completed_count) AS REAL) / NULLIF(SUM(eligible_turn_count), 0) AS task_completion_rate
FROM syn_daily_voice_experience
WHERE snapshot_exclusive = :snapshot
  AND activity_date >= substr(:start, 1, 10)
  AND activity_date < substr(:end, 1, 10)
HAVING :start = substr(:start, 1, 10) || 'T00:00:00Z'
  AND :end = substr(:end, 1, 10) || 'T00:00:00Z'
  AND :start < :end;
```

## `clarification_rate` · 请求澄清比例

指标：请求澄清比例。
分子：clarification_count。
分母：eligible_turn_count。
单位：ratio。
范围：非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。 当前日表SQL仅接受:start与:end均为UTC整日边界的半开区间；小时或其他非整日范围必须从原始事实按同口径重算，不能截去时分秒。
空值与零：比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。
限制：澄清不是技术失败，但本轮尚未完成目标。 日表SQL以HAVING核对整日参数，不合要求时不返回统计行，不把它解释成零样本。

```sql
SELECT COALESCE(SUM(clarification_count), 0) AS numerator, COALESCE(SUM(eligible_turn_count), 0) AS denominator,
       CAST(SUM(clarification_count) AS REAL) / NULLIF(SUM(eligible_turn_count), 0) AS clarification_rate
FROM syn_daily_voice_experience
WHERE snapshot_exclusive = :snapshot
  AND activity_date >= substr(:start, 1, 10)
  AND activity_date < substr(:end, 1, 10)
HAVING :start = substr(:start, 1, 10) || 'T00:00:00Z'
  AND :end = substr(:end, 1, 10) || 'T00:00:00Z'
  AND :start < :end;
```

## `asr_exact_match_rate` · 有标签转写一致率

指标：有标签转写一致率。
分子：asr_exact_match_count。
分母：asr_labeled_turn_count。
单位：ratio。
范围：非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。 eligible且reference_text非空，未生成最终预测也保留在分母。 当前日表SQL仅接受:start与:end均为UTC整日边界的半开区间；小时或其他非整日范围必须从原始事实按同口径重算，不能截去时分秒。
空值与零：比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。
限制：本包只定义人工合成标签子集的规范化逐字一致，未定义CER/WER，不代表真实声学准确率。 日表SQL以HAVING核对整日参数，不合要求时不返回统计行，不把它解释成零样本。

```sql
SELECT COALESCE(SUM(asr_exact_match_count), 0) AS numerator, COALESCE(SUM(asr_labeled_turn_count), 0) AS denominator,
       CAST(SUM(asr_exact_match_count) AS REAL) / NULLIF(SUM(asr_labeled_turn_count), 0) AS asr_exact_match_rate
FROM syn_daily_voice_experience
WHERE snapshot_exclusive = :snapshot
  AND activity_date >= substr(:start, 1, 10)
  AND activity_date < substr(:end, 1, 10)
HAVING :start = substr(:start, 1, 10) || 'T00:00:00Z'
  AND :end = substr(:end, 1, 10) || 'T00:00:00Z'
  AND :start < :end;
```

## `asr_label_coverage` · 转写标签覆盖率

指标：转写标签覆盖率。
分子：asr_labeled_turn_count。
分母：eligible_turn_count。
单位：ratio。
范围：非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。 当前日表SQL仅接受:start与:end均为UTC整日边界的半开区间；小时或其他非整日范围必须从原始事实按同口径重算，不能截去时分秒。
空值与零：比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。
限制：预测不能填充缺失人工标签。 日表SQL以HAVING核对整日参数，不合要求时不返回统计行，不把它解释成零样本。

```sql
SELECT COALESCE(SUM(asr_labeled_turn_count), 0) AS numerator, COALESCE(SUM(eligible_turn_count), 0) AS denominator,
       CAST(SUM(asr_labeled_turn_count) AS REAL) / NULLIF(SUM(eligible_turn_count), 0) AS asr_label_coverage
FROM syn_daily_voice_experience
WHERE snapshot_exclusive = :snapshot
  AND activity_date >= substr(:start, 1, 10)
  AND activity_date < substr(:end, 1, 10)
HAVING :start = substr(:start, 1, 10) || 'T00:00:00Z'
  AND :end = substr(:end, 1, 10) || 'T00:00:00Z'
  AND :start < :end;
```

## `intent_match_rate` · 有标签意图一致率

指标：有标签意图一致率。
分子：intent_match_count。
分母：reference_intent_id非空的eligible轮次数。
单位：ratio。
范围：非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。 reference_intent_id非空，未预测也保留在分母。 当前日表SQL仅接受:start与:end均为UTC整日边界的半开区间；小时或其他非整日范围必须从原始事实按同口径重算，不能截去时分秒。 eligible仅含completed、clarification_pending、rejected、failed、unknown；排除cancelled与no_speech。
空值与零：比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。
限制：只比较最终采用意图，不把最高置信或第一个成功结果当最终结果。 日表SQL以HAVING核对整日参数，不合要求时不返回统计行，不把它解释成零样本。

```sql
SELECT COALESCE(SUM(intent_match_count), 0) AS numerator, COALESCE(SUM(intent_labeled_turn_count), 0) AS denominator,
       CAST(SUM(intent_match_count) AS REAL) / NULLIF(SUM(intent_labeled_turn_count), 0) AS intent_match_rate
FROM syn_daily_voice_experience
WHERE snapshot_exclusive = :snapshot
  AND activity_date >= substr(:start, 1, 10)
  AND activity_date < substr(:end, 1, 10)
HAVING :start = substr(:start, 1, 10) || 'T00:00:00Z'
  AND :end = substr(:end, 1, 10) || 'T00:00:00Z'
  AND :start < :end;
```

## `intent_label_coverage` · 意图标签覆盖率

指标：意图标签覆盖率。
分子：intent_labeled_turn_count。
分母：eligible_turn_count。
单位：ratio。
范围：非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。 当前日表SQL仅接受:start与:end均为UTC整日边界的半开区间；小时或其他非整日范围必须从原始事实按同口径重算，不能截去时分秒。
空值与零：比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。
限制：没有标签的轮次不进入一致率。 日表SQL以HAVING核对整日参数，不合要求时不返回统计行，不把它解释成零样本。

```sql
SELECT COALESCE(SUM(intent_labeled_turn_count), 0) AS numerator, COALESCE(SUM(eligible_turn_count), 0) AS denominator,
       CAST(SUM(intent_labeled_turn_count) AS REAL) / NULLIF(SUM(eligible_turn_count), 0) AS intent_label_coverage
FROM syn_daily_voice_experience
WHERE snapshot_exclusive = :snapshot
  AND activity_date >= substr(:start, 1, 10)
  AND activity_date < substr(:end, 1, 10)
HAVING :start = substr(:start, 1, 10) || 'T00:00:00Z'
  AND :end = substr(:end, 1, 10) || 'T00:00:00Z'
  AND :start < :end;
```

## `asr_retry_turn_rate` · ASR重试轮次占比

指标：ASR重试轮次占比。
分子：存在attempt_no>1的去重turn数。
分母：有ASR尝试的去重turn数。
单位：ratio。
范围：非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。
空值与零：比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。
限制：一次轮次多次重试只计一次分子。

```sql
WITH eligible_turns AS (
    SELECT t.*, s.vehicle_id, s.build_id, s.policy_id
    FROM syn_voice_turn t
    JOIN syn_voice_session s ON s.session_id = t.session_id
    JOIN syn_vehicle v ON v.vehicle_id = s.vehicle_id
    WHERE v.is_lab_unit = 0 AND v.telemetry_consent = 1
      AND s.quality_state = 'valid' AND s.is_complete = 1
      AND t.quality_state = 'valid'
      AND t.started_at >= :start AND t.started_at < :end
      AND s.started_at < :snapshot AND s.ended_at < :snapshot
      AND t.started_at < :snapshot AND t.finished_at < :snapshot
      AND t.received_at < :snapshot AND s.received_at < :snapshot
), per_turn AS (
    SELECT a.turn_id, MAX(CASE WHEN a.attempt_no > 1 THEN 1 ELSE 0 END) AS matched
    FROM syn_asr_attempt a JOIN eligible_turns t ON t.turn_id = a.turn_id
    WHERE a.received_at < :snapshot GROUP BY a.turn_id
)
SELECT COALESCE(SUM(matched), 0) AS matched_turns, COUNT(*) AS attempted_turns,
       CAST(SUM(matched) AS REAL) / NULLIF(COUNT(*), 0) AS asr_retry_turn_rate
FROM per_turn;
```

## `edge_fallback_turn_rate` · 端侧回退轮次占比

指标：端侧回退轮次占比。
分子：出现fallback_reason非none且endpoint=edge的去重turn数。
分母：有ASR尝试的去重turn数。
单位：ratio。
范围：非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。
空值与零：比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。
限制：回退发生不等于回退成功，仍核对final_outcome。

```sql
WITH eligible_turns AS (
    SELECT t.*, s.vehicle_id, s.build_id, s.policy_id
    FROM syn_voice_turn t
    JOIN syn_voice_session s ON s.session_id = t.session_id
    JOIN syn_vehicle v ON v.vehicle_id = s.vehicle_id
    WHERE v.is_lab_unit = 0 AND v.telemetry_consent = 1
      AND s.quality_state = 'valid' AND s.is_complete = 1
      AND t.quality_state = 'valid'
      AND t.started_at >= :start AND t.started_at < :end
      AND s.started_at < :snapshot AND s.ended_at < :snapshot
      AND t.started_at < :snapshot AND t.finished_at < :snapshot
      AND t.received_at < :snapshot AND s.received_at < :snapshot
), per_turn AS (
    SELECT a.turn_id, MAX(CASE WHEN a.endpoint_kind = 'edge' AND a.fallback_reason <> 'none' THEN 1 ELSE 0 END) AS matched
    FROM syn_asr_attempt a JOIN eligible_turns t ON t.turn_id = a.turn_id
    WHERE a.received_at < :snapshot GROUP BY a.turn_id
)
SELECT COALESCE(SUM(matched), 0) AS matched_turns, COUNT(*) AS attempted_turns,
       CAST(SUM(matched) AS REAL) / NULLIF(COUNT(*), 0) AS edge_fallback_turn_rate
FROM per_turn;
```

## `completed_task_mean_ms` · 已达成任务平均响应耗时

指标：已达成任务平均响应耗时。
分子：SUM(completed_latency_sum_ms)。
分母：SUM(completed_latency_samples)。
单位：ms。
范围：非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。 只取completed。 当前日表SQL仅接受:start与:end均为UTC整日边界的半开区间；小时或其他非整日范围必须从原始事实按同口径重算，不能截去时分秒。
空值与零：比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。
限制：从用户输入结束计，不包含input_ms；不能平均分组均值。 日表SQL以HAVING核对整日参数，不合要求时不返回统计行，不把它解释成零样本。

```sql
SELECT COALESCE(SUM(completed_latency_sum_ms), 0) AS numerator, COALESCE(SUM(completed_latency_samples), 0) AS denominator,
       CAST(SUM(completed_latency_sum_ms) AS REAL) / NULLIF(SUM(completed_latency_samples), 0) AS completed_task_mean_ms
FROM syn_daily_voice_experience
WHERE snapshot_exclusive = :snapshot
  AND activity_date >= substr(:start, 1, 10)
  AND activity_date < substr(:end, 1, 10)
HAVING :start = substr(:start, 1, 10) || 'T00:00:00Z'
  AND :end = substr(:end, 1, 10) || 'T00:00:00Z'
  AND :start < :end;
```

## `completed_task_p95_ms` · 已达成任务P95耗时

指标：已达成任务P95耗时。
分子：原始completed task_latency_ms最近秩ceil(0.95*N)值。
分母：不适用；按指标公式取得计数或分布值。
单位：ms。
范围：非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。 只取completed且非空样本。
空值与零：比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。
限制：原始样本最近秩，不平均组P95，不用阶段时长相加代替。

```sql
WITH eligible_turns AS (
    SELECT t.*, s.vehicle_id, s.build_id, s.policy_id
    FROM syn_voice_turn t
    JOIN syn_voice_session s ON s.session_id = t.session_id
    JOIN syn_vehicle v ON v.vehicle_id = s.vehicle_id
    WHERE v.is_lab_unit = 0 AND v.telemetry_consent = 1
      AND s.quality_state = 'valid' AND s.is_complete = 1
      AND t.quality_state = 'valid'
      AND t.started_at >= :start AND t.started_at < :end
      AND s.started_at < :snapshot AND s.ended_at < :snapshot
      AND t.started_at < :snapshot AND t.finished_at < :snapshot
      AND t.received_at < :snapshot AND s.received_at < :snapshot
), ranked AS (
    SELECT task_latency_ms AS latency_ms,
           ROW_NUMBER() OVER (ORDER BY task_latency_ms, turn_id) AS rn,
           COUNT(*) OVER () AS n
    FROM eligible_turns WHERE final_outcome = 'completed' AND task_latency_ms IS NOT NULL
)
SELECT COUNT(*) AS sample_count,
       MAX(CASE WHEN rn = (95 * n + 99) / 100 THEN latency_ms END) AS completed_task_p95_ms
FROM ranked;
```

## `first_audio_p95_ms` · 有首音轮次P95时延

指标：有首音轮次P95时延。
分子：原始first_audio_latency_ms最近秩ceil(0.95*N)值。
分母：不适用；按指标公式取得计数或分布值。
单位：ms。
范围：非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。 仅实际有首音者，另报告首音覆盖率。
空值与零：比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。
限制：首音来自playback开始，不是TTS请求开始或首包；澄清提示也可有首音。

```sql
WITH eligible_turns AS (
    SELECT t.*, s.vehicle_id, s.build_id, s.policy_id
    FROM syn_voice_turn t
    JOIN syn_voice_session s ON s.session_id = t.session_id
    JOIN syn_vehicle v ON v.vehicle_id = s.vehicle_id
    WHERE v.is_lab_unit = 0 AND v.telemetry_consent = 1
      AND s.quality_state = 'valid' AND s.is_complete = 1
      AND t.quality_state = 'valid'
      AND t.started_at >= :start AND t.started_at < :end
      AND s.started_at < :snapshot AND s.ended_at < :snapshot
      AND t.started_at < :snapshot AND t.finished_at < :snapshot
      AND t.received_at < :snapshot AND s.received_at < :snapshot
), ranked AS (
    SELECT first_audio_latency_ms AS latency_ms,
           ROW_NUMBER() OVER (ORDER BY first_audio_latency_ms, turn_id) AS rn,
           COUNT(*) OVER () AS n
    FROM eligible_turns WHERE first_audio_latency_ms IS NOT NULL
)
SELECT COUNT(*) AS sample_count,
       MAX(CASE WHEN rn = (95 * n + 99) / 100 THEN latency_ms END) AS first_audio_p95_ms
FROM ranked;
```

## `first_audio_coverage` · 首音覆盖率

指标：首音覆盖率。
分子：first_audio_samples。
分母：turn_count。
单位：ratio。
范围：非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。 当前日表SQL仅接受:start与:end均为UTC整日边界的半开区间；小时或其他非整日范围必须从原始事实按同口径重算，不能截去时分秒。
空值与零：比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。
限制：无首音不能填0混入时延分布。 日表SQL以HAVING核对整日参数，不合要求时不返回统计行，不把它解释成零样本。

```sql
SELECT COALESCE(SUM(first_audio_samples), 0) AS numerator, COALESCE(SUM(turn_count), 0) AS denominator,
       CAST(SUM(first_audio_samples) AS REAL) / NULLIF(SUM(turn_count), 0) AS first_audio_coverage
FROM syn_daily_voice_experience
WHERE snapshot_exclusive = :snapshot
  AND activity_date >= substr(:start, 1, 10)
  AND activity_date < substr(:end, 1, 10)
HAVING :start = substr(:start, 1, 10) || 'T00:00:00Z'
  AND :end = substr(:end, 1, 10) || 'T00:00:00Z'
  AND :start < :end;
```

## `stage_attempt_success_rate` · 阶段尝试成功率

指标：阶段尝试成功率。
分子：succeeded_attempt_count。
分母：attempt_count。
单位：ratio。
范围：非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。 必须限定stage并分端云。 当前日表SQL仅接受:start与:end均为UTC整日边界的半开区间；小时或其他非整日范围必须从原始事实按同口径重算，不能截去时分秒。
空值与零：比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。
限制：含timeout/cancelled/unknown在attempt分母；不是用户任务成功率。 日表SQL以HAVING核对整日参数，不合要求时不返回统计行，不把它解释成零样本。

```sql
SELECT stage, endpoint_kind, SUM(succeeded_attempt_count) AS numerator, SUM(attempt_count) AS denominator,
       CAST(SUM(succeeded_attempt_count) AS REAL) / NULLIF(SUM(attempt_count), 0) AS stage_attempt_success_rate
FROM syn_daily_stage_latency
WHERE snapshot_exclusive = :snapshot
  AND turn_date >= substr(:start, 1, 10)
  AND turn_date < substr(:end, 1, 10)
GROUP BY stage, endpoint_kind
HAVING :start = substr(:start, 1, 10) || 'T00:00:00Z'
  AND :end = substr(:end, 1, 10) || 'T00:00:00Z'
  AND :start < :end
ORDER BY stage, endpoint_kind;
```

## `stage_mean_ms` · 阶段尝试平均耗时

指标：阶段尝试平均耗时。
分子：SUM(latency_sum_ms)。
分母：SUM(latency_samples)。
单位：ms。
范围：非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。 按stage/endpoint解释。 当前日表SQL仅接受:start与:end均为UTC整日边界的半开区间；小时或其他非整日范围必须从原始事实按同口径重算，不能截去时分秒。
空值与零：比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。
限制：只对非空耗时样本，未知耗时不填0。 日表SQL以HAVING核对整日参数，不合要求时不返回统计行，不把它解释成零样本。

```sql
SELECT stage, endpoint_kind, SUM(latency_sum_ms) AS numerator, SUM(latency_samples) AS denominator,
       CAST(SUM(latency_sum_ms) AS REAL) / NULLIF(SUM(latency_samples), 0) AS stage_mean_ms
FROM syn_daily_stage_latency
WHERE snapshot_exclusive = :snapshot
  AND turn_date >= substr(:start, 1, 10)
  AND turn_date < substr(:end, 1, 10)
GROUP BY stage, endpoint_kind
HAVING :start = substr(:start, 1, 10) || 'T00:00:00Z'
  AND :end = substr(:end, 1, 10) || 'T00:00:00Z'
  AND :start < :end
ORDER BY stage, endpoint_kind;
```

## `logical_effect_confirmation_rate` · 逻辑动作效果确认率

指标：逻辑动作效果确认率。
分子：有最新明确confirmed效果的去重operation_key数。
分母：去重operation_key数。
单位：ratio。
范围：非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。
空值与零：比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。
限制：重复回执和传输重试不增加动作数；accepted不等于效果确认。

```sql
WITH eligible_turns AS (
    SELECT t.*, s.vehicle_id, s.build_id, s.policy_id
    FROM syn_voice_turn t
    JOIN syn_voice_session s ON s.session_id = t.session_id
    JOIN syn_vehicle v ON v.vehicle_id = s.vehicle_id
    WHERE v.is_lab_unit = 0 AND v.telemetry_consent = 1
      AND s.quality_state = 'valid' AND s.is_complete = 1
      AND t.quality_state = 'valid'
      AND t.started_at >= :start AND t.started_at < :end
      AND s.started_at < :snapshot AND s.ended_at < :snapshot
      AND t.started_at < :snapshot AND t.finished_at < :snapshot
      AND t.received_at < :snapshot AND s.received_at < :snapshot
), operations AS (
    SELECT DISTINCT i.operation_key
    FROM syn_action_invocation i JOIN eligible_turns t ON t.turn_id = i.turn_id
    WHERE i.received_at < :snapshot
), ranked_receipts AS (
    SELECT r.*, ROW_NUMBER() OVER (
        PARTITION BY r.operation_key
        ORDER BY r.observed_offset_ms DESC, r.observation_no DESC, r.result_id DESC
    ) AS receipt_rank
    FROM syn_action_result r JOIN operations o ON o.operation_key = r.operation_key
    WHERE r.received_at < :snapshot
)
SELECT COUNT(*) AS logical_operations,
       COALESCE(SUM(CASE WHEN r.return_state = 'succeeded' AND r.effect_state = 'confirmed' THEN 1 ELSE 0 END), 0) AS matched_operations,
       CAST(SUM(CASE WHEN r.return_state = 'succeeded' AND r.effect_state = 'confirmed' THEN 1 ELSE 0 END) AS REAL) / NULLIF(COUNT(*), 0) AS logical_effect_confirmation_rate
FROM operations o LEFT JOIN ranked_receipts r
  ON r.operation_key = o.operation_key AND r.receipt_rank = 1;
```

## `unknown_action_rate` · 逻辑动作结果未知占比

指标：逻辑动作结果未知占比。
分子：最新可见状态unknown或尚无回执的operation_key数。
分母：全部operation_key数。
单位：ratio。
范围：非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。
空值与零：比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。
限制：不能把unknown改成失败或重做新动作。

```sql
WITH eligible_turns AS (
    SELECT t.*, s.vehicle_id, s.build_id, s.policy_id
    FROM syn_voice_turn t
    JOIN syn_voice_session s ON s.session_id = t.session_id
    JOIN syn_vehicle v ON v.vehicle_id = s.vehicle_id
    WHERE v.is_lab_unit = 0 AND v.telemetry_consent = 1
      AND s.quality_state = 'valid' AND s.is_complete = 1
      AND t.quality_state = 'valid'
      AND t.started_at >= :start AND t.started_at < :end
      AND s.started_at < :snapshot AND s.ended_at < :snapshot
      AND t.started_at < :snapshot AND t.finished_at < :snapshot
      AND t.received_at < :snapshot AND s.received_at < :snapshot
), operations AS (
    SELECT DISTINCT i.operation_key
    FROM syn_action_invocation i JOIN eligible_turns t ON t.turn_id = i.turn_id
    WHERE i.received_at < :snapshot
), ranked_receipts AS (
    SELECT r.*, ROW_NUMBER() OVER (
        PARTITION BY r.operation_key
        ORDER BY r.observed_offset_ms DESC, r.observation_no DESC, r.result_id DESC
    ) AS receipt_rank
    FROM syn_action_result r JOIN operations o ON o.operation_key = r.operation_key
    WHERE r.received_at < :snapshot
)
SELECT COUNT(*) AS logical_operations,
       COALESCE(SUM(CASE WHEN r.result_id IS NULL OR r.return_state = 'unknown' THEN 1 ELSE 0 END), 0) AS matched_operations,
       CAST(SUM(CASE WHEN r.result_id IS NULL OR r.return_state = 'unknown' THEN 1 ELSE 0 END) AS REAL) / NULLIF(COUNT(*), 0) AS unknown_action_rate
FROM operations o LEFT JOIN ranked_receipts r
  ON r.operation_key = o.operation_key AND r.receipt_rank = 1;
```

## `tts_success_rate` · TTS尝试成功率

指标：TTS尝试成功率。
分子：outcome=succeeded次数。
分母：所有TTS尝试次数。
单位：ratio。
范围：非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。
空值与零：比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。
限制：不等于实际播放完成或任务达成。

```sql
WITH eligible_turns AS (
    SELECT t.*, s.vehicle_id, s.build_id, s.policy_id
    FROM syn_voice_turn t
    JOIN syn_voice_session s ON s.session_id = t.session_id
    JOIN syn_vehicle v ON v.vehicle_id = s.vehicle_id
    WHERE v.is_lab_unit = 0 AND v.telemetry_consent = 1
      AND s.quality_state = 'valid' AND s.is_complete = 1
      AND t.quality_state = 'valid'
      AND t.started_at >= :start AND t.started_at < :end
      AND s.started_at < :snapshot AND s.ended_at < :snapshot
      AND t.started_at < :snapshot AND t.finished_at < :snapshot
      AND t.received_at < :snapshot AND s.received_at < :snapshot
)
SELECT COUNT(*) AS visible_records, COALESCE(SUM(CASE WHEN f.outcome = 'succeeded' THEN 1 ELSE 0 END), 0) AS matched_records,
       CAST(SUM(CASE WHEN f.outcome = 'succeeded' THEN 1 ELSE 0 END) AS REAL) / NULLIF(COUNT(*), 0) AS tts_success_rate
FROM syn_tts_request f JOIN eligible_turns t ON t.turn_id = f.turn_id
WHERE f.received_at < :snapshot;
```

## `playback_completion_rate` · 播报片段完成率

指标：播报片段完成率。
分子：completion_state=complete片段数。
分母：全部播放片段数。
单位：ratio。
范围：非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。
空值与零：比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。
限制：用户打断单独列出，不直接算作原动作失败。

```sql
WITH eligible_turns AS (
    SELECT t.*, s.vehicle_id, s.build_id, s.policy_id
    FROM syn_voice_turn t
    JOIN syn_voice_session s ON s.session_id = t.session_id
    JOIN syn_vehicle v ON v.vehicle_id = s.vehicle_id
    WHERE v.is_lab_unit = 0 AND v.telemetry_consent = 1
      AND s.quality_state = 'valid' AND s.is_complete = 1
      AND t.quality_state = 'valid'
      AND t.started_at >= :start AND t.started_at < :end
      AND s.started_at < :snapshot AND s.ended_at < :snapshot
      AND t.started_at < :snapshot AND t.finished_at < :snapshot
      AND t.received_at < :snapshot AND s.received_at < :snapshot
)
SELECT COUNT(*) AS visible_records, COALESCE(SUM(CASE WHEN f.completion_state = 'complete' THEN 1 ELSE 0 END), 0) AS matched_records,
       CAST(SUM(CASE WHEN f.completion_state = 'complete' THEN 1 ELSE 0 END) AS REAL) / NULLIF(COUNT(*), 0) AS playback_completion_rate
FROM syn_playback_segment f JOIN eligible_turns t ON t.turn_id = f.turn_id
WHERE f.received_at < :snapshot;
```

## `feedback_coverage` · 明确反馈覆盖率

指标：明确反馈覆盖率。
分子：feedback_count。
分母：turn_count。
单位：ratio。
范围：非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。 当前日表SQL仅接受:start与:end均为UTC整日边界的半开区间；小时或其他非整日范围必须从原始事实按同口径重算，不能截去时分秒。
空值与零：比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。
限制：没有反馈不是满意或不满意。 日表SQL以HAVING核对整日参数，不合要求时不返回统计行，不把它解释成零样本。

```sql
SELECT COALESCE(SUM(feedback_count), 0) AS numerator, COALESCE(SUM(turn_count), 0) AS denominator,
       CAST(SUM(feedback_count) AS REAL) / NULLIF(SUM(turn_count), 0) AS feedback_coverage
FROM syn_daily_voice_experience
WHERE snapshot_exclusive = :snapshot
  AND activity_date >= substr(:start, 1, 10)
  AND activity_date < substr(:end, 1, 10)
HAVING :start = substr(:start, 1, 10) || 'T00:00:00Z'
  AND :end = substr(:end, 1, 10) || 'T00:00:00Z'
  AND :start < :end;
```

## `positive_feedback_rate` · 有反馈轮次正评率

指标：有反馈轮次正评率。
分子：positive_feedback_count。
分母：feedback_count。
单位：ratio。
范围：非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。 当前日表SQL仅接受:start与:end均为UTC整日边界的半开区间；小时或其他非整日范围必须从原始事实按同口径重算，不能截去时分秒。
空值与零：比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。
限制：仅人工合成反馈子集，必须同时报告覆盖率。 日表SQL以HAVING核对整日参数，不合要求时不返回统计行，不把它解释成零样本。

```sql
SELECT COALESCE(SUM(positive_feedback_count), 0) AS numerator, COALESCE(SUM(feedback_count), 0) AS denominator,
       CAST(SUM(positive_feedback_count) AS REAL) / NULLIF(SUM(feedback_count), 0) AS positive_feedback_rate
FROM syn_daily_voice_experience
WHERE snapshot_exclusive = :snapshot
  AND activity_date >= substr(:start, 1, 10)
  AND activity_date < substr(:end, 1, 10)
HAVING :start = substr(:start, 1, 10) || 'T00:00:00Z'
  AND :end = substr(:end, 1, 10) || 'T00:00:00Z'
  AND :start < :end;
```

## `interrupted_playback_rate` · 播报片段被打断比例

指标：播报片段被打断比例。
分子：completion_state=interrupted片段数。
分母：全部播放片段数。
单位：ratio。
范围：非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。
空值与零：比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。
限制：新输入打断、按钮停止和设备错误分别解释。

```sql
WITH eligible_turns AS (
    SELECT t.*, s.vehicle_id, s.build_id, s.policy_id
    FROM syn_voice_turn t
    JOIN syn_voice_session s ON s.session_id = t.session_id
    JOIN syn_vehicle v ON v.vehicle_id = s.vehicle_id
    WHERE v.is_lab_unit = 0 AND v.telemetry_consent = 1
      AND s.quality_state = 'valid' AND s.is_complete = 1
      AND t.quality_state = 'valid'
      AND t.started_at >= :start AND t.started_at < :end
      AND s.started_at < :snapshot AND s.ended_at < :snapshot
      AND t.started_at < :snapshot AND t.finished_at < :snapshot
      AND t.received_at < :snapshot AND s.received_at < :snapshot
)
SELECT COUNT(*) AS visible_records, COALESCE(SUM(CASE WHEN f.completion_state = 'interrupted' THEN 1 ELSE 0 END), 0) AS matched_records,
       CAST(SUM(CASE WHEN f.completion_state = 'interrupted' THEN 1 ELSE 0 END) AS REAL) / NULLIF(COUNT(*), 0) AS interrupted_playback_rate
FROM syn_playback_segment f JOIN eligible_turns t ON t.turn_id = f.turn_id
WHERE f.received_at < :snapshot;
```

## 可机读定义

以下记录是上文的明确结构定义，目录生成器只复用这些定义并与实际DDL核对；没有种子安排或用例预期值。

```semantic-definitions
{"kind":"table","table":"syn_daily_voice_experience","label":"语音交互日体验汇总","grain":"一个UTC活动日、车辆及各事实冻结build的并列计数","primary_key":["activity_date","vehicle_id","build_id"],"unique_keys":[],"description":"不同事实分别按所属轮次或独立入口日期聚合，不能将attempt/候选/槽位直接联接后重复SUM。轮次跨午夜按本轮开始日，阶段后续日期不能改归属。","time_basis":"activity_date按各指标明确的起点；轮次及阶段按turn.started_at日期。","checks":["wakeup_accepted_count<=wakeup_attempt_count","wakeup_false_accept_count<=wakeup_labeled_count","eligible_turn_count=task_completed_count+clarification_count+failed_turn_count+unknown_turn_count+rejected_turn_count","turn_count=eligible_turn_count+cancelled_turn_count+no_speech_turn_count","asr_exact_match_count<=asr_labeled_turn_count","intent_match_count<=intent_labeled_turn_count","positive_feedback_count<=feedback_count"],"time_columns":[{"column":"activity_date","role":"business"},{"column":"snapshot_exclusive","role":"snapshot"}],"default_filters":["snapshot_exclusive = '2026-10-04T00:00:00Z'"]}
{"kind":"field","table":"syn_daily_voice_experience","name":"activity_date","type":"TEXT","nullable":false,"meaning":"UTC活动日期：轮次按started_at；唤醒按自身started_at；会话数按session.started_at。","unit":"UTC date"}
{"kind":"field","table":"syn_daily_voice_experience","name":"vehicle_id","type":"TEXT","nullable":false,"meaning":"车辆维度。","references":{"table":"syn_vehicle","column":"vehicle_id"}}
{"kind":"field","table":"syn_daily_voice_experience","name":"build_id","type":"TEXT","nullable":false,"meaning":"事件当时冻结build。","references":{"table":"syn_software_build","column":"build_id"}}
{"kind":"field","table":"syn_daily_voice_experience","name":"session_count","type":"INTEGER","nullable":false,"meaning":"当日开始的有效完整语音会话数。","unit":"count","minimum":0}
{"kind":"field","table":"syn_daily_voice_experience","name":"wakeup_attempt_count","type":"INTEGER","nullable":false,"meaning":"当日可见valid入口尝试数。","unit":"count","minimum":0}
{"kind":"field","table":"syn_daily_voice_experience","name":"wakeup_accepted_count","type":"INTEGER","nullable":false,"meaning":"被接受的入口数。","unit":"count","minimum":0}
{"kind":"field","table":"syn_daily_voice_experience","name":"wakeup_labeled_count","type":"INTEGER","nullable":false,"meaning":"有人工有效唤醒标签的尝试数。","unit":"count","minimum":0}
{"kind":"field","table":"syn_daily_voice_experience","name":"wakeup_false_accept_count","type":"INTEGER","nullable":false,"meaning":"标签为非有效唤醒但被接受的次数。","unit":"count","minimum":0}
{"kind":"field","table":"syn_daily_voice_experience","name":"turn_count","type":"INTEGER","nullable":false,"meaning":"当日开始的有效轮次数。","unit":"count","minimum":0}
{"kind":"field","table":"syn_daily_voice_experience","name":"eligible_turn_count","type":"INTEGER","nullable":false,"meaning":"completed/clarification_pending/rejected/failed/unknown轮次数。","unit":"count","minimum":0}
{"kind":"field","table":"syn_daily_voice_experience","name":"task_completed_count","type":"INTEGER","nullable":false,"meaning":"final_outcome=completed的轮次数，不代表标签正确或满意。","unit":"count","minimum":0}
{"kind":"field","table":"syn_daily_voice_experience","name":"clarification_count","type":"INTEGER","nullable":false,"meaning":"final_outcome=clarification_pending的轮次数。","unit":"count","minimum":0}
{"kind":"field","table":"syn_daily_voice_experience","name":"failed_turn_count","type":"INTEGER","nullable":false,"meaning":"final_outcome=failed次数。","unit":"count","minimum":0}
{"kind":"field","table":"syn_daily_voice_experience","name":"unknown_turn_count","type":"INTEGER","nullable":false,"meaning":"final_outcome=unknown次数。","unit":"count","minimum":0}
{"kind":"field","table":"syn_daily_voice_experience","name":"cancelled_turn_count","type":"INTEGER","nullable":false,"meaning":"cancelled次数，排除eligible。","unit":"count","minimum":0}
{"kind":"field","table":"syn_daily_voice_experience","name":"no_speech_turn_count","type":"INTEGER","nullable":false,"meaning":"no_speech次数，排除eligible。","unit":"count","minimum":0}
{"kind":"field","table":"syn_daily_voice_experience","name":"rejected_turn_count","type":"INTEGER","nullable":false,"meaning":"rejected次数，进入eligible。","unit":"count","minimum":0}
{"kind":"field","table":"syn_daily_voice_experience","name":"completed_latency_sum_ms","type":"INTEGER","nullable":false,"meaning":"completed轮次task_latency_ms合计。","unit":"ms","minimum":0}
{"kind":"field","table":"syn_daily_voice_experience","name":"completed_latency_samples","type":"INTEGER","nullable":false,"meaning":"completed且任务时延非空的样本数。","unit":"count","minimum":0}
{"kind":"field","table":"syn_daily_voice_experience","name":"first_audio_latency_sum_ms","type":"INTEGER","nullable":false,"meaning":"实际有首音的非空时延合计。","unit":"ms","minimum":0}
{"kind":"field","table":"syn_daily_voice_experience","name":"first_audio_samples","type":"INTEGER","nullable":false,"meaning":"实际有首音的样本数，不等于completed数。","unit":"count","minimum":0}
{"kind":"field","table":"syn_daily_voice_experience","name":"asr_labeled_turn_count","type":"INTEGER","nullable":false,"meaning":"eligible且reference_text非空的轮次数，含无预测的失败轮。","unit":"count","minimum":0}
{"kind":"field","table":"syn_daily_voice_experience","name":"asr_exact_match_count","type":"INTEGER","nullable":false,"meaning":"上述标签轮中最终选中归一化文本与参考归一化完全一致数。","unit":"count","minimum":0}
{"kind":"field","table":"syn_daily_voice_experience","name":"intent_labeled_turn_count","type":"INTEGER","nullable":false,"meaning":"eligible且reference_intent_id非空的轮次数，含没有预测的失败轮。","unit":"count","minimum":0}
{"kind":"field","table":"syn_daily_voice_experience","name":"intent_match_count","type":"INTEGER","nullable":false,"meaning":"上述标签轮中最终采用预测意图与人工标签相等数。","unit":"count","minimum":0}
{"kind":"field","table":"syn_daily_voice_experience","name":"feedback_count","type":"INTEGER","nullable":false,"meaning":"当日轮次获得可见valid明确反馈的数目。","unit":"count","minimum":0}
{"kind":"field","table":"syn_daily_voice_experience","name":"positive_feedback_count","type":"INTEGER","nullable":false,"meaning":"其中positive反馈数。","unit":"count","minimum":0}
{"kind":"field","table":"syn_daily_voice_experience","name":"playback_interruption_count","type":"INTEGER","nullable":false,"meaning":"当日轮次的实际播放打断事件数。","unit":"count","minimum":0}
{"kind":"field","table":"syn_daily_voice_experience","name":"snapshot_exclusive","type":"TEXT","nullable":false,"meaning":"本次汇总的排他快照上界。","unit":"UTC RFC3339 second"}
{"kind":"table","table":"syn_daily_stage_latency","label":"语音阶段日尝试汇总","grain":"一个轮次归属日、阶段、端云位置与build的统计","primary_key":["turn_date","stage","endpoint_kind","build_id"],"unique_keys":[],"description":"用于尝试负载和耗时均值，不能把attempt成功率当请求成功率；P95必须读取原始符合条件样本，不平均分组P95。","time_basis":"所有阶段按所属turn的started_at归属日。","checks":["attempt_count=succeeded_attempt_count+failed_attempt_count+timeout_attempt_count+cancelled_attempt_count+unknown_attempt_count+ambiguous_attempt_count+rejected_attempt_count","distinct_turn_count<=attempt_count","latency_samples<=attempt_count"],"time_columns":[{"column":"turn_date","role":"business"},{"column":"snapshot_exclusive","role":"snapshot"}],"default_filters":["snapshot_exclusive = '2026-10-04T00:00:00Z'"]}
{"kind":"field","table":"syn_daily_stage_latency","name":"turn_date","type":"TEXT","nullable":false,"meaning":"voice_turn.started_at的UTC日期。","unit":"UTC date"}
{"kind":"field","table":"syn_daily_stage_latency","name":"stage","type":"TEXT","nullable":false,"meaning":"可比的处理尝试阶段，VAD输入时长不混入。","enum":["asr","nlu","route","action","tts"]}
{"kind":"field","table":"syn_daily_stage_latency","name":"endpoint_kind","type":"TEXT","nullable":false,"meaning":"实际处理位置。","enum":["edge","cloud"]}
{"kind":"field","table":"syn_daily_stage_latency","name":"build_id","type":"TEXT","nullable":false,"meaning":"轮次会话冻结build。","references":{"table":"syn_software_build","column":"build_id"}}
{"kind":"field","table":"syn_daily_stage_latency","name":"attempt_count","type":"INTEGER","nullable":false,"meaning":"该阶段所有可见尝试数。","unit":"count","minimum":0}
{"kind":"field","table":"syn_daily_stage_latency","name":"distinct_turn_count","type":"INTEGER","nullable":false,"meaning":"这些尝试对应的去重轮次数。","unit":"count","minimum":0}
{"kind":"field","table":"syn_daily_stage_latency","name":"succeeded_attempt_count","type":"INTEGER","nullable":false,"meaning":"成功尝试数；route selected按成功记，action只看明确成功回执。","unit":"count","minimum":0}
{"kind":"field","table":"syn_daily_stage_latency","name":"failed_attempt_count","type":"INTEGER","nullable":false,"meaning":"明确失败尝试数。","unit":"count","minimum":0}
{"kind":"field","table":"syn_daily_stage_latency","name":"timeout_attempt_count","type":"INTEGER","nullable":false,"meaning":"超时尝试数。","unit":"count","minimum":0}
{"kind":"field","table":"syn_daily_stage_latency","name":"cancelled_attempt_count","type":"INTEGER","nullable":false,"meaning":"取消尝试数。","unit":"count","minimum":0}
{"kind":"field","table":"syn_daily_stage_latency","name":"unknown_attempt_count","type":"INTEGER","nullable":false,"meaning":"动作回执未知等未定状态数。","unit":"count","minimum":0}
{"kind":"field","table":"syn_daily_stage_latency","name":"ambiguous_attempt_count","type":"INTEGER","nullable":false,"meaning":"NLU歧义次数，不能算技术失败。","minimum":0,"unit":"count"}
{"kind":"field","table":"syn_daily_stage_latency","name":"rejected_attempt_count","type":"INTEGER","nullable":false,"meaning":"路由/动作被策略或前提拒绝的次数，不与执行失败混同。","minimum":0,"unit":"count"}
{"kind":"field","table":"syn_daily_stage_latency","name":"latency_sum_ms","type":"INTEGER","nullable":false,"meaning":"ASR/NLU/route/TTS用wall_ms；action用提交到最新明确回执的offset差；非空样本合计，不把unknown填0。","unit":"ms","minimum":0}
{"kind":"field","table":"syn_daily_stage_latency","name":"latency_samples","type":"INTEGER","nullable":false,"meaning":"非空耗时样本数。","unit":"count","minimum":0}
{"kind":"field","table":"syn_daily_stage_latency","name":"latency_min_ms","type":"INTEGER","nullable":true,"meaning":"非空耗时最小值，无样本NULL。","unit":"ms","minimum":0}
{"kind":"field","table":"syn_daily_stage_latency","name":"latency_max_ms","type":"INTEGER","nullable":true,"meaning":"非空耗时最大值，无样本NULL。","unit":"ms","minimum":0}
{"kind":"field","table":"syn_daily_stage_latency","name":"queued_sum_ms","type":"INTEGER","nullable":false,"meaning":"存在排队字段的ASR/NLU排队耗时合计，其他阶段0。","unit":"ms","minimum":0}
{"kind":"field","table":"syn_daily_stage_latency","name":"snapshot_exclusive","type":"TEXT","nullable":false,"meaning":"快照排他上界。","unit":"UTC RFC3339 second"}
{"kind":"table","table":"syn_daily_intent_outcome","label":"已选意图日结果汇总","grain":"一个轮次归属日、最终预测意图与build的统计","primary_key":["turn_date","intent_id","build_id"],"unique_keys":[],"description":"仅包含已有最终预测意图的轮次，不能把该表行数当全部语音输入，也不能单用它评估意图准确率（无预测的标签轮仍应进入正确率分母）。","time_basis":"turn_date；分类维度是最终预测意图。","checks":["selected_turn_count=task_completed_count+clarification_count+rejected_count+failed_count+cancelled_count+unknown_count+no_speech_count","confirmed_effect_count<=logical_action_count","positive_feedback_count<=feedback_count"],"time_columns":[{"column":"turn_date","role":"business"},{"column":"snapshot_exclusive","role":"snapshot"}],"default_filters":["snapshot_exclusive = '2026-10-04T00:00:00Z'"]}
{"kind":"field","table":"syn_daily_intent_outcome","name":"turn_date","type":"TEXT","nullable":false,"meaning":"voice_turn.started_at的UTC日期。","unit":"UTC date"}
{"kind":"field","table":"syn_daily_intent_outcome","name":"intent_id","type":"TEXT","nullable":false,"meaning":"最终被对话管理采用的预测意图，不是人工标签。","references":{"table":"syn_intent_catalog","column":"intent_id"}}
{"kind":"field","table":"syn_daily_intent_outcome","name":"capability_id","type":"TEXT","nullable":false,"meaning":"预测意图所属能力。","references":{"table":"syn_voice_capability","column":"capability_id"}}
{"kind":"field","table":"syn_daily_intent_outcome","name":"build_id","type":"TEXT","nullable":false,"meaning":"会话冻结build。","references":{"table":"syn_software_build","column":"build_id"}}
{"kind":"field","table":"syn_daily_intent_outcome","name":"selected_turn_count","type":"INTEGER","nullable":false,"meaning":"有该最终预测意图的轮次数。","unit":"count","minimum":0}
{"kind":"field","table":"syn_daily_intent_outcome","name":"task_completed_count","type":"INTEGER","nullable":false,"meaning":"其中任务completed数。","unit":"count","minimum":0}
{"kind":"field","table":"syn_daily_intent_outcome","name":"clarification_count","type":"INTEGER","nullable":false,"meaning":"其中需要澄清数。","unit":"count","minimum":0}
{"kind":"field","table":"syn_daily_intent_outcome","name":"rejected_count","type":"INTEGER","nullable":false,"meaning":"其中被拒绝数。","unit":"count","minimum":0}
{"kind":"field","table":"syn_daily_intent_outcome","name":"failed_count","type":"INTEGER","nullable":false,"meaning":"其中失败数。","unit":"count","minimum":0}
{"kind":"field","table":"syn_daily_intent_outcome","name":"cancelled_count","type":"INTEGER","nullable":false,"meaning":"其中取消数。","unit":"count","minimum":0}
{"kind":"field","table":"syn_daily_intent_outcome","name":"unknown_count","type":"INTEGER","nullable":false,"meaning":"其中结果未知数。","unit":"count","minimum":0}
{"kind":"field","table":"syn_daily_intent_outcome","name":"no_speech_count","type":"INTEGER","nullable":false,"meaning":"一般为0，保留最终状态分桶完整性。","unit":"count","minimum":0}
{"kind":"field","table":"syn_daily_intent_outcome","name":"logical_action_count","type":"INTEGER","nullable":false,"meaning":"关联的去重operation_key数，不把重试当新动作。","unit":"count","minimum":0}
{"kind":"field","table":"syn_daily_intent_outcome","name":"confirmed_effect_count","type":"INTEGER","nullable":false,"meaning":"其中有可见confirmed效果的去重operation_key数。","unit":"count","minimum":0}
{"kind":"field","table":"syn_daily_intent_outcome","name":"feedback_count","type":"INTEGER","nullable":false,"meaning":"可见明确反馈数。","unit":"count","minimum":0}
{"kind":"field","table":"syn_daily_intent_outcome","name":"positive_feedback_count","type":"INTEGER","nullable":false,"meaning":"positive数。","unit":"count","minimum":0}
{"kind":"field","table":"syn_daily_intent_outcome","name":"snapshot_exclusive","type":"TEXT","nullable":false,"meaning":"快照排他上界。","unit":"UTC RFC3339 second"}
{"kind":"metric","id":"active_voice_vehicles","name":"语音活跃车辆数","aliases":["语音活跃设备"],"tables":["syn_voice_turn","syn_voice_session","syn_vehicle"],"numerator":"COUNT(DISTINCT vehicle_id)","denominator":null,"unit":"vehicle","empty_or_zero_rule":"比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。","scope":"非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。","limitations":"跨日期/build去重不能直接相加。","description":"指标：语音活跃车辆数。\n分子：COUNT(DISTINCT vehicle_id)。\n分母：不适用；按指标公式取得计数或分布值。\n单位：vehicle。\n范围：非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。\n空值与零：比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。\n限制：跨日期/build去重不能直接相加。","sql":"WITH eligible_turns AS (\n    SELECT t.*, s.vehicle_id, s.build_id, s.policy_id\n    FROM syn_voice_turn t\n    JOIN syn_voice_session s ON s.session_id = t.session_id\n    JOIN syn_vehicle v ON v.vehicle_id = s.vehicle_id\n    WHERE v.is_lab_unit = 0 AND v.telemetry_consent = 1\n      AND s.quality_state = 'valid' AND s.is_complete = 1\n      AND t.quality_state = 'valid'\n      AND t.started_at >= :start AND t.started_at < :end\n      AND s.started_at < :snapshot AND s.ended_at < :snapshot\n      AND t.started_at < :snapshot AND t.finished_at < :snapshot\n      AND t.received_at < :snapshot AND s.received_at < :snapshot\n)\nSELECT COUNT(DISTINCT vehicle_id) AS active_voice_vehicles FROM eligible_turns;"}
{"kind":"metric","id":"valid_voice_turns","name":"有效语音交互轮次","aliases":["语音轮次数"],"tables":["syn_voice_turn"],"numerator":"COUNT(*)","denominator":null,"unit":"turn","empty_or_zero_rule":"比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。","scope":"非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。","limitations":"不把阶段attempt/候选/槽位当新用户请求。","description":"指标：有效语音交互轮次。\n分子：COUNT(*)。\n分母：不适用；按指标公式取得计数或分布值。\n单位：turn。\n范围：非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。\n空值与零：比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。\n限制：不把阶段attempt/候选/槽位当新用户请求。","sql":"WITH eligible_turns AS (\n    SELECT t.*, s.vehicle_id, s.build_id, s.policy_id\n    FROM syn_voice_turn t\n    JOIN syn_voice_session s ON s.session_id = t.session_id\n    JOIN syn_vehicle v ON v.vehicle_id = s.vehicle_id\n    WHERE v.is_lab_unit = 0 AND v.telemetry_consent = 1\n      AND s.quality_state = 'valid' AND s.is_complete = 1\n      AND t.quality_state = 'valid'\n      AND t.started_at >= :start AND t.started_at < :end\n      AND s.started_at < :snapshot AND s.ended_at < :snapshot\n      AND t.started_at < :snapshot AND t.finished_at < :snapshot\n      AND t.received_at < :snapshot AND s.received_at < :snapshot\n)\nSELECT COUNT(*) AS valid_voice_turns FROM eligible_turns;"}
{"kind":"metric","id":"wakeup_acceptance_rate","name":"入口接受率","aliases":["唤醒接受率"],"tables":["syn_wakeup_attempt"],"numerator":"accepted=1次数","denominator":"全部可见valid入口次数","unit":"ratio","empty_or_zero_rule":"比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。","scope":"按wakeup.started_at，默认非实验授权车辆。","limitations":"不是唤醒正确率；按键与唤醒词应分组。","description":"指标：入口接受率。\n分子：accepted=1次数。\n分母：全部可见valid入口次数。\n单位：ratio。\n范围：按wakeup.started_at，默认非实验授权车辆。\n空值与零：比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。\n限制：不是唤醒正确率；按键与唤醒词应分组。","sql":"WITH visible_wakeup AS (\n    SELECT w.* FROM syn_wakeup_attempt w\n    JOIN syn_vehicle v ON v.vehicle_id = w.vehicle_id\n    WHERE v.is_lab_unit = 0 AND v.telemetry_consent = 1\n      AND w.quality_state = 'valid'\n      AND w.started_at >= :start AND w.started_at < :end\n      AND w.started_at < :snapshot AND w.received_at < :snapshot\n)\nSELECT COUNT(*) AS attempts, COALESCE(SUM(accepted), 0) AS accepted_attempts,\n       CAST(SUM(accepted) AS REAL) / NULLIF(COUNT(*), 0) AS acceptance_rate\nFROM visible_wakeup;"}
{"kind":"metric","id":"wakeup_false_accept_rate","name":"有标签入口错误接受率","aliases":["合成误接受率"],"tables":["syn_wakeup_attempt"],"numerator":"reference_is_intended=0且accepted=1次数","denominator":"reference_is_intended=0次数","unit":"ratio","empty_or_zero_rule":"比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。","scope":"只取人工合成标签非空的valid入口。","limitations":"不代表真实音频误唤醒率；必须报告标签覆盖率。","description":"指标：有标签入口错误接受率。\n分子：reference_is_intended=0且accepted=1次数。\n分母：reference_is_intended=0次数。\n单位：ratio。\n范围：只取人工合成标签非空的valid入口。\n空值与零：比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。\n限制：不代表真实音频误唤醒率；必须报告标签覆盖率。","sql":"WITH visible_wakeup AS (\n    SELECT w.* FROM syn_wakeup_attempt w\n    JOIN syn_vehicle v ON v.vehicle_id = w.vehicle_id\n    WHERE v.is_lab_unit = 0 AND v.telemetry_consent = 1\n      AND w.quality_state = 'valid'\n      AND w.started_at >= :start AND w.started_at < :end\n      AND w.started_at < :snapshot AND w.received_at < :snapshot\n)\nSELECT COALESCE(SUM(CASE WHEN reference_is_intended = 0 AND accepted = 1 THEN 1 ELSE 0 END), 0) AS false_accepts,\n       COALESCE(SUM(CASE WHEN reference_is_intended = 0 THEN 1 ELSE 0 END), 0) AS unintended_labeled_attempts,\n       CAST(SUM(CASE WHEN reference_is_intended = 0 AND accepted = 1 THEN 1 ELSE 0 END) AS REAL)\n         / NULLIF(SUM(CASE WHEN reference_is_intended = 0 THEN 1 ELSE 0 END), 0) AS false_accept_rate\nFROM visible_wakeup;"}
{"kind":"metric","id":"wakeup_label_coverage","name":"入口标签覆盖率","aliases":["唤醒标签覆盖率"],"tables":["syn_wakeup_attempt"],"numerator":"reference_is_intended非空次数","denominator":"全部可见valid入口次数","unit":"ratio","empty_or_zero_rule":"比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。","scope":"按wakeup.started_at。","limitations":"无标签不能被当作负标签。","description":"指标：入口标签覆盖率。\n分子：reference_is_intended非空次数。\n分母：全部可见valid入口次数。\n单位：ratio。\n范围：按wakeup.started_at。\n空值与零：比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。\n限制：无标签不能被当作负标签。","sql":"WITH visible_wakeup AS (\n    SELECT w.* FROM syn_wakeup_attempt w\n    JOIN syn_vehicle v ON v.vehicle_id = w.vehicle_id\n    WHERE v.is_lab_unit = 0 AND v.telemetry_consent = 1\n      AND w.quality_state = 'valid'\n      AND w.started_at >= :start AND w.started_at < :end\n      AND w.started_at < :snapshot AND w.received_at < :snapshot\n)\nSELECT COUNT(reference_is_intended) AS labeled_attempts, COUNT(*) AS attempts,\n       CAST(COUNT(reference_is_intended) AS REAL) / NULLIF(COUNT(*), 0) AS label_coverage\nFROM visible_wakeup;"}
{"kind":"metric","id":"task_completion_rate","name":"语音任务达成率","aliases":["语音任务成功率"],"tables":["syn_voice_turn","syn_daily_voice_experience"],"numerator":"task_completed_count","denominator":"eligible_turn_count","unit":"ratio","empty_or_zero_rule":"比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。","scope":"非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。 eligible=completed/clarification_pending/rejected/failed/unknown，排除cancelled/no_speech。 当前日表SQL仅接受:start与:end均为UTC整日边界的半开区间；小时或其他非整日范围必须从原始事实按同口径重算，不能截去时分秒。","limitations":"是执行链终态，不证明意图正确、播报成功或用户满意。 日表SQL以HAVING核对整日参数，不合要求时不返回统计行，不把它解释成零样本。","description":"指标：语音任务达成率。\n分子：task_completed_count。\n分母：eligible_turn_count。\n单位：ratio。\n范围：非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。 eligible=completed/clarification_pending/rejected/failed/unknown，排除cancelled/no_speech。 当前日表SQL仅接受:start与:end均为UTC整日边界的半开区间；小时或其他非整日范围必须从原始事实按同口径重算，不能截去时分秒。\n空值与零：比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。\n限制：是执行链终态，不证明意图正确、播报成功或用户满意。 日表SQL以HAVING核对整日参数，不合要求时不返回统计行，不把它解释成零样本。","sql":"SELECT COALESCE(SUM(task_completed_count), 0) AS numerator, COALESCE(SUM(eligible_turn_count), 0) AS denominator,\n       CAST(SUM(task_completed_count) AS REAL) / NULLIF(SUM(eligible_turn_count), 0) AS task_completion_rate\nFROM syn_daily_voice_experience\nWHERE snapshot_exclusive = :snapshot\n  AND activity_date >= substr(:start, 1, 10)\n  AND activity_date < substr(:end, 1, 10)\nHAVING :start = substr(:start, 1, 10) || 'T00:00:00Z'\n  AND :end = substr(:end, 1, 10) || 'T00:00:00Z'\n  AND :start < :end;","structure":{"kind":"metric","table":{"object_id":"table-syn_daily_voice_experience","version":"1"},"expression":"CAST(SUM(task_completed_count) AS REAL) / NULLIF(SUM(eligible_turn_count), 0)","input_grain":"按列所属业务日、车辆、冻结build的并列日计数；当前指标按turn日","time_column":"activity_date","unit":"ratio","required_filters":["snapshot_exclusive = :snapshot",":start = substr(:start, 1, 10) || 'T00:00:00Z'",":end = substr(:end, 1, 10) || 'T00:00:00Z'",":start < :end"],"dimensions":["vehicle_id","build_id"]}}
{"kind":"metric","id":"clarification_rate","name":"请求澄清比例","aliases":["缺槽澄清率"],"tables":["syn_voice_turn","syn_daily_voice_experience"],"numerator":"clarification_count","denominator":"eligible_turn_count","unit":"ratio","empty_or_zero_rule":"比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。","scope":"非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。 当前日表SQL仅接受:start与:end均为UTC整日边界的半开区间；小时或其他非整日范围必须从原始事实按同口径重算，不能截去时分秒。","limitations":"澄清不是技术失败，但本轮尚未完成目标。 日表SQL以HAVING核对整日参数，不合要求时不返回统计行，不把它解释成零样本。","description":"指标：请求澄清比例。\n分子：clarification_count。\n分母：eligible_turn_count。\n单位：ratio。\n范围：非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。 当前日表SQL仅接受:start与:end均为UTC整日边界的半开区间；小时或其他非整日范围必须从原始事实按同口径重算，不能截去时分秒。\n空值与零：比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。\n限制：澄清不是技术失败，但本轮尚未完成目标。 日表SQL以HAVING核对整日参数，不合要求时不返回统计行，不把它解释成零样本。","sql":"SELECT COALESCE(SUM(clarification_count), 0) AS numerator, COALESCE(SUM(eligible_turn_count), 0) AS denominator,\n       CAST(SUM(clarification_count) AS REAL) / NULLIF(SUM(eligible_turn_count), 0) AS clarification_rate\nFROM syn_daily_voice_experience\nWHERE snapshot_exclusive = :snapshot\n  AND activity_date >= substr(:start, 1, 10)\n  AND activity_date < substr(:end, 1, 10)\nHAVING :start = substr(:start, 1, 10) || 'T00:00:00Z'\n  AND :end = substr(:end, 1, 10) || 'T00:00:00Z'\n  AND :start < :end;","structure":{"kind":"metric","table":{"object_id":"table-syn_daily_voice_experience","version":"1"},"expression":"CAST(SUM(clarification_count) AS REAL) / NULLIF(SUM(eligible_turn_count), 0)","input_grain":"按列所属业务日、车辆、冻结build的并列日计数；当前指标按turn日","time_column":"activity_date","unit":"ratio","required_filters":["snapshot_exclusive = :snapshot",":start = substr(:start, 1, 10) || 'T00:00:00Z'",":end = substr(:end, 1, 10) || 'T00:00:00Z'",":start < :end"],"dimensions":["vehicle_id","build_id"]}}
{"kind":"metric","id":"asr_exact_match_rate","name":"有标签转写一致率","aliases":["合成转写一致率"],"tables":["syn_voice_turn","syn_asr_hypothesis","syn_daily_voice_experience"],"numerator":"asr_exact_match_count","denominator":"asr_labeled_turn_count","unit":"ratio","empty_or_zero_rule":"比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。","scope":"非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。 eligible且reference_text非空，未生成最终预测也保留在分母。 当前日表SQL仅接受:start与:end均为UTC整日边界的半开区间；小时或其他非整日范围必须从原始事实按同口径重算，不能截去时分秒。","limitations":"本包只定义人工合成标签子集的规范化逐字一致，未定义CER/WER，不代表真实声学准确率。 日表SQL以HAVING核对整日参数，不合要求时不返回统计行，不把它解释成零样本。","description":"指标：有标签转写一致率。\n分子：asr_exact_match_count。\n分母：asr_labeled_turn_count。\n单位：ratio。\n范围：非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。 eligible且reference_text非空，未生成最终预测也保留在分母。 当前日表SQL仅接受:start与:end均为UTC整日边界的半开区间；小时或其他非整日范围必须从原始事实按同口径重算，不能截去时分秒。\n空值与零：比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。\n限制：本包只定义人工合成标签子集的规范化逐字一致，未定义CER/WER，不代表真实声学准确率。 日表SQL以HAVING核对整日参数，不合要求时不返回统计行，不把它解释成零样本。","sql":"SELECT COALESCE(SUM(asr_exact_match_count), 0) AS numerator, COALESCE(SUM(asr_labeled_turn_count), 0) AS denominator,\n       CAST(SUM(asr_exact_match_count) AS REAL) / NULLIF(SUM(asr_labeled_turn_count), 0) AS asr_exact_match_rate\nFROM syn_daily_voice_experience\nWHERE snapshot_exclusive = :snapshot\n  AND activity_date >= substr(:start, 1, 10)\n  AND activity_date < substr(:end, 1, 10)\nHAVING :start = substr(:start, 1, 10) || 'T00:00:00Z'\n  AND :end = substr(:end, 1, 10) || 'T00:00:00Z'\n  AND :start < :end;","structure":{"kind":"metric","table":{"object_id":"table-syn_daily_voice_experience","version":"1"},"expression":"CAST(SUM(asr_exact_match_count) AS REAL) / NULLIF(SUM(asr_labeled_turn_count), 0)","input_grain":"按列所属业务日、车辆、冻结build的并列日计数；当前指标按turn日","time_column":"activity_date","unit":"ratio","required_filters":["snapshot_exclusive = :snapshot",":start = substr(:start, 1, 10) || 'T00:00:00Z'",":end = substr(:end, 1, 10) || 'T00:00:00Z'",":start < :end"],"dimensions":["vehicle_id","build_id"]}}
{"kind":"metric","id":"asr_label_coverage","name":"转写标签覆盖率","aliases":["ASR标签覆盖率"],"tables":["syn_daily_voice_experience"],"numerator":"asr_labeled_turn_count","denominator":"eligible_turn_count","unit":"ratio","empty_or_zero_rule":"比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。","scope":"非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。 当前日表SQL仅接受:start与:end均为UTC整日边界的半开区间；小时或其他非整日范围必须从原始事实按同口径重算，不能截去时分秒。","limitations":"预测不能填充缺失人工标签。 日表SQL以HAVING核对整日参数，不合要求时不返回统计行，不把它解释成零样本。","description":"指标：转写标签覆盖率。\n分子：asr_labeled_turn_count。\n分母：eligible_turn_count。\n单位：ratio。\n范围：非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。 当前日表SQL仅接受:start与:end均为UTC整日边界的半开区间；小时或其他非整日范围必须从原始事实按同口径重算，不能截去时分秒。\n空值与零：比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。\n限制：预测不能填充缺失人工标签。 日表SQL以HAVING核对整日参数，不合要求时不返回统计行，不把它解释成零样本。","sql":"SELECT COALESCE(SUM(asr_labeled_turn_count), 0) AS numerator, COALESCE(SUM(eligible_turn_count), 0) AS denominator,\n       CAST(SUM(asr_labeled_turn_count) AS REAL) / NULLIF(SUM(eligible_turn_count), 0) AS asr_label_coverage\nFROM syn_daily_voice_experience\nWHERE snapshot_exclusive = :snapshot\n  AND activity_date >= substr(:start, 1, 10)\n  AND activity_date < substr(:end, 1, 10)\nHAVING :start = substr(:start, 1, 10) || 'T00:00:00Z'\n  AND :end = substr(:end, 1, 10) || 'T00:00:00Z'\n  AND :start < :end;","structure":{"kind":"metric","table":{"object_id":"table-syn_daily_voice_experience","version":"1"},"expression":"CAST(SUM(asr_labeled_turn_count) AS REAL) / NULLIF(SUM(eligible_turn_count), 0)","input_grain":"按列所属业务日、车辆、冻结build的并列日计数；当前指标按turn日","time_column":"activity_date","unit":"ratio","required_filters":["snapshot_exclusive = :snapshot",":start = substr(:start, 1, 10) || 'T00:00:00Z'",":end = substr(:end, 1, 10) || 'T00:00:00Z'",":start < :end"],"dimensions":["vehicle_id","build_id"]}}
{"kind":"metric","id":"intent_match_rate","name":"有标签意图一致率","aliases":["合成意图准确率"],"tables":["syn_voice_turn","syn_nlu_attempt","syn_daily_voice_experience"],"numerator":"intent_match_count","denominator":"reference_intent_id非空的eligible轮次数","unit":"ratio","empty_or_zero_rule":"比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。","scope":"非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。 reference_intent_id非空，未预测也保留在分母。 当前日表SQL仅接受:start与:end均为UTC整日边界的半开区间；小时或其他非整日范围必须从原始事实按同口径重算，不能截去时分秒。 eligible仅含completed、clarification_pending、rejected、failed、unknown；排除cancelled与no_speech。","limitations":"只比较最终采用意图，不把最高置信或第一个成功结果当最终结果。 日表SQL以HAVING核对整日参数，不合要求时不返回统计行，不把它解释成零样本。","description":"指标：有标签意图一致率。\n分子：intent_match_count。\n分母：reference_intent_id非空的eligible轮次数。\n单位：ratio。\n范围：非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。 reference_intent_id非空，未预测也保留在分母。 当前日表SQL仅接受:start与:end均为UTC整日边界的半开区间；小时或其他非整日范围必须从原始事实按同口径重算，不能截去时分秒。 eligible仅含completed、clarification_pending、rejected、failed、unknown；排除cancelled与no_speech。\n空值与零：比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。\n限制：只比较最终采用意图，不把最高置信或第一个成功结果当最终结果。 日表SQL以HAVING核对整日参数，不合要求时不返回统计行，不把它解释成零样本。","sql":"SELECT COALESCE(SUM(intent_match_count), 0) AS numerator, COALESCE(SUM(intent_labeled_turn_count), 0) AS denominator,\n       CAST(SUM(intent_match_count) AS REAL) / NULLIF(SUM(intent_labeled_turn_count), 0) AS intent_match_rate\nFROM syn_daily_voice_experience\nWHERE snapshot_exclusive = :snapshot\n  AND activity_date >= substr(:start, 1, 10)\n  AND activity_date < substr(:end, 1, 10)\nHAVING :start = substr(:start, 1, 10) || 'T00:00:00Z'\n  AND :end = substr(:end, 1, 10) || 'T00:00:00Z'\n  AND :start < :end;","structure":{"kind":"metric","table":{"object_id":"table-syn_daily_voice_experience","version":"1"},"expression":"CAST(SUM(intent_match_count) AS REAL) / NULLIF(SUM(intent_labeled_turn_count), 0)","input_grain":"按列所属业务日、车辆、冻结build的并列日计数；当前指标按turn日","time_column":"activity_date","unit":"ratio","required_filters":["snapshot_exclusive = :snapshot",":start = substr(:start, 1, 10) || 'T00:00:00Z'",":end = substr(:end, 1, 10) || 'T00:00:00Z'",":start < :end"],"dimensions":["vehicle_id","build_id"]}}
{"kind":"metric","id":"intent_label_coverage","name":"意图标签覆盖率","aliases":["NLU标签覆盖率"],"tables":["syn_daily_voice_experience"],"numerator":"intent_labeled_turn_count","denominator":"eligible_turn_count","unit":"ratio","empty_or_zero_rule":"比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。","scope":"非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。 当前日表SQL仅接受:start与:end均为UTC整日边界的半开区间；小时或其他非整日范围必须从原始事实按同口径重算，不能截去时分秒。","limitations":"没有标签的轮次不进入一致率。 日表SQL以HAVING核对整日参数，不合要求时不返回统计行，不把它解释成零样本。","description":"指标：意图标签覆盖率。\n分子：intent_labeled_turn_count。\n分母：eligible_turn_count。\n单位：ratio。\n范围：非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。 当前日表SQL仅接受:start与:end均为UTC整日边界的半开区间；小时或其他非整日范围必须从原始事实按同口径重算，不能截去时分秒。\n空值与零：比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。\n限制：没有标签的轮次不进入一致率。 日表SQL以HAVING核对整日参数，不合要求时不返回统计行，不把它解释成零样本。","sql":"SELECT COALESCE(SUM(intent_labeled_turn_count), 0) AS numerator, COALESCE(SUM(eligible_turn_count), 0) AS denominator,\n       CAST(SUM(intent_labeled_turn_count) AS REAL) / NULLIF(SUM(eligible_turn_count), 0) AS intent_label_coverage\nFROM syn_daily_voice_experience\nWHERE snapshot_exclusive = :snapshot\n  AND activity_date >= substr(:start, 1, 10)\n  AND activity_date < substr(:end, 1, 10)\nHAVING :start = substr(:start, 1, 10) || 'T00:00:00Z'\n  AND :end = substr(:end, 1, 10) || 'T00:00:00Z'\n  AND :start < :end;","structure":{"kind":"metric","table":{"object_id":"table-syn_daily_voice_experience","version":"1"},"expression":"CAST(SUM(intent_labeled_turn_count) AS REAL) / NULLIF(SUM(eligible_turn_count), 0)","input_grain":"按列所属业务日、车辆、冻结build的并列日计数；当前指标按turn日","time_column":"activity_date","unit":"ratio","required_filters":["snapshot_exclusive = :snapshot",":start = substr(:start, 1, 10) || 'T00:00:00Z'",":end = substr(:end, 1, 10) || 'T00:00:00Z'",":start < :end"],"dimensions":["vehicle_id","build_id"]}}
{"kind":"metric","id":"asr_retry_turn_rate","name":"ASR重试轮次占比","aliases":["识别重试率"],"tables":["syn_asr_attempt","syn_voice_turn"],"numerator":"存在attempt_no>1的去重turn数","denominator":"有ASR尝试的去重turn数","unit":"ratio","empty_or_zero_rule":"比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。","scope":"非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。","limitations":"一次轮次多次重试只计一次分子。","description":"指标：ASR重试轮次占比。\n分子：存在attempt_no>1的去重turn数。\n分母：有ASR尝试的去重turn数。\n单位：ratio。\n范围：非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。\n空值与零：比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。\n限制：一次轮次多次重试只计一次分子。","sql":"WITH eligible_turns AS (\n    SELECT t.*, s.vehicle_id, s.build_id, s.policy_id\n    FROM syn_voice_turn t\n    JOIN syn_voice_session s ON s.session_id = t.session_id\n    JOIN syn_vehicle v ON v.vehicle_id = s.vehicle_id\n    WHERE v.is_lab_unit = 0 AND v.telemetry_consent = 1\n      AND s.quality_state = 'valid' AND s.is_complete = 1\n      AND t.quality_state = 'valid'\n      AND t.started_at >= :start AND t.started_at < :end\n      AND s.started_at < :snapshot AND s.ended_at < :snapshot\n      AND t.started_at < :snapshot AND t.finished_at < :snapshot\n      AND t.received_at < :snapshot AND s.received_at < :snapshot\n), per_turn AS (\n    SELECT a.turn_id, MAX(CASE WHEN a.attempt_no > 1 THEN 1 ELSE 0 END) AS matched\n    FROM syn_asr_attempt a JOIN eligible_turns t ON t.turn_id = a.turn_id\n    WHERE a.received_at < :snapshot GROUP BY a.turn_id\n)\nSELECT COALESCE(SUM(matched), 0) AS matched_turns, COUNT(*) AS attempted_turns,\n       CAST(SUM(matched) AS REAL) / NULLIF(COUNT(*), 0) AS asr_retry_turn_rate\nFROM per_turn;"}
{"kind":"metric","id":"edge_fallback_turn_rate","name":"端侧回退轮次占比","aliases":["端云回退率"],"tables":["syn_asr_attempt","syn_voice_turn"],"numerator":"出现fallback_reason非none且endpoint=edge的去重turn数","denominator":"有ASR尝试的去重turn数","unit":"ratio","empty_or_zero_rule":"比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。","scope":"非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。","limitations":"回退发生不等于回退成功，仍核对final_outcome。","description":"指标：端侧回退轮次占比。\n分子：出现fallback_reason非none且endpoint=edge的去重turn数。\n分母：有ASR尝试的去重turn数。\n单位：ratio。\n范围：非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。\n空值与零：比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。\n限制：回退发生不等于回退成功，仍核对final_outcome。","sql":"WITH eligible_turns AS (\n    SELECT t.*, s.vehicle_id, s.build_id, s.policy_id\n    FROM syn_voice_turn t\n    JOIN syn_voice_session s ON s.session_id = t.session_id\n    JOIN syn_vehicle v ON v.vehicle_id = s.vehicle_id\n    WHERE v.is_lab_unit = 0 AND v.telemetry_consent = 1\n      AND s.quality_state = 'valid' AND s.is_complete = 1\n      AND t.quality_state = 'valid'\n      AND t.started_at >= :start AND t.started_at < :end\n      AND s.started_at < :snapshot AND s.ended_at < :snapshot\n      AND t.started_at < :snapshot AND t.finished_at < :snapshot\n      AND t.received_at < :snapshot AND s.received_at < :snapshot\n), per_turn AS (\n    SELECT a.turn_id, MAX(CASE WHEN a.endpoint_kind = 'edge' AND a.fallback_reason <> 'none' THEN 1 ELSE 0 END) AS matched\n    FROM syn_asr_attempt a JOIN eligible_turns t ON t.turn_id = a.turn_id\n    WHERE a.received_at < :snapshot GROUP BY a.turn_id\n)\nSELECT COALESCE(SUM(matched), 0) AS matched_turns, COUNT(*) AS attempted_turns,\n       CAST(SUM(matched) AS REAL) / NULLIF(COUNT(*), 0) AS edge_fallback_turn_rate\nFROM per_turn;"}
{"kind":"metric","id":"completed_task_mean_ms","name":"已达成任务平均响应耗时","aliases":["任务平均响应耗时"],"tables":["syn_daily_voice_experience"],"numerator":"SUM(completed_latency_sum_ms)","denominator":"SUM(completed_latency_samples)","unit":"ms","empty_or_zero_rule":"比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。","scope":"非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。 只取completed。 当前日表SQL仅接受:start与:end均为UTC整日边界的半开区间；小时或其他非整日范围必须从原始事实按同口径重算，不能截去时分秒。","limitations":"从用户输入结束计，不包含input_ms；不能平均分组均值。 日表SQL以HAVING核对整日参数，不合要求时不返回统计行，不把它解释成零样本。","description":"指标：已达成任务平均响应耗时。\n分子：SUM(completed_latency_sum_ms)。\n分母：SUM(completed_latency_samples)。\n单位：ms。\n范围：非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。 只取completed。 当前日表SQL仅接受:start与:end均为UTC整日边界的半开区间；小时或其他非整日范围必须从原始事实按同口径重算，不能截去时分秒。\n空值与零：比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。\n限制：从用户输入结束计，不包含input_ms；不能平均分组均值。 日表SQL以HAVING核对整日参数，不合要求时不返回统计行，不把它解释成零样本。","sql":"SELECT COALESCE(SUM(completed_latency_sum_ms), 0) AS numerator, COALESCE(SUM(completed_latency_samples), 0) AS denominator,\n       CAST(SUM(completed_latency_sum_ms) AS REAL) / NULLIF(SUM(completed_latency_samples), 0) AS completed_task_mean_ms\nFROM syn_daily_voice_experience\nWHERE snapshot_exclusive = :snapshot\n  AND activity_date >= substr(:start, 1, 10)\n  AND activity_date < substr(:end, 1, 10)\nHAVING :start = substr(:start, 1, 10) || 'T00:00:00Z'\n  AND :end = substr(:end, 1, 10) || 'T00:00:00Z'\n  AND :start < :end;","structure":{"kind":"metric","table":{"object_id":"table-syn_daily_voice_experience","version":"1"},"expression":"CAST(SUM(completed_latency_sum_ms) AS REAL) / NULLIF(SUM(completed_latency_samples), 0)","input_grain":"按列所属业务日、车辆、冻结build的并列日计数；当前指标按turn日","time_column":"activity_date","unit":"ms","required_filters":["snapshot_exclusive = :snapshot",":start = substr(:start, 1, 10) || 'T00:00:00Z'",":end = substr(:end, 1, 10) || 'T00:00:00Z'",":start < :end"],"dimensions":["vehicle_id","build_id"]}}
{"kind":"metric","id":"completed_task_p95_ms","name":"已达成任务P95耗时","aliases":["任务响应P95"],"tables":["syn_voice_turn"],"numerator":"原始completed task_latency_ms最近秩ceil(0.95*N)值","denominator":null,"unit":"ms","empty_or_zero_rule":"比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。","scope":"非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。 只取completed且非空样本。","limitations":"原始样本最近秩，不平均组P95，不用阶段时长相加代替。","description":"指标：已达成任务P95耗时。\n分子：原始completed task_latency_ms最近秩ceil(0.95*N)值。\n分母：不适用；按指标公式取得计数或分布值。\n单位：ms。\n范围：非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。 只取completed且非空样本。\n空值与零：比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。\n限制：原始样本最近秩，不平均组P95，不用阶段时长相加代替。","sql":"WITH eligible_turns AS (\n    SELECT t.*, s.vehicle_id, s.build_id, s.policy_id\n    FROM syn_voice_turn t\n    JOIN syn_voice_session s ON s.session_id = t.session_id\n    JOIN syn_vehicle v ON v.vehicle_id = s.vehicle_id\n    WHERE v.is_lab_unit = 0 AND v.telemetry_consent = 1\n      AND s.quality_state = 'valid' AND s.is_complete = 1\n      AND t.quality_state = 'valid'\n      AND t.started_at >= :start AND t.started_at < :end\n      AND s.started_at < :snapshot AND s.ended_at < :snapshot\n      AND t.started_at < :snapshot AND t.finished_at < :snapshot\n      AND t.received_at < :snapshot AND s.received_at < :snapshot\n), ranked AS (\n    SELECT task_latency_ms AS latency_ms,\n           ROW_NUMBER() OVER (ORDER BY task_latency_ms, turn_id) AS rn,\n           COUNT(*) OVER () AS n\n    FROM eligible_turns WHERE final_outcome = 'completed' AND task_latency_ms IS NOT NULL\n)\nSELECT COUNT(*) AS sample_count,\n       MAX(CASE WHEN rn = (95 * n + 99) / 100 THEN latency_ms END) AS completed_task_p95_ms\nFROM ranked;"}
{"kind":"metric","id":"first_audio_p95_ms","name":"有首音轮次P95时延","aliases":["首音P95"],"tables":["syn_voice_turn","syn_playback_segment"],"numerator":"原始first_audio_latency_ms最近秩ceil(0.95*N)值","denominator":null,"unit":"ms","empty_or_zero_rule":"比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。","scope":"非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。 仅实际有首音者，另报告首音覆盖率。","limitations":"首音来自playback开始，不是TTS请求开始或首包；澄清提示也可有首音。","description":"指标：有首音轮次P95时延。\n分子：原始first_audio_latency_ms最近秩ceil(0.95*N)值。\n分母：不适用；按指标公式取得计数或分布值。\n单位：ms。\n范围：非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。 仅实际有首音者，另报告首音覆盖率。\n空值与零：比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。\n限制：首音来自playback开始，不是TTS请求开始或首包；澄清提示也可有首音。","sql":"WITH eligible_turns AS (\n    SELECT t.*, s.vehicle_id, s.build_id, s.policy_id\n    FROM syn_voice_turn t\n    JOIN syn_voice_session s ON s.session_id = t.session_id\n    JOIN syn_vehicle v ON v.vehicle_id = s.vehicle_id\n    WHERE v.is_lab_unit = 0 AND v.telemetry_consent = 1\n      AND s.quality_state = 'valid' AND s.is_complete = 1\n      AND t.quality_state = 'valid'\n      AND t.started_at >= :start AND t.started_at < :end\n      AND s.started_at < :snapshot AND s.ended_at < :snapshot\n      AND t.started_at < :snapshot AND t.finished_at < :snapshot\n      AND t.received_at < :snapshot AND s.received_at < :snapshot\n), ranked AS (\n    SELECT first_audio_latency_ms AS latency_ms,\n           ROW_NUMBER() OVER (ORDER BY first_audio_latency_ms, turn_id) AS rn,\n           COUNT(*) OVER () AS n\n    FROM eligible_turns WHERE first_audio_latency_ms IS NOT NULL\n)\nSELECT COUNT(*) AS sample_count,\n       MAX(CASE WHEN rn = (95 * n + 99) / 100 THEN latency_ms END) AS first_audio_p95_ms\nFROM ranked;"}
{"kind":"metric","id":"first_audio_coverage","name":"首音覆盖率","aliases":["有播报轮次占比"],"tables":["syn_daily_voice_experience"],"numerator":"first_audio_samples","denominator":"turn_count","unit":"ratio","empty_or_zero_rule":"比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。","scope":"非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。 当前日表SQL仅接受:start与:end均为UTC整日边界的半开区间；小时或其他非整日范围必须从原始事实按同口径重算，不能截去时分秒。","limitations":"无首音不能填0混入时延分布。 日表SQL以HAVING核对整日参数，不合要求时不返回统计行，不把它解释成零样本。","description":"指标：首音覆盖率。\n分子：first_audio_samples。\n分母：turn_count。\n单位：ratio。\n范围：非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。 当前日表SQL仅接受:start与:end均为UTC整日边界的半开区间；小时或其他非整日范围必须从原始事实按同口径重算，不能截去时分秒。\n空值与零：比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。\n限制：无首音不能填0混入时延分布。 日表SQL以HAVING核对整日参数，不合要求时不返回统计行，不把它解释成零样本。","sql":"SELECT COALESCE(SUM(first_audio_samples), 0) AS numerator, COALESCE(SUM(turn_count), 0) AS denominator,\n       CAST(SUM(first_audio_samples) AS REAL) / NULLIF(SUM(turn_count), 0) AS first_audio_coverage\nFROM syn_daily_voice_experience\nWHERE snapshot_exclusive = :snapshot\n  AND activity_date >= substr(:start, 1, 10)\n  AND activity_date < substr(:end, 1, 10)\nHAVING :start = substr(:start, 1, 10) || 'T00:00:00Z'\n  AND :end = substr(:end, 1, 10) || 'T00:00:00Z'\n  AND :start < :end;","structure":{"kind":"metric","table":{"object_id":"table-syn_daily_voice_experience","version":"1"},"expression":"CAST(SUM(first_audio_samples) AS REAL) / NULLIF(SUM(turn_count), 0)","input_grain":"按列所属业务日、车辆、冻结build的并列日计数；当前指标按turn日","time_column":"activity_date","unit":"ratio","required_filters":["snapshot_exclusive = :snapshot",":start = substr(:start, 1, 10) || 'T00:00:00Z'",":end = substr(:end, 1, 10) || 'T00:00:00Z'",":start < :end"],"dimensions":["vehicle_id","build_id"]}}
{"kind":"metric","id":"stage_attempt_success_rate","name":"阶段尝试成功率","aliases":["阶段成功率"],"tables":["syn_daily_stage_latency"],"numerator":"succeeded_attempt_count","denominator":"attempt_count","unit":"ratio","empty_or_zero_rule":"比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。","scope":"非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。 必须限定stage并分端云。 当前日表SQL仅接受:start与:end均为UTC整日边界的半开区间；小时或其他非整日范围必须从原始事实按同口径重算，不能截去时分秒。","limitations":"含timeout/cancelled/unknown在attempt分母；不是用户任务成功率。 日表SQL以HAVING核对整日参数，不合要求时不返回统计行，不把它解释成零样本。","description":"指标：阶段尝试成功率。\n分子：succeeded_attempt_count。\n分母：attempt_count。\n单位：ratio。\n范围：非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。 必须限定stage并分端云。 当前日表SQL仅接受:start与:end均为UTC整日边界的半开区间；小时或其他非整日范围必须从原始事实按同口径重算，不能截去时分秒。\n空值与零：比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。\n限制：含timeout/cancelled/unknown在attempt分母；不是用户任务成功率。 日表SQL以HAVING核对整日参数，不合要求时不返回统计行，不把它解释成零样本。","sql":"SELECT stage, endpoint_kind, SUM(succeeded_attempt_count) AS numerator, SUM(attempt_count) AS denominator,\n       CAST(SUM(succeeded_attempt_count) AS REAL) / NULLIF(SUM(attempt_count), 0) AS stage_attempt_success_rate\nFROM syn_daily_stage_latency\nWHERE snapshot_exclusive = :snapshot\n  AND turn_date >= substr(:start, 1, 10)\n  AND turn_date < substr(:end, 1, 10)\nGROUP BY stage, endpoint_kind\nHAVING :start = substr(:start, 1, 10) || 'T00:00:00Z'\n  AND :end = substr(:end, 1, 10) || 'T00:00:00Z'\n  AND :start < :end\nORDER BY stage, endpoint_kind;","structure":{"kind":"metric","table":{"object_id":"table-syn_daily_stage_latency","version":"1"},"expression":"CAST(SUM(succeeded_attempt_count) AS REAL) / NULLIF(SUM(attempt_count), 0)","input_grain":"一个轮次归属日、阶段、端云位置与build的统计","time_column":"turn_date","unit":"ratio","required_filters":["snapshot_exclusive = :snapshot",":start = substr(:start, 1, 10) || 'T00:00:00Z'",":end = substr(:end, 1, 10) || 'T00:00:00Z'",":start < :end"],"dimensions":["stage","endpoint_kind","build_id"]}}
{"kind":"metric","id":"stage_mean_ms","name":"阶段尝试平均耗时","aliases":["阶段平均耗时"],"tables":["syn_daily_stage_latency"],"numerator":"SUM(latency_sum_ms)","denominator":"SUM(latency_samples)","unit":"ms","empty_or_zero_rule":"比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。","scope":"非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。 按stage/endpoint解释。 当前日表SQL仅接受:start与:end均为UTC整日边界的半开区间；小时或其他非整日范围必须从原始事实按同口径重算，不能截去时分秒。","limitations":"只对非空耗时样本，未知耗时不填0。 日表SQL以HAVING核对整日参数，不合要求时不返回统计行，不把它解释成零样本。","description":"指标：阶段尝试平均耗时。\n分子：SUM(latency_sum_ms)。\n分母：SUM(latency_samples)。\n单位：ms。\n范围：非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。 按stage/endpoint解释。 当前日表SQL仅接受:start与:end均为UTC整日边界的半开区间；小时或其他非整日范围必须从原始事实按同口径重算，不能截去时分秒。\n空值与零：比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。\n限制：只对非空耗时样本，未知耗时不填0。 日表SQL以HAVING核对整日参数，不合要求时不返回统计行，不把它解释成零样本。","sql":"SELECT stage, endpoint_kind, SUM(latency_sum_ms) AS numerator, SUM(latency_samples) AS denominator,\n       CAST(SUM(latency_sum_ms) AS REAL) / NULLIF(SUM(latency_samples), 0) AS stage_mean_ms\nFROM syn_daily_stage_latency\nWHERE snapshot_exclusive = :snapshot\n  AND turn_date >= substr(:start, 1, 10)\n  AND turn_date < substr(:end, 1, 10)\nGROUP BY stage, endpoint_kind\nHAVING :start = substr(:start, 1, 10) || 'T00:00:00Z'\n  AND :end = substr(:end, 1, 10) || 'T00:00:00Z'\n  AND :start < :end\nORDER BY stage, endpoint_kind;","structure":{"kind":"metric","table":{"object_id":"table-syn_daily_stage_latency","version":"1"},"expression":"CAST(SUM(latency_sum_ms) AS REAL) / NULLIF(SUM(latency_samples), 0)","input_grain":"一个轮次归属日、阶段、端云位置与build的统计","time_column":"turn_date","unit":"ms","required_filters":["snapshot_exclusive = :snapshot",":start = substr(:start, 1, 10) || 'T00:00:00Z'",":end = substr(:end, 1, 10) || 'T00:00:00Z'",":start < :end"],"dimensions":["stage","endpoint_kind","build_id"]}}
{"kind":"metric","id":"logical_effect_confirmation_rate","name":"逻辑动作效果确认率","aliases":["效果确认率"],"tables":["syn_action_invocation","syn_action_result"],"numerator":"有最新明确confirmed效果的去重operation_key数","denominator":"去重operation_key数","unit":"ratio","empty_or_zero_rule":"比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。","scope":"非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。","limitations":"重复回执和传输重试不增加动作数；accepted不等于效果确认。","description":"指标：逻辑动作效果确认率。\n分子：有最新明确confirmed效果的去重operation_key数。\n分母：去重operation_key数。\n单位：ratio。\n范围：非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。\n空值与零：比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。\n限制：重复回执和传输重试不增加动作数；accepted不等于效果确认。","sql":"WITH eligible_turns AS (\n    SELECT t.*, s.vehicle_id, s.build_id, s.policy_id\n    FROM syn_voice_turn t\n    JOIN syn_voice_session s ON s.session_id = t.session_id\n    JOIN syn_vehicle v ON v.vehicle_id = s.vehicle_id\n    WHERE v.is_lab_unit = 0 AND v.telemetry_consent = 1\n      AND s.quality_state = 'valid' AND s.is_complete = 1\n      AND t.quality_state = 'valid'\n      AND t.started_at >= :start AND t.started_at < :end\n      AND s.started_at < :snapshot AND s.ended_at < :snapshot\n      AND t.started_at < :snapshot AND t.finished_at < :snapshot\n      AND t.received_at < :snapshot AND s.received_at < :snapshot\n), operations AS (\n    SELECT DISTINCT i.operation_key\n    FROM syn_action_invocation i JOIN eligible_turns t ON t.turn_id = i.turn_id\n    WHERE i.received_at < :snapshot\n), ranked_receipts AS (\n    SELECT r.*, ROW_NUMBER() OVER (\n        PARTITION BY r.operation_key\n        ORDER BY r.observed_offset_ms DESC, r.observation_no DESC, r.result_id DESC\n    ) AS receipt_rank\n    FROM syn_action_result r JOIN operations o ON o.operation_key = r.operation_key\n    WHERE r.received_at < :snapshot\n)\nSELECT COUNT(*) AS logical_operations,\n       COALESCE(SUM(CASE WHEN r.return_state = 'succeeded' AND r.effect_state = 'confirmed' THEN 1 ELSE 0 END), 0) AS matched_operations,\n       CAST(SUM(CASE WHEN r.return_state = 'succeeded' AND r.effect_state = 'confirmed' THEN 1 ELSE 0 END) AS REAL) / NULLIF(COUNT(*), 0) AS logical_effect_confirmation_rate\nFROM operations o LEFT JOIN ranked_receipts r\n  ON r.operation_key = o.operation_key AND r.receipt_rank = 1;"}
{"kind":"metric","id":"unknown_action_rate","name":"逻辑动作结果未知占比","aliases":["动作未知率"],"tables":["syn_action_invocation","syn_action_result"],"numerator":"最新可见状态unknown或尚无回执的operation_key数","denominator":"全部operation_key数","unit":"ratio","empty_or_zero_rule":"比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。","scope":"非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。","limitations":"不能把unknown改成失败或重做新动作。","description":"指标：逻辑动作结果未知占比。\n分子：最新可见状态unknown或尚无回执的operation_key数。\n分母：全部operation_key数。\n单位：ratio。\n范围：非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。\n空值与零：比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。\n限制：不能把unknown改成失败或重做新动作。","sql":"WITH eligible_turns AS (\n    SELECT t.*, s.vehicle_id, s.build_id, s.policy_id\n    FROM syn_voice_turn t\n    JOIN syn_voice_session s ON s.session_id = t.session_id\n    JOIN syn_vehicle v ON v.vehicle_id = s.vehicle_id\n    WHERE v.is_lab_unit = 0 AND v.telemetry_consent = 1\n      AND s.quality_state = 'valid' AND s.is_complete = 1\n      AND t.quality_state = 'valid'\n      AND t.started_at >= :start AND t.started_at < :end\n      AND s.started_at < :snapshot AND s.ended_at < :snapshot\n      AND t.started_at < :snapshot AND t.finished_at < :snapshot\n      AND t.received_at < :snapshot AND s.received_at < :snapshot\n), operations AS (\n    SELECT DISTINCT i.operation_key\n    FROM syn_action_invocation i JOIN eligible_turns t ON t.turn_id = i.turn_id\n    WHERE i.received_at < :snapshot\n), ranked_receipts AS (\n    SELECT r.*, ROW_NUMBER() OVER (\n        PARTITION BY r.operation_key\n        ORDER BY r.observed_offset_ms DESC, r.observation_no DESC, r.result_id DESC\n    ) AS receipt_rank\n    FROM syn_action_result r JOIN operations o ON o.operation_key = r.operation_key\n    WHERE r.received_at < :snapshot\n)\nSELECT COUNT(*) AS logical_operations,\n       COALESCE(SUM(CASE WHEN r.result_id IS NULL OR r.return_state = 'unknown' THEN 1 ELSE 0 END), 0) AS matched_operations,\n       CAST(SUM(CASE WHEN r.result_id IS NULL OR r.return_state = 'unknown' THEN 1 ELSE 0 END) AS REAL) / NULLIF(COUNT(*), 0) AS unknown_action_rate\nFROM operations o LEFT JOIN ranked_receipts r\n  ON r.operation_key = o.operation_key AND r.receipt_rank = 1;"}
{"kind":"metric","id":"tts_success_rate","name":"TTS尝试成功率","aliases":["播报合成成功率"],"tables":["syn_tts_request"],"numerator":"outcome=succeeded次数","denominator":"所有TTS尝试次数","unit":"ratio","empty_or_zero_rule":"比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。","scope":"非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。","limitations":"不等于实际播放完成或任务达成。","description":"指标：TTS尝试成功率。\n分子：outcome=succeeded次数。\n分母：所有TTS尝试次数。\n单位：ratio。\n范围：非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。\n空值与零：比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。\n限制：不等于实际播放完成或任务达成。","sql":"WITH eligible_turns AS (\n    SELECT t.*, s.vehicle_id, s.build_id, s.policy_id\n    FROM syn_voice_turn t\n    JOIN syn_voice_session s ON s.session_id = t.session_id\n    JOIN syn_vehicle v ON v.vehicle_id = s.vehicle_id\n    WHERE v.is_lab_unit = 0 AND v.telemetry_consent = 1\n      AND s.quality_state = 'valid' AND s.is_complete = 1\n      AND t.quality_state = 'valid'\n      AND t.started_at >= :start AND t.started_at < :end\n      AND s.started_at < :snapshot AND s.ended_at < :snapshot\n      AND t.started_at < :snapshot AND t.finished_at < :snapshot\n      AND t.received_at < :snapshot AND s.received_at < :snapshot\n)\nSELECT COUNT(*) AS visible_records, COALESCE(SUM(CASE WHEN f.outcome = 'succeeded' THEN 1 ELSE 0 END), 0) AS matched_records,\n       CAST(SUM(CASE WHEN f.outcome = 'succeeded' THEN 1 ELSE 0 END) AS REAL) / NULLIF(COUNT(*), 0) AS tts_success_rate\nFROM syn_tts_request f JOIN eligible_turns t ON t.turn_id = f.turn_id\nWHERE f.received_at < :snapshot;"}
{"kind":"metric","id":"playback_completion_rate","name":"播报片段完成率","aliases":["播报完成率"],"tables":["syn_playback_segment"],"numerator":"completion_state=complete片段数","denominator":"全部播放片段数","unit":"ratio","empty_or_zero_rule":"比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。","scope":"非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。","limitations":"用户打断单独列出，不直接算作原动作失败。","description":"指标：播报片段完成率。\n分子：completion_state=complete片段数。\n分母：全部播放片段数。\n单位：ratio。\n范围：非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。\n空值与零：比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。\n限制：用户打断单独列出，不直接算作原动作失败。","sql":"WITH eligible_turns AS (\n    SELECT t.*, s.vehicle_id, s.build_id, s.policy_id\n    FROM syn_voice_turn t\n    JOIN syn_voice_session s ON s.session_id = t.session_id\n    JOIN syn_vehicle v ON v.vehicle_id = s.vehicle_id\n    WHERE v.is_lab_unit = 0 AND v.telemetry_consent = 1\n      AND s.quality_state = 'valid' AND s.is_complete = 1\n      AND t.quality_state = 'valid'\n      AND t.started_at >= :start AND t.started_at < :end\n      AND s.started_at < :snapshot AND s.ended_at < :snapshot\n      AND t.started_at < :snapshot AND t.finished_at < :snapshot\n      AND t.received_at < :snapshot AND s.received_at < :snapshot\n)\nSELECT COUNT(*) AS visible_records, COALESCE(SUM(CASE WHEN f.completion_state = 'complete' THEN 1 ELSE 0 END), 0) AS matched_records,\n       CAST(SUM(CASE WHEN f.completion_state = 'complete' THEN 1 ELSE 0 END) AS REAL) / NULLIF(COUNT(*), 0) AS playback_completion_rate\nFROM syn_playback_segment f JOIN eligible_turns t ON t.turn_id = f.turn_id\nWHERE f.received_at < :snapshot;"}
{"kind":"metric","id":"feedback_coverage","name":"明确反馈覆盖率","aliases":["反馈覆盖率"],"tables":["syn_daily_voice_experience"],"numerator":"feedback_count","denominator":"turn_count","unit":"ratio","empty_or_zero_rule":"比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。","scope":"非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。 当前日表SQL仅接受:start与:end均为UTC整日边界的半开区间；小时或其他非整日范围必须从原始事实按同口径重算，不能截去时分秒。","limitations":"没有反馈不是满意或不满意。 日表SQL以HAVING核对整日参数，不合要求时不返回统计行，不把它解释成零样本。","description":"指标：明确反馈覆盖率。\n分子：feedback_count。\n分母：turn_count。\n单位：ratio。\n范围：非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。 当前日表SQL仅接受:start与:end均为UTC整日边界的半开区间；小时或其他非整日范围必须从原始事实按同口径重算，不能截去时分秒。\n空值与零：比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。\n限制：没有反馈不是满意或不满意。 日表SQL以HAVING核对整日参数，不合要求时不返回统计行，不把它解释成零样本。","sql":"SELECT COALESCE(SUM(feedback_count), 0) AS numerator, COALESCE(SUM(turn_count), 0) AS denominator,\n       CAST(SUM(feedback_count) AS REAL) / NULLIF(SUM(turn_count), 0) AS feedback_coverage\nFROM syn_daily_voice_experience\nWHERE snapshot_exclusive = :snapshot\n  AND activity_date >= substr(:start, 1, 10)\n  AND activity_date < substr(:end, 1, 10)\nHAVING :start = substr(:start, 1, 10) || 'T00:00:00Z'\n  AND :end = substr(:end, 1, 10) || 'T00:00:00Z'\n  AND :start < :end;","structure":{"kind":"metric","table":{"object_id":"table-syn_daily_voice_experience","version":"1"},"expression":"CAST(SUM(feedback_count) AS REAL) / NULLIF(SUM(turn_count), 0)","input_grain":"按列所属业务日、车辆、冻结build的并列日计数；当前指标按turn日","time_column":"activity_date","unit":"ratio","required_filters":["snapshot_exclusive = :snapshot",":start = substr(:start, 1, 10) || 'T00:00:00Z'",":end = substr(:end, 1, 10) || 'T00:00:00Z'",":start < :end"],"dimensions":["vehicle_id","build_id"]}}
{"kind":"metric","id":"positive_feedback_rate","name":"有反馈轮次正评率","aliases":["合成正评率"],"tables":["syn_daily_voice_experience"],"numerator":"positive_feedback_count","denominator":"feedback_count","unit":"ratio","empty_or_zero_rule":"比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。","scope":"非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。 当前日表SQL仅接受:start与:end均为UTC整日边界的半开区间；小时或其他非整日范围必须从原始事实按同口径重算，不能截去时分秒。","limitations":"仅人工合成反馈子集，必须同时报告覆盖率。 日表SQL以HAVING核对整日参数，不合要求时不返回统计行，不把它解释成零样本。","description":"指标：有反馈轮次正评率。\n分子：positive_feedback_count。\n分母：feedback_count。\n单位：ratio。\n范围：非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。 当前日表SQL仅接受:start与:end均为UTC整日边界的半开区间；小时或其他非整日范围必须从原始事实按同口径重算，不能截去时分秒。\n空值与零：比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。\n限制：仅人工合成反馈子集，必须同时报告覆盖率。 日表SQL以HAVING核对整日参数，不合要求时不返回统计行，不把它解释成零样本。","sql":"SELECT COALESCE(SUM(positive_feedback_count), 0) AS numerator, COALESCE(SUM(feedback_count), 0) AS denominator,\n       CAST(SUM(positive_feedback_count) AS REAL) / NULLIF(SUM(feedback_count), 0) AS positive_feedback_rate\nFROM syn_daily_voice_experience\nWHERE snapshot_exclusive = :snapshot\n  AND activity_date >= substr(:start, 1, 10)\n  AND activity_date < substr(:end, 1, 10)\nHAVING :start = substr(:start, 1, 10) || 'T00:00:00Z'\n  AND :end = substr(:end, 1, 10) || 'T00:00:00Z'\n  AND :start < :end;","structure":{"kind":"metric","table":{"object_id":"table-syn_daily_voice_experience","version":"1"},"expression":"CAST(SUM(positive_feedback_count) AS REAL) / NULLIF(SUM(feedback_count), 0)","input_grain":"按列所属业务日、车辆、冻结build的并列日计数；当前指标按turn日","time_column":"activity_date","unit":"ratio","required_filters":["snapshot_exclusive = :snapshot",":start = substr(:start, 1, 10) || 'T00:00:00Z'",":end = substr(:end, 1, 10) || 'T00:00:00Z'",":start < :end"],"dimensions":["vehicle_id","build_id"]}}
{"kind":"metric","id":"interrupted_playback_rate","name":"播报片段被打断比例","aliases":["播报打断率"],"tables":["syn_playback_segment"],"numerator":"completion_state=interrupted片段数","denominator":"全部播放片段数","unit":"ratio","empty_or_zero_rule":"比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。","scope":"非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。","limitations":"新输入打断、按钮停止和设备错误分别解释。","description":"指标：播报片段被打断比例。\n分子：completion_state=interrupted片段数。\n分母：全部播放片段数。\n单位：ratio。\n范围：非实验且遥测授权车辆；有效完整会话及valid轮次；业务时点和received_at均早于排他快照；按turn.started_at UTC半开区间。\n空值与零：比率分母为0返回NULL；计数无符合记录返回0；均值/P95无样本返回NULL。\n限制：新输入打断、按钮停止和设备错误分别解释。","sql":"WITH eligible_turns AS (\n    SELECT t.*, s.vehicle_id, s.build_id, s.policy_id\n    FROM syn_voice_turn t\n    JOIN syn_voice_session s ON s.session_id = t.session_id\n    JOIN syn_vehicle v ON v.vehicle_id = s.vehicle_id\n    WHERE v.is_lab_unit = 0 AND v.telemetry_consent = 1\n      AND s.quality_state = 'valid' AND s.is_complete = 1\n      AND t.quality_state = 'valid'\n      AND t.started_at >= :start AND t.started_at < :end\n      AND s.started_at < :snapshot AND s.ended_at < :snapshot\n      AND t.started_at < :snapshot AND t.finished_at < :snapshot\n      AND t.received_at < :snapshot AND s.received_at < :snapshot\n)\nSELECT COUNT(*) AS visible_records, COALESCE(SUM(CASE WHEN f.completion_state = 'interrupted' THEN 1 ELSE 0 END), 0) AS matched_records,\n       CAST(SUM(CASE WHEN f.completion_state = 'interrupted' THEN 1 ELSE 0 END) AS REAL) / NULLIF(COUNT(*), 0) AS interrupted_playback_rate\nFROM syn_playback_segment f JOIN eligible_turns t ON t.turn_id = f.turn_id\nWHERE f.received_at < :snapshot;"}
```
