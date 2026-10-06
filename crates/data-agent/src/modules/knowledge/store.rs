use crate::{
    persistence::AppTx,
    types::{AccessContext, Error, Result, epoch, fingerprint, id},
};
use serde_json::{Value, json};
use sqlx::Row;
fn body(row: &sqlx::mysql::MySqlRow) -> Value {
    row.get::<sqlx::types::Json<Value>, _>("body").0
}
async fn begin_operation(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    key: &str,
    value: &Value,
) -> Result<Option<Value>> {
    // 预占与正式写同事务；失败回滚，不留下空回执或重复版本。
    sqlx::query("INSERT INTO knowledge_operations(owner_id,operation_id,fingerprint,receipt) VALUES(?,?,?,CAST('null' AS JSON)) ON DUPLICATE KEY UPDATE operation_id=VALUES(operation_id)")
        .bind(&ctx.user_id).bind(key).bind(fingerprint(value)).execute(tx.connection()).await?;
    let row = sqlx::query("SELECT fingerprint,receipt FROM knowledge_operations WHERE owner_id=? AND operation_id=? FOR UPDATE")
        .bind(&ctx.user_id).bind(key).fetch_one(tx.connection()).await?;
    let receipt = row.get::<sqlx::types::Json<Value>, _>("receipt").0;
    let stored = row.get::<String, _>("fingerprint");
    let legacy_reanalysis = value["action"] == "reanalyze"
        && !receipt.is_null()
        && stored
            == fingerprint(
                &json!({"object_id":value["object_id"],"input":value["input"],"source_version":receipt["source_version"]}),
            );
    if stored != fingerprint(value) && !legacy_reanalysis {
        return Err(Error::new("idempotency_conflict"));
    }
    if !receipt.is_null() {
        return Ok(Some(receipt));
    }
    Ok(None)
}
async fn record(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    key: &str,
    input: &Value,
    value: &Value,
) -> Result<()> {
    sqlx::query("UPDATE knowledge_operations SET receipt=? WHERE owner_id=? AND operation_id=? AND fingerprint=?").bind(sqlx::types::Json(value)).bind(&ctx.user_id).bind(key).bind(fingerprint(input)).execute(tx.connection()).await?;
    Ok(())
}
async fn persist(tx: &mut AppTx<'_>, ctx: &AccessContext, v: &Value) -> Result<()> {
    let mut v = v.clone();
    if v.get("created_by").is_none() {
        v["created_by"] = v["updated_by"].clone();
    }
    sqlx::query("INSERT INTO knowledge_objects(id,space_id,kind,name,version,state,body,source_id,source_version,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name),version=VALUES(version),state=VALUES(state),body=VALUES(body),source_version=VALUES(source_version),updated_by=VALUES(updated_by)")
 .bind(v["id"].as_str()).bind(&ctx.space_id).bind(v["kind"].as_str()).bind(v["name"].as_str()).bind(epoch(v["version"].as_str().ok_or(Error::new("invalid_input"))?)?).bind(v["state"].as_str()).bind(sqlx::types::Json(&v)).bind(v["source_id"].as_str()).bind(epoch(v["source_version"].as_str().unwrap_or("0"))?).bind(&ctx.user_id).execute(tx.connection()).await?;
    sqlx::query("INSERT INTO knowledge_index_jobs(object_id,version) VALUES(?,?)")
        .bind(v["id"].as_str())
        .bind(epoch(v["version"].as_str().unwrap_or("0"))?)
        .execute(tx.connection())
        .await?;
    sqlx::query("INSERT INTO knowledge_versions(object_id,version,body) VALUES(?,?,?)")
        .bind(v["id"].as_str())
        .bind(epoch(v["version"].as_str().unwrap_or("0"))?)
        .bind(sqlx::types::Json(&v))
        .execute(tx.connection())
        .await?;
    Ok(())
}
pub async fn seed_in_tx(tx: &mut AppTx<'_>, ctx: &AccessContext, catalog: &Value) -> Result<()> {
    for v in catalog["objects"]
        .as_array()
        .ok_or(Error::new("invalid_input"))?
    {
        if sqlx::query("SELECT id FROM knowledge_objects WHERE id=?")
            .bind(v["id"].as_str())
            .fetch_optional(tx.connection())
            .await?
            .is_none()
        {
            persist(tx, ctx, v).await?;
        }
    }
    Ok(())
}
pub async fn list_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    active_only: bool,
) -> Result<Vec<Value>> {
    let rows=sqlx::query("SELECT body FROM knowledge_objects FORCE INDEX(PRIMARY) WHERE space_id=? AND state<>'deleted' AND (?=0 OR state='enabled') ORDER BY id").bind(&ctx.space_id).bind(active_only).fetch_all(tx.connection()).await?;
    Ok(rows.iter().map(body).collect())
}
pub async fn table_objects_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    table: &str,
) -> Result<Vec<Value>> {
    let rows = sqlx::query("SELECT body FROM knowledge_objects WHERE space_id=? AND state='enabled' AND (id=? OR (kind='field' AND JSON_CONTAINS(JSON_EXTRACT(body,'$.related_ids'),JSON_QUOTE(?)))) ORDER BY id")
        .bind(&ctx.space_id).bind(table).bind(table).fetch_all(tx.connection()).await?;
    Ok(rows.iter().map(body).collect())
}

pub async fn related_documents_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    ids: &[String],
) -> Result<Vec<Value>> {
    let keys = serde_json::to_string(ids).map_err(|_| Error::new("invalid_input"))?;
    let rows = sqlx::query("SELECT d.body FROM knowledge_objects d WHERE d.space_id=? AND d.state='enabled' AND d.kind='document' AND (JSON_CONTAINS(CAST(? AS JSON),JSON_QUOTE(d.id)) OR JSON_OVERLAPS(JSON_EXTRACT(d.body,'$.related_ids'),CAST(? AS JSON)) OR EXISTS(SELECT 1 FROM knowledge_objects f WHERE f.space_id=d.space_id AND f.state='enabled' AND f.kind='field' AND JSON_OVERLAPS(JSON_EXTRACT(f.body,'$.related_ids'),CAST(? AS JSON)) AND JSON_CONTAINS(JSON_EXTRACT(d.body,'$.related_ids'),JSON_QUOTE(f.id)))) ORDER BY d.id LIMIT 33")
        .bind(&ctx.space_id).bind(&keys).bind(&keys).bind(&keys).fetch_all(tx.connection()).await?;
    Ok(rows.iter().map(body).collect())
}

pub async fn lock_versions_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    refs: &[(String, u64)],
) -> Result<()> {
    let mut refs = refs.to_vec();
    refs.sort();
    refs.dedup();
    for (id, version) in refs {
        let row = sqlx::query(
            "SELECT version,state FROM knowledge_objects WHERE id=? AND space_id=? FOR UPDATE",
        )
        .bind(id)
        .bind(&ctx.space_id)
        .fetch_optional(tx.connection())
        .await?
        .ok_or(Error::new("not_available"))?;
        if row.get::<u64, _>("version") != version || row.get::<String, _>("state") != "enabled" {
            return Err(Error::new("stale_knowledge"));
        }
    }
    Ok(())
}
pub async fn read_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &str,
    version: Option<u64>,
    manage: bool,
) -> Result<Value> {
    let row = sqlx::query("SELECT body,state FROM knowledge_objects WHERE id=? AND space_id=?")
        .bind(object)
        .bind(&ctx.space_id)
        .fetch_optional(tx.connection())
        .await?
        .ok_or(Error::new("not_available"))?;
    if row.get::<String, _>("state") == "deleted"
        || (!manage && row.get::<String, _>("state") != "enabled")
    {
        return Err(Error::new("not_available"));
    }
    if !manage {
        let v = body(&row);
        if version.is_some_and(|requested| {
            v["version"].as_str().and_then(|s| s.parse::<u64>().ok()) != Some(requested)
        }) {
            return Err(Error::new("stale_knowledge"));
        }
    }
    if let Some(version) = version {
        return sqlx::query_scalar::<_, sqlx::types::Json<Value>>(
            "SELECT body FROM knowledge_versions WHERE object_id=? AND version=?",
        )
        .bind(object)
        .bind(version)
        .fetch_optional(tx.connection())
        .await?
        .map(|v| v.0)
        .ok_or(Error::new("not_available"));
    }
    Ok(body(&row))
}

pub async fn is_deleted_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &str,
) -> Result<bool> {
    Ok(sqlx::query_scalar::<_, String>(
        "SELECT state FROM knowledge_objects WHERE id=? AND space_id=?",
    )
    .bind(object)
    .bind(&ctx.space_id)
    .fetch_optional(tx.connection())
    .await?
    .is_some_and(|state| state == "deleted"))
}
async fn locked(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &str,
    expected: &str,
) -> Result<Value> {
    let row=sqlx::query("SELECT body FROM knowledge_objects WHERE id=? AND space_id=? AND state<>'deleted' FOR UPDATE").bind(object).bind(&ctx.space_id).fetch_optional(tx.connection()).await?.ok_or(Error::new("not_available"))?;
    let v = body(&row);
    if v["version"] != expected {
        return Err(Error::new("version_conflict"));
    }
    Ok(v)
}
fn next(v: &mut Value, ctx: &AccessContext) {
    v["version"] = json!(
        (epoch(v["version"].as_str().unwrap_or("0")).expect("saved version") + 1).to_string()
    );
    v["updated_by"] = json!(ctx.user_id);
}
pub async fn begin_edit_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &str,
    input: &Value,
) -> Result<Option<Value>> {
    let key = input["operation_id"]
        .as_str()
        .ok_or(Error::new("invalid_input"))?;
    begin_operation(tx, ctx, key, &json!({"object_id":object,"input":input})).await
}

pub async fn begin_reanalysis_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &str,
    input: &Value,
) -> Result<Option<Value>> {
    let key = input["operation_id"]
        .as_str()
        .ok_or(Error::new("invalid_input"))?;
    begin_operation(
        tx,
        ctx,
        key,
        &json!({"action":"reanalyze","object_id":object,"input":input}),
    )
    .await
}

pub async fn save_edit_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &str,
    input: &Value,
    source_value: Option<&str>,
) -> Result<Value> {
    let key = input["operation_id"]
        .as_str()
        .ok_or(Error::new("invalid_input"))?;
    let command = json!({"object_id":object,"input":input});
    if let Some(v) = begin_operation(tx, ctx, key, &command).await? {
        return Ok(v);
    }
    let mut v = locked(
        tx,
        ctx,
        object,
        input["expected_version"].as_str().unwrap_or(""),
    )
    .await?;
    if input.get("source_url").is_some() || input.get("related_ids").is_some() {
        if v["kind"] != "document" || input["entry_id"] != "body" || input["clear_override"] == true
        {
            return Err(Error::new("invalid_input"));
        }
        validate_document_metadata(tx, ctx, input).await?;
        if let Some(related) = input.get("related_ids") {
            v["related_ids"] = related.clone();
        }
    }
    let entry = v["entries"]
        .as_array_mut()
        .ok_or(Error::new("invalid_input"))?
        .iter_mut()
        .find(|e| e["entry_id"] == input["entry_id"])
        .ok_or(Error::new("invalid_input"))?;
    if input["clear_override"] == true {
        entry["human_override"] = Value::Null;
        entry["effective_value"] = json!(
            entry["suggestion"]["value"]
                .as_str()
                .or_else(|| entry["source_facts"]["value"].as_str())
                .or(source_value)
                .unwrap_or("")
        );
        entry["review_state"] = json!("unverified");
    } else {
        let source_url = input
            .get("source_url")
            .cloned()
            .unwrap_or_else(|| entry["human_override"]["source_url"].clone());
        entry["human_override"] = json!({"value":input["value"],"edited_by":ctx.user_id,"operation_id":key,"source_url":source_url});
        entry["effective_value"] = input["value"].clone();
        entry["review_state"] = json!("confirmed");
        if entry["entry_id"] == "body"
            && entry["source_facts"]["gap"] == "只有链接，正文尚未录入，不能据此解释业务"
            && input["value"]
                .as_str()
                .is_some_and(|v| !v.trim().is_empty())
        {
            entry["source_facts"]["gap"] = json!("人工录入，尚无平台来源");
        }
    }
    next(&mut v, ctx);
    persist(tx, ctx, &v).await?;
    record(tx, ctx, key, &command, &v).await?;
    Ok(v)
}
pub async fn create_in_tx(tx: &mut AppTx<'_>, ctx: &AccessContext, input: &Value) -> Result<Value> {
    let key = input["operation_id"].as_str().unwrap_or("");
    if let Some(v) = begin_operation(tx, ctx, key, input).await? {
        return Ok(v);
    }
    validate_document_metadata(tx, ctx, input).await?;
    let gap = if input["body"].as_str().is_none_or(|b| b.trim().is_empty()) {
        "只有链接，正文尚未录入，不能据此解释业务"
    } else {
        "人工录入，尚无平台来源"
    };
    let v = json!({"id":id(),"kind":input["kind"],"name":input["name"],"version":"1","state":"enabled","entries":[{"entry_id":"body","path":"body","label":"正文","source_facts":{"complete":false,"gap":gap},"suggestion":{},"human_override":{"value":input["body"],"edited_by":ctx.user_id,"source_url":input["source_url"]},"effective_value":input["body"],"review_state":"confirmed"}],"related_ids":input["related_ids"],"source_id":null,"source_version":"0","updated_by":ctx.user_id,"created_by":ctx.user_id});
    persist(tx, ctx, &v).await?;
    record(tx, ctx, key, input, &v).await?;
    Ok(v)
}
pub async fn change_state_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &str,
    input: &Value,
    state: &str,
) -> Result<Value> {
    let key = input["operation_id"].as_str().unwrap_or("");
    let command = json!({"object_id":object,"input":input,"state":state});
    if let Some(v) = begin_operation(tx, ctx, key, &command).await? {
        return Ok(v);
    }
    let mut v = locked(
        tx,
        ctx,
        object,
        input["expected_version"].as_str().unwrap_or(""),
    )
    .await?;
    v["state"] = json!(state);
    v["state_origin"] = json!("human");
    next(&mut v, ctx);
    persist(tx, ctx, &v).await?;
    record(tx, ctx, key, &command, &v).await?;
    Ok(v)
}
pub async fn reanalyze_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &str,
    input: &Value,
    source_version: u64,
    candidate: &Value,
) -> Result<Value> {
    let key = input["operation_id"].as_str().unwrap_or("");
    let command = json!({"action":"reanalyze","object_id":object,"input":input});
    if let Some(v) = begin_operation(tx, ctx, key, &command).await? {
        return Ok(v);
    }
    let locked = locked(
        tx,
        ctx,
        object,
        input["expected_version"].as_str().unwrap_or(""),
    )
    .await;
    let mut v = match locked {
        Ok(value) => value,
        Err(error) => {
            // 预填会提交superseded回执；对象冲突不能顺带提交空操作占位。
            sqlx::query("DELETE FROM knowledge_operations WHERE owner_id=? AND operation_id=? AND fingerprint=? AND JSON_TYPE(receipt)='NULL'")
                .bind(&ctx.user_id).bind(key).bind(fingerprint(&command)).execute(tx.connection()).await?;
            return Err(error);
        }
    };
    for entry in v["entries"]
        .as_array_mut()
        .ok_or(Error::new("invalid_input"))?
    {
        if let Some(new) = candidate["entries"]
            .as_array()
            .and_then(|a| a.iter().find(|e| e["entry_id"] == entry["entry_id"]))
        {
            entry["source_facts"] = new["source_facts"].clone();
            entry["suggestion"] = new["suggestion"].clone();
            if entry["human_override"].is_null() {
                entry["effective_value"] = new["effective_value"].clone();
                entry["review_state"] = json!("unverified");
            } else {
                entry["review_state"] = json!("needs_review");
            }
        }
    }
    for entry in candidate["entries"]
        .as_array()
        .ok_or(Error::new("invalid_input"))?
    {
        if !v["entries"]
            .as_array()
            .is_some_and(|items| items.iter().any(|old| old["entry_id"] == entry["entry_id"]))
        {
            v["entries"]
                .as_array_mut()
                .ok_or(Error::new("invalid_input"))?
                .push(entry.clone());
        }
    }
    if v["state"] == "disabled" && v["state_origin"] == "platform" {
        v["state"] = json!("enabled");
    }
    v["name"] = candidate["name"].clone();
    v["related_ids"] = candidate["related_ids"].clone();
    v["source_version"] = json!(source_version.to_string());
    next(&mut v, ctx);
    persist(tx, ctx, &v).await?;
    record(tx, ctx, key, &command, &v).await?;
    Ok(v)
}
pub async fn check_refs_in_tx(tx: &mut AppTx<'_>, ctx: &AccessContext, refs: &Value) -> Result<()> {
    for r in refs.as_array().ok_or(Error::new("invalid_input"))? {
        let v = read_in_tx(tx, ctx, r["object_id"].as_str().unwrap_or(""), None, false).await?;
        if v["version"] != r["version"] {
            return Err(Error::new("stale_knowledge"));
        }
        if let Some(path) = r["path"].as_str()
            && !path.is_empty()
            && !v["entries"]
                .as_array()
                .is_some_and(|a| a.iter().any(|e| e["entry_id"] == path || e["path"] == path))
        {
            return Err(Error::new("invalid_evidence"));
        }
    }
    Ok(())
}
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
    let rows=sqlx::query("SELECT body FROM semantic_change_proposals WHERE owner_id=? AND space_id=? AND state='open'").bind(&ctx.user_id).bind(&ctx.space_id).fetch_all(tx.connection()).await?;
    Ok(rows.iter().map(body).collect())
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

pub async fn claim_index_batch_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    vector: bool,
    target: Option<&str>,
) -> Result<Vec<Value>> {
    // 候选不加锁；随后先锁对象、再按作业主键锁定，和语义保存使用同一顺序。
    // 不能在UPDATE JOIN中先扫描作业并取得间隙锁，再等待正在保存的对象。
    let candidates=sqlx::query_scalar::<_,String>("SELECT DISTINCT k.id FROM knowledge_objects k JOIN knowledge_index_jobs j ON j.object_id=k.id WHERE k.space_id=? AND ((j.version<k.version AND j.vector_state NOT IN ('indexed','bounded','superseded')) OR (j.version=k.version AND ((?=1 AND (j.vector_target IS NULL OR j.vector_target<>?)) OR (?=1 AND j.vector_state IN ('sending','unknown') AND j.vector_attempts>=3 AND j.lease_until<UTC_TIMESTAMP(3)) OR ((j.state='pending' OR (?=1 AND j.vector_state IN ('pending','sending','unknown'))) AND (j.lease_until IS NULL OR j.lease_until<UTC_TIMESTAMP(3)) AND j.vector_attempts<3)))) ORDER BY k.id LIMIT ?")
        .bind(&ctx.space_id).bind(vector).bind(target).bind(vector).bind(vector).bind(if vector { 1_u32 } else { 64_u32 }).fetch_all(tx.connection()).await?;
    let mut jobs = Vec::new();
    for object_id in candidates {
        let Some(current_version)=sqlx::query_scalar::<_,u64>("SELECT version FROM knowledge_objects WHERE id=? AND space_id=? FOR UPDATE SKIP LOCKED")
            .bind(&object_id).bind(&ctx.space_id).fetch_optional(tx.connection()).await? else {continue;};
        let mut versions=sqlx::query_scalar::<_,u64>("SELECT version FROM knowledge_index_jobs WHERE object_id=? AND version<? AND vector_state NOT IN ('indexed','bounded','superseded') ORDER BY version LIMIT 64")
            .bind(&object_id).bind(current_version).fetch_all(tx.connection()).await?;
        versions.push(current_version);
        for version in versions {
            let Some(row)=sqlx::query("SELECT state,vector_state,vector_attempts,vector_target,lease_epoch,lease_until IS NULL OR lease_until<UTC_TIMESTAMP(3) AS available FROM knowledge_index_jobs WHERE object_id=? AND version=? FOR UPDATE SKIP LOCKED")
                .bind(&object_id).bind(version).fetch_optional(tx.connection()).await? else {continue;};
            let mut vector_state: String = row.get("vector_state");
            if version < current_version {
                if !matches!(vector_state.as_str(), "indexed" | "bounded" | "superseded") {
                    sqlx::query("UPDATE knowledge_index_jobs SET state='indexed',vector_state='superseded' WHERE object_id=? AND version=?")
                        .bind(&object_id).bind(version).execute(tx.connection()).await?;
                }
                continue;
            }
            let mut attempts: u32 = row.get("vector_attempts");
            let mut epoch: u64 = row.get("lease_epoch");
            let mut available: bool = row.get("available");
            let previous_target: Option<String> = row.get("vector_target");
            if vector && (previous_target.is_none() || previous_target.as_deref() != target) {
                sqlx::query("UPDATE knowledge_index_jobs SET vector_state='pending',vector_attempts=0,vector_error=NULL,vector_receipt=NULL,lease_until=NULL,lease_epoch=lease_epoch+1,vector_target=? WHERE object_id=? AND version=?")
                    .bind(target).bind(&object_id).bind(version).execute(tx.connection()).await?;
                vector_state = "pending".into();
                attempts = 0;
                epoch += 1;
                available = true;
            }
            // 最后一次领取后进程退出，收敛为明确失败，保留受控重建入口。
            if vector
                && available
                && attempts >= 3
                && matches!(vector_state.as_str(), "sending" | "unknown")
            {
                sqlx::query("UPDATE knowledge_index_jobs SET vector_state='failed',vector_error='vector_receipt_unknown',lease_until=NULL,lease_epoch=lease_epoch+1 WHERE object_id=? AND version=?")
                    .bind(&object_id).bind(version).execute(tx.connection()).await?;
                continue;
            }
            let pending = row.get::<String, _>("state") == "pending"
                || (vector && matches!(vector_state.as_str(), "pending" | "sending" | "unknown"));
            if !pending || !available || attempts >= 3 {
                continue;
            }
            epoch += 1;
            sqlx::query("UPDATE knowledge_index_jobs SET lease_epoch=?,lease_until=TIMESTAMPADD(SECOND,120,UTC_TIMESTAMP(3)),vector_state=IF(?=1,'sending',vector_state),vector_attempts=vector_attempts+? WHERE object_id=? AND version=?")
                .bind(epoch).bind(vector).bind(u32::from(vector)).bind(&object_id).bind(version).execute(tx.connection()).await?;
            // 锁内读当前不可变版本，不能沿用候选快照里已过期的正文。
            let object = sqlx::query_scalar::<_, sqlx::types::Json<Value>>(
                "SELECT body FROM knowledge_versions WHERE object_id=? AND version=? FOR SHARE",
            )
            .bind(&object_id)
            .bind(version)
            .fetch_one(tx.connection())
            .await?
            .0;
            jobs.push(json!({"object_id":object_id,"job_version":version.to_string(),"lease_epoch":epoch.to_string(),"object":object}));
        }
    }
    Ok(jobs)
}
pub async fn finish_index_in_tx(
    tx: &mut AppTx<'_>,
    job: &Value,
    receipt: Option<&Value>,
    error: Option<&str>,
) -> Result<()> {
    let changed=sqlx::query("UPDATE knowledge_index_jobs SET state='indexed',vector_state=IF(? IS NOT NULL,IF(vector_attempts>=3,'failed','unknown'),IF(? IS NULL,vector_state,?)),vector_error=?,vector_receipt=?,lease_until=IF(? IS NOT NULL,TIMESTAMPADD(SECOND,5,UTC_TIMESTAMP(3)),NULL) WHERE object_id=? AND version=? AND lease_epoch=?")
        .bind(error).bind(receipt.map(sqlx::types::Json)).bind(receipt.and_then(|v|v["state"].as_str())).bind(error).bind(receipt.map(sqlx::types::Json)).bind(error)
        .bind(job["object_id"].as_str()).bind(epoch(job["job_version"].as_str().unwrap_or("0"))?).bind(epoch(job["lease_epoch"].as_str().unwrap_or("0"))?)
        .execute(tx.connection()).await?;
    if changed.rows_affected() != 1 {
        return Err(Error::new("lease_lost"));
    }
    Ok(())
}
pub async fn index_coverage_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    target: &str,
) -> Result<&'static str> {
    let incomplete:i64=sqlx::query_scalar("SELECT COUNT(*) FROM knowledge_objects k LEFT JOIN knowledge_index_jobs j ON j.object_id=k.id AND j.version=k.version WHERE k.space_id=? AND k.state='enabled' AND (j.vector_state IS NULL OR j.vector_state<>'indexed' OR j.vector_target IS NULL OR j.vector_target<>?)")
        .bind(&ctx.space_id).bind(target).fetch_one(tx.connection()).await?;
    Ok(if incomplete > 0 {
        "incomplete"
    } else {
        "current"
    })
}

pub async fn rebuild_index_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    target: &str,
    operation: &str,
) -> Result<Value> {
    let receipt =
        json!({"operation_id":operation,"resource_id":target,"version":"1","state":"queued"});
    let created=sqlx::query("INSERT IGNORE INTO knowledge_index_rebuilds(space_id,owner_id,operation_id,target,receipt) VALUES(?,?,?,?,?)").bind(&ctx.space_id).bind(&ctx.user_id).bind(operation).bind(target).bind(sqlx::types::Json(&receipt)).execute(tx.connection()).await?;
    if created.rows_affected() == 0 {
        let row=sqlx::query("SELECT target,receipt FROM knowledge_index_rebuilds WHERE space_id=? AND owner_id=? AND operation_id=? FOR UPDATE").bind(&ctx.space_id).bind(&ctx.user_id).bind(operation).fetch_one(tx.connection()).await?;
        if row.get::<String, _>("target") != target {
            return Err(Error::new("idempotency_conflict"));
        }
        return Ok(row.get::<sqlx::types::Json<Value>, _>("receipt").0);
    }
    let objects = sqlx::query(
        "SELECT id,version FROM knowledge_objects WHERE space_id=? ORDER BY id FOR UPDATE",
    )
    .bind(&ctx.space_id)
    .fetch_all(tx.connection())
    .await?;
    if !objects.is_empty() {
        let mut query = sqlx::QueryBuilder::<sqlx::MySql>::new(
            "INSERT INTO knowledge_index_jobs(object_id,version,state,vector_target) ",
        );
        query.push_values(&objects, |mut values, row| {
            values
                .push_bind(row.get::<String, _>("id"))
                .push_bind(row.get::<u64, _>("version"))
                .push_bind("pending")
                .push_bind(target);
        });
        query.push(" ON DUPLICATE KEY UPDATE state='pending',vector_state='pending',vector_target=VALUES(vector_target),vector_attempts=0,vector_error=NULL,vector_receipt=NULL,lease_until=NULL,lease_epoch=lease_epoch+1");
        query.build().execute(tx.connection()).await?;
    }
    Ok(receipt)
}

async fn validate_document_metadata(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    input: &Value,
) -> Result<()> {
    for r in input["related_ids"].as_array().into_iter().flatten() {
        read_in_tx(
            tx,
            ctx,
            r.as_str().ok_or(Error::new("invalid_input"))?,
            None,
            true,
        )
        .await?;
    }
    if let Some(url) = input["source_url"].as_str() {
        let parsed = reqwest::Url::parse(url).map_err(|_| Error::new("invalid_input"))?;
        if !matches!(parsed.scheme(), "https" | "http") {
            return Err(Error::new("invalid_input"));
        }
    }
    Ok(())
}

// 管理目录有界分页，不能把任意截断当成整个空间。
pub async fn page_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    after: Option<&str>,
    related: Option<&str>,
) -> Result<(Vec<Value>, Option<String>)> {
    let rows=sqlx::query("SELECT body FROM knowledge_objects FORCE INDEX(PRIMARY) WHERE space_id=? AND state<>'deleted' AND (? IS NULL OR id>?) AND (? IS NULL OR JSON_CONTAINS(JSON_EXTRACT(body,'$.related_ids'),JSON_QUOTE(?))) ORDER BY id LIMIT 101")
        .bind(&ctx.space_id).bind(after).bind(after).bind(related).bind(related).fetch_all(tx.connection()).await?;
    let next = if rows.len() > 100 {
        rows.get(99)
            .map(|r| body(r)["id"].as_str().unwrap_or("").to_owned())
    } else {
        None
    };
    Ok((rows.iter().take(100).map(body).collect(), next))
}
// 索引积压时从当前正式正文查候选，精确名称优先且每次回源有界。
pub async fn matching_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    query: &str,
    tokens: &[String],
) -> Result<Vec<Value>> {
    if tokens.is_empty() {
        return Ok(vec![]);
    }
    let mut rows: Vec<String> = Vec::new();
    // 先取名称匹配，再补正文匹配；主键顺序避免长JSON进入filesort工作区。
    for exact in [true, false] {
        let remaining = 1001 - rows.len();
        if remaining == 0 {
            break;
        }
        let mut sql = sqlx::QueryBuilder::<sqlx::MySql>::new(
            "SELECT id FROM knowledge_objects FORCE INDEX(PRIMARY) WHERE space_id=",
        );
        sql.push_bind(&ctx.space_id)
            .push(" AND state='enabled' AND (INSTR(LOWER(name),")
            .push_bind(query.to_lowercase())
            .push(")>0)=")
            .push_bind(exact)
            .push(" AND (");
        let mut parts = sql.separated(" OR ");
        for token in tokens.iter().take(24) {
            parts
                .push("INSTR(LOWER(CAST(body AS CHAR)),")
                .push_bind_unseparated(token)
                .push_unseparated(")>0");
        }
        sql.push(") ORDER BY id LIMIT ").push_bind(remaining as u32);
        rows.extend(
            sql.build_query_scalar::<String>()
                .fetch_all(tx.connection())
                .await?,
        );
    }
    Ok(rows.into_iter().map(|id| json!({"id":id})).collect())
}

pub async fn current_objects_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    ids: &[String],
) -> Result<Vec<Value>> {
    let mut values = Vec::new();
    for chunk in ids.chunks(500) {
        let mut query = sqlx::QueryBuilder::<sqlx::MySql>::new(
            "SELECT body FROM knowledge_objects WHERE space_id=",
        );
        query
            .push_bind(&ctx.space_id)
            .push(" AND state='enabled' AND id IN (");
        let mut keys = query.separated(",");
        for id in chunk {
            keys.push_bind(id);
        }
        query.push(")");
        values.extend(
            query
                .build()
                .fetch_all(tx.connection())
                .await?
                .iter()
                .map(body),
        );
    }
    Ok(values)
}

pub async fn retire_source_objects_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    source: &str,
    keep: &std::collections::HashSet<String>,
) -> Result<()> {
    let objects:Vec<sqlx::types::Json<Value>>=sqlx::query_scalar("SELECT body FROM knowledge_objects WHERE space_id=? AND source_id=? AND state='enabled' ORDER BY id FOR UPDATE")
      .bind(&ctx.space_id).bind(source).fetch_all(tx.connection()).await?;
    for object in objects {
        let mut object = object.0;
        if keep.contains(object["id"].as_str().unwrap_or("")) {
            continue;
        }
        object["state"] = json!("disabled");
        object["state_origin"] = json!("platform");
        for entry in object["entries"].as_array_mut().into_iter().flatten() {
            entry["review_state"] = json!("needs_review");
        }
        next(&mut object, ctx);
        persist(tx, ctx, &object).await?;
    }
    Ok(())
}

// 先核对当前知识与领取代次，再冻结维护预算；重试不能从新环境配置补额。
pub async fn bind_index_embedding_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    job: &Value,
    profile: Option<&Value>,
) -> Result<Value> {
    let object = read_in_tx(
        tx,
        ctx,
        job["object_id"].as_str().unwrap_or(""),
        None,
        false,
    )
    .await?;
    if object["version"] != job["job_version"] {
        return Err(Error::new("version_conflict"));
    }
    let row=sqlx::query("SELECT embedding_profile,lease_epoch,vector_state,lease_until>UTC_TIMESTAMP(3) AS valid FROM knowledge_index_jobs WHERE object_id=? AND version=? FOR UPDATE")
        .bind(job["object_id"].as_str()).bind(epoch(job["job_version"].as_str().unwrap_or("0"))?).fetch_one(tx.connection()).await?;
    if row.get::<String, _>("vector_state") != "sending"
        || row.get::<u64, _>("lease_epoch").to_string() != job["lease_epoch"].as_str().unwrap_or("")
        || row.get::<i64, _>("valid") != 1
    {
        return Err(Error::new("lease_lost"));
    }
    // 云端长文分批处理：仅续接尚有效的同代租约，过期领取不能复活。
    sqlx::query("UPDATE knowledge_index_jobs SET lease_until=TIMESTAMPADD(SECOND,120,UTC_TIMESTAMP(3)) WHERE object_id=? AND version=?")
        .bind(job["object_id"].as_str()).bind(epoch(job["job_version"].as_str().unwrap_or("0"))?).execute(tx.connection()).await?;
    if let Some(saved) = row.get::<Option<sqlx::types::Json<Value>>, _>("embedding_profile") {
        return Ok(saved.0);
    }
    let profile = profile.ok_or(Error::new("budget_unavailable"))?;
    sqlx::query(
        "UPDATE knowledge_index_jobs SET embedding_profile=? WHERE object_id=? AND version=?",
    )
    .bind(sqlx::types::Json(profile))
    .bind(job["object_id"].as_str())
    .bind(epoch(job["job_version"].as_str().unwrap_or("0"))?)
    .execute(tx.connection())
    .await?;
    Ok(profile.clone())
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

pub async fn source_tables_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    source: &str,
) -> Result<Vec<String>> {
    Ok(sqlx::query_scalar("SELECT id FROM knowledge_objects WHERE space_id=? AND kind='table' AND source_id=? ORDER BY id").bind(&ctx.space_id).bind(source).fetch_all(tx.connection()).await?)
}
