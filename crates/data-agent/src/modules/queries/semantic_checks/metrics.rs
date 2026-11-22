use super::*;

pub(super) fn check_metrics(
    select: &Select,
    parameters: &Value,
    bindings: &[Binding<'_>],
    sums: &[Column],
    objects: &[Value],
    candidates: &[(&Value, &Value)],
    report: &mut Report,
) {
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
    let metric_expr = metric_expression(expression);
    let column = metric_expr.as_ref().and_then(|expr| {
        let expr = sum_column(expr)?;
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

pub(super) fn metric_expression(sql: &str) -> Option<Expr> {
    let mut parser = Parser::new(&SQLiteDialect {})
        .with_recursion_limit(32)
        .try_with_sql(sql)
        .ok()?;
    let expr = parser.parse_expr().ok()?;
    (parser.peek_token().token == Token::EOF).then_some(expr)
}

// 输入是已解析的单表投影。仅忽略本表限定和未引号标识符的大小写，常量原样参与比对。
fn metric_key(expr: &Expr, binding: &Binding<'_>) -> Option<Vec<Token>> {
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
    let mut key = Vec::new();
    let mut index = 0;
    while index < tokens.len() {
        if index == 0 || tokens[index - 1] != Token::Period {
            for name in binding.alias.iter().chain(std::iter::once(&binding.name)) {
                let mut end = index;
                if name.split('.').all(|part| {
                    let matches = matches!(tokens.get(end), Some(Token::Word(w)) if w.value.eq_ignore_ascii_case(part))
                        && tokens.get(end+1) == Some(&Token::Period);
                    end += 2;
                    matches
                }) && matches!(tokens.get(end), Some(Token::Word(_))) {
                    index = end;
                    break;
                }
            }
        }
        key.push(tokens[index].clone());
        index += 1;
    }
    Some(key)
}

pub(super) fn mixes_metric_boundary(
    select: &Select,
    expected: &Expr,
    binding: &Binding<'_>,
) -> bool {
    let Some(expected) = metric_key(expected, binding) else {
        return false;
    };
    select
        .projection
        .iter()
        .filter_map(projection_expr)
        .any(|expr| {
            let mut terms = Vec::new();
            arithmetic_terms(expr, &mut terms);
            terms.len() > 1
                && terms
                    .iter()
                    .any(|term| metric_key(term, binding).as_ref() == Some(&expected))
                && terms.iter().any(|term| {
                    contains_boundary_patch(term)
                        && metric_key(term, binding).as_ref() != Some(&expected)
                })
        })
}

// 顶层加减链分解：a + b - (c + d) → [a, b, (c+d)]；括号内加减不提升为顶层项。
fn arithmetic_terms<'a>(expr: &'a Expr, terms: &mut Vec<&'a Expr>) {
    match unnested(expr) {
        Expr::BinaryOp {
            left,
            op: BinaryOperator::Plus | BinaryOperator::Minus,
            right,
        } => {
            arithmetic_terms(left, terms);
            terms.push(unnested(right));
        }
        _ => terms.push(expr),
    }
}

// 边界项特征：CASE WHEN分支或IS NULL判定——“存在匿名则+1”式补丁的形态。
fn contains_boundary_patch(expr: &Expr) -> bool {
    match expr {
        Expr::IsNull(_) => true,
        Expr::Case { conditions, .. } => conditions
            .iter()
            .any(|branch| contains_boundary_patch(&branch.condition)),
        Expr::Nested(inner) => contains_boundary_patch(inner),
        Expr::BinaryOp { left, right, .. } => {
            contains_boundary_patch(left) || contains_boundary_patch(right)
        }
        Expr::Function(function) => {
            let FunctionArguments::List(args) = &function.args else {
                return false;
            };
            args.args.iter().any(|arg| match arg {
                FunctionArg::Named { arg, .. }
                | FunctionArg::Unnamed(arg)
                | FunctionArg::ExprNamed { arg, .. } => match arg {
                    FunctionArgExpr::Expr(expr) => contains_boundary_patch(expr),
                    _ => false,
                },
            })
        }
        _ => false,
    }
}

/// 平台结果列按 SELECT 的投影顺序返回。标签只来自这次查询引用的、已确认的结构。
pub fn annotate_result_columns(sql: &str, columns: &mut [Value], snapshot: &Value, refs: &[Value]) {
    let Ok(statements) = Parser::new(&SQLiteDialect {})
        .with_recursion_limit(32)
        .try_with_sql(sql)
        .and_then(|mut parser| parser.parse_statements())
    else {
        return;
    };
    let [Statement::Query(query)] = statements.as_slice() else {
        return;
    };
    let SetExpr::Select(select) = query.body.as_ref() else {
        return;
    };
    let Some(objects) = snapshot["objects"].as_array() else {
        return;
    };
    let Some(bindings) = table_bindings(select, objects) else {
        return;
    };
    if query.with.is_some() {
        return;
    }
    let wildcard = match select.projection.as_slice() {
        [SelectItem::Wildcard(opts)] => bindings.len() == 1 && plain_wildcard(opts),
        [SelectItem::QualifiedWildcard(SelectItemQualifiedWildcardKind::ObjectName(n), opts)] => {
            bindings.len() == 1
                && plain_wildcard(opts)
                && plain_name(n).is_some_and(|name| {
                    bindings[0]
                        .alias
                        .as_ref()
                        .unwrap_or(&bindings[0].name)
                        .eq_ignore_ascii_case(&name)
                })
        }
        _ => false,
    };
    if !wildcard
        && (select.projection.len() != columns.len()
            || select
                .projection
                .iter()
                .any(|item| projection_expr(item).is_none()))
    {
        return;
    }
    // 结果说明沿用查询真正引用的条目。单位条目被引用时，不顺带展示同对象其他来源的说明。
    let definitions: Vec<_> = objects
        .iter()
        .filter(|o| o["state"] == "enabled")
        .filter_map(|object| {
            let kind = object["kind"].as_str()?;
            if !matches!(kind, "field" | "metric") {
                return None;
            }
            let mut selected = object["entries"].as_array()?.iter().filter(|entry| {
                entry["review_state"] == "confirmed"
                    && refs.iter().any(|r| {
                        ref_matches(r, object)
                            && r["path"].as_str().is_none_or(|path| {
                                path.is_empty()
                                    || entry["entry_id"] == path
                                    || entry["path"] == path
                            })
                    })
            });
            let rule = selected
                .clone()
                .map(|e| &e["effective_structure"])
                .find(|rule| rule["kind"] == kind)?;
            let label = if kind == "field" {
                selected
                    .find(|e| e["path"] == "meaning")
                    .and_then(|e| e["effective_value"].as_str())
            } else {
                object["name"].as_str()
            };
            Some((rule, label.map(str::trim)))
        })
        .collect();
    for (index, output) in columns.iter_mut().enumerate() {
        let Some(name) = output["name"].as_str() else {
            continue;
        };
        let wildcard_column;
        let expr = if wildcard {
            wildcard_column = Expr::Identifier(sqlparser::ast::Ident::new(name));
            &wildcard_column
        } else {
            let item = &select.projection[index];
            if let SelectItem::ExprWithAlias { alias, .. } = item
                && !alias.value.eq_ignore_ascii_case(name)
            {
                continue;
            }
            let Some(expr) = projection_expr(item) else {
                continue;
            };
            expr
        };
        let field = if matches!(unnested(expr), Expr::Identifier(_))
            && bindings.len() > 1
            && bindings.iter().any(|binding| {
                binding
                    .object
                    .is_none_or(|table| table["column_names_complete"] != true)
            }) {
            None
        } else {
            resolve_column(expr, &bindings)
        };
        let mut matches = definitions.iter().filter_map(|(rule, label)| {
            match rule["kind"].as_str()? {
                "field" => {
                    let column = field.as_ref()?;
                    if rule["table"]["object_id"] != column.table_id
                        || !rule["column"].as_str()?.eq_ignore_ascii_case(&column.name)
                    {
                        return None;
                    }
                }
                "metric" => {
                    let [binding] = bindings.as_slice() else {
                        return None;
                    };
                    if !ref_matches(&rule["table"], binding.object?) {
                        return None;
                    }
                    let expected = metric_expression(rule["expression"].as_str()?)?;
                    if metric_key(&expected, binding)? != metric_key(expr, binding)? {
                        return None;
                    }
                }
                _ => return None,
            }
            Some((*label, rule["unit"].as_str().map(str::trim)))
        });
        if let Some((label, unit)) = matches.next()
            && matches.next().is_none()
        {
            if let Some(label) = label.filter(|s| (1..=240).contains(&s.chars().count())) {
                output["display_label"] = json!(label);
            }
            if let Some(unit) = unit.filter(|s| (1..=64).contains(&s.chars().count())) {
                output["unit"] = json!(unit);
            }
        }
    }
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
