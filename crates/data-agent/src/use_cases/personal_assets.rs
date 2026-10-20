use crate::{
    contracts,
    modules::{access, assets, conversations, runtime},
    persistence::AppTx,
    types::{AccessContext, Error, Result},
};
use serde_json::{Value, json};
use sqlx::MySqlPool;
type CheckedText = super::context_authority::CheckedTextResults;

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

pub async fn ensure_field_authorities_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    asset: &Value,
) -> Result<()> {
    let id = asset["id"].as_str().ok_or(Error::new("invalid_input"))?;
    if let Some(operations) =
        assets::legacy_operation_ids_in_tx(tx, ctx, id, &asset["version"]).await?
    {
        let model_operations = runtime::recorded_tool_operations_in_tx(tx, &operations).await?;
        assets::materialize_field_authorities_in_tx(
            tx,
            ctx,
            id,
            &asset["version"],
            &model_operations,
        )
        .await?;
    }
    Ok(())
}

/// 私有字段归属不进入公开资产；缺失来源不能按空依赖交付。
pub async fn authorities_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    asset: &Value,
) -> Result<Vec<Value>> {
    ensure_field_authorities_in_tx(tx, ctx, asset).await?;
    let fields = assets::read_field_authorities_in_tx(
        tx,
        ctx,
        asset["id"].as_str().ok_or(Error::new("invalid_input"))?,
        &asset["version"],
    )
    .await?;
    let mut authorities = Vec::new();
    for field in assets::TEXT_FIELDS {
        match fields[field]["origin"].as_str() {
            Some("user") => (),
            Some("generated") => {
                let authority = fields[field]["authority"].clone();
                super::context_authority::merge(
                    &mut super::context_authority::empty(),
                    &authority,
                )?;
                authorities.push(authority);
            }
            _ => return Err(Error::new("stale_context")),
        }
    }
    Ok(authorities)
}

pub async fn text_authority_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    cid: &str,
    asset: &Value,
    checked: &CheckedText,
) -> Result<Value> {
    super::knowledge::check_refs_in_tx(tx, ctx, &asset["dependencies"]).await?;
    field_text_authority_in_tx(tx, ctx, cid, asset, checked).await
}

async fn field_text_authority_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    cid: &str,
    asset: &Value,
    checked: &CheckedText,
) -> Result<Value> {
    let mut authority = super::context_authority::empty();
    for source in authorities_in_tx(tx, ctx, asset).await? {
        super::context_authority::validate_text_in_tx(tx, ctx, cid, &source, checked).await?;
        super::context_authority::merge(&mut authority, &source)?;
    }
    Ok(authority)
}

pub async fn checked_assets(
    pool: &MySqlPool,
    ctx: &AccessContext,
    items: &[Value],
) -> Result<CheckedText> {
    let mut tx = AppTx::begin(pool).await?;
    let mut authorities = Vec::new();
    for asset in items {
        match authorities_in_tx(&mut tx, ctx, asset).await {
            Ok(sources) => authorities.extend(sources),
            Err(error) if unavailable_text(&error) => (),
            Err(error) => return Err(error),
        }
    }
    tx.commit().await?;
    let mut checked = CheckedText::default();
    checked.include_authorities(pool, ctx, &authorities).await?;
    Ok(checked)
}

pub async fn project_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    asset: &mut Value,
    checked: &CheckedText,
) -> Result<()> {
    match field_text_authority_in_tx(tx, ctx, "", asset, checked).await {
        Ok(_) => (),
        Err(error) if unavailable_text(&error) => {
            asset["name"] = json!("来源不可用，正文已隐藏");
            asset["scope"] = json!("来源不可用，正文已隐藏");
            asset["body"] = json!("");
            asset["source_text"] = json!("");
            asset["files"] = json!([]);
            asset["dependencies"] = json!([]);
            asset["text_unavailable"] = json!(true);
        }
        Err(error) => return Err(error),
    }
    Ok(())
}

pub async fn name_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    asset: &Value,
    checked: &CheckedText,
) -> Result<Value> {
    ensure_field_authorities_in_tx(tx, ctx, asset).await?;
    let fields = assets::read_field_authorities_in_tx(
        tx,
        ctx,
        asset["id"].as_str().ok_or(Error::new("invalid_input"))?,
        &asset["version"],
    )
    .await?;
    let source = match fields["name"]["origin"].as_str() {
        Some("user") => super::context_authority::empty(),
        Some("generated") => fields["name"]["authority"].clone(),
        _ => Value::Null,
    };
    match super::context_authority::validate_text_in_tx(tx, ctx, "", &source, checked).await {
        Ok(()) => Ok(asset["name"].clone()),
        Err(error) if unavailable_text(&error) => Ok(json!("来源不可用，正文已隐藏")),
        Err(error) => Err(error),
    }
}

pub async fn read(pool: &MySqlPool, ctx: &AccessContext, id: &str) -> Result<Value> {
    let mut tx = AppTx::begin(pool).await?;
    let item = assets::read_in_tx(&mut tx, ctx, id, false).await?;
    tx.commit().await?;
    let checked = checked_assets(pool, ctx, &[item]).await?;
    let mut tx = AppTx::begin(pool).await?;
    let mut item = assets::read_in_tx(&mut tx, ctx, id, false).await?;
    project_in_tx(&mut tx, ctx, &mut item, &checked).await?;
    tx.commit().await?;
    Ok(item)
}

pub(super) async fn project_receipt(
    pool: &MySqlPool,
    ctx: &AccessContext,
    mut asset: Value,
) -> Result<Value> {
    let checked = checked_assets(pool, ctx, std::slice::from_ref(&asset)).await?;
    let mut tx = AppTx::begin(pool).await?;
    project_in_tx(&mut tx, ctx, &mut asset, &checked).await?;
    tx.commit().await?;
    Ok(asset)
}

pub async fn list(pool: &MySqlPool, ctx: &AccessContext) -> Result<Value> {
    let mut tx = AppTx::begin(pool).await?;
    let items = assets::list_in_tx(&mut tx, ctx, false).await?;
    tx.commit().await?;
    let checked = checked_assets(pool, ctx, &items).await?;
    let mut tx = AppTx::begin(pool).await?;
    let mut v = assets::list_in_tx(&mut tx, ctx, false).await?;
    let can_admin = access::is_super_maintainer(ctx)?;
    for asset in &mut v {
        asset["can_edit"] = json!(assets::can_edit(ctx, asset, can_admin));
        project_in_tx(&mut tx, ctx, asset, &checked).await?;
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
        if let Some(id) = input["id"].as_str() {
            let old = assets::read_in_tx(&mut tx, ctx, id, false).await?;
            ensure_field_authorities_in_tx(&mut tx, ctx, &old).await?;
        }
        super::knowledge::check_refs_in_tx(&mut tx, ctx, &input["dependencies"]).await?;
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
    // 源正文失效不阻止启停/删除；这里只恢复归属证据，不要求正文可采用。
    match assets::read_in_tx(&mut tx, ctx, asset, false).await {
        Ok(old) => ensure_field_authorities_in_tx(&mut tx, ctx, &old).await?,
        // 删除后仍允许同一成功操作取回原回执，由状态入口先核幂等身份。
        Err(error) if error.code == "not_available" => (),
        Err(error) => return Err(error),
    }
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
    let item = read(
        pool,
        ctx,
        input["asset_id"]
            .as_str()
            .ok_or(Error::new("invalid_input"))?,
    )
    .await?;
    if item["text_unavailable"] == true {
        return Err(Error::new("stale_context"));
    }
    let checked = checked_assets(pool, ctx, &[item]).await?;
    let mut tx = AppTx::begin(pool).await?;
    let conversation = conversations::lock_conversation_in_tx(&mut tx, ctx, cid).await?;
    let v = if let Some(receipt) = assets::begin_selection_in_tx(&mut tx, ctx, cid, &input).await? {
        receipt
    } else {
        assert_selection_change_in_tx(&mut tx, &conversation).await?;
        let value = assets::select_in_tx(&mut tx, ctx, cid, &input).await?;
        super::knowledge::check_refs_in_tx(&mut tx, ctx, &value["dependencies"]).await?;
        value
    };
    text_authority_in_tx(&mut tx, ctx, cid, &v, &checked).await?;
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
    let source = read(pool, ctx, asset).await?;
    if source["text_unavailable"] == true {
        return Err(Error::new("stale_context"));
    }
    let checked = checked_assets(pool, ctx, &[source]).await?;
    let mut tx = AppTx::begin(pool).await?;
    let source = assets::read_in_tx(&mut tx, ctx, asset, false).await?;
    text_authority_in_tx(&mut tx, ctx, "", &source, &checked).await?;
    let value = assets::publish_in_tx(&mut tx, ctx, asset, &input).await?;
    super::knowledge::check_refs_in_tx(&mut tx, ctx, &value["dependencies"]).await?;
    tx.commit().await?;
    project_receipt(pool, ctx, value).await
}
pub async fn selections(
    pool: &MySqlPool,
    ctx: &AccessContext,
    cid: &str,
    after: &str,
) -> Result<Value> {
    let mut tx = AppTx::begin(pool).await?;
    conversations::lock_conversation_in_tx(&mut tx, ctx, cid).await?;
    let before = assets::selection_page_in_tx(&mut tx, ctx, cid, after).await?;
    tx.commit().await?;
    let checked = checked_assets(
        pool,
        ctx,
        &before
            .iter()
            .filter(|row| row["asset"].is_object())
            .map(|row| row["asset"].clone())
            .collect::<Vec<_>>(),
    )
    .await?;
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
            match text_authority_in_tx(&mut tx, ctx, cid, asset, &checked).await {
                Ok(_) => "available",
                Err(e) if unavailable_text(&e) => "dependency_unavailable",
                Err(e) => return Err(e),
            }
        };
        selections.push(json!({"selection_id":row["selection_id"],"asset_id":row["asset_id"],"selected_version":row["selected_version"],"current_version":asset["version"],"name":if availability == "available" { asset["name"].clone() } else { json!("Skill 当前不可用") },"visibility":asset["visibility"],"owner_id":asset["owner_id"],"availability":availability}));
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

pub async fn read_skill_file_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    cid: &str,
    run: &str,
    path: &str,
    checked: &CheckedText,
) -> Result<Value> {
    let (id, version, file) = assets::skill_files::parse_location(path)?;
    let asset = assets::read_in_tx(tx, ctx, id, true).await?;
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
    let authority = text_authority_in_tx(tx, ctx, cid, &asset, checked).await?;
    super::context_authority::merge_run_in_tx(tx, run, &authority).await?;
    let text = assets::skill_files::content(&asset, file)?;
    assets::record_adoption_in_tx(tx, ctx, run, &asset, "read").await?;
    Ok(json!({"id":id,"kind":"skill","version":version,"path":path,"text":text}))
}
