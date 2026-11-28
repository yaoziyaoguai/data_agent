use super::check_grouping_ambiguity;

const UNGROUPED_RESTRICTED_SQL: &str = "SELECT build_id,
       COALESCE(SUM(task_completed_count), 0) AS numerator,
       COALESCE(SUM(eligible_turn_count), 0) AS denominator,
       CAST(SUM(task_completed_count) AS REAL) / NULLIF(SUM(eligible_turn_count), 0) AS task_completion_rate
FROM syn_daily_voice_experience
WHERE snapshot_exclusive = :snapshot
  AND activity_date >= substr(:start, 1, 10)
  AND activity_date < substr(:end, 1, 10)
HAVING :start = substr(:start, 1, 10) || 'T00:00:00Z'
  AND :end = substr(:end, 1, 10) || 'T00:00:00Z'
  AND :start < :end
ORDER BY task_completion_rate DESC, build_id;";

const OVERALL_TOTAL_SQL: &str = "SELECT COALESCE(SUM(task_completed_count), 0) AS numerator,
       COALESCE(SUM(eligible_turn_count), 0) AS denominator,
       CAST(SUM(task_completed_count) AS REAL) / NULLIF(SUM(eligible_turn_count), 0) AS task_completion_rate
FROM syn_daily_voice_experience
WHERE snapshot_exclusive = :snapshot
  AND activity_date >= substr(:start, 1, 10)
  AND activity_date < substr(:end, 1, 10)
HAVING :start = substr(:start, 1, 10) || 'T00:00:00Z'
  AND :end = substr(:end, 1, 10) || 'T00:00:00Z'
  AND :start < :end;";

const GROUPED_SQL: &str = "SELECT build_id,
       COALESCE(SUM(task_completed_count), 0) AS numerator,
       COALESCE(SUM(eligible_turn_count), 0) AS denominator,
       CAST(SUM(task_completed_count) AS REAL) / NULLIF(SUM(eligible_turn_count), 0) AS task_completion_rate
FROM syn_daily_voice_experience
WHERE snapshot_exclusive = :snapshot
  AND activity_date >= substr(:start, 1, 10)
  AND activity_date < substr(:end, 1, 10)
GROUP BY build_id
HAVING :start = substr(:start, 1, 10) || 'T00:00:00Z'
  AND :end = substr(:end, 1, 10) || 'T00:00:00Z'
  AND :start < :end
ORDER BY task_completion_rate DESC, build_id;";

#[test]
fn rejects_ungrouped_build_id_and_names_column_while_preserving_overall_and_grouped_queries() {
    let diag = check_grouping_ambiguity(UNGROUPED_RESTRICTED_SQL).expect("must reject");
    assert_eq!(diag["code"], "ungrouped_aggregate_column");
    let msg = diag["message"].as_str().unwrap();
    assert!(msg.contains("build_id"), "unexpected message: {msg}");

    assert_eq!(check_grouping_ambiguity(OVERALL_TOTAL_SQL), None);
    assert_eq!(check_grouping_ambiguity(GROUPED_SQL), None);
}

#[test]
fn preserves_detail_queries_window_functions_ordinals_aliases_and_conditional_aggregates() {
    for valid_sql in [
        "SELECT * FROM syn_daily_voice_experience LIMIT 1;",
        "SELECT :cohort AS cohort, COUNT(*) FROM syn_daily_voice_experience",
        "SELECT build_id, SUM(task_completed_count) OVER (PARTITION BY build_id) AS w FROM syn_daily_voice_experience",
        "SELECT build_id, SUM(task_completed_count) AS total FROM syn_daily_voice_experience GROUP BY 1 ORDER BY total DESC",
        "SELECT substr(activity_date, 1, 7) AS ym, SUM(task_completed_count) FROM syn_daily_voice_experience d GROUP BY ym",
        "SELECT substr(d.activity_date, 1, 7) AS ym, SUM(d.task_completed_count) FROM syn_daily_voice_experience d GROUP BY substr(activity_date, 1, 7)",
        "SELECT SUM(CASE WHEN build_id = 'SB3' THEN task_completed_count ELSE 0 END) AS sb3_num FROM syn_daily_voice_experience",
        "SELECT COUNT(*) FILTER (WHERE build_id = 'SB2') AS sb2_rows FROM syn_daily_voice_experience",
        "SELECT d.build_id, (SELECT SUM(x.task_completed_count) FROM syn_daily_voice_experience x WHERE x.build_id = d.build_id) FROM syn_daily_voice_experience d",
    ] {
        assert_eq!(
            check_grouping_ambiguity(valid_sql),
            None,
            "valid SQL must pass: {valid_sql}"
        );
    }
}

#[test]
fn handles_sqlite_scalar_multi_arg_min_max_and_collate_expressions() {
    // SQLite 多参数 MIN/MAX 是逐行标量函数，不应误判为聚合而拦截普通明细查询
    assert_eq!(
        check_grouping_ambiguity("SELECT cohort, MAX(n, 0) FROM sample"),
        None
    );
    assert_eq!(
        check_grouping_ambiguity("SELECT cohort, MIN(n, 10, 100) FROM sample"),
        None
    );
    // 单参数 MAX(n) 仍是聚合函数，混选裸列 cohort 必须拒绝并指出 cohort
    let single_arg_max = check_grouping_ambiguity("SELECT cohort, MAX(n) FROM sample")
        .expect("single-arg MAX with bare column must reject");
    assert!(
        single_arg_max["message"]
            .as_str()
            .unwrap()
            .contains("cohort"),
        "{single_arg_max}"
    );
    // 多参数标量 MAX(n, 0) 与真实聚合 SUM(n) 同处一层且未 GROUP BY 时，n 与 cohort 均属未分组列
    let mixed_scalar_max = check_grouping_ambiguity("SELECT cohort, MAX(n, 0), SUM(n) FROM sample")
        .expect("scalar MAX + aggregate SUM without GROUP BY must reject");
    let mixed_msg = mixed_scalar_max["message"].as_str().unwrap();
    assert!(
        mixed_msg.contains("cohort") && mixed_msg.contains('n'),
        "{mixed_msg}"
    );

    // COLLATE 包装的裸列混用聚合必须拦截并指出 cohort；补齐同表达式 GROUP BY 后放行
    let ungrouped_collate =
        check_grouping_ambiguity("SELECT cohort COLLATE NOCASE, SUM(n) FROM sample")
            .expect("COLLATE column without GROUP BY must reject");
    assert_eq!(ungrouped_collate["code"], "ungrouped_aggregate_column");
    assert!(
        ungrouped_collate["message"]
            .as_str()
            .unwrap()
            .contains("cohort"),
        "{ungrouped_collate}"
    );
    assert_eq!(
        check_grouping_ambiguity(
            "SELECT cohort COLLATE NOCASE, SUM(n) FROM sample GROUP BY cohort COLLATE NOCASE"
        ),
        None
    );
}

#[test]
fn rejects_wildcards_having_columns_order_by_columns_and_subquery_grouping_bugs() {
    for (bad_sql, expected_col) in [
        (
            "SELECT *, SUM(task_completed_count) FROM syn_daily_voice_experience",
            "*",
        ),
        (
            "SELECT d.*, SUM(d.task_completed_count) FROM syn_daily_voice_experience d GROUP BY d.build_id",
            "d.*",
        ),
        (
            "SELECT SUM(task_completed_count) FROM syn_daily_voice_experience HAVING build_id = 'SB2'",
            "build_id",
        ),
        (
            "SELECT SUM(task_completed_count) FROM syn_daily_voice_experience ORDER BY activity_date",
            "activity_date",
        ),
        (
            "WITH agg AS (SELECT build_id, SUM(task_completed_count) AS n FROM syn_daily_voice_experience) SELECT * FROM agg",
            "build_id",
        ),
    ] {
        let diag = check_grouping_ambiguity(bad_sql)
            .unwrap_or_else(|| panic!("expected rejection for {bad_sql}"));
        assert_eq!(diag["code"], "ungrouped_aggregate_column");
        assert!(
            diag["message"].as_str().unwrap().contains(expected_col),
            "expected {expected_col} in {diag}"
        );
    }
}
