use serde_json::{Value, json};
use sqlparser::{
    ast::{
        BinaryOperator, Expr, FunctionArg, FunctionArgExpr, FunctionArguments, GroupByExpr,
        JoinConstraint, JoinOperator, LimitClause, ObjectName, OrderByKind, Select, SelectItem,
        SelectItemQualifiedWildcardKind, SetExpr, Statement, TableFactor, Value as SqlValue,
        WildcardAdditionalOptions,
    },
    dialect::SQLiteDialect,
    parser::Parser,
};
use std::collections::BTreeSet;

const LIMITATION: &str =
    "仅核对当前有效结构与直接列表达式，不证明数据唯一性、口径正确或查询获准执行。";

/// M02经组合用例提供已核对权限及版本的快照；此处只读快照，不访问知识存储。
pub fn check_semantics(sql: &str, parameters: &Value, snapshot: &Value) -> Value {
    let statements = match Parser::new(&SQLiteDialect {})
        .with_recursion_limit(32)
        .try_with_sql(sql)
        .and_then(|mut parser| parser.parse_statements())
    {
        Ok(statements) => statements,
        Err(_) => return unsupported("诊断解析器不能解析这条SQL；语法与只读结论仍以平台为准。"),
    };
    let [Statement::Query(query)] = statements.as_slice() else {
        return unsupported("仅检查一条SELECT查询。多语句和其他语句未检查。");
    };
    let SetExpr::Select(select) = query.body.as_ref() else {
        return unsupported("集合操作、括号查询和子查询未检查。");
    };
    if query.with.is_some() || !query.pipe_operators.is_empty() {
        return unsupported("CTE及管道查询未检查；预聚合需要单独核对。");
    }
    if query.fetch.is_some()
        || !query.locks.is_empty()
        || query.for_clause.is_some()
        || query.settings.is_some()
        || query.format_clause.is_some()
    {
        return unsupported("特殊查询输出、锁和FETCH结构未检查。");
    }
    if let Some(order) = &query.order_by {
        let OrderByKind::Expressions(expressions) = &order.kind else {
            return unsupported("ORDER BY ALL未检查。");
        };
        if order.interpolate.is_some()
            || expressions.iter().any(|order| {
                order.with_fill.is_some()
                    || !(direct_column(&order.expr)
                        || scalar(&order.expr)
                        || sum_column(&order.expr).is_some())
            })
        {
            return unsupported("复杂排序表达式或排序子查询未检查。");
        }
    }
    if query
        .limit_clause
        .as_ref()
        .is_some_and(|limit| match limit {
            LimitClause::LimitOffset {
                limit,
                offset,
                limit_by,
            } => {
                !limit_by.is_empty()
                    || limit.as_ref().is_some_and(|value| !scalar(value))
                    || offset.as_ref().is_some_and(|offset| !scalar(&offset.value))
            }
            LimitClause::OffsetCommaLimit { offset, limit } => !scalar(offset) || !scalar(limit),
        })
    {
        return unsupported("复杂LIMIT或分页子查询未检查。");
    }
    if let Err(reason) = check_shape(select) {
        return unsupported(reason);
    }
    let objects = snapshot["objects"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let relation = &select.from[0];
    let mut bindings = Vec::new();
    for table in
        std::iter::once(&relation.relation).chain(relation.joins.iter().map(|join| &join.relation))
    {
        let Some((name, alias)) = physical_table(table) else {
            return unsupported("仅支持普通表及表别名；子查询、表函数、采样和历史表版本未检查。");
        };
        let candidates: Vec<_> = objects
            .iter()
            .filter(|object| object["kind"] == "table" && object["state"] == "enabled")
            .filter(|object| {
                object["name"]
                    .as_str()
                    .is_some_and(|n| n.eq_ignore_ascii_case(&name))
            })
            .collect();
        bindings.push(Binding {
            name,
            alias,
            object: (candidates.len() == 1).then(|| candidates[0]),
        });
    }
    let mut report = Report::default();
    report.add(
        "sql_shape",
        "checked",
        vec![],
        "SQL属于当前静态诊断支持的形状。",
        LIMITATION,
    );
    for binding in &bindings {
        if binding.object.is_none() {
            report
                .missing
                .push(format!("表{}缺少唯一的有效结构快照。", binding.name));
        }
        if binding
            .object
            .is_some_and(|object| object["column_names_complete"] != true)
        {
            report
                .missing
                .push(format!("表{}的列目录不完整，列引用未检查。", binding.name));
        }
    }
    if objects.iter().any(|object| {
        object["entries"].as_array().is_some_and(|entries| {
            entries.iter().any(|entry| {
                entry["review_state"] != "confirmed" && !entry["effective_structure"].is_null()
            })
        })
    }) {
        report
            .missing
            .push("部分结构仍待确认或复核，不作为已完成检查的依据。".to_owned());
    }
    let sum_expressions: Vec<_> = select
        .projection
        .iter()
        .filter_map(projection_expr)
        .filter_map(sum_column)
        .collect();
    let sums: Vec<_> = sum_expressions
        .iter()
        .filter_map(|column| resolve_column(column, &bindings))
        .collect();
    if sums.len() != sum_expressions.len() {
        report.missing(
            "aggregate_columns",
            vec![],
            "部分SUM列无法唯一对应完整列目录，相关聚合未检查。",
        );
    }
    if let Some(join) = relation.joins.first() {
        check_join(
            join_constraint(&join.join_operator).unwrap(),
            &bindings,
            &sums,
            objects,
            &mut report,
        );
    }
    check_metrics(select, parameters, &bindings, &sums, objects, &mut report);
    if let Some(notes) = snapshot["coverage"]["notes"].as_array() {
        report
            .missing
            .extend(notes.iter().filter_map(Value::as_str).map(str::to_owned));
    }
    report.finish()
}

#[derive(Default)]
struct Report {
    checks: Vec<Value>,
    missing: Vec<String>,
}

impl Report {
    fn add(&mut self, rule: &str, state: &str, refs: Vec<Value>, finding: &str, limit: &str) {
        self.checks
            .push(json!({"rule":rule,"state":state,"evidence_refs":refs,
            "finding":finding,"coverage_limit":limit}));
    }

    fn missing(&mut self, rule: &str, refs: Vec<Value>, finding: &str) {
        self.missing.push(finding.to_owned());
        self.add(rule, "not_checked", refs, finding, LIMITATION);
    }

    fn finish(self) -> Value {
        json!({"checks":self.checks,"coverage":{"sql_shape":"supported",
            "supported_scope":["单SELECT、普通表别名、至多一个INNER/LEFT等值关联",
                "直接列SUM的关系基数风险", "明确选用指标的直接时间界及未换算输入单位"],
            "missing_semantics":self.missing,"unsupported_constructs":[]}})
    }
}

fn unsupported(reason: &str) -> Value {
    json!({"checks":[{"rule":"sql_shape","state":"not_checked","evidence_refs":[],
        "finding":reason,"coverage_limit":LIMITATION}],"coverage":{"sql_shape":"unsupported",
        "supported_scope":[],"missing_semantics":[],"unsupported_constructs":[reason]}})
}

struct Binding<'a> {
    name: String,
    alias: Option<String>,
    object: Option<&'a Value>,
}

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
struct Column {
    table_id: String,
    name: String,
}

fn plain_name(name: &ObjectName) -> Option<String> {
    name.0
        .iter()
        .map(|part| part.as_ident().map(|ident| ident.value.clone()))
        .collect::<Option<Vec<_>>>()
        .map(|parts| parts.join("."))
}

fn physical_table(table: &TableFactor) -> Option<(String, Option<String>)> {
    let TableFactor::Table {
        name,
        alias,
        args,
        with_hints,
        version,
        with_ordinality,
        partitions,
        json_path,
        sample,
        index_hints,
    } = table
    else {
        return None;
    };
    if args.is_some()
        || !with_hints.is_empty()
        || version.is_some()
        || *with_ordinality
        || !partitions.is_empty()
        || json_path.is_some()
        || sample.is_some()
        || !index_hints.is_empty()
        || alias
            .as_ref()
            .is_some_and(|alias| !alias.columns.is_empty())
    {
        return None;
    }
    Some((
        plain_name(name)?,
        alias.as_ref().map(|alias| alias.name.value.clone()),
    ))
}

fn projection_expr(item: &SelectItem) -> Option<&Expr> {
    match item {
        SelectItem::UnnamedExpr(expr) | SelectItem::ExprWithAlias { expr, .. } => Some(expr),
        _ => None,
    }
}

fn plain_wildcard(options: &WildcardAdditionalOptions) -> bool {
    options.opt_ilike.is_none()
        && options.opt_exclude.is_none()
        && options.opt_except.is_none()
        && options.opt_replace.is_none()
        && options.opt_rename.is_none()
}

fn unnested(expr: &Expr) -> &Expr {
    match expr {
        Expr::Nested(expr) => unnested(expr),
        _ => expr,
    }
}

fn direct_column(expr: &Expr) -> bool {
    matches!(
        unnested(expr),
        Expr::Identifier(_) | Expr::CompoundIdentifier(_)
    )
}

fn sum_column(expr: &Expr) -> Option<&Expr> {
    let Expr::Function(function) = unnested(expr) else {
        return None;
    };
    if !plain_name(&function.name)?.eq_ignore_ascii_case("sum")
        || function.over.is_some()
        || function.filter.is_some()
        || function.null_treatment.is_some()
        || !function.within_group.is_empty()
        || !matches!(function.parameters, FunctionArguments::None)
    {
        return None;
    }
    let FunctionArguments::List(args) = &function.args else {
        return None;
    };
    if args.duplicate_treatment.is_some() || !args.clauses.is_empty() {
        return None;
    }
    match args.args.as_slice() {
        [FunctionArg::Unnamed(FunctionArgExpr::Expr(column))] if direct_column(column) => {
            Some(column)
        }
        _ => None,
    }
}

fn scalar(expr: &Expr) -> bool {
    matches!(unnested(expr), Expr::Value(_))
}

fn simple_predicate(expr: &Expr) -> bool {
    match unnested(expr) {
        Expr::BinaryOp {
            left,
            op: BinaryOperator::And,
            right,
        } => simple_predicate(left) && simple_predicate(right),
        Expr::BinaryOp {
            left,
            op:
                BinaryOperator::Eq
                | BinaryOperator::NotEq
                | BinaryOperator::Gt
                | BinaryOperator::GtEq
                | BinaryOperator::Lt
                | BinaryOperator::LtEq,
            right,
        } => (direct_column(left) && scalar(right)) || (scalar(left) && direct_column(right)),
        Expr::IsNull(expr) | Expr::IsNotNull(expr) => direct_column(expr),
        _ => false,
    }
}

fn join_constraint(operator: &JoinOperator) -> Option<&Expr> {
    match operator {
        JoinOperator::Join(JoinConstraint::On(expr))
        | JoinOperator::Inner(JoinConstraint::On(expr))
        | JoinOperator::Left(JoinConstraint::On(expr))
        | JoinOperator::LeftOuter(JoinConstraint::On(expr)) => Some(expr),
        _ => None,
    }
}

fn join_pairs(expr: &Expr) -> Option<Vec<(&Expr, &Expr)>> {
    match unnested(expr) {
        Expr::BinaryOp {
            left,
            op: BinaryOperator::And,
            right,
        } => {
            let mut pairs = join_pairs(left)?;
            pairs.extend(join_pairs(right)?);
            Some(pairs)
        }
        Expr::BinaryOp {
            left,
            op: BinaryOperator::Eq,
            right,
        } if direct_column(left) && direct_column(right) => Some(vec![(left, right)]),
        _ => None,
    }
}

fn check_shape(select: &Select) -> std::result::Result<(), &'static str> {
    if select.from.len() != 1 || select.from[0].joins.len() > 1 {
        return Err("仅支持一个FROM表和至多一个关联；多关联、逗号关联未检查。");
    }
    if select.distinct.is_some()
        || select.having.is_some()
        || !select.named_window.is_empty()
        || select.qualify.is_some()
        || select.into.is_some()
        || select.prewhere.is_some()
        || !select.lateral_views.is_empty()
        || select.connect_by.is_some()
        || select.top.is_some()
        || select.exclude.is_some()
        || !select.cluster_by.is_empty()
        || !select.distribute_by.is_empty()
        || !select.sort_by.is_empty()
        || select.value_table_mode.is_some()
    {
        return Err("去重、HAVING、窗口及其他特殊SELECT结构未检查。");
    }
    for item in &select.projection {
        match item {
            SelectItem::Wildcard(options) if plain_wildcard(options) => (),
            SelectItem::QualifiedWildcard(
                SelectItemQualifiedWildcardKind::ObjectName(name),
                options,
            ) if plain_name(name).is_some() && plain_wildcard(options) => (),
            _ if projection_expr(item)
                .is_some_and(|expr| direct_column(expr) || sum_column(expr).is_some()) => {}
            _ => return Err("仅支持直接列及SUM(直接列)；其他聚合、换算、窗口和复杂表达式未检查。"),
        }
    }
    match &select.group_by {
        GroupByExpr::Expressions(exprs, modifiers)
            if modifiers.is_empty() && exprs.iter().all(direct_column) => {}
        _ => return Err("仅支持直接列GROUP BY；分组表达式与分组集未检查。"),
    }
    if select
        .selection
        .as_ref()
        .is_some_and(|expr| !simple_predicate(expr))
    {
        return Err("仅支持AND连接的直接列比较及空值条件；OR、子查询和复杂过滤未检查。");
    }
    if let Some(join) = select.from[0].joins.first()
        && join_constraint(&join.join_operator)
            .and_then(join_pairs)
            .is_none()
    {
        return Err("仅支持INNER/LEFT JOIN的AND等值列关联；其他关联未检查。");
    }
    Ok(())
}

fn object_ref(object: &Value) -> Value {
    json!({"object_id":object["id"],"version":object["version"]})
}

fn effective_structures<'a>(object: &'a Value, kind: &str) -> Vec<&'a Value> {
    object["entries"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .filter(|entry| entry["review_state"] == "confirmed")
        .map(|entry| &entry["effective_structure"])
        .filter(|structure| structure["kind"] == kind)
        .collect()
}

fn ref_matches(reference: &Value, object: &Value) -> bool {
    reference["object_id"] == object["id"] && reference["version"] == object["version"]
}

fn resolve_column(expr: &Expr, bindings: &[Binding<'_>]) -> Option<Column> {
    let (qualifier, column) = match unnested(expr) {
        Expr::Identifier(ident) => (None, ident.value.as_str()),
        Expr::CompoundIdentifier(idents) if idents.len() >= 2 => (
            Some(
                idents[..idents.len() - 1]
                    .iter()
                    .map(|ident| ident.value.as_str())
                    .collect::<Vec<_>>()
                    .join("."),
            ),
            idents.last()?.value.as_str(),
        ),
        _ => return None,
    };
    let candidates: Vec<_> = bindings
        .iter()
        .filter(|binding| {
            qualifier.as_ref().is_none_or(|qualifier| {
                binding
                    .alias
                    .as_ref()
                    .unwrap_or(&binding.name)
                    .eq_ignore_ascii_case(qualifier)
            })
        })
        .filter_map(|binding| binding.object)
        .filter(|object| {
            if object["column_names_complete"] != true {
                return false;
            }
            object["column_names"].as_array().is_some_and(|columns| {
                columns.iter().any(|name| {
                    name.as_str()
                        .is_some_and(|name| name.eq_ignore_ascii_case(column))
                })
            })
        })
        .collect();
    if candidates.len() != 1 {
        return None;
    }
    Some(Column {
        table_id: candidates[0]["id"].as_str()?.to_owned(),
        name: column.to_ascii_lowercase(),
    })
}

fn check_join(
    expr: &Expr,
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
    let candidates: Vec<_> = objects
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
        .collect();
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
    for (left, right) in join_pairs(expr).unwrap() {
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

fn check_metrics(
    select: &Select,
    parameters: &Value,
    bindings: &[Binding<'_>],
    sums: &[Column],
    objects: &[Value],
    report: &mut Report,
) {
    let candidates: Vec<_> = objects
        .iter()
        .filter(|object| object["kind"] == "metric" && object["state"] == "enabled")
        .flat_map(|object| {
            effective_structures(object, "metric")
                .into_iter()
                .map(move |structure| (object, structure))
        })
        .collect();
    if candidates.len() != 1 {
        report.missing(
            "metric_binding",
            vec![],
            "未明确选用唯一有效指标；不根据SQL别名猜测指标、时间或单位。",
        );
        return;
    }
    let (metric, structure) = candidates[0];
    let refs = vec![object_ref(metric)];
    let Some(table) = bindings
        .iter()
        .filter_map(|binding| binding.object)
        .find(|object| ref_matches(&structure["table"], object))
    else {
        report.missing(
            "metric_expression",
            refs,
            "指标的表引用缺失或版本不一致，计算口径未检查。",
        );
        return;
    };
    if table["column_names_complete"] != true {
        report.missing(
            "metric_expression",
            refs,
            "指标表的列目录不完整，计算表达式未检查。",
        );
        return;
    }
    let Some(expression) = structure["expression"].as_str() else {
        report.missing("metric_expression", refs, "指标缺少计算表达式，未检查。");
        return;
    };
    let parsed = Parser::new(&SQLiteDialect {})
        .with_recursion_limit(32)
        .try_with_sql(&format!("SELECT {expression}"))
        .and_then(|mut parser| parser.parse_statements());
    let column = parsed.ok().and_then(|statements| {
        let [Statement::Query(query)] = statements.as_slice() else {
            return None;
        };
        if query.with.is_some() || query.order_by.is_some() || query.limit_clause.is_some() {
            return None;
        }
        let SetExpr::Select(select) = query.body.as_ref() else {
            return None;
        };
        if !select.from.is_empty() || select.selection.is_some() {
            return None;
        }
        let [item] = select.projection.as_slice() else {
            return None;
        };
        let expr = sum_column(projection_expr(item)?)?;
        match unnested(expr) {
            Expr::Identifier(ident) => Some(ident.value.to_ascii_lowercase()),
            // 正式表达式只允许本指标表的明确物理表限定，不能猜作者临时别名。
            Expr::CompoundIdentifier(idents) => {
                let qualifier = idents[..idents.len() - 1]
                    .iter()
                    .map(|ident| ident.value.as_str())
                    .collect::<Vec<_>>()
                    .join(".");
                table["name"]
                    .as_str()
                    .filter(|name| name.eq_ignore_ascii_case(&qualifier))?;
                Some(idents.last()?.value.to_ascii_lowercase())
            }
            _ => None,
        }
    });
    let Some(column) = column else {
        report.missing(
            "metric_expression",
            refs,
            "指标定义不是可对应的SUM(直接列)，复杂计算SQL或表达式未检查。",
        );
        return;
    };
    if !table["column_names"].as_array().is_some_and(|columns| {
        columns.iter().any(|name| {
            name.as_str()
                .is_some_and(|name| name.eq_ignore_ascii_case(&column))
        })
    }) {
        report.missing(
            "metric_expression",
            refs,
            "指标输入列不能对应当前列目录，未检查。",
        );
        return;
    }
    if select
        .projection
        .iter()
        .filter_map(projection_expr)
        .filter_map(sum_column)
        .any(|column| resolve_column(column, bindings).is_none())
    {
        report.missing(
            "metric_expression",
            refs,
            "SQL的SUM列存在无法唯一解析的引用，指标对应关系未检查。",
        );
        return;
    }
    if !sums
        .iter()
        .any(|sum| sum.table_id == table["id"].as_str().unwrap_or("") && sum.name == column)
    {
        report.add(
            "metric_expression",
            "warning",
            refs,
            "SQL没有对应明确选用指标的直接列SUM。",
            LIMITATION,
        );
        return;
    }
    report.add(
        "metric_expression",
        "checked",
        refs.clone(),
        "SQL包含明确选用指标的SUM(直接列)。",
        "只对应此表达式；指标的必要过滤、分组维度、输入粒度与多项输出仍需核对。",
    );
    check_metric_time(
        select,
        parameters,
        bindings,
        table,
        structure,
        refs.clone(),
        report,
    );
    let fields: Vec<_> = objects
        .iter()
        .filter(|object| object["kind"] == "field" && object["state"] == "enabled")
        .flat_map(|object| {
            effective_structures(object, "field")
                .into_iter()
                .map(move |value| (object, value))
        })
        .filter(|(_, field)| {
            ref_matches(&field["table"], table)
                && field["column"]
                    .as_str()
                    .is_some_and(|value| value.eq_ignore_ascii_case(&column))
        })
        .collect();
    let unit = structure["unit"].as_str();
    if fields.len() != 1 || unit.is_none() || fields[0].1["unit"].as_str().is_none() {
        report.missing(
            "metric_unit",
            refs,
            "缺少唯一输入字段单位或指标单位，单位未检查。",
        );
        return;
    }
    let (field, field_structure) = fields[0];
    let mismatch = field_structure["unit"].as_str() != unit;
    report.add(
        "metric_unit",
        if mismatch { "warning" } else { "checked" },
        vec![object_ref(metric), object_ref(field)],
        if mismatch {
            "直接SUM的输入字段单位与指标单位不同，SQL未包含可核对的换算。"
        } else {
            "直接SUM的输入字段单位与选用指标单位一致。"
        },
        "仅比较明确单位文本，不猜测汇率、币种或单位换算；复杂表达式未检查。",
    );
}

fn scalar_bound(expr: &Expr, parameters: &Value) -> bool {
    match unnested(expr) {
        Expr::Value(value) => match &value.value {
            SqlValue::Placeholder(name) => parameters
                .get(name)
                .or_else(|| parameters.get(name.trim_start_matches([':', '@', '$'])))
                .is_some_and(|value| value.is_string() || value.is_number()),
            SqlValue::SingleQuotedString(_) | SqlValue::Number(_, _) => true,
            _ => false,
        },
        _ => false,
    }
}

fn check_metric_time(
    select: &Select,
    parameters: &Value,
    bindings: &[Binding<'_>],
    table: &Value,
    metric: &Value,
    refs: Vec<Value>,
    report: &mut Report,
) {
    let Some(expected) = metric["time_column"].as_str() else {
        report.missing("metric_time", refs, "指标未指定时间依据，时间条件未检查。");
        return;
    };
    let structures = effective_structures(table, "table");
    let times: BTreeSet<_> = structures
        .iter()
        .flat_map(|structure| {
            structure["time_columns"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or(&[])
        })
        .filter_map(|time| time["column"].as_str().map(str::to_ascii_lowercase))
        .collect();
    let mut leaves = Vec::new();
    if let Some(expr) = &select.selection {
        predicate_leaves(expr, &mut leaves);
    }
    let mut expected_bounds = [false; 2];
    let mut wrong_time = false;
    let mut unbound = false;
    for expr in leaves {
        let Expr::BinaryOp { left, op, right } = unnested(expr) else {
            continue;
        };
        let (column, bound, lower) = if direct_column(left) {
            (
                resolve_column(left, bindings),
                right.as_ref(),
                matches!(op, BinaryOperator::Gt | BinaryOperator::GtEq),
            )
        } else {
            (
                resolve_column(right, bindings),
                left.as_ref(),
                matches!(op, BinaryOperator::Lt | BinaryOperator::LtEq),
            )
        };
        if !matches!(
            op,
            BinaryOperator::Gt | BinaryOperator::GtEq | BinaryOperator::Lt | BinaryOperator::LtEq
        ) {
            continue;
        }
        let Some(column) = column else {
            continue;
        };
        if column.table_id != table["id"].as_str().unwrap_or("") {
            continue;
        }
        if column.name.eq_ignore_ascii_case(expected) {
            expected_bounds[usize::from(!lower)] = true;
            unbound |= !scalar_bound(bound, parameters);
        } else if times.contains(&column.name) {
            wrong_time = true;
        }
    }
    if wrong_time {
        report.add(
            "metric_time",
            "warning",
            refs,
            "SQL使用了与指标时间依据不同的已知时间列。",
            "只识别直接上下界；不同时间列可能是补充条件，需结合用户问题核对。",
        );
    } else if unbound {
        report.missing("metric_time", refs, "时间界参数缺失或不能核对，未检查。");
    } else if expected_bounds == [true, true] {
        report.add(
            "metric_time",
            "checked",
            refs,
            "SQL在选用指标的时间列上包含上下界且参数有值。",
            "不核对时区、自然日、边界是否符合用户要求或参数先后关系。",
        );
    } else {
        report.missing(
            "metric_time",
            refs,
            "指标时间列未包含完整可核对的上下界；不猜测用户是否需要不限时间。",
        );
    }
}

fn predicate_leaves<'a>(expr: &'a Expr, leaves: &mut Vec<&'a Expr>) {
    match unnested(expr) {
        Expr::BinaryOp {
            left,
            op: BinaryOperator::And,
            right,
        } => {
            predicate_leaves(left, leaves);
            predicate_leaves(right, leaves);
        }
        expr => leaves.push(expr),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(structure: Value) -> Value {
        json!({"effective_structure":structure,"review_state":"confirmed"})
    }

    fn snapshot() -> Value {
        json!({"objects":[
            {"id":"purchase","kind":"table","name":"warehouse.purchases","version":"7","state":"enabled",
                "column_names_complete":true,"column_names":["tenant_code","purchase_key","net_minor","event_day","loaded_day"],
                "entries":[entry(json!({"kind":"table","grain":"一行一笔购买",
                    "unique_keys":[["tenant_code","purchase_key"]],"time_columns":[
                        {"column":"event_day","role":"业务发生日"},{"column":"loaded_day","role":"入库日"}],
                    "default_filters":[],"constraints":[]}))]},
            {"id":"line","kind":"table","name":"warehouse.lines","version":"3","state":"enabled",
                "column_names_complete":true,"column_names":["tenant_code","purchase_key","line_key","line_minor"],"entries":[]},
            {"id":"purchase_lines","kind":"relationship","name":"购买关联条目","version":"5","state":"enabled",
                "entries":[entry(json!({"kind":"relationship","left_table":{"object_id":"purchase","version":"7"},
                    "right_table":{"object_id":"line","version":"3"},"join_keys":[
                        {"left_column":"tenant_code","right_column":"tenant_code"},
                        {"left_column":"purchase_key","right_column":"purchase_key"}],
                    "cardinality":"one_to_many","scope":"同一租户内按购买标识关联"}))]}
        ],"coverage":{"state":"complete","notes":[]}})
    }

    fn with_metric(unit: &str) -> Value {
        let mut snapshot = snapshot();
        snapshot["objects"].as_array_mut().unwrap().extend([
            json!({"id":"purchase_amount","kind":"metric","name":"购买净额","version":"4","state":"enabled",
                "entries":[entry(json!({"kind":"metric","table":{"object_id":"purchase","version":"7"},
                    "expression":"SUM(net_minor)","input_grain":"一行一笔购买","time_column":"event_day",
                    "unit":unit,"required_filters":[],"dimensions":[]}))]}),
            json!({"id":"purchase_net","kind":"field","name":"warehouse.purchases.net_minor","version":"2","state":"enabled",
                "entries":[entry(json!({"kind":"field","table":{"object_id":"purchase","version":"7"},
                    "column":"net_minor","unit":"分"}))]})
        ]);
        snapshot
    }

    fn state(report: &Value, rule: &str) -> String {
        report["checks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|check| check["rule"] == rule)
            .unwrap_or_else(|| panic!("missing {rule}: {report}"))["state"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    #[test]
    fn checked_warning_and_unknown_reports_follow_the_shared_contract() {
        for report in [
            check_semantics(
                &format!("SELECT SUM(p.net_minor) {JOIN}"),
                &json!({}),
                &snapshot(),
            ),
            check_semantics(
                "SELECT SUM(net_minor) FROM warehouse.purchases",
                &json!({}),
                &with_metric("元"),
            ),
            check_semantics(
                "SELECT COUNT(*) FROM warehouse.purchases",
                &json!({}),
                &snapshot(),
            ),
            check_semantics(
                "SELECT SUM(net_minor) FROM warehouse.purchases",
                &json!({}),
                &json!({"objects":[]}),
            ),
        ] {
            crate::contracts::validate("SemanticCheckReport", &report)
                .unwrap_or_else(|error| panic!("{error:?}: {report}"));
        }
    }

    const JOIN: &str = "FROM warehouse.purchases p LEFT JOIN warehouse.lines d ON d.tenant_code=p.tenant_code AND p.purchase_key=d.purchase_key";

    #[test]
    fn complete_composite_keys_and_one_side_sum_warn_without_blocking() {
        let report = check_semantics(
            &format!("SELECT SUM(p.net_minor) {JOIN}"),
            &json!({}),
            &snapshot(),
        );
        assert_eq!(state(&report, "join_keys"), "checked");
        assert_eq!(state(&report, "aggregate_cardinality"), "warning");
        assert_eq!(report["coverage"]["sql_shape"], "supported");
        assert!(report.get("semantic_passed").is_none());
        assert_eq!(
            report["checks"][1]["evidence_refs"][0],
            json!({"object_id":"purchase_lines","version":"5"})
        );
    }

    #[test]
    fn missing_or_wrong_composite_keys_are_warning_even_with_existing_columns() {
        for condition in [
            "p.purchase_key=d.purchase_key",
            "p.purchase_key=d.line_key AND p.tenant_code=d.tenant_code",
            "p.purchase_key=p.tenant_code AND p.tenant_code=d.tenant_code",
        ] {
            let sql = format!(
                "SELECT SUM(p.net_minor) FROM warehouse.purchases p INNER JOIN warehouse.lines d ON {condition}"
            );
            let report = check_semantics(&sql, &json!({}), &snapshot());
            assert_eq!(state(&report, "join_keys"), "warning", "{condition}");
            assert!(
                !report["checks"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|check| check["rule"] == "aggregate_cardinality")
            );
        }
    }

    #[test]
    fn relationship_direction_comes_from_stable_refs_and_not_from_sql_from_order() {
        let report = check_semantics(
            "SELECT SUM(p.net_minor) FROM warehouse.lines d INNER JOIN warehouse.purchases p ON p.purchase_key=d.purchase_key AND p.tenant_code=d.tenant_code",
            &json!({}),
            &snapshot(),
        );
        assert_eq!(state(&report, "join_keys"), "checked");
        assert_eq!(state(&report, "aggregate_cardinality"), "warning");
        let report = check_semantics(
            &format!("SELECT SUM(d.line_minor) {JOIN}"),
            &json!({}),
            &snapshot(),
        );
        assert_eq!(state(&report, "aggregate_cardinality"), "checked");
    }

    #[test]
    fn many_to_one_and_many_to_many_risk_directions_are_distinct() {
        let mut snapshot = snapshot();
        snapshot["objects"][2]["entries"][0]["effective_structure"]["cardinality"] =
            json!("many_to_one");
        assert_eq!(
            state(
                &check_semantics(
                    &format!("SELECT SUM(d.line_minor) {JOIN}"),
                    &json!({}),
                    &snapshot
                ),
                "aggregate_cardinality"
            ),
            "warning"
        );
        assert_eq!(
            state(
                &check_semantics(
                    &format!("SELECT SUM(p.net_minor) {JOIN}"),
                    &json!({}),
                    &snapshot
                ),
                "aggregate_cardinality"
            ),
            "checked"
        );
        snapshot["objects"][2]["entries"][0]["effective_structure"]["cardinality"] =
            json!("many_to_many");
        assert_eq!(
            state(
                &check_semantics(
                    &format!("SELECT SUM(p.net_minor) {JOIN}"),
                    &json!({}),
                    &snapshot
                ),
                "aggregate_cardinality"
            ),
            "warning"
        );
        snapshot["objects"][2]["entries"][0]["effective_structure"]["cardinality"] =
            json!("one_to_one");
        assert_eq!(
            state(
                &check_semantics(
                    &format!("SELECT SUM(p.net_minor) {JOIN}"),
                    &json!({}),
                    &snapshot
                ),
                "aggregate_cardinality"
            ),
            "checked"
        );
    }

    #[test]
    fn stale_disabled_needs_review_and_absent_rules_remain_not_checked() {
        for mutation in 0..5 {
            let mut snapshot = snapshot();
            match mutation {
                0 => {
                    snapshot["objects"][2]["entries"][0]["effective_structure"]["left_table"]["version"] =
                        json!("6")
                }
                1 => snapshot["objects"][2]["state"] = json!("disabled"),
                2 => snapshot["objects"][2]["entries"][0]["review_state"] = json!("needs_review"),
                3 => snapshot["objects"][2]["entries"] = json!([]),
                _ => snapshot["objects"][2]["entries"][0]["review_state"] = json!("unverified"),
            }
            let report = check_semantics(
                &format!("SELECT SUM(p.net_minor) {JOIN}"),
                &json!({}),
                &snapshot,
            );
            assert_eq!(state(&report, "join_keys"), "not_checked");
            assert!(
                !report["coverage"]["missing_semantics"]
                    .as_array()
                    .unwrap()
                    .is_empty()
            );
        }
        assert_eq!(
            state(
                &check_semantics(
                    &format!("SELECT SUM(p.net_minor) {JOIN}"),
                    &json!({}),
                    &json!({"objects":[]})
                ),
                "join_keys"
            ),
            "not_checked"
        );
    }

    #[test]
    fn incomplete_column_catalog_never_claims_expression_or_join_was_checked() {
        let mut snapshot = with_metric("分");
        snapshot["objects"][0]["column_names_complete"] = json!(false);
        let report = check_semantics(
            &format!("SELECT SUM(p.net_minor) {JOIN}"),
            &json!({}),
            &snapshot,
        );
        assert_eq!(state(&report, "join_keys"), "not_checked");
        assert_eq!(state(&report, "metric_expression"), "not_checked");
        assert_eq!(state(&report, "aggregate_columns"), "not_checked");
        assert!(
            !report["coverage"]["missing_semantics"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn ambiguous_relationship_and_unqualified_column_are_not_checked() {
        let mut snapshot = snapshot();
        let mut second = snapshot["objects"][2].clone();
        second["id"] = json!("alternate");
        snapshot["objects"].as_array_mut().unwrap().push(second);
        assert_eq!(
            state(
                &check_semantics(
                    &format!("SELECT SUM(p.net_minor) {JOIN}"),
                    &json!({}),
                    &snapshot
                ),
                "join_keys"
            ),
            "not_checked"
        );
        let report = check_semantics(
            "SELECT SUM(p.net_minor) FROM warehouse.purchases p JOIN warehouse.lines d ON tenant_code=p.tenant_code AND p.purchase_key=d.purchase_key",
            &json!({}),
            &super::tests::snapshot(),
        );
        assert_eq!(state(&report, "join_keys"), "not_checked");
    }

    #[test]
    fn aliases_are_not_used_to_guess_metric_meaning() {
        let report = check_semantics(
            "SELECT SUM(net_minor) AS purchase_amount FROM warehouse.purchases",
            &json!({}),
            &snapshot(),
        );
        assert_eq!(state(&report, "metric_binding"), "not_checked");
        assert!(
            !report["checks"]
                .as_array()
                .unwrap()
                .iter()
                .any(|check| check["rule"] == "metric_unit")
        );
    }

    #[test]
    fn explicitly_bound_metric_matches_direct_sum_time_and_unit() {
        let report = check_semantics(
            "SELECT SUM(p.net_minor) AS total FROM warehouse.purchases p WHERE p.event_day >= :start AND p.event_day < :end",
            &json!({"start":"2035-02-01","end":"2035-03-01"}),
            &with_metric("分"),
        );
        assert_eq!(state(&report, "metric_expression"), "checked");
        assert_eq!(state(&report, "metric_time"), "checked");
        assert_eq!(state(&report, "metric_unit"), "checked");
    }

    #[test]
    fn explicit_time_column_and_unit_mismatches_warn() {
        let report = check_semantics(
            "SELECT SUM(p.net_minor) FROM warehouse.purchases p WHERE p.loaded_day >= '2035-02-01' AND p.loaded_day < '2035-03-01'",
            &json!({}),
            &with_metric("元"),
        );
        assert_eq!(state(&report, "metric_time"), "warning");
        assert_eq!(state(&report, "metric_unit"), "warning");
    }

    #[test]
    fn missing_time_bounds_or_parameters_do_not_claim_checked() {
        for (sql, parameters) in [
            ("SELECT SUM(net_minor) FROM warehouse.purchases", json!({})),
            (
                "SELECT SUM(net_minor) FROM warehouse.purchases WHERE event_day >= :start AND event_day < :end",
                json!({"start":"2035-01-01"}),
            ),
            (
                "SELECT SUM(net_minor) FROM warehouse.purchases WHERE event_day >= '2035-01-01'",
                json!({}),
            ),
        ] {
            assert_eq!(
                state(
                    &check_semantics(sql, &parameters, &with_metric("分")),
                    "metric_time"
                ),
                "not_checked"
            );
        }
        let report = check_semantics(
            "SELECT SUM(net_minor) FROM warehouse.purchases WHERE '2035-01-01' <= event_day AND '2035-02-01' > event_day",
            &json!({}),
            &with_metric("分"),
        );
        assert_eq!(state(&report, "metric_time"), "checked");
    }

    #[test]
    fn missing_units_and_wrong_metric_expressions_are_explicit() {
        let mut snapshot = with_metric("分");
        snapshot["objects"][4]["entries"][0]["effective_structure"]["unit"] = Value::Null;
        let report = check_semantics(
            "SELECT SUM(net_minor) FROM warehouse.purchases",
            &json!({}),
            &snapshot,
        );
        assert_eq!(state(&report, "metric_unit"), "not_checked");
        let report = check_semantics(
            "SELECT SUM(p.purchase_key) FROM warehouse.purchases p",
            &json!({}),
            &snapshot,
        );
        assert_eq!(state(&report, "metric_expression"), "warning");
        assert!(
            !report["checks"]
                .as_array()
                .unwrap()
                .iter()
                .any(|check| check["rule"] == "metric_unit")
        );
        snapshot["objects"][3]["entries"][0]["effective_structure"]["expression"] =
            json!("SUM(net_minor) / 100");
        assert_eq!(
            state(
                &check_semantics(
                    "SELECT SUM(net_minor) FROM warehouse.purchases",
                    &json!({}),
                    &snapshot
                ),
                "metric_expression"
            ),
            "not_checked"
        );
    }

    #[test]
    fn complex_sql_is_not_checked_instead_of_flagged_as_semantic_failure() {
        for sql in [
            "WITH p AS (SELECT purchase_key, SUM(net_minor) AS net FROM warehouse.purchases GROUP BY purchase_key) SELECT SUM(net) FROM p",
            "SELECT SUM(p.net) FROM (SELECT purchase_key, SUM(net_minor) AS net FROM warehouse.purchases GROUP BY purchase_key) p",
            "SELECT SUM(net_minor) FROM warehouse.purchases UNION ALL SELECT SUM(line_minor) FROM warehouse.lines",
            "SELECT SUM(DISTINCT net_minor) FROM warehouse.purchases",
            "SELECT SUM(net_minor) OVER (PARTITION BY tenant_code) FROM warehouse.purchases",
            "SELECT SUM(net_minor / 100) FROM warehouse.purchases",
            "SELECT COUNT(*) FROM warehouse.purchases",
            "SELECT SUM(net_minor) FROM warehouse.purchases WHERE event_day > '2035-01-01' OR event_day IS NULL",
            "SELECT SUM(p.net_minor) FROM warehouse.purchases p JOIN warehouse.lines d USING(purchase_key)",
            "SELECT SUM(p.net_minor) FROM warehouse.purchases p JOIN warehouse.lines d ON p.purchase_key=d.purchase_key JOIN warehouse.lines e ON e.line_key=d.line_key",
            "SELECT SUM(net_minor) FROM warehouse.purchases; SELECT * FROM warehouse.lines",
        ] {
            let report = check_semantics(sql, &json!({}), &with_metric("分"));
            assert_eq!(state(&report, "sql_shape"), "not_checked", "{sql}");
            assert_eq!(report["coverage"]["sql_shape"], "unsupported");
            assert_eq!(report["checks"].as_array().unwrap().len(), 1);
        }
    }

    #[test]
    fn quoted_table_names_and_column_case_use_ast_identity() {
        let report = check_semantics(
            "SELECT SUM(P.NET_MINOR) FROM \"warehouse\".\"purchases\" AS P JOIN warehouse.lines AS D ON P.TENANT_CODE=D.TENANT_CODE AND P.PURCHASE_KEY=D.PURCHASE_KEY",
            &json!({}),
            &snapshot(),
        );
        assert_eq!(state(&report, "join_keys"), "checked");
        assert_eq!(state(&report, "aggregate_cardinality"), "warning");
    }

    #[test]
    fn malformed_and_overly_deep_sql_are_bounded_parser_failures() {
        for sql in [
            "SELECT (FROM",
            &format!(
                "SELECT {}net_minor{} FROM warehouse.purchases",
                "(".repeat(80),
                ")".repeat(80)
            ),
        ] {
            let report = check_semantics(sql, &json!({}), &snapshot());
            assert_eq!(report["coverage"]["sql_shape"], "unsupported");
        }
    }
}
