use serde_json::{Value, json};
use sqlparser::{
    ast::{
        Expr, Function, FunctionArg, FunctionArgExpr, FunctionArgumentClause, FunctionArguments,
        GroupByExpr, Ident, JoinConstraint, JoinOperator, LimitClause, NamedWindowExpr, ObjectName,
        OrderBy, OrderByKind, Query, Select, SelectItem, SelectItemQualifiedWildcardKind, SetExpr,
        Statement, TableFactor, TableWithJoins, Value as SqlValue, WindowFrameBound, WindowSpec,
        WindowType,
    },
    dialect::SQLiteDialect,
    parser::Parser,
    tokenizer::{Token, Tokenizer},
};
use std::collections::{BTreeMap, BTreeSet};

/// 检查已通过平台基础语法/只读编译的 SQLite 查询是否存在未分组列混用聚合的歧义。
/// 仅拦截确有分组折叠歧义的查询并返回具体列名；普通明细、合法分组、窗口及纯整体汇总原样放行。
pub fn check_grouping_ambiguity(sql: &str) -> Option<Value> {
    let statements = Parser::new(&SQLiteDialect {})
        .with_recursion_limit(32)
        .try_with_sql(sql)
        .and_then(|mut parser| parser.parse_statements())
        .ok()?;
    let [Statement::Query(query)] = statements.as_slice() else {
        return None;
    };
    let mut ungrouped = Vec::new();
    check_query(query, &BTreeSet::new(), &mut ungrouped);
    if ungrouped.is_empty() {
        return None;
    }
    let cols = ungrouped.join("、");
    let mut message = format!(
        "聚合查询中存在未列入 GROUP BY 的非聚合列（{cols}），在 SQLite 中会把多组折叠为单行合计并挂到任意分组值；按维度拆分请将对应列补入 GROUP BY，计算整体汇总请移除未分组列。"
    );
    if message.chars().count() > 960 {
        message = message.chars().take(960).collect::<String>() + "…";
    }
    Some(json!({ "code": "ungrouped_aggregate_column", "message": message }))
}

fn push_unique(out: &mut Vec<String>, name: String) {
    if !out
        .iter()
        .any(|existing| existing.eq_ignore_ascii_case(&name))
    {
        out.push(name);
    }
}

fn split_compound_ident(idents: &[Ident]) -> Option<(String, String)> {
    let [prefix @ .., last] = idents else {
        return None;
    };
    if prefix.is_empty() {
        return None;
    }
    let qualifier = prefix
        .iter()
        .map(|i| i.value.to_ascii_lowercase())
        .collect::<Vec<_>>()
        .join(".");
    Some((qualifier, last.value.to_ascii_lowercase()))
}

fn check_query(query: &Query, outer_relations: &BTreeSet<String>, out: &mut Vec<String>) {
    if let Some(with) = &query.with {
        for cte in &with.cte_tables {
            check_query(&cte.query, outer_relations, out);
        }
    }
    match query.body.as_ref() {
        SetExpr::Select(select) => {
            check_select(select, query.order_by.as_ref(), outer_relations, out);
        }
        other => {
            check_set_expr(other, outer_relations, out);
            if let Some(order_by) = &query.order_by
                && let OrderByKind::Expressions(exprs) = &order_by.kind
            {
                exprs
                    .iter()
                    .for_each(|item| check_subqueries_in_expr(&item.expr, outer_relations, out));
            }
        }
    }
    match &query.limit_clause {
        Some(LimitClause::LimitOffset {
            limit,
            offset,
            limit_by,
        }) => {
            for e in limit
                .iter()
                .chain(offset.iter().map(|o| &o.value))
                .chain(limit_by.iter())
            {
                check_subqueries_in_expr(e, outer_relations, out);
            }
        }
        Some(LimitClause::OffsetCommaLimit { offset, limit }) => {
            check_subqueries_in_expr(offset, outer_relations, out);
            check_subqueries_in_expr(limit, outer_relations, out);
        }
        None => {}
    }
}

fn check_set_expr(expr: &SetExpr, outer_relations: &BTreeSet<String>, out: &mut Vec<String>) {
    match expr {
        SetExpr::Select(select) => check_select(select, None, outer_relations, out),
        SetExpr::Query(query) => check_query(query, outer_relations, out),
        SetExpr::SetOperation { left, right, .. } => {
            check_set_expr(left, outer_relations, out);
            check_set_expr(right, outer_relations, out);
        }
        SetExpr::Values(values) => {
            for item in values.rows.iter().flatten() {
                check_subqueries_in_expr(item, outer_relations, out);
            }
        }
        _ => {}
    }
}

fn collect_local_relations(
    tables: &[TableWithJoins],
    outer_relations: &BTreeSet<String>,
    local: &mut BTreeSet<String>,
    out: &mut Vec<String>,
) {
    for table in tables {
        collect_factor_relations(&table.relation, outer_relations, local, out);
        for join in &table.joins {
            collect_factor_relations(&join.relation, outer_relations, local, out);
        }
    }
    let mut child_outer = outer_relations.clone();
    child_outer.extend(local.iter().cloned());
    for join in tables.iter().flat_map(|t| &t.joins) {
        if let Some(JoinConstraint::On(expr)) = join_constraint(&join.join_operator) {
            check_subqueries_in_expr(expr, &child_outer, out);
        }
    }
}

fn collect_factor_relations(
    factor: &TableFactor,
    outer_relations: &BTreeSet<String>,
    local: &mut BTreeSet<String>,
    out: &mut Vec<String>,
) {
    match factor {
        TableFactor::Table { name, alias, .. } => {
            let ident = alias.as_ref().map(|a| a.name.value.as_str()).or_else(|| {
                name.0
                    .last()
                    .and_then(|p| p.as_ident())
                    .map(|i| i.value.as_str())
            });
            if let Some(ident) = ident {
                local.insert(ident.to_ascii_lowercase());
            }
        }
        TableFactor::Derived {
            subquery, alias, ..
        } => {
            check_query(subquery, outer_relations, out);
            if let Some(alias) = alias {
                local.insert(alias.name.value.to_ascii_lowercase());
            }
        }
        TableFactor::NestedJoin {
            table_with_joins,
            alias,
        } => {
            collect_local_relations(
                std::slice::from_ref(table_with_joins.as_ref()),
                outer_relations,
                local,
                out,
            );
            if let Some(alias) = alias {
                local.insert(alias.name.value.to_ascii_lowercase());
            }
        }
        _ => {}
    }
}

fn join_constraint(op: &JoinOperator) -> Option<&JoinConstraint> {
    match op {
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
        _ => None,
    }
}

#[derive(Default)]
struct GroupScope {
    expr_keys: BTreeSet<String>,
    unqualified_cols: BTreeSet<String>,
    qualified_cols: BTreeSet<(String, String)>,
}

impl GroupScope {
    fn add_expr(&mut self, expr: &Expr, single_relation: Option<&str>) {
        let stripped = unnested(expr);
        if let Some(key) = canonical_expr_key(stripped, single_relation) {
            self.expr_keys.insert(key);
        }
        match stripped {
            Expr::Identifier(ident) => {
                self.unqualified_cols
                    .insert(ident.value.to_ascii_lowercase());
            }
            Expr::CompoundIdentifier(idents) => {
                if let Some(pair) = split_compound_ident(idents) {
                    self.qualified_cols.insert(pair);
                }
            }
            _ => {}
        }
    }

    fn matches_expr(&self, expr: &Expr, single_relation: Option<&str>) -> bool {
        let stripped = unnested(expr);
        if let Some(key) = canonical_expr_key(stripped, single_relation)
            && self.expr_keys.contains(&key)
        {
            return true;
        }
        match stripped {
            Expr::Identifier(ident) => {
                let col = ident.value.to_ascii_lowercase();
                // 平台EXPLAIN已先行证明未限定列无跨表歧义，可与已分组的同名列对应。
                self.unqualified_cols.contains(&col)
                    || self.qualified_cols.iter().any(|(_, c)| c == &col)
            }
            Expr::CompoundIdentifier(idents) => {
                split_compound_ident(idents).is_some_and(|(qualifier, col)| {
                    self.qualified_cols.contains(&(qualifier, col.clone()))
                        || self.unqualified_cols.contains(&col)
                })
            }
            _ => false,
        }
    }
}

fn check_select(
    select: &Select,
    query_order_by: Option<&OrderBy>,
    outer_relations: &BTreeSet<String>,
    out: &mut Vec<String>,
) {
    let mut local_relations = BTreeSet::new();
    collect_local_relations(&select.from, outer_relations, &mut local_relations, out);
    let mut child_outer = outer_relations.clone();
    child_outer.extend(local_relations.iter().cloned());

    if let Some(selection) = &select.selection {
        check_subqueries_in_expr(selection, &child_outer, out);
    }
    if let Some(sqlparser::ast::Distinct::On(exprs)) = &select.distinct {
        for expr in exprs {
            check_subqueries_in_expr(expr, &child_outer, out);
        }
    }
    for item in &select.projection {
        if let SelectItem::UnnamedExpr(e) | SelectItem::ExprWithAlias { expr: e, .. } = item {
            check_subqueries_in_expr(e, &child_outer, out);
        }
    }
    let group_exprs: &[Expr] = match &select.group_by {
        GroupByExpr::Expressions(exprs, _) => {
            for e in exprs {
                check_subqueries_in_expr(e, &child_outer, out);
            }
            exprs.as_slice()
        }
        GroupByExpr::All(_) => return,
    };
    if let Some(having) = &select.having {
        check_subqueries_in_expr(having, &child_outer, out);
    }
    if let Some(qualify) = &select.qualify {
        check_subqueries_in_expr(qualify, &child_outer, out);
    }
    for def in &select.named_window {
        if let NamedWindowExpr::WindowSpec(spec) = &def.1 {
            for_each_window_spec_expr(spec, |e| check_subqueries_in_expr(e, &child_outer, out));
        }
    }
    if let Some(order_by) = query_order_by
        && let OrderByKind::Expressions(exprs) = &order_by.kind
    {
        for item in exprs {
            check_subqueries_in_expr(&item.expr, &child_outer, out);
        }
    }

    let has_aggregate = select.projection.iter().any(|item| match item {
        SelectItem::UnnamedExpr(e) | SelectItem::ExprWithAlias { expr: e, .. } => {
            contains_local_aggregate(e)
        }
        _ => false,
    }) || select.having.as_ref().is_some_and(contains_local_aggregate)
        || query_order_by.is_some_and(|order_by| match &order_by.kind {
            OrderByKind::Expressions(exprs) => {
                exprs.iter().any(|o| contains_local_aggregate(&o.expr))
            }
            OrderByKind::All(_) => false,
        });

    if group_exprs.is_empty() && !has_aggregate && select.having.is_none() {
        return;
    }

    let single_relation = (local_relations.len() == 1)
        .then(|| local_relations.iter().next().map(String::as_str))
        .flatten();

    let mut projection_exprs: Vec<Option<&Expr>> = Vec::with_capacity(select.projection.len());
    let mut projection_aliases: BTreeMap<String, &Expr> = BTreeMap::new();
    for item in &select.projection {
        match item {
            SelectItem::UnnamedExpr(expr) => projection_exprs.push(Some(expr)),
            SelectItem::ExprWithAlias { expr, alias } => {
                projection_exprs.push(Some(expr));
                projection_aliases.insert(alias.value.to_ascii_lowercase(), expr);
            }
            SelectItem::Wildcard(_) | SelectItem::QualifiedWildcard(_, _) => {
                projection_exprs.push(None);
            }
        }
    }

    let mut scope = GroupScope::default();
    for g in group_exprs {
        if let Some(idx) = positive_ordinal(g) {
            if let Some(Some(target)) = projection_exprs.get(idx - 1)
                && !contains_local_aggregate(target)
            {
                scope.add_expr(target, single_relation);
            }
            continue;
        }
        if let Expr::Identifier(ident) = unnested(g) {
            let key = ident.value.to_ascii_lowercase();
            if let Some(aliased) = projection_aliases.get(&key)
                && !contains_local_aggregate(aliased)
            {
                scope.add_expr(aliased, single_relation);
            }
        }
        scope.add_expr(g, single_relation);
    }

    let ctx = PostGroupCtx {
        scope: &scope,
        single_relation,
        local_relations: &local_relations,
        outer_relations,
    };
    let empty_aliases = BTreeMap::new();
    let mut local_violation = Vec::new();
    for item in &select.projection {
        match item {
            SelectItem::Wildcard(_) => push_unique(&mut local_violation, "*".to_owned()),
            SelectItem::QualifiedWildcard(kind, _) => {
                let label = match kind {
                    SelectItemQualifiedWildcardKind::ObjectName(name) => format!("{name}.*"),
                    SelectItemQualifiedWildcardKind::Expr(_) => "*".to_owned(),
                };
                push_unique(&mut local_violation, label);
            }
            SelectItem::UnnamedExpr(expr) | SelectItem::ExprWithAlias { expr, .. } => {
                validate_post_group_expr(expr, &ctx, &empty_aliases, &mut local_violation);
            }
        }
    }
    if let Some(having) = &select.having {
        validate_post_group_expr(having, &ctx, &projection_aliases, &mut local_violation);
    }
    if let Some(order_by) = query_order_by
        && let OrderByKind::Expressions(exprs) = &order_by.kind
    {
        for item in exprs {
            if positive_ordinal(&item.expr).is_some() {
                continue;
            }
            validate_post_group_expr(&item.expr, &ctx, &projection_aliases, &mut local_violation);
        }
    }
    for col in local_violation {
        push_unique(out, col);
    }
}

struct PostGroupCtx<'a> {
    scope: &'a GroupScope,
    single_relation: Option<&'a str>,
    local_relations: &'a BTreeSet<String>,
    outer_relations: &'a BTreeSet<String>,
}

fn validate_post_group_expr(
    expr: &Expr,
    ctx: &PostGroupCtx<'_>,
    projection_aliases: &BTreeMap<String, &Expr>,
    out: &mut Vec<String>,
) {
    let expr = unnested(expr);
    if ctx.scope.matches_expr(expr, ctx.single_relation) {
        return;
    }
    match expr {
        Expr::Subquery(_) | Expr::Exists { .. } => {}
        Expr::Identifier(ident) => {
            let lower = ident.value.to_ascii_lowercase();
            let niladic_time = ident.quote_style.is_none()
                && matches!(
                    lower.as_str(),
                    "current_timestamp" | "current_date" | "current_time"
                );
            if !niladic_time && !projection_aliases.contains_key(&lower) {
                push_unique(out, ident.value.clone());
            }
        }
        Expr::CompoundIdentifier(idents) => {
            if let Some((qualifier, _)) = split_compound_ident(idents) {
                if ctx.outer_relations.contains(&qualifier)
                    && !ctx.local_relations.contains(&qualifier)
                {
                    return;
                }
                let display = idents
                    .iter()
                    .map(|i| i.value.as_str())
                    .collect::<Vec<_>>()
                    .join(".");
                push_unique(out, display);
            } else if let Some(first) = idents.first() {
                push_unique(out, first.value.clone());
            }
        }
        Expr::Function(func) if is_aggregate_function(func) => {}
        _ => for_each_child_expr(expr, |child| {
            validate_post_group_expr(child, ctx, projection_aliases, out);
        }),
    }
}

fn contains_local_aggregate(expr: &Expr) -> bool {
    match expr {
        Expr::Subquery(_) | Expr::Exists { .. } => false,
        Expr::Function(func) if is_aggregate_function(func) => true,
        _ => {
            let mut found = false;
            for_each_child_expr(expr, |child| {
                if !found && contains_local_aggregate(child) {
                    found = true;
                }
            });
            found
        }
    }
}

fn check_subqueries_in_expr(
    expr: &Expr,
    outer_relations: &BTreeSet<String>,
    out: &mut Vec<String>,
) {
    match expr {
        Expr::Subquery(subquery) | Expr::Exists { subquery, .. } => {
            check_query(subquery, outer_relations, out);
        }
        Expr::InSubquery {
            expr: inner,
            subquery,
            ..
        } => {
            check_subqueries_in_expr(inner, outer_relations, out);
            check_query(subquery, outer_relations, out);
        }
        Expr::Function(func) => {
            for arg_set in [&func.parameters, &func.args] {
                if let FunctionArguments::Subquery(subquery) = arg_set {
                    check_query(subquery, outer_relations, out);
                }
            }
            for_each_function_expr(func, |child| {
                check_subqueries_in_expr(child, outer_relations, out);
            });
        }
        _ => for_each_child_expr(expr, |child| {
            check_subqueries_in_expr(child, outer_relations, out);
        }),
    }
}

fn for_each_child_expr<'a>(expr: &'a Expr, mut visit: impl FnMut(&'a Expr)) {
    match expr {
        Expr::InSubquery { expr: inner, .. }
        | Expr::Nested(inner)
        | Expr::UnaryOp { expr: inner, .. }
        | Expr::IsNull(inner)
        | Expr::IsNotNull(inner)
        | Expr::IsTrue(inner)
        | Expr::IsNotTrue(inner)
        | Expr::IsFalse(inner)
        | Expr::IsNotFalse(inner)
        | Expr::IsUnknown(inner)
        | Expr::IsNotUnknown(inner)
        | Expr::IsNormalized { expr: inner, .. }
        | Expr::Cast { expr: inner, .. }
        | Expr::Extract { expr: inner, .. }
        | Expr::Ceil { expr: inner, .. }
        | Expr::Floor { expr: inner, .. }
        | Expr::Collate { expr: inner, .. }
        | Expr::JsonAccess { value: inner, .. }
        | Expr::CompoundFieldAccess { root: inner, .. }
        | Expr::Prefixed { value: inner, .. }
        | Expr::Named { expr: inner, .. }
        | Expr::OuterJoin(inner)
        | Expr::Prior(inner) => visit(inner),
        Expr::Convert { expr, styles, .. } => {
            visit(expr);
            styles.iter().for_each(&mut visit);
        }
        Expr::Interval(interval) => visit(&interval.value),
        Expr::BinaryOp { left, right, .. }
        | Expr::IsDistinctFrom(left, right)
        | Expr::IsNotDistinctFrom(left, right)
        | Expr::AnyOp { left, right, .. }
        | Expr::AllOp { left, right, .. }
        | Expr::AtTimeZone {
            timestamp: left,
            time_zone: right,
        }
        | Expr::InUnnest {
            expr: left,
            array_expr: right,
            ..
        }
        | Expr::Like {
            expr: left,
            pattern: right,
            ..
        }
        | Expr::ILike {
            expr: left,
            pattern: right,
            ..
        }
        | Expr::SimilarTo {
            expr: left,
            pattern: right,
            ..
        }
        | Expr::RLike {
            expr: left,
            pattern: right,
            ..
        }
        | Expr::Position {
            expr: left,
            r#in: right,
        } => {
            visit(left);
            visit(right);
        }
        Expr::Between {
            expr, low, high, ..
        } => {
            visit(expr);
            visit(low);
            visit(high);
        }
        Expr::InList { expr, list, .. } => {
            visit(expr);
            list.iter().for_each(&mut visit);
        }
        Expr::Case {
            operand,
            conditions,
            else_result,
            ..
        } => {
            operand.iter().map(AsRef::as_ref).for_each(&mut visit);
            for branch in conditions {
                visit(&branch.condition);
                visit(&branch.result);
            }
            else_result.iter().map(AsRef::as_ref).for_each(&mut visit);
        }
        Expr::Tuple(items) => items.iter().for_each(&mut visit),
        Expr::Array(array) => array.elem.iter().for_each(&mut visit),
        Expr::Substring {
            expr,
            substring_from,
            substring_for,
            ..
        } => {
            visit(expr);
            substring_from
                .iter()
                .map(AsRef::as_ref)
                .for_each(&mut visit);
            substring_for.iter().map(AsRef::as_ref).for_each(&mut visit);
        }
        Expr::Trim {
            expr,
            trim_what,
            trim_characters,
            ..
        } => {
            visit(expr);
            trim_what.iter().map(AsRef::as_ref).for_each(&mut visit);
            if let Some(chars) = trim_characters {
                chars.iter().for_each(&mut visit);
            }
        }
        Expr::Overlay {
            expr,
            overlay_what,
            overlay_from,
            overlay_for,
        } => {
            visit(expr);
            visit(overlay_what);
            visit(overlay_from);
            overlay_for.iter().map(AsRef::as_ref).for_each(&mut visit);
        }
        Expr::Function(func) => for_each_function_expr(func, visit),
        _ => {}
    }
}

fn for_each_function_expr<'a>(func: &'a Function, mut visit: impl FnMut(&'a Expr)) {
    for arg_set in [&func.parameters, &func.args] {
        if let FunctionArguments::List(list) = arg_set {
            for arg in &list.args {
                let (FunctionArg::Unnamed(inner)
                | FunctionArg::Named { arg: inner, .. }
                | FunctionArg::ExprNamed { arg: inner, .. }) = arg;
                if let FunctionArgExpr::Expr(e) = inner {
                    visit(e);
                }
            }
            for clause in &list.clauses {
                match clause {
                    FunctionArgumentClause::OrderBy(order) => {
                        order.iter().for_each(|item| visit(&item.expr));
                    }
                    FunctionArgumentClause::Limit(e) => visit(e),
                    _ => {}
                }
            }
        }
    }
    func.filter.iter().map(AsRef::as_ref).for_each(&mut visit);
    func.within_group.iter().for_each(|item| visit(&item.expr));
    if let Some(WindowType::WindowSpec(spec)) = &func.over {
        for_each_window_spec_expr(spec, visit);
    }
}

fn for_each_window_spec_expr<'a>(spec: &'a WindowSpec, mut visit: impl FnMut(&'a Expr)) {
    spec.partition_by.iter().for_each(&mut visit);
    spec.order_by.iter().for_each(|item| visit(&item.expr));
    if let Some(frame) = &spec.window_frame {
        for bound in std::iter::once(&frame.start_bound).chain(frame.end_bound.iter()) {
            if let WindowFrameBound::Preceding(Some(e)) | WindowFrameBound::Following(Some(e)) =
                bound
            {
                visit(e);
            }
        }
    }
}

fn is_aggregate_function(func: &Function) -> bool {
    if func.over.is_some() {
        return false;
    }
    let Some(name) = function_name(&func.name) else {
        return false;
    };
    let arg_count = match &func.args {
        FunctionArguments::None => 0,
        FunctionArguments::Subquery(_) => 1,
        FunctionArguments::List(list) => list.args.len(),
    };
    match name.as_str() {
        // SQLite 单参数 MIN(x)/MAX(x) 为聚合，多参数 MIN(x, y, ...)/MAX(x, y, ...) 为逐行标量函数。
        "min" | "max" | "sum" | "avg" | "total" => arg_count == 1,
        "count" => arg_count <= 1,
        "group_concat" | "string_agg" => (1..=2).contains(&arg_count),
        _ => false,
    }
}

fn function_name(name: &ObjectName) -> Option<String> {
    let [part] = name.0.as_slice() else {
        return None;
    };
    Some(part.as_ident()?.value.to_ascii_lowercase())
}

fn unnested(mut expr: &Expr) -> &Expr {
    while let Expr::Nested(inner) = expr {
        expr = inner;
    }
    expr
}

fn positive_ordinal(expr: &Expr) -> Option<usize> {
    if let Expr::Value(val) = unnested(expr)
        && let SqlValue::Number(raw, false) = &val.value
        && let Ok(n) = raw.parse::<usize>()
        && n >= 1
    {
        return Some(n);
    }
    None
}

fn canonical_expr_key(expr: &Expr, single_relation: Option<&str>) -> Option<String> {
    let sql = unnested(expr).to_string();
    let mut tokens = Tokenizer::new(&SQLiteDialect {}, &sql).tokenize().ok()?;
    tokens.retain(|t| !matches!(t, Token::Whitespace(_)));
    for token in &mut tokens {
        if let Token::Word(word) = token
            && word.quote_style.is_none()
        {
            word.value.make_ascii_lowercase();
        }
    }
    let mut normalized = Vec::with_capacity(tokens.len());
    let mut idx = 0;
    while idx < tokens.len() {
        if let Some(rel) = single_relation
            && (idx == 0 || tokens[idx - 1] != Token::Period)
            && matches!(tokens.get(idx), Some(Token::Word(w)) if w.value.eq_ignore_ascii_case(rel))
            && tokens.get(idx + 1) == Some(&Token::Period)
            && matches!(tokens.get(idx + 2), Some(Token::Word(_)))
        {
            idx += 2;
            continue;
        }
        normalized.push(tokens[idx].to_string());
        idx += 1;
    }
    Some(normalized.join(" "))
}

#[cfg(test)]
#[path = "grouping_validation/tests.rs"]
mod tests;
