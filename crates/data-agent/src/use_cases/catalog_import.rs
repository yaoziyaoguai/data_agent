use crate::{
    modules::{access, ingestion, jobs, knowledge},
    persistence::AppTx,
    types::{AccessContext, Error, Result},
};
use serde_json::{Value, json};
use sqlx::MySqlPool;
use std::{
    collections::{BTreeMap, HashSet},
    time::Duration,
};

fn accepted(read: &Value) -> Value {
    json!({"sync_id":read["id"],"status":read["status"],"status_url":format!("/source-syncs/{}",read["id"].as_str().unwrap_or(""))})
}
pub async fn sync(pool: &MySqlPool, ctx: &AccessContext, operation: &str) -> Result<Value> {
    access::authorize_maintainer(ctx)?;
    let mut tx = AppTx::begin(pool).await?;
    let read = ingestion::begin_catalog_read_in_tx(&mut tx, ctx, operation).await?;
    let result = if read["background"] == false {
        if read["receipt"].is_object() {
            Ok(read["receipt"].clone())
        } else {
            Err(Error::new(match read["error_code"].as_str() {
                Some("source_interrupted") => "source_interrupted",
                Some("version_conflict") => "version_conflict",
                _ => "source_unavailable",
            }))
        }
    } else {
        Ok(accepted(&read))
    };
    if read["created"] == true {
        jobs::enqueue_source_in_tx(&mut tx, "source_sync", read["id"].as_str().unwrap_or(""), 1)
            .await?;
    }
    tx.commit().await?;
    result
}
pub async fn progress(pool: &MySqlPool, ctx: &AccessContext, sync: &str) -> Result<Value> {
    access::authorize_maintainer(ctx)?;
    let mut tx = AppTx::begin(pool).await?;
    let read = ingestion::catalog_read_in_tx(&mut tx, sync).await?;
    if read["space_id"] != ctx.space_id || read["background"] != true {
        return Err(Error::new("not_available"));
    }
    let members = ingestion::catalog_members_in_tx(&mut tx, sync).await?;
    let sources = members
        .iter()
        .map(|m| {
            (
                m["source_id"].as_str().unwrap_or("").to_owned(),
                m["revision"].as_u64().unwrap_or(0),
            )
        })
        .collect::<Vec<_>>();
    let objects = members
        .iter()
        .flat_map(|m| m["objects"].as_array().into_iter().flatten())
        .filter_map(|id| id.as_str().map(str::to_owned))
        .collect::<Vec<_>>();
    let mut result = accepted(&read);
    result["processed_sources"] = read["processed_sources"].clone();
    result["pages_committed"] = read["pages_committed"].clone();
    result["error_code"] = read["error_code"].clone();
    result["error_message"] = read["error_message"].clone();
    result["preparation"] =
        jobs::source_work_progress_in_tx(&mut tx, "prepare_source", &sources).await?;
    result["raw_index"] =
        jobs::source_work_progress_in_tx(&mut tx, "raw_source_index", &sources).await?;
    result["knowledge_index"] = knowledge::index_progress_in_tx(&mut tx, ctx, &objects).await?;
    tx.commit().await?;
    crate::contracts::validate("SourceSyncProgress", &result)?;
    Ok(result)
}
pub async fn process_due(pool: &MySqlPool, worker: &str, ttl: u32) -> Result<bool> {
    let mut tx = AppTx::begin(pool).await?;
    let backfilled = ingestion::backfill_current_in_tx(&mut tx).await?;
    tx.commit().await?;
    if backfilled > 0 {
        return Ok(true);
    }
    let Some(job) = jobs::claim_source_sync(pool, worker, ttl).await? else {
        return Ok(false);
    };
    // 续租可能等待页事务的作业行锁；两者持续被轮询，才能让持锁事务提交。
    let heartbeat = async {
        let mut interval = tokio::time::interval(Duration::from_millis(u64::from(ttl / 3)));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            if let Err(error) = jobs::renew_claim(pool, &job.lease, ttl).await
                && !error.is_transient_storage()
            {
                return error;
            }
        }
    };
    let result = tokio::select! {
        result=apply_page(pool, &job)=>result,
        error=heartbeat=>Err(error),
    };
    if let Err(error) = result {
        if error.code == "lease_lost" {
            return Ok(true);
        }
        let transient = error.is_transient_storage() || error.code == "source_unavailable";
        if transient && job.lease.attempts < 2 {
            let mut tx = AppTx::begin(pool).await?;
            jobs::begin_attempt_in_tx(&mut tx, &job.lease).await?;
            tx.commit().await?;
            jobs::defer(pool, &job.lease).await?;
        } else {
            let mut tx = AppTx::begin(pool).await?;
            let read = ingestion::catalog_read_in_tx(&mut tx, &job.resource_id).await?;
            ingestion::finish_catalog_read_in_tx(&mut tx, &read, None, Some(&error)).await?;
            jobs::fail_in_tx(&mut tx, &job.lease).await?;
            tx.commit().await?;
        }
        eprintln!(
            "source_sync_failure sync={} code={}",
            job.resource_id, error.code
        );
    }
    Ok(true)
}
async fn apply_page(pool: &MySqlPool, job: &jobs::SourceJob) -> Result<()> {
    let mut tx = AppTx::begin(pool).await?;
    let read = ingestion::catalog_read_in_tx(&mut tx, &job.resource_id).await?;
    let ctx = AccessContext {
        user_id: read["owner_id"].as_str().unwrap_or("").into(),
        space_id: read["space_id"].as_str().unwrap_or("").into(),
        request_id: job.resource_id.clone(),
    };
    access::authorize_maintainer(&ctx)?;
    ingestion::start_catalog_page_in_tx(&mut tx, &read).await?;
    jobs::assert_job_in_tx(&mut tx, &job.lease.id, job.lease.lease_epoch).await?;
    tx.commit().await?;
    if read["pages_committed"] == 0 {
        super::knowledge::sync_catalog(pool, &ctx).await?;
    }
    // 每页读取在事务外，网络等待不持有来源、权限或知识锁。
    let page =
        ingestion::catalog::fetch_page(read["cursor"].as_str(), read["snapshot_id"].as_str())
            .await?;
    let namespace = page["source_namespace"]
        .as_str()
        .ok_or(Error::new("invalid_input"))?;
    for (field, page_field) in [
        ("snapshot_id", "snapshot_id"),
        ("namespace", "source_namespace"),
        ("authoritative", "authoritative"),
    ] {
        if !read[field].is_null() && read[field] != page[page_field] {
            return Err(Error::new("version_conflict"));
        }
    }
    let complete = page["complete"]
        .as_bool()
        .ok_or(Error::new("invalid_input"))?;
    let tables = page["tables"]
        .as_array()
        .ok_or(Error::new("invalid_input"))?;
    if (complete && !page["next_cursor"].is_null())
        || (!complete && (page["next_cursor"].as_str().is_none() || tables.is_empty()))
    {
        return Err(Error::new("source_incomplete"));
    }
    let mut tx = AppTx::begin(pool).await?;
    let mut pending = Vec::new();
    for table in tables {
        let member = apply_table(&mut tx, &ctx, &read, namespace, table).await?;
        ingestion::save_catalog_member_in_tx(&mut tx, &job.resource_id, &member).await?;
        pending.push((
            member["source_id"].as_str().unwrap_or("").to_owned(),
            member["revision"].as_u64().unwrap_or(0),
        ));
    }
    ingestion::check_catalog_read_in_tx(&mut tx, &ctx, &read, namespace).await?;
    ingestion::commit_catalog_page_in_tx(&mut tx, &read, &page).await?;
    if complete {
        finish_directory(
            &mut tx,
            &ctx,
            &read,
            namespace,
            page["authoritative"] == true,
        )
        .await?;
    }
    for (source, version) in pending {
        jobs::enqueue_source_in_tx(&mut tx, "raw_source_index", &source, version).await?;
        jobs::enqueue_source_in_tx(&mut tx, "prepare_source", &source, version).await?;
    }
    if complete {
        jobs::settle_in_tx(&mut tx, &job.lease.id, job.lease.lease_epoch).await?;
    } else {
        jobs::release_source_page_in_tx(&mut tx, job).await?;
    }
    tx.commit().await
}
async fn apply_table(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    read: &Value,
    page_namespace: &str,
    table: &Value,
) -> Result<Value> {
    let mut maintainers = BTreeMap::<String, Option<String>>::new();
    // 新对象先登记授权范围；负责人等完整同步成功后统一生效。
    let scope_objects = ingestion::catalog::objects(ctx, page_namespace, table, 1)?;
    let table_id = scope_objects[0]["id"]
        .as_str()
        .ok_or(Error::new("invalid_input"))?;
    for object in &scope_objects {
        access::register_in_tx(
            tx,
            ctx,
            object["id"].as_str().unwrap_or(""),
            table_id,
            "datasight",
        )
        .await?;
    }
    let mut ids = vec![table_id.to_owned()];
    // 仅兼容从零合成夹具中的明确别名，平台对象按 namespace + id 定位。
    if let Some(alias) =
        ingestion::catalog::synthetic_alias(page_namespace, table["id"].as_str().unwrap_or(""))
    {
        match knowledge::read_in_tx(tx, ctx, &alias, None, true).await {
            Ok(_) => ids.push(alias),
            Err(e) if e.code == "not_available" => {}
            Err(e) => return Err(e),
        }
    }
    for object in ids {
        maintainers.insert(object, table["maintainer_id"].as_str().map(str::to_owned));
    }
    let (version, changed) =
        ingestion::save_catalog_table_in_tx(tx, ctx, read, page_namespace, table).await?;
    let objects = ingestion::catalog::objects(ctx, page_namespace, table, version)?;
    // 新对象与既有对象使用同一个来源/知识小事务；人工值仍通过正式合并规则保护。
    for candidate in &objects {
        let id = candidate["id"].as_str().unwrap_or("");
        let mut created = false;
        let updated=match knowledge::read_in_tx(tx, ctx, id, None, true).await {
                    Ok(old) if changed => {
                        Some(knowledge::reanalyze_in_tx(tx,ctx,id,&json!({"operation_id":crate::types::fingerprint(&json!(["catalog",read["id"],id,version])),"expected_version":old["version"]}),version,candidate).await?)
                    }
                    Ok(_) => None,
                    Err(error) if error.code == "not_available" => {
                        if knowledge::is_deleted_in_tx(tx,ctx,id).await? {
                            None
                        } else {
                            knowledge::seed_in_tx(tx, ctx, &json!({"objects":[candidate]})).await?;
                            created = true;
                            Some(knowledge::read_in_tx(tx,ctx,id,None,true).await?)
                        }
                    }
                    Err(error) => return Err(error),
                };
        if let Some(updated) = updated {
            let preferred = ingestion::read_analysis_preference_in_tx(tx, ctx, &updated)
                .await?
                .is_some_and(|v| v["preferred"] == true);
            if created && version == 1 && !preferred {
                continue;
            }
            let sources = vec![
                ingestion::read_source_in_tx(
                    tx,
                    ctx,
                    updated["source_id"].as_str().unwrap_or(""),
                    version,
                )
                .await?,
            ];
            ingestion::queue_prefill_in_tx(
                tx,
                ctx,
                &updated,
                &json!({"sources":sources,"catalog_import_id":read["id"]}),
            )
            .await?;
        }
    }

    Ok(
        json!({"source_id":ingestion::catalog::source_id(&ctx.space_id,page_namespace,table["id"].as_str().unwrap_or("")),
        "platform_table_id":table["id"],"revision":version,"objects":objects.iter().filter_map(|o|o["id"].as_str()).collect::<Vec<_>>(),"maintainers":maintainers}),
    )
}
async fn finish_directory(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    read: &Value,
    namespace: &str,
    authoritative: bool,
) -> Result<()> {
    let members = ingestion::catalog_members_in_tx(tx, read["id"].as_str().unwrap_or("")).await?;
    let seen: HashSet<String> = members
        .iter()
        .filter_map(|m| m["platform_table_id"].as_str().map(str::to_owned))
        .collect();
    let mut maintainers = BTreeMap::<String, Option<String>>::new();
    for member in &members {
        for (id, owner) in member["maintainers"].as_object().into_iter().flatten() {
            maintainers.insert(id.clone(), owner.as_str().map(str::to_owned));
        }
    }
    let missing = if authoritative {
        ingestion::missing_catalog_sources_in_tx(tx, ctx, namespace, &seen, false).await?
    } else {
        vec![]
    };
    for source in &missing {
        for object in knowledge::source_tables_in_tx(tx, ctx, source).await? {
            maintainers.insert(object, None);
        }
        if let Some(alias) =
            ingestion::catalog::retired_synthetic_alias(&ctx.space_id, namespace, source)
        {
            maintainers.insert(alias, None);
        }
    }
    for (object, owner) in maintainers {
        access::sync_maintainer_in_tx(tx, ctx, &object, owner.as_deref()).await?;
    }
    ingestion::check_catalog_read_in_tx(tx, ctx, read, namespace).await?;
    for member in &members {
        ingestion::check_prefill_sources_in_tx(tx,&ctx.space_id,&json!([{"source_id":member["source_id"],"version":member["revision"].as_u64().unwrap_or(0).to_string()}])).await?;
    }
    if authoritative {
        if ingestion::missing_catalog_sources_in_tx(tx, ctx, namespace, &seen, true).await?
            != missing
        {
            return Err(Error::new("version_conflict"));
        }
        for member in &members {
            let keep = member["objects"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect();
            knowledge::retire_source_objects_in_tx(
                tx,
                ctx,
                member["source_id"].as_str().unwrap_or(""),
                &keep,
            )
            .await?;
        }
        for source in missing {
            ingestion::retire_catalog_source_in_tx(tx, ctx, read, &source).await?;
            knowledge::retire_source_objects_in_tx(tx, ctx, &source, &HashSet::new()).await?;
        }
    }
    ingestion::complete_catalog_namespace_in_tx(tx, ctx, read, namespace).await?;
    ingestion::finish_catalog_read_in_tx(
        tx,
        read,
        Some(&json!({"sync_id":read["id"],"status":"completed"})),
        None,
    )
    .await
}
