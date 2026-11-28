use crate::{
    contracts::generated::{
        AssetSave, AssetState, PublishSkill, ReviewSkillSuggestion, SkillSelection,
        SkillSelectionRemoval, SuggestSkill, VersionCommand,
    },
    modules::{access, analysis, assets, conversations, runtime},
    persistence::AppTx,
    types::{AccessContext, Error, Result},
};
use serde_json::{Value, json};
use sqlx::MySqlPool;

use super::context_authority::{self, AuthorityUse, CheckedTextResults};

pub(super) fn unavailable_text(error: &Error) -> bool {
    matches!(
        error.code,
        "stale_context"
            | "stale_knowledge"
            | "not_available"
            | "forbidden"
            | "result_expired"
            | "result_unavailable"
    )
}

pub(super) fn skill_authority(asset: &Value) -> Result<Value> {
    let mut authority = context_authority::from_sources(&json!({
        "knowledge_refs": asset["dependencies"],
    }))?;
    if let Some(sources) = asset.get("skill_sources") {
        for key in ["source_skills", "source_query_results"] {
            authority[key] = sources[key].clone();
        }
    }
    Ok(authority)
}

pub(super) async fn read_skill_authority_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    cid: &str,
    recovery_chain: &str,
    active_run: Option<&str>,
) -> Result<Value> {
    let snapshot = match active_run {
        Some(run_id) => runtime::read_authority_in_tx(tx, run_id).await?,
        None => None,
    };
    let references =
        if let Some(reads) = snapshot.as_ref().and_then(|s| s.get("active_skill_reads")) {
            let mut references = reads.as_array().ok_or(Error::new("stale_context"))?.clone();
            // 续聊沿用的 Pi 分支仍留有此前各轮的工具正文，跨轮保留的精读同样要在途核对。
            if let Some(snapshot) = &snapshot {
                for reference in context_authority::items(&snapshot["source_skills"]) {
                    if !references.contains(reference) {
                        references.push(reference.clone());
                    }
                }
            }
            references
        } else {
            // 旧检查点未分开保存目录和精读，仍沿原回执核对。
            let mut references = runtime::read_skill_sources_in_tx(tx, cid, recovery_chain).await?;
            if let Some(snapshot) = &snapshot {
                references.retain(|r| context_authority::items(&snapshot["skills"]).contains(r));
            }
            references
        };
    let ids = references
        .iter()
        .map(|reference| context_authority::pair(&reference[0], &reference[1]))
        .collect::<Result<Vec<_>>>()?;
    let current = assets::read_enabled_in_tx(
        tx,
        ctx,
        &ids.iter().map(|(id, _)| id.clone()).collect::<Vec<_>>(),
    )
    .await?;
    let mut authority = context_authority::empty();
    for ((id, version), reference) in ids.into_iter().zip(references) {
        let asset = current
            .get(&id)
            .filter(|asset| asset["version"] == version)
            .ok_or(Error::new("stale_context"))?;
        context_authority::merge(&mut authority, &skill_authority(asset)?)?;
        let sources = authority["source_skills"]
            .as_array_mut()
            .ok_or(Error::new("unavailable"))?;
        if !sources.contains(&reference) {
            sources.push(reference);
        }
    }
    Ok(authority)
}

pub(super) async fn assert_read_skill_authority_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    authority: &Value,
    checked: &CheckedTextResults,
) -> Result<()> {
    context_authority::validate_in_tx(tx, ctx, authority, AuthorityUse::Text(checked))
        .await
        .map(|_| ())
        .map_err(|error| {
            if unavailable_text(&error) || error.code == "stale_source" {
                Error::new("stale_context")
            } else {
                error
            }
        })
}

pub(super) async fn checked_skills<'a>(
    pool: &MySqlPool,
    ctx: &AccessContext,
    assets: impl Iterator<Item = &'a Value>,
) -> Result<CheckedTextResults> {
    let authorities = assets
        .filter(|asset| asset.get("skill_sources").is_some())
        .map(skill_authority)
        .collect::<Result<Vec<_>>>()?;
    let mut checked = CheckedTextResults::default();
    checked.include(pool, ctx, &authorities, false).await?;
    Ok(checked)
}

pub(super) async fn checked_selected_skills(
    pool: &MySqlPool,
    ctx: &AccessContext,
    conversation: &str,
    ids: Option<&[&str]>,
) -> Result<CheckedTextResults> {
    let mut tx = AppTx::begin(pool).await?;
    let selected = assets::selected_in_tx(&mut tx, ctx, conversation).await?;
    tx.commit().await?;
    let assets = selected
        .iter()
        .filter_map(|asset| {
            let Some(ids) = ids else {
                return Some(Ok(asset));
            };
            match asset["id"].as_str() {
                Some(id) if ids.contains(&id) => Some(Ok(asset)),
                Some(_) => None,
                None => Some(Err(Error::new("unavailable"))),
            }
        })
        .collect::<Result<Vec<_>>>()?;
    checked_skills(pool, ctx, assets.into_iter()).await
}

pub(super) async fn validate_skill_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    asset: &Value,
    checked: &CheckedTextResults,
) -> Result<Value> {
    let mut authority = skill_authority(asset)?;
    let refs =
        context_authority::validate_in_tx(tx, ctx, &authority, AuthorityUse::Text(checked)).await?;
    context_authority::observe(&mut authority, &json!(refs))?;
    Ok(authority)
}

pub(super) async fn authorize_skill_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    asset: &Value,
    gate: Option<&super::source_limits::SourceGate>,
    checked: &CheckedTextResults,
) -> Result<Value> {
    super::source_limits::assert_asset_in_tx(tx, ctx, gate, asset).await?;
    let authority = validate_skill_in_tx(tx, ctx, asset, checked).await?;
    if let Some(gate) = gate
        && asset.get("skill_sources").is_some()
        && !super::source_limits::authority_within_in_tx(tx, ctx, gate, &authority).await?
    {
        return Err(Error::new("source_not_allowed"));
    }
    Ok(authority)
}

pub(super) async fn retain_authorized_skills_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    assets: &mut Vec<Value>,
    checked: &CheckedTextResults,
) -> Result<()> {
    let ids = assets
        .iter()
        .flat_map(|asset| context_authority::items(&asset["skill_sources"]["source_skills"]))
        .map(|reference| {
            reference[0]
                .as_str()
                .map(str::to_owned)
                .ok_or(Error::new("unavailable"))
        })
        .collect::<Result<std::collections::BTreeSet<_>>>()?;
    let enabled =
        assets::enabled_sources_in_tx(tx, ctx, &ids.into_iter().collect::<Vec<_>>()).await?;
    let dependency_ids = enabled
        .values()
        .flatten()
        .map(|reference| {
            reference["object_id"]
                .as_str()
                .map(str::to_owned)
                .ok_or(Error::new("unavailable"))
        })
        .collect::<Result<std::collections::BTreeSet<_>>>()?;
    let knowledge = crate::modules::knowledge::current_versions_in_tx(
        tx,
        ctx,
        &dependency_ids.into_iter().collect::<Vec<_>>(),
    )
    .await?;
    let mut visible_ancestors = std::collections::BTreeSet::new();
    for (ancestor, dependencies) in enabled {
        let visible = dependencies.iter().try_fold(true, |visible, reference| {
            let dependency =
                context_authority::pair(&reference["object_id"], &reference["version"])?;
            Ok::<_, Error>(visible && knowledge.get(&dependency) == Some(&true))
        })?;
        if visible {
            visible_ancestors.insert(ancestor);
        }
    }
    for asset in std::mem::take(assets) {
        if asset.get("skill_sources").is_some() {
            let authority = skill_authority(&asset)?;
            if !checked.allows(&authority, false) {
                continue;
            }
            let allowed = context_authority::items(&authority["source_skills"])
                .iter()
                .try_fold(true, |allowed, reference| {
                    let key = context_authority::pair(&reference[0], &reference[1])?;
                    Ok::<_, Error>(allowed && visible_ancestors.contains(&key))
                })?;
            if !allowed {
                continue;
            }
        }
        assets.push(asset);
    }
    Ok(())
}

pub(super) async fn project_skill_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    asset: &mut Value,
    checked: &CheckedTextResults,
) -> Result<()> {
    if let Err(error) = validate_skill_in_tx(tx, ctx, asset, checked).await {
        if !unavailable_text(&error) {
            return Err(error);
        }
        assets::hide_skill_text(asset);
    }
    asset
        .as_object_mut()
        .ok_or(crate::types::Error::new("unavailable"))?
        .remove("skill_sources");
    Ok(())
}

pub(super) async fn project_receipt(
    pool: &MySqlPool,
    ctx: &AccessContext,
    mut asset: Value,
) -> Result<Value> {
    if asset["kind"] != "skill"
        || (asset["state"] == "deleted" && asset["text_unavailable"] == true)
    {
        return Ok(asset);
    }
    let mut tx = AppTx::begin(pool).await?;
    if let Some(proof) = assets::version_skill_sources_in_tx(&mut tx, &asset).await? {
        asset["skill_sources"] = proof;
    }
    tx.commit().await?;
    let checked = checked_skills(pool, ctx, std::iter::once(&asset)).await?;
    let mut tx = AppTx::begin(pool).await?;
    project_skill_in_tx(&mut tx, ctx, &mut asset, &checked).await?;
    tx.commit().await?;
    Ok(asset)
}

pub async fn read(pool: &MySqlPool, ctx: &AccessContext, id: &str) -> Result<Value> {
    let mut tx = AppTx::begin(pool).await?;
    let mut item = assets::read_with_sources_in_tx(&mut tx, ctx, id, false).await?;
    tx.commit().await?;
    if item["state"] == "draft" {
        let draft = super::skill_drafts::read(pool, ctx, id).await?;
        if draft["status"] != "pending" {
            return Err(Error::new("stale_context"));
        }
        for key in ["name", "body", "scope", "files", "dependencies"] {
            item[key] = draft[key].clone();
        }
        item.as_object_mut()
            .ok_or(crate::types::Error::new("unavailable"))?
            .remove("skill_sources");
    } else if item["kind"] == "skill" {
        let checked = checked_skills(pool, ctx, std::iter::once(&item)).await?;
        let mut tx = AppTx::begin(pool).await?;
        item = assets::read_with_sources_in_tx(&mut tx, ctx, id, false).await?;
        project_skill_in_tx(&mut tx, ctx, &mut item, &checked).await?;
        tx.commit().await?;
    }
    Ok(item)
}

pub async fn list(pool: &MySqlPool, ctx: &AccessContext) -> Result<Value> {
    let mut tx = AppTx::begin(pool).await?;
    let rows = assets::list_in_tx(&mut tx, ctx, false).await?;
    tx.commit().await?;
    let checked = checked_skills(
        pool,
        ctx,
        rows.iter().filter(|asset| asset["state"] != "draft"),
    )
    .await?;
    let mut tx = AppTx::begin(pool).await?;
    let mut v = assets::list_in_tx(&mut tx, ctx, false).await?;
    let expired = if v.iter().any(|asset| asset["state"] == "draft") {
        let refs = assets::skill_drafts::pending_references_in_tx(&mut tx, ctx).await?;
        let ids = refs
            .iter()
            .map(|reference| reference.task_id.as_str())
            .collect::<Vec<_>>();
        let versions = analysis::active_condition_versions_in_tx(&mut tx, &ids).await?;
        refs.into_iter()
            .filter_map(|reference| {
                (versions.get(&reference.task_id) != Some(&reference.condition_version))
                    .then_some(reference.draft_id)
            })
            .collect::<std::collections::HashSet<_>>()
    } else {
        std::collections::HashSet::new()
    };
    let can_admin = access::is_super_maintainer(ctx)?;
    for asset in &mut v {
        asset["can_edit"] = json!(assets::can_edit(ctx, asset, can_admin));
        if asset["state"] == "draft" {
            // 草稿目录不交付模型生成的正文、标题或范围。
            assets::hide_skill_text(asset);
            asset["name"] = json!("待核对的 Skill");
            asset["scope"] = json!("打开核对后查看适用范围");
            let draft = asset
                .as_object_mut()
                .ok_or(crate::types::Error::new("unavailable"))?;
            draft.remove("skill_sources");
            draft.remove("text_unavailable");
            let draft_id = draft["id"].as_str().ok_or(Error::new("unavailable"))?;
            if expired.contains(draft_id) {
                draft.insert("draft_status".into(), json!("condition_changed"));
                draft.insert("name".into(), json!("已失效的 Skill 草稿"));
                draft.insert("scope".into(), json!("原任务条件已变化或任务已取消"));
            }
        } else if asset["kind"] == "skill" {
            project_skill_in_tx(&mut tx, ctx, asset, &checked).await?;
        }
    }
    tx.commit().await?;
    Ok(json!({"assets":v}))
}
pub async fn save(
    pool: &MySqlPool,
    ctx: &AccessContext,
    request: AssetSave,
    input: Value,
) -> Result<Value> {
    if request.draft_id.is_some() {
        return super::skill_drafts::confirm(pool, ctx, &input).await;
    }
    let mut tx = AppTx::begin(pool).await?;
    let v = if let Some(receipt) = assets::begin_save_in_tx(&mut tx, ctx, &input).await? {
        receipt
    } else {
        super::knowledge::check_adoptable_refs_in_tx(&mut tx, ctx, &input["dependencies"]).await?;
        assets::save_authorized_in_tx(&mut tx, ctx, &input, access::is_super_maintainer(ctx)?)
            .await?
    };
    super::personal_memory::queue_in_tx(&mut tx, ctx, &v, None, None).await?;
    tx.commit().await?;
    project_receipt(pool, ctx, v).await
}
pub async fn state(
    pool: &MySqlPool,
    ctx: &AccessContext,
    asset: &str,
    input: VersionCommand,
    state: AssetState,
) -> Result<Value> {
    let state = match state {
        AssetState::Enabled => "enabled",
        AssetState::Disabled => "disabled",
        AssetState::Deleted => "deleted",
        AssetState::Draft => return Err(Error::new("invalid_input")),
    };
    let input = serde_json::to_value(input).map_err(|_| Error::new("invalid_input"))?;
    let mut tx = AppTx::begin(pool).await?;
    let v = assets::change_state_authorized_in_tx(
        &mut tx,
        ctx,
        asset,
        &input,
        state,
        access::is_super_maintainer(ctx)?,
    )
    .await?;
    super::personal_memory::queue_in_tx(&mut tx, ctx, &v, None, None).await?;
    tx.commit().await?;
    project_receipt(pool, ctx, v).await
}
pub async fn select(
    pool: &MySqlPool,
    ctx: &AccessContext,
    cid: &str,
    request: SkillSelection,
) -> Result<Value> {
    let mut tx = AppTx::begin(pool).await?;
    let item = assets::read_with_sources_in_tx(&mut tx, ctx, &request.asset_id, true).await;
    tx.commit().await?;
    let checked = match item {
        Ok(item) => checked_skills(pool, ctx, std::iter::once(&item)).await?,
        Err(error) if unavailable_text(&error) => CheckedTextResults::default(),
        Err(error) => return Err(error),
    };
    let input = serde_json::to_value(request).map_err(|_| Error::new("invalid_input"))?;
    let mut tx = AppTx::begin(pool).await?;
    let conversation = conversations::lock_conversation_in_tx(&mut tx, ctx, cid).await?;
    if let Some(mut receipt) = assets::begin_selection_in_tx(&mut tx, ctx, cid, &input).await? {
        // 原选用回执保持成功，过时正文不再交付。
        match assets::read_with_sources_in_tx(
            &mut tx,
            ctx,
            receipt["id"]
                .as_str()
                .ok_or(crate::types::Error::new("unavailable"))?,
            true,
        )
        .await
        {
            Ok(current) if receipt["version"] == current["version"] => {
                let mut current = current;
                project_skill_in_tx(&mut tx, ctx, &mut current, &checked).await?;
                if current["text_unavailable"] == true {
                    assets::hide_skill_text(&mut receipt);
                }
            }
            Ok(_) => assets::hide_skill_text(&mut receipt),
            Err(error) if unavailable_text(&error) => assets::hide_skill_text(&mut receipt),
            Err(error) => return Err(error),
        }
        tx.commit().await?;
        return Ok(receipt);
    }
    assert_selection_change_in_tx(&mut tx, &conversation).await?;
    let v = assets::select_in_tx(&mut tx, ctx, cid, &input).await?;
    let current = assets::read_with_sources_in_tx(
        &mut tx,
        ctx,
        v["id"]
            .as_str()
            .ok_or(crate::types::Error::new("unavailable"))?,
        true,
    )
    .await?;
    validate_skill_in_tx(&mut tx, ctx, &current, &checked).await?;
    tx.commit().await?;
    Ok(v)
}

async fn assert_selection_change_in_tx(
    tx: &mut AppTx<'_>,
    conversation: &conversations::LockedConversation,
) -> Result<()> {
    if selection_change_blocked_in_tx(tx, conversation).await? {
        return Err(Error::new("message_pending"));
    }
    Ok(())
}

async fn selection_change_blocked_in_tx(
    tx: &mut AppTx<'_>,
    conversation: &conversations::LockedConversation,
) -> Result<bool> {
    Ok(
        conversation.lease_valid
            || conversations::has_pending_input_in_tx(tx, conversation).await?,
    )
}

pub async fn remove_selection(
    pool: &MySqlPool,
    ctx: &AccessContext,
    cid: &str,
    input: SkillSelectionRemoval,
) -> Result<Value> {
    let input = serde_json::to_value(input).map_err(|_| Error::new("invalid_input"))?;
    let mut tx = AppTx::begin(pool).await?;
    let conversation = conversations::lock_conversation_in_tx(&mut tx, ctx, cid).await?;
    let receipt =
        if let Some(receipt) = assets::begin_removal_in_tx(&mut tx, ctx, cid, &input).await? {
            receipt
        } else {
            assert_selection_change_in_tx(&mut tx, &conversation).await?;
            assets::remove_selection_in_tx(&mut tx, ctx, cid, &input).await?
        };
    tx.commit().await?;
    Ok(receipt)
}

pub async fn publish(
    pool: &MySqlPool,
    ctx: &AccessContext,
    asset: &str,
    input: PublishSkill,
) -> Result<Value> {
    let input = serde_json::to_value(input).map_err(|_| Error::new("invalid_input"))?;
    let mut tx = AppTx::begin(pool).await?;
    let item = assets::read_with_sources_in_tx(&mut tx, ctx, asset, false).await?;
    tx.commit().await?;
    let checked = checked_skills(pool, ctx, std::iter::once(&item)).await?;
    let mut tx = AppTx::begin(pool).await?;
    let value = assets::publish_in_tx(&mut tx, ctx, asset, &input).await?;
    let published = assets::read_with_sources_in_tx(
        &mut tx,
        ctx,
        value["id"]
            .as_str()
            .ok_or(crate::types::Error::new("unavailable"))?,
        false,
    )
    .await?;
    validate_skill_in_tx(&mut tx, ctx, &published, &checked).await?;
    tx.commit().await?;
    Ok(value)
}
pub async fn selections(
    pool: &MySqlPool,
    ctx: &AccessContext,
    cid: &str,
    after: &str,
) -> Result<Value> {
    let mut tx = AppTx::begin(pool).await?;
    conversations::lock_conversation_in_tx(&mut tx, ctx, cid).await?;
    let original = assets::selection_page_in_tx(&mut tx, ctx, cid, after).await?;
    tx.commit().await?;
    let checked = checked_skills(pool, ctx, original.iter().map(|row| &row["asset"])).await?;
    let mut tx = AppTx::begin(pool).await?;
    let conversation = conversations::lock_conversation_in_tx(&mut tx, ctx, cid).await?;
    let change_blocked = selection_change_blocked_in_tx(&mut tx, &conversation).await?;
    let mut rows = assets::selection_page_in_tx(&mut tx, ctx, cid, after).await?;
    let next = if rows.len() > 50 {
        rows.truncate(50);
        rows.last().map(|r| r["asset_id"].clone())
    } else {
        None
    };
    let mut selections = Vec::new();
    for row in rows {
        let asset = &row["asset"];
        let availability = if asset.is_null() {
            "unavailable"
        } else if asset["state"] != "enabled" {
            "disabled"
        } else if asset["version"] != row["selected_version"] {
            "version_changed"
        } else {
            "available"
        };
        let mut asset = asset.clone();
        if !asset.is_null() {
            project_skill_in_tx(&mut tx, ctx, &mut asset, &checked).await?;
        }
        let availability = if availability == "available" && asset["text_unavailable"] == true {
            "dependency_unavailable"
        } else {
            availability
        };
        // name只承载资产身份；可用性由availability表达，删除或越界的资产name为null，
        // 界面侧按自己的fallback文案渲染，不在后端投影里重复。
        selections.push(json!({"selection_id":row["selection_id"],"asset_id":row["asset_id"],"selected_version":row["selected_version"],"current_version":asset["version"],"name":asset["name"].clone(),"visibility":asset["visibility"],"owner_id":asset["owner_id"],"availability":availability}));
    }
    tx.commit().await?;
    Ok(
        json!({"conversation_id":cid,"selections":selections,"next_after_id":next,"change_blocked":change_blocked}),
    )
}
pub async fn suggestions(
    pool: &MySqlPool,
    ctx: &AccessContext,
    asset: &str,
    after: &str,
) -> Result<Value> {
    let mut tx = AppTx::begin(pool).await?;
    let value = assets::suggestions_in_tx(&mut tx, ctx, asset, after).await?;
    tx.commit().await?;
    Ok(value)
}
pub async fn suggest(
    pool: &MySqlPool,
    ctx: &AccessContext,
    asset: &str,
    input: SuggestSkill,
) -> Result<Value> {
    let input = serde_json::to_value(input).map_err(|_| Error::new("invalid_input"))?;
    let mut tx = AppTx::begin(pool).await?;
    let value = assets::suggest_in_tx(&mut tx, ctx, asset, &input).await?;
    tx.commit().await?;
    Ok(value)
}
pub async fn review_suggestion(
    pool: &MySqlPool,
    ctx: &AccessContext,
    asset: &str,
    suggestion: &str,
    input: ReviewSkillSuggestion,
) -> Result<Value> {
    let input = serde_json::to_value(input).map_err(|_| Error::new("invalid_input"))?;
    let mut tx = AppTx::begin(pool).await?;
    let value = assets::review_suggestion_in_tx(
        &mut tx,
        ctx,
        asset,
        suggestion,
        &input,
        access::is_super_maintainer(ctx)?,
    )
    .await?;
    tx.commit().await?;
    Ok(value)
}

pub(super) async fn read_skill_file_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    conv: &crate::modules::conversations::LockedConversation,
    run: &str,
    path: &str,
    gate: Option<&super::source_limits::SourceGate>,
    checked: &CheckedTextResults,
) -> Result<Value> {
    let cid = conv.id.as_str();
    let (id, version, file) = assets::skill_files::parse_location(path)?;
    let asset = assets::read_with_sources_in_tx(tx, ctx, id, true).await?;
    if asset["kind"] != "skill" || asset["version"] != version {
        return Err(Error::new("stale_knowledge"));
    }
    if !assets::selected_in_tx(tx, ctx, cid)
        .await?
        .iter()
        .any(|v| v["id"] == id && v["version"] == version)
    {
        return Err(Error::new("selection_required"));
    }
    let authority = authorize_skill_in_tx(tx, ctx, &asset, gate, checked).await?;
    let text = assets::skill_files::content(&asset, file)?;
    context_authority::record_skill_read_in_tx(tx, run, authority, &asset).await?;
    assets::record_adoption_in_tx(tx, ctx, run, &asset, "read").await?;
    Ok(
        json!({"id":id,"kind":"skill","version":version,"path":path,"text":text,
        "knowledge_refs":asset["dependencies"]}),
    )
}
