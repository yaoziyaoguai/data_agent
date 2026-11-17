# {{run_prefix}}ASR最终尝试分布

这是独立公开的合成查询案例。目标是按实际端侧/云侧统计有效轮次中最终ASR尝试的成功率，不代表转写准确率。

使用syn_voice_turn、syn_voice_session、syn_vehicle及syn_asr_attempt。按turn.started_at选择UTC半开区间；车辆授权且非实验、会话完整有效、轮次valid，业务完成和received均早于快照。每轮按最大可见attempt_no选择最后尝试；只统计有ASR尝试的轮次，最终取消、失败、超时保留在分母，仅succeeded算成功。

参数：start、end_exclusive、snapshot_exclusive。先按上述条件筛轮次和尝试，再用ROW_NUMBER按turn_id分区及attempt_no降序选择一行，最后按endpoint_kind聚合COUNT与succeeded计数，分母0返回NULL。候选表不参与成功率分母。该案例只提供查询方法，不授予执行授权。

参数化SQL（资格、可见性与最终尝试选择沿语义资料`asr_final_attempt_success_rate`的既有定义，仅增加endpoint_kind分组；不含数据预期值）：

```sql
WITH qualified_turns AS (
    SELECT t.turn_id, t.started_at
    FROM syn_voice_turn t
    JOIN syn_voice_session s ON s.session_id = t.session_id
    JOIN syn_vehicle v ON v.vehicle_id = s.vehicle_id
    WHERE v.is_lab_unit = 0 AND v.telemetry_consent = 1
      AND s.quality_state = 'valid' AND s.is_complete = 1
      AND t.quality_state = 'valid'
      AND t.started_at >= :start AND t.started_at < :end_exclusive
      AND s.started_at < :snapshot_exclusive AND s.ended_at < :snapshot_exclusive
      AND t.finished_at < :snapshot_exclusive
      AND t.received_at < :snapshot_exclusive AND s.received_at < :snapshot_exclusive
), visible_attempts AS (
    SELECT a.*
    FROM syn_asr_attempt a JOIN qualified_turns t ON t.turn_id = a.turn_id
    WHERE a.received_at < :snapshot_exclusive
      AND CAST(strftime('%s', t.started_at) AS INTEGER) * 1000 + a.finish_offset_ms
          < CAST(strftime('%s', :snapshot_exclusive) AS INTEGER) * 1000
), final_attempt AS (
    SELECT a.*,
           ROW_NUMBER() OVER (PARTITION BY a.turn_id ORDER BY a.attempt_no DESC) AS rn
    FROM visible_attempts a
)
SELECT endpoint_kind,
       COALESCE(SUM(outcome = 'succeeded'), 0) AS succeeded_turns,
       COUNT(*) AS turns_with_attempt,
       CAST(SUM(outcome = 'succeeded') AS REAL) / NULLIF(COUNT(*), 0) AS final_success_rate
FROM final_attempt
WHERE rn = 1
GROUP BY endpoint_kind
ORDER BY endpoint_kind;
```
