use crate::{
    contracts,
    modules::queries,
    persistence::AppTx,
    types::{AccessContext, Error, Result},
};
use rust_decimal::{Decimal, RoundingStrategy};
use serde_json::{Value, json};
use sqlx::MySqlPool;
use std::{collections::BTreeMap, str::FromStr};

fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key].as_str().ok_or(Error::new("invalid_input"))
}

// 模型组织解释，宿主只取结果原值；不执行表达式，也不从普通聊天中猜数字含义。
// 取值与格式化分开：prepare把格式化后的绑定交给正文，present在同一实现上组模板。
fn resolve(binding: &Value, sources: &BTreeMap<String, (Value, Value)>) -> Result<Value> {
    let (query, result) = sources
        .get(text(binding, "query_id")?)
        .ok_or(Error::new("invalid_evidence"))?;
    Ok(match text(binding, "kind")? {
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
        "observation_cutoff" | "data_batch" => {
            // 截点/批次只绑定草稿快照里用户声明的角色值：未声明、角色不唯一或值为空
            // 都拒绝，不能以request_clock或平台data_freshness冒充用户口径。
            let kind = text(binding, "kind")?;
            let candidates: Vec<_> = query["time_basis"]["time_roles"]
                .as_array()
                .ok_or(Error::new("invalid_evidence"))?
                .iter()
                .filter(|role| role["role"].as_str() == Some(kind))
                .filter(|role| {
                    binding
                        .get("field_ref")
                        .and_then(Value::as_str)
                        .is_none_or(|field| role["field_ref"].as_str() == Some(field))
                })
                .collect();
            if candidates.len() != 1 {
                return Err(Error::new("invalid_evidence"));
            }
            let value = candidates[0]
                .get("value")
                .cloned()
                .ok_or(Error::new("invalid_evidence"))?;
            if value.is_null() {
                return Err(Error::new("invalid_evidence"));
            }
            value
        }
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
    })
}

// 固定小数位文本：round后分数位不足补零；Decimal显示不用科学计数。
fn fixed(decimal: &Decimal, precision: u32) -> String {
    let text = decimal.to_string();
    let (sign, body) = text
        .strip_prefix('-')
        .map_or(("", text.as_str()), |body| ("-", body));
    match body.split_once('.') {
        Some((integer, _)) if precision == 0 => format!("{sign}{integer}"),
        Some((integer, fraction)) => {
            let mut fraction = fraction.to_owned();
            while fraction.len() < precision as usize {
                fraction.push('0');
            }
            format!("{sign}{integer}.{fraction}")
        }
        None if precision == 0 => format!("{sign}{body}"),
        None => format!("{sign}{body}.{}", "0".repeat(precision as usize)),
    }
}

// 展示格式：缺省或raw为原值；decimal/percent经精确十进制半值远离零，
// 不经浮点往返；NULL沿原空值展示；非数字不猜单位或百分比。
fn formatted(value: &Value, format: Option<&Value>) -> Result<String> {
    if value.is_null() {
        return Ok("NULL（空值）".to_owned());
    }
    let style = format
        .map(|format| format["style"].as_str())
        .unwrap_or(Some("raw"))
        .ok_or(Error::new("invalid_input"))?;
    if style == "raw" {
        return if let Some(value) = value.as_str() {
            Ok(value.to_owned())
        } else if value.is_number() || value.is_boolean() {
            Ok(value.to_string())
        } else {
            Err(Error::new("invalid_evidence"))
        };
    }
    let precision = format
        .and_then(|format| format["precision"].as_u64())
        .ok_or(Error::new("invalid_input"))? as u32;
    let mut decimal = match value {
        Value::Number(number) => {
            Decimal::from_str(&number.to_string()).map_err(|_| Error::new("invalid_evidence"))?
        }
        Value::String(value) => {
            Decimal::from_str(value).map_err(|_| Error::new("invalid_evidence"))?
        }
        _ => return Err(Error::new("invalid_evidence")),
    };
    if style == "percent" {
        decimal *= Decimal::from(100);
    }
    // Decimal::from_str 拒绝NaN/Infinity与超出96位mantissa的值，无需再检查有限性。
    let rounded = decimal.round_dp_with_strategy(precision, RoundingStrategy::MidpointAwayFromZero);
    let rounded = if rounded.is_zero() {
        Decimal::ZERO
    } else {
        rounded
    };
    Ok(format!(
        "{}{}",
        fixed(&rounded, precision),
        if style == "percent" { "%" } else { "" }
    ))
}

// 来源文本只作为字面值显示，不能把结果单元格变成Markdown链接或控制结构。
fn escaped(rendered: &str) -> String {
    rendered.chars().fold(String::new(), |mut output, c| {
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
    })
}

fn binding_values(
    input: &Value,
    sources: &BTreeMap<String, (Value, Value)>,
) -> Result<BTreeMap<String, String>> {
    let mut bindings = BTreeMap::new();
    for binding in input["values"]
        .as_array()
        .ok_or(Error::new("invalid_input"))?
    {
        let name = text(binding, "name")?;
        let rendered = formatted(
            &resolve(binding, sources)?,
            binding.get("format").filter(|format| !format.is_null()),
        )?;
        if bindings
            .insert(name.to_owned(), escaped(&rendered))
            .is_some()
        {
            return Err(Error::new("invalid_input"));
        }
    }
    Ok(bindings)
}

// 部分结果的范围说明只在确有缺口时追加一次；完整结果为空串。
fn required_suffix(sources: &BTreeMap<String, (Value, Value)>) -> &'static str {
    if sources.values().any(|(_, result)| {
        result["saved_result_complete"] != true || result["result_complete"] != true
    }) {
        "\n\n范围说明：以上仅覆盖实际取得的结果，不能视作全量统计。"
    } else {
        ""
    }
}

// present沿原模板语义；数字字符禁令已随格式化合同移除，SQL代码块仍不放模板。
fn render(input: &Value, sources: &BTreeMap<String, (Value, Value)>) -> Result<String> {
    let bindings = binding_values(input, sources)?;
    let mut output = crate::modules::runtime::substitute(text(input, "template")?, &bindings)?;
    if output.contains("```") {
        return Err(Error::new("invalid_evidence"));
    }
    output.push_str(required_suffix(sources));
    if output.trim().is_empty() || output.chars().count() > 8000 {
        return Err(Error::new("invalid_input"));
    }
    Ok(output)
}

// present与prepare共用同一来源核验：读原查询、对回执结果、保留原任务/条件身份。
async fn verified_sources(
    pool: &MySqlPool,
    ctx: &AccessContext,
    cid: &str,
    message_id: &str,
    input: &Value,
    checked: &mut super::context_authority::CheckedTextResults,
) -> Result<(Vec<Value>, BTreeMap<String, (Value, Value)>)> {
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
    Ok((references, sources))
}

pub async fn present(
    pool: &MySqlPool,
    ctx: &AccessContext,
    cid: &str,
    message_id: &str,
    input: &Value,
    checked: &mut super::context_authority::CheckedTextResults,
) -> Result<Value> {
    contracts::validate("PresentAnalysisAnswerInput", input)?;
    let (references, sources) =
        verified_sources(pool, ctx, cid, message_id, input, checked).await?;
    Ok(
        json!({"answer_text":render(input, &sources)?,"sources":references,"result_dependencies":input["sources"]}),
    )
}

// 一次准备：只产出已核定的数值绑定与范围后缀，不生成正文、不定稿、不覆盖通知。
pub async fn prepare(
    pool: &MySqlPool,
    ctx: &AccessContext,
    cid: &str,
    message_id: &str,
    input: &Value,
    checked: &mut super::context_authority::CheckedTextResults,
) -> Result<Value> {
    contracts::validate("PrepareAnalysisAnswerInput", input)?;
    let (references, sources) =
        verified_sources(pool, ctx, cid, message_id, input, checked).await?;
    Ok(json!({"bindings":binding_values(input, &sources)?,
        "required_suffix":required_suffix(&sources),
        "sources":references,"result_dependencies":input["sources"]}))
}

pub async fn check_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    cid: &str,
    run_id: &str,
    answer: &Value,
    checked: &super::context_authority::CheckedTextResults,
) -> Result<Value> {
    let sources = check_sources_in_tx(tx, ctx, cid, answer, checked).await?;
    super::context_authority::merge_run_in_tx(tx, run_id, &sources).await?;
    Ok(sources)
}

// 冻结答案的交付核验不属于当前任务取证，不能把前项来源并入切换后的模型上下文。
pub(super) async fn check_sources_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    cid: &str,
    answer: &Value,
    checked: &super::context_authority::CheckedTextResults,
) -> Result<Value> {
    let mut sources = super::context_authority::empty();
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
        super::context_authority::merge(&mut sources, &authority)?;
    }
    let mut result_sources = super::context_authority::empty();
    result_sources["query_results"] = json!(
        answer["result_dependencies"]
            .as_array()
            .ok_or(Error::new("invalid_evidence"))?
            .iter()
            .map(|reference| json!([reference["query_id"], reference["result_ref"]]))
            .collect::<Vec<_>>()
    );
    if !checked.allows(&result_sources) {
        return Err(Error::new("stale_context"));
    }
    super::context_authority::merge(&mut sources, &result_sources)?;
    Ok(sources)
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
    fn binds_declared_cutoff_and_batch_only_from_time_basis() {
        let undeclared = sources();
        let mut declared = sources();
        declared.get_mut("query").unwrap().0["time_basis"] = json!({
        "time_start": null, "time_end": null, "timezone": "UTC",
        "time_roles": [
            {"role":"observation_cutoff","description":"按用户口径","field_ref":null,
             "value":"2026-10-01T00:00:00+08:00","evidence_refs":[]},
            {"role":"data_batch","description":"上游批次","field_ref":"batch_id",
             "value":"2026-09","evidence_refs":[]},
            {"role":"data_batch","description":"对账批次","field_ref":"recon_id",
             "value":"2026-09-R","evidence_refs":[]},
        ]});
        let input = json!({"template":"截至{{cutoff}}，批次{{batch}}。", "values":[
            {"name":"cutoff","query_id":"query","kind":"observation_cutoff"},
            {"name":"batch","query_id":"query","kind":"data_batch","field_ref":"recon_id"}]});
        assert_eq!(
            render(&input, &declared).unwrap(),
            "截至2026-10-01T00:00:00+08:00，批次2026-09-R。"
        );
        // 同名角色多条而不带field_ref：归属不明，拒绝而不是任选一条。
        let ambiguous = json!({"template":"批次{{batch}}。", "values":[
            {"name":"batch","query_id":"query","kind":"data_batch"}]});
        assert!(render(&ambiguous, &declared).is_err());
        // 未声明时间基准的旧草稿：截点/批次不可绑定，不能以时钟或平台新鲜度冒充。
        let cutoff = json!({"template":"截至{{cutoff}}。", "values":[
            {"name":"cutoff","query_id":"query","kind":"observation_cutoff"}]});
        assert!(render(&cutoff, &undeclared).is_err());
    }
    #[test]
    fn rejects_code_blocks_and_missing_sources_but_allows_plain_digits() {
        // 正常语义数字（年份、编号、零分母说明）可以直写；SQL代码块仍不放模板。
        assert_eq!(
            render(
                &json!({"template":"2026年增长10.8%，合计１００%，共{{rows}}行。",
                    "values":[{"name":"rows","query_id":"query","kind":"statistic","statistic":"row_count"}]}),
                &sources()
            )
            .unwrap(),
            "2026年增长10.8%，合计１００%，共2行。"
        );
        for template in ["增长{{missing}}", "```sql\nselect amount\n```"] {
            assert!(render(&json!({"template":template,"values":[]}), &sources()).is_err());
        }
        let input = json!({"template":"金额{{amount}}", "values":[{"name":"amount","kind":"cell","query_id":"query","column":"amount","row_index":2}]});
        assert!(render(&input, &sources()).is_err());
    }
    #[test]
    fn formats_decimal_and_percent_without_float_roundtrip() {
        let decimal = sources();
        let input = |format: Value| {
            json!({"template":"{{amount}} {{ratio}} {{empty}}",
                "values":[
                    {"name":"amount","query_id":"query","kind":"cell","row_index":0,"column":"amount","format":format},
                    {"name":"ratio","query_id":"query","kind":"cell","row_index":0,"column":"amount","format":format},
                    {"name":"empty","query_id":"query","kind":"cell","row_index":1,"column":"amount","format":format}]})
        };
        // decimal_string单元格不经浮点：9007199254740993保持精确；NULL沿原空值展示。
        assert_eq!(
            render(&input(json!({"style":"decimal","precision":0})), &decimal).unwrap(),
            "9007199254740993 9007199254740993 NULL（空值）"
        );
        assert_eq!(
            render(&input(json!({"style":"percent","precision":2})), &decimal).unwrap(),
            "900719925474099300.00% 900719925474099300.00% NULL（空值）"
        );
    }
    #[test]
    fn rounds_half_away_from_zero_and_rejects_non_numeric_styles() {
        let formatted =
            |value: Value, format: Value| super::formatted(&value, Some(&format)).unwrap();
        assert_eq!(
            formatted(json!(0.5), json!({"style":"decimal","precision":0})),
            "1"
        );
        assert_eq!(
            formatted(json!("-0.5"), json!({"style":"decimal","precision":0})),
            "-1"
        );
        assert_eq!(
            formatted(json!("2.345"), json!({"style":"decimal","precision":2})),
            "2.35"
        );
        assert_eq!(
            formatted(json!("2.344"), json!({"style":"decimal","precision":2})),
            "2.34"
        );
        assert_eq!(
            formatted(json!(0.4), json!({"style":"percent","precision":2})),
            "40.00%"
        );
        assert_eq!(
            formatted(json!(3), json!({"style":"percent","precision":0})),
            "300%"
        );
        assert_eq!(
            formatted(json!("-0.001"), json!({"style":"decimal","precision":0})),
            "0"
        );
        assert_eq!(
            formatted(json!("40"), json!({"style":"decimal","precision":3})),
            "40.000"
        );
        // 非数字字符串不猜单位/百分比；布尔同样拒绝。
        assert!(
            super::formatted(
                &json!("N/A"),
                Some(&json!({"style":"percent","precision":1}))
            )
            .is_err()
        );
        assert!(
            super::formatted(
                &json!(true),
                Some(&json!({"style":"decimal","precision":1}))
            )
            .is_err()
        );
        // raw保持原值。
        assert_eq!(
            formatted(json!("9007199254740993"), json!({"style":"raw"})),
            "9007199254740993"
        );
    }
    #[test]
    fn display_replaces_markers_once_and_appends_suffix() {
        let prepared = json!({"bindings":{"rate":"40.00%","note":"值不再扫描{{rate}}"},
            "required_suffix":"\n\n范围说明：以上仅覆盖实际取得的结果，不能视作全量统计。"});
        assert_eq!(
            crate::modules::runtime::display_from_preparation("达成率为{{rate}}。", &prepared)
                .unwrap(),
            "达成率为40.00%。\n\n范围说明：以上仅覆盖实际取得的结果，不能视作全量统计。"
        );
        let complete = json!({"bindings":{"a":"1"},"required_suffix":""});
        assert_eq!(
            crate::modules::runtime::display_from_preparation(
                "单个 { 不构成标记，{{a}} 替换一次。",
                &complete
            )
            .unwrap(),
            "单个 { 不构成标记，1 替换一次。"
        );
        // 未知标记、未闭合标记都不能定稿。
        assert!(
            crate::modules::runtime::display_from_preparation("{{missing}}", &complete).is_err()
        );
        assert!(
            crate::modules::runtime::display_from_preparation("已开始 {{未闭合", &complete)
                .is_err()
        );
    }
}
