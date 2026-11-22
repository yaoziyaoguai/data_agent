use crate::{
    contracts::{self, generated::ModelProfile},
    modules::{analysis, assets, conversations, ingestion, knowledge, queries, runtime},
    persistence::AppTx,
    types::{AccessContext, Error, Result, id},
};
use serde::Deserialize;
use serde_json::Value;
use sqlx::{MySql, MySqlPool, QueryBuilder, Row, mysql::MySqlRow, types::Json};
use std::collections::{HashMap, HashSet};

pub(crate) struct PendingDelivery {
    pub context: AccessContext,
    pub lease_epoch: u64,
    pub history: runtime::DeliveryHistory,
    pub selected_skill_provenance: Vec<Value>,
}

#[derive(Clone)]
pub(crate) struct DeliveryResult {
    pub reference: String,
    pub target_id: String,
    pub objects: Vec<String>,
}

pub(crate) async fn result_heads(
    pool: &MySqlPool,
    ctx: &AccessContext,
    ids: &[&str],
) -> Result<HashMap<String, DeliveryResult>> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let mut sql = QueryBuilder::<MySql>::new("");
    conversations::push_readable_delivery_conversations(&mut sql, ctx);
    queries::push_delivery_result_heads(&mut sql, &ctx.user_id, ids);
    let rows = sql.build().fetch_all(pool).await?;
    Ok(rows
        .into_iter()
        .filter_map(|row| {
            let reference = row.get::<Option<String>, _>("result_ref")?;
            Some((
                row.get("id"),
                DeliveryResult {
                    reference,
                    target_id: row.get("target_id"),
                    objects: array(&row, "object_ids"),
                },
            ))
        })
        .collect())
}

pub(crate) async fn pending(pool: &MySqlPool, cid: &str, message: &str) -> Result<PendingDelivery> {
    let mut tx = AppTx::begin(pool).await?;
    let mut query = QueryBuilder::<MySql>::new(
        "WITH delivery_input AS (
        SELECT c.id AS conversation_id,c.owner_id,c.space_id,c.lease_epoch,
            COALESCE(c.lease_until>UTC_TIMESTAMP(3),0) AS lease_valid,m.recovery_chain_id",
    );
    conversations::push_delivery_input(&mut query, cid, message);
    // 先锁住输入和会话，旧轮次提交完才能取得同一个原生检查点。
    query
        .push(" LIMIT 1 FOR UPDATE OF c,m),")
        .push(runtime::DELIVERY_HISTORY_SQL)
        .push(" SELECT i.owner_id,i.space_id,i.lease_epoch,i.lease_valid,h.*,")
        .push(assets::WORKSPACE_SELECTED_PROVENANCE_SQL)
        .push(" FROM delivery_input i CROSS JOIN delivery_history h");
    let row = query
        .build()
        .fetch_optional(tx.connection())
        .await?
        .ok_or(Error::new("not_available"))?;
    if row.get::<i64, _>("lease_valid") != 0 {
        return Err(Error::new("lease_lost"));
    }
    let pending = PendingDelivery {
        context: AccessContext {
            user_id: row.get("owner_id"),
            space_id: row.get("space_id"),
            request_id: id(),
            table_access: None,
        },
        lease_epoch: row.get("lease_epoch"),
        history: runtime::decode_delivery_history(&row)?,
        selected_skill_provenance: array(&row, "selected_skill_provenance"),
    };
    tx.commit().await?;
    Ok(pending)
}

pub(crate) async fn selected_skill_provenance(
    pool: &MySqlPool,
    ctx: &AccessContext,
    cid: &str,
) -> Result<Vec<Value>> {
    let mut sql = QueryBuilder::<MySql>::new("SELECT ");
    sql.push(assets::WORKSPACE_SELECTED_PROVENANCE_SQL)
        .push(" FROM (SELECT ")
        .push_bind(cid)
        .push(" AS conversation_id,")
        .push_bind(&ctx.space_id)
        .push(" AS space_id,")
        .push_bind(&ctx.user_id)
        .push(" AS owner_id) i");
    Ok(array(
        &sql.build().fetch_one(pool).await?,
        "selected_skill_provenance",
    ))
}

pub(crate) async fn legacy_checkpoint(
    pool: &MySqlPool,
    run: &str,
    epoch: u64,
) -> Result<(AccessContext, String, Value)> {
    let mut tx = AppTx::begin(pool).await?;
    tx.lock_rank(1)?;
    let mut query = QueryBuilder::<MySql>::new("");
    runtime::push_legacy_checkpoint_run(&mut query, run);
    query.push(conversations::LEGACY_CHECKPOINT_CONTEXT_SQL);
    let row = query
        .build()
        .fetch_optional(tx.connection())
        .await?
        .ok_or(Error::new("not_available"))?;
    // run 的状态变更随会话行锁推进；旧内联正文确认后只读，不替换原绑定。
    if row.get::<i64, _>("lease_valid") == 0
        || row.get::<u64, _>("lease_epoch") != epoch
        || row.get::<Option<String>, _>("lease_owner").as_deref() != Some(run)
        || row.get::<String, _>("state") != "running"
    {
        return Err(Error::new("lease_lost"));
    }
    let checkpoint = row
        .get::<Option<Json<Value>>, _>("legacy_delivery_checkpoint")
        .ok_or(Error::new("not_available"))?
        .0;
    let context = AccessContext {
        user_id: row.get("owner_id"),
        space_id: row.get("space_id"),
        request_id: row.get("request_id"),
        table_access: None,
    };
    let cid = row.get("conversation_id");
    tx.commit().await?;
    Ok((context, cid, checkpoint))
}

pub(crate) struct LockedDelivery {
    pub input: conversations::DeliveryInput,
    pub previous_attempt: Option<(String, String)>,
    pub profile: Option<ModelProfile>,
}

pub(crate) async fn lock(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    cid: &str,
    message: &str,
) -> Result<LockedDelivery> {
    tx.lock_rank(1)?;
    let mut query = QueryBuilder::<MySql>::new("SELECT ");
    query
        .push(conversations::DELIVERY_LOCK_COLUMNS)
        .push(",")
        .push(runtime::DELIVERY_BUDGET_SQL)
        .push(",")
        .push(runtime::DELIVERY_PREVIOUS_ATTEMPT_SQL);
    conversations::push_delivery_input(&mut query, cid, message);
    query.push(" FOR UPDATE OF c,m");
    let row = query
        .build()
        .fetch_optional(tx.connection())
        .await?
        .ok_or(Error::new("not_available"))?;
    let input = conversations::decode_delivery_lock(tx, ctx, cid, &row)?;
    let previous_attempt = row
        .get::<Option<Json<(String, String)>>, _>("previous_attempt")
        .map(|v| v.0);
    let mut budget = row
        .get::<Option<Json<Value>>, _>("budget")
        .ok_or(Error::new("not_available"))?
        .0;
    let model = budget["model_profile"].take();
    let profile = (!model.is_null())
        .then(|| contracts::decode("ModelProfile", model))
        .transpose()?;
    Ok(LockedDelivery {
        input,
        previous_attempt,
        profile,
    })
}

pub(crate) struct Workspace {
    pub tasks: Vec<Value>,
    pub assets: Vec<Value>,
    pub asset_sources: HashMap<String, Value>,
    pub active_source_skills: HashMap<String, Value>,
    pub observations: Vec<Value>,
    pub input_tasks: Vec<String>,
    pub recent_tasks: Vec<String>,
    pub notification: Option<Value>,
    pub declared_scopes: HashMap<String, Option<Value>>,
    pub scopes_unrestricted: bool,
    pub previous_scope: Option<Value>,
    pub checkpoint_sources_available: bool,
}

#[derive(Deserialize)]
pub(crate) struct CheckpointSources<'a> {
    #[serde(borrow)]
    knowledge: Vec<(&'a str, &'a str)>,
    #[serde(borrow)]
    sources: Vec<(&'a str, &'a str)>,
    #[serde(borrow)]
    memories: Vec<(&'a str, &'a str)>,
    #[serde(borrow)]
    skills: Vec<(&'a str, &'a str)>,
    #[serde(borrow)]
    source_skills: Vec<(&'a str, &'a str)>,
}

const CHECKPOINT_HEAD_COLUMNS: &str = "\n        (SELECT JSON_OBJECTAGG(id,JSON_OBJECT('kind',kind,'id',id,'version',CAST(version AS CHAR),
           'source_id',source_id,'table_id',table_id)) FROM workspace_dependency_heads) AS asset_sources,
        (SELECT JSON_OBJECTAGG(id,JSON_OBJECT('version',CAST(version AS CHAR),'dependencies',dependencies))
            FROM checkpoint_asset_heads) AS checkpoint_assets,
        (SELECT JSON_OBJECTAGG(id,CAST(version AS CHAR)) FROM checkpoint_platform_heads) AS checkpoint_platform_sources";

struct CheckpointProjection<'a> {
    checkpoint: Option<&'a CheckpointSources<'a>>,
    objects: HashSet<&'a str>,
    assets: Vec<&'a str>,
    platform_sources: Vec<(&'a str, &'a str)>,
}

struct AuthorityHeads {
    objects: HashMap<String, Value>,
    assets: HashMap<String, Value>,
    checkpoint_available: bool,
}

impl<'a> CheckpointProjection<'a> {
    fn new(
        checkpoint: Option<&'a CheckpointSources<'a>>,
        result_objects: impl Iterator<Item = &'a str>,
    ) -> Self {
        let mut objects: HashSet<_> = result_objects.collect();
        let mut assets = Vec::new();
        let mut platform_sources = Vec::new();
        if let Some(checkpoint) = checkpoint {
            objects.extend(checkpoint.knowledge.iter().map(|(id, _)| *id));
            assets.extend(checkpoint.assets().map(|(id, _)| *id));
            for &(source, revision) in &checkpoint.sources {
                if let Some(id) = source.strip_prefix("document-") {
                    objects.insert(id);
                } else {
                    platform_sources.push((source, revision));
                }
            }
        }
        Self {
            checkpoint,
            objects,
            assets,
            platform_sources,
        }
    }

    fn push_heads(&self, sql: &mut QueryBuilder<MySql>, ctx: &AccessContext, workspace: bool) {
        assets::push_checkpoint_asset_heads(sql, ctx, &self.assets, workspace);
        sql.push(",");
        knowledge::push_workspace_dependency_heads(sql, ctx, &self.objects, workspace);
        sql.push(",");
        ingestion::push_checkpoint_platform_heads(sql, &ctx.space_id, &self.platform_sources);
    }

    fn decode(&self, row: &MySqlRow, ctx: &AccessContext) -> Result<AuthorityHeads> {
        let heads: HashMap<String, Value> = row
            .get::<Option<Json<HashMap<String, Value>>>, _>("asset_sources")
            .map_or_else(HashMap::new, |v| v.0);
        let stored_assets = row
            .get::<Option<Json<HashMap<String, Value>>>, _>("checkpoint_assets")
            .map_or_else(HashMap::new, |v| v.0);
        let mut assets = HashMap::new();
        for (id, asset) in stored_assets {
            let dependencies = asset["dependencies"]
                .as_array()
                .ok_or(Error::new("unavailable"))?;
            let visible = dependencies.iter().try_fold(true, |visible, reference| {
                let id = reference["object_id"]
                    .as_str()
                    .ok_or(Error::new("unavailable"))?;
                Ok::<_, Error>(visible && heads.contains_key(id))
            })?;
            if visible {
                assets.insert(id, asset);
            }
        }
        let platform = row
            .get::<Option<Json<HashMap<String, String>>>, _>("checkpoint_platform_sources")
            .map_or_else(HashMap::new, |v| v.0);
        let checkpoint_available = self.checkpoint.is_some_and(|checkpoint| {
            checkpoint
                .knowledge
                .iter()
                .all(|(id, _)| heads.contains_key(*id))
                && checkpoint.sources.iter().all(|(id, revision)| {
                    if let Some(document) = id.strip_prefix("document-") {
                        heads.get(document).is_some_and(|head| {
                            head["kind"] == "document" && head["version"] == *revision
                        })
                    } else {
                        ctx.can_read_platform_source(id)
                            && platform.get(*id).is_some_and(|v| v == revision)
                    }
                })
                && checkpoint.assets().all(|(id, revision)| {
                    assets.get(*id).is_some_and(|v| v["version"] == *revision)
                })
        });
        Ok(AuthorityHeads {
            objects: heads,
            assets,
            checkpoint_available,
        })
    }
}

impl<'a> CheckpointSources<'a> {
    fn assets(&self) -> impl Iterator<Item = &(&'a str, &'a str)> {
        self.memories
            .iter()
            .chain(&self.skills)
            .chain(&self.source_skills)
    }
}

pub(crate) async fn legacy_checkpoint_heads<'a>(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    checkpoint: &'a CheckpointSources<'a>,
    result_objects: impl Iterator<Item = &'a str>,
) -> Result<Option<HashMap<String, Value>>> {
    let authority = CheckpointProjection::new(Some(checkpoint), result_objects);
    let mut sql = QueryBuilder::<MySql>::new("WITH ");
    authority.push_heads(&mut sql, ctx, false);
    sql.push(" SELECT ").push(CHECKPOINT_HEAD_COLUMNS);
    let row = sql.build().fetch_one(tx.connection()).await?;
    let heads = authority.decode(&row, ctx)?;
    Ok(heads.checkpoint_available.then_some(heads.objects))
}

fn array<T: serde::de::DeserializeOwned>(row: &MySqlRow, name: &str) -> Vec<T> {
    row.get::<Option<Json<Vec<T>>>, _>(name)
        .map_or_else(Vec::new, |v| v.0)
}

pub(crate) async fn workspace<'a>(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    message: &conversations::Message,
    previous: Option<(&str, u64)>,
    checkpoint: Option<&'a CheckpointSources<'a>>,
    result_objects: impl Iterator<Item = &'a str>,
) -> Result<Workspace> {
    let (task, version) = previous.unzip();
    let mut sql = QueryBuilder::<MySql>::new("WITH delivery_input AS (SELECT ");
    sql.push_bind(&message.conversation_id)
        .push(" AS conversation_id,")
        .push_bind(&message.id)
        .push(" AS message_id,")
        .push_bind(&ctx.user_id)
        .push(" AS owner_id,")
        .push_bind(&ctx.space_id)
        .push(" AS space_id,")
        .push_bind(message.result_query_id.as_deref())
        .push(" AS result_query_id,")
        .push_bind(task)
        .push(" AS previous_task_id,")
        .push_bind(version)
        .push(" AS previous_version),")
        .push(analysis::TASK_CONTEXT_SQL)
        .push(",")
        .push(analysis::DELIVERY_SOURCE_LIMITS_SQL)
        .push(",")
        .push(conversations::DELIVERY_TASK_ORDER_SQL)
        .push(",")
        .push(queries::DELIVERY_QUERY_SQL)
        .push(",")
        .push(assets::WORKSPACE_ASSETS_SQL)
        .push(",");
    let authority = CheckpointProjection::new(checkpoint, result_objects);
    authority.push_heads(&mut sql, ctx, true);
    sql.push(" SELECT ").push(CHECKPOINT_HEAD_COLUMNS).push(",
        (SELECT JSON_ARRAYAGG(body) FROM task_context) AS tasks,
        (SELECT JSON_ARRAYAGG(body) FROM workspace_assets) AS assets,
        (SELECT JSON_ARRAYAGG(body) FROM query_observations) AS observations,
        (SELECT JSON_ARRAYAGG(task_id) FROM input_tasks) AS input_tasks,
        (SELECT JSON_ARRAYAGG(JSON_ARRAY(task_id,sequence)) FROM recent_tasks) AS recent_tasks,
        (SELECT body FROM result_notification) AS notification,
        (SELECT JSON_OBJECTAGG(id,IFNULL(declared,JSON_ARRAY())) FROM task_source_limits) AS declared_scopes,
        NOT EXISTS(SELECT 1 FROM task_source_limits WHERE lifecycle='active'
            AND (declared IS NULL OR JSON_TYPE(JSON_EXTRACT(declared,'$[0]'))<>'NULL')) AS scopes_unrestricted,
        (SELECT previous FROM task_source_limits WHERE id=").push_bind(task).push(") AS previous_scope");
    let row = sql.build().fetch_one(tx.connection()).await?;
    let mut recent: Vec<(String, u64)> = array(&row, "recent_tasks");
    recent.sort_unstable_by(|(a, x), (b, y)| y.cmp(x).then_with(|| a.cmp(b)));
    let mut assets: Vec<Value> = array(&row, "assets");
    assets.sort_unstable_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    let mut observations: Vec<Value> = array(&row, "observations");
    observations.sort_unstable_by(|a, b| {
        (b["created_at"].as_str(), b["id"].as_str())
            .cmp(&(a["created_at"].as_str(), a["id"].as_str()))
    });
    for q in &mut observations {
        q.as_object_mut()
            .ok_or(crate::types::Error::new("unavailable"))?
            .remove("created_at");
    }
    let declared_scopes = row
        .get::<Option<Json<HashMap<String, Vec<Value>>>>, _>("declared_scopes")
        .map_or_else(HashMap::new, |v| {
            v.0.into_iter()
                .map(|(id, values)| (id, values.into_iter().next()))
                .collect()
        });
    let heads = authority.decode(&row, ctx)?;
    Ok(Workspace {
        tasks: array(&row, "tasks")
            .into_iter()
            .map(analysis::decode_task_context)
            .collect::<Result<_>>()?,
        assets,
        observations,
        asset_sources: heads.objects,
        active_source_skills: heads.assets,
        input_tasks: array(&row, "input_tasks"),
        recent_tasks: recent.into_iter().map(|(id, _)| id).collect(),
        notification: row
            .get::<Option<Json<Value>>, _>("notification")
            .map(|v| v.0),
        declared_scopes,
        scopes_unrestricted: row.get::<i64, _>("scopes_unrestricted") != 0,
        previous_scope: array::<Value>(&row, "previous_scope").into_iter().next(),
        checkpoint_sources_available: heads.checkpoint_available,
    })
}
