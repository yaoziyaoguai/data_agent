use crate::types::{Error, Result};
use serde_json::Value;
use sqlparser::{
    ast::{Expr, OrderByKind, SelectItem, SetExpr, Statement},
    dialect::SQLiteDialect,
    parser::Parser,
};
use std::collections::BTreeSet;

fn chart_error() -> Error {
    Error::new("invalid_evidence")
}

fn decimal(value: &str) -> bool {
    if value.is_empty() || value.len() > 256 {
        return false;
    }
    let value = value.strip_prefix('-').unwrap_or(value);
    let mut parts = value.split('.');
    let integer = parts.next().unwrap_or("");
    !integer.is_empty()
        && integer.bytes().all(|b| b.is_ascii_digit())
        && (integer == "0" || !integer.starts_with('0'))
        && parts.next().is_none_or(|fraction| {
            !fraction.is_empty() && fraction.bytes().all(|b| b.is_ascii_digit())
        })
        && parts.next().is_none()
}

fn ordered_dimension(sql: &str, column: &str, position: usize) -> bool {
    let Ok(statements) = Parser::new(&SQLiteDialect {})
        .with_recursion_limit(32)
        .try_with_sql(sql)
        .and_then(|mut parser| parser.parse_statements())
    else {
        return false;
    };
    let [Statement::Query(query)] = statements.as_slice() else {
        return false;
    };
    let Some(order) = &query.order_by else {
        return false;
    };
    let OrderByKind::Expressions(expressions) = &order.kind else {
        return false;
    };
    let Some(first) = expressions.first() else {
        return false;
    };
    if first.with_fill.is_some() || order.interpolate.is_some() {
        return false;
    }
    match &first.expr {
        Expr::Identifier(name) => name.value == column,
        Expr::CompoundIdentifier(_) => {
            let SetExpr::Select(select) = query.body.as_ref() else {
                return false;
            };
            if select.projection.iter().any(|item| {
                matches!(
                    item,
                    SelectItem::Wildcard(_) | SelectItem::QualifiedWildcard(_, _)
                )
            }) {
                return false;
            }
            match select.projection.get(position) {
                Some(SelectItem::UnnamedExpr(expr) | SelectItem::ExprWithAlias { expr, .. }) => {
                    *expr == first.expr
                }
                _ => false,
            }
        }
        Expr::Value(value) => {
            matches!(&value.value, sqlparser::ast::Value::Number(number, _) if number.parse::<usize>().ok() == Some(position + 1))
        }
        _ => false,
    }
}

/// 只核验绘图列、已保存范围和顺序依据；图表不会把明细变成新的聚合指标。
pub fn validate_report_chart(chart: &Value, query: &Value, result: &Value) -> Result<()> {
    if chart["query_id"] != query["id"]
        || chart["query_id"] != result["query_id"]
        || chart["result_ref"] != result["result_ref"]
    {
        return Err(chart_error());
    }
    let columns = result["columns"].as_array().ok_or_else(chart_error)?;
    let column = |key: &str| {
        let positions: Vec<_> = columns
            .iter()
            .enumerate()
            .filter(|(_, column)| column["name"] == chart[key])
            .map(|(index, _)| index)
            .collect();
        if positions.len() != 1 {
            return Err(chart_error());
        }
        Ok(positions[0])
    };
    let dimension = column("dimension_column")?;
    let measure = column("measure_column")?;
    if dimension == measure {
        return Err(chart_error());
    }
    // SQLite的空列和精确小数文本均可能声明为text；按实际保存单元格核验，不能转浮点猜类型。
    if !matches!(
        columns[measure]["type"].as_str(),
        Some("integer" | "number" | "text" | "string")
    ) {
        return Err(chart_error());
    }
    let line = chart["kind"] == "line";
    if line
        && !ordered_dimension(
            query["sql"].as_str().ok_or_else(chart_error)?,
            chart["dimension_column"].as_str().ok_or_else(chart_error)?,
            dimension,
        )
    {
        return Err(chart_error());
    }
    let mut dimensions = BTreeSet::new();
    for row in result["rows"].as_array().ok_or_else(chart_error)? {
        let row = row.as_array().ok_or_else(chart_error)?;
        let x = row.get(dimension).ok_or_else(chart_error)?;
        if line && x.is_null() {
            return Err(chart_error());
        }
        if !dimensions.insert(x.as_str()) {
            return Err(chart_error());
        }
        let y = row.get(measure).ok_or_else(chart_error)?;
        if !y.is_null() && !y.as_str().is_some_and(decimal) {
            return Err(chart_error());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn line_needs_verified_order_and_unique_dimension() {
        let chart = json!({"kind":"line","query_id":"q","result_ref":"r","dimension_column":"month","measure_column":"amount"});
        let mut query = json!({"id":"q","sql":"SELECT month, SUM(amount) AS amount FROM payments GROUP BY month ORDER BY month"});
        let mut result = json!({"query_id":"q","result_ref":"r","columns":[{"name":"month","type":"string"},{"name":"amount","type":"number"}],"rows":[["2026-01","9007199254740993.01"],["2026-02",null]]});
        assert!(validate_report_chart(&chart, &query, &result).is_ok());
        query["sql"] = json!("SELECT month, amount FROM payments");
        assert!(validate_report_chart(&chart, &query, &result).is_err());
        query["sql"] = json!("SELECT month, amount FROM payments ORDER BY 1");
        result["rows"][1][0] = json!("2026-01");
        assert!(validate_report_chart(&chart, &query, &result).is_err());
    }

    #[test]
    fn exact_decimal_text_and_empty_result_are_valid_but_arbitrary_text_is_not() {
        let chart = json!({"kind":"bar","query_id":"q","result_ref":"r","dimension_column":"group","measure_column":"amount"});
        let query = json!({"id":"q"});
        let mut result = json!({"query_id":"q","result_ref":"r","columns":[{"name":"group","type":"text"},{"name":"amount","type":"text"}],"rows":[["a","9007199254740993.01"]]});
        assert!(validate_report_chart(&chart, &query, &result).is_ok());
        result["rows"][0][1] = json!("收入待核对");
        assert!(validate_report_chart(&chart, &query, &result).is_err());
        result["rows"] = json!([]);
        assert!(validate_report_chart(&chart, &query, &result).is_ok());
    }

    #[test]
    fn qualified_dimension_order_is_bound_to_the_selected_expression() {
        assert!(ordered_dimension(
            "SELECT a.month AS month, a.amount FROM a JOIN b ON a.id=b.id ORDER BY a.month",
            "month",
            0
        ));
        assert!(!ordered_dimension(
            "SELECT a.month AS month, a.amount FROM a JOIN b ON a.id=b.id ORDER BY b.month",
            "month",
            0
        ));
        assert!(!ordered_dimension(
            "SELECT a.* FROM a ORDER BY a.month",
            "month",
            0
        ));
        assert!(!ordered_dimension(
            "SELECT a.*, b.month AS other FROM a JOIN b ON a.id=b.id ORDER BY b.month",
            "month",
            1
        ));
    }
}
