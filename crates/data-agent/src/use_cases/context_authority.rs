use super::{knowledge, knowledge_sources, query_workflow};
use crate::{
    modules::{assets, runtime},
    persistence::AppTx,
    types::{AccessContext, Error, Result, epoch},
};
use serde_json::{Value, json};
use sqlx::MySqlPool;
use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet, btree_map::Entry};

const ASSETS: [&str; 3] = ["memories", "skills", "source_skills"];
const RESULTS: [&str; 2] = ["query_results", "source_query_results"];
const BUCKETS: [&str; 9] = [
    "knowledge",
    "knowledge_entries",
    "sources",
    ASSETS[0],
    ASSETS[1],
    ASSETS[2],
    RESULTS[0],
    RESULTS[1],
    "historical_analyses",
];

pub fn empty() -> Value {
    let mut snapshot = serde_json::Map::from_iter(BUCKETS.map(|key| (key.into(), json!([]))));
    snapshot.insert("dependency_schema".into(), json!(6));
    Value::Object(snapshot)
}

pub(super) fn items(value: &Value) -> &[Value] {
    value.as_array().map_or(&[], Vec::as_slice)
}

fn complete(snapshot: &Value) -> bool {
    let schema = snapshot["dependency_schema"].as_u64();
    matches!(schema, Some(5 | 6))
        && BUCKETS.into_iter().all(|key| {
            let legacy =
                key == "knowledge_entries" || (schema == Some(5) && key == "historical_analyses");
            snapshot[key].is_array() || (legacy && snapshot[key].is_null())
        })
}

pub(super) fn has_sources(snapshot: &Value) -> bool {
    BUCKETS
        .into_iter()
        .any(|key| !items(&snapshot[key]).is_empty())
}

fn push(snapshot: &mut Value, bucket: &str, reference: Value) -> Result<()> {
    let list = snapshot[bucket]
        .as_array_mut()
        .ok_or(Error::new("stale_context"))?;
    if !list.contains(&reference) {
        list.push(reference);
    }
    Ok(())
}

pub(super) fn knowledge_paths(snapshot: &Value) -> impl Iterator<Item = (&Value, &Value, &str)> {
    items(&snapshot["knowledge"]).iter().flat_map(|r| {
        let paths = items(&snapshot["knowledge_entries"])
            .iter()
            .filter(|p| p[0] == r[0] && p[1] == r[1])
            .filter_map(|p| p[2].as_str());
        let whole = paths.clone().next().is_none() || paths.clone().any(str::is_empty);
        // 老快照缺路径的整对象范围优先于同对象的精读路径。
        paths
            .filter(move |_| !whole)
            .chain(whole.then_some(""))
            .map(|path| (&r[0], &r[1], path))
    })
}

pub fn merge(snapshot: &mut Value, dependencies: &Value) -> Result<()> {
    if !complete(snapshot) || !complete(dependencies) {
        return Err(Error::new("stale_context"));
    }
    // 新旧快照合并前补上旧整对象标记，避免新精读路径收窄历史范围。
    let whole = [&*snapshot, dependencies]
        .into_iter()
        .flat_map(knowledge_paths)
        .filter(|(_, _, path)| path.is_empty())
        .map(|(id, version, _)| json!([id, version, ""]))
        .collect::<Vec<_>>();
    for bucket in BUCKETS {
        if snapshot[bucket].is_null() {
            snapshot[bucket] = json!([]);
        }
        for reference in items(&dependencies[bucket]) {
            push(snapshot, bucket, reference.clone())?;
        }
    }
    if snapshot.get("active_skill_reads").is_some() {
        for reference in items(&dependencies["active_skill_reads"]) {
            push(snapshot, "active_skill_reads", reference.clone())?;
        }
    }
    for reference in whole {
        push(snapshot, "knowledge_entries", reference)?;
    }
    if let Some(previews) = dependencies.get("skill_preview_sources") {
        merge_skill_preview_sources(snapshot, previews)?;
    }
    snapshot["dependency_schema"] = json!(6);
    Ok(())
}

pub(super) fn merge_skill_preview_sources(snapshot: &mut Value, sources: &Value) -> Result<()> {
    let preview = snapshot
        .as_object_mut()
        .ok_or(Error::new("stale_context"))?
        .entry("skill_preview_sources")
        .or_insert_with(empty);
    merge(preview, sources)
}

pub(super) fn including_skill_previews(snapshot: &Value) -> Result<Cow<'_, Value>> {
    if let Some(previews) = snapshot.get("skill_preview_sources") {
        let mut authority = snapshot.clone();
        merge(&mut authority, previews)?;
        Ok(Cow::Owned(authority))
    } else {
        Ok(Cow::Borrowed(snapshot))
    }
}

fn declared_results(sources: &Value) -> impl Iterator<Item = (&Value, &Value)> {
    items(&sources["result_dependencies"])
        .iter()
        .map(|r| (&r["query_id"], &r["result_ref"]))
}

pub fn from_sources(sources: &Value) -> Result<Value> {
    let mut snapshot = empty();
    observe(&mut snapshot, &sources["knowledge_refs"])?;
    if sources["id"].is_string() && sources["result_ref"].is_string() {
        push(
            &mut snapshot,
            "query_results",
            json!([sources["id"], sources["result_ref"]]),
        )?;
    }
    for (query, result) in declared_results(sources) {
        push(&mut snapshot, "query_results", json!([query, result]))?;
    }
    Ok(snapshot)
}

pub(super) fn historical_sources(snapshot: &Value, actual: &Value) -> Result<Value> {
    let mut combined = empty();
    merge(&mut combined, snapshot)?;
    let records = std::mem::replace(&mut combined["historical_analyses"], json!([]));
    merge(&mut combined, &from_sources(actual)?)?;
    for record in items(&records) {
        merge(&mut combined, &from_sources(&record["actual_sources"])?)?;
    }
    Ok(combined)
}

// 预览本文进入模型；所选 Skill 名称和范围同样属于其版本。
pub(super) fn observe_workspace_previews(snapshot: &mut Value, workspace: &Value) -> Result<()> {
    let mut previews = empty();
    for item in items(&workspace["memories"]) {
        push(
            &mut previews,
            "memories",
            json!([item["id"], item["version"]]),
        )?;
        observe(&mut previews, &item["dependencies"])?;
    }
    for item in items(&workspace["selected_skills"]) {
        push(
            &mut previews,
            "skills",
            json!([item["id"], item["version"]]),
        )?;
    }
    if has_sources(&previews) {
        merge(snapshot, &previews)?;
    }
    Ok(())
}

pub fn observe(snapshot: &mut Value, data: &Value) -> Result<()> {
    observe_delivery(snapshot, data, true)
}

pub(super) fn observe_delivery(
    snapshot: &mut Value,
    data: &Value,
    with_dependencies: bool,
) -> Result<()> {
    let leaves = std::iter::once(data)
        .chain(items(data))
        .chain(
            ["items", "hits", "knowledge_refs", "objects"]
                .into_iter()
                .flat_map(|key| items(&data[key])),
        )
        .chain(
            ["query", "results", "result"]
                .into_iter()
                .filter_map(|key| data.get(key)),
        );
    for item in leaves {
        if matches!(
            item["state"].as_str(),
            Some("stale" | "not_available" | "deleted" | "disabled")
        ) {
            continue;
        }
        // 退役工具仍可能重放已保存的旧回执，授权沿原交付对象和路径核对。
        if let Some(entries) = item["entries"].as_array() {
            let (id, version) = (&item["id"], &item["version"]);
            push(snapshot, "knowledge", json!([id, version]))?;
            for entry in entries {
                push(
                    snapshot,
                    "knowledge_entries",
                    json!([id, version, entry["path"]]),
                )?;
            }
        }
        if item["current_version"].is_string() {
            push(
                snapshot,
                "sources",
                json!([item["source_id"], item["version"]]),
            )?;
        }
        let supports = items(&item["supports"]);
        let included = |key: &str| items(&item[key]).iter().filter(|_| with_dependencies);
        let citations = std::iter::once(item)
            .chain(item.get("citation"))
            .chain(included("citations"))
            .chain(
                supports
                    .iter()
                    .filter_map(|s| s["reference"].get("citation")),
            );
        for c in citations {
            let (Some(id), Some(version)) = (c["source"]["id"].as_str(), c["revision"].as_str())
            else {
                continue;
            };
            let id = if c["source"]["kind"] == "document" {
                format!("document-{id}")
            } else {
                id.to_owned()
            };
            push(snapshot, "sources", json!([id, version]))?;
        }
        let delivered_supports = supports
            .iter()
            .filter(|s| {
                s["content"].as_str().is_some_and(|v| !v.is_empty())
                    || s["delivered_in"].is_object()
            })
            .map(|s| &s["reference"]["ref"]);
        let refs = std::iter::once(item.get("ref").unwrap_or(item))
            .chain(included("structure_dependencies"))
            .chain(delivered_supports)
            .chain(items(&item["asset"]["dependencies"]));
        for r in refs {
            let [object, version, path] = ["object_id", "version", "path"].map(|key| &r[key]);
            if object.is_string() && version.is_string() && path.is_string() {
                push(snapshot, "knowledge", json!([object, version]))?;
                push(
                    snapshot,
                    "knowledge_entries",
                    json!([object, version, path]),
                )?;
            }
        }
        let result_body = item["rows"].is_array()
            || item["statistics"].is_object()
            || (item["content_format"] == "json"
                && item["content_text"].is_string()
                && matches!(item["view"].as_str(), Some("rows" | "statistics" | "cell")));
        if result_body && item["query_id"].is_string() && item["result_ref"].is_string() {
            push(
                snapshot,
                "query_results",
                json!([item["query_id"], item["result_ref"]]),
            )?;
        }
        let asset_body = item["state"] == "ok" && item["asset"].is_object();
        if let Some((entries, asset)) = match item["kind"].as_str() {
            Some("memory") if asset_body => Some(("memories", &item["asset_ref"])),
            Some("skill") if asset_body => Some(("skills", &item["asset_ref"])),
            Some("skill") if item["path"].is_string() && item["text"].is_string() => {
                Some(("skills", item))
            }
            _ => None,
        } {
            push(snapshot, entries, json!([asset["id"], asset["version"]]))?;
        }
    }
    for item in items(&data["personal_memories"]) {
        if item["id"].is_string() && item["version"].is_string() {
            push(snapshot, "memories", json!([item["id"], item["version"]]))?;
            if with_dependencies {
                observe(snapshot, &item["dependencies"])?;
            }
        }
    }
    Ok(())
}

pub(super) fn pair(id: &Value, version: &Value) -> Result<(String, String)> {
    id.as_str()
        .zip(version.as_str())
        .map(|(id, v)| (id.into(), v.into()))
        .ok_or(Error::new("stale_context"))
}

pub(super) type ResultKey = (String, String, bool);

pub(super) fn result_keys(snapshot: &Value, historical: bool) -> Result<BTreeSet<ResultKey>> {
    let direct = RESULTS
        .into_iter()
        .flat_map(|key| items(&snapshot[key]))
        .map(|r| (&r[0], &r[1], historical));
    let history = items(&snapshot["historical_analyses"])
        .iter()
        .flat_map(|r| declared_results(&r["actual_sources"]))
        .map(|(q, r)| (q, r, true));
    direct
        .chain(history)
        .map(|(q, r, h)| pair(q, r).map(|(q, r)| (q, r, h)))
        .collect()
}

pub(super) fn result_query_ids(snapshot: &Value) -> Result<Vec<String>> {
    let mut ids: Vec<_> = result_keys(snapshot, false)?
        .into_iter()
        .map(|(id, _, _)| id)
        .collect();
    ids.dedup();
    Ok(ids)
}

#[derive(Default)]
pub struct CheckedTextResults {
    results: BTreeMap<ResultKey, bool>,
    denied_queries: BTreeSet<String>,
}

enum ResultProofFailure {
    Propagate,
    HideHistoricalOutput,
}

impl CheckedTextResults {
    pub async fn include(
        &mut self,
        pool: &MySqlPool,
        ctx: &AccessContext,
        snapshots: &[Value],
        historical: bool,
    ) -> Result<()> {
        self.check_results(
            pool,
            ctx,
            snapshots,
            historical,
            ResultProofFailure::Propagate,
        )
        .await
    }

    pub(super) async fn include_output_history(
        &mut self,
        pool: &MySqlPool,
        ctx: &AccessContext,
        snapshots: &[Value],
    ) -> Result<()> {
        self.check_results(
            pool,
            ctx,
            snapshots,
            true,
            ResultProofFailure::HideHistoricalOutput,
        )
        .await
    }

    async fn check_results(
        &mut self,
        pool: &MySqlPool,
        ctx: &AccessContext,
        snapshots: &[Value],
        historical: bool,
        failure: ResultProofFailure,
    ) -> Result<()> {
        for key in snapshots
            .iter()
            .map(|snapshot| result_keys(snapshot, historical))
            .collect::<Result<Vec<_>>>()?
            .into_iter()
            .flatten()
        {
            let Entry::Vacant(entry) = self.results.entry(key) else {
                continue;
            };
            let (query, result, history) = entry.key();
            let proof =
                query_workflow::check_result_authority(pool, ctx, query, result, *history).await;
            let allowed = match proof {
                Ok(_) => true,
                Err(error)
                    if super::personal_assets::unavailable_text(&error)
                        || error.code == "invalid_evidence"
                        || (matches!(failure, ResultProofFailure::HideHistoricalOutput)
                            && matches!(error.code, "outcome_unknown" | "upstream_failed")) =>
                {
                    false
                }
                Err(error) => return Err(error),
            };
            entry.insert(allowed);
        }
        Ok(())
    }

    // 并入另一份已核结果，已有判定（含撤权）保持首次核验值。
    pub(super) fn extend(&mut self, other: CheckedTextResults) {
        for (key, allowed) in other.results {
            self.results.entry(key).or_insert(allowed);
        }
        self.denied_queries.extend(other.denied_queries);
    }

    pub(super) fn record_checked_result(&mut self, key: ResultKey, allowed: bool) {
        self.results.insert(key, allowed);
    }

    pub(super) fn record_result(&mut self, query: &str, result: &str) {
        self.record_checked_result((query.into(), result.into(), false), true);
    }

    pub(super) fn record_denied_query(&mut self, query: &str) {
        self.denied_queries.insert(query.into());
    }

    pub(super) fn allows_query(&self, query: &str) -> bool {
        !self.denied_queries.contains(query)
    }

    pub(super) fn allows(&self, snapshot: &Value, historical: bool) -> bool {
        complete(snapshot)
            && result_keys(snapshot, historical)
                .is_ok_and(|keys| keys.iter().all(|key| self.results.get(key) == Some(&true)))
    }
}

pub enum AuthorityUse<'a> {
    Historical,
    Text(&'a CheckedTextResults),
}

pub async fn validate_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    snapshot: &Value,
    usage: AuthorityUse<'_>,
) -> Result<Vec<Value>> {
    let valid = match usage {
        AuthorityUse::Text(checked) => checked.allows(snapshot, false),
        AuthorityUse::Historical => complete(snapshot),
    };
    if !valid {
        return Err(Error::new("stale_context"));
    }
    let historical = matches!(usage, AuthorityUse::Historical);
    let references = ASSETS
        .iter()
        .flat_map(|key| items(&snapshot[*key]))
        .map(|r| pair(&r[0], &r[1]))
        .collect::<Result<BTreeSet<_>>>()?;
    let ids: Vec<_> = references.iter().map(|r| r.0.clone()).collect();
    let enabled = assets::enabled_sources_in_tx(tx, ctx, &ids).await?;
    let mut asset_refs = Vec::new();
    for reference in references {
        match enabled.get(&reference) {
            Some(dependencies) => {
                for dependency in dependencies {
                    if !asset_refs.contains(dependency) {
                        asset_refs.push(dependency.clone());
                    }
                }
            }
            None if historical && enabled.keys().any(|(id, _)| id == &reference.0) => {}
            None => return Err(Error::new("stale_context")),
        }
    }
    let mut refs = asset_refs.clone();
    for (id, version, path) in knowledge_paths(snapshot) {
        let reference = json!({"object_id":id,"version":version,"path":path});
        if !refs.contains(&reference) {
            refs.push(reference);
        }
    }
    let refs = Value::Array(refs);
    if historical {
        knowledge::history_check_refs_in_tx(tx, ctx, &refs).await?;
    } else {
        knowledge::check_delivered_refs_in_tx(tx, ctx, &refs).await?;
    }
    let mut revisions = Vec::new();
    for r in items(&snapshot["sources"]) {
        let (id, version) = pair(&r[0], &r[1])?;
        revisions.push((id, (!historical).then(|| epoch(&version)).transpose()?));
    }
    let metas = knowledge_sources::read_metas_in_tx(tx, ctx, &revisions).await?;
    if !historical
        && revisions.iter().any(|(id, revision)| {
            let meta = &metas[id];
            meta["complete"] != true
                || meta["current_version"]
                    .as_str()
                    .and_then(|v| v.parse().ok())
                    != *revision
        })
    {
        return Err(Error::new("stale_source"));
    }
    for record in items(&snapshot["historical_analyses"]) {
        if let Some(sources) = record["actual_sources"]
            .get("authority")
            .filter(|v| !v.is_null())
        {
            Box::pin(validate_in_tx(tx, ctx, sources, AuthorityUse::Historical)).await?;
        }
    }
    Ok(asset_refs)
}

pub async fn generated_text_authority_in_tx(tx: &mut AppTx<'_>, run: &str) -> Result<Value> {
    let mut snapshot = runtime::read_authority_in_tx(tx, run)
        .await?
        .filter(complete)
        .ok_or(Error::new("stale_context"))?;
    exclude_skill_previews(&mut snapshot);
    Ok(snapshot)
}

pub(super) fn exclude_skill_previews(snapshot: &mut Value) {
    if let Value::Object(fields) = snapshot {
        fields.remove("checkpoint_reset_required");
        fields.remove("skill_preview_sources");
        // 目录仍可用于检查点核权；答案只继承当前 Pi 分支实际读取的文件。
        if let Some(reads) = fields.remove("active_skill_reads") {
            fields.insert("skills".into(), reads);
        }
    }
}

pub(super) fn start_input_skill_reads(snapshot: &mut Value) -> Result<()> {
    // 旧 Pi 分支仍保留上一轮工具正文；新输入只清本轮精读登记。
    let reads = snapshot
        .get("active_skill_reads")
        .unwrap_or(&snapshot["skills"])
        .clone();
    for reference in items(&reads) {
        push(snapshot, "source_skills", reference.clone())?;
    }
    snapshot["active_skill_reads"] = json!([]);
    Ok(())
}

pub(super) async fn record_skill_read_in_tx(
    tx: &mut AppTx<'_>,
    run: &str,
    mut authority: Value,
    asset: &Value,
) -> Result<()> {
    let reference = json!([asset["id"], asset["version"]]);
    push(&mut authority, "source_skills", reference.clone())?;
    authority["active_skill_reads"] = json!([reference]);
    merge_run_in_tx(tx, run, &authority).await
}

pub async fn merge_run_in_tx(tx: &mut AppTx<'_>, run: &str, dependencies: &Value) -> Result<()> {
    if let Some(mut snapshot) = runtime::read_authority_in_tx(tx, run).await? {
        merge(&mut snapshot, dependencies)?;
        runtime::save_authority_in_tx(tx, run, &snapshot).await?;
    }
    Ok(())
}

pub async fn extend_run_in_tx(tx: &mut AppTx<'_>, run: &str, data: &Value) -> Result<()> {
    let mut snapshot = empty();
    observe(&mut snapshot, data)?;
    merge_run_in_tx(tx, run, &snapshot).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn observations_keep_explicit_evidence_and_ignore_unrelated_turn_text() {
        let mut snapshot = empty();
        observe(
            &mut snapshot,
            &json!({"hits":[{
            "ref":{"object_id":"doc","version":"3","path":"body"},
            "structure_dependencies":[{"object_id":"table","version":"7","path":"ddl"}],
            "supports":[{"content":"条件","reference":{"ref":{"object_id":"support","version":"2","path":"body"}}},
                {"content":null,"reference":{"ref":{"object_id":"link","version":"1","path":"body"}}}]
        }],"memories":[{"id":"note"}],"tasks":[{"result_dependencies":[{"query_id":"old","result_ref":"hidden"}]}]}),
        ).unwrap();
        assert_eq!(
            snapshot["knowledge_entries"],
            json!([
                ["doc", "3", "body"],
                ["table", "7", "ddl"],
                ["support", "2", "body"]
            ])
        );
        assert_eq!(snapshot["memories"], json!([]));
        assert!(result_keys(&snapshot, false).unwrap().is_empty());
        observe(
            &mut snapshot,
            &json!({"results":{"query_id":"q","result_ref":"r","rows":[["正文"]]}}),
        )
        .unwrap();
        assert_eq!(
            result_keys(&snapshot, false).unwrap(),
            BTreeSet::from([("q".into(), "r".into(), false)])
        );
    }
}
