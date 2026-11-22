use crate::{
    contracts,
    modules::{access, assets, conversations},
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

pub(super) fn skill_authority(asset: &Value) -> Value {
    let mut authority = context_authority::from_sources(&json!({
        "knowledge_refs": asset["dependencies"],
    }));
    if let Some(sources) = asset.get("skill_sources") {
        for key in ["source_skills", "source_query_results"] {
            authority[key] = sources[key].clone();
        }
    }
    authority
}

pub(super) async fn checked_skills<'a>(
    pool: &MySqlPool,
    ctx: &AccessContext,
    assets: impl Iterator<Item = &'a Value>,
) -> Result<CheckedTextResults> {
    let authorities = assets
        .filter(|asset| asset.get("skill_sources").is_some())
        .map(skill_authority)
        .collect::<Vec<_>>();
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
    checked_skills(
        pool,
        ctx,
        selected.iter().filter(|asset| {
            ids.is_none_or(|ids| ids.contains(&asset["id"].as_str().expect("saved Skill ID")))
        }),
    )
    .await
}

pub(super) async fn validate_skill_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    asset: &Value,
    checked: &CheckedTextResults,
) -> Result<Value> {
    let mut authority = skill_authority(asset);
    let refs =
        context_authority::validate_in_tx(tx, ctx, &authority, AuthorityUse::Text(checked)).await?;
    context_authority::observe(&mut authority, &json!(refs));
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
        .map(|reference| reference[0].as_str().expect("saved ancestor ID").to_owned())
        .collect::<std::collections::BTreeSet<_>>();
    let enabled =
        assets::enabled_sources_in_tx(tx, ctx, &ids.into_iter().collect::<Vec<_>>()).await?;
    let dependency_ids = enabled
        .values()
        .flatten()
        .map(|reference| {
            reference["object_id"]
                .as_str()
                .expect("saved knowledge ID")
                .to_owned()
        })
        .collect::<std::collections::BTreeSet<_>>();
    let knowledge = crate::modules::knowledge::current_versions_in_tx(
        tx,
        ctx,
        &dependency_ids.into_iter().collect::<Vec<_>>(),
    )
    .await?;
    assets.retain(|asset| {
        asset.get("skill_sources").is_none_or(|_| {
            let authority = skill_authority(asset);
            checked.allows(&authority, false)
                && context_authority::items(&authority["source_skills"])
                    .iter()
                    .all(|reference| {
                        enabled
                            .get(&(
                                reference[0].as_str().expect("saved ancestor ID").to_owned(),
                                reference[1]
                                    .as_str()
                                    .expect("saved ancestor version")
                                    .to_owned(),
                            ))
                            .is_some_and(|dependencies| {
                                dependencies.iter().all(|reference| {
                                    knowledge.get(&(
                                        reference["object_id"]
                                            .as_str()
                                            .expect("saved knowledge ID")
                                            .to_owned(),
                                        reference["version"]
                                            .as_str()
                                            .expect("saved knowledge version")
                                            .to_owned(),
                                    )) == Some(&true)
                                })
                            })
                    })
        })
    });
    Ok(())
}

fn hide_skill(asset: &mut Value) {
    for field in ["name", "scope"] {
        asset[field] = json!("来源不可用，正文已隐藏");
    }
    for field in ["body", "source_text"] {
        asset[field] = json!("");
    }
    for field in ["files", "dependencies"] {
        asset[field] = json!([]);
    }
    asset["text_unavailable"] = json!(true);
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
        hide_skill(asset);
    }
    asset
        .as_object_mut()
        .expect("stored asset")
        .remove("skill_sources");
    Ok(())
}

pub(super) async fn project_receipt(
    pool: &MySqlPool,
    ctx: &AccessContext,
    mut asset: Value,
) -> Result<Value> {
    if asset["kind"] != "skill" {
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
            .expect("stored draft")
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
    let can_admin = access::is_super_maintainer(ctx)?;
    for asset in &mut v {
        asset["can_edit"] = json!(assets::can_edit(ctx, asset, can_admin));
        if asset["state"] == "draft" {
            // 草稿目录不交付模型生成的正文、标题或范围。
            hide_skill(asset);
            asset["name"] = json!("待核对的 Skill");
            asset["scope"] = json!("打开核对后查看适用范围");
            let draft = asset.as_object_mut().expect("stored draft");
            draft.remove("skill_sources");
            draft.remove("text_unavailable");
        } else if asset["kind"] == "skill" {
            project_skill_in_tx(&mut tx, ctx, asset, &checked).await?;
        }
    }
    tx.commit().await?;
    Ok(json!({"assets":v}))
}
pub async fn save(pool: &MySqlPool, ctx: &AccessContext, input: Value) -> Result<Value> {
    contracts::validate("AssetSave", &input)?;
    if input.get("draft_id").is_some() {
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
    input: Value,
    state: &str,
) -> Result<Value> {
    contracts::validate("VersionCommand", &input)?;
    if !matches!(state, "enabled" | "disabled" | "deleted") {
        return Err(Error::new("invalid_input"));
    }
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
    input: Value,
) -> Result<Value> {
    contracts::validate("SkillSelection", &input)?;
    let mut tx = AppTx::begin(pool).await?;
    let item = assets::read_with_sources_in_tx(
        &mut tx,
        ctx,
        input["asset_id"].as_str().expect("checked asset ID"),
        true,
    )
    .await;
    tx.commit().await?;
    let checked = match item {
        Ok(item) => checked_skills(pool, ctx, std::iter::once(&item)).await?,
        Err(error) if unavailable_text(&error) => CheckedTextResults::default(),
        Err(error) => return Err(error),
    };
    let mut tx = AppTx::begin(pool).await?;
    let conversation = conversations::lock_conversation_in_tx(&mut tx, ctx, cid).await?;
    if let Some(mut receipt) = assets::begin_selection_in_tx(&mut tx, ctx, cid, &input).await? {
        // 原选用回执保持成功，过时正文不再交付。
        match assets::read_with_sources_in_tx(
            &mut tx,
            ctx,
            receipt["id"].as_str().expect("saved skill ID"),
            true,
        )
        .await
        {
            Ok(current) if receipt["version"] == current["version"] => {
                let mut current = current;
                project_skill_in_tx(&mut tx, ctx, &mut current, &checked).await?;
                if current["text_unavailable"] == true {
                    hide_skill(&mut receipt);
                }
            }
            Ok(_) => hide_skill(&mut receipt),
            Err(error) if unavailable_text(&error) => hide_skill(&mut receipt),
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
        v["id"].as_str().expect("selected skill ID"),
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
    input: Value,
) -> Result<Value> {
    contracts::validate("SkillSelectionRemoval", &input)?;
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
    input: Value,
) -> Result<Value> {
    contracts::validate("PublishSkill", &input)?;
    let mut tx = AppTx::begin(pool).await?;
    let item = assets::read_with_sources_in_tx(&mut tx, ctx, asset, false).await?;
    tx.commit().await?;
    let checked = checked_skills(pool, ctx, std::iter::once(&item)).await?;
    let mut tx = AppTx::begin(pool).await?;
    let value = assets::publish_in_tx(&mut tx, ctx, asset, &input).await?;
    let published = assets::read_with_sources_in_tx(
        &mut tx,
        ctx,
        value["id"].as_str().expect("published asset ID"),
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
    input: Value,
) -> Result<Value> {
    contracts::validate("SuggestSkill", &input)?;
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
    input: Value,
) -> Result<Value> {
    contracts::validate("ReviewSkillSuggestion", &input)?;
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
    context_authority::merge_run_in_tx(tx, run, &authority).await?;
    assets::record_adoption_in_tx(tx, ctx, run, &asset, "read").await?;
    Ok(
        json!({"id":id,"kind":"skill","version":version,"path":path,"text":text,
        "knowledge_refs":asset["dependencies"]}),
    )
}
