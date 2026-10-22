use crate::{
    contracts,
    modules::queries,
    persistence::AppTx,
    types::{AccessContext, Error, Result},
};
use serde_json::{Value, json};
use sqlx::MySqlPool;
use std::collections::BTreeMap;

fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key].as_str().ok_or(Error::new("invalid_input"))
}

// 模型组织解释，宿主填入结果原值；不执行表达式，也不从普通聊天中猜数字含义。
fn render(input: &Value, sources: &BTreeMap<String, (Value, Value)>) -> Result<String> {
    let mut bindings = BTreeMap::new();
    for binding in input["values"]
        .as_array()
        .ok_or(Error::new("invalid_input"))?
    {
        let name = text(binding, "name")?;
        let (query, result) = sources
            .get(text(binding, "query_id")?)
            .ok_or(Error::new("invalid_evidence"))?;
        let value = match text(binding, "kind")? {
            "cell" => {
                let column = text(binding, "column")?;
                let columns = result["columns"]
                    .as_array()
                    .ok_or(Error::new("result_unavailable"))?;
                let matches: Vec<_> = columns
                    .iter()
                    .enumerate()
                    .filter(|(_, c)| c["name"] == column)
                    .collect();
                if matches.len() != 1 {
                    return Err(Error::new("invalid_evidence"));
                }
                result["rows"]
                    .as_array()
                    .and_then(|rows| rows.get(binding["row_index"].as_u64()? as usize))
                    .and_then(|row| row.as_array())
                    .and_then(|row| row.get(matches[0].0))
                    .ok_or(Error::new("invalid_evidence"))?
                    .clone()
            }
            "parameter" => query["parameters"]
                .get(text(binding, "parameter")?)
                .ok_or(Error::new("invalid_evidence"))?
                .clone(),
            "metadata" => result
                .get(text(binding, "metadata")?)
                .ok_or(Error::new("invalid_evidence"))?
                .clone(),
            "statistic" => {
                let statistic = text(binding, "statistic")?;
                let statistics = &result["statistics"];
                if statistic == "row_count" {
                    statistics
                        .get(statistic)
                        .ok_or(Error::new("invalid_evidence"))?
                        .clone()
                } else {
                    let column = text(binding, "column")?;
                    let stats = statistics["columns"]
                        .as_array()
                        .and_then(|columns| columns.iter().find(|c| c["column_name"] == column))
                        .ok_or(Error::new("invalid_evidence"))?;
                    let scope = if matches!(statistic, "positive" | "zero" | "negative") {
                        &stats["numeric_counts"]
                    } else {
                        stats
                    };
                    scope
                        .get(statistic)
                        .ok_or(Error::new("invalid_evidence"))?
                        .clone()
                }
            }
            _ => return Err(Error::new("invalid_input")),
        };
        let rendered = if value.is_null() {
            "NULL（空值）".to_owned()
        } else if let Some(value) = value.as_str() {
            value.to_owned()
        } else if value.is_number() || value.is_boolean() {
            value.to_string()
        } else {
            return Err(Error::new("invalid_evidence"));
        };
        // 来源文本只作为字面值显示，不能把结果单元格变成Markdown链接或控制结构。
        let escaped = rendered.chars().fold(String::new(), |mut output, c| {
            if matches!(
                c,
                '\\' | '`' | '*' | '_' | '[' | ']' | '<' | '>' | '|' | '#'
            ) {
                output.push('\\');
            }
            if c == '\n' || c == '\r' {
                output.push(' ');
            } else {
                output.push(c);
            }
            output
        });
        if bindings.insert(name, escaped).is_some() {
            return Err(Error::new("invalid_input"));
        }
    }
    let mut remaining = text(input, "template")?;
    if remaining.contains("```")
        || remaining
            .chars()
            .any(|c| c.is_ascii_digit() || ('０'..='９').contains(&c))
    {
        return Err(Error::new("invalid_evidence"));
    }
    let mut output = String::new();
    while let Some(start) = remaining.find("{{") {
        output.push_str(&remaining[..start]);
        let after = &remaining[start + 2..];
        let end = after.find("}}").ok_or(Error::new("invalid_evidence"))?;
        output.push_str(
            bindings
                .get(&after[..end])
                .ok_or(Error::new("invalid_evidence"))?,
        );
        remaining = &after[end + 2..];
    }
    if remaining.contains("}}") {
        return Err(Error::new("invalid_evidence"));
    }
    output.push_str(remaining);
    if sources.values().any(|(_, result)| {
        result["saved_result_complete"] != true || result["result_complete"] != true
    }) {
        output.push_str("\n\n范围说明：以上仅覆盖实际取得的结果，不能视作全量统计。");
    }
    if output.trim().is_empty() || output.chars().count() > 8000 {
        return Err(Error::new("invalid_input"));
    }
    Ok(output)
}

pub async fn prepare(
    pool: &MySqlPool,
    ctx: &AccessContext,
    cid: &str,
    message_id: &str,
    input: &Value,
    checked: &mut super::context_authority::CheckedTextResults,
) -> Result<Value> {
    contracts::validate("PresentAnalysisAnswerInput", input)?;
    let mut sources = BTreeMap::new();
    let mut references = Vec::new();
    for source in input["sources"].as_array().expect("validated") {
        let qid = text(source, "query_id")?;
        let query = super::query_workflow::read(pool, ctx, qid).await?;
        let conditions = json!({"task_id":query["task_id"],"condition_version":query["condition_version"],
            "data_range":"按原查询条件解释", "findings":[{"text":"结果引用核对","calculation":"","limitations":["以实际返回范围为准"],
            "knowledge_refs":[],"figures":[],"query_refs":[source]}]});
        let (_, mut results) = super::analysis_evidence::validate_sources_and_results(
            pool,
            ctx,
            cid,
            message_id,
            &conditions,
            checked,
        )
        .await?;
        let result = results
            .remove(qid)
            .ok_or(Error::new("result_unavailable"))?;
        if result["result_ref"] != source["result_ref"] || sources.contains_key(qid) {
            return Err(Error::new("invalid_evidence"));
        }
        references.push(json!({"query_id":qid,"result_ref":source["result_ref"],"task_id":query["task_id"],"condition_version":query["condition_version"]}));
        sources.insert(qid.to_owned(), (query, result));
    }
    Ok(
        json!({"answer_text":render(input, &sources)?,"sources":references,"result_dependencies":input["sources"]}),
    )
}

pub async fn check_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    cid: &str,
    run_id: &str,
    answer: &Value,
    checked: &super::context_authority::CheckedTextResults,
) -> Result<()> {
    for reference in answer["sources"]
        .as_array()
        .ok_or(Error::new("invalid_evidence"))?
    {
        let query = queries::read_in_tx(tx, ctx, text(reference, "query_id")?).await?;
        super::analysis_evidence::assert_query(&query, cid, reference, reference)?;
        let authority = super::query_workflow::validate_text_in_tx(
            tx,
            ctx,
            cid,
            text(reference, "query_id")?,
            checked,
        )
        .await?;
        super::context_authority::merge_run_in_tx(tx, run_id, &authority).await?;
    }
    super::context_authority::extend_result_dependencies_in_tx(
        tx,
        run_id,
        &answer["result_dependencies"],
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sources() -> BTreeMap<String, (Value, Value)> {
        BTreeMap::from([(
            "query".into(),
            (
                json!({"parameters":{"start":"2026-01-01"}}),
                json!({
            "columns":[{"name":"amount"}],"rows":[["9007199254740993"],[null]],
            "statistics":{"row_count":2,"columns":[{"column_name":"amount","null_count":1}]},
            "result_complete":true,"saved_result_complete":true}),
            ),
        )])
    }
    #[test]
    fn binds_exact_values_nulls_parameters_and_statistics_without_arithmetic() {
        let input = json!({"template":"从{{start}}起，金额{{amount}}；另一项{{missing}}，共{{rows}}行。", "values":[
            {"name":"start","query_id":"query","kind":"parameter","parameter":"start"},
            {"name":"amount","query_id":"query","kind":"cell","row_index":0,"column":"amount"},
            {"name":"missing","query_id":"query","kind":"cell","row_index":1,"column":"amount"},
            {"name":"rows","query_id":"query","kind":"statistic","statistic":"row_count"}]});
        assert_eq!(
            render(&input, &sources()).unwrap(),
            "从2026-01-01起，金额9007199254740993；另一项NULL（空值），共2行。"
        );
    }
    #[test]
    fn rejects_unbound_numbers_and_missing_source_cells() {
        for template in [
            "增长10.8%",
            "合计１００%",
            "增长{{missing}}",
            "```sql\nselect amount\n```",
        ] {
            assert!(render(&json!({"template":template,"values":[]}), &sources()).is_err());
        }
        let input = json!({"template":"金额{{amount}}", "values":[{"name":"amount","kind":"cell","query_id":"query","column":"amount","row_index":2}]});
        assert!(render(&input, &sources()).is_err());
    }
}
