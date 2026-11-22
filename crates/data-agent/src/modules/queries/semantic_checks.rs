mod metrics;
mod relations;
pub use metrics::annotate_result_columns;
use metrics::{check_metrics, metric_expression, mixes_metric_boundary};
use relations::{check_join, multi_grain_rewrite};

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
    tokenizer::{Token, Tokenizer},
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
    let join_keys = match check_shape(select) {
        Ok(keys) => keys,
        Err(reason) => return unsupported(reason),
    };
    let objects = snapshot["objects"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let relation = &select.from[0];
    let Some(bindings) = table_bindings(select, objects) else {
        return unsupported("仅支持普通表及表别名；子查询、表函数、采样和历史表版本未检查。");
    };
    let simple_projection = select.projection.iter().all(|item| match item {
        SelectItem::Wildcard(options) => plain_wildcard(options),
        SelectItem::QualifiedWildcard(
            SelectItemQualifiedWildcardKind::ObjectName(name),
            options,
        ) => plain_name(name).is_some() && plain_wildcard(options),
        _ => projection_expr(item)
            .is_some_and(|expr| direct_column(expr) || sum_column(expr).is_some()),
    });
    let metrics: Vec<_> = objects
        .iter()
        .filter(|object| object["kind"] == "metric" && object["state"] == "enabled")
        .flat_map(|object| {
            effective_structures(object, "metric")
                .into_iter()
                .map(move |structure| (object, structure))
        })
        .collect();
    let rewrite = relation
        .joins
        .first()
        .and_then(|join| multi_grain_rewrite(&join.join_operator, &bindings, objects, &metrics));
    if !simple_projection {
        let mut checks = Vec::new();
        if let ([binding], [(metric, structure)]) = (bindings.as_slice(), metrics.as_slice())
            && binding.object.is_some_and(|table| {
                ref_matches(&structure["table"], table) && table["column_names_complete"] == true
            })
            && let Some(expression) = structure["expression"].as_str()
            && let Some(expected) = metric_expression(expression)
            && mixes_metric_boundary(select, &expected, binding)
        {
            checks.push(json!({
                "rule":"metric_boundary_mixed", "state":"warning", "evidence_refs":[object_ref(metric)],
                "finding":"此列把已确认指标和空值样本加减合并，结果与登记口径不同。若需分别核对，请分列展示。",
                "coverage_limit":"仅比对单表顶层投影中的加减项，不判定用户意图或执行权限。"
            }));
        }
        checks.extend(rewrite);
        return coverage_unsupported(
            "仅支持直接列及SUM(直接列)；其他聚合、换算、窗口和复杂表达式未检查。",
            checks,
        );
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
    if let Some(keys) = join_keys {
        check_join(keys, &bindings, &sums, objects, &mut report);
    }
    report.checks.extend(rewrite);
    check_metrics(
        select,
        parameters,
        &bindings,
        &sums,
        objects,
        &metrics,
        &mut report,
    );
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
    coverage_unsupported(reason, Vec::new())
}

fn coverage_unsupported(reason: &str, mut checks: Vec<Value>) -> Value {
    checks.insert(
        0,
        json!({"rule":"sql_shape","state":"not_checked","evidence_refs":[],
        "finding":reason,"coverage_limit":LIMITATION}),
    );
    json!({"checks":checks,"coverage":{"sql_shape":"unsupported",
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

fn table_bindings<'a>(select: &Select, objects: &'a [Value]) -> Option<Vec<Binding<'a>>> {
    let [relation] = select.from.as_slice() else {
        return None;
    };
    std::iter::once(&relation.relation)
        .chain(relation.joins.iter().map(|join| &join.relation))
        .map(|table| {
            let (name, alias) = physical_table(table)?;
            let mut candidates = objects.iter().filter(|object| {
                object["kind"] == "table"
                    && object["state"] == "enabled"
                    && object["name"]
                        .as_str()
                        .is_some_and(|n| n.eq_ignore_ascii_case(&name))
            });
            let object = candidates.next().filter(|_| candidates.next().is_none());
            Some(Binding {
                name,
                alias,
                object,
            })
        })
        .collect()
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

type JoinKeys<'a> = Vec<(&'a Expr, &'a Expr)>;

fn check_shape(select: &Select) -> std::result::Result<Option<JoinKeys<'_>>, &'static str> {
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
    select.from[0]
        .joins
        .first()
        .map(|join| {
            join_constraint(&join.join_operator)
                .and_then(join_pairs)
                .ok_or("仅支持INNER/LEFT JOIN的AND等值列关联；其他关联未检查。")
        })
        .transpose()
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

#[cfg(test)]
#[path = "semantic_checks/tests/semantic_checks.rs"]
mod tests;
