use super::store::{LockedConversation, Message, locked_conversation, message_from_row};
use crate::{
    persistence::AppTx,
    types::{AccessContext, Result},
};
use sqlx::Row;

pub(crate) const DELIVERY_INPUT_FROM: &str = " FROM conversations c JOIN conversation_messages m
    ON m.conversation_id=c.id AND m.owner_id=c.owner_id WHERE c.deleted=FALSE AND c.id=";

pub(crate) fn push_delivery_input(
    query: &mut sqlx::QueryBuilder<sqlx::MySql>,
    cid: &str,
    message: &str,
) {
    query
        .push(DELIVERY_INPUT_FROM)
        .push_bind(cid)
        .push(" AND m.id=")
        .push_bind(message);
}

pub(crate) const DELIVERY_LOCK_COLUMNS: &str = "m.*,c.space_id,c.deleted,c.lease_owner,c.lease_epoch,
    COALESCE(c.lease_until>UTC_TIMESTAMP(3),0) AS lease_valid,c.model_selection,c.model_selection_version,
    c.active_task_id,c.active_task_condition_version";

pub(crate) const LEGACY_CHECKPOINT_CONTEXT_SQL: &str = "SELECT c.id AS conversation_id,c.owner_id,c.space_id,
    COALESCE(m.request_id,m.id) AS request_id,c.lease_owner,c.lease_epoch,
    COALESCE(c.lease_until>UTC_TIMESTAMP(3),0) AS lease_valid,r.state,r.legacy_delivery_checkpoint
    FROM conversations c JOIN checkpoint_run r ON r.conversation_id=c.id
    JOIN conversation_messages m ON m.id=r.message_id AND m.conversation_id=c.id AND m.owner_id=c.owner_id
    WHERE c.deleted=FALSE FOR UPDATE OF c";

pub(crate) struct DeliveryInput {
    pub conversation: LockedConversation,
    pub message: Message,
    pub active_task: Option<(String, u64)>,
}

pub(crate) fn decode_delivery_lock(
    tx: &AppTx<'_>,
    ctx: &AccessContext,
    cid: &str,
    row: &sqlx::mysql::MySqlRow,
) -> Result<DeliveryInput> {
    let task = row
        .get::<Option<String>, _>("active_task_id")
        .zip(row.get("active_task_condition_version"));
    Ok(DeliveryInput {
        conversation: locked_conversation(tx, ctx, cid, row)?,
        message: message_from_row(row),
        active_task: task,
    })
}

pub(crate) const DELIVERY_TASK_ORDER_SQL: &str = "input_tasks AS (
    SELECT b.task_id FROM delivery_input i JOIN conversation_message_tasks b ON b.message_id=i.message_id
    UNION SELECT m.routed_task_id FROM delivery_input i JOIN conversation_messages m ON m.id=i.message_id
      WHERE m.routed_task_id IS NOT NULL
), recent_tasks AS (
    SELECT COALESCE(b.task_id,m.routed_task_id) AS task_id,MAX(e.event_seq) AS sequence
    FROM delivery_input i JOIN conversation_messages m ON m.conversation_id=i.conversation_id
    JOIN conversation_events e ON e.conversation_id=m.conversation_id AND e.event_type='message'
      AND JSON_UNQUOTE(JSON_EXTRACT(e.payload,'$.message_id'))=m.id
    LEFT JOIN conversation_message_tasks b ON b.message_id=m.id
    WHERE m.disposition<>'withdrawn' AND COALESCE(b.task_id,m.routed_task_id) IS NOT NULL
    GROUP BY COALESCE(b.task_id,m.routed_task_id)
)";
pub(crate) fn push_readable_delivery_conversations(
    sql: &mut sqlx::QueryBuilder<sqlx::MySql>,
    ctx: &crate::types::AccessContext,
) {
    sql.push(
        "WITH readable_delivery_conversations AS (SELECT id FROM conversations WHERE owner_id=",
    )
    .push_bind(&ctx.user_id)
    .push(" AND space_id=")
    .push_bind(&ctx.space_id)
    .push(" AND deleted=FALSE) ");
}
