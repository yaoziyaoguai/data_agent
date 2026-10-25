use crate::{
    persistence::AppTx,
    types::{AccessContext, Error, Result},
};
use serde_json::Value;
use sqlx::Row;
use std::collections::{HashMap, HashSet, VecDeque};

// 依赖索引与知识保存同事务：保存时从各层实际内容生成依赖行，读取按索引
// 批量/分页进行，不逐条装配完整对象。旧内容没有可映射来源时不生成行，
// 由读取侧按unknown处理，不得猜无依赖。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DependencyRow {
    pub owner_id: String,
    pub owner_version: u64,
    pub entry_path: String,
    pub layer: String,
    pub purpose: String,
    pub role: String,
    pub effective: bool,
    pub target_kind: String,
    pub target_id: String,
    pub target_revision: u64,
    pub target_path: String,
    pub target_fingerprint: String,
}

// 目标相关内容：知识目标取登记路径的有效值（路径为空取全部有效条目），文档取
// 全部有效条目正文，平台来源取正文原文。粒度是整份相关内容；引用片段级指纹
// 属出处重绑定，无法可靠细分时按整份保守比较。
fn relevant_content(kind: &str, body: &Value, path: &str) -> String {
    let entries = body["entries"].as_array();
    match kind {
        "knowledge" if !path.is_empty() => entries
            .into_iter()
            .flatten()
            .find(|entry| entry["path"].as_str() == Some(path))
            .and_then(|entry| entry["effective_value"].as_str())
            .unwrap_or("")
            .to_owned(),
        "document" | "knowledge" => entries
            .into_iter()
            .flatten()
            .filter_map(|entry| entry["effective_value"].as_str())
            .collect::<Vec<_>>()
            .join("\n\n"),
        _ => body.as_str().unwrap_or("").to_owned(),
    }
}

fn content_fingerprint(kind: &str, body: &Value, path: &str) -> String {
    crate::types::fingerprint(&serde_json::json!(relevant_content(kind, body, path)))
}

// 条目有效层沿用语义投影的优先级：人工确认优先，其次模型建议，最后来源事实。
fn effective_layer(entry: &Value, document: bool) -> &'static str {
    if document {
        "model_suggestion"
    } else if entry["human_override"].is_object() {
        "human_override"
    } else if entry["suggestion"]["value"].is_string() {
        "model_suggestion"
    } else {
        "source_fact"
    }
}

struct DependencyCollector {
    owner_id: String,
    owner_version: u64,
    rows: Vec<DependencyRow>,
    seen: HashSet<(String, String, String, String, String, u64, String)>,
}

impl DependencyCollector {
    fn new(owner_id: String, owner_version: u64) -> Self {
        Self {
            owner_id,
            owner_version,
            rows: Vec::new(),
            seen: HashSet::new(),
        }
    }

    fn push(&mut self, mut row: DependencyRow) {
        row.owner_id = self.owner_id.clone();
        row.owner_version = self.owner_version;
        if self.seen.insert((
            row.layer.clone(),
            row.role.clone(),
            row.target_kind.clone(),
            row.target_id.clone(),
            row.entry_path.clone(),
            row.target_revision,
            row.purpose.clone(),
        )) {
            self.rows.push(row);
        }
    }

    // 来源引用按document-前缀区分文档与平台来源；缺身份或修订不登记。
    fn push_source(
        &mut self,
        entry_path: &str,
        layer: &str,
        effective: bool,
        role: &str,
        reference: &Value,
    ) {
        let Some(source) = reference["source_id"].as_str() else {
            return;
        };
        let Some(revision) = reference["version"]
            .as_str()
            .and_then(|value| value.parse::<u64>().ok())
        else {
            return;
        };
        let (kind, id) = match source.strip_prefix("document-") {
            Some(id) => ("document", id.to_owned()),
            None => ("platform", source.to_owned()),
        };
        self.push(DependencyRow {
            owner_id: String::new(),
            owner_version: 0,
            entry_path: entry_path.to_owned(),
            layer: layer.to_owned(),
            purpose: "required".to_owned(),
            role: role.to_owned(),
            effective,
            target_kind: kind.to_owned(),
            target_id: id,
            target_revision: revision,
            target_path: String::new(),
            target_fingerprint: String::new(),
        });
    }

    // 必要知识引用按对象引用登记，目标修订即被引用对象版本；role区分支持、
    // 结构依赖与示例输出声明，它们都绑定知识对象修订并随改版受检。
    fn push_knowledge_reference(
        &mut self,
        entry_path: &str,
        layer: &str,
        effective: bool,
        role: &str,
        object_ref: &Value,
    ) {
        let Some(target) = object_ref["object_id"].as_str() else {
            return;
        };
        let Some(revision) = object_ref["version"]
            .as_str()
            .and_then(|value| value.parse::<u64>().ok())
        else {
            return;
        };
        self.push(DependencyRow {
            owner_id: String::new(),
            owner_version: 0,
            entry_path: entry_path.to_owned(),
            layer: layer.to_owned(),
            purpose: "required".to_owned(),
            role: role.to_owned(),
            effective,
            target_kind: "knowledge".to_owned(),
            target_id: target.to_owned(),
            target_revision: revision,
            target_path: object_ref["path"].as_str().unwrap_or("").to_owned(),
            target_fingerprint: String::new(),
        });
    }
}

// 从对象当前正文生成依赖行：来源事实的原始出处与结构化证据、模型建议的证据/
// 资料引用、各层陈述的原文引用与必要知识支持。引用按其所在层登记，
// 只有有效层行参与语义有效性；人工完全替换后的旧层行保留但不再有效；
// 同文确认（人工正文与自动层逐字相同）按人工层承载该层出处，来源保留。
// 同时给出整对象映射状态：有效层存在无映射来源的自动内容时为unknown，
// 人工内容与已映射内容都算complete；读取侧不得把unknown猜成已知无依赖。
pub struct ObjectDependencies {
    pub rows: Vec<DependencyRow>,
    pub complete: bool,
}

// 单条陈述的出处登记：citation绑定来源修订，knowledge支持绑定对象版本。
fn collect_statement_sources(
    collector: &mut DependencyCollector,
    entry_path: &str,
    row_layer: &str,
    effective: bool,
    statement: &Value,
) {
    for citation in statement["citations"].as_array().into_iter().flatten() {
        let reference = json_source_reference(&citation["source"], &citation["revision"]);
        collector.push_source(entry_path, row_layer, effective, "citation", &reference);
    }
    for support in statement["supports"].as_array().into_iter().flatten() {
        if support["reference"]["kind"] == "knowledge" {
            collector.push_knowledge_reference(
                entry_path,
                row_layer,
                effective,
                "support",
                &support["reference"]["ref"],
            );
        }
    }
}

// 陈述完整文本（text＋scope_text，与建议层value拼接形态一致）逐字留在人工值中
// 才算未替换部分；只保留半句、改写或删掉都不携带旧出处。
fn statement_retained_verbatim(statement: &Value, human_text: &str) -> bool {
    let text = statement["text"].as_str().unwrap_or("");
    let scope = statement["scope_text"].as_str().unwrap_or("");
    let full = if scope.is_empty() {
        text.to_owned()
    } else {
        format!("{text}\n{scope}")
    };
    let trimmed = full.trim();
    !trimmed.is_empty() && human_text.contains(trimmed)
}

// 登记source_layer在正文里的来源引用，写入行的层为row_layer：常规登记两者相同，
// 同文确认时以自动层的引用集合按人工层登记为有效行。
fn collect_layer_sources(
    collector: &mut DependencyCollector,
    entry: &Value,
    entry_path: &str,
    row_layer: &str,
    source_layer: &str,
    effective: bool,
) {
    match source_layer {
        "source_fact" => {
            if entry["source_facts"]["source_id"].is_string() {
                collector.push_source(
                    entry_path,
                    row_layer,
                    effective,
                    "origin",
                    &entry["source_facts"],
                );
            }
            for reference in entry["source_facts"]["structured_evidence"]
                .as_array()
                .into_iter()
                .flatten()
            {
                collector.push_source(entry_path, row_layer, effective, "evidence", reference);
            }
        }
        "model_suggestion" => {
            for (field, role) in [("material_refs", "material"), ("evidence", "evidence")] {
                for reference in entry["suggestion"][field].as_array().into_iter().flatten() {
                    collector.push_source(entry_path, row_layer, effective, role, reference);
                }
            }
        }
        _ => {}
    }
    for statement in entry[layer_field(source_layer)]["statements"]
        .as_array()
        .into_iter()
        .flatten()
    {
        collect_statement_sources(collector, entry_path, row_layer, effective, statement);
    }
}

pub fn rows_for_object(object: &Value) -> Result<ObjectDependencies> {
    let owner_id = object["id"]
        .as_str()
        .ok_or(Error::new("invalid_input"))?
        .to_owned();
    let owner_version = object["version"]
        .as_str()
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or(Error::new("invalid_input"))?;
    let document = object["kind"] == "document";
    let mut collector = DependencyCollector::new(owner_id, owner_version);
    let mut complete = true;
    for entry in object["entries"].as_array().into_iter().flatten() {
        let entry_path = entry["path"].as_str().unwrap_or("").to_owned();
        let effective = effective_layer(entry, document);
        for layer in ["source_fact", "model_suggestion", "human_override"] {
            collect_layer_sources(
                &mut collector,
                entry,
                &entry_path,
                layer,
                layer,
                effective == layer,
            );
        }
        // 同文确认：人工正文与自动层逐字相同，出处仍是该层来源，按人工层登记为
        // 有效行（同文重存/仅确认保留来源）。局部替换：与整层文本不同，但逐字
        // 保留的陈述仍是未替换部分，其出处同样按人工层登记为有效行；整条提交
        // 不把局部修改误判为全部替换。
        if effective == "human_override" {
            let human_text = entry["human_override"]["value"]
                .as_str()
                .map(str::trim)
                .unwrap_or("");
            if !human_text.is_empty() {
                for (layer, field) in [
                    ("model_suggestion", "suggestion"),
                    ("source_fact", "source_facts"),
                ] {
                    if entry[field]["value"].as_str().map(str::trim) == Some(human_text) {
                        collect_layer_sources(
                            &mut collector,
                            entry,
                            &entry_path,
                            "human_override",
                            layer,
                            true,
                        );
                    } else {
                        for statement in entry[field]["statements"].as_array().into_iter().flatten()
                        {
                            if statement_retained_verbatim(statement, human_text) {
                                collect_statement_sources(
                                    &mut collector,
                                    &entry_path,
                                    "human_override",
                                    true,
                                    statement,
                                );
                            }
                        }
                    }
                }
            }
        }
        // 结构的知识引用与正文同层登记：query_example结构的dependencies是所依赖
        // 资料，computed_metrics只声明实际输出（过滤用指标不冒充输出）；两类引用
        // 都绑定知识对象修订，被引对象改版后随有效层行受检。人工层承载的结构
        // 同样登记，结构与正文必须同层，不借用底层结构。
        let structure = &entry["effective_structure"];
        if structure["kind"] == "query_example" {
            for reference in structure["dependencies"].as_array().into_iter().flatten() {
                collector.push_knowledge_reference(
                    &entry_path,
                    effective,
                    true,
                    "structure",
                    reference,
                );
            }
            for metric in structure["computed_metrics"]
                .as_array()
                .into_iter()
                .flatten()
            {
                collector.push_knowledge_reference(
                    &entry_path,
                    effective,
                    true,
                    "output_metric",
                    &metric["metric_ref"],
                );
            }
        }
        if effective != "human_override" {
            let effective_field = layer_field(effective);
            let has_content = entry[effective_field]["value"]
                .as_str()
                .is_some_and(|value| !value.trim().is_empty())
                || entry[effective_field]["statements"]
                    .as_array()
                    .is_some_and(|statements| !statements.is_empty());
            let mapped = collector
                .rows
                .iter()
                .any(|row| row.entry_path == entry_path && row.effective);
            // 有效层有自动内容却提取不到任何来源映射：如实记unknown，不猜无依赖。
            if has_content && !mapped {
                complete = false;
            }
        }
    }
    Ok(ObjectDependencies {
        rows: collector.rows,
        complete,
    })
}

fn layer_field(layer: &str) -> &str {
    match layer {
        "source_fact" => "source_facts",
        "model_suggestion" => "suggestion",
        _ => "human_override",
    }
}

fn json_source_reference(source: &Value, revision: &Value) -> Value {
    let id = match source["kind"].as_str() {
        Some("document") => format!("document-{}", source["id"].as_str().unwrap_or_default()),
        _ => source["id"].as_str().unwrap_or_default().to_owned(),
    };
    serde_json::json!({"source_id":id,"version":revision})
}

// 登记修订下的目标内容哈希：平台来源读快照正文，文档/知识目标读历史版本正文。
// 读不到正文（快照缺失或版本未落库）时留空指纹，失效判定按保守失效处理。
async fn fill_target_fingerprints_in_tx(
    tx: &mut AppTx<'_>,
    rows: &mut [DependencyRow],
) -> Result<()> {
    let mut platforms: Vec<(String, u64)> = Vec::new();
    let mut objects: Vec<(String, u64)> = Vec::new();
    let mut seen = HashSet::new();
    for row in rows.iter() {
        if !seen.insert((
            row.target_kind.clone(),
            row.target_id.clone(),
            row.target_revision,
        )) {
            continue;
        }
        match row.target_kind.as_str() {
            "platform" => platforms.push((row.target_id.clone(), row.target_revision)),
            _ => objects.push((row.target_id.clone(), row.target_revision)),
        }
    }
    let mut platform_contents: HashMap<(String, u64), Value> = HashMap::new();
    for chunk in platforms.chunks(200) {
        if chunk.is_empty() {
            continue;
        }
        let tuple_list = placeholders(chunk.len(), 2);
        let mut query = sqlx::query(sqlx::AssertSqlSafe(format!(
            "SELECT source_id,version,body FROM source_snapshots WHERE (source_id,version) IN ({tuple_list})"
        )));
        for (id, revision) in chunk {
            query = query.bind(id).bind(revision);
        }
        for record in query.fetch_all(tx.connection()).await? {
            platform_contents.insert(
                (
                    record.get::<String, _>("source_id"),
                    record.get::<u64, _>("version"),
                ),
                Value::String(record.get::<String, _>("body")),
            );
        }
    }
    let mut object_contents: HashMap<(String, u64), Value> = HashMap::new();
    for chunk in objects.chunks(200) {
        if chunk.is_empty() {
            continue;
        }
        let tuple_list = placeholders(chunk.len(), 2);
        let mut query = sqlx::query(sqlx::AssertSqlSafe(format!(
            "SELECT object_id,version,body FROM knowledge_versions WHERE (object_id,version) IN ({tuple_list})"
        )));
        for (id, revision) in chunk {
            query = query.bind(id).bind(revision);
        }
        for record in query.fetch_all(tx.connection()).await? {
            object_contents.insert(
                (
                    record.get::<String, _>("object_id"),
                    record.get::<u64, _>("version"),
                ),
                record.get::<sqlx::types::Json<Value>, _>("body").0,
            );
        }
    }
    for row in rows.iter_mut() {
        let contents = if row.target_kind == "platform" {
            &platform_contents
        } else {
            &object_contents
        };
        if let Some(body) = contents.get(&(row.target_id.clone(), row.target_revision)) {
            row.target_fingerprint = content_fingerprint(&row.target_kind, body, &row.target_path);
        }
    }
    Ok(())
}

// 保存侧的存在性判定：按反向索引一次查询确认是否有有效依赖行指向该对象。
// 文档对象与知识对象的目标身份不同（document-前缀拆分），保存方据此登记扇出。
pub async fn has_dependents_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    kind: &str,
    object_id: &str,
) -> Result<bool> {
    let target_kind = if kind == "document" {
        "document"
    } else {
        "knowledge"
    };
    let row = sqlx::query(
        "SELECT 1 FROM knowledge_dependencies WHERE space_id=? AND target_kind=? AND target_id=? AND effective=1 LIMIT 1",
    )
    .bind(&ctx.space_id)
    .bind(target_kind)
    .bind(object_id)
    .fetch_optional(tx.connection())
    .await?;
    Ok(row.is_some())
}

pub async fn persist_in_tx(tx: &mut AppTx<'_>, ctx: &AccessContext, object: &Value) -> Result<()> {
    let owner_id = object["id"].as_str().ok_or(Error::new("invalid_input"))?;
    let version = object["version"]
        .as_str()
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or(Error::new("invalid_input"))?;
    let mut indexed = rows_for_object(object)?;
    fill_target_fingerprints_in_tx(tx, &mut indexed.rows).await?;
    sqlx::query("DELETE FROM knowledge_dependencies WHERE owner_id=? AND owner_version=?")
        .bind(owner_id)
        .bind(version)
        .execute(tx.connection())
        .await?;
    sqlx::query("DELETE FROM knowledge_dependency_states WHERE owner_id=? AND owner_version=?")
        .bind(owner_id)
        .bind(version)
        .execute(tx.connection())
        .await?;
    for row in indexed.rows {
        sqlx::query("INSERT IGNORE INTO knowledge_dependencies(owner_id,owner_version,space_id,entry_path,layer,purpose,role,effective,target_kind,target_id,target_revision,target_path,target_fingerprint) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
            .bind(&row.owner_id)
            .bind(row.owner_version)
            .bind(&ctx.space_id)
            .bind(&row.entry_path)
            .bind(&row.layer)
            .bind(&row.purpose)
            .bind(&row.role)
            .bind(row.effective)
            .bind(&row.target_kind)
            .bind(&row.target_id)
            .bind(row.target_revision)
            .bind(&row.target_path)
            .bind(&row.target_fingerprint)
            .execute(tx.connection())
            .await?;
    }
    sqlx::query("INSERT INTO knowledge_dependency_states(owner_id,owner_version,space_id,mapping_state) VALUES(?,?,?,?)")
        .bind(owner_id)
        .bind(version)
        .bind(&ctx.space_id)
        .bind(if indexed.complete {
            "complete"
        } else {
            "unknown"
        })
        .execute(tx.connection())
        .await?;
    Ok(())
}

// 反向依赖查询：按目标身份分页返回依赖者引用，不装配对象正文。
// limit 是每页(owner,version)对数上限：同一owner可有大量版本行，只按owner推进会跳过
// 其余版本；同一对又可有多行指向同一目标（不同entry_path/role），按行分页会把并列行
// 截断在页界后整组跳过。先按对取页、再整批取回页内对的全部行，两类丢失都结构性排除。
pub struct Dependent {
    pub owner_id: String,
    pub owner_version: u64,
    pub entry_path: String,
    pub layer: String,
    pub purpose: String,
    pub role: String,
    pub effective: bool,
}

pub async fn dependents_in_tx(
    tx: &mut AppTx<'_>,
    space: &str,
    kind: &str,
    id: &str,
    after: Option<(&str, u64)>,
    limit: u64,
) -> Result<Vec<Dependent>> {
    if !(1..=200).contains(&limit) {
        return Err(Error::new("invalid_input"));
    }
    let (cursor_owner, cursor_version, condition) = match after {
        Some((owner, version)) => (
            owner.to_owned(),
            version,
            "AND (owner_id,owner_version)>(?,?)",
        ),
        None => (String::new(), 0, ""),
    };
    let mut pair_query = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT DISTINCT owner_id,owner_version FROM knowledge_dependencies WHERE space_id=? AND target_kind=? AND target_id=? {condition} ORDER BY owner_id,owner_version LIMIT ?"
    )))
    .bind(space)
    .bind(kind)
    .bind(id);
    if after.is_some() {
        pair_query = pair_query.bind(&cursor_owner).bind(cursor_version);
    }
    let pairs: Vec<(String, u64)> = pair_query
        .bind(limit)
        .fetch_all(tx.connection())
        .await?
        .iter()
        .map(|row| {
            (
                row.get::<String, _>("owner_id"),
                row.get::<u64, _>("owner_version"),
            )
        })
        .collect();
    if pairs.is_empty() {
        return Ok(Vec::new());
    }
    // 对集合已按目标筛过，但同一对还会登记指向其他目标的行，取行时保留目标过滤。
    let tuple_list = placeholders(pairs.len(), 2);
    let mut row_query = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT owner_id,owner_version,entry_path,layer,purpose,role,effective FROM knowledge_dependencies WHERE space_id=? AND target_kind=? AND target_id=? AND (owner_id,owner_version) IN ({tuple_list}) ORDER BY owner_id,owner_version,entry_path,layer,purpose,role"
    )))
    .bind(space)
    .bind(kind)
    .bind(id);
    for (owner, version) in &pairs {
        row_query = row_query.bind(owner).bind(*version);
    }
    let rows = row_query.fetch_all(tx.connection()).await?;
    Ok(rows
        .iter()
        .map(|row| Dependent {
            owner_id: row.get("owner_id"),
            owner_version: row.get("owner_version"),
            entry_path: row.get("entry_path"),
            layer: row.get("layer"),
            purpose: row.get("purpose"),
            role: row.get("role"),
            effective: row.get("effective"),
        })
        .collect())
}

// 有效必要依赖：按(owner,version)批量读取，供传递核验立即发现依据变化。
// 游走会被持锁事务（交付前重核等）调用，这里保持单次往返，不逐owner展开。
pub async fn effective_required_in_tx(
    tx: &mut AppTx<'_>,
    owners: &[(String, u64)],
) -> Result<Vec<DependencyRow>> {
    effective_dependencies_in_tx(tx, owners, Some("required")).await
}

// 有效依赖批量读取；purpose为None时读全部用途（实际贡献根不能只取required）。
// 用途值是内部常量，不拼调用方输入。
async fn effective_dependencies_in_tx(
    tx: &mut AppTx<'_>,
    owners: &[(String, u64)],
    purpose: Option<&str>,
) -> Result<Vec<DependencyRow>> {
    if owners.is_empty() {
        return Ok(Vec::new());
    }
    if owners.len() > 200 {
        return Err(Error::new("payload_limit"));
    }
    let tuple_list = placeholders(owners.len(), 2);
    let purpose_filter = purpose
        .map(|value| format!(" AND purpose='{value}'"))
        .unwrap_or_default();
    let mut query = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT owner_id,owner_version,entry_path,layer,purpose,role,target_kind,target_id,target_revision,target_path,target_fingerprint FROM knowledge_dependencies WHERE (owner_id,owner_version) IN ({tuple_list}) AND effective{purpose_filter}"
    )));
    for (owner, version) in owners {
        query = query.bind(owner).bind(version);
    }
    let fetched = query.fetch_all(tx.connection()).await?;
    Ok(fetched
        .iter()
        .map(|row| DependencyRow {
            owner_id: row.get("owner_id"),
            owner_version: row.get("owner_version"),
            entry_path: row.get("entry_path"),
            layer: row.get("layer"),
            purpose: row.get("purpose"),
            role: row.get("role"),
            effective: true,
            target_kind: row.get("target_kind"),
            target_id: row.get("target_id"),
            target_revision: row.get("target_revision"),
            target_path: row.get("target_path"),
            target_fingerprint: row
                .get::<Option<String>, _>("target_fingerprint")
                .unwrap_or_default(),
        })
        .collect())
}

// 传递核验结论：stale=已变化的依据（登记修订与当前修订不符，来源消失时当前修订为空），
// unknown=无法证明的链路成员（无映射状态的对象版本，不得当作已知无依赖）。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct StaleDependency {
    pub owner_id: String,
    pub entry_path: String,
    pub target_kind: String,
    pub target_id: String,
    pub registered_revision: u64,
    pub current_revision: Option<u64>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DependencyVerdict {
    pub stale: Vec<StaleDependency>,
    pub unknown: Vec<(String, u64)>,
}

// 多列占位符逐元组自带括号，调用方统一 IN ({list}) 只包外层：单项若不带内层括号，
// (a,b) IN (?,?) 会被MySQL当作两标量列表，报"Operand should contain 2 column(s)"。
fn placeholders(items: usize, columns: usize) -> String {
    if columns == 1 {
        return vec!["?"; items].join(",");
    }
    std::iter::repeat_n(format!("({})", vec!["?"; columns].join(",")), items)
        .collect::<Vec<_>>()
        .join(",")
}

// 单个(owner,version)的映射是否完备；缺行或unknown都返回false，读取侧不得猜。
pub async fn mapping_complete_in_tx(tx: &mut AppTx<'_>, owner: &(String, u64)) -> Result<bool> {
    let state: Option<String> =
        sqlx::query("SELECT mapping_state FROM knowledge_dependency_states WHERE owner_id=? AND owner_version=?")
            .bind(&owner.0)
            .bind(owner.1)
            .fetch_optional(tx.connection())
            .await?
            .map(|row| row.get("mapping_state"));
    Ok(state.as_deref() == Some("complete"))
}

// 批量查映射状态，返回状态为complete的(owner,version)集合；缺行或unknown不在集合内。
// 占位符列表只拼"?"，成员身份全部走绑定参数。
pub async fn complete_members_in_tx(
    tx: &mut AppTx<'_>,
    chunk: &[(String, u64)],
) -> Result<HashSet<(String, u64)>> {
    let tuple_list = placeholders(chunk.len(), 2);
    let mut query = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT owner_id,owner_version,mapping_state FROM knowledge_dependency_states WHERE (owner_id,owner_version) IN ({tuple_list})"
    )));
    for (owner, version) in chunk {
        query = query.bind(owner).bind(version);
    }
    Ok(query
        .fetch_all(tx.connection())
        .await?
        .iter()
        .filter(|row| row.get::<String, _>("mapping_state") == "complete")
        .map(|row| {
            (
                row.get::<String, _>("owner_id"),
                row.get::<u64, _>("owner_version"),
            )
        })
        .collect())
}

// 当前目标正文：平台来源取source_current，对象目标取enabled当前版。只在修订
// 不匹配且行带指纹时按需读取并缓存，避免干净路径搬运大正文。
async fn current_body_in_tx(
    tx: &mut AppTx<'_>,
    space: &str,
    kind: &str,
    id: &str,
    cache: &mut HashMap<(String, String), Option<Value>>,
) -> Result<Option<Value>> {
    if let Some(cached) = cache.get(&(kind.to_owned(), id.to_owned())) {
        return Ok(cached.clone());
    }
    let body = if kind == "platform" {
        sqlx::query_scalar::<_, String>(
            "SELECT body FROM source_current WHERE space_id=? AND source_id=?",
        )
        .bind(space)
        .bind(id)
        .fetch_optional(tx.connection())
        .await?
        .map(Value::String)
    } else {
        sqlx::query_scalar::<_, sqlx::types::Json<Value>>(
            "SELECT body FROM knowledge_objects WHERE state='enabled' AND id=?",
        )
        .bind(id)
        .fetch_optional(tx.connection())
        .await?
        .map(|body| body.0)
    };
    cache.insert((kind.to_owned(), id.to_owned()), body.clone());
    Ok(body)
}

// 有效必要依赖的传递游走：从根对象出发逐层批量读索引；来源类目标（platform/document）
// 与当前修订核对即止，知识类目标核对当前版本后继续下钻。A→B→S中S变化在本次调用内
// 立即可见，不等扇出作业更新B；已见(owner,version)不重复展开，环不会无限递归。
pub async fn walk_required_in_tx(
    tx: &mut AppTx<'_>,
    space: &str,
    roots: &[(String, u64)],
) -> Result<DependencyVerdict> {
    if roots.len() > 200 {
        return Err(Error::new("payload_limit"));
    }
    let mut verdict = DependencyVerdict::default();
    let mut visited: HashSet<(String, u64)> = roots.iter().cloned().collect();
    let mut bodies: HashMap<(String, String), Option<Value>> = HashMap::new();
    let mut frontier: Vec<(String, u64)> = roots.to_vec();
    while !frontier.is_empty() {
        let mut mapped: Vec<(String, u64)> = Vec::new();
        for chunk in frontier.chunks(200) {
            let known = complete_members_in_tx(tx, chunk).await?;
            for owner in chunk {
                if known.contains(owner) {
                    mapped.push(owner.clone());
                } else {
                    // 无状态行或unknown：链路无法证明，不得当作已知无依赖。
                    verdict.unknown.push(owner.clone());
                }
            }
        }
        let mut rows = Vec::new();
        for chunk in mapped.chunks(200) {
            rows.extend(effective_required_in_tx(tx, chunk).await?);
        }
        let mut platform_ids = Vec::new();
        let mut object_ids = Vec::new();
        for row in &rows {
            match row.target_kind.as_str() {
                "platform" => platform_ids.push(row.target_id.clone()),
                _ => object_ids.push(row.target_id.clone()),
            }
        }
        platform_ids.dedup();
        object_ids.dedup();
        let mut current: std::collections::HashMap<(String, String), Option<u64>> =
            std::collections::HashMap::new();
        for (kind, ids) in [("platform", platform_ids), ("object", object_ids)] {
            for chunk in ids.chunks(200) {
                if chunk.is_empty() {
                    continue;
                }
                let list = placeholders(chunk.len(), 1);
                let sql = if kind == "platform" {
                    format!(
                        "SELECT id,version FROM source_heads WHERE space_id=? AND id IN ({list})"
                    )
                } else {
                    format!(
                        "SELECT id,version FROM knowledge_objects WHERE state='enabled' AND id IN ({list})"
                    )
                };
                let mut query = sqlx::query(sqlx::AssertSqlSafe(sql));
                if kind == "platform" {
                    query = query.bind(space);
                }
                for id in chunk {
                    query = query.bind(id);
                }
                for record in query.fetch_all(tx.connection()).await? {
                    current.insert(
                        (kind.to_owned(), record.get::<String, _>("id")),
                        Some(record.get::<u64, _>("version")),
                    );
                }
            }
        }
        let mut next: Vec<(String, u64)> = Vec::new();
        for row in rows {
            if row.target_id == row.owner_id {
                // 文档派生陈述引用自身文档是常态；自引不构成外部依据，同对象
                // 新旧修订由修订读取规则处理，否则文档改版后的重整理读取会永久失效。
                continue;
            }
            let kind = if row.target_kind == "platform" {
                "platform"
            } else {
                "object"
            };
            let live = current
                .get(&(kind.to_owned(), row.target_id.clone()))
                .cloned()
                .flatten();
            match live {
                Some(revision) if revision == row.target_revision => {
                    // 知识目标版本未变则继续下钻；来源目标（platform/document）核对即止。
                    if row.target_kind == "knowledge"
                        && visited.insert((row.target_id.clone(), row.target_revision))
                    {
                        next.push((row.target_id.clone(), row.target_revision));
                    }
                }
                live => {
                    // 修订推进时比相关内容指纹：逐字节相同（纯观测/元数据改版）不算
                    // 失效也不下钻，不让仅有修订号变化代替内容比较；指纹缺失或当前
                    // 正文读不到时按保守失效。
                    if !row.target_fingerprint.is_empty()
                        && let Some(body) =
                            current_body_in_tx(tx, space, kind, &row.target_id, &mut bodies).await?
                        && content_fingerprint(&row.target_kind, &body, &row.target_path)
                            == row.target_fingerprint
                    {
                        continue;
                    }
                    verdict.stale.push(StaleDependency {
                        owner_id: row.owner_id,
                        entry_path: row.entry_path,
                        target_kind: row.target_kind,
                        target_id: row.target_id,
                        registered_revision: row.target_revision,
                        current_revision: live,
                    });
                }
            }
        }
        frontier = next;
    }
    Ok(verdict)
}

// 实际贡献根：根对象有效内容实际依赖的来源身份闭包，供权限/模型端点/用户明确
// 来源限制核验（组合层构造允许集后由其判定）。与失效游走的差别：贡献是按登记
// 修订的历史事实——来源身份不因后来改版或扇出滞后消失，也不与当前修订核对；
// 文档派生陈述引用自身文档即以该文档为根（A原文以A为来源）；人工替换后的旧
// source标签在非有效层，不进入闭包。任何用途的有效行都计入，不能只取required。
pub struct ContributionRoots {
    pub owner_id: String,
    pub owner_version: u64,
    // (kind,id)去重升序，kind∈platform|document，与SourceKey身份一致。
    pub sources: Vec<(String, String)>,
    // 闭包经停的不可证明成员（无状态行或unknown）。非空时闭包不完整，sources只是
    // 已知部分，调用方必须按不通过处理，不得当空集合或已核验放行。
    pub unknown: Vec<(String, u64)>,
}

pub async fn contribution_roots_in_tx(
    tx: &mut AppTx<'_>,
    roots: &[(String, u64)],
) -> Result<Vec<ContributionRoots>> {
    if roots.is_empty() {
        return Ok(Vec::new());
    }
    if roots.len() > 200 {
        return Err(Error::new("payload_limit"));
    }
    // 先按(owner,version)节点批量展开整图：mapped节点带有效行，unknown节点无行可读。
    let mut sources_by_node: std::collections::HashMap<(String, u64), Vec<(String, String)>> =
        std::collections::HashMap::new();
    let mut edges: std::collections::HashMap<(String, u64), Vec<(String, u64)>> =
        std::collections::HashMap::new();
    let mut unknown_nodes: HashSet<(String, u64)> = HashSet::new();
    let mut visited: HashSet<(String, u64)> = roots.iter().cloned().collect();
    let mut frontier: Vec<(String, u64)> = roots.to_vec();
    while !frontier.is_empty() {
        let mut mapped: Vec<(String, u64)> = Vec::new();
        for chunk in frontier.chunks(200) {
            let complete = complete_members_in_tx(tx, chunk).await?;
            for node in chunk {
                if complete.contains(node) {
                    mapped.push(node.clone());
                } else {
                    unknown_nodes.insert(node.clone());
                }
            }
        }
        let mut rows = Vec::new();
        for chunk in mapped.chunks(200) {
            rows.extend(effective_dependencies_in_tx(tx, chunk, None).await?);
        }
        let mut next: Vec<(String, u64)> = Vec::new();
        for row in rows {
            let node = (row.owner_id.clone(), row.owner_version);
            match row.target_kind.as_str() {
                // 知识支持按登记修订下钻（历史贡献事实），自指支持不构成外部贡献。
                "knowledge" => {
                    let target = (row.target_id.clone(), row.target_revision);
                    if target != node {
                        edges.entry(node).or_default().push(target);
                    }
                }
                // 来源类目标即贡献根；自引文档（文档派生陈述引用自身）同样是根。
                "platform" | "document" => {
                    sources_by_node
                        .entry(node)
                        .or_default()
                        .push((row.target_kind.clone(), row.target_id.clone()));
                }
                _ => {}
            }
        }
        for target in edges.values().flatten() {
            if visited.insert(target.clone()) {
                next.push(target.clone());
            }
        }
        next.sort();
        next.dedup();
        frontier = next;
    }
    // 逐根在内存图上取闭包，批量根一次查询摊平图展开；经停unknown即中断该路径并记录。
    let mut results = Vec::new();
    for root in roots {
        let (mut sources, mut unknown) = (HashSet::new(), Vec::new());
        let mut seen: HashSet<(String, u64)> = HashSet::from([root.clone()]);
        let mut queue = VecDeque::from([root.clone()]);
        while let Some(node) = queue.pop_front() {
            if unknown_nodes.contains(&node) {
                unknown.push(node);
                continue;
            }
            for source in sources_by_node.get(&node).into_iter().flatten() {
                sources.insert(source.clone());
            }
            for target in edges.get(&node).into_iter().flatten() {
                if seen.insert(target.clone()) {
                    queue.push_back(target.clone());
                }
            }
        }
        unknown.sort();
        unknown.dedup();
        let mut list = sources.into_iter().collect::<Vec<_>>();
        list.sort();
        list.dedup();
        results.push(ContributionRoots {
            owner_id: root.0.clone(),
            owner_version: root.1,
            sources: list,
            unknown,
        });
    }
    Ok(results)
}
