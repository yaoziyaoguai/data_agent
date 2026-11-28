use sqlparser::{
    ast::{
        Expr, FunctionArg, FunctionArgExpr, FunctionArgumentClause, FunctionArguments, GroupByExpr,
        JoinConstraint, JoinOperator, LimitClause, NamedWindowExpr, ObjectName, OrderByKind, Query,
        Select, SelectItem, SetExpr, Statement, TableFactor, TableWithJoins, WindowFrameBound,
        WindowSpec, WindowType,
    },
    dialect::SQLiteDialect,
    parser::Parser,
};
use std::collections::BTreeSet;

/// 解析单条只读SQL实际引用的底层物理表名（小写去重），排除语句内CTE别名。
/// 无法完整解析、多语句或包含表函数/跨库限定等不可静态证明的构造时返回None（fail-closed）。
pub fn referenced_tables(sql: &str) -> Option<BTreeSet<String>> {
    let statements = Parser::new(&SQLiteDialect {})
        .with_recursion_limit(32)
        .try_with_sql(sql)
        .and_then(|mut parser| parser.parse_statements())
        .ok()?;
    let [Statement::Query(query)] = statements.as_slice() else {
        return None;
    };
    let mut tables = BTreeSet::new();
    let ctes = BTreeSet::new();
    walk_query(query, &ctes, &mut tables).then_some(tables)
}

fn single_ident(name: &ObjectName) -> Option<String> {
    let [part] = name.0.as_slice() else {
        return None;
    };
    Some(part.as_ident()?.value.to_ascii_lowercase())
}

fn walk_query(query: &Query, outer_ctes: &BTreeSet<String>, out: &mut BTreeSet<String>) -> bool {
    if query.fetch.is_some()
        || !query.locks.is_empty()
        || query.for_clause.is_some()
        || query.settings.is_some()
        || query.format_clause.is_some()
        || !query.pipe_operators.is_empty()
    {
        return false;
    }
    let mut ctes = outer_ctes.clone();
    if let Some(with) = &query.with {
        if with.recursive {
            for cte in &with.cte_tables {
                if cte.from.is_some() {
                    return false;
                }
                ctes.insert(cte.alias.name.value.to_ascii_lowercase());
            }
            for cte in &with.cte_tables {
                if !walk_query(&cte.query, &ctes, out) {
                    return false;
                }
            }
        } else {
            for cte in &with.cte_tables {
                if cte.from.is_some() || !walk_query(&cte.query, &ctes, out) {
                    return false;
                }
                ctes.insert(cte.alias.name.value.to_ascii_lowercase());
            }
        }
    }
    if !walk_set_expr(&query.body, &ctes, out) {
        return false;
    }
    if let Some(order_by) = &query.order_by {
        if order_by.interpolate.is_some() {
            return false;
        }
        match &order_by.kind {
            OrderByKind::Expressions(exprs) => {
                if !exprs
                    .iter()
                    .all(|item| item.with_fill.is_none() && walk_expr(&item.expr, &ctes, out))
                {
                    return false;
                }
            }
            OrderByKind::All(_) => {}
        }
    }
    if let Some(limit) = &query.limit_clause {
        let ok = match limit {
            LimitClause::LimitOffset {
                limit,
                offset,
                limit_by,
            } => {
                limit.as_ref().is_none_or(|e| walk_expr(e, &ctes, out))
                    && offset
                        .as_ref()
                        .is_none_or(|o| walk_expr(&o.value, &ctes, out))
                    && limit_by.iter().all(|e| walk_expr(e, &ctes, out))
            }
            LimitClause::OffsetCommaLimit { offset, limit } => {
                walk_expr(offset, &ctes, out) && walk_expr(limit, &ctes, out)
            }
        };
        if !ok {
            return false;
        }
    }
    true
}

fn walk_set_expr(expr: &SetExpr, ctes: &BTreeSet<String>, out: &mut BTreeSet<String>) -> bool {
    match expr {
        SetExpr::Select(select) => walk_select(select, ctes, out),
        SetExpr::Query(query) => walk_query(query, ctes, out),
        SetExpr::SetOperation { left, right, .. } => {
            walk_set_expr(left, ctes, out) && walk_set_expr(right, ctes, out)
        }
        SetExpr::Values(values) => values
            .rows
            .iter()
            .flatten()
            .all(|e| walk_expr(e, ctes, out)),
        _ => false,
    }
}

fn walk_select(select: &Select, ctes: &BTreeSet<String>, out: &mut BTreeSet<String>) -> bool {
    if select.into.is_some()
        || select.prewhere.is_some()
        || !select.lateral_views.is_empty()
        || select.connect_by.is_some()
        || select.top.is_some()
        || select.value_table_mode.is_some()
    {
        return false;
    }
    if let Some(sqlparser::ast::Distinct::On(exprs)) = &select.distinct
        && !exprs.iter().all(|e| walk_expr(e, ctes, out))
    {
        return false;
    }
    if !select
        .from
        .iter()
        .all(|t| walk_table_with_joins(t, ctes, out))
    {
        return false;
    }
    for item in &select.projection {
        let ok = match item {
            SelectItem::UnnamedExpr(e) | SelectItem::ExprWithAlias { expr: e, .. } => {
                walk_expr(e, ctes, out)
            }
            SelectItem::Wildcard(opts) | SelectItem::QualifiedWildcard(_, opts) => {
                opts.opt_ilike.is_none()
                    && opts.opt_exclude.is_none()
                    && opts.opt_except.is_none()
                    && opts.opt_replace.is_none()
                    && opts.opt_rename.is_none()
            }
        };
        if !ok {
            return false;
        }
    }
    if select
        .selection
        .as_ref()
        .is_some_and(|e| !walk_expr(e, ctes, out))
    {
        return false;
    }
    match &select.group_by {
        GroupByExpr::Expressions(exprs, modifiers) => {
            if !modifiers.is_empty() || !exprs.iter().all(|e| walk_expr(e, ctes, out)) {
                return false;
            }
        }
        GroupByExpr::All(modifiers) => {
            if !modifiers.is_empty() {
                return false;
            }
        }
    }
    if select
        .having
        .as_ref()
        .is_some_and(|e| !walk_expr(e, ctes, out))
        || select
            .qualify
            .as_ref()
            .is_some_and(|e| !walk_expr(e, ctes, out))
        || !select
            .cluster_by
            .iter()
            .chain(&select.distribute_by)
            .all(|e| walk_expr(e, ctes, out))
        || !select
            .sort_by
            .iter()
            .all(|o| o.with_fill.is_none() && walk_expr(&o.expr, ctes, out))
    {
        return false;
    }
    select.named_window.iter().all(|def| match &def.1 {
        NamedWindowExpr::NamedWindow(_) => true,
        NamedWindowExpr::WindowSpec(spec) => walk_window_spec(spec, ctes, out),
    })
}

fn walk_table_with_joins(
    table: &TableWithJoins,
    ctes: &BTreeSet<String>,
    out: &mut BTreeSet<String>,
) -> bool {
    walk_table_factor(&table.relation, ctes, out)
        && table.joins.iter().all(|join| {
            walk_table_factor(&join.relation, ctes, out)
                && walk_join_operator(&join.join_operator, ctes, out)
        })
}

fn walk_join_operator(
    op: &JoinOperator,
    ctes: &BTreeSet<String>,
    out: &mut BTreeSet<String>,
) -> bool {
    let constraint = match op {
        JoinOperator::Join(c)
        | JoinOperator::Inner(c)
        | JoinOperator::Left(c)
        | JoinOperator::LeftOuter(c)
        | JoinOperator::Right(c)
        | JoinOperator::RightOuter(c)
        | JoinOperator::FullOuter(c)
        | JoinOperator::Semi(c)
        | JoinOperator::LeftSemi(c)
        | JoinOperator::RightSemi(c)
        | JoinOperator::Anti(c)
        | JoinOperator::LeftAnti(c)
        | JoinOperator::RightAnti(c)
        | JoinOperator::CrossJoin(c) => Some(c),
        _ => return false,
    };
    match constraint {
        None | Some(JoinConstraint::Natural | JoinConstraint::None) => true,
        Some(JoinConstraint::Using(_)) => true,
        Some(JoinConstraint::On(expr)) => walk_expr(expr, ctes, out),
    }
}

fn walk_table_factor(
    factor: &TableFactor,
    ctes: &BTreeSet<String>,
    out: &mut BTreeSet<String>,
) -> bool {
    match factor {
        TableFactor::Table {
            name,
            args: None,
            with_hints,
            version: None,
            with_ordinality: false,
            partitions,
            json_path: None,
            sample: None,
            index_hints,
            ..
        } if with_hints.is_empty() && partitions.is_empty() && index_hints.is_empty() => {
            let Some(ident) = single_ident(name) else {
                return false;
            };
            if !ctes.contains(&ident) {
                out.insert(ident);
            }
            true
        }
        TableFactor::Derived {
            lateral: false,
            subquery,
            ..
        } => walk_query(subquery, ctes, out),
        TableFactor::NestedJoin {
            table_with_joins, ..
        } => walk_table_with_joins(table_with_joins, ctes, out),
        _ => false,
    }
}

fn walk_window_spec(
    spec: &WindowSpec,
    ctes: &BTreeSet<String>,
    out: &mut BTreeSet<String>,
) -> bool {
    spec.partition_by.iter().all(|e| walk_expr(e, ctes, out))
        && spec
            .order_by
            .iter()
            .all(|o| o.with_fill.is_none() && walk_expr(&o.expr, ctes, out))
        && spec.window_frame.as_ref().is_none_or(|frame| {
            walk_frame_bound(&frame.start_bound, ctes, out)
                && frame
                    .end_bound
                    .as_ref()
                    .is_none_or(|b| walk_frame_bound(b, ctes, out))
        })
}

fn walk_frame_bound(
    bound: &WindowFrameBound,
    ctes: &BTreeSet<String>,
    out: &mut BTreeSet<String>,
) -> bool {
    match bound {
        WindowFrameBound::CurrentRow
        | WindowFrameBound::Preceding(None)
        | WindowFrameBound::Following(None) => true,
        WindowFrameBound::Preceding(Some(e)) | WindowFrameBound::Following(Some(e)) => {
            walk_expr(e, ctes, out)
        }
    }
}

fn walk_expr(expr: &Expr, ctes: &BTreeSet<String>, out: &mut BTreeSet<String>) -> bool {
    match expr {
        Expr::Identifier(_)
        | Expr::CompoundIdentifier(_)
        | Expr::Value(_)
        | Expr::TypedString { .. } => true,
        Expr::Nested(inner)
        | Expr::UnaryOp { expr: inner, .. }
        | Expr::IsNull(inner)
        | Expr::IsNotNull(inner)
        | Expr::IsTrue(inner)
        | Expr::IsNotTrue(inner)
        | Expr::IsFalse(inner)
        | Expr::IsNotFalse(inner)
        | Expr::IsUnknown(inner)
        | Expr::IsNotUnknown(inner)
        | Expr::Cast { expr: inner, .. }
        | Expr::Extract { expr: inner, .. }
        | Expr::Ceil { expr: inner, .. }
        | Expr::Floor { expr: inner, .. } => walk_expr(inner, ctes, out),
        Expr::BinaryOp { left, right, .. }
        | Expr::IsDistinctFrom(left, right)
        | Expr::IsNotDistinctFrom(left, right)
        | Expr::AnyOp { left, right, .. }
        | Expr::AllOp { left, right, .. } => {
            walk_expr(left, ctes, out) && walk_expr(right, ctes, out)
        }
        Expr::Like { expr, pattern, .. }
        | Expr::ILike { expr, pattern, .. }
        | Expr::SimilarTo { expr, pattern, .. }
        | Expr::RLike { expr, pattern, .. } => {
            walk_expr(expr, ctes, out) && walk_expr(pattern, ctes, out)
        }
        Expr::Between {
            expr, low, high, ..
        } => walk_expr(expr, ctes, out) && walk_expr(low, ctes, out) && walk_expr(high, ctes, out),
        Expr::InList { expr, list, .. } => {
            walk_expr(expr, ctes, out) && list.iter().all(|item| walk_expr(item, ctes, out))
        }
        Expr::InSubquery { expr, subquery, .. } => {
            walk_expr(expr, ctes, out) && walk_query(subquery, ctes, out)
        }
        Expr::Subquery(subquery) | Expr::Exists { subquery, .. } => walk_query(subquery, ctes, out),
        Expr::Case {
            operand,
            conditions,
            else_result,
            ..
        } => {
            operand.as_ref().is_none_or(|e| walk_expr(e, ctes, out))
                && conditions
                    .iter()
                    .all(|w| walk_expr(&w.condition, ctes, out) && walk_expr(&w.result, ctes, out))
                && else_result.as_ref().is_none_or(|e| walk_expr(e, ctes, out))
        }
        Expr::Tuple(items) => items.iter().all(|e| walk_expr(e, ctes, out)),
        Expr::Substring {
            expr,
            substring_from,
            substring_for,
            ..
        } => {
            walk_expr(expr, ctes, out)
                && substring_from
                    .as_ref()
                    .is_none_or(|e| walk_expr(e, ctes, out))
                && substring_for
                    .as_ref()
                    .is_none_or(|e| walk_expr(e, ctes, out))
        }
        Expr::Trim {
            expr, trim_what, ..
        } => {
            walk_expr(expr, ctes, out) && trim_what.as_ref().is_none_or(|e| walk_expr(e, ctes, out))
        }
        Expr::Position { expr, r#in } => walk_expr(expr, ctes, out) && walk_expr(r#in, ctes, out),
        Expr::Interval(interval) => walk_expr(&interval.value, ctes, out),
        Expr::Function(func) => {
            let args_ok = match &func.parameters {
                FunctionArguments::None => true,
                FunctionArguments::Subquery(q) => walk_query(q, ctes, out),
                FunctionArguments::List(list) => walk_function_arg_list(list, ctes, out),
            } && match &func.args {
                FunctionArguments::None => true,
                FunctionArguments::Subquery(q) => walk_query(q, ctes, out),
                FunctionArguments::List(list) => walk_function_arg_list(list, ctes, out),
            };
            args_ok
                && func.filter.as_ref().is_none_or(|e| walk_expr(e, ctes, out))
                && func
                    .within_group
                    .iter()
                    .all(|o| o.with_fill.is_none() && walk_expr(&o.expr, ctes, out))
                && func.over.as_ref().is_none_or(|over| match over {
                    WindowType::NamedWindow(_) => true,
                    WindowType::WindowSpec(spec) => walk_window_spec(spec, ctes, out),
                })
        }
        _ => false,
    }
}

fn walk_function_arg_list(
    list: &sqlparser::ast::FunctionArgumentList,
    ctes: &BTreeSet<String>,
    out: &mut BTreeSet<String>,
) -> bool {
    list.args.iter().all(|arg| match arg {
        FunctionArg::Unnamed(inner)
        | FunctionArg::Named { arg: inner, .. }
        | FunctionArg::ExprNamed { arg: inner, .. } => match inner {
            FunctionArgExpr::Expr(e) => walk_expr(e, ctes, out),
            FunctionArgExpr::Wildcard | FunctionArgExpr::QualifiedWildcard(_) => true,
        },
    }) && list.clauses.iter().all(|clause| match clause {
        FunctionArgumentClause::OrderBy(order) => order
            .iter()
            .all(|o| o.with_fill.is_none() && walk_expr(&o.expr, ctes, out)),
        FunctionArgumentClause::Limit(e) => walk_expr(e, ctes, out),
        _ => false,
    })
}

#[cfg(test)]
mod tests {
    use super::referenced_tables;
    use std::collections::BTreeSet;

    #[test]
    fn collects_physical_tables_across_ctes_joins_subqueries_and_filters() {
        assert_eq!(
            referenced_tables("SELECT 7 AS voice_turns"),
            Some(BTreeSet::new())
        );
        assert_eq!(
            referenced_tables(
                "WITH base AS (SELECT build_id, valid_voice_turns FROM syn_daily_voice_experience WHERE stat_date BETWEEN :s AND :e) \
                 SELECT b.build_id, SUM(b.valid_voice_turns) FILTER (WHERE b.build_id IS NOT NULL) \
                 FROM base b LEFT JOIN syn_software_build s ON b.build_id = s.build_id \
                 GROUP BY b.build_id ORDER BY 2 DESC LIMIT 10"
            ),
            Some(BTreeSet::from([
                "syn_daily_voice_experience".to_owned(),
                "syn_software_build".to_owned(),
            ]))
        );
        assert_eq!(
            referenced_tables(
                "SELECT d.build_id FROM syn_daily_voice_experience d \
                 WHERE EXISTS (SELECT 1 FROM syn_software_build s WHERE s.build_id = d.build_id)"
            ),
            Some(BTreeSet::from([
                "syn_daily_voice_experience".to_owned(),
                "syn_software_build".to_owned(),
            ]))
        );
    }

    #[test]
    fn fails_closed_on_table_functions_qualified_schemas_or_multi_statements() {
        assert_eq!(referenced_tables("SELECT * FROM pragma_table_list()"), None);
        assert_eq!(
            referenced_tables("SELECT * FROM other_db.syn_software_build"),
            None
        );
        assert_eq!(
            referenced_tables("SELECT 1; SELECT * FROM syn_software_build"),
            None
        );
    }
}
