use crate::{
    modules::{analysis, assets, conversations, knowledge, queries, runtime},
    persistence::AppTx,
    types::{AccessContext, Error, Result, epoch},
};
use serde_json::{Value, json};
use sqlx::MySqlPool;

pub fn empty() -> Value {
    json!({"dependency_schema":5,"sources":[],"knowledge":[],"memories":[],"skills":[],"query_results":[],"source_skills":[],"source_query_results":[]})
}

/// 按文本自己的来源核验；当前条件移除引用不能使旧目标、开放问题脱离权限约束。
pub async fn protect_task_context_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    cid: &str,
    task: &mut Value,
    checked_results: &CheckedTextResults,
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
        match validate_text_in_tx(tx, ctx, cid, &references, checked_results).await {
            Ok(()) => merge(&mut adopted, &references)?,
            Err(error)
                if matches!(
                    error.code,
                    "stale_context"
                        | "stale_knowledge"
                        | "not_available"
                        | "forbidden"
                        | "invalid_input"
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
                    "部分目标、问题或条件的来源已失效或不完整，相关正文已隐藏。其他合法字段仍可读取，条件版本、问题身份与等待状态保留；未回答不能默认采用。请重新调查，不能从旧历史补回失效正文。"
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
            add(snapshot, kind, &reference[0], &reference[1]);
        }
    }
    Ok(())
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
    let mut persisted = empty();
    merge(&mut persisted, snapshot)?;
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
        for reference in snapshot[kind].as_array().into_iter().flatten() {
            if !references.contains(reference) {
                references.push(reference.clone());
            }
        }
    }
    json!(references)
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
                let mut snapshot = empty();
                snapshot["query_results"] = json!([reference]);
                let result = check_results(pool, ctx, &snapshot).await?;
                self.results.push((reference.clone(), !result.invalidated));
            }
        }
        Ok(())
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
    fn allows(&self, snapshot: &Value) -> bool {
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

// 只观察宿主已裁剪、确实交付的结构化资料。字符串中的ID不被当作引用。
// 对同一Pi会话取并集：压缩摘要可能仍包含早先资料，不能因最新页没出现就删掉依赖。
pub fn observe(snapshot: &mut Value, data: &Value) {
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
            add(snapshot, kind, &data["id"], &data["version"]);
        }
    }
    if data["current_version"].is_string() {
        add(snapshot, "sources", &data["source_id"], &data["version"]);
    }
    if data["path"].is_string() {
        add(snapshot, "knowledge", &data["object_id"], &data["version"]);
    }
    for reference in knowledge::structure_dependencies(data) {
        add(
            snapshot,
            "knowledge",
            &reference["object_id"],
            &reference["version"],
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
            for value in values.values() {
                observe(snapshot, value);
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

fn complete(snapshot: &Value) -> bool {
    // 格式5要求持久正文的完整来源闭包；旧格式及缺桶快照都不能当作空依赖。
    snapshot["dependency_schema"] == 5
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
            snapshot[*kind].as_array().is_some_and(|items| {
                items.iter().all(|item| {
                    item.as_array().is_some_and(|pair| {
                        pair.len() == 2 && pair[0].is_string() && pair[1].is_string()
                    })
                })
            })
        })
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
    let ids = snapshot["knowledge"]
        .as_array()
        .expect("checked")
        .iter()
        .map(|r| r[0].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    let objects = knowledge::current_objects_in_tx(tx, ctx, &ids).await?;
    for reference in snapshot["knowledge"].as_array().expect("checked") {
        let object = objects
            .iter()
            .find(|v| v["id"] == reference[0] && v["version"] == reference[1])
            .ok_or(Error::new("stale_context"))?;
        super::knowledge::assert_source_in_tx(tx, ctx, object).await?;
        // 有效规则的完整依赖已随投影登记；不能给已撤下规则的线索补上原始旧依赖。
    }
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
        let source = super::knowledge_sources::read_in_tx(
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
        match super::query_workflow::result_state_authority(
            pool,
            ctx,
            reference[0].as_str().unwrap(),
            reference[1].as_str().unwrap(),
        )
        .await
        {
            Ok(()) => (),
            Err(error)
                if matches!(
                    error.code,
                    "result_expired"
                        | "result_unavailable"
                        | "forbidden"
                        | "not_available"
                        | "stale_knowledge"
                        | "invalid_evidence"
                ) =>
            {
                checked.invalidated = true;
                break;
            }
            Err(error) => return Err(error),
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

pub async fn extend_run_in_tx(tx: &mut AppTx<'_>, run: &str, data: &Value) -> Result<()> {
    if let Some(mut previous) = runtime::read_authority_in_tx(tx, run).await? {
        if !complete(&previous) {
            return Err(Error::new("stale_context"));
        }
        observe(&mut previous, data);
        runtime::save_authority_in_tx(tx, run, &previous).await?;
    }
    Ok(())
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
    run: &str,
    references: &Value,
) -> Result<()> {
    if let Some(mut snapshot) = runtime::read_authority_in_tx(tx, run).await? {
        if !complete(&snapshot) {
            return Err(Error::new("stale_context"));
        }
        for reference in references
            .as_array()
            .ok_or(Error::new("invalid_evidence"))?
        {
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
            json!([["prior", "saved"], ["query", "result"]])
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
