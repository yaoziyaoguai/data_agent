use super::decisions::ConditionRevision;
use crate::{
    persistence::AppTx,
    types::{Error, Result, epoch},
};
use serde_json::{Value, json};
use sqlx::Row;

pub async fn read_tasks_in_tx(tx: &mut AppTx<'_>, cid: &str) -> Result<Vec<Value>> {
    let rows = sqlx::query("SELECT * FROM analysis_tasks WHERE conversation_id=? ORDER BY id")
        .bind(cid)
        .fetch_all(tx.connection())
        .await?;
    let mut result = Vec::new();
    for row in rows {
        let task = row.get::<String, _>("id");
        let version = row.get::<u64, _>("condition_version");
        let refs = super::evidence::refs_in_tx(tx, cid, &task, version).await?;
        let mut snapshot = json!({"id":task,"goal":row.get::<String,_>("goal"),"condition_version":version.to_string(),"lifecycle":row.get::<String,_>("lifecycle"),"phase":row.get::<String,_>("phase"),"evidence_refs":refs});
        if let Some(reference) = super::report::report_ref_in_tx(tx, cid, &task).await? {
            snapshot["report_ref"] = reference;
        }
        result.push(snapshot);
    }
    Ok(result)
}

pub async fn active_condition_versions_in_tx(
    tx: &mut AppTx<'_>,
    tasks: &[&str],
) -> Result<std::collections::HashMap<String, String>> {
    let mut versions = std::collections::HashMap::new();
    for chunk in tasks.chunks(256) {
        let mut query = sqlx::QueryBuilder::<sqlx::MySql>::new(
            "SELECT id,CAST(condition_version AS CHAR) FROM analysis_tasks WHERE lifecycle='active' AND id IN (",
        );
        let mut ids = query.separated(",");
        for task in chunk {
            ids.push_bind(task);
        }
        ids.push_unseparated(")");
        versions.extend(
            query
                .build_query_as::<(String, String)>()
                .fetch_all(tx.connection())
                .await?,
        );
    }
    Ok(versions)
}

pub(crate) const TASK_CONTEXT_SQL: &str = "task_context AS (
    SELECT t.id, JSON_OBJECT('id',t.id,'goal',t.goal,'condition_version',CAST(t.condition_version AS CHAR),
       'phase',t.phase,'lifecycle',t.lifecycle,'conditions',c.body,'stored_decision_state',c.decision_state_version,
       'report_ref',r.reference,'clarification',IF(q.id IS NULL,NULL,
            JSON_OBJECT('id',q.id,'question',q.question,'options',q.options)),
       'evidence_refs', (SELECT JSON_ARRAYAGG(JSON_OBJECT('reference',ref.reference,
                   'created_at',ref.created_at,'id',ref.id))
            FROM (SELECT reference,created_at,id FROM analysis_evidence
                WHERE task_id=t.id AND conversation_id=t.conversation_id AND condition_version=t.condition_version
                ORDER BY created_at DESC,id DESC LIMIT 5) ref),
       'has_more_clarifications', EXISTS(SELECT 1 FROM clarifications other
            WHERE other.task_id=t.id AND other.state='open' AND other.id<>q.id)) AS body
     FROM delivery_input i JOIN analysis_tasks t ON t.conversation_id=i.conversation_id
     LEFT JOIN condition_revisions c ON t.id=c.task_id AND t.condition_version=c.version
     LEFT JOIN analysis_reports r ON r.task_id=t.id AND r.conversation_id=t.conversation_id
     LEFT JOIN clarifications q ON q.id=(SELECT first.id FROM clarifications first
           WHERE first.task_id=t.id AND first.state='open' ORDER BY first.condition_version,first.id LIMIT 1)
)";

pub(crate) fn decode_task_context(mut snapshot: Value) -> Result<Value> {
    let mut refs = snapshot["evidence_refs"]
        .take()
        .as_array_mut()
        .map(std::mem::take)
        .unwrap_or_default();
    refs.sort_by(|a, b| {
        (b["created_at"].as_str(), b["id"].as_str())
            .cmp(&(a["created_at"].as_str(), a["id"].as_str()))
    });
    snapshot["evidence_refs"] = json!(
        refs.into_iter()
            .map(|mut r| r["reference"].take())
            .collect::<Vec<_>>()
    );
    let recorded_version = snapshot
        .as_object_mut()
        .ok_or(crate::types::Error::new("unavailable"))?
        .remove("stored_decision_state");
    if !snapshot["conditions"].is_null() {
        let revision = ConditionRevision::from_stored(
            snapshot["conditions"].clone(),
            recorded_version
                .and_then(|v| v.as_u64())
                .ok_or(crate::types::Error::new("unavailable"))? as u8,
        )?;
        snapshot["decision_state_version"] = json!(revision.decision_state.number());
        if let Some(pending) = revision.legacy_pending(epoch(
            snapshot["condition_version"]
                .as_str()
                .ok_or(crate::types::Error::new("unavailable"))?,
        )?)? {
            snapshot["legacy_pending"] = pending;
        }
    }
    let more = snapshot["has_more_clarifications"]
        .as_bool()
        .ok_or(crate::types::Error::new("unavailable"))?;
    if more {
        snapshot["context_complete"] = json!(false);
    }
    if snapshot["report_ref"].is_null() {
        snapshot
            .as_object_mut()
            .ok_or(crate::types::Error::new("unavailable"))?
            .remove("report_ref");
    }
    Ok(snapshot)
}

pub async fn context_in_tx(tx: &mut AppTx<'_>, cid: &str) -> Result<Vec<Value>> {
    let mut sql = sqlx::QueryBuilder::<sqlx::MySql>::new("WITH delivery_input AS (SELECT ");
    sql.push_bind(cid)
        .push(" AS conversation_id),")
        .push(TASK_CONTEXT_SQL)
        .push(" SELECT body FROM task_context ORDER BY id");
    sql.build_query_scalar::<sqlx::types::Json<Value>>()
        .fetch_all(tx.connection())
        .await?
        .into_iter()
        .map(|row| decode_task_context(row.0))
        .collect()
}

// 包含空范围 [null] 和无声明 [] 两种不同状态，并持有每项任务自己的有效声明。
pub(crate) const DELIVERY_SOURCE_LIMITS_SQL: &str = "task_source_limits AS (
    SELECT t.id, t.lifecycle,
       (SELECT JSON_ARRAY(JSON_EXTRACT(c.body,'$.source_limits')) FROM condition_revisions c
        WHERE c.task_id=t.id AND c.version<=t.condition_version
          AND JSON_CONTAINS_PATH(c.body,'one','$.source_limits') ORDER BY c.version DESC LIMIT 1) AS declared,
       (SELECT JSON_ARRAY(JSON_EXTRACT(c.body,'$.source_limits')) FROM condition_revisions c
        WHERE t.id=i.previous_task_id AND c.task_id=t.id AND c.version<=LEAST(t.condition_version,i.previous_version)
          AND JSON_CONTAINS_PATH(c.body,'one','$.source_limits') ORDER BY c.version DESC LIMIT 1) AS previous
    FROM delivery_input i JOIN analysis_tasks t ON t.conversation_id=i.conversation_id
)";

async fn clarification_preview_in_tx(
    tx: &mut AppTx<'_>,
    task: &str,
) -> Result<(Option<Value>, bool)> {
    // 只交付首题正文，但保留省略信号，避免把未答问题预览当作全集。
    let rows = sqlx::query("SELECT id,question,options FROM clarifications WHERE task_id=? AND state='open' ORDER BY condition_version,id LIMIT 2")
        .bind(task).fetch_all(tx.connection()).await?;
    let first = rows.first().map(|value| {
        json!({"id":value.get::<String,_>("id"),"question":value.get::<String,_>("question"),"options":value.get::<sqlx::types::Json<Value>,_>("options").0})
    });
    Ok((first, rows.len() > 1))
}

/// 宿主最终交付使用的可见澄清预览；与任务卡读取同一首题和省略信号。
pub async fn clarification_preview_for_task_in_tx(
    tx: &mut AppTx<'_>,
    task: &str,
) -> Result<(Option<Value>, bool)> {
    clarification_preview_in_tx(tx, task).await
}

pub async fn recovery_state_in_tx(tx: &mut AppTx<'_>, cid: &str, task: &str) -> Result<Value> {
    let row = sqlx::query("SELECT condition_version,lifecycle,phase FROM analysis_tasks WHERE id=? AND conversation_id=?")
        .bind(task).bind(cid).fetch_optional(tx.connection()).await?
        .ok_or(Error::new("not_available"))?;
    let ids: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM clarifications WHERE task_id=? AND state='open' ORDER BY id LIMIT 9",
    )
    .bind(task)
    .fetch_all(tx.connection())
    .await?;
    let source_limits_declared = declared_source_limits_in_tx(tx, cid, task).await?.is_some();
    Ok(json!({
        "task_id":task,
        "condition_version":row.get::<u64,_>("condition_version").to_string(),
        "lifecycle":row.get::<String,_>("lifecycle"),
        "phase":row.get::<String,_>("phase"),
        "source_limits_declared":source_limits_declared,
        "open_clarification_ids":ids.iter().take(8).collect::<Vec<_>>(),
        "has_more_clarifications":ids.len()>8,
        "read_tool":{"name":"read_analysis_task","arguments":{"task_id":task}}
    }))
}

pub async fn read_task_in_tx(tx: &mut AppTx<'_>, cid: &str, task: &str) -> Result<Value> {
    context_in_tx(tx, cid)
        .await?
        .into_iter()
        .find(|t| t["id"] == task)
        .ok_or(crate::types::Error::new("not_available"))
}

// 条件修订按会话归属读取正文、字段来源与宿主格式；读取不迁移旧版本。
pub async fn condition_revision_in_tx(
    tx: &mut AppTx<'_>,
    cid: &str,
    task: &str,
    version: u64,
) -> Result<ConditionRevision> {
    let row = sqlx::query(
        "SELECT c.body,c.decision_state_version FROM condition_revisions c \
         JOIN analysis_tasks t ON t.id=c.task_id WHERE t.conversation_id=? AND c.task_id=? AND c.version=?",
    ).bind(cid).bind(task).bind(version).fetch_optional(tx.connection()).await?.ok_or(Error::new("not_available"))?;
    ConditionRevision::from_stored(
        row.get::<sqlx::types::Json<Value>, _>("body").0,
        row.get("decision_state_version"),
    )
}

pub async fn current_condition_revision_in_tx(
    tx: &mut AppTx<'_>,
    cid: &str,
    task: &str,
) -> Result<Option<ConditionRevision>> {
    let row = sqlx::query(
        "SELECT c.body,c.decision_state_version FROM condition_revisions c \
         JOIN analysis_tasks t ON t.id=c.task_id AND t.condition_version=c.version WHERE t.conversation_id=? AND t.id=?",
    ).bind(cid).bind(task).fetch_optional(tx.connection()).await?;
    row.map(|row| {
        ConditionRevision::from_stored(
            row.get::<sqlx::types::Json<Value>, _>("body").0,
            row.get("decision_state_version"),
        )
    })
    .transpose()
}

/// 原修订里最后一次明确保存的范围；缺字段与显式null保持不同含义。
pub async fn declared_source_limits_in_tx(
    tx: &mut AppTx<'_>,
    cid: &str,
    task: &str,
) -> Result<Option<Value>> {
    source_limits_at_version_in_tx(tx, cid, task, u64::MAX).await
}

pub async fn active_task_sources_unrestricted_in_tx(tx: &mut AppTx<'_>, cid: &str) -> Result<bool> {
    let unrestricted = sqlx::query_scalar::<_, i64>(
        "SELECT NOT EXISTS(SELECT 1 FROM analysis_tasks t
         LEFT JOIN condition_revisions c ON c.task_id=t.id AND c.version=(
           SELECT MAX(v.version) FROM condition_revisions v WHERE v.task_id=t.id
           AND v.version<=t.condition_version AND JSON_CONTAINS_PATH(v.body,'one','$.source_limits'))
         WHERE t.conversation_id=? AND t.lifecycle='active'
         AND (c.task_id IS NULL OR JSON_TYPE(JSON_EXTRACT(c.body,'$.source_limits'))<>'NULL'))",
    ).bind(cid).fetch_one(tx.connection()).await?;
    Ok(unrestricted != 0)
}

pub async fn source_limits_at_version_in_tx(
    tx: &mut AppTx<'_>,
    cid: &str,
    task: &str,
    version: u64,
) -> Result<Option<Value>> {
    let limits = sqlx::query_scalar::<_, sqlx::types::Json<Value>>(
        "SELECT JSON_EXTRACT(c.body,'$.source_limits') FROM condition_revisions c JOIN analysis_tasks t ON t.id=c.task_id \
         WHERE t.conversation_id=? AND t.id=? AND c.version<=LEAST(t.condition_version,?) \
         AND JSON_CONTAINS_PATH(c.body,'one','$.source_limits') \
         ORDER BY c.version DESC LIMIT 1",
    )
    .bind(cid)
    .bind(task)
    .bind(version)
    .fetch_optional(tx.connection())
    .await?;
    Ok(limits.map(|limits| limits.0))
}

pub async fn read_task_with_clarifications_in_tx(
    tx: &mut AppTx<'_>,
    cid: &str,
    task: &str,
    after: Option<&str>,
    version: Option<u64>,
) -> Result<Value> {
    let mut snapshot = read_task_in_tx(tx, cid, task).await?;
    // 正式读取以本页问题和游标表达范围；正文来源保护在组装完成后继续执行。
    for key in ["has_more_clarifications", "context_complete"] {
        snapshot
            .as_object_mut()
            .ok_or(crate::types::Error::new("unavailable"))?
            .remove(key);
    }
    let current_version = epoch(snapshot["condition_version"].as_str().unwrap_or("0"))?;
    let requested_version = version.unwrap_or(current_version);
    snapshot["current_condition_version"] = snapshot["condition_version"].clone();
    snapshot["is_historical"] = json!(requested_version != current_version);
    if requested_version != current_version {
        let revision = condition_revision_in_tx(tx, cid, task, requested_version).await?;
        snapshot["legacy_pending"] = revision
            .legacy_pending(requested_version)?
            .unwrap_or(Value::Null);
        if snapshot["legacy_pending"].is_null() {
            snapshot
                .as_object_mut()
                .ok_or(crate::types::Error::new("unavailable"))?
                .remove("legacy_pending");
        }
        snapshot["decision_state_version"] = json!(revision.decision_state.number());
        snapshot["conditions"] = revision.body;
        snapshot["condition_version"] = json!(requested_version.to_string());
        snapshot["evidence_refs"] =
            json!(super::evidence::refs_in_tx(tx, cid, task, requested_version).await?);
        // 历史条件不能借当前任务文本带出另一个版本的资料；goal没有历史版本。
        for key in ["report_ref", "goal", "clarification"] {
            snapshot
                .as_object_mut()
                .ok_or(crate::types::Error::new("unavailable"))?
                .remove(key);
        }
    }
    snapshot["note"] = json!(
        "conditions与evidence_refs属于所读condition_version；current_condition_version/lifecycle/phase为当前控制状态。历史读取仅带当前开放问题ID，不携当前目标、问题或选项正文；当前正文须另按当前版本读取并校验依据。历史条件只供调查和引用，不授予执行权。"
    );
    if let Some(cursor) = after {
        // 翻页期间问题可能已被回答，但游标仍须属于当前任务。
        sqlx::query_scalar::<_, String>(
            "SELECT id FROM clarifications WHERE id=? AND task_id=? AND conversation_id=?",
        )
        .bind(cursor)
        .bind(task)
        .bind(cid)
        .fetch_optional(tx.connection())
        .await?
        .ok_or(Error::new("not_available"))?;
    }
    let rows = sqlx::query("SELECT id,question,options FROM clarifications WHERE task_id=? AND state='open' AND (? IS NULL OR id>?) ORDER BY id LIMIT 9")
        .bind(task).bind(after).bind(after).fetch_all(tx.connection()).await?;
    let clarifications = rows.iter().take(8).map(|row| {
        json!({"id":row.get::<String,_>("id"),"question":row.get::<String,_>("question"),"options":row.get::<sqlx::types::Json<Value>,_>("options").0})
    }).collect::<Vec<_>>();
    snapshot["next_clarification_after"] = if rows.len() > 8 {
        clarifications
            .last()
            .ok_or(crate::types::Error::new("unavailable"))?["id"]
            .clone()
    } else {
        Value::Null
    };
    if requested_version == current_version {
        snapshot["open_clarifications"] = json!(clarifications);
    } else {
        snapshot["current_open_clarification_ids"] = json!(
            clarifications
                .iter()
                .map(|item| &item["id"])
                .collect::<Vec<_>>()
        );
    }
    Ok(snapshot)
}

pub async fn task_directory_in_tx(
    tx: &mut AppTx<'_>,
    cid: &str,
    after: Option<&str>,
) -> Result<Value> {
    let rows=sqlx::query("SELECT id,goal,condition_version,lifecycle,phase FROM analysis_tasks WHERE conversation_id=? AND (? IS NULL OR id>?) ORDER BY id LIMIT 21")
       .bind(cid).bind(after).bind(after).fetch_all(tx.connection()).await?;
    let tasks=rows.iter().take(20).map(|r|json!({"id":r.get::<String,_>("id"),"goal":r.get::<String,_>("goal").chars().take(240).collect::<String>(),"condition_version":r.get::<u64,_>("condition_version").to_string(),"lifecycle":r.get::<String,_>("lifecycle"),"phase":r.get::<String,_>("phase")})).collect::<Vec<_>>();
    let next = if rows.len() > 20 {
        tasks.last().map(|v| v["id"].clone())
    } else {
        None
    };
    Ok(
        json!({"tasks":tasks,"next_task_after":next,"note":"仅目录摘要；按真实ID用read_analysis_task读取当前条件。该目录覆盖同一消息建立的多个任务。"}),
    )
}
