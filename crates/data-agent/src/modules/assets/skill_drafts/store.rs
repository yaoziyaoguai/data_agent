use crate::{
    contracts,
    persistence::AppTx,
    types::{AccessContext, Error, Result, fingerprint, id},
};
use serde_json::{Value, json};
use sqlx::Row;

pub struct DraftOrigin<'a> {
    pub conversation_id: &'a str,
    pub operation_id: &'a str,
    pub source_message_id: &'a str,
    pub origin_run_id: &'a str,
}

pub struct StoredDraft {
    pub reference: Value,
    pub state: String,
    pub body: Option<Value>,
    pub asset_id: Option<String>,
}

impl StoredDraft {
    pub fn view(&self) -> Result<Value> {
        let mut value = json!({"status":self.state,"reference":self.reference});
        if self.state == "pending" {
            let body = self.body.as_ref().ok_or(Error::new("invalid_input"))?;
            for key in [
                "name",
                "body",
                "scope",
                "files",
                "dependencies",
                "evidence_refs",
                "created_at",
            ] {
                value[key] = body[key].clone();
            }
        } else if self.state == "confirmed" {
            value["asset_id"] = json!(self.asset_id.as_ref().ok_or(Error::new("invalid_input"))?);
        }
        contracts::validate("SkillDraft", &value)?;
        Ok(value)
    }
}

fn stored(row: &sqlx::mysql::MySqlRow) -> StoredDraft {
    StoredDraft {
        reference: row.get::<sqlx::types::Json<Value>, _>("reference").0,
        state: row.get("state"),
        body: row
            .get::<Option<sqlx::types::Json<Value>>, _>("body")
            .map(|body| body.0),
        asset_id: row.get("asset_id"),
    }
}

pub async fn locate_in_tx(tx: &mut AppTx<'_>, ctx: &AccessContext, draft: &str) -> Result<Value> {
    sqlx::query_scalar::<_, sqlx::types::Json<Value>>(
        "SELECT reference FROM skill_drafts WHERE id=? AND owner_id=? AND space_id=?",
    )
    .bind(draft)
    .bind(&ctx.user_id)
    .bind(&ctx.space_id)
    .fetch_optional(tx.connection())
    .await?
    .map(|value| value.0)
    .ok_or(Error::new("not_available"))
}

pub async fn read_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    draft: &str,
) -> Result<StoredDraft> {
    let row = sqlx::query("SELECT reference,state,body,asset_id FROM skill_drafts WHERE id=? AND owner_id=? AND space_id=? FOR UPDATE")
        .bind(draft).bind(&ctx.user_id).bind(&ctx.space_id).fetch_optional(tx.connection()).await?
        .ok_or(Error::new("not_available"))?;
    Ok(stored(&row))
}

pub async fn page_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    after: &str,
) -> Result<Vec<String>> {
    Ok(sqlx::query_scalar(
        "SELECT id FROM skill_drafts WHERE owner_id=? AND space_id=? AND id>? ORDER BY id LIMIT 21",
    )
    .bind(&ctx.user_id)
    .bind(&ctx.space_id)
    .bind(after)
    .fetch_all(tx.connection())
    .await?)
}

pub async fn prepare_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    origin: DraftOrigin<'_>,
    input: &Value,
    dependencies: &Value,
    evidence_refs: &Value,
) -> Result<Value> {
    contracts::validate("PrepareSkillDraftInput", input)?;
    let reference = json!({"draft_id":id(),"conversation_id":origin.conversation_id,
        "task_id":input["task_id"],"condition_version":input["condition_version"],
        "source_message_id":origin.source_message_id});
    contracts::validate("SkillDraftRef", &reference)?;
    let command = fingerprint(
        &json!({"input":input,"conversation_id":origin.conversation_id,
        "source_message_id":origin.source_message_id,"origin_run_id":origin.origin_run_id}),
    );
    let created_at = sqlx::query_scalar::<_, String>(
        "SELECT DATE_FORMAT(UTC_TIMESTAMP(3),'%Y-%m-%dT%H:%i:%s.%fZ')",
    )
    .fetch_one(tx.connection())
    .await?;
    let body = json!({"name":input["name"],"body":input["body"],"scope":input["scope"],
        "files":input["files"],"dependencies":dependencies,"evidence_refs":evidence_refs,"created_at":created_at});
    StoredDraft {
        reference: reference.clone(),
        state: "pending".into(),
        body: Some(body.clone()),
        asset_id: None,
    }
    .view()?;
    super::super::skill_files::validate(&json!("skill"), &input["files"])?;
    super::super::skill_files::content(
        &json!({"id":reference["draft_id"],"name":input["name"],"scope":input["scope"],"body":input["body"],"files":input["files"],"dependencies":dependencies}),
        "SKILL.md",
    )?;
    sqlx::query("INSERT INTO skill_drafts(id,owner_id,space_id,conversation_id,source_message_id,origin_run_id,operation_id,fingerprint,reference,state,body) VALUES(?,?,?,?,?,?,?,?,?,'pending',?) ON DUPLICATE KEY UPDATE operation_id=VALUES(operation_id)")
        .bind(reference["draft_id"].as_str()).bind(&ctx.user_id).bind(&ctx.space_id)
        .bind(origin.conversation_id).bind(origin.source_message_id).bind(origin.origin_run_id)
        .bind(origin.operation_id).bind(&command).bind(sqlx::types::Json(&reference))
        .bind(sqlx::types::Json(&body)).execute(tx.connection()).await?;
    let row = sqlx::query("SELECT fingerprint,reference FROM skill_drafts WHERE owner_id=? AND space_id=? AND operation_id=? FOR UPDATE")
        .bind(&ctx.user_id).bind(&ctx.space_id).bind(origin.operation_id).fetch_one(tx.connection()).await?;
    if row.get::<String, _>("fingerprint") != command {
        return Err(Error::new("idempotency_conflict"));
    }
    Ok(row.get::<sqlx::types::Json<Value>, _>("reference").0)
}

pub async fn invalidate_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    draft: &str,
    state: &str,
) -> Result<()> {
    if !matches!(state, "condition_changed" | "sources_unavailable") {
        return Err(Error::new("invalid_input"));
    }
    sqlx::query("UPDATE skill_drafts SET state=?,body=NULL WHERE id=? AND owner_id=? AND space_id=? AND state='pending'")
        .bind(state).bind(draft).bind(&ctx.user_id).bind(&ctx.space_id).execute(tx.connection()).await?;
    Ok(())
}

pub async fn confirm_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    draft: &str,
    asset: &str,
) -> Result<()> {
    let updated = sqlx::query("UPDATE skill_drafts SET state='confirmed',asset_id=?,body=NULL WHERE id=? AND owner_id=? AND space_id=? AND state='pending'")
        .bind(asset).bind(draft).bind(&ctx.user_id).bind(&ctx.space_id).execute(tx.connection()).await?;
    if updated.rows_affected() != 1 {
        return Err(Error::new("version_conflict"));
    }
    Ok(())
}

pub async fn delete_conversation_drafts_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    cid: &str,
) -> Result<()> {
    sqlx::query("UPDATE skill_drafts SET state='sources_unavailable',body=NULL WHERE owner_id=? AND space_id=? AND conversation_id=? AND state<>'confirmed'")
        .bind(&ctx.user_id).bind(&ctx.space_id).bind(cid).execute(tx.connection()).await?;
    Ok(())
}
