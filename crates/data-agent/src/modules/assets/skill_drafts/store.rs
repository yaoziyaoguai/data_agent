use crate::{
    contracts,
    persistence::{AppTx, receipts::Operation},
    types::{AccessContext, Error, Result, id},
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

pub async fn locate_in_tx(tx: &mut AppTx<'_>, ctx: &AccessContext, draft: &str) -> Result<Value> {
    sqlx::query_scalar::<_, sqlx::types::Json<Value>>(
        "SELECT JSON_EXTRACT(draft_origin,'$.reference') FROM personal_assets WHERE id=? AND owner_id=? AND space_id=? AND draft_origin IS NOT NULL",
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
    let row = sqlx::query("SELECT body,draft_origin FROM personal_assets WHERE id=? AND owner_id=? AND space_id=? AND draft_origin IS NOT NULL FOR UPDATE")
        .bind(draft).bind(&ctx.user_id).bind(&ctx.space_id).fetch_optional(tx.connection()).await?
        .ok_or(Error::new("not_available"))?;
    let origin = row.get::<sqlx::types::Json<Value>, _>("draft_origin").0;
    let state = origin["status"]
        .as_str()
        .ok_or(crate::types::Error::new("unavailable"))?
        .to_owned();
    let body = (state == "pending").then(|| {
        let mut body = row.get::<sqlx::types::Json<Value>, _>("body").0;
        body["evidence_refs"] = origin["evidence_refs"].clone();
        body["created_at"] = origin["created_at"].clone();
        body
    });
    Ok(StoredDraft {
        state,
        body,
        reference: origin["reference"].clone(),
        asset_id: origin["asset_id"].as_str().map(str::to_owned),
    })
}

pub async fn page_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    after: &str,
) -> Result<Vec<String>> {
    Ok(sqlx::query_scalar(
        "SELECT id FROM personal_assets WHERE owner_id=? AND space_id=? AND draft_origin IS NOT NULL AND id>? ORDER BY id LIMIT 21",
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
    skill_sources: Option<&Value>,
) -> Result<Value> {
    let reference = json!({"draft_id":id(),"conversation_id":origin.conversation_id,
        "task_id":input["task_id"],"condition_version":input["condition_version"],
        "source_message_id":origin.source_message_id});
    contracts::validate("SkillDraftRef", &reference)?;
    let receipt = Operation::new(
        ctx,
        "skill_draft",
        origin.operation_id,
        &json!({"input":input,"conversation_id":origin.conversation_id,
            "source_message_id":origin.source_message_id,"origin_run_id":origin.origin_run_id}),
    );
    if let Some(reference) = receipt.begin(tx).await? {
        return Ok(reference);
    }
    let created_at = sqlx::query_scalar::<_, String>(
        "SELECT DATE_FORMAT(UTC_TIMESTAMP(3),'%Y-%m-%dT%H:%i:%s.%fZ')",
    )
    .fetch_one(tx.connection())
    .await?;
    let mut body = json!({"id":reference["draft_id"],"kind":"skill","state":"draft","version":"1",
        "verified":false,"selected":false,"source_text":"","name":input["name"],"body":input["body"],
        "scope":input["scope"],"files":input["files"],"dependencies":dependencies});
    if let Some(sources) = skill_sources {
        body["skill_sources"] = sources.clone();
    }
    let origin = json!({"reference":reference,"status":"pending",
        "evidence_refs":evidence_refs,"created_at":created_at,"operation_id":origin.operation_id,"origin_run_id":origin.origin_run_id});

    super::super::skill_files::validate(&json!("skill"), &input["files"])?;
    super::super::skill_files::content(
        &json!({"id":reference["draft_id"],"name":input["name"],"scope":input["scope"],"body":input["body"],"files":input["files"],"dependencies":dependencies}),
        "SKILL.md",
    )?;
    sqlx::query("INSERT INTO personal_assets(id,owner_id,space_id,version,kind,state,visibility,body,draft_origin) VALUES(?,?,?,1,'skill','draft','personal',?,?)")
        .bind(reference["draft_id"].as_str()).bind(&ctx.user_id).bind(&ctx.space_id)
        .bind(sqlx::types::Json(&body)).bind(sqlx::types::Json(&origin)).execute(tx.connection()).await?;
    receipt.complete(tx, &reference).await?;
    Ok(reference)
}

pub async fn discard_in_tx(tx: &mut AppTx<'_>, ctx: &AccessContext, draft: &str) -> Result<()> {
    sqlx::query("UPDATE personal_assets SET state='deleted',body=JSON_OBJECT(),draft_origin=JSON_SET(draft_origin,'$.status','discarded','$.evidence_refs',NULL) WHERE id=? AND owner_id=? AND space_id=? AND state='draft'")
        .bind(draft).bind(&ctx.user_id).bind(&ctx.space_id).execute(tx.connection()).await?;
    Ok(())
}

pub async fn confirm_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    draft: &str,
    asset: &str,
) -> Result<()> {
    let updated = sqlx::query("UPDATE personal_assets SET draft_origin=JSON_SET(draft_origin,'$.status','confirmed','$.asset_id',?,'$.evidence_refs',NULL) WHERE id=? AND owner_id=? AND space_id=? AND JSON_UNQUOTE(JSON_EXTRACT(draft_origin,'$.status'))='pending'")
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
    sqlx::query("UPDATE personal_assets SET state='deleted',body=JSON_OBJECT(),draft_origin=JSON_SET(draft_origin,'$.status','sources_unavailable','$.evidence_refs',NULL) WHERE owner_id=? AND space_id=? AND JSON_UNQUOTE(JSON_EXTRACT(draft_origin,'$.reference.conversation_id'))=? AND state='draft'")
        .bind(&ctx.user_id).bind(&ctx.space_id).bind(cid).execute(tx.connection()).await?;
    Ok(())
}
