use super::*;

pub async fn propose_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    operation: &str,
    input: &Value,
) -> Result<Value> {
    check_refs_in_tx(tx, ctx, &input["evidence"]).await?;
    let current = read_in_tx(
        tx,
        ctx,
        input["object_id"].as_str().unwrap_or(""),
        None,
        false,
    )
    .await?;
    if current["version"] != input["base_version"] {
        return Err(Error::new("version_conflict"));
    }
    if input["evidence"].as_array().is_none_or(|a| a.is_empty()) {
        return Err(Error::new("invalid_evidence"));
    }
    if !current["entries"]
        .as_array()
        .is_some_and(|a| a.iter().any(|e| e["entry_id"] == input["entry_id"]))
    {
        return Err(Error::new("invalid_evidence"));
    }
    let v = json!({"id":operation,"object_id":input["object_id"],"base_version":input["base_version"],"entry_id":input["entry_id"],"value":input["value"],"reason":input["reason"],"evidence":input["evidence"],"state":"open"});
    sqlx::query("INSERT INTO semantic_change_proposals(id,owner_id,space_id,body) VALUES(?,?,?,?)")
        .bind(operation)
        .bind(&ctx.user_id)
        .bind(&ctx.space_id)
        .bind(sqlx::types::Json(&v))
        .execute(tx.connection())
        .await?;
    Ok(v)
}
pub async fn proposals_in_tx(tx: &mut AppTx<'_>, ctx: &AccessContext) -> Result<Vec<Value>> {
    let rows = sqlx::query(
        "SELECT body FROM semantic_change_proposals WHERE owner_id=? AND space_id=? AND state='open'",
    )
    .bind(&ctx.user_id)
    .bind(&ctx.space_id)
    .fetch_all(tx.connection())
    .await?;
    let mut visible = Vec::with_capacity(rows.len());
    for row in &rows {
        let item = body(row);
        let object = item["object_id"].as_str().unwrap_or("");
        match check_read_access_in_tx(tx, ctx, object).await {
            Ok(()) => visible.push(item),
            Err(error) if error.code == "not_available" => {}
            Err(error) => return Err(error),
        }
    }
    Ok(visible)
}
pub async fn apply_proposal_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    proposal: &str,
    input: &Value,
) -> Result<Value> {
    let key = input["operation_id"]
        .as_str()
        .ok_or(Error::new("invalid_input"))?;
    let command = json!({"proposal_id":proposal,"input":input});
    if let Some(v) = begin_operation(tx, ctx, key, &command).await? {
        return Ok(v);
    }
    let row=sqlx::query("SELECT body FROM semantic_change_proposals WHERE id=? AND owner_id=? AND space_id=? FOR UPDATE").bind(proposal).bind(&ctx.user_id).bind(&ctx.space_id).fetch_optional(tx.connection()).await?.ok_or(Error::new("not_available"))?;
    let p = body(&row);
    if input["expected_version"] != p["base_version"] {
        return Err(Error::new("version_conflict"));
    }
    check_refs_in_tx(tx, ctx, &p["evidence"]).await?;
    let edit = json!({"operation_id":fingerprint(&json!({"proposal_apply":key})),"expected_version":p["base_version"],"entry_id":p["entry_id"],"value":p["value"]});
    let v = save_edit_in_tx(tx, ctx, p["object_id"].as_str().unwrap_or(""), &edit, None).await?;
    sqlx::query("UPDATE semantic_change_proposals SET state='applied' WHERE id=?")
        .bind(proposal)
        .execute(tx.connection())
        .await?;
    record(tx, ctx, key, &command, &v).await?;
    Ok(v)
}

pub async fn proposal_in_tx(tx: &mut AppTx<'_>, ctx: &AccessContext, id: &str) -> Result<Value> {
    let row = sqlx::query(
        "SELECT body FROM semantic_change_proposals WHERE id=? AND owner_id=? AND space_id=?",
    )
    .bind(id)
    .bind(&ctx.user_id)
    .bind(&ctx.space_id)
    .fetch_optional(tx.connection())
    .await?
    .ok_or(Error::new("not_available"))?;
    Ok(body(&row))
}
