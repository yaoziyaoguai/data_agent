use super::store;
use crate::{
    contracts,
    persistence::AppTx,
    types::{AccessContext, Error, Result, epoch},
};
use serde_json::{Value, json};
use sqlparser::{
    ast::{
        BinaryOperator, Expr, FunctionArg, FunctionArgExpr, FunctionArguments, SelectItem, SetExpr,
        Statement,
    },
    dialect::SQLiteDialect,
    parser::Parser,
};
use std::collections::{BTreeMap, HashSet};

const MAX_STRUCTURE_BYTES: usize = 8192;

// 正文和结构必须采用同一层；人工层缺结构时不能借用底层结构。
pub fn project_entry(entry: &mut Value) {
    let layer = if entry["human_override"].is_object() {
        &entry["human_override"]
    } else if entry["suggestion"]["value"].is_string() {
        &entry["suggestion"]
    } else {
        &entry["source_facts"]
    };
    entry["effective_structure"] = layer
        .get("structured_value")
        .cloned()
        .unwrap_or(Value::Null);
}

pub fn project_object(object: &mut Value) {
    for entry in object
        .get_mut("entries")
        .and_then(Value::as_array_mut)
        .into_iter()
        .flatten()
    {
        project_entry(entry);
    }
}

pub(super) fn mark_other_rules_for_review(object: &mut Value, edited_entry: &str) {
    for entry in object["entries"].as_array_mut().into_iter().flatten() {
        if entry["entry_id"] != edited_entry && !entry["effective_structure"].is_null() {
            entry["review_state"] = json!("needs_review");
        }
    }
}

pub fn validate_shape(object: &Value, entry: &Value, structure: &Value) -> Result<()> {
    if structure.is_null() {
        return Ok(());
    }
    contracts::validate("SemanticStructure", structure)?;
    if structure["kind"] != object["kind"]
        || matches!(
            entry["path"].as_str(),
            Some("ddl" | "etl" | "type" | "lineage")
        )
        || serde_json::to_vec(structure).map_or(true, |bytes| bytes.len() > MAX_STRUCTURE_BYTES)
    {
        return Err(Error::new("invalid_input"));
    }
    Ok(())
}

pub fn validate_single_structure(object: &Value) -> Result<()> {
    let count = object["entries"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|entry| !entry["effective_structure"].is_null())
        .count();
    if count > 1 {
        return Err(Error::new("invalid_input"));
    }
    Ok(())
}

// 列名来自同一知识版本的DDL；字段目录只能补充已知列，不能证明目录完整。
pub fn columns(table: &Value, fields: &[Value]) -> (Vec<String>, bool) {
    let table_name = table["name"].as_str().unwrap_or("");
    let ddl = table["entries"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|entry| entry["path"] == "ddl")
        .and_then(|entry| entry["effective_value"].as_str());
    if let Some(ddl) = ddl
        && let Ok(mut parser) = Parser::new(&SQLiteDialect {})
            .with_recursion_limit(32)
            .try_with_sql(ddl)
        && let Ok(statements) = parser.parse_statements()
        && statements.len() == 1
        && let Statement::CreateTable(definition) = &statements[0]
    {
        let name = definition
            .name
            .0
            .iter()
            .map(|part| part.as_ident().map(|name| name.value.as_str()))
            .collect::<Option<Vec<_>>>()
            .map(|parts| parts.join("."));
        if name
            .as_deref()
            .is_some_and(|name| name.eq_ignore_ascii_case(table_name))
            && !definition.columns.is_empty()
            && definition.query.is_none()
            && definition.like.is_none()
            && definition.clone.is_none()
        {
            return (
                definition
                    .columns
                    .iter()
                    .map(|column| column.name.value.clone())
                    .collect(),
                true,
            );
        }
    }
    let prefix = format!("{table_name}.");
    let mut names = fields
        .iter()
        .filter(|field| {
            field["kind"] == "field"
                && field["related_ids"]
                    .as_array()
                    .is_some_and(|ids| ids.contains(&table["id"]))
        })
        .filter_map(|field| field["name"].as_str())
        .map(|name| name.strip_prefix(&prefix).unwrap_or(name).to_owned())
        .collect::<Vec<_>>();
    names.sort();
    names.dedup();
    (names, false)
}

pub fn table_dependencies(structure: &Value) -> Vec<Value> {
    match structure["kind"].as_str() {
        Some("field" | "metric") => vec![structure["table"].clone()],
        Some("relationship") => vec![
            structure["left_table"].clone(),
            structure["right_table"].clone(),
        ],
        _ => vec![],
    }
}

pub fn structure_dependencies(object: &Value) -> Vec<Value> {
    let mut seen = HashSet::new();
    object["entries"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|entry| {
            let structure = &entry["effective_structure"];
            if structure["kind"] == "query_example" {
                return query_example_dependencies(structure);
            }
            table_dependencies(structure)
                .into_iter()
                .map(|reference| json!({"object_id":reference["object_id"],"version":reference["version"],"path":"ddl"}))
                .collect()
        })
        .filter_map(|reference| {
            let id = reference["object_id"].as_str()?;
            let version = reference["version"].as_str()?;
            let path = reference["path"].as_str()?;
            seen.insert((id.to_owned(), version.to_owned(), path.to_owned()))
                .then_some(reference)
        })
        .collect()
}

fn query_example_dependencies(structure: &Value) -> Vec<Value> {
    structure["dependencies"]
        .as_array()
        .into_iter()
        .flatten()
        .chain(
            structure["verification"]["evidence_refs"]
                .as_array()
                .into_iter()
                .flatten(),
        )
        .cloned()
        .collect()
}

fn check_column(table: &Value, column: &str) -> Result<()> {
    if table["column_names_complete"] != true {
        return Err(Error::new("unsupported"));
    }
    if !table["column_names"].as_array().is_some_and(|names| {
        names.iter().any(|name| {
            name.as_str()
                .is_some_and(|name| name.eq_ignore_ascii_case(column))
        })
    }) {
        return Err(Error::new("invalid_input"));
    }
    Ok(())
}

fn table_for<'a>(tables: &'a BTreeMap<String, Value>, reference: &Value) -> Result<&'a Value> {
    let table = tables
        .get(reference["object_id"].as_str().unwrap_or(""))
        .ok_or(Error::new("not_available"))?;
    if table["kind"] != "table" {
        return Err(Error::new("invalid_input"));
    }
    if table["version"] != reference["version"] {
        return Err(Error::new("stale_knowledge"));
    }
    Ok(table)
}

fn check_metric_expression(table: &Value, expression: &str) -> Result<()> {
    let parse = |sql: &str| {
        Parser::new(&SQLiteDialect {})
            .with_recursion_limit(32)
            .try_with_sql(sql)
            .and_then(|mut parser| parser.parse_statements())
    };
    let statements = parse(expression)
        .or_else(|_| parse(&format!("SELECT {expression}")))
        .map_err(|_| Error::new("invalid_input"))?;
    let [Statement::Query(query)] = statements.as_slice() else {
        return Err(Error::new("invalid_input"));
    };
    // 完整SQL及复杂表达式仍由维护者核对；这里只检查可绑定的单表直接计算列。
    if query.with.is_some() {
        return Ok(());
    }
    let SetExpr::Select(select) = query.body.as_ref() else {
        return Ok(());
    };
    if !select.from.is_empty() || select.projection.len() != 1 {
        return Ok(());
    }
    match &select.projection[0] {
        SelectItem::UnnamedExpr(expression)
        | SelectItem::ExprWithAlias {
            expr: expression, ..
        } => check_expression_column(table, expression),
        _ => Ok(()),
    }
}

fn check_expression_column(table: &Value, expression: &Expr) -> Result<()> {
    match expression {
        Expr::Identifier(column) => check_column(table, &column.value),
        Expr::CompoundIdentifier(parts)
            if parts.len() == 2
                && parts[0]
                    .value
                    .eq_ignore_ascii_case(table["name"].as_str().unwrap_or("")) =>
        {
            check_column(table, &parts[1].value)
        }
        Expr::Nested(expression) => check_expression_column(table, expression),
        Expr::BinaryOp {
            left,
            op:
                BinaryOperator::Plus
                | BinaryOperator::Minus
                | BinaryOperator::Multiply
                | BinaryOperator::Divide,
            right,
        } => {
            check_expression_column(table, left)?;
            check_expression_column(table, right)
        }
        Expr::Function(function) if function.name.to_string().eq_ignore_ascii_case("SUM") => {
            if let FunctionArguments::List(arguments) = &function.args
                && let [FunctionArg::Unnamed(FunctionArgExpr::Expr(expression))] =
                    arguments.args.as_slice()
            {
                return check_expression_column(table, expression);
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

fn validate_bindings(
    object: &Value,
    structure: &Value,
    tables: &BTreeMap<String, Value>,
) -> Result<()> {
    match structure["kind"].as_str() {
        Some("table") => {
            let table = tables
                .get(object["id"].as_str().unwrap_or(""))
                .ok_or(Error::new("not_available"))?;
            for key in structure["unique_keys"].as_array().into_iter().flatten() {
                for column in key.as_array().into_iter().flatten() {
                    check_column(table, column.as_str().unwrap_or(""))?;
                }
            }
            for time in structure["time_columns"].as_array().into_iter().flatten() {
                check_column(table, time["column"].as_str().unwrap_or(""))?;
            }
        }
        Some("field") => {
            let table = table_for(tables, &structure["table"])?;
            let column = structure["column"].as_str().unwrap_or("");
            check_column(table, column)?;
            let prefix = format!("{}.", table["name"].as_str().unwrap_or(""));
            let name = object["name"].as_str().unwrap_or("");
            if !name
                .strip_prefix(&prefix)
                .unwrap_or(name)
                .eq_ignore_ascii_case(column)
                || !object["related_ids"]
                    .as_array()
                    .is_some_and(|ids| ids.contains(&table["id"]))
            {
                return Err(Error::new("invalid_input"));
            }
        }
        Some("relationship") => {
            let left = table_for(tables, &structure["left_table"])?;
            let right = table_for(tables, &structure["right_table"])?;
            for key in structure["join_keys"].as_array().into_iter().flatten() {
                check_column(left, key["left_column"].as_str().unwrap_or(""))?;
                check_column(right, key["right_column"].as_str().unwrap_or(""))?;
            }
        }
        Some("metric") => {
            let table = table_for(tables, &structure["table"])?;
            check_metric_expression(table, structure["expression"].as_str().unwrap_or(""))?;
            if let Some(column) = structure["time_column"].as_str() {
                check_column(table, column)?;
            }
            for column in structure["dimensions"].as_array().into_iter().flatten() {
                check_column(table, column.as_str().unwrap_or(""))?;
            }
        }
        Some("query_example") => {
            for key in ["applicable_question", "sql", "grain"] {
                if structure[key]
                    .as_str()
                    .is_none_or(|value| value.trim().is_empty())
                {
                    return Err(Error::new("invalid_input"));
                }
            }
            let mut names = HashSet::new();
            for parameter in structure["parameters"].as_array().into_iter().flatten() {
                let name = parameter["name"].as_str().unwrap_or("").trim();
                if name.is_empty()
                    || !names.insert(name)
                    || parameter["description"]
                        .as_str()
                        .is_none_or(|value| value.trim().is_empty())
                {
                    return Err(Error::new("invalid_input"));
                }
            }
            if !structure["verification"].is_null()
                && structure["verification"]["note"]
                    .as_str()
                    .is_none_or(|value| value.trim().is_empty())
            {
                return Err(Error::new("invalid_input"));
            }
        }
        _ => return Err(Error::new("invalid_input")),
    }
    Ok(())
}

async fn decorated_table(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    mut table: Value,
) -> Result<Value> {
    if table["kind"] != "table" {
        return Err(Error::new("invalid_input"));
    }
    let fields = store::table_objects_in_tx(tx, ctx, table["id"].as_str().unwrap_or("")).await?;
    let (columns, complete) = columns(&table, &fields);
    table["column_names"] = json!(columns);
    table["column_names_complete"] = json!(complete);
    Ok(table)
}

pub async fn validate_edit_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &Value,
    entry_id: &str,
    structure: &Value,
) -> Result<()> {
    if structure.is_null() {
        return Ok(());
    }
    let entry = object["entries"]
        .as_array()
        .and_then(|entries| entries.iter().find(|entry| entry["entry_id"] == entry_id))
        .ok_or(Error::new("invalid_input"))?;
    validate_shape(object, entry, structure)?;
    if object["entries"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|other| other["entry_id"] != entry_id && !other["effective_structure"].is_null())
    {
        return Err(Error::new("invalid_input"));
    }
    if structure["kind"] == "query_example" {
        let dependencies = query_example_dependencies(structure);
        if dependencies
            .iter()
            .any(|reference| reference["object_id"] == object["id"])
        {
            return Err(Error::new("invalid_input"));
        }
        store::check_refs_in_tx(tx, ctx, &json!(dependencies)).await?;
        return validate_bindings(object, structure, &BTreeMap::new());
    }
    let mut tables = BTreeMap::new();
    if object["kind"] == "table" {
        let table = decorated_table(tx, ctx, object.clone()).await?;
        tables.insert(object["id"].as_str().unwrap_or("").to_owned(), table);
    }
    for reference in table_dependencies(structure) {
        let table = store::read_in_tx(
            tx,
            ctx,
            reference["object_id"].as_str().unwrap_or(""),
            Some(epoch(reference["version"].as_str().unwrap_or(""))?),
            false,
        )
        .await?;
        let table = decorated_table(tx, ctx, table).await?;
        tables.insert(
            reference["object_id"].as_str().unwrap_or("").to_owned(),
            table,
        );
    }
    validate_bindings(object, structure, &tables)
}

// 只读诊断的坏引用是覆盖缺口；业务草稿保存仍使用原有严格引用校验。
pub async fn semantic_snapshot_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    refs: &Value,
) -> Result<Value> {
    let references = refs.as_array().ok_or(Error::new("invalid_input"))?;
    if references.len() > 50 {
        return Err(Error::new("invalid_input"));
    }
    let mut objects = BTreeMap::new();
    let mut notes = Vec::new();
    for reference in references {
        let object = match store::read_in_tx(
            tx,
            ctx,
            reference["object_id"].as_str().unwrap_or(""),
            Some(epoch(reference["version"].as_str().unwrap_or(""))?),
            false,
        )
        .await
        {
            Ok(object) => object,
            Err(error) if matches!(error.code, "stale_knowledge" | "not_available") => {
                notes.push("部分参考知识不可用或已变化，须重新读取有效依据。".to_owned());
                continue;
            }
            Err(error) => return Err(error),
        };
        if let Some(path) = reference["path"].as_str()
            && !object["entries"].as_array().is_some_and(|entries| {
                entries
                    .iter()
                    .any(|entry| entry["entry_id"] == path || entry["path"] == path)
            })
        {
            notes.push("参考条目不可用，须重新读取有效依据。".to_owned());
            continue;
        }
        objects.insert(object["id"].as_str().unwrap_or("").to_owned(), object);
    }
    let ids = objects.keys().cloned().collect::<Vec<_>>();
    let mut tables = BTreeMap::new();
    for id in &ids {
        let mut object = objects[id].clone();
        project_object(&mut object);
        if object["kind"] == "table" {
            let table = decorated_table(tx, ctx, object.clone()).await?;
            tables.insert(id.clone(), table.clone());
            object = table;
        }
        for entry in object["entries"].as_array().into_iter().flatten() {
            for reference in table_dependencies(&entry["effective_structure"]) {
                let dependency = store::read_in_tx(
                    tx,
                    ctx,
                    reference["object_id"].as_str().unwrap_or(""),
                    Some(epoch(reference["version"].as_str().unwrap_or(""))?),
                    false,
                )
                .await;
                match dependency {
                    Ok(table) if table["kind"] == "table" => {
                        let table = decorated_table(tx, ctx, table).await?;
                        tables.insert(
                            reference["object_id"].as_str().unwrap_or("").to_owned(),
                            table,
                        );
                    }
                    Ok(_) => {
                        notes.push("计算规则引用了不适用的对象类型。".to_owned());
                    }
                    Err(error) if matches!(error.code, "stale_knowledge" | "not_available") => {
                        notes.push("计算规则的依赖不可用或已改版，尚未重新核对。".to_owned());
                    }
                    Err(error) => return Err(error),
                }
            }
        }
        objects.insert(id.clone(), object);
    }
    for (id, table) in &tables {
        objects.entry(id.clone()).or_insert_with(|| {
            let mut value = table.clone();
            project_object(&mut value);
            value
        });
    }
    for id in objects.keys().cloned().collect::<Vec<_>>() {
        let object = objects.get_mut(&id).expect("read object");
        let base = object.clone();
        let duplicate = validate_single_structure(&base).is_err();
        let mut found = false;
        for entry in object["entries"].as_array_mut().into_iter().flatten() {
            let structure = entry["effective_structure"].clone();
            if structure.is_null() {
                continue;
            }
            if duplicate
                || validate_shape(&base, entry, &structure).is_err()
                || validate_bindings(&base, &structure, &tables).is_err()
            {
                entry["effective_structure"] = Value::Null;
                notes.push("部分计算规则缺少有效绑定或未能核对列，未用于业务检查。".to_owned());
            } else {
                found = true;
            }
        }
        if !found {
            notes.push("部分参考知识尚无可用结构，业务检查范围有限。".to_owned());
        }
    }
    let mut unique = HashSet::new();
    notes.retain(|note| unique.insert(note.clone()));
    if references.is_empty() {
        notes.push("未提供语义依据，仅有平台语法与只读检查。".to_owned());
    }
    Ok(
        json!({"objects":objects.into_values().collect::<Vec<_>>(),"coverage":{"state":if notes.is_empty(){"complete"}else{"missing_semantics"},"notes":notes}}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn rule() -> Value {
        json!({"kind":"table","grain":"每行一个订单","unique_keys":[["id"]],"time_columns":[],"default_filters":[],"constraints":[]})
    }
    #[test]
    fn proposal_listing_preserves_records_without_entries() {
        let original = json!({"id":"proposal-demo","object_id":"table-demo","base_version":"1",
            "entry_id":"description","value":"建议说明","reason":"核对资料",
            "evidence":[{"object_id":"table-demo","version":"1","path":"description"}],"state":"open"});
        contracts::validate("Proposal", &original).unwrap();
        let mut projected = original.clone();
        project_object(&mut projected);
        assert_eq!(projected, original);
        contracts::validate("Proposal", &projected).unwrap();
    }
    #[test]
    fn manual_text_does_not_reuse_source_structure() {
        let mut entry = json!({"source_facts":{"value":"来源","structured_value":rule()},"suggestion":{},"human_override":{"value":"人工正文"}});
        project_entry(&mut entry);
        assert!(entry["effective_structure"].is_null());
        entry["human_override"] = Value::Null;
        project_entry(&mut entry);
        assert_eq!(entry["effective_structure"], rule());
    }
    #[test]
    fn suggestion_and_structure_are_selected_together() {
        let mut entry = json!({"source_facts":{"value":"来源","structured_value":rule()},"suggestion":{"value":"新建议"},"human_override":null});
        project_entry(&mut entry);
        assert!(entry["effective_structure"].is_null());
        entry["suggestion"]["structured_value"] = rule();
        project_entry(&mut entry);
        assert_eq!(entry["effective_structure"], rule());
    }
    #[test]
    fn editing_another_definition_requires_rule_review() {
        let mut object = json!({"entries":[
            {"entry_id":"definition","effective_structure":rule(),"review_state":"confirmed"},
            {"entry_id":"sql","effective_structure":null,"review_state":"confirmed"}
        ]});
        mark_other_rules_for_review(&mut object, "sql");
        assert_eq!(object["entries"][0]["review_state"], "needs_review");
        assert_eq!(object["entries"][0]["effective_structure"], rule());
        assert_eq!(object["entries"][1]["review_state"], "confirmed");
    }
    #[test]
    fn ddl_columns_handle_quoted_arbitrary_tables_and_partial_fields() {
        let table = json!({"id":"arbitrary","name":"purchase lines","entries":[{"path":"ddl","effective_value":"CREATE TABLE \"purchase lines\" (\"record id\" TEXT PRIMARY KEY, amount INTEGER)"}]});
        assert_eq!(
            columns(&table, &[]),
            (vec!["record id".into(), "amount".into()], true)
        );
        let mut missing = table;
        missing["entries"][0]["effective_value"] = json!("CREATE TABLE unrelated (id TEXT)");
        let fields = vec![json!({"kind":"field","name":"record id","related_ids":["arbitrary"]})];
        assert_eq!(
            columns(&missing, &fields),
            (vec!["record id".into()], false)
        );
    }
    #[test]
    fn structure_kind_and_metadata_paths_are_checked() {
        let object = json!({"kind":"table"});
        assert!(validate_shape(&object, &json!({"path":"grain"}), &rule()).is_ok());
        assert!(validate_shape(&object, &json!({"path":"ddl"}), &rule()).is_err());
        assert!(
            validate_shape(&json!({"kind":"metric"}), &json!({"path":"body"}), &rule()).is_err()
        );
    }
    #[test]
    fn multiple_rules_and_oversized_structures_are_rejected() {
        let object = json!({"kind":"table","entries":[
            {"effective_structure":rule()}, {"effective_structure":rule()}
        ]});
        assert!(validate_single_structure(&object).is_err());
        let mut large = rule();
        large["constraints"] = json!([
            "约束".repeat(300),
            "约束".repeat(300),
            "约束".repeat(300),
            "约束".repeat(300),
            "约束".repeat(300)
        ]);
        assert!(contracts::validate("SemanticStructure", &large).is_ok());
        assert!(validate_shape(&object, &json!({"path":"description"}), &large).is_err());
    }
    #[test]
    fn stale_table_references_and_unknown_columns_are_rejected() {
        let mut tables = BTreeMap::new();
        tables.insert("orders".into(),json!({"id":"orders","kind":"table","version":"2","column_names":["id"],"column_names_complete":true}));
        assert_eq!(
            table_for(&tables, &json!({"object_id":"orders","version":"1"}))
                .unwrap_err()
                .code,
            "stale_knowledge"
        );
        assert!(check_column(&tables["orders"], "absent").is_err());
        assert!(check_column(&tables["orders"], "ID").is_ok());
    }
    #[test]
    fn structural_dependencies_keep_versions_and_complete_evidence_paths() {
        let object = json!({"entries":[{"effective_structure":{
            "kind":"relationship","left_table":{"object_id":"purchases","version":"4"},
            "right_table":{"object_id":"purchases","version":"5"}
        }}]});
        let refs = structure_dependencies(&object);
        assert_eq!(
            refs,
            json!([
                {"object_id":"purchases","version":"4","path":"ddl"},
                {"object_id":"purchases","version":"5","path":"ddl"}
            ])
            .as_array()
            .unwrap()
            .clone()
        );
        for reference in refs {
            assert!(contracts::validate("EvidenceRef", &reference).is_ok());
        }
    }
    #[test]
    fn query_example_dependencies_keep_document_paths_and_verification_evidence() {
        let refs = structure_dependencies(&json!({"entries":[{"effective_structure":{
            "kind":"query_example",
            "dependencies":[
                {"object_id":"table","version":"2","path":"ddl"},
                {"object_id":"guide","version":"3","path":"grain"},
                {"object_id":"guide","version":"3","path":"limits"}
            ],
            "verification":{"note":"已核对","evidence_refs":[
                {"object_id":"guide","version":"3","path":"grain"},
                {"object_id":"metric","version":"4","path":"body"}
            ]}
        }}]}));
        assert_eq!(
            refs,
            json!([
                {"object_id":"table","version":"2","path":"ddl"},
                {"object_id":"guide","version":"3","path":"grain"},
                {"object_id":"guide","version":"3","path":"limits"},
                {"object_id":"metric","version":"4","path":"body"}
            ])
            .as_array()
            .unwrap()
            .clone()
        );
    }
    #[test]
    fn query_example_rejects_empty_questions_and_duplicate_parameter_names() {
        let mut structure = json!({"kind":"query_example","applicable_question":"按标签统计商品行数",
            "parameters":[{"name":"cohort","type":"string","description":"结果标签","required":true}],
            "sql":"SELECT :cohort, COUNT(*) FROM purchases","grain":"单行汇总",
            "dependencies":[{"object_id":"purchases","version":"1","path":"ddl"}],"verification":null});
        let object = json!({"kind":"query_example"});
        assert!(validate_shape(&object, &json!({"path":"body"}), &structure).is_ok());
        assert!(validate_bindings(&object, &structure, &BTreeMap::new()).is_ok());
        let duplicate = structure["parameters"][0].clone();
        structure["parameters"]
            .as_array_mut()
            .unwrap()
            .push(duplicate);
        assert!(validate_bindings(&object, &structure, &BTreeMap::new()).is_err());
        structure["parameters"] = json!([]);
        structure["applicable_question"] = json!("  ");
        assert!(validate_bindings(&object, &structure, &BTreeMap::new()).is_err());
    }
    #[test]
    fn directly_bound_metric_columns_are_checked_without_compiling_complex_sql() {
        let table =
            json!({"name":"purchases","column_names":["gross"],"column_names_complete":true});
        assert!(check_metric_expression(&table, "SUM(gross) / 100").is_ok());
        assert!(check_metric_expression(&table, "SUM(absent) / 100").is_err());
        assert!(check_metric_expression(&table, "SUM(purchases.absent)").is_err());
        assert!(check_metric_expression(&table, "SELECT SUM(gross) FROM purchases").is_ok());
        assert!(check_metric_expression(&table, "SUM(").is_err());
    }
}
