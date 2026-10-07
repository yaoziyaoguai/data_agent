use crate::{
    modules::{access, ingestion, knowledge},
    persistence::AppTx,
    types::{AccessContext, Error, Result},
};
use serde_json::{Value, json};
use sqlx::MySqlPool;

pub async fn sync(pool: &MySqlPool, ctx: &AccessContext, operation: &str) -> Result<Value> {
    access::authorize_maintainer(ctx)?;
    let mut tx = AppTx::begin(pool).await?;
    let read = ingestion::begin_catalog_read_in_tx(&mut tx, ctx, operation).await?;
    tx.commit().await?;
    if read["receipt"].is_object() {
        return Ok(read["receipt"].clone());
    }
    if let Some(code) = read["error_code"].as_str() {
        return Err(Error::new(match code {
            "source_interrupted" => "source_interrupted",
            "version_conflict" => "version_conflict",
            _ => "source_unavailable",
        }));
    }
    let receipt = json!({"operation_id":operation,"resource_id":read["id"],"version":"1","state":"synchronized"});
    if let Err(error) = fetch_and_apply(pool, ctx, &read, &receipt).await {
        let mut tx = AppTx::begin(pool).await?;
        ingestion::finish_catalog_read_in_tx(&mut tx, &read, None, Some(error.code)).await?;
        tx.commit().await?;
        return Err(error);
    }
    Ok(receipt)
}

async fn fetch_and_apply(
    pool: &MySqlPool,
    ctx: &AccessContext,
    read: &Value,
    receipt: &Value,
) -> Result<()> {
    let mut cursor: Option<String> = None;
    let mut snapshot: Option<String> = None;
    let mut namespace: Option<String> = None;
    let mut authoritative: Option<bool> = None;
    let mut imported =
        std::collections::HashMap::<String, (u64, std::collections::HashSet<String>)>::new();
    let mut seen = std::collections::HashSet::new();
    let mut cursors = std::collections::HashSet::new();
    let mut maintainers = std::collections::BTreeMap::<String, Option<String>>::new();
    for _ in 0..100 {
        // 网络读取完全在事务外；read中的采集前基线始终不改绑。
        let page = ingestion::catalog::fetch_page(cursor.as_deref(), snapshot.as_deref()).await?;
        let page_snapshot = page["snapshot_id"]
            .as_str()
            .ok_or(Error::new("invalid_input"))?;
        let page_namespace = page["source_namespace"]
            .as_str()
            .ok_or(Error::new("invalid_input"))?;
        if snapshot.as_ref().is_some_and(|s| s != page_snapshot)
            || namespace.as_ref().is_some_and(|s| s != page_namespace)
        {
            return Err(Error::new("version_conflict"));
        }
        let page_authoritative = page["authoritative"]
            .as_bool()
            .ok_or(Error::new("invalid_input"))?;
        if authoritative.is_some_and(|v| v != page_authoritative) {
            return Err(Error::new("version_conflict"));
        }
        authoritative = Some(page_authoritative);
        snapshot = Some(page_snapshot.into());
        namespace = Some(page_namespace.into());
        for table in page["tables"]
            .as_array()
            .ok_or(Error::new("invalid_input"))?
        {
            if !seen.insert(table["id"].as_str().unwrap_or("").to_owned()) {
                return Err(Error::new("invalid_input"));
            }
            let mut tx = AppTx::begin(pool).await?;
            // 新对象先登记授权范围；负责人等完整同步成功后统一生效。
            let scope_objects = ingestion::catalog::objects(ctx, page_namespace, table, 1)?;
            let table_id = scope_objects[0]["id"]
                .as_str()
                .ok_or(Error::new("invalid_input"))?;
            for object in &scope_objects {
                access::register_in_tx(
                    &mut tx,
                    ctx,
                    object["id"].as_str().unwrap_or(""),
                    table_id,
                    "datasight",
                )
                .await?;
            }
            let mut ids = vec![table_id.to_owned()];
            // 仅兼容从零合成夹具中的明确别名，平台对象按 namespace + id 定位。
            if let Some(alias) = ingestion::catalog::synthetic_alias(
                page_namespace,
                table["id"].as_str().unwrap_or(""),
            ) {
                match knowledge::read_in_tx(&mut tx, ctx, &alias, None, true).await {
                    Ok(_) => ids.push(alias),
                    Err(e) if e.code == "not_available" => {}
                    Err(e) => return Err(e),
                }
            }
            for object in ids {
                maintainers.insert(object, table["maintainer_id"].as_str().map(str::to_owned));
            }
            let (version, changed) =
                ingestion::save_catalog_table_in_tx(&mut tx, ctx, read, page_namespace, table)
                    .await?;
            let objects = ingestion::catalog::objects(ctx, page_namespace, table, version)?;
            // 新对象与既有对象使用同一个来源/知识小事务；人工值仍通过正式合并规则保护。
            for candidate in &objects {
                let id = candidate["id"].as_str().unwrap_or("");
                let mut created = false;
                let updated=match knowledge::read_in_tx(&mut tx, ctx, id, None, true).await {
                    Ok(old) if changed => {
                        Some(knowledge::reanalyze_in_tx(&mut tx,ctx,id,&json!({"operation_id":crate::types::fingerprint(&json!(["catalog",read["id"],id,version])),"expected_version":old["version"]}),version,candidate).await?)
                    }
                    Ok(_) => None,
                    Err(error) if error.code == "not_available" => {
                        if knowledge::is_deleted_in_tx(&mut tx,ctx,id).await? {
                            None
                        } else {
                            knowledge::seed_in_tx(&mut tx, ctx, &json!({"objects":[candidate]})).await?;
                            created = true;
                            Some(knowledge::read_in_tx(&mut tx,ctx,id,None,true).await?)
                        }
                    }
                    Err(error) => return Err(error),
                };
                if let Some(updated) = updated {
                    let preferred =
                        ingestion::read_analysis_preference_in_tx(&mut tx, ctx, &updated)
                            .await?
                            .is_some_and(|v| v["preferred"] == true);
                    if created && version == 1 && !preferred {
                        continue;
                    }
                    let sources = vec![
                        ingestion::read_source_in_tx(
                            &mut tx,
                            ctx,
                            updated["source_id"].as_str().unwrap_or(""),
                            version,
                        )
                        .await?,
                    ];
                    ingestion::queue_prefill_in_tx(
                        &mut tx,
                        ctx,
                        &updated,
                        &json!({"sources":sources,"catalog_import_id":read["id"]}),
                    )
                    .await?;
                }
            }
            tx.commit().await?;
            let source = ingestion::catalog::source_id(
                &ctx.space_id,
                page_namespace,
                table["id"].as_str().unwrap_or(""),
            );
            imported.insert(
                source,
                (
                    version,
                    objects
                        .iter()
                        .filter_map(|v| v["id"].as_str().map(str::to_owned))
                        .collect(),
                ),
            );
        }
        cursor = page["next_cursor"].as_str().map(str::to_owned);
        match (&cursor, page["complete"].as_bool()) {
            (None, Some(true)) => {
                let mut tx = AppTx::begin(pool).await?;
                // 改派和撤权与成功回执同事务；统一先锁授权，再锁来源与知识。
                let missing = if authoritative == Some(true) {
                    ingestion::missing_catalog_sources_in_tx(
                        &mut tx,
                        ctx,
                        page_namespace,
                        &seen,
                        false,
                    )
                    .await?
                } else {
                    Vec::new()
                };
                let mut revoked = std::collections::BTreeSet::new();
                for source in &missing {
                    revoked.extend(knowledge::source_tables_in_tx(&mut tx, ctx, source).await?);
                    if let Some(alias) = ingestion::catalog::retired_synthetic_alias(
                        &ctx.space_id,
                        page_namespace,
                        source,
                    ) {
                        revoked.insert(alias);
                    }
                }
                for object in revoked {
                    maintainers.insert(object, None);
                }
                for (object, owner) in &maintainers {
                    access::sync_maintainer_in_tx(&mut tx, ctx, object, owner.as_deref()).await?;
                }
                ingestion::check_catalog_read_in_tx(&mut tx, ctx, read, page_namespace).await?;
                // 非权威目录也不能用已被并发导入替换的来源提交旧负责人。
                for (source, (version, _)) in &imported {
                    ingestion::check_prefill_sources_in_tx(
                        &mut tx,
                        &ctx.space_id,
                        &json!([{"source_id":source,"version":version.to_string()}]),
                    )
                    .await?;
                }
                if authoritative == Some(true) {
                    // 等待锁时目录可能已改变；只校验当前集合，不在来源锁后追加授权锁。
                    if ingestion::missing_catalog_sources_in_tx(
                        &mut tx,
                        ctx,
                        page_namespace,
                        &seen,
                        true,
                    )
                    .await?
                        != missing
                    {
                        return Err(Error::new("version_conflict"));
                    }
                    for (source, (_, keep)) in &imported {
                        knowledge::retire_source_objects_in_tx(&mut tx, ctx, source, keep).await?;
                    }
                    for source in missing {
                        ingestion::retire_catalog_source_in_tx(&mut tx, ctx, read, &source).await?;
                        knowledge::retire_source_objects_in_tx(
                            &mut tx,
                            ctx,
                            &source,
                            &std::collections::HashSet::new(),
                        )
                        .await?;
                    }
                }
                ingestion::complete_catalog_namespace_in_tx(&mut tx, ctx, read, page_namespace)
                    .await?;
                ingestion::finish_catalog_read_in_tx(&mut tx, read, Some(receipt), None).await?;
                tx.commit().await?;
                return Ok(());
            }
            (Some(cursor), Some(false))
                if !page["tables"].as_array().is_none_or(Vec::is_empty)
                    && cursors.insert(cursor.clone()) => {}
            _ => return Err(Error::new("source_incomplete")),
        }
    }
    Err(Error::new("candidate_limit"))
}
