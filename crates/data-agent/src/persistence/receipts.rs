use super::{AppTx, MySqlPool};
use crate::types::{AccessContext, Error, Result, fingerprint};
use serde_json::Value;
use sqlx::types::Json;

pub(crate) struct Operation<'a> {
    scope: &'a AccessContext,
    domain: &'static str,
    id: &'a str,
    hash: String,
}

impl<'a> Operation<'a> {
    pub(crate) fn new(
        scope: &'a AccessContext,
        domain: &'static str,
        id: &'a str,
        command: &Value,
    ) -> Self {
        Self {
            scope,
            domain,
            id,
            hash: fingerprint(command),
        }
    }

    async fn load(
        &self,
        tx: &mut AppTx<'_>,
        lock: bool,
        legacy_match: impl FnOnce(&str, &Value) -> bool,
    ) -> Result<Option<Value>> {
        let sql = if lock {
            "SELECT request_hash,response_json FROM idempotency_receipts WHERE space_id=? AND actor_id=? AND domain=? AND operation_id=? FOR UPDATE"
        } else {
            "SELECT request_hash,response_json FROM idempotency_receipts WHERE space_id=? AND actor_id=? AND domain=? AND operation_id=?"
        };
        let row = sqlx::query_as::<_, (String, Json<Value>)>(sql)
            .bind(&self.scope.space_id)
            .bind(&self.scope.user_id)
            .bind(self.domain)
            .bind(self.id)
            .fetch_optional(tx.connection())
            .await?;
        let Some((hash, Json(response))) = row else {
            return Ok(None);
        };
        if hash != self.hash && !legacy_match(&hash, &response) {
            return Err(Error::new("idempotency_conflict"));
        }
        Ok((!response.is_null()).then_some(response))
    }

    pub(crate) async fn read(&self, tx: &mut AppTx<'_>) -> Result<Option<Value>> {
        self.load(tx, false, |_, _| false).await
    }

    pub(crate) async fn begin(&self, tx: &mut AppTx<'_>) -> Result<Option<Value>> {
        self.begin_with(tx, |_, _| false).await
    }

    pub(crate) async fn execute(
        &self,
        tx: &mut AppTx<'_>,
        mutation: impl AsyncFnOnce(&mut AppTx<'_>) -> Result<Value>,
    ) -> Result<Value> {
        if let Some(response) = self.begin(tx).await? {
            return Ok(response);
        }
        let response = mutation(tx).await?;
        self.complete(tx, &response).await?;
        Ok(response)
    }

    pub(crate) async fn begin_with(
        &self,
        tx: &mut AppTx<'_>,
        legacy_match: impl FnOnce(&str, &Value) -> bool,
    ) -> Result<Option<Value>> {
        // 回执预占和副作用使用同一事务；并发重放在唯一键上串行。
        sqlx::query("INSERT INTO idempotency_receipts(space_id,actor_id,domain,operation_id,request_hash,response_json) VALUES(?,?,?,?,?,CAST('null' AS JSON)) ON DUPLICATE KEY UPDATE operation_id=idempotency_receipts.operation_id")
            .bind(&self.scope.space_id).bind(&self.scope.user_id).bind(self.domain).bind(self.id)
            .bind(&self.hash).execute(tx.connection()).await?;
        self.load(tx, true, legacy_match).await
    }

    pub(crate) async fn complete(&self, tx: &mut AppTx<'_>, response: &Value) -> Result<()> {
        sqlx::query("UPDATE idempotency_receipts SET response_json=? WHERE space_id=? AND actor_id=? AND domain=? AND operation_id=? AND request_hash=?")
            .bind(Json(response)).bind(&self.scope.space_id).bind(&self.scope.user_id)
            .bind(self.domain).bind(self.id).bind(&self.hash).execute(tx.connection()).await?;
        Ok(())
    }

    pub(crate) async fn discard_pending(&self, tx: &mut AppTx<'_>) -> Result<()> {
        sqlx::query("DELETE FROM idempotency_receipts WHERE space_id=? AND actor_id=? AND domain=? AND operation_id=? AND request_hash=? AND JSON_TYPE(response_json)='NULL'")
            .bind(&self.scope.space_id).bind(&self.scope.user_id).bind(self.domain).bind(self.id)
            .bind(&self.hash).execute(tx.connection()).await?;
        Ok(())
    }
}

pub(crate) async fn delete_subject(
    tx: &mut AppTx<'_>,
    scope: &AccessContext,
    domain: &str,
    path: &str,
    id: &str,
) -> Result<()> {
    sqlx::query("DELETE FROM idempotency_receipts WHERE space_id=? AND actor_id=? AND domain=? AND JSON_UNQUOTE(JSON_EXTRACT(response_json,?))=?")
        .bind(&scope.space_id).bind(&scope.user_id).bind(domain).bind(path).bind(id)
        .execute(tx.connection()).await?;
    Ok(())
}

pub async fn prune_expired(pool: &MySqlPool) -> Result<bool> {
    // 工具账本仍可能接回的操作保持原回执；过期清理只影响脱离恢复链的回执。
    let deleted = sqlx::query("DELETE FROM idempotency_receipts WHERE created_at<UTC_TIMESTAMP(3)-INTERVAL 30 DAY AND NOT EXISTS(SELECT 1 FROM tool_calls WHERE tool_calls.operation_id=idempotency_receipts.operation_id) LIMIT 500")
        .execute(pool).await?;
    Ok(deleted.rows_affected() == 500)
}
