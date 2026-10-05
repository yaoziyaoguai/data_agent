use crate::{
    contracts,
    types::{AccessContext, Error, Result, fingerprint},
};
use serde_json::{Value, json};

pub fn source_id(space: &str, namespace: &str, table: &str) -> String {
    format!(
        "catalog-{}",
        &fingerprint(&json!([space, namespace, table]))[..48]
    )
}
fn object_id(space: &str, namespace: &str, table: &str, column: Option<&str>) -> String {
    format!(
        "{}-{}",
        if column.is_some() { "field" } else { "table" },
        &fingerprint(&json!([space, namespace, table, column]))[..48]
    )
}
pub fn table_object_id(space: &str, namespace: &str, table: &str) -> String {
    object_id(space, namespace, table, None)
}
pub fn source_text(table: &Value) -> String {
    let mut text = format!(
        "# 平台原始元数据\n{}\n\n# 原始DDL\n{}\n\n# 表注释\n{}\n",
        table,
        table["ddl"].as_str().unwrap_or(""),
        table["comment"].as_str().unwrap_or("")
    );
    for column in table["columns"].as_array().into_iter().flatten() {
        text.push_str(&format!("\n# 原始字段元数据\n{column}\n"));
        text.push_str(&format!(
            "\n# 字段 {}\n类型 {}；可空 {}\n{}\n",
            column["name"].as_str().unwrap_or(""),
            column["data_type"].as_str().unwrap_or(""),
            column["nullable"],
            column["comment"].as_str().unwrap_or("")
        ));
    }
    if !table["node"].is_null() {
        text.push_str(&format!(
            "\n# 调度节点 {} 的加工SQL\n{}\n\n# 生产血缘（不自动代表可查询JOIN）\n{}\n",
            table["node"]["id"].as_str().unwrap_or(""),
            table["node"]["sql"].as_str().unwrap_or(""),
            table["node"]["upstream_ids"]
        ));
    }
    text
}
fn entry(path: &str, label: &str, value: &str, quote: &str, source: &str, version: u64) -> Value {
    json!({"entry_id":path,"path":path,"label":label,"source_facts":{"source_id":source,"version":version.to_string(),"location":path,"quote":quote,"value":value,"complete":!value.is_empty(),"gap":if value.is_empty(){Some("平台没有提供此解释，等待分析或人工补充")}else{None}},"suggestion":{},"human_override":null,"effective_value":value,"review_state":"unverified"})
}
pub fn objects(
    ctx: &AccessContext,
    namespace: &str,
    table: &Value,
    version: u64,
) -> Result<Vec<Value>> {
    contracts::validate("CatalogTable", table)?;
    let table_key = table["id"].as_str().ok_or(Error::new("invalid_input"))?;
    let source = source_id(&ctx.space_id, namespace, table_key);
    let table_id = object_id(&ctx.space_id, namespace, table_key, None);
    let sql = table["node"]["sql"].as_str().unwrap_or("");
    let mut entries = vec![
        entry(
            "description",
            "表说明",
            table["comment"].as_str().unwrap_or(""),
            table["comment"].as_str().unwrap_or(""),
            &source,
            version,
        ),
        entry(
            "ddl",
            "表结构",
            table["ddl"].as_str().unwrap_or(""),
            table["ddl"].as_str().unwrap_or(""),
            &source,
            version,
        ),
        entry("etl", "加工SQL", sql, sql, &source, version),
    ];
    let lineage = table["node"]["upstream_ids"]
        .as_array()
        .map(|upstream| json!(upstream).to_string())
        .unwrap_or_default();
    // 节点移除也推进来源版本；旧血缘只能留在历史或人工覆盖中。
    entries.push(entry(
        "lineage",
        "生产血缘",
        &lineage,
        &lineage,
        &source,
        version,
    ));
    for (path, label) in [
        ("grain", "每行代表什么"),
        ("time", "时间与范围"),
        ("keys", "主键与去重"),
        ("filters", "默认过滤与特殊情况"),
        ("metrics", "支持的指标与计算"),
        ("limitations", "适用范围和缺口"),
    ] {
        entries.push(entry(path, label, "", "", &source, version));
    }
    let build = |id: String,
                 kind: &str,
                 name: String,
                 entries: Vec<Value>,
                 related: Vec<String>| json!({"id":id,"kind":kind,"name":name,"version":"1","state":"enabled","entries":entries,"related_ids":related,"source_id":source,"source_version":version.to_string(),"updated_by":"platform-catalog"});
    let mut values = vec![build(
        table_id.clone(),
        "table",
        table["name"].as_str().unwrap_or("").into(),
        entries,
        vec![],
    )];
    let mut ids = std::collections::HashSet::new();
    for column in table["columns"]
        .as_array()
        .ok_or(Error::new("invalid_input"))?
    {
        let column_key = column["id"].as_str().ok_or(Error::new("invalid_input"))?;
        if !ids.insert(column_key) {
            return Err(Error::new("invalid_input"));
        }
        let datatype = format!(
            "{}{}",
            column["data_type"].as_str().unwrap_or(""),
            if column["nullable"] == true {
                "，可空"
            } else {
                "，非空"
            }
        );
        values.push(build(
            object_id(&ctx.space_id, namespace, table_key, Some(column_key)),
            "field",
            format!(
                "{}.{}",
                table["name"].as_str().unwrap_or(""),
                column["name"].as_str().unwrap_or("")
            ),
            vec![
                entry(
                    "meaning",
                    "字段含义",
                    column["comment"].as_str().unwrap_or(""),
                    column["comment"].as_str().unwrap_or(""),
                    &source,
                    version,
                ),
                entry(
                    "type",
                    "字段类型",
                    &datatype,
                    &column.to_string(),
                    &source,
                    version,
                ),
                entry("unit", "单位与精度", "", "", &source, version),
                entry("values", "取值与空值含义", "", "", &source, version),
                entry("calculation", "加工与计算规则", "", "", &source, version),
                entry("limitations", "适用范围和缺口", "", "", &source, version),
            ],
            vec![table_id.clone()],
        ));
    }
    for value in &values {
        contracts::validate("KnowledgeObject", value)?;
    }
    Ok(values)
}

pub async fn fetch_page(cursor: Option<&str>, snapshot: Option<&str>) -> Result<Value> {
    let url =
        std::env::var("DATA_AGENT_PLATFORM_URL").map_err(|_| Error::new("source_unavailable"))?;
    let url = reqwest::Url::parse(&url).map_err(|_| Error::new("invalid_input"))?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.username() != ""
        || url.password().is_some()
    {
        return Err(Error::new("invalid_input"));
    }
    let token =
        std::env::var("DATA_AGENT_INTERNAL_TOKEN").map_err(|_| Error::new("source_unavailable"))?;
    let response = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|_| Error::new("source_unavailable"))?
        .post(
            url.join("/catalog")
                .map_err(|_| Error::new("invalid_input"))?,
        )
        .bearer_auth(token)
        .json(&json!({"cursor":cursor,"snapshot_id":snapshot,"limit":50}))
        .send()
        .await
        .map_err(|_| Error::new("source_unavailable"))?;
    if !response.status().is_success() {
        return Err(Error::new("source_unavailable"));
    }
    if response.content_length().is_some_and(|v| v > 8_000_000) {
        return Err(Error::new("payload_limit"));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|_| Error::new("source_unavailable"))?;
    if bytes.len() > 8_000_000 {
        return Err(Error::new("payload_limit"));
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| Error::new("invalid_input"))?;
    contracts::validate("CatalogPage", &value)?;
    Ok(value)
}
