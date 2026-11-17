use crate::{
    modules::{analysis, assets, conversations, knowledge, queries, runtime},
    persistence::AppTx,
    types::{AccessContext, Error, Result, epoch},
};
use serde_json::{Value, json};
use sqlx::MySqlPool;

pub fn empty() -> Value {
    json!({"dependency_schema":6,"sources":[],"knowledge":[],"knowledge_entries":[],"memories":[],"skills":[],"query_results":[],"source_skills":[],"source_query_results":[],"historical_analyses":[]})
}

pub(super) fn has_no_sources(authority: &Value) -> bool {
    let mut sources = empty();
    merge(&mut sources, authority).is_ok() && sources == empty()
}

/// 按文本自己的来源核验；当前条件移除引用不能使旧目标、开放问题脱离权限约束。
pub async fn protect_task_context_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    cid: &str,
    task: &mut Value,
    checked_results: &CheckedTextResults,
    projection: Option<&super::source_limits::ActiveProjection>,
) -> Result<Value> {
    let has_goal = task["goal"].is_string();
    let has_questions = task["clarification"].is_object()
        || task["opened_clarification"].is_object()
        || task["opened_clarifications"]
            .as_array()
            .is_some_and(|items| !items.is_empty())
        || task["open_clarifications"]
            .as_array()
            .is_some_and(|items| !items.is_empty());
    let has_conditions = task["conditions"].is_object();
    if !has_goal && !has_questions && !has_conditions {
        return Ok(empty());
    }
    let task_id = task["id"]
        .as_str()
        .or_else(|| task["task_id"].as_str())
        .ok_or(Error::new("invalid_input"))?
        .to_owned();
    let refs = analysis::task_text_authorities_in_tx(tx, cid, &task_id).await?;
    let mut adopted = empty();
    let mut checks = Vec::new();
    if has_goal {
        checks.push(("goal".to_owned(), refs["goal"].clone()));
    }
    let mut questions = Vec::<String>::new();
    for key in ["clarification", "opened_clarification"] {
        if let Some(id) = task[key]["id"].as_str()
            && !questions.iter().any(|existing| existing == id)
        {
            questions.push(id.to_owned());
        }
    }
    for key in ["open_clarifications", "opened_clarifications"] {
        for question in task[key].as_array().into_iter().flatten() {
            if let Some(id) = question["id"].as_str()
                && !questions.iter().any(|existing| existing == id)
            {
                questions.push(id.to_owned());
            }
        }
    }
    for id in questions {
        checks.push((id.clone(), refs["clarifications"][&id].clone()));
    }
    if has_conditions {
        let version = epoch(
            task["condition_version"]
                .as_str()
                .ok_or(Error::new("invalid_input"))?,
        )?;
        let fields = analysis::condition_text_authorities_in_tx(tx, cid, &task_id, version).await?;
        for key in task["conditions"].as_object().expect("conditions").keys() {
            checks.push((format!("condition:{key}"), fields[key].clone()));
        }
    }
    for (kind, references) in checks {
        let readable = async {
            validate_text_in_tx(tx, ctx, cid, &references, checked_results).await?;
            if projection.is_some_and(|scope| !scope.scope_known) && !has_no_sources(&references) {
                return Err(Error::new("source_not_allowed"));
            }
            if let Some(gate) = projection.and_then(|scope| scope.gate.as_ref())
                && !super::source_limits::authority_within_in_tx(tx, ctx, gate, &references).await?
            {
                return Err(Error::new("source_not_allowed"));
            }
            Ok(())
        }
        .await;
        match readable {
            Ok(()) => merge(&mut adopted, &references)?,
            Err(error)
                if matches!(
                    error.code,
                    "stale_context"
                        | "stale_knowledge"
                        | "not_available"
                        | "forbidden"
                        | "invalid_input"
                        | "source_not_allowed"
                ) =>
            {
                if kind == "goal" {
                    task.as_object_mut().expect("task snapshot").remove("goal");
                } else if let Some(field) = kind.strip_prefix("condition:") {
                    task["conditions"]
                        .as_object_mut()
                        .expect("conditions")
                        .remove(field);
                    if task.get("unavailable_condition_fields").is_none() {
                        task["unavailable_condition_fields"] = json!([]);
                    }
                    task["unavailable_condition_fields"]
                        .as_array_mut()
                        .expect("field array")
                        .push(json!(field));
                    task["context_complete"] = json!(false);
                    if field == "semantic_resolution"
                        && let Some(items) = task
                            .get_mut("legacy_pending")
                            .and_then(|pending| pending.get_mut("items"))
                            .and_then(Value::as_array_mut)
                    {
                        for item in items {
                            item.as_object_mut()
                                .expect("legacy pending item")
                                .remove("text");
                            item["text_unavailable"] = json!(true);
                        }
                    }
                } else {
                    for key in ["clarification", "opened_clarification"] {
                        if task[key]["id"] == kind {
                            task.as_object_mut().expect("task snapshot").remove(key);
                        }
                    }
                    for key in ["open_clarifications", "opened_clarifications"] {
                        if let Some(questions) = task[key].as_array_mut() {
                            questions.retain(|question| question["id"] != kind);
                        }
                    }
                    if task.get("unavailable_clarification_ids").is_none() {
                        task["unavailable_clarification_ids"] = json!([]);
                    }
                    task["unavailable_clarification_ids"]
                        .as_array_mut()
                        .expect("id array")
                        .push(json!(kind));
                }
                // 顶层兼容问题没有独立 ID，不能绕过逐题投影。
                task.as_object_mut()
                    .expect("task snapshot")
                    .remove("question");
                task.as_object_mut()
                    .expect("task snapshot")
                    .remove("options");
                task["text_unavailable"] = json!(true);
                task["note"] = json!(
                    "部分目标、问题或条件正文当前未交付，可能因目录只含控制信息，或来源范围、权限、版本、完整性限制；省略本身不等于失效。其他合法字段可读，条件版本、问题身份与等待状态保留，未回答不能默认采用。来源就绪后用read_analysis_task核对正文；仍不可用时说明缺口，不能从旧历史补回隐藏内容。"
                );
            }
            Err(error) => return Err(error),
        }
    }
    Ok(adopted)
}

pub async fn validate_text_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    cid: &str,
    snapshot: &Value,
    checked_results: &CheckedTextResults,
) -> Result<()> {
    if !checked_results.allows(snapshot) {
        return Err(Error::new("stale_context"));
    }
    validate_in_tx(tx, ctx, cid, snapshot).await
}

/// 完整条件引用（例如报告来源）不能把部分不可用条件伪装成原完整快照。
pub async fn validate_condition_text_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    cid: &str,
    task: &str,
    version: u64,
    conditions: &Value,
    checked_results: &CheckedTextResults,
) -> Result<Value> {
    let fields = analysis::condition_text_authorities_in_tx(tx, cid, task, version).await?;
    let mut adopted = empty();
    for key in conditions
        .as_object()
        .ok_or(Error::new("invalid_input"))?
        .keys()
    {
        validate_text_in_tx(tx, ctx, cid, &fields[key], checked_results).await?;
        merge(&mut adopted, &fields[key])?;
    }
    Ok(adopted)
}

/// 复用同一种 authority；正文传播时传递完整依赖，不能只恢复 knowledge_refs。
/// 合并是写路径：结果统一升级为格式6；格式5旧快照缺历史桶按空解码，不追加
/// required，恢复不因格式迁移失败。
pub fn merge(snapshot: &mut Value, dependencies: &Value) -> Result<()> {
    if !complete(snapshot) || !complete(dependencies) {
        return Err(Error::new("stale_context"));
    }
    for kind in [
        "knowledge",
        "memories",
        "skills",
        "sources",
        "query_results",
        "source_skills",
        "source_query_results",
    ] {
        for reference in dependencies[kind].as_array().expect("complete") {
            if kind == "knowledge" {
                let scopes: Vec<_> = dependencies["knowledge_entries"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|r| r[0] == reference[0] && r[1] == reference[1])
                    .collect();
                if scopes.is_empty() {
                    add_knowledge(snapshot, &reference[0], &reference[1], None);
                } else {
                    for scope in scopes {
                        add_knowledge(snapshot, &reference[0], &reference[1], scope[2].as_str());
                    }
                }
            } else {
                add(snapshot, kind, &reference[0], &reference[1]);
            }
        }
    }
    for entry in dependencies["historical_analyses"]
        .as_array()
        .into_iter()
        .flatten()
    {
        if snapshot["historical_analyses"].as_array().is_none() {
            snapshot["historical_analyses"] = json!([]);
        }
        let entries = snapshot["historical_analyses"]
            .as_array_mut()
            .expect("bucket just ensured");
        if !entries.contains(entry) {
            entries.push(entry.clone());
        }
    }
    // 升级到格式6即显式携带历史桶：未使用也是空数组，不再出现缺桶的6。
    if snapshot["historical_analyses"].as_array().is_none() {
        snapshot["historical_analyses"] = json!([]);
    }
    snapshot["dependency_schema"] = json!(6);
    Ok(())
}

/// 历史派生保留去重后的实际来源，不把前代分析投影递归复制到新投影中。
/// 历史正文的身份与内容指纹由其自身记录核验，来源闭包只负责当前访问边界。
pub(super) fn historical_sources(snapshot: &Value) -> Result<Value> {
    let mut result = empty();
    let mut pending = vec![snapshot.clone()];
    while let Some(mut sources) = pending.pop() {
        if !complete(&sources) {
            return Err(Error::new("stale_context"));
        }
        for entry in sources["historical_analyses"]
            .as_array()
            .into_iter()
            .flatten()
        {
            pending.push(entry["actual_sources"]["authority"].clone());
            observe(&mut result, &entry["actual_sources"]["knowledge_refs"]);
            for reference in entry["actual_sources"]["result_dependencies"]
                .as_array()
                .into_iter()
                .flatten()
            {
                add(
                    &mut result,
                    "source_query_results",
                    &reference["query_id"],
                    &reference["result_ref"],
                );
            }
        }
        sources["historical_analyses"] = json!([]);
        merge(&mut result, &sources)?;
    }
    Ok(result)
}

fn historical_result_references(snapshot: &Value) -> Value {
    let Ok(sources) = historical_sources(snapshot) else {
        return json!([]);
    };
    let mut references = result_references(&sources);
    for reference in references.as_array_mut().expect("references") {
        reference[2] = json!("history_display");
    }
    references
}

fn covers(snapshot: &Value, sources: &Value) -> bool {
    complete(snapshot)
        && complete(sources)
        && [
            "knowledge",
            "memories",
            "skills",
            "sources",
            "query_results",
            "source_skills",
            "source_query_results",
        ]
        .iter()
        .all(|kind| {
            sources[*kind]
                .as_array()
                .expect("complete")
                .iter()
                .all(|reference| {
                    snapshot[*kind]
                        .as_array()
                        .expect("complete")
                        .contains(reference)
                })
        })
}

/// 只展开最终实际交付的资产，裁掉的目录项不进入后续上下文依赖。
pub async fn asset_text_dependencies_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    cid: &str,
    data: &Value,
    checked: &CheckedTextResults,
) -> Result<Value> {
    fn collect(data: &Value, references: &mut Vec<Value>) {
        if matches!(data["kind"].as_str(), Some("memory" | "skill"))
            && data["state"] != "disabled"
            && data["state"] != "deleted"
            && data["text_unavailable"] != true
        {
            let reference = json!([data["id"], data["version"]]);
            if data["id"].is_string()
                && data["version"].is_string()
                && !references.contains(&reference)
            {
                references.push(reference);
            }
        }
        match data {
            Value::Object(values) => {
                for value in values.values() {
                    collect(value, references);
                }
            }
            Value::Array(values) => {
                for value in values {
                    collect(value, references);
                }
            }
            _ => (),
        }
    }
    let mut references = Vec::new();
    collect(data, &mut references);
    let mut authority = empty();
    for reference in references {
        let asset = assets::read_in_tx(tx, ctx, reference[0].as_str().expect("id"), true).await?;
        if asset["version"] != reference[1] {
            return Err(Error::new("stale_context"));
        }
        let source =
            super::personal_assets::text_authority_in_tx(tx, ctx, cid, &asset, checked).await?;
        merge(&mut authority, &source)?;
    }
    Ok(authority)
}

pub async fn check_available_asset_results(
    pool: &MySqlPool,
    ctx: &AccessContext,
    cid: &str,
) -> Result<CheckedTextResults> {
    let mut tx = AppTx::begin(pool).await?;
    let mut items = assets::list_in_tx(&mut tx, ctx, true)
        .await?
        .into_iter()
        .filter(|asset| asset["kind"] == "memory")
        .collect::<Vec<_>>();
    items.extend(assets::selected_in_tx(&mut tx, ctx, cid).await?);
    tx.commit().await?;
    super::personal_assets::checked_assets(pool, ctx, &items).await
}

/// 持久正文继承来源权限，不代表目标会话再次选用上游 Skill 或取得查询执行权。
pub fn to_persisted(snapshot: &Value) -> Result<Value> {
    if !complete(snapshot) {
        return Err(Error::new("stale_context"));
    }
    let mut persisted = snapshot.clone();
    for (direct, source) in [
        ("skills", "source_skills"),
        ("query_results", "source_query_results"),
    ] {
        for reference in snapshot[direct].as_array().expect("complete") {
            add(&mut persisted, source, &reference[0], &reference[1]);
        }
        persisted[direct] = json!([]);
    }
    Ok(persisted)
}

fn result_references(snapshot: &Value) -> Value {
    let mut references = Vec::new();
    for kind in ["query_results", "source_query_results"] {
        for pair in snapshot[kind].as_array().into_iter().flatten() {
            let reference = json!([pair[0], pair[1], "current_use"]);
            if !references.contains(&reference) {
                references.push(reference);
            }
        }
    }
    for entry in snapshot["historical_analyses"]
        .as_array()
        .into_iter()
        .flatten()
    {
        for dependency in entry["actual_sources"]["result_dependencies"]
            .as_array()
            .into_iter()
            .flatten()
        {
            let reference = json!([
                dependency["query_id"],
                dependency["result_ref"],
                "history_display"
            ]);
            if !references.contains(&reference) {
                references.push(reference);
            }
        }
    }
    json!(references)
}

async fn result_accessible(
    pool: &MySqlPool,
    ctx: &AccessContext,
    reference: &Value,
) -> Result<bool> {
    let query = reference[0].as_str().ok_or(Error::new("stale_context"))?;
    let result_ref = reference[1].as_str().ok_or(Error::new("stale_context"))?;
    let result = if reference[2] == "history_display" {
        super::query_workflow::historical_result_authority(pool, ctx, query, result_ref).await
    } else {
        super::query_workflow::result_state_authority(pool, ctx, query, result_ref).await
    };
    match result {
        Ok(()) => Ok(true),
        Err(error)
            if matches!(
                error.code,
                "result_expired"
                    | "result_unavailable"
                    | "forbidden"
                    | "not_available"
                    | "stale_knowledge"
                    | "stale_context"
                    | "invalid_evidence"
            ) =>
        {
            Ok(false)
        }
        Err(error) => Err(error),
    }
}

pub async fn merge_run_in_tx(tx: &mut AppTx<'_>, run: &str, dependencies: &Value) -> Result<()> {
    if let Some(mut snapshot) = runtime::read_authority_in_tx(tx, run).await? {
        merge(&mut snapshot, dependencies)?;
        runtime::save_authority_in_tx(tx, run, &snapshot).await?;
    }
    Ok(())
}

/// 写入正文采用宿主已交付清单；模型遗漏引用不能使生成文本脱离来源约束。
pub async fn generated_text_authority_in_tx(
    tx: &mut AppTx<'_>,
    run: &str,
    input: &Value,
) -> Result<Value> {
    let mut snapshot = runtime::read_authority_in_tx(tx, run)
        .await?
        .ok_or(Error::new("stale_context"))?;
    if !complete(&snapshot) {
        return Err(Error::new("stale_context"));
    }
    observe(&mut snapshot, input);
    snapshot
        .as_object_mut()
        .expect("authority")
        .remove("checkpoint_reset_required");
    to_persisted(&snapshot)
}

#[derive(Default)]
pub struct CheckedTextResults {
    results: Vec<(Value, bool)>,
}
impl CheckedTextResults {
    pub fn include_checked(&mut self, other: &Self) {
        for item in &other.results {
            if !self.results.contains(item) {
                self.results.push(item.clone());
            }
        }
    }
    pub async fn include_authorities(
        &mut self,
        pool: &MySqlPool,
        ctx: &AccessContext,
        authorities: &[Value],
    ) -> Result<()> {
        for authority in authorities {
            for reference in result_references(authority)
                .as_array()
                .into_iter()
                .flatten()
            {
                if self.results.iter().any(|(known, _)| known == reference) {
                    continue;
                }
                let accessible = result_accessible(pool, ctx, reference).await?;
                self.results.push((reference.clone(), accessible));
            }
        }
        Ok(())
    }
    pub async fn include_history(
        &mut self,
        pool: &MySqlPool,
        ctx: &AccessContext,
        authorities: &[Value],
    ) -> Result<()> {
        for authority in authorities {
            for reference in historical_result_references(authority)
                .as_array()
                .into_iter()
                .flatten()
            {
                if !self.results.iter().any(|(known, _)| known == reference) {
                    let accessible = result_accessible(pool, ctx, reference).await?;
                    self.results.push((reference.clone(), accessible));
                }
            }
        }
        Ok(())
    }
    pub(super) fn allows_history(&self, snapshot: &Value) -> bool {
        historical_sources(snapshot).is_ok()
            && historical_result_references(snapshot)
                .as_array()
                .expect("references")
                .iter()
                .all(|reference| {
                    self.results
                        .iter()
                        .any(|(known, valid)| *valid && known == reference)
                })
    }
    pub fn include_run(&mut self, checked: &CheckedResults) {
        if !checked.invalidated {
            for reference in checked.references.as_array().into_iter().flatten() {
                if !self
                    .results
                    .iter()
                    .any(|(known, valid)| *valid && known == reference)
                {
                    self.results.push((reference.clone(), true));
                }
            }
        }
    }
    pub(super) fn allows(&self, snapshot: &Value) -> bool {
        complete(snapshot)
            && result_references(snapshot)
                .as_array()
                .expect("result refs")
                .iter()
                .all(|reference| {
                    self.results
                        .iter()
                        .any(|(checked, valid)| *valid && checked == reference)
                })
    }
}

/// 平台权限在事务外查证；使用正文时逐对比对引用，新出现或未检查的结果不能进入正文。
pub async fn check_task_text_results(
    pool: &MySqlPool,
    ctx: &AccessContext,
    cid: &str,
    run_results: Option<&CheckedResults>,
) -> Result<CheckedTextResults> {
    let mut tx = AppTx::begin(pool).await?;
    let references = analysis::task_text_result_dependencies_in_tx(&mut tx, cid).await?;
    tx.commit().await?;
    let mut checked = CheckedTextResults {
        results: Vec::new(),
    };
    if let Some(run) = run_results.filter(|run| !run.invalidated) {
        checked.results.extend(
            run.references
                .as_array()
                .into_iter()
                .flatten()
                .map(|reference| (reference.clone(), true)),
        );
    }
    let mut snapshot = empty();
    snapshot["query_results"] = references;
    checked.include_authorities(pool, ctx, &[snapshot]).await?;
    Ok(checked)
}

fn add(snapshot: &mut Value, kind: &str, id: &Value, version: &Value) {
    if !id.is_string() || !version.is_string() {
        return;
    }
    let entry = json!([id, version]);
    let entries = snapshot[kind].as_array_mut().expect("validated authority");
    if !entries.contains(&entry) {
        entries.push(entry);
    }
}

pub(super) fn knowledge_selections(
    snapshot: &Value,
) -> Result<Vec<knowledge::dependency_index::DependencySelection>> {
    let mut selected = Vec::new();
    for pair in snapshot["knowledge"]
        .as_array()
        .expect("validated authority")
    {
        let paths: Vec<_> = snapshot["knowledge_entries"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|entry| entry[0] == pair[0] && entry[1] == pair[1])
            .filter_map(|entry| entry[2].as_str())
            .collect();
        let paths = if paths.is_empty() || paths.contains(&"") {
            vec![""]
        } else {
            paths
        };
        for path in paths {
            selected.push(knowledge::dependency_index::DependencySelection {
                object_id: pair[0].as_str().expect("id").to_owned(),
                version: epoch(pair[1].as_str().expect("version"))?,
                path: path.to_owned(),
            });
        }
    }
    Ok(selected)
}

// 范围随原authority传播；已有旧式整对象引用不能被后续窄读收紧。
fn add_knowledge(snapshot: &mut Value, id: &Value, version: &Value, path: Option<&str>) {
    if !id.is_string() || !version.is_string() {
        return;
    }
    let prior = snapshot["knowledge"]
        .as_array()
        .expect("validated authority")
        .contains(&json!([id, version]));
    if !snapshot["knowledge_entries"].is_array() {
        snapshot["knowledge_entries"] = json!([]);
    }
    let entries = snapshot["knowledge_entries"]
        .as_array_mut()
        .expect("entry scopes");
    let scoped = entries.iter().any(|r| r[0] == *id && r[1] == *version);
    let path = if prior && !scoped {
        ""
    } else {
        path.unwrap_or("")
    };
    let reference = json!([id, version, path]);
    if !entries.contains(&reference) {
        entries.push(reference);
    }
    add(snapshot, "knowledge", id, version);
}

fn add_legacy_search_sources(snapshot: &mut Value, object: &Value) {
    // 文档窗口由知识引用保留版本、path和有效来源；准入沿文档直许或贡献根判定，
    // 不额外要求另一种读取身份。显式陈述引用仍在各自分支登记。
    if object["kind"] != "document" {
        for source in object["required_sources"].as_array().into_iter().flatten() {
            add(snapshot, "sources", &source[0], &source[1]);
        }
    }
}

/// 用原内容单元的映射登记最终搜索回执的依赖，不向 v1 回执添加内部字段。
/// objects 保留每个陈述/窗口；登记支持引用不表示支持正文已经交付。
pub fn search_delivery_dependencies(objects: &[Value], reply: &Value) -> Value {
    let mut snapshot = empty();
    for delivered in reply["hits"].as_array().into_iter().flatten() {
        if delivered["record_kind"] == "source_excerpt" {
            add_search_citation(&mut snapshot, &delivered["citation"]);
            continue;
        }
        let reference = &delivered["ref"];
        add_knowledge(
            &mut snapshot,
            &reference["object_id"],
            &reference["version"],
            reference["path"].as_str(),
        );
        for object in objects.iter().filter(|object| {
            object["id"] == reference["object_id"] && object["version"] == reference["version"]
        }) {
            for entry in object["entries"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|entry| entry["path"] == reference["path"])
            {
                let statement = &entry["statement_content"];
                if !statement.is_object() {
                    add_legacy_search_sources(&mut snapshot, object);
                } else if statement["statement_id"] == delivered["statement_id"] {
                    for citation in statement["citations"].as_array().into_iter().flatten() {
                        add_search_citation(&mut snapshot, citation);
                    }
                    for support in statement["supports"].as_array().into_iter().flatten() {
                        let reference = &support["reference"];
                        match reference["kind"].as_str() {
                            Some("knowledge") => add_knowledge(
                                &mut snapshot,
                                &reference["ref"]["object_id"],
                                &reference["ref"]["version"],
                                reference["ref"]["path"].as_str(),
                            ),
                            Some("source") => {
                                add_search_citation(&mut snapshot, &reference["citation"])
                            }
                            _ => (),
                        }
                    }
                }
            }
        }
    }
    for object in objects {
        for delivered in reply["objects"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|item| item["id"] == object["id"] && item["version"] == object["version"])
        {
            for entry in object["entries"].as_array().into_iter().flatten() {
                let same_entry = |item: &&Value| {
                    item["entry_id"] == entry["entry_id"] && item["path"] == entry["path"]
                };
                let entries = delivered["entries"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(same_entry);
                let excerpts = delivered["retrieval"]["excerpts"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(same_entry);
                let statement = &entry["statement_content"];
                if !statement.is_object() {
                    // legacy 非文档没有更细映射，保留目录项仍登记其必要来源。
                    if entries.count() + excerpts.count() > 0 {
                        add_legacy_search_sources(&mut snapshot, object);
                    }
                    continue;
                }
                let visible = entries
                    .map(|item| (&item["content_page"]["offset"], &item["effective_value"]))
                    .chain(excerpts.map(|item| (&item["offset"], &item["text"])))
                    .any(|(offset, text)| search_window_visible(entry, offset, text));
                if !visible {
                    continue;
                }
                for citation in statement["citations"].as_array().into_iter().flatten() {
                    add_search_citation(&mut snapshot, citation);
                }
                for support in statement["supports"].as_array().into_iter().flatten() {
                    let reference = &support["reference"];
                    match reference["kind"].as_str() {
                        Some("knowledge") => add_knowledge(
                            &mut snapshot,
                            &reference["ref"]["object_id"],
                            &reference["ref"]["version"],
                            reference["ref"]["path"].as_str(),
                        ),
                        Some("source") => {
                            add_search_citation(&mut snapshot, &reference["citation"])
                        }
                        _ => (),
                    }
                }
            }
        }
    }
    snapshot
}

fn search_window_visible(entry: &Value, offset: &Value, text: &Value) -> bool {
    let original = entry["effective_value"].as_str().unwrap_or("");
    let text = text.as_str().unwrap_or("");
    let original_start = entry["content_page"]["offset"].as_u64().unwrap_or(0);
    let delivered_start = offset.as_u64().unwrap_or(0);
    let start = original_start.max(delivered_start);
    let end = (original_start + original.chars().count() as u64)
        .min(delivered_start + text.chars().count() as u64);
    // 文档陈述使用局部坐标；同时核对重叠正文，避免同 entry 的其它陈述误登记。
    start < end
        && original
            .chars()
            .skip((start - original_start) as usize)
            .take((end - start) as usize)
            .eq(text
                .chars()
                .skip((start - delivered_start) as usize)
                .take((end - start) as usize))
}

fn add_search_citation(snapshot: &mut Value, citation: &Value) {
    let Some(id) = citation["source"]["id"].as_str() else {
        return;
    };
    let source_id = if citation["source"]["kind"] == "document" {
        json!(format!("document-{id}"))
    } else {
        json!(id)
    };
    add(snapshot, "sources", &source_id, &citation["revision"]);
}

// 只观察宿主已裁剪、确实交付的结构化资料。字符串中的ID不被当作引用。
// 对同一Pi会话取并集：压缩摘要可能仍包含早先资料，不能因最新页没出现就删掉依赖。
pub fn observe(snapshot: &mut Value, data: &Value) {
    if matches!(
        data["kind"].as_str(),
        Some("knowledge" | "memory" | "skill")
    ) && matches!(data["state"].as_str(), Some("stale" | "not_available"))
    {
        return;
    }
    // 单元格、统计和JSON片段同样已向模型交付结果，压缩后仍需重新鉴权。
    let projected_result = matches!(data["view"].as_str(), Some("rows" | "statistics" | "cell"))
        && crate::contracts::validate("AgentQueryResults", data).is_ok();
    if data["result_ref"].is_string()
        && data["query_id"].is_string()
        && (data["rows"].is_array() || projected_result)
    {
        add(
            snapshot,
            "query_results",
            &data["query_id"],
            &data["result_ref"],
        );
    }
    if data["state"] != "disabled" && data["state"] != "deleted" {
        let kind = match data["kind"].as_str() {
            Some("memory") => Some("memories"),
            Some("skill") => Some("skills"),
            Some(_) if data["entries"].is_array() => Some("knowledge"),
            _ => None,
        };
        if let Some(kind) = kind {
            if kind == "knowledge" {
                if data["entries"].as_array().is_some_and(Vec::is_empty) {
                    add_knowledge(snapshot, &data["id"], &data["version"], None);
                }
                for entry in data["entries"].as_array().into_iter().flatten() {
                    add_knowledge(
                        snapshot,
                        &data["id"],
                        &data["version"],
                        entry["path"].as_str(),
                    );
                }
            } else {
                add(snapshot, kind, &data["id"], &data["version"]);
            }
        }
    }
    if data["current_version"].is_string() {
        add(snapshot, "sources", &data["source_id"], &data["version"]);
    }
    if data["source"].is_object() && data["revision"].is_string() && data["text"].is_string() {
        add_search_citation(snapshot, data);
    }
    if data["source"].is_object() && data["revision"].is_string() && data["locator"].is_object() {
        add_search_citation(snapshot, data);
    }
    if data["path"].is_string() {
        add_knowledge(
            snapshot,
            &data["object_id"],
            &data["version"],
            data["path"].as_str(),
        );
    }
    for reference in knowledge::structure_dependencies(data) {
        add_knowledge(
            snapshot,
            &reference["object_id"],
            &reference["version"],
            reference["path"].as_str(),
        );
    }
    if data["coverage"]["sql_shape"].is_string() {
        for reference in data["checks"]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|check| check["evidence_refs"].as_array().into_iter().flatten())
        {
            add(
                snapshot,
                "knowledge",
                &reference["object_id"],
                &reference["version"],
            );
        }
    }
    match data {
        Value::Object(values) => {
            for (key, value) in values {
                // 历史投影不是当前交付：其引用只证明旧记录来源，不能进入当前
                // 采用桶充当新依据（04切片9）。
                if matches!(
                    key.as_str(),
                    "historical_analysis" | "effective_structure" | "structured_value"
                ) {
                    // 结构引用已由owner返回的实际结构依赖登记，不能再从旧结构说明换回旧表版本。
                    continue;
                }
                if key == "knowledge_refs" {
                    for reference in value.as_array().into_iter().flatten() {
                        add_knowledge(
                            snapshot,
                            &reference["object_id"],
                            &reference["version"],
                            reference["path"].as_str(),
                        );
                    }
                } else {
                    observe(snapshot, value);
                }
            }
        }
        Value::Array(values) => {
            for value in values {
                observe(snapshot, value);
            }
        }
        _ => (),
    }
}

fn historical_entry(entry: &Value) -> bool {
    entry["kind"].is_string()
        && entry["reference"].is_object()
        && entry["generated_at"].is_string()
        && entry["content_fingerprint"].is_string()
        && entry["actual_sources"].is_object()
}

fn complete(snapshot: &Value) -> bool {
    // 未发布试验实现曾移走来源记录；旧检查点沿既有重建路径处理，不猜空依赖。
    if snapshot.get("task_text_provenance").is_some()
        || snapshot.get("delivered_provenance").is_some()
    {
        return false;
    }
    // 格式5按旧形状解码（缺历史桶视为空，不给旧记录追加required造成恢复失败）；
    // 格式6要求显式携带historical_analyses，未使用也带空数组。
    let schema = snapshot["dependency_schema"].as_u64();
    if schema != Some(5) && schema != Some(6) {
        return false;
    }
    let buckets_ok = [
        "knowledge",
        "memories",
        "skills",
        "sources",
        "query_results",
        "source_skills",
        "source_query_results",
    ]
    .iter()
    .all(|kind| {
        snapshot[*kind].as_array().is_some_and(|items| {
            items.iter().all(|item| {
                item.as_array().is_some_and(|pair| {
                    pair.len() == 2 && pair[0].is_string() && pair[1].is_string()
                })
            })
        })
    });
    let entries_ok = snapshot.get("knowledge_entries").is_none_or(|entries| {
        entries.as_array().is_some_and(|entries| {
            entries.iter().all(|entry| {
                entry
                    .as_array()
                    .is_some_and(|parts| parts.len() == 3 && parts.iter().all(Value::is_string))
            })
        })
    });
    buckets_ok
        && entries_ok
        && (schema == Some(5)
            || snapshot["historical_analyses"]
                .as_array()
                .is_some_and(|items| items.iter().all(historical_entry)))
}

async fn validate_document_sources_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    documents: &[(knowledge::dependency_index::DependencySelection, Value)],
    snapshot: &Value,
) -> Result<()> {
    let mut sources = std::collections::HashSet::new();
    for chunk in documents.chunks(200) {
        let selections = chunk
            .iter()
            .map(|(selection, _)| selection.clone())
            .collect::<Vec<_>>();
        let roots =
            knowledge::dependency_index::selected_contribution_roots_in_tx(tx, &selections).await?;
        for ((_, object), roots) in chunk.iter().zip(roots) {
            sources.extend(roots.sources.into_iter().map(|(kind, id)| {
                if kind == "document" {
                    format!("document-{id}")
                } else {
                    id
                }
            }));
            if !roots.unknown.is_empty() {
                // 旧成果沿原legacy要求核已知来源，不把未知映射伪装成无依赖。
                sources.extend(
                    super::knowledge_sources::requirements(object)?
                        .into_iter()
                        .map(|(id, _)| id),
                );
            }
        }
    }
    for source in sources {
        if snapshot["sources"]
            .as_array()
            .expect("checked")
            .iter()
            .any(|reference| reference[0].as_str() == Some(source.as_str()))
        {
            continue;
        }
        // 版本/指纹已由所选知识依赖核验；同版本正文也可能变为不完整或缺失，
        // 必须单独回源核元信息，但不能因此向来源许可桶追加新的读取身份。
        let meta = super::knowledge_sources::read_meta_in_tx(tx, ctx, &source, None).await?;
        if meta["complete"] != true {
            return Err(Error::new("stale_context"));
        }
    }
    Ok(())
}

pub async fn validate_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    cid: &str,
    snapshot: &Value,
) -> Result<()> {
    // 旧检查点没有完整采用清单，保守重建；不以空数组假装已验证。
    if !complete(snapshot) {
        return Err(Error::new("stale_context"));
    }
    let paths_for = |reference: &Value| {
        snapshot["knowledge_entries"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|entry| entry[0] == reference[0] && entry[1] == reference[1])
            .filter_map(|entry| entry[2].as_str())
            .collect::<Vec<_>>()
    };
    let ids = snapshot["knowledge"]
        .as_array()
        .expect("checked")
        .iter()
        .filter(|r| {
            let paths = paths_for(r);
            paths.is_empty() || paths.contains(&"")
        })
        .map(|r| r[0].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    let objects = knowledge::source_reference_objects_in_tx(tx, ctx, &ids).await?;
    let mut documents = Vec::new();
    for reference in snapshot["knowledge"].as_array().expect("checked") {
        let paths = paths_for(reference);
        if paths.is_empty() || paths.contains(&"") {
            let object = objects
                .iter()
                .find(|v| v["id"] == reference[0] && v["version"] == reference[1])
                .ok_or(Error::new("stale_context"))?;
            super::knowledge::assert_source_in_tx(tx, ctx, object).await?;
            if object["kind"] == "document" {
                documents.push((
                    knowledge::dependency_index::DependencySelection {
                        object_id: reference[0].as_str().unwrap().to_owned(),
                        version: epoch(reference[1].as_str().unwrap())?,
                        path: String::new(),
                    },
                    object.clone(),
                ));
            }
        } else {
            for path in paths {
                let version = epoch(reference[1].as_str().unwrap())?;
                let object = knowledge::read_selected_structure_in_tx(
                    tx,
                    ctx,
                    reference[0].as_str().unwrap(),
                    version,
                    Some(path),
                )
                .await
                .map_err(|error| match error.code {
                    "not_available" | "stale_knowledge" => Error::new("stale_context"),
                    _ => error,
                })?;
                let path = object["entries"][0]["path"]
                    .as_str()
                    .ok_or(Error::new("stale_context"))?;
                super::knowledge_sources::assert_selected_in_tx(tx, ctx, &object, path).await?;
                if object["kind"] == "document" {
                    documents.push((
                        knowledge::dependency_index::DependencySelection {
                            object_id: reference[0].as_str().unwrap().to_owned(),
                            version,
                            path: path.to_owned(),
                        },
                        object,
                    ));
                }
            }
        }
    }
    validate_document_sources_in_tx(tx, ctx, &documents, snapshot).await?;
    for kind in ["memories", "skills", "source_skills"] {
        let selected = if kind == "skills" {
            assets::selected_in_tx(tx, ctx, cid).await?
        } else {
            vec![]
        };
        for reference in snapshot[kind].as_array().expect("checked") {
            let asset = assets::read_in_tx(tx, ctx, reference[0].as_str().unwrap(), true).await?;
            if asset["version"] != reference[1]
                || (kind == "skills"
                    && !selected
                        .iter()
                        .any(|v| v["id"] == reference[0] && v["version"] == reference[1]))
            {
                return Err(Error::new("stale_context"));
            }
            super::knowledge::check_refs_in_tx(tx, ctx, &asset["dependencies"]).await?;
            // 投影时已展开的私有来源必须仍完整包含在快照中；不递归重造资产编排。
            for source in super::personal_assets::authorities_in_tx(tx, ctx, &asset).await? {
                if !covers(snapshot, &source) {
                    return Err(Error::new("stale_context"));
                }
            }
        }
    }
    for reference in snapshot["sources"].as_array().expect("checked") {
        // 历史核验只取元信息：身份、修订与完整性别名同read_in_tx，正文不回源装配。
        let source = super::knowledge_sources::read_meta_in_tx(
            tx,
            ctx,
            reference[0].as_str().unwrap(),
            Some(epoch(reference[1].as_str().unwrap())?),
        )
        .await?;
        if source["version"] != source["current_version"] || source["complete"] != true {
            return Err(Error::new("stale_context"));
        }
    }
    for kind in ["query_results", "source_query_results"] {
        for reference in snapshot[kind].as_array().expect("checked") {
            let query = queries::read_in_tx(tx, ctx, reference[0].as_str().unwrap()).await?;
            if (kind == "query_results" && query["conversation_id"] != cid)
                || query["execution_state"] != "succeeded"
                || query["result_ref"] != reference[1]
            {
                return Err(Error::new("stale_context"));
            }
            super::knowledge::check_refs_in_tx(tx, ctx, &query["knowledge_refs"]).await?;
            conversations::assert_readable_in_tx(
                tx,
                ctx,
                query["conversation_id"]
                    .as_str()
                    .ok_or(Error::new("stale_context"))?,
            )
            .await?;
            let source =
                queries::text_authority_in_tx(tx, ctx, reference[0].as_str().expect("reference"))
                    .await?;
            if !covers(snapshot, &source) {
                return Err(Error::new("stale_context"));
            }
        }
    }
    // 历史投影桶：记录仍存在且指纹未被改写；缺失或变化都按保守失效处理。
    // 该桶不参与covers/采用判定，历史引用不能充当当前EvidenceRef或执行依据。
    for entry in snapshot["historical_analyses"]
        .as_array()
        .into_iter()
        .flatten()
    {
        super::historical_analysis::assert_unchanged_in_tx(tx, ctx, entry).await?;
    }
    Ok(())
}

/// 历史展示不依赖旧资料全文；普通改版不隐藏已存正文，撤权、删除、停用仍拒绝。来源闭包
/// 覆盖（covers）照常要求：缺闭包的记录不能证明正文来源，仍按限制隐藏。查询
/// 结果只核记录存在与会话可读，当前结果有效性交给图表/明细逐项处理。
pub async fn validate_history_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    cid: &str,
    snapshot: &Value,
) -> Result<()> {
    if !complete(snapshot) {
        return Err(Error::new("stale_context"));
    }
    for reference in knowledge_selections(snapshot)? {
        // 保存时的条目范围仍约束历史来源；旧无范围清单继续核整对象。
        super::knowledge::history_check_refs_in_tx(
            tx,
            ctx,
            &json!([{"object_id": reference.object_id, "version": reference.version.to_string(), "path": reference.path}]),
        )
        .await?;
    }
    for kind in ["memories", "skills", "source_skills"] {
        for reference in snapshot[kind].as_array().expect("checked") {
            let asset = assets::read_in_tx(tx, ctx, reference[0].as_str().unwrap(), true).await?;
            if asset["state"] == "disabled" || asset["state"] == "deleted" {
                return Err(Error::new("not_available"));
            }
        }
    }
    for reference in snapshot["sources"].as_array().expect("checked") {
        // 历史展示不读正文：存在/可用性以元信息判定，结果与read_in_tx一致。
        super::knowledge_sources::read_meta_in_tx(tx, ctx, reference[0].as_str().unwrap(), None)
            .await?;
    }
    for kind in ["query_results", "source_query_results"] {
        for reference in snapshot[kind].as_array().expect("checked") {
            let query = queries::read_in_tx(tx, ctx, reference[0].as_str().unwrap()).await?;
            if kind == "query_results" && query["conversation_id"] != cid {
                return Err(Error::new("stale_context"));
            }
            conversations::assert_readable_in_tx(
                tx,
                ctx,
                query["conversation_id"]
                    .as_str()
                    .ok_or(Error::new("stale_context"))?,
            )
            .await?;
            let source =
                queries::text_authority_in_tx(tx, ctx, reference[0].as_str().expect("reference"))
                    .await?;
            if !covers(
                &historical_sources(snapshot)?,
                &historical_sources(&source)?,
            ) {
                return Err(Error::new("stale_context"));
            }
        }
    }
    for entry in snapshot["historical_analyses"]
        .as_array()
        .into_iter()
        .flatten()
    {
        super::historical_analysis::assert_unchanged_in_tx(tx, ctx, entry).await?;
    }
    Ok(())
}

pub struct CheckedResults {
    references: Value,
    pub invalidated: bool,
}

impl CheckedResults {
    pub fn assert_snapshot(&self, snapshot: &Value) -> Result<()> {
        if self.references != result_references(snapshot) {
            return Err(Error::new("stale_context"));
        }
        Ok(())
    }
}

/// 外部结果授权在业务事务外检查；最终事务比较同一依赖清单，避免检查后新增引用。
pub async fn check_results(
    pool: &MySqlPool,
    ctx: &AccessContext,
    snapshot: &Value,
) -> Result<CheckedResults> {
    let mut checked = CheckedResults {
        references: result_references(snapshot),
        invalidated: !complete(snapshot),
    };
    if checked.invalidated {
        return Ok(checked);
    }
    for reference in result_references(snapshot).as_array().expect("complete") {
        if !result_accessible(pool, ctx, reference).await? {
            checked.invalidated = true;
            break;
        }
    }
    Ok(checked)
}

pub async fn check_run_results(
    pool: &MySqlPool,
    ctx: &AccessContext,
    run: &str,
) -> Result<CheckedResults> {
    let mut tx = AppTx::begin(pool).await?;
    let snapshot = runtime::read_authority_in_tx(&mut tx, run)
        .await?
        .unwrap_or_else(empty);
    tx.commit().await?;
    let checked = check_results(pool, ctx, &snapshot).await?;
    if checked.invalidated {
        return Err(Error::new("stale_context"));
    }
    Ok(checked)
}

pub async fn assert_checked_run_in_tx(
    tx: &mut AppTx<'_>,
    run: &str,
    checked: &CheckedResults,
) -> Result<()> {
    let snapshot = runtime::read_authority_in_tx(tx, run)
        .await?
        .unwrap_or_else(empty);
    checked.assert_snapshot(&snapshot)
}

pub async fn needs_reset_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    cid: &str,
    snapshot: &Value,
) -> Result<bool> {
    if snapshot["checkpoint_reset_required"] == true {
        return Ok(true);
    }
    match validate_in_tx(tx, ctx, cid, snapshot).await {
        Ok(()) => Ok(false),
        Err(error)
            if matches!(
                error.code,
                "stale_context" | "stale_knowledge" | "not_available" | "invalid_input"
            ) =>
        {
            Ok(true)
        }
        Err(error) => Err(error),
    }
}

pub async fn extend_run_in_tx(
    tx: &mut AppTx<'_>,
    _locked: &crate::modules::conversations::LockedConversation,
    run: &str,
    data: &Value,
) -> Result<()> {
    if let Some(mut snapshot) = runtime::read_authority_in_tx(tx, run).await? {
        if !complete(&snapshot) {
            return Err(Error::new("stale_context"));
        }
        observe(&mut snapshot, data);
        runtime::save_authority_in_tx(tx, run, &snapshot).await?;
    }
    Ok(())
}

/// 证据读取进入会话投影依赖清单：只有成功读取回执追加，条件引用与目录预览不进
/// 此桶；桶随授权快照跨轮传播，轮内收紧/切换后的派发与检查点重投影据此判定。
pub async fn observe_evidence_reads_in_tx(
    tx: &mut AppTx<'_>,
    run: &str,
    tool_name: &str,
    data: &Value,
) -> Result<()> {
    if let Some(mut authority) = runtime::read_authority_in_tx(tx, run).await? {
        let reads = super::source_limits::evidence_reads_of(&[json!({
            "tool_name": tool_name,
            "data": data,
        })]);
        merge_evidence_reads(&mut authority, reads);
        runtime::save_authority_in_tx(tx, run, &authority).await?;
    }
    Ok(())
}

fn merge_evidence_reads(authority: &mut Value, reads: Vec<Value>) {
    if !authority["evidence_reads"].is_array() {
        authority["evidence_reads"] = json!([]);
    }
    let entries = authority["evidence_reads"]
        .as_array_mut()
        .expect("read list");
    for read in reads {
        if !entries.contains(&read) {
            entries.push(read);
        }
    }
}

/// 启动预览也是实际交付。只登记裁剪后留下的资产，不把派生出处当原文预览。
pub fn observe_workspace_previews(authority: &mut Value, workspace: &Value) {
    for kind in ["memories", "selected_skills"] {
        for preview in workspace[kind].as_array().into_iter().flatten() {
            merge_evidence_reads(
                authority,
                super::source_limits::evidence_reads_of(&[
                    json!({"tool_name": "read_knowledge", "data": preview}),
                ]),
            );
        }
    }
}
pub async fn assert_run_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    cid: &str,
    run: &str,
) -> Result<()> {
    if let Some(previous) = runtime::read_authority_in_tx(tx, run).await? {
        match validate_in_tx(tx, ctx, cid, &previous).await {
            Err(error)
                if matches!(
                    error.code,
                    "stale_knowledge" | "not_available" | "invalid_input"
                ) =>
            {
                return Err(Error::new("stale_context"));
            }
            result => result?,
        }
    }
    Ok(())
}

pub async fn extend_result_dependencies_in_tx(
    tx: &mut AppTx<'_>,
    _locked: &crate::modules::conversations::LockedConversation,
    run: &str,
    references: &Value,
) -> Result<()> {
    if let Some(mut snapshot) = runtime::read_authority_in_tx(tx, run).await? {
        if !complete(&snapshot) {
            return Err(Error::new("stale_context"));
        }
        let refs: Vec<Value> = references
            .as_array()
            .ok_or(Error::new("invalid_evidence"))?
            .to_vec();
        if refs.is_empty() {
            return Ok(());
        }
        for reference in &refs {
            add(
                &mut snapshot,
                "query_results",
                &reference["query_id"],
                &reference["result_ref"],
            );
        }
        runtime::save_authority_in_tx(tx, run, &snapshot).await?;
    }
    Ok(())
}

// 用户本轮主动修订只替换该记忆的授权版本，不能顺便刷新其他失效依据。
// 当前模型可用工具回执确认纠错；旧SDK正文/摘要在新输入或中断恢复时必须重建。
pub async fn record_memory_change_in_tx(
    tx: &mut AppTx<'_>,
    run: &str,
    old: &Value,
    new: &Value,
) -> Result<()> {
    if let Some(mut authority) = runtime::read_authority_in_tx(tx, run).await? {
        let memories = authority["memories"]
            .as_array_mut()
            .ok_or(Error::new("stale_context"))?;
        memories.retain(|entry| entry != &json!([old["id"], old["version"]]));
        if new["state"] == "enabled" {
            memories.push(json!([new["id"], new["version"]]));
        }
        authority["checkpoint_reset_required"] = json!(true);
        runtime::save_authority_in_tx(tx, run, &authority).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_document_search_keeps_knowledge_scope_without_extra_source_permissions() {
        let document = json!({"id":"document-synthetic-guide","kind":"document","version":"3",
            "required_sources":[["synthetic-upstream","7"]],
            "entries":[{"entry_id":"body","path":"body","effective_value":"合成允许正文"}]});
        let reply = json!({"hits":[{"record_kind":"knowledge_entry",
            "ref":{"object_id":document["id"],"version":"3","path":"body"}}]});
        let authority = search_delivery_dependencies(std::slice::from_ref(&document), &reply);
        assert_eq!(authority["sources"], json!([]));
        assert_eq!(
            authority["knowledge_entries"],
            json!([[document["id"], "3", "body"]])
        );

        let legacy_reply = json!({"objects":[{"id":document["id"],"kind":"document","version":"3",
            "entries":[{"entry_id":"body","path":"body"}]}]});
        let mut legacy =
            search_delivery_dependencies(std::slice::from_ref(&document), &legacy_reply);
        observe(&mut legacy, &legacy_reply);
        assert_eq!(legacy["sources"], authority["sources"]);
        assert_eq!(legacy["knowledge_entries"], authority["knowledge_entries"]);

        let mut term = document;
        term["kind"] = json!("term");
        let term_authority = search_delivery_dependencies(&[term], &reply);
        assert_eq!(
            term_authority["sources"],
            json!([["synthetic-upstream", "7"]])
        );
    }

    #[test]
    fn document_statements_keep_explicit_source_and_support_dependencies() {
        let citation = json!({"source":{"kind":"platform","id":"synthetic-cited-source"},
            "revision":"4","locator":{"offset":2,"length":6}});
        let document = json!({"id":"document-synthetic-statement","kind":"document","version":"2",
            "entries":[{"path":"body","statement_content":{"statement_id":"statement-a",
                "citations":[citation],"supports":[{"reference":{"kind":"knowledge",
                    "ref":{"object_id":"synthetic-support","version":"5","path":"definition"}}}]}}]});
        let reply = json!({"hits":[{"record_kind":"knowledge_entry","statement_id":"statement-a",
            "ref":{"object_id":document["id"],"version":"2","path":"body"}}]});
        let authority = search_delivery_dependencies(&[document], &reply);
        assert_eq!(
            authority["sources"],
            json!([["synthetic-cited-source", "4"]])
        );
        assert!(
            authority["knowledge_entries"]
                .as_array()
                .unwrap()
                .contains(&json!(["synthetic-support", "5", "definition"]))
        );
    }

    #[test]
    fn persisted_text_keeps_transitive_sources_without_reselecting_them() {
        let mut run = empty();
        run["skills"] = json!([["selected", "1"]]);
        run["query_results"] = json!([["query", "result"]]);
        run["source_skills"] = json!([["ancestor", "2"]]);
        run["source_query_results"] = json!([["prior", "saved"]]);
        let persisted = to_persisted(&run).unwrap();
        assert_eq!(persisted["skills"], json!([]));
        assert_eq!(persisted["query_results"], json!([]));
        assert_eq!(
            persisted["source_skills"],
            json!([["ancestor", "2"], ["selected", "1"]])
        );
        assert_eq!(
            persisted["source_query_results"],
            json!([["prior", "saved"], ["query", "result"]])
        );
        let mut next = empty();
        merge(&mut next, &persisted).unwrap();
        assert_eq!(to_persisted(&next).unwrap(), persisted);
        assert_eq!(
            result_references(&next),
            json!([
                ["prior", "saved", "current_use"],
                ["query", "result", "current_use"]
            ])
        );
    }
    #[test]
    fn delivered_rows_are_dependencies_but_task_reference_metadata_is_not() {
        let mut snapshot = empty();
        observe(
            &mut snapshot,
            &json!({"tasks":[{"evidence_refs":[{"evidence_id":"e","result_dependencies":[{"query_id":"old","result_ref":"old-ref"}]}]}]}),
        );
        assert_eq!(snapshot["query_results"], json!([]));
        observe(
            &mut snapshot,
            &json!({"results":{"query_id":"q","result_ref":"ref","rows":[["1"]]}}),
        );
        assert_eq!(snapshot["query_results"], json!([["q", "ref"]]));
    }
    #[test]
    fn delivered_result_views_and_fragments_keep_result_authority() {
        let base = json!({"query_id":"q","result_ref":"ref","source":"mock","columns":[{"name":"v","type":"text","encoding":"text"}],"rows":[["x".repeat(30000)]],"result_complete":true,"truncated":false,"data_freshness":"synthetic","next_cursor":null,"fetched_offset":"0","saved_row_count":1,"saved_result_complete":true,"statistics":{"scope":"complete_result","row_count":1,"distinct_comparison":"returned_text","columns":[]}});
        for input in [
            json!({}),
            json!({"view":"statistics"}),
            json!({"view":"cell","row_index":0,"column_index":0}),
        ] {
            let page = queries::agent_result_page(&base, &input).unwrap();
            let mut snapshot = empty();
            observe(&mut snapshot, &json!({"results":page}));
            assert_eq!(snapshot["query_results"], json!([["q", "ref"]]));
        }
        let mut snapshot = empty();
        observe(
            &mut snapshot,
            &json!({"query_id":"unread","result_ref":"ref","view":"cell"}),
        );
        assert_eq!(snapshot["query_results"], json!([]));
    }
    #[test]
    fn dependencies_cover_delivered_objects_and_keep_earlier_pages() {
        let mut snapshot = empty();
        observe(
            &mut snapshot,
            &json!({"objects":[{"id":"table-a","kind":"table","version":"2","entries":[]}],"text":"table-not-read"}),
        );
        observe(
            &mut snapshot,
            &json!({"body":"片段","source_id":"source-a","version":"3","current_version":"3"}),
        );
        observe(
            &mut snapshot,
            &json!({"conditions":{"knowledge_refs":[{"object_id":"metric-a","version":"1","path":"sql"}]},"memories":[{"id":"memory-a","kind":"memory","version":"4"}]}),
        );
        assert_eq!(
            snapshot["knowledge"],
            json!([["table-a", "2"], ["metric-a", "1"]])
        );
        assert_eq!(snapshot["sources"], json!([["source-a", "3"]]));
        assert_eq!(snapshot["memories"], json!([["memory-a", "4"]]));
        let mut legacy = empty();
        legacy["knowledge"] = json!([["legacy-object", "1"]]);
        legacy.as_object_mut().unwrap().remove("knowledge_entries");
        merge(&mut legacy, &snapshot).unwrap();
        observe(
            &mut legacy,
            &json!({"object_id":"legacy-object","version":"1","path":"new-narrow-read"}),
        );
        assert!(
            knowledge_selections(&legacy)
                .unwrap()
                .iter()
                .any(|s| s.object_id == "legacy-object" && s.path.is_empty()),
            "旧快照的整对象范围不得被后续窄读收紧"
        );
        assert!(!complete(
            &json!({"knowledge":[],"sources":[],"memories":[],"skills":[]})
        ));
    }

    #[test]
    fn structure_dependencies_are_kept_when_later_pages_only_contain_text() {
        let mut snapshot = empty();
        observe(
            &mut snapshot,
            &json!({"id":"metric-x","kind":"metric","version":"3","entries":[{
                "effective_structure":{"kind":"metric","table":{"object_id":"table-x","version":"4"}}
            }]}),
        );
        observe(
            &mut snapshot,
            &json!({"structure_text":"部分正文","structure_dependencies":[{
                "object_id":"table-y","version":"5","path":"ddl"
            }]}),
        );
        assert_eq!(
            snapshot["knowledge"],
            json!([["metric-x", "3"], ["table-x", "4"], ["table-y", "5"]])
        );
        assert!(!complete(
            &json!({"dependency_schema":1,"knowledge":[],"sources":[],"memories":[],"skills":[]})
        ));
        for version in [3, 4] {
            let mut old = empty();
            old["dependency_schema"] = json!(version);
            assert!(!complete(&old));
        }
    }
}
