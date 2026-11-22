use crate::{
    persistence::{AppTx, receipts::Operation},
    types::{AccessContext, Error, Result, fingerprint},
};
use serde_json::{Value, json};
use sqlx::Row;

pub async fn queue_prefill_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &Value,
    material: &Value,
) -> Result<()> {
    let table = analysis_table_id(object);
    // 与常用范围变更共享行锁，避免配置先更新而并发导入随后插入旧优先级。
    let priority = if let Some(table) = table {
        sqlx::query("INSERT INTO table_analysis_preferences(space_id,table_id) VALUES(?,?) ON DUPLICATE KEY UPDATE table_id=VALUES(table_id)")
            .bind(&ctx.space_id)
            .bind(table)
            .execute(tx.connection())
            .await?;
        let preferred: bool = sqlx::query_scalar("SELECT preferred FROM table_analysis_preferences WHERE space_id=? AND table_id=? FOR UPDATE")
            .bind(&ctx.space_id).bind(table).fetch_one(tx.connection()).await?;
        u8::from(preferred)
    } else {
        0
    };
    let mut input = material.clone();
    input["object"] = object.clone();
    sqlx::query("INSERT IGNORE INTO prefill_attempts(id,space_id,object_id,expected_version,input_fingerprint,input_json,table_id,priority) VALUES(?,?,?,?,?,?,?,?)")
        .bind(crate::types::id()).bind(&ctx.space_id).bind(object["id"].as_str()).bind(crate::types::epoch(object["version"].as_str().unwrap_or("0"))?).bind(fingerprint(&input)).bind(sqlx::types::Json(input)).bind(table).bind(priority).execute(tx.connection()).await?;
    Ok(())
}

fn analysis_table_id(object: &Value) -> Option<&str> {
    match object["kind"].as_str() {
        Some("table") => object["id"].as_str(),
        Some("field") => object["related_ids"]
            .as_array()?
            .iter()
            .find_map(|v| v.as_str().filter(|id| id.starts_with("table-"))),
        _ => None,
    }
}

pub async fn read_analysis_preference_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &Value,
) -> Result<Option<Value>> {
    let Some(table) = analysis_table_id(object) else {
        return Ok(None);
    };
    let row = sqlx::query(
        "SELECT version,preferred FROM table_analysis_preferences WHERE space_id=? AND table_id=?",
    )
    .bind(&ctx.space_id)
    .bind(table)
    .fetch_optional(tx.connection())
    .await?;
    Ok(Some(row.map(|r| json!({"table_id":table,"version":r.get::<u64,_>("version").to_string(),"preferred":r.get::<bool,_>("preferred")}))
        .unwrap_or_else(|| json!({"table_id":table,"version":"1","preferred":false}))))
}

pub async fn save_analysis_preference_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    table: &str,
    input: &Value,
) -> Result<(Value, bool)> {
    let operation = input["operation_id"]
        .as_str()
        .ok_or(Error::new("invalid_input"))?;
    let command = json!({"table_id":table,"input":input});
    let receipt = Operation::new(ctx, "analysis_preference", operation, &command);
    if let Some(saved) = receipt.begin(tx).await? {
        return Ok((saved, false));
    }
    sqlx::query("INSERT INTO table_analysis_preferences(space_id,table_id) VALUES(?,?) ON DUPLICATE KEY UPDATE table_id=VALUES(table_id)")
        .bind(&ctx.space_id)
        .bind(table)
        .execute(tx.connection())
        .await?;
    let row = sqlx::query("SELECT version,preferred FROM table_analysis_preferences WHERE space_id=? AND table_id=? FOR UPDATE")
        .bind(&ctx.space_id).bind(table).fetch_one(tx.connection()).await?;
    let version = row.get::<u64, _>("version");
    if input["expected_version"].as_str() != Some(version.to_string().as_str()) {
        return Err(Error::new("version_conflict"));
    }
    let preferred = input["preferred"]
        .as_bool()
        .ok_or(Error::new("invalid_input"))?;
    let changed = preferred != row.get::<bool, _>("preferred");
    let version = if changed {
        version.checked_add(1).ok_or(Error::new("invalid_input"))?
    } else {
        version
    };
    if changed {
        sqlx::query("UPDATE table_analysis_preferences SET version=?,preferred=?,updated_by=? WHERE space_id=? AND table_id=?")
            .bind(version).bind(preferred).bind(&ctx.user_id).bind(&ctx.space_id).bind(table).execute(tx.connection()).await?;
        sqlx::query("UPDATE prefill_attempts SET priority=? WHERE space_id=? AND table_id=? AND state='queued'")
            .bind(u8::from(preferred)).bind(&ctx.space_id).bind(table).execute(tx.connection()).await?;
    }
    let saved = json!({"table_id":table,"version":version.to_string(),"preferred":preferred});
    receipt.complete(tx, &saved).await?;
    Ok((saved, changed))
}
pub async fn check_prefill_sources_in_tx(
    tx: &mut AppTx<'_>,
    space: &str,
    sources: &Value,
) -> Result<()> {
    sqlx::query("SELECT space_id FROM source_sync_locks WHERE space_id=? FOR UPDATE")
        .bind(space)
        .fetch_one(tx.connection())
        .await?;
    for source in sources.as_array().ok_or(Error::new("invalid_input"))? {
        let current: Option<u64> = sqlx::query_scalar(
            "SELECT version FROM source_heads WHERE id=? AND space_id=? FOR UPDATE",
        )
        .bind(source["source_id"].as_str().unwrap_or(""))
        .bind(space)
        .fetch_optional(tx.connection())
        .await?;
        if current.map(|v| v.to_string()).as_deref() != source["version"].as_str() {
            return Err(Error::new("stale_knowledge"));
        }
    }
    Ok(())
}
pub async fn prefill_status_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &str,
) -> Result<Value> {
    let row=sqlx::query("SELECT id,state,error_code FROM prefill_attempts WHERE space_id=? AND object_id=? ORDER BY created_at DESC,id DESC LIMIT 1").bind(&ctx.space_id).bind(object).fetch_optional(tx.connection()).await?;
    Ok(row.map(|r|json!({"attempt_id":r.get::<String,_>("id"),"state":r.get::<String,_>("state"),"error_code":r.get::<Option<String>,_>("error_code")})).unwrap_or(Value::Null))
}

// 对象当前来源的语义整理状态（记录分支）：与对象级预填分开表达，两作业互不冒充。
// 人工独立对象（无来源）返回null；只取最新方法版本的实际进度，不猜进度。
// 排队作业还没有准备记录时的回退状态由组合层查jobs公开接口拼装。
pub async fn preparation_record_status_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &Value,
) -> Result<Value> {
    let Some((source, revision)) = preparation_source_of(object) else {
        return Ok(Value::Null);
    };
    let row = sqlx::query("SELECT semantic_status,error_code FROM source_preparations WHERE source_id=? AND revision=? AND space_id=? ORDER BY method_version DESC LIMIT 1")
        .bind(&source)
        .bind(revision)
        .bind(&ctx.space_id)
        .fetch_optional(tx.connection())
        .await?;
    Ok(row
        .map(|record| {
            json!({"source_id":source,"revision":revision.to_string(),
            "state":record.get::<String,_>("semantic_status"),
            "error_code":record.get::<Option<String>,_>("error_code")})
        })
        .unwrap_or(Value::Null))
}

// 对象的整理来源身份：单文档以自身为来源，目录对象沿主来源；人工独立对象无来源。
pub fn preparation_source_of(object: &Value) -> Option<(String, u64)> {
    if object["kind"] == "document" && object["source_id"].is_null() {
        let id = object["id"].as_str()?;
        let revision = object["version"].as_str()?.parse::<u64>().ok()?;
        return Some((format!("document-{id}"), revision));
    }
    let source = object["source_id"].as_str()?;
    let revision = object["source_version"].as_str()?.parse::<u64>().ok()?;
    Some((source.to_owned(), revision))
}
pub async fn claim_prefill_in_tx(tx: &mut AppTx<'_>, space: &str) -> Result<Option<Value>> {
    let expired = sqlx::query("SELECT id,input_json,result_json FROM prefill_attempts WHERE space_id=? AND state='issued' AND issued_until<UTC_TIMESTAMP(3) FOR UPDATE")
        .bind(space)
        .fetch_all(tx.connection())
        .await?;
    for row in expired {
        let mut input = row.get::<sqlx::types::Json<Value>, _>("input_json").0;
        let mut result = row
            .get::<Option<sqlx::types::Json<Value>>, _>("result_json")
            .map_or(Value::Null, |value| value.0);
        release_prefill_material(&mut input, &mut result);
        sqlx::query("UPDATE prefill_attempts SET state='unknown',error_code='model_unknown',input_json=?,result_json=?,issued_until=NULL WHERE id=? AND state='issued' AND issued_until<UTC_TIMESTAMP(3)")
            .bind(sqlx::types::Json(&input))
            .bind(sqlx::types::Json(&result))
            .bind(row.get::<String, _>("id"))
            .execute(tx.connection())
            .await?;
    }
    // 同次目录的后续页可能才包含上游；采集终止前不开始模型分析。
    let row = sqlx::query("SELECT * FROM prefill_attempts p WHERE space_id=? AND state='queued' AND (JSON_EXTRACT(input_json,'$.catalog_import_id') IS NULL OR EXISTS(SELECT 1 FROM catalog_imports c WHERE c.id=JSON_UNQUOTE(JSON_EXTRACT(p.input_json,'$.catalog_import_id')) AND ((c.background=1 AND c.state IN ('completed','failed')) OR (c.background=0 AND (c.state<>'fetching' OR c.lease_until<UTC_TIMESTAMP(3)))))) ORDER BY priority DESC,created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED").bind(space).fetch_optional(tx.connection()).await?;
    let Some(row) = row else { return Ok(None) };
    let id: String = row.get("id");
    // 已开始的请求在重启后保持未知，不自动重发模型请求。
    sqlx::query("UPDATE prefill_attempts SET state='issued',issued_until=TIMESTAMPADD(SECOND,?,UTC_TIMESTAMP(3)) WHERE id=?")
        .bind(super::prefill::timing()?.1)
        .bind(&id)
        .execute(tx.connection())
        .await?;
    Ok(Some(
        json!({"id":id,"object_id":row.get::<String,_>("object_id"),"expected_version":row.get::<u64,_>("expected_version").to_string(),"input":row.get::<sqlx::types::Json<Value>,_>("input_json").0}),
    ))
}
pub async fn finish_prefill_in_tx(
    tx: &mut AppTx<'_>,
    id: &str,
    state: &str,
    result: &Value,
    code: Option<&str>,
) -> Result<()> {
    let row = sqlx::query("SELECT state,input_json FROM prefill_attempts WHERE id=? FOR UPDATE")
        .bind(id)
        .fetch_optional(tx.connection())
        .await?;
    let Some(row) = row.filter(|row| row.get::<String, _>("state") == "issued") else {
        return Ok(());
    };
    let mut input = row.get::<sqlx::types::Json<Value>, _>("input_json").0;
    let mut result = result.clone();
    release_prefill_material(&mut input, &mut result);
    sqlx::query("UPDATE prefill_attempts SET state=?,input_json=?,result_json=?,error_code=?,issued_until=NULL WHERE id=? AND state='issued'")
        .bind(state)
        .bind(sqlx::types::Json(&input))
        .bind(sqlx::types::Json(&result))
        .bind(code)
        .bind(id)
        .execute(tx.connection())
        .await?;
    Ok(())
}

// 实际终态只释放临时材料；分析结果、引用、覆盖进度与原调用账本继续保留。
fn release_prefill_material(input: &mut Value, result: &mut Value) {
    if let Some(fields) = input.as_object_mut() {
        fields.remove("frozen_review_sources");
        fields.remove("metadata");
    }
    if let Some(object) = input["object"].as_object_mut() {
        object.remove("entries");
    }
    for source in input["sources"].as_array_mut().into_iter().flatten() {
        if let Some(fields) = source.as_object_mut() {
            for field in ["body", "supporting_excerpts", "quote_catalog"] {
                fields.remove(field);
            }
        }
    }
    if let Some(coverage) = result["review_input"].get("coverage").cloned() {
        result["material_coverage"] = coverage;
    }
    if let Some(fields) = result.as_object_mut() {
        fields.remove("review_input");
    }
}

pub async fn assert_prefill_active_in_tx(tx: &mut AppTx<'_>, attempt: &str) -> Result<()> {
    let active: i64=sqlx::query_scalar("SELECT state='issued' AND issued_until>UTC_TIMESTAMP(3) FROM prefill_attempts WHERE id=? FOR UPDATE").bind(attempt).fetch_one(tx.connection()).await?;
    if active == 0 {
        return Err(Error::new("model_unknown"));
    }
    Ok(())
}

pub async fn record_prefill_draft_in_tx(
    tx: &mut AppTx<'_>,
    attempt: &str,
    draft: &Value,
    review_input: &Value,
) -> Result<()> {
    assert_prefill_active_in_tx(tx, attempt).await?;
    // 复核仍属于同一次预填；保留分析草稿，更新当前领取的有效期，不重领或自动重发。
    sqlx::query("UPDATE prefill_attempts SET result_json=?,issued_until=TIMESTAMPADD(SECOND,?,UTC_TIMESTAMP(3)) WHERE id=?")
        .bind(sqlx::types::Json(serde_json::json!({"analysis":draft,"review_input":review_input})))
        .bind(super::prefill::timing()?.1)
        .bind(attempt).execute(tx.connection()).await?;
    Ok(())
}
