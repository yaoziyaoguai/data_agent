#[path = "knowledge/maintenance.rs"]
mod maintenance;
pub use maintenance::{
    KnowledgeChange, KnowledgeVersionAction, edit, edit_batch, edit_entries, write,
};
#[path = "knowledge/catalog.rs"]
mod catalog;
pub(super) use catalog::semantic_object_in_tx;
pub(crate) use catalog::sync_catalog;
use catalog::{current_catalog_in_tx, sources_in_tx};
#[path = "knowledge/references.rs"]
mod references;
pub(super) use references::check_adoptable_refs_in_tx;
pub(super) use references::{assert_selection_sources_in_tx, check_refs_for_task_in_tx};
pub use references::{assert_source_in_tx, check_refs_in_tx, history_check_refs_in_tx};
use references::{
    check_input_structure_sources_in_tx, checked_refs_in_tx, current_structure_refs_in_tx,
};
#[path = "knowledge/indexing.rs"]
mod indexing;
use indexing::depends_on_source;
pub(crate) use indexing::source_alias;
pub use indexing::{process_index, rebuild_index, rebuild_index_for_operation};
#[path = "knowledge/search_cursor.rs"]
mod search_cursor;
use search_cursor::SavedCandidate;
pub use search_cursor::SearchContinuation;
#[cfg(test)]
use search_cursor::{SEARCH_CURSOR_BYTES, SavedLocation};
#[path = "knowledge/search_candidates.rs"]
mod search_candidates;
pub use search_candidates::{ScopedSearchRequest, ScopedSearchStage, StageReads, VerdictCache};
use search_candidates::{load_selected_in_tx, ordered_candidates_with, ranked_candidates_in_tx};
#[path = "knowledge/search_stage.rs"]
mod search_stage;
use search_stage::finish_search_stage;
pub use search_stage::{restore_search_stage_outside_lock, search_stage_outside_lock};
#[path = "knowledge/search_sources.rs"]
mod search_sources;
pub use search_sources::assert_search_fresh_in_tx;
pub(super) use search_sources::search_selected_sources_outside_lock;
#[path = "knowledge/search_delivery.rs"]
mod search_delivery;
use search_delivery::assemble_search_in_tx;

use crate::{
    contracts,
    contracts::generated::{
        AnalysisPreferenceCommand, Directory, DirectoryView, KnowledgeListQuery,
        MaintenanceDependentState, SourceKey, SourceKeyKind,
    },
    modules::{access, ingestion, jobs, knowledge, retrieval, retrieval::source_segments},
    persistence::AppTx,
    search_scope::KnowledgeSearchScope,
    types::{AccessContext, Error, Result, epoch, fingerprint, id},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};
use sqlx::MySqlPool;
pub async fn initialize(pool: &MySqlPool, space: &str) -> Result<()> {
    let ctx = AccessContext {
        user_id: "synthetic-import".into(),
        space_id: space.into(),
        request_id: id(),
        table_access: None,
    };
    let mut tx = AppTx::begin(pool).await?;
    let initialized =
        ingestion::source_head_version_in_tx(&mut tx, &ctx.space_id, "semantic-catalog")
            .await?
            .is_some();
    tx.commit().await?;
    // 首次启动建样例；已有资料的更新只经手动同步，重启不替用户导入新版本。
    if !initialized {
        sync_catalog(pool, &ctx).await?;
    }
    let mut tx = AppTx::begin(pool).await?;
    let objects = knowledge::list_in_tx(&mut tx, &ctx, false).await?;
    super::semantic_governance::register_objects_in_tx(&mut tx, &ctx, &objects).await?;
    tx.commit().await
}
pub async fn catalog_reader(ctx: &AccessContext) -> Result<AccessContext> {
    let access = crate::modules::queries::platform::catalog_access(ctx).await?;
    let mut reader = ctx.clone();
    reader.table_access = None;
    if !access.complete_access {
        let mut table_ids = access
            .legacy_table_names
            .into_iter()
            .map(|id| format!("table-{id}"))
            .collect::<std::collections::HashSet<_>>();
        table_ids.extend(
            access.table_ids.iter().map(|id| {
                ingestion::catalog::table_object_id(&ctx.space_id, &access.namespace, id)
            }),
        );
        let source_ids = access
            .table_ids
            .iter()
            .map(|id| ingestion::catalog::source_id(&ctx.space_id, &access.namespace, id))
            .collect();
        reader.table_access = Some(std::sync::Arc::new(crate::types::TableAccess {
            table_ids,
            source_ids,
            unavailable: false,
        }));
    }
    Ok(reader)
}

pub async fn catalog_context(ctx: &AccessContext) -> Result<AccessContext> {
    match catalog_reader(ctx).await {
        Err(error) if error.code == "source_unavailable" => {
            // 非目录操作仍可处理控制状态和独立资料，缺失的平台清单视为无表授权。
            let mut reader = ctx.clone();
            reader.table_access = Some(std::sync::Arc::new(crate::types::TableAccess {
                table_ids: Default::default(),
                source_ids: Default::default(),
                unavailable: true,
            }));
            Ok(reader)
        }
        result => result,
    }
}

pub async fn list(
    pool: &MySqlPool,
    ctx: &AccessContext,
    input: KnowledgeListQuery,
) -> Result<Value> {
    let query = input.q.as_deref();
    let after = input.after_id.as_deref();
    let related = input.related_id.as_deref();
    let directory = input.directory;
    let state = input.state.map(|state| match state {
        MaintenanceDependentState::Enabled => "enabled",
        MaintenanceDependentState::Disabled => "disabled",
    });
    // 浏览检索（05切片4）：与工具路径共用组合推进——词法就绪即期限内预读，慢嵌入
    // 不饿死词法路；返回的objects/coverage已含预读复用后的最终装配。
    let searched = if let Some(query) = query.filter(|_| directory.is_none()) {
        Some(super::knowledge_embeddings::search(pool, ctx, query, None).await?)
    } else {
        None
    };
    let mut tx = AppTx::begin(pool).await?;
    if let Some(object) = related {
        knowledge::read_in_tx(&mut tx, ctx, object, None, true).await?;
    }
    let (values, next, coverage) = if let Some(directory) = directory {
        let ids = if matches!(directory, Directory::Maintained) {
            Some(access::maintainable_ids_in_tx(&mut tx, ctx).await?)
        } else {
            None
        };
        let (values, next) = knowledge::directory_page_in_tx(
            &mut tx,
            ctx,
            after,
            query,
            state,
            ids.as_deref(),
            matches!(input.directory_view, Some(DirectoryView::Grouped)),
        )
        .await?;
        (values, next, None)
    } else if let Some(ref result) = searched {
        (result.objects.clone(), None, Some(result.coverage.clone()))
    } else {
        let (values, next) = knowledge::page_in_tx(&mut tx, ctx, after, related).await?;
        (values, next, None)
    };
    let mut values = values;
    for value in &mut values {
        // 工具采用元信息由检索工具保留；维护HTTP沿用正式对象契约。05切片2起
        // 检索命中对象为窄读装配，条目级瞬态键（窄读定位/必要来源）不进HTTP契约。
        if let Some(object) = value.as_object_mut() {
            object.remove("structure_dependencies");
            object.remove("structure_coverage");
            object.remove("entries_total");
            object.remove("required_sources");
            object.remove("statement_dependencies");
        }
        for entry in value["entries"].as_array_mut().into_iter().flatten() {
            if let Some(entry) = entry.as_object_mut() {
                entry.remove("structure_gap");
                entry.remove("content_page");
                entry.remove("statement_content");
                entry.remove("statement_dependencies");
            }
        }
        value["maintenance"] =
            access::maintenance_snapshot_in_tx(&mut tx, ctx, value["id"].as_str().unwrap_or(""))
                .await?;
        value["prefill_status"] =
            ingestion::prefill_status_in_tx(&mut tx, ctx, value["id"].as_str().unwrap_or(""))
                .await?;
        value["preparation_status"] = preparation_status_in_tx(&mut tx, ctx, value).await?;
        if let Some(preference) =
            ingestion::read_analysis_preference_in_tx(&mut tx, ctx, value).await?
        {
            value["analysis_preference"] = preference;
        }
    }
    tx.commit().await?;
    Ok(
        json!({"objects":values,"next_after_id":next,"search_coverage":coverage,"retrieval_mode":if searched.as_ref().is_some_and(|result| result.coverage["vector_state"]=="available"){"hybrid_authoritative"}else{"lexical_authoritative"}}),
    )
}
pub async fn read(
    pool: &MySqlPool,
    ctx: &AccessContext,
    object: &str,
    version: Option<u64>,
) -> Result<Value> {
    let mut tx = AppTx::begin(pool).await?;
    let mut v = knowledge::read_in_tx(&mut tx, ctx, object, version, true).await?;
    if version.is_none() {
        v["prefill_status"] = ingestion::prefill_status_in_tx(&mut tx, ctx, object).await?;
        v["preparation_status"] = preparation_status_in_tx(&mut tx, ctx, &v).await?;
        if let Some(preference) =
            ingestion::read_analysis_preference_in_tx(&mut tx, ctx, &v).await?
        {
            v["analysis_preference"] = preference;
        }
    }
    v["maintenance"] = access::maintenance_snapshot_in_tx(&mut tx, ctx, object).await?;
    tx.commit().await?;
    Ok(v)
}

// 整理状态组合：先查对象来源的准备记录，尚无记录（刚排队）再查最近的prepare_source
// 作业状态；错误码只随实际准备进度出现，排队作业没有整理错误，两者皆无为null。
async fn preparation_status_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &Value,
) -> Result<Value> {
    let record = ingestion::preparation_record_status_in_tx(tx, ctx, object).await?;
    if !record.is_null() {
        return Ok(record);
    }
    let Some((source, revision)) = ingestion::preparation_source_of(object) else {
        return Ok(Value::Null);
    };
    Ok(
        jobs::latest_source_job_state_in_tx(tx, "prepare_source", &source, revision)
            .await?
            .map(|state| {
                json!({"source_id":source,"revision":revision.to_string(),"state":state,"error_code":null})
            })
            .unwrap_or(Value::Null),
    )
}
pub async fn source(
    pool: &MySqlPool,
    ctx: &AccessContext,
    source: &str,
    version: u64,
) -> Result<Value> {
    if !ctx.can_read_platform_source(source) {
        return Err(Error::new("not_available"));
    }
    let mut tx = AppTx::begin(pool).await?;
    let v = super::knowledge_sources::read_in_tx(&mut tx, ctx, source, Some(version)).await?;
    tx.commit().await?;
    Ok(v)
}

pub async fn source_excerpt(
    pool: &MySqlPool,
    ctx: &AccessContext,
    citation: Value,
) -> Result<Value> {
    let citation = contracts::decode("SourceCitation", citation)?;
    let mut tx = AppTx::begin(pool).await?;
    let excerpt = super::knowledge_sources::read_citation_in_tx(&mut tx, ctx, citation).await?;
    tx.commit().await?;
    Ok(json!(excerpt))
}

pub async fn set_table_analysis_preference(
    pool: &MySqlPool,
    ctx: &AccessContext,
    table: &str,
    input: AnalysisPreferenceCommand,
) -> Result<Value> {
    let input = json!({"operation_id": input.operation_id, "expected_version": input.expected_version, "preferred": input.preferred});
    let mut tx = AppTx::begin(pool).await?;
    access::authorize_semantic_in_tx(&mut tx, ctx, table).await?;
    let object = knowledge::read_in_tx(&mut tx, ctx, table, None, true).await?;
    if object["kind"] != "table" {
        return Err(Error::new("invalid_input"));
    }
    let (receipt, changed) =
        ingestion::save_analysis_preference_in_tx(&mut tx, ctx, table, &input).await?;
    if changed && receipt["preferred"] == true {
        for object in knowledge::table_objects_in_tx(&mut tx, ctx, table).await? {
            let Some(source) = object["source_id"].as_str() else {
                continue;
            };
            let sources = if source.starts_with("catalog-") {
                let version =
                    ingestion::source_version_in_tx(&mut tx, &ctx.space_id, source).await?;
                vec![ingestion::read_source_in_tx(&mut tx, ctx, source, version).await?]
            } else {
                sources_in_tx(&mut tx, ctx).await?
            };
            super::prefill_materials::queue_in_tx(&mut tx, ctx, &object, sources).await?;
        }
    }
    contracts::validate("TableAnalysisPreference", &receipt)?;
    tx.commit().await?;
    Ok(receipt)
}
pub async fn proposals(pool: &MySqlPool, ctx: &AccessContext) -> Result<Value> {
    let mut tx = AppTx::begin(pool).await?;
    let v = knowledge::proposals_in_tx(&mut tx, ctx).await?;
    tx.commit().await?;
    Ok(json!({"proposals":v}))
}
pub async fn sync(pool: &MySqlPool, ctx: &AccessContext, key: &str) -> Result<Value> {
    access::authorize_maintainer(ctx)?;
    super::catalog_import::sync(pool, ctx, key).await
}

pub(super) async fn valid_assets_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    items: Vec<Value>,
    gate: Option<&super::source_limits::SourceGate>,
) -> Result<Vec<Value>> {
    let ids = items
        .iter()
        .flat_map(|asset| super::context_authority::items(&asset["dependencies"]))
        .map(|reference| {
            reference["object_id"]
                .as_str()
                .map(str::to_owned)
                .ok_or(Error::new("unavailable"))
        })
        .collect::<Result<std::collections::BTreeSet<_>>>()?;
    let ids: Vec<_> = ids.into_iter().collect();
    let mut versions = std::collections::HashMap::new();
    for object in knowledge::candidate_meta_in_tx(tx, ctx, &ids, None).await? {
        if object["state"] == "enabled"
            && gate
                .map(|gate| gate.allows_object(&object))
                .transpose()?
                .unwrap_or(true)
        {
            let key = super::context_authority::pair(&object["id"], &object["version"])?;
            versions.insert(key.0, key.1);
        }
    }
    let mut allowed = Vec::new();
    for asset in items {
        let dependencies = super::context_authority::items(&asset["dependencies"]);
        let valid = dependencies.iter().try_fold(
            gate.is_none() || !dependencies.is_empty(),
            |valid, reference| {
                let id = reference["object_id"]
                    .as_str()
                    .ok_or(Error::new("unavailable"))?;
                Ok::<_, Error>(
                    valid
                        && versions
                            .get(id)
                            .is_some_and(|version| reference["version"] == version.as_str()),
                )
            },
        )?;
        if valid {
            allowed.push(asset);
        }
    }
    Ok(allowed)
}

pub async fn read_asset(pool: &MySqlPool, ctx: &AccessContext, asset: &str) -> Result<Value> {
    super::personal_assets::read(pool, ctx, asset).await
}
pub async fn source_head(pool: &MySqlPool, ctx: &AccessContext, source: &str) -> Result<Value> {
    if !ctx.can_read_platform_source(source) {
        return Err(Error::new("not_available"));
    }
    let mut tx = AppTx::begin(pool).await?;
    let v = super::knowledge_sources::read_in_tx(&mut tx, ctx, source, None).await?;
    tx.commit().await?;
    Ok(v)
}

pub async fn effective_in_tx(tx: &mut AppTx<'_>, ctx: &AccessContext) -> Result<Vec<Value>> {
    let all = knowledge::list_in_tx(tx, ctx, true).await?;
    let mut valid = Vec::new();
    for v in all {
        if assert_source_in_tx(tx, ctx, &v).await.is_ok() {
            valid.push(v);
        }
    }
    Ok(valid)
}

// 统一公共索引消费者：knowledge拥有的公共待办同时承载知识对象与原文来源目标。
// 领取事务内按目标类型分派owner读接口；分段、Embedding与向量写入在锁外，
// 每批回短事务核租约代次、原修订与实际集合身份后记录投影进度。
pub enum SearchHit {
    Knowledge {
        record: String,
        score: f64,
        content: Value,
    },
    SourceExcerpt {
        records: Vec<String>,
        score: f64,
        content: Value,
    },
}
impl SearchHit {
    /// 最终回执保留该 hit 时，必须一起确认其中所有原始规范成员。
    pub fn record_keys(&self) -> Vec<String> {
        match self {
            Self::Knowledge { record, .. } => vec![record.clone()],
            Self::SourceExcerpt { records, .. } => records.clone(),
        }
    }
}
pub struct KnowledgeSearch {
    pub objects: Vec<Value>,
    pub hits: Vec<SearchHit>,
    pub pending: Vec<Value>,
    pub coverage: Value,
    pub scan_progress: Value,
    pub continuation: Option<SearchContinuation>,
}
impl KnowledgeSearch {
    /// 仅在最终裁剪之后传入仍可见 hit 的 record_keys；整项裁掉不能确认其成员。
    pub fn snapshot(
        &self,
        delivered_records: &[String],
        max_bytes: usize,
    ) -> Result<Option<String>> {
        self.continuation.as_ref().map_or(Ok(None), |saved| {
            saved.snapshot(delivered_records, max_bytes)
        })
    }
}
#[cfg(test)]
mod window_lifetime_tests {
    use super::*;

    fn scan_with_pending_shard() -> retrieval::vector::ScanSnapshot {
        serde_json::from_value(json!({
            "i": {"target": null, "projection": crate::types::KNOWLEDGE_PROJECTION,
                  "segmentation": source_segments::SEGMENTATION_VERSION},
            "c": [null, {"b": "0".repeat(64), "s": [[0, 0]]}, null, null]
        }))
        .expect("scan snapshot")
    }
    fn knowledge_candidate(sequence: usize) -> SavedCandidate {
        SavedCandidate::Knowledge(
            format!("obj-{sequence}"),
            "1".into(),
            format!("record-{sequence}"),
            vec![SavedLocation {
                entry_id: Some("body".into()),
                path: Some("body".into()),
                statement_id: None,
                statement_offset: None,
                offset: Some(0),
                length: Some(8),
                content_hash: None,
            }],
        )
    }
    fn continuation_with(records: Vec<SavedCandidate>, retired: Vec<usize>) -> SearchContinuation {
        SearchContinuation {
            space: None,
            schema: 1,
            scan: scan_with_pending_shard(),
            records,
            channels: std::array::from_fn(|_| vec![]),
            sql: [(0, false, true); 2],
            retired,
            sql_active: false,
        }
    }

    // R07纯类型层：跨窗累计退休身份超过1000且仍有后窗时，旧全查询history累加在
    // 固定终点报tool_response_capacity；窗口生命周期语义须释放去重记录并继续编码。
    #[test]
    fn window_exhaustion_releases_dedup_beyond_1000_retirees() {
        let first: Vec<_> = (0..1000).map(knowledge_candidate).collect();
        let saved = continuation_with(first, (0..1000).collect());
        let encoded = saved
            .snapshot(&[], SEARCH_CURSOR_BYTES)
            .expect("首窗1000项全交付后仍须可编码游标")
            .expect("扫描仍有后窗");
        let restored = SearchContinuation::decode(&encoded).expect("释放后的游标可恢复");
        assert!(
            restored.records.is_empty() && restored.retired.is_empty(),
            "窗口耗尽即释放成员状态"
        );
        assert!(restored.scan.has_more());
        // 后继窗再交1000项：跨窗累计退休2000越过旧全局1000门，游标仍可推进。
        let mut next = restored;
        next.records = (1000..2000).map(knowledge_candidate).collect();
        next.retired = (0..1000).collect();
        let again = next
            .snapshot(&[], SEARCH_CURSOR_BYTES)
            .expect("后继窗耗尽仍须可编码")
            .expect("仍有后窗");
        assert!(
            SearchContinuation::decode(&again)
                .unwrap()
                .records
                .is_empty()
        );
    }

    // 旧cursor薄转换：本窗成员命中旧全查询去重记录时并入本窗retired，随后释放
    // 全查询history；不能直接清空导致当前窗旧抑制成员重新交付。
    #[test]
    fn legacy_cursor_history_joins_window_retired_then_releases() {
        let key = "k:record-0";
        let wire = json!({
            "v": 1,
            "s": {"i": {"target": null, "projection": crate::types::KNOWLEDGE_PROJECTION,
                        "segmentation": source_segments::SEGMENTATION_VERSION},
                  "c": [null, {"b": "0".repeat(64), "s": [[0, 0]]}, null, null]},
            "r": [
                {"k": ["obj-0", "1", "record-0", [{"e": "body", "p": "body", "o": 0, "l": 8}]]},
                {"k": ["obj-1", "1", "record-1", [{"e": "body", "p": "body", "o": 0, "l": 8}]]}
            ],
            "c": [[], [], [], [], []],
            "q": [[0, false, true], [0, false, true]],
            "d": [],
            "a": false,
            "h": [fingerprint(&json!(key))]
        });
        let encoded = serde_json::to_string(&wire).expect("旧形状可编码");
        let restored = SearchContinuation::decode(&encoded).expect("旧cursor薄转换");
        assert!(
            restored.suppresses(key),
            "命中旧history的本窗成员并入retired"
        );
        assert!(!restored.suppresses("k:record-1"));
        let cursor = restored
            .snapshot(&["k:record-1".to_string()], SEARCH_CURSOR_BYTES)
            .expect("释放后游标继续推进")
            .expect("仍有后窗");
        assert!(
            SearchContinuation::decode(&cursor)
                .unwrap()
                .records
                .is_empty()
        );
    }

    // 跨新窗允许同身份重现：已结束窗口不再抑制后续窗口候选；同窗内不重不漏
    // 仍由retired成员状态保证。
    #[test]
    fn released_window_does_not_suppress_later_window_members() {
        let first = continuation_with(vec![knowledge_candidate(0)], vec![0]);
        let encoded = first
            .snapshot(&[], SEARCH_CURSOR_BYTES)
            .expect("窗口耗尽可编码")
            .expect("仍有后窗");
        let mut later = SearchContinuation::decode(&encoded).unwrap();
        later.records = vec![knowledge_candidate(0)];
        assert!(
            !later.suppresses(&knowledge_candidate(0).key()),
            "跨窗重现不再被全查询history抑制"
        );
    }
}
