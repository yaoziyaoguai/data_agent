use crate::{
    contracts,
    modules::{access, knowledge},
    persistence::AppTx,
    types::{AccessContext, Error, Result, epoch, id},
};
use serde_json::{Value, json};
use sqlx::MySqlPool;

pub async fn register_object_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &Value,
) -> Result<()> {
    let object_id = object["id"].as_str().ok_or(Error::new("invalid_input"))?;
    let mut authority = object_id.to_owned();
    if object["kind"] == "field" {
        for related in object["related_ids"].as_array().into_iter().flatten() {
            if let Some(parent) = related.as_str() {
                match knowledge::read_in_tx(tx, ctx, parent, None, true).await {
                    Ok(table) if table["kind"] == "table" => {
                        authority = parent.to_owned();
                        break;
                    }
                    Ok(_) => {}
                    Err(e) if e.code == "not_available" => {}
                    Err(e) => return Err(e),
                }
            }
        }
    }
    let source = if object["kind"] == "table" || object["kind"] == "field" {
        "datasight"
    } else {
        "system"
    };
    access::register_in_tx(tx, ctx, object_id, &authority, source).await
}
pub async fn decorate_in_tx(tx: &mut AppTx<'_>, ctx: &AccessContext, v: &mut Value) -> Result<()> {
    v["maintenance"] = access::maintenance_in_tx(tx, ctx, v["id"].as_str().unwrap_or("")).await?;
    Ok(())
}
pub async fn assign(
    pool: &MySqlPool,
    ctx: &AccessContext,
    object: &str,
    input: Value,
) -> Result<Value> {
    contracts::validate("AssignSemanticMaintainer", &input)?;
    let mut tx = AppTx::begin(pool).await?;
    knowledge::read_in_tx(&mut tx, ctx, object, None, true).await?;
    let v = access::assign_in_tx(&mut tx, ctx, object, &input).await?;
    tx.commit().await?;
    Ok(v)
}
pub async fn draft(pool: &MySqlPool, ctx: &AccessContext, input: Value) -> Result<Value> {
    contracts::validate("ProposalDraftCommand", &input)?;
    let mut tx = AppTx::begin(pool).await?;
    let command = json!({"action":"draft","input":input});
    let v = if let Some(v) = knowledge::corrections::begin_in_tx(&mut tx, ctx, &command).await? {
        v
    } else {
        super::knowledge::check_refs_in_tx(&mut tx, ctx, &input["evidence"]).await?;
        let v = knowledge::propose_in_tx(&mut tx, ctx, &id(), &input).await?;
        knowledge::corrections::record_in_tx(&mut tx, ctx, &command, &v).await?;
        v
    };
    tx.commit().await?;
    Ok(v)
}
async fn visible_in_tx(tx: &mut AppTx<'_>, ctx: &AccessContext, v: &Value) -> Result<bool> {
    let object = v["object_id"].as_str().ok_or(Error::new("invalid_input"))?;
    knowledge::read_in_tx(tx, ctx, object, None, true).await?;
    let can_review = access::maintenance_in_tx(tx, ctx, object).await?["can_edit"] == true;
    if v["submitter_id"] != ctx.user_id && !can_review {
        return Err(Error::new("not_available"));
    }
    Ok(can_review)
}
async fn view_in_tx(tx: &mut AppTx<'_>, ctx: &AccessContext, mut v: Value) -> Result<Value> {
    let can_review = visible_in_tx(tx, ctx, &v).await?;
    v["can_review"] = json!(can_review && v["state"] != "applied");
    v["can_revise"] = json!(v["submitter_id"] == ctx.user_id && v["state"] != "applied");
    contracts::validate("SemanticCorrection", &v)?;
    Ok(v)
}
pub async fn read(pool: &MySqlPool, ctx: &AccessContext, correction: &str) -> Result<Value> {
    let mut tx = AppTx::begin(pool).await?;
    let v = knowledge::corrections::read_in_tx(&mut tx, ctx, correction, false).await?;
    let v = view_in_tx(&mut tx, ctx, v).await?;
    tx.commit().await?;
    Ok(v)
}
pub async fn list(pool: &MySqlPool, ctx: &AccessContext, after: Option<&str>) -> Result<Value> {
    let mut tx = AppTx::begin(pool).await?;
    let ids = access::maintainable_ids_in_tx(&mut tx, ctx).await?;
    let mut rows = knowledge::corrections::page_in_tx(
        &mut tx,
        ctx,
        access::is_super_maintainer(ctx)?,
        &ids,
        after,
    )
    .await?;
    let next = if rows.len() > 50 {
        rows.truncate(50);
        rows.last().map(|v| v["id"].clone())
    } else {
        None
    };
    let mut values = Vec::new();
    for row in rows {
        match view_in_tx(&mut tx, ctx, row).await {
            Ok(v) => values.push(v),
            Err(e) if e.code == "not_available" => {}
            Err(e) => return Err(e),
        }
    }
    tx.commit().await?;
    Ok(json!({"corrections":values,"next_after_id":next}))
}
async fn check_content_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    input: &Value,
) -> Result<String> {
    let object = input["object_id"]
        .as_str()
        .ok_or(Error::new("invalid_input"))?;
    // 同序锁定目标和依据，防止核验与保存之间被改版或停用。
    let mut refs = vec![(
        object.to_owned(),
        epoch(input["base_version"].as_str().unwrap_or(""))?,
    )];
    for r in input["evidence"]
        .as_array()
        .ok_or(Error::new("invalid_input"))?
    {
        refs.push((
            r["object_id"].as_str().unwrap_or("").to_owned(),
            epoch(r["version"].as_str().unwrap_or(""))?,
        ));
    }
    knowledge::lock_versions_in_tx(tx, ctx, &refs).await?;
    super::knowledge::check_refs_in_tx(tx, ctx, &input["evidence"]).await?;
    let object = knowledge::read_in_tx(tx, ctx, object, None, false).await?;
    super::knowledge::assert_source_in_tx(tx, ctx, &object).await?;
    let entry = object["entries"]
        .as_array()
        .and_then(|entries| entries.iter().find(|e| e["entry_id"] == input["entry_id"]))
        .ok_or(Error::new("invalid_evidence"))?;
    Ok(entry["effective_value"].as_str().unwrap_or("").to_owned())
}
fn copy_content(v: &mut Value, input: &Value) {
    for k in [
        "object_id",
        "base_version",
        "entry_id",
        "value",
        "reason",
        "evidence",
    ] {
        v[k] = input[k].clone();
    }
}

pub async fn change(
    pool: &MySqlPool,
    ctx: &AccessContext,
    correction: Option<&str>,
    action: &str,
    input: Value,
) -> Result<Value> {
    let schema = match action {
        "submit" => "SubmitSemanticCorrection",
        "revise" => "ReviseSemanticCorrection",
        "review" => "ReviewSemanticCorrection",
        "apply" => "ApplySemanticCorrection",
        _ => return Err(Error::new("invalid_input")),
    };
    contracts::validate(schema, &input)?;
    let mut tx = AppTx::begin(pool).await?;
    let initial = if let Some(correction) = correction {
        Some(knowledge::corrections::read_in_tx(&mut tx, ctx, correction, false).await?)
    } else {
        None
    };
    // 当前授权先于幂等回执检查；撤权者不能用旧操作读取正式保存内容。
    if let Some(v) = &initial {
        let reviewer = visible_in_tx(&mut tx, ctx, v).await?;
        if action == "revise" {
            if v["submitter_id"] != ctx.user_id {
                return Err(Error::new("forbidden"));
            }
        } else if !reviewer {
            return Err(Error::new("forbidden"));
        }
    } else {
        let target = input["object_id"].as_str().unwrap_or("");
        knowledge::read_in_tx(&mut tx, ctx, target, None, false).await?;
        // 提出者只需可读；提前锁定授权快照，保持 ownership → knowledge 的顺序。
        access::maintenance_in_tx(&mut tx, ctx, target).await?;
    }
    if input
        .get("reason")
        .is_some_and(|v| v.as_str().is_none_or(|s| s.trim().is_empty()))
    {
        return Err(Error::new("invalid_input"));
    }
    let command = json!({"action":action,"id":correction,"input":input});
    if let Some(v) = knowledge::corrections::begin_in_tx(&mut tx, ctx, &command).await? {
        let v = view_in_tx(&mut tx, ctx, v).await?;
        tx.commit().await?;
        return Ok(v);
    }
    let original = if action == "submit" || action == "revise" {
        Some(check_content_in_tx(&mut tx, ctx, &input).await?)
    } else if action == "apply" {
        let v = initial.as_ref().ok_or(Error::new("invalid_input"))?;
        if input["expected_version"] != v["base_version"] {
            return Err(Error::new("version_conflict"));
        }
        Some(check_content_in_tx(&mut tx, ctx, v).await?)
    } else {
        None
    };
    let mut v = if let Some(correction) = correction {
        let v = knowledge::corrections::read_in_tx(&mut tx, ctx, correction, true).await?;
        if v["revision"] != input["expected_revision"] || v["state"] == "applied" {
            return Err(Error::new("version_conflict"));
        }
        v
    } else {
        json!({"id":id(),"submitter_id":ctx.user_id,"revision":"0","state":"submitted","reviewer_id":null,"review_reason":null,"applied_by":null,"applied_version":null,"applied_value":null})
    };
    match action {
        "submit" | "revise" => {
            if action == "revise"
                && (v["object_id"] != input["object_id"] || v["entry_id"] != input["entry_id"])
            {
                return Err(Error::new("invalid_input"));
            }
            copy_content(&mut v, &input);
            v["original_value"] = json!(original);
            v["state"] = json!("submitted");
            v["reviewer_id"] = Value::Null;
            v["review_reason"] = Value::Null;
        }
        "review" => {
            if v["state"] != "submitted" {
                return Err(Error::new("version_conflict"));
            }
            v["state"] = input["decision"].clone();
            v["reviewer_id"] = json!(ctx.user_id);
            v["review_reason"] = input["reason"].clone();
        }
        "apply" => {
            if v["state"] != "accepted" {
                return Err(Error::new("version_conflict"));
            }
            let edit = json!({"operation_id":input["operation_id"],"expected_version":input["expected_version"],"entry_id":v["entry_id"],"value":input["value"]});
            let saved = knowledge::save_edit_in_tx(
                &mut tx,
                ctx,
                v["object_id"].as_str().unwrap_or(""),
                &edit,
                None,
            )
            .await?;
            v["state"] = json!("applied");
            v["applied_version"] = saved["version"].clone();
            v["applied_value"] = input["value"].clone();
            v["applied_by"] = json!(ctx.user_id);
        }
        _ => return Err(Error::new("invalid_input")),
    }
    v["revision"] = json!((epoch(v["revision"].as_str().unwrap_or(""))? + 1).to_string());
    knowledge::corrections::save_in_tx(&mut tx, ctx, &v).await?;
    knowledge::corrections::record_in_tx(&mut tx, ctx, &command, &v).await?;
    let v = view_in_tx(&mut tx, ctx, v).await?;
    tx.commit().await?;
    Ok(v)
}

pub async fn register_catalog_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    catalog: &Value,
) -> Result<()> {
    let mut objects = catalog["objects"]
        .as_array()
        .ok_or(Error::new("invalid_input"))?
        .iter()
        .collect::<Vec<_>>();
    objects.sort_by_key(|o| o["id"].as_str().unwrap_or(""));
    for object in &objects {
        let id = object["id"].as_str().ok_or(Error::new("invalid_input"))?;
        let parent = if object["kind"] == "field" {
            object["related_ids"]
                .as_array()
                .into_iter()
                .flatten()
                .find_map(|r| {
                    objects
                        .iter()
                        .find(|o| o["kind"] == "table" && o["id"] == *r)
                        .and_then(|o| o["id"].as_str())
                })
        } else {
            None
        };
        access::register_in_tx(
            tx,
            ctx,
            id,
            parent.unwrap_or(id),
            if object["kind"] == "table" || object["kind"] == "field" {
                "datasight"
            } else {
                "system"
            },
        )
        .await?;
    }
    Ok(())
}
