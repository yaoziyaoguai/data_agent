use super::*;

fn relations_between<'a>(
    objects: &'a [Value],
    first: &Value,
    second: &Value,
) -> Vec<(&'a Value, &'a Value)> {
    objects
        .iter()
        .filter(|object| object["kind"] == "relationship" && object["state"] == "enabled")
        .flat_map(|object| {
            effective_structures(object, "relationship")
                .into_iter()
                .map(move |structure| (object, structure))
        })
        .filter(|(_, structure)| {
            (ref_matches(&structure["left_table"], first)
                && ref_matches(&structure["right_table"], second))
                || (ref_matches(&structure["left_table"], second)
                    && ref_matches(&structure["right_table"], first))
        })
        .collect()
}

pub(super) fn check_join(
    keys: JoinKeys<'_>,
    bindings: &[Binding<'_>],
    sums: &[Column],
    objects: &[Value],
    report: &mut Report,
) {
    let bound_objects = bindings
        .iter()
        .map(|binding| binding.object)
        .collect::<Vec<_>>();
    let [Some(first), Some(second)] = bound_objects.as_slice() else {
        report.missing(
            "join_keys",
            vec![],
            "缺少关联两端表快照，关联键及聚合风险未检查。",
        );
        return;
    };
    let candidates = relations_between(objects, first, second);
    if candidates.len() != 1 {
        report.missing(
            "join_keys",
            vec![],
            "缺少唯一、有效且版本一致的关联规则，关联键及聚合风险未检查。",
        );
        return;
    }
    let (object, structure) = candidates[0];
    let refs = vec![object_ref(object), object_ref(first), object_ref(second)];
    let left_id = structure["left_table"]["object_id"].as_str().unwrap_or("");
    let right_id = structure["right_table"]["object_id"].as_str().unwrap_or("");
    let mut actual = BTreeSet::new();
    for (left, right) in keys {
        let (Some(left), Some(right)) = (
            resolve_column(left, bindings),
            resolve_column(right, bindings),
        ) else {
            report.missing("join_keys", refs, "关联字段无法唯一对应当前表列，未检查。");
            return;
        };
        if left.table_id == left_id && right.table_id == right_id {
            actual.insert((left.name, right.name));
        } else if right.table_id == left_id && left.table_id == right_id {
            actual.insert((right.name, left.name));
        } else {
            report.add(
                "join_keys",
                "warning",
                refs,
                "关联条件包含同一端字段，未匹配记录的两端关联键。",
                LIMITATION,
            );
            return;
        }
    }
    let expected: BTreeSet<_> = structure["join_keys"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .filter_map(|key| {
            Some((
                key["left_column"].as_str()?.to_ascii_lowercase(),
                key["right_column"].as_str()?.to_ascii_lowercase(),
            ))
        })
        .collect();
    if expected.is_empty() {
        report.missing("join_keys", refs, "关联规则缺少完整键，未检查。");
        return;
    }
    if actual != expected {
        report.add(
            "join_keys",
            "warning",
            refs,
            "SQL关联键与记录的完整关联键不同，可能漏键或关联了错误字段。",
            LIMITATION,
        );
        return;
    }
    report.add(
        "join_keys",
        "checked",
        refs.clone(),
        "SQL等值关联包含记录的完整关联键。",
        "仅核对字段集合；关联适用范围及实际唯一性仍需查证。",
    );
    if sums.is_empty() {
        return;
    }
    let cardinality = structure["cardinality"].as_str().unwrap_or("");
    if !matches!(
        cardinality,
        "one_to_one" | "one_to_many" | "many_to_one" | "many_to_many"
    ) {
        report.missing(
            "aggregate_cardinality",
            refs,
            "关联基数未知，SUM重复累计风险未检查。",
        );
        return;
    }
    let duplicated = sums.iter().any(|sum| match cardinality {
        "one_to_many" => sum.table_id == left_id,
        "many_to_one" => sum.table_id == right_id,
        "many_to_many" => sum.table_id == left_id || sum.table_id == right_id,
        _ => false,
    });
    report.add(
        "aggregate_cardinality",
        if duplicated { "warning" } else { "checked" },
        refs,
        if duplicated {
            "SUM取自记录关系的一端或多对多端，关联后可能重复累计；请先核对粒度或预聚合。"
        } else {
            "这些直接列SUM未命中当前记录的关联放大方向。"
        },
        "只核对记录基数的风险方向；不证明真实数据唯一性，过滤或业务范围也可能影响基数。",
    );
}

pub(super) fn multi_grain_rewrite(
    operator: &JoinOperator,
    bindings: &[Binding<'_>],
    objects: &[Value],
    metrics: &[(&Value, &Value)],
) -> Option<Value> {
    let [left, right] = bindings else {
        return None;
    };
    let (left_table, right_table) = (left.object?, right.object?);
    let candidates = relations_between(objects, left_table, right_table);
    let [(relation, definition)] = candidates.as_slice() else {
        return None;
    };
    if !matches!(
        definition["cardinality"].as_str()?,
        "one_to_many" | "many_to_one" | "many_to_many"
    ) {
        return None;
    }
    let forward = ref_matches(&definition["left_table"], left_table);
    let keys = definition["join_keys"]
        .as_array()?
        .iter()
        .map(|key| {
            let pair = (key["left_column"].as_str()?, key["right_column"].as_str()?);
            Some(if forward { pair } else { (pair.1, pair.0) })
        })
        .collect::<Option<Vec<_>>>()?;
    let actual = join_pairs(join_constraint(operator)?)?
        .into_iter()
        .map(|(a, b)| {
            let (a, b) = (resolve_column(a, bindings)?, resolve_column(b, bindings)?);
            let (a, b) = if a.table_id == left_table["id"].as_str()? {
                (a, b)
            } else {
                (b, a)
            };
            (a.table_id == left_table["id"].as_str()?
                && b.table_id == right_table["id"].as_str()?)
            .then_some((a.name, b.name))
        })
        .collect::<Option<BTreeSet<_>>>()?;
    if keys.is_empty()
        || actual
            != keys
                .iter()
                .map(|(a, b)| (a.to_ascii_lowercase(), b.to_ascii_lowercase()))
                .collect()
    {
        return None;
    }
    let on_left = metrics
        .iter()
        .filter(|(_, metric)| ref_matches(&metric["table"], left_table))
        .collect::<Vec<_>>();
    let on_right = metrics
        .iter()
        .filter(|(_, metric)| ref_matches(&metric["table"], right_table))
        .collect::<Vec<_>>();
    if on_left.is_empty()
        || on_right.is_empty()
        || on_left.iter().all(|(_, a)| {
            on_right
                .iter()
                .all(|(_, b)| a["input_grain"] == b["input_grain"])
        })
    {
        return None;
    }
    let quote = |name: &str| sqlparser::ast::Ident::with_quote('"', name).to_string();
    let mut parts = Vec::new();
    let mut projections = Vec::new();
    let mut refs = vec![
        object_ref(relation),
        object_ref(left_table),
        object_ref(right_table),
    ];
    for (side, (binding, selected)) in [(left, on_left), (right, on_right)].into_iter().enumerate()
    {
        let group = keys
            .iter()
            .map(|(a, b)| quote(if side == 0 { a } else { b }))
            .collect::<Vec<_>>();
        let mut cols = group
            .iter()
            .enumerate()
            .map(|(i, key)| format!("{key} AS join_key_{}", i + 1))
            .collect::<Vec<_>>();
        for (metric, structure) in selected {
            let filters = structure["required_filters"]
                .as_array()?
                .iter()
                .map(Value::as_str)
                .collect::<Option<Vec<_>>>()?;
            let expression = structure["expression"].as_str()?;
            let grain = structure["input_grain"].as_str()?;
            let n = parts.len() + 1;
            let table = binding
                .name
                .split('.')
                .map(quote)
                .collect::<Vec<_>>()
                .join(".");
            cols.truncate(group.len());
            cols.push(format!("{expression} AS metric_value"));
            let filters = if filters.is_empty() {
                String::new()
            } else {
                format!(" AND ({})", filters.join(") AND ("))
            };
            let alias = format!("metric_{n}");
            parts.push(format!("{alias} AS (\n  -- {}，输入粒度：{}\n  SELECT {}\n  FROM {table}\n  WHERE <本表的原查询时间和筛选>{filters}\n  GROUP BY {}\n)",
                metric["name"].as_str()?, grain.replace('\n'," "), cols.join(", "), group.join(", ")));
            projections.push(format!("{alias}.metric_value AS {alias}"));
            refs.push(object_ref(metric));
        }
    }
    let on = (1..=keys.len())
        .map(|i| format!("metric_1.join_key_{i} = {{alias}}.join_key_{i}"))
        .collect::<Vec<_>>()
        .join(" AND ");
    let joins = (2..=parts.len())
        .map(|i| {
            let alias = format!("metric_{i}");
            let join = if matches!(operator, JoinOperator::Left(_) | JoinOperator::LeftOuter(_)) {
                "LEFT JOIN"
            } else {
                "JOIN"
            };
            format!("{join} {alias} ON {}", on.replace("{alias}", &alias))
        })
        .collect::<Vec<_>>()
        .join("\n");
    let finding = format!(
        "按指标独立过滤并聚合到共同关联键，再连接聚合结果。保留原分组、时间口径和分母；同一条事实记录不可在不同事实端重复计数。\nWITH {}\nSELECT {}\nFROM metric_1\n{joins}",
        parts.join(",\n"),
        projections.join(", ")
    );
    (finding.chars().count() <= 4000 && refs.len() <= 50).then(|| json!({
        "rule":"multi_grain_cte","state":"warning","evidence_refs":refs,"finding":finding,
        "coverage_limit":"改写草案：原过滤、输出分组及缺失键处理仍需核对。此处不做SQL校验或执行。"
    }))
}
