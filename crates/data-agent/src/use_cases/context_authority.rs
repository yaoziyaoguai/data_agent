use crate::{
    modules::{assets, knowledge, queries, runtime},
    persistence::AppTx,
    types::{AccessContext, Error, Result, epoch},
};
use serde_json::{Value, json};
use sqlx::MySqlPool;

pub fn empty() -> Value {
    json!({"dependency_schema":4,"sources":[],"knowledge":[],"memories":[],"skills":[],"query_results":[]})
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
    if data["result_ref"].is_string() && data["rows"].is_array() && data["query_id"].is_string() {
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
    snapshot["dependency_schema"] == 4
        && [
            "knowledge",
            "memories",
            "skills",
            "sources",
            "query_results",
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
    for kind in ["memories", "skills"] {
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
    for reference in snapshot["query_results"].as_array().expect("checked") {
        let query = queries::read_in_tx(tx, ctx, reference[0].as_str().unwrap()).await?;
        if query["conversation_id"] != cid
            || query["execution_state"] != "succeeded"
            || query["result_ref"] != reference[1]
        {
            return Err(Error::new("stale_context"));
        }
        super::knowledge::check_refs_in_tx(tx, ctx, &query["knowledge_refs"]).await?;
    }
    Ok(())
}

pub struct CheckedResults {
    references: Value,
    pub invalidated: bool,
}

impl CheckedResults {
    pub fn assert_snapshot(&self, snapshot: &Value) -> Result<()> {
        if self.references != snapshot["query_results"] {
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
        references: snapshot["query_results"].clone(),
        invalidated: !complete(snapshot),
    };
    if checked.invalidated {
        return Ok(checked);
    }
    for reference in snapshot["query_results"].as_array().expect("complete") {
        match super::query_workflow::result_authority(
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
        let mut old = empty();
        old["dependency_schema"] = json!(3);
        assert!(!complete(&old));
    }
}
