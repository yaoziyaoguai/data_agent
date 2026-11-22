use crate::{
    contracts::generated::{History, HistoryItem},
    persistence::AppTx,
    types::{AccessContext, Error, Result},
};

pub async fn list_conversations_in_tx(
    tx: &mut AppTx<'_>,
    context: &AccessContext,
    before: Option<&str>,
    query: &str,
) -> Result<History> {
    let cursor = if let Some(id) = before {
        Some(sqlx::query_scalar::<_,String>("SELECT DATE_FORMAT(created_at,'%Y-%m-%d %H:%i:%s.%f') FROM conversations WHERE id=? AND owner_id=? AND space_id=?")
            .bind(id).bind(&context.user_id).bind(&context.space_id).fetch_optional(tx.connection()).await?.ok_or(Error::new("invalid_input"))?)
    } else {
        None
    };
    let rows = sqlx::query_as::<_, (String, String, String)>("SELECT id,COALESCE(title,'新对话') AS title,DATE_FORMAT(created_at,'%Y-%m-%dT%H:%i:%s.%fZ') AS created_at FROM conversations WHERE owner_id=? AND space_id=? AND deleted=0 AND INSTR(LOWER(COALESCE(title,'')),LOWER(?))>0 AND (? IS NULL OR created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT 101")
        .bind(&context.user_id).bind(&context.space_id).bind(query).bind(&cursor).bind(&cursor).bind(&cursor).bind(before).fetch_all(tx.connection()).await?;
    let next_before_id = (rows.len() > 100).then(|| rows[99].0.clone());
    let conversations = rows
        .into_iter()
        .take(100)
        .map(|(id, title, created_at)| HistoryItem {
            id,
            title,
            created_at: Some(created_at),
        })
        .collect();
    Ok(History {
        conversations,
        next_before_id,
    })
}
