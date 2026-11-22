use super::*;

pub async fn read_structure_refs_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &str,
    version: u64,
) -> Result<Value> {
    read_selected_structure_in_tx(tx, ctx, object, version, None).await
}

pub async fn read_selected_structure_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &str,
    version: u64,
    path: Option<&str>,
) -> Result<Value> {
    let path = path.filter(|path| !path.is_empty());
    let mut query = sqlx::QueryBuilder::<sqlx::MySql>::new(
        "SELECT k.kind,k.name,k.version,k.source_id,JSON_EXTRACT(k.body,'$.related_ids') AS related_ids,m.mapping_state,",
    );
    query.push(DIRECT_TABLE_ID).push(", (
        SELECT JSON_ARRAYAGG(JSON_OBJECT('entry_id',JSON_EXTRACT(e,'$.entry_id'),'path',JSON_EXTRACT(e,'$.path'),
          'source_facts',JSON_OBJECT('source_id',JSON_EXTRACT(e,'$.source_facts.source_id'),'version',JSON_EXTRACT(e,'$.source_facts.version'),
            'structured_evidence',JSON_EXTRACT(e,'$.source_facts.structured_evidence')),
          'suggestion',JSON_OBJECT('evidence',JSON_EXTRACT(e,'$.suggestion.evidence'),'material_refs',JSON_EXTRACT(e,'$.suggestion.material_refs')),
          'human_override',IF(JSON_TYPE(JSON_EXTRACT(e,'$.human_override'))='OBJECT',JSON_OBJECT('present',TRUE),NULL),
          'effective_structure',CASE WHEN JSON_TYPE(JSON_EXTRACT(e,'$.human_override'))='OBJECT' THEN JSON_EXTRACT(e,'$.human_override.structured_value')
            WHEN JSON_TYPE(JSON_EXTRACT(e,'$.suggestion.value'))='STRING' THEN JSON_EXTRACT(e,'$.suggestion.structured_value') ELSE JSON_EXTRACT(e,'$.source_facts.structured_value') END))
        FROM JSON_TABLE(k.body,'$.entries[*]' COLUMNS(e JSON PATH '$')) j");
    if let Some(path) = path {
        query
            .push(" WHERE BINARY JSON_UNQUOTE(JSON_EXTRACT(e,'$.entry_id'))=BINARY ")
            .push_bind(path)
            .push(" OR BINARY JSON_UNQUOTE(JSON_EXTRACT(e,'$.path'))=BINARY ")
            .push_bind(path);
    }
    query
        .push(
            ") AS entries FROM knowledge_objects k
        LEFT JOIN knowledge_dependency_states m ON m.owner_id=k.id AND m.owner_version=k.version
        WHERE k.id=",
        )
        .push_bind(object)
        .push(" AND k.space_id=")
        .push_bind(&ctx.space_id)
        .push(" AND k.state='enabled'");
    push_table_access(&mut query, ctx);
    let head = query
        .build()
        .fetch_optional(tx.connection())
        .await?
        .ok_or(Error::new("not_available"))?;
    if head.get::<u64, _>("version") != version {
        return Err(Error::new("stale_knowledge"));
    }
    let entries = head
        .get::<Option<sqlx::types::Json<Vec<Value>>>, _>("entries")
        .map_or_else(Vec::new, |v| v.0);
    if path.is_some() && entries.len() != 1 {
        return Err(Error::new("invalid_evidence"));
    }
    Ok(
        json!({"id":object,"kind":head.get::<String,_>("kind"),"name":head.get::<String,_>("name"),
        "version":version.to_string(),"related_ids":head.get::<Option<sqlx::types::Json<Value>>,_>("related_ids").map(|v|v.0).unwrap_or(json!([])),
        "mapping_state":head.get::<Option<String>,_>("mapping_state"),
        "source_id":head.get::<Option<String>,_>("source_id"),"table_id":head.get::<Option<String>,_>("table_id"),
        "entries":entries}),
    )
}

pub(in crate::modules::knowledge) async fn read_table_binding_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &str,
    version: Option<u64>,
) -> Result<Value> {
    let mut query = sqlx::QueryBuilder::<sqlx::MySql>::new(
        "SELECT k.id,k.kind,k.name,k.version,
           (SELECT JSON_UNQUOTE(JSON_EXTRACT(j.entry,'$.effective_value'))
            FROM JSON_TABLE(k.body,'$.entries[*]' COLUMNS(entry JSON PATH '$')) j
            WHERE JSON_UNQUOTE(JSON_EXTRACT(j.entry,'$.path'))='ddl' LIMIT 1) AS ddl
         FROM knowledge_objects k WHERE k.id=",
    );
    query
        .push_bind(object)
        .push(" AND k.space_id=")
        .push_bind(&ctx.space_id)
        .push(" AND k.state='enabled'");
    push_table_access(&mut query, ctx);
    let row = query
        .build()
        .fetch_optional(tx.connection())
        .await?
        .ok_or(Error::new("not_available"))?;
    if version.is_some_and(|version| row.get::<u64, _>("version") != version) {
        return Err(Error::new("stale_knowledge"));
    }
    if row.get::<String, _>("kind") != "table" {
        return Err(Error::new("invalid_input"));
    }
    Ok(json!({
        "id":object,"kind":"table","name":row.get::<String,_>("name"),
        "version":row.get::<u64,_>("version").to_string(),
        "entries":[{"path":"ddl","effective_value":row.get::<Option<String>,_>("ddl")}],
    }))
}

pub(in crate::modules::knowledge) async fn original_table_ddl_in_tx(
    tx: &mut AppTx<'_>,
    object: &str,
    version: u64,
) -> Result<Option<String>> {
    Ok(sqlx::query_scalar::<_,Option<String>>("SELECT JSON_UNQUOTE(JSON_EXTRACT(e,'$.effective_value')) FROM (SELECT body FROM knowledge_objects WHERE id=? AND version=? UNION ALL SELECT archived_body AS body FROM knowledge_revisions WHERE object_id=? AND version=?) o,JSON_TABLE(o.body,'$.entries[*]' COLUMNS(e JSON PATH '$')) j WHERE JSON_UNQUOTE(JSON_EXTRACT(e,'$.path'))='ddl' LIMIT 1")
        .bind(object).bind(version).bind(object).bind(version).fetch_optional(tx.connection()).await?.flatten())
}

pub(in crate::modules::knowledge) async fn field_binding_source_in_tx(
    tx: &mut AppTx<'_>,
    object: &str,
    version: u64,
) -> Result<Option<Value>> {
    Ok(sqlx::query_scalar::<_,Option<sqlx::types::Json<Value>>>("SELECT JSON_EXTRACT(j.e,'$.source_facts') FROM knowledge_objects o,JSON_TABLE(o.body,'$.entries[*]' COLUMNS(e JSON PATH '$')) j WHERE o.id=? AND o.version=? AND JSON_UNQUOTE(JSON_EXTRACT(j.e,'$.path'))='type'")
        .bind(object).bind(version).fetch_optional(tx.connection()).await?.flatten().map(|v|v.0))
}

pub async fn current_versions_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    ids: &[String],
) -> Result<std::collections::HashMap<(String, String), bool>> {
    // 检索在锁外读取后，提交前按(id,version)核对对象是否仍为当前有效版本。
    let mut result = std::collections::HashMap::new();
    for chunk in ids.chunks(500) {
        let mut query = sqlx::QueryBuilder::<sqlx::MySql>::new(
            "SELECT k.id AS object_id, CAST(k.version AS CHAR) AS object_version, k.state FROM knowledge_objects k WHERE k.space_id=",
        );
        query.push_bind(&ctx.space_id).push(" AND id IN (");
        let mut keys = query.separated(",");
        for id in chunk {
            keys.push_bind(id);
        }
        query.push(")");
        push_table_access(&mut query, ctx);
        for row in query.build().fetch_all(tx.connection()).await? {
            result.insert(
                (
                    row.get::<String, _>("object_id"),
                    row.get::<String, _>("object_version"),
                ),
                row.get::<String, _>("state") == "enabled",
            );
        }
    }
    Ok(result)
}

// 返回本次实际置为disabled的对象（已按保存路径投影）；调用方据此执行保存后组合。
pub async fn retire_source_objects_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    source: &str,
    keep: &std::collections::HashSet<String>,
) -> Result<Vec<Value>> {
    // 来源头已由同步事务核对；先取候选，再按对象主键锁定，避免范围扫描锁住其他来源。
    let objects: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM knowledge_objects WHERE space_id=? AND source_id=? ORDER BY id",
    )
    .bind(&ctx.space_id)
    .bind(source)
    .fetch_all(tx.connection())
    .await?;
    let mut retired = Vec::new();
    for object_id in objects {
        if keep.contains(&object_id) {
            continue;
        }
        let Some(object) = sqlx::query_scalar::<_, sqlx::types::Json<Value>>(
            "SELECT body FROM knowledge_objects WHERE id=? AND space_id=? AND source_id=? AND state='enabled' FOR UPDATE",
        )
        .bind(&object_id).bind(&ctx.space_id).bind(source).fetch_optional(tx.connection()).await? else {
            continue;
        };
        let mut object = object.0;
        object["state"] = json!("disabled");
        object["state_origin"] = json!("platform");
        for entry in object["entries"].as_array_mut().into_iter().flatten() {
            entry["review_state"] = json!("needs_review");
        }
        next(&mut object, ctx)?;
        persist(tx, ctx, &object, &["*"]).await?;
        crate::modules::knowledge::structure::project_object(&mut object);
        crate::modules::knowledge::preparation::project_object(&mut object);
        retired.push(object);
    }
    Ok(retired)
}

// 先核对当前知识与领取代次，再读回冻结维护预算；首次冻结由
// freeze_index_embedding_in_tx在同一事务内完成，重试不能从新环境配置补额。
