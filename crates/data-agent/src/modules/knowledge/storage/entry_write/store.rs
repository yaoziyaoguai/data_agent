use super::*;

pub async fn begin_edit_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &str,
    input: &Value,
) -> Result<Option<Value>> {
    let key = input["operation_id"]
        .as_str()
        .ok_or(Error::new("invalid_input"))?;
    begin_operation(tx, ctx, key, &json!({"object_id":object,"input":input})).await
}

pub async fn begin_create_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    input: &Value,
) -> Result<Option<Value>> {
    let key = input["operation_id"]
        .as_str()
        .ok_or(Error::new("invalid_input"))?;
    let receipt = begin_operation(tx, ctx, key, input).await?;
    if let Some(value) = &receipt {
        read_in_tx(
            tx,
            ctx,
            value["id"].as_str().ok_or(Error::new("invalid_input"))?,
            None,
            false,
        )
        .await?;
    }
    Ok(receipt)
}

pub async fn begin_reanalysis_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &str,
    input: &Value,
) -> Result<Option<Value>> {
    let key = input["operation_id"]
        .as_str()
        .ok_or(Error::new("invalid_input"))?;
    begin_operation(
        tx,
        ctx,
        key,
        &json!({"action":"reanalyze","object_id":object,"input":input}),
    )
    .await
}

pub async fn save_edit_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &str,
    input: &Value,
    source_value: Option<&str>,
) -> Result<Value> {
    let key = input["operation_id"]
        .as_str()
        .ok_or(Error::new("invalid_input"))?;
    let command = json!({"object_id":object,"input":input});
    if let Some(v) = begin_operation(tx, ctx, key, &command).await? {
        return Ok(v);
    }
    let mut v = locked(
        tx,
        ctx,
        object,
        input["expected_version"].as_str().unwrap_or(""),
    )
    .await?;
    let changed_path = apply_entry_in_tx(tx, ctx, &mut v, input, key, source_value).await?;
    next(&mut v, ctx)?;
    crate::modules::knowledge::preparation::project_object(&mut v);
    persist(tx, ctx, &v, &[&changed_path]).await?;
    record(tx, ctx, key, &command, &v).await?;
    Ok(v)
}

pub async fn apply_entry_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    v: &mut Value,
    input: &Value,
    key: &str,
    source_value: Option<&str>,
) -> Result<String> {
    let object = v["id"]
        .as_str()
        .ok_or(Error::new("invalid_input"))?
        .to_owned();
    if input["entry_id"] == "business_domain"
        && !v["entries"].as_array().is_some_and(|entries| {
            entries
                .iter()
                .any(|entry| entry["entry_id"] == "business_domain")
        })
    {
        if input["clear_override"] == true
            || v["entries"].as_array().is_some_and(|entries| {
                entries.len() >= 200
                    || entries
                        .iter()
                        .any(|entry| entry["path"] == "business_domain")
            })
        {
            return Err(Error::new("invalid_input"));
        }
        v["entries"]
            .as_array_mut()
            .ok_or(Error::new("invalid_input"))?
            .push(business_domain_entry());
    }
    if v["entries"].as_array().is_some_and(|entries| {
        entries.iter().any(|entry| {
            entry["entry_id"] == input["entry_id"] && entry["path"] == "business_domain"
        })
    }) && input["clear_override"] != true
    {
        validate_business_domain(&input["value"])?;
    }
    if input["clear_override"] != true {
        if !input["structured_value"].is_null()
            && input["value"]
                .as_str()
                .is_none_or(|value| value.trim().is_empty())
        {
            return Err(Error::new("invalid_input"));
        }
        crate::modules::knowledge::structure::validate_edit_in_tx(
            tx,
            ctx,
            v,
            input["entry_id"].as_str().unwrap_or(""),
            &input["structured_value"],
        )
        .await?;
    }
    if input.get("source_url").is_some() || input.get("related_ids").is_some() {
        if v["kind"] != "document" || input["entry_id"] != "body" || input["clear_override"] == true
        {
            return Err(Error::new("invalid_input"));
        }
        validate_document_metadata(tx, ctx, input).await?;
        if let Some(related) = input.get("related_ids") {
            v["related_ids"] = related.clone();
        }
    }
    let human_statements = if let Some(drafts) = input["statements"].as_array() {
        if input["clear_override"] == true {
            return Err(Error::new("invalid_input"));
        }
        let entry = v["entries"]
            .as_array()
            .and_then(|entries| {
                entries
                    .iter()
                    .find(|entry| entry["entry_id"] == input["entry_id"])
            })
            .ok_or(Error::new("invalid_input"))?;
        let mut keys = std::collections::HashSet::new();
        let mut statements = Vec::new();
        let mut rendered = Vec::new();
        for draft in drafts {
            if draft["target"]["object_id"] != object
                || draft["target"]["version"] != v["version"]
                || draft["target"]["path"] != entry["path"]
                || !keys.insert(draft["key"].to_string())
            {
                return Err(Error::new("invalid_input"));
            }
            let statement_id = fingerprint(&json!([
                "human_statement",
                object,
                entry["path"],
                draft["key"]
            ]));
            let mut supports = Vec::new();
            let mut support_keys = std::collections::HashSet::new();
            for support in draft["supports"].as_array().into_iter().flatten() {
                if !support_keys.insert(support["key"].to_string()) {
                    return Err(Error::new("invalid_input"));
                }
                if !support["embedded_in"].is_null() {
                    let locator = crate::contracts::decode::<
                        crate::contracts::generated::SourceLocator,
                    >(
                        "SourceLocator", support["embedded_in"]["locator"].clone()
                    )?;
                    let field = support["embedded_in"]["field"]
                        .as_str()
                        .ok_or(Error::new("invalid_input"))?;
                    if support["content"].as_str()
                        != Some(locator.slice(draft[field].as_str().unwrap_or(""))?)
                    {
                        return Err(Error::new("invalid_input"));
                    }
                }
                supports.push(json!({"support_id":fingerprint(&json!([statement_id,support["key"]])),
                    "role":support["role"],"reference":support["reference"],"content":support["content"],
                    "embedded_in":support["embedded_in"]}));
            }
            let mut statement = json!({"statement_id":statement_id,
                "object_ref":{"object_id":object,"version":v["version"],"path":entry["path"]},
                "text":draft["text"],"scope_text":draft["scope_text"],"origin":"human",
                "citations":draft["citations"],"supports":supports});
            if let Some(declaration) = draft.get("supports_complete") {
                statement["supports_complete"] = declaration.clone();
            }
            let text = draft["text"].as_str().ok_or(Error::new("invalid_input"))?;
            let scope = draft["scope_text"]
                .as_str()
                .ok_or(Error::new("invalid_input"))?;
            rendered.push(if scope.is_empty() {
                text.to_owned()
            } else {
                format!("{text}\n{scope}")
            });
            statements.push(statement);
        }
        if !drafts.is_empty() && rendered.join("\n\n") != input["value"].as_str().unwrap_or("") {
            return Err(Error::new("invalid_input"));
        }
        Some(json!(statements))
    } else {
        None
    };
    let entry = v["entries"]
        .as_array_mut()
        .ok_or(Error::new("invalid_input"))?
        .iter_mut()
        .find(|e| e["entry_id"] == input["entry_id"])
        .ok_or(Error::new("invalid_input"))?;
    if input["clear_override"] == true {
        entry["human_override"] = Value::Null;
        entry["effective_value"] = json!(
            entry["suggestion"]["value"]
                .as_str()
                .or_else(|| entry["source_facts"]["value"].as_str())
                .or(source_value)
                .unwrap_or("")
        );
        entry["review_state"] = json!("unverified");
    } else {
        let source_url = input
            .get("source_url")
            .cloned()
            .unwrap_or_else(|| entry["human_override"]["source_url"].clone());
        let related_override = input
            .get("related_ids")
            .cloned()
            .or_else(|| entry["human_override"].get("related_ids").cloned());
        entry["human_override"] = json!({"value":input["value"],"edited_by":ctx.user_id,"operation_id":key,"source_url":source_url});
        entry["human_override"]["structured_value"] = input["structured_value"].clone();
        if let Some(statements) = human_statements {
            entry["human_override"]["statements"] = statements;
        }
        if let Some(related) = related_override {
            entry["human_override"]["related_ids"] = related;
        }
        entry["effective_value"] = input["value"].clone();
        entry["review_state"] = json!("confirmed");
        if entry["entry_id"] == "body"
            && entry["source_facts"]["gap"] == "只有链接，正文尚未录入，不能据此解释业务"
            && input["value"]
                .as_str()
                .is_some_and(|v| !v.trim().is_empty())
        {
            entry["source_facts"]["gap"] = json!("人工录入，尚无平台来源");
        }
    }
    crate::modules::knowledge::structure::project_object(v);
    crate::modules::knowledge::structure::mark_other_rules_for_review(
        v,
        input["entry_id"].as_str().unwrap_or(""),
    );
    v["entries"]
        .as_array()
        .and_then(|entries| {
            entries
                .iter()
                .find(|entry| entry["entry_id"] == input["entry_id"])
        })
        .and_then(|entry| entry["path"].as_str())
        .map(str::to_owned)
        .ok_or(Error::new("invalid_input"))
}

pub async fn begin_entry_batch_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    operation: &str,
    command: &Value,
) -> Result<Option<Value>> {
    begin_operation(tx, ctx, operation, command).await
}

pub async fn lock_entry_batch_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    groups: &[crate::contracts::generated::KnowledgeEditGroup],
) -> Result<Vec<Value>> {
    let mut objects = Vec::with_capacity(groups.len());
    for group in groups {
        objects.push(locked(tx, ctx, &group.object_id, &group.expected_version).await?);
    }
    Ok(objects)
}

pub async fn persist_entry_batch_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    objects: &mut [Value],
    paths: &[Vec<String>],
) -> Result<()> {
    let mut versions = Vec::with_capacity(objects.len());
    for (object, paths) in objects.iter_mut().zip(paths) {
        next(object, ctx)?;
        crate::modules::knowledge::preparation::project_object(object);
        let changed: Vec<&str> = paths.iter().map(String::as_str).collect();
        persist_object(tx, ctx, object, &changed, false).await?;
        versions.push((
            object["id"]
                .as_str()
                .ok_or(Error::new("invalid_input"))?
                .to_owned(),
            epoch(
                object["version"]
                    .as_str()
                    .ok_or(Error::new("invalid_input"))?,
            )?,
        ));
    }
    // 对象的最终修订共用一次入队。条目级中间值从未成为索引目标。
    let mut insert = sqlx::QueryBuilder::<sqlx::MySql>::new(
        "INSERT INTO knowledge_index_jobs(target_kind,object_id,version) ",
    );
    insert.push_values(versions, |mut row, (id, version)| {
        row.push_bind("knowledge_entry")
            .push_bind(id)
            .push_bind(version);
    });
    insert.build().execute(tx.connection()).await?;
    Ok(())
}

pub async fn record_entry_batch_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    operation: &str,
    command: &Value,
    receipt: &Value,
) -> Result<()> {
    record(tx, ctx, operation, command, receipt).await
}

pub async fn create_in_tx(tx: &mut AppTx<'_>, ctx: &AccessContext, input: &Value) -> Result<Value> {
    let key = input["operation_id"].as_str().unwrap_or("");
    if let Some(v) = begin_operation(tx, ctx, key, input).await? {
        read_in_tx(
            tx,
            ctx,
            v["id"].as_str().ok_or(Error::new("invalid_input"))?,
            None,
            false,
        )
        .await?;
        return Ok(v);
    }
    validate_document_metadata(tx, ctx, input).await?;
    let gap = if input["body"].as_str().is_none_or(|b| b.trim().is_empty()) {
        "只有链接，正文尚未录入，不能据此解释业务"
    } else {
        "人工录入，尚无平台来源"
    };
    let mut v = json!({"id":id(),"kind":input["kind"],"name":input["name"],"version":"1","state":"enabled","entries":[{"entry_id":"body","path":"body","label":"正文","source_facts":{"complete":false,"gap":gap},"suggestion":{},"human_override":{"value":input["body"],"structured_value":input["structured_value"],"edited_by":ctx.user_id,"source_url":input["source_url"]},"effective_value":input["body"],"review_state":"confirmed"}],"related_ids":input["related_ids"],"source_id":null,"source_version":"0","updated_by":ctx.user_id,"created_by":ctx.user_id});
    if let Some(domain) = input.get("business_domain") {
        validate_business_domain(domain)?;
        let mut entry = business_domain_entry();
        entry["human_override"] =
            json!({"value":domain,"edited_by":ctx.user_id,"operation_id":key});
        entry["effective_value"] = domain.clone();
        entry["review_state"] = json!("confirmed");
        v["entries"]
            .as_array_mut()
            .ok_or(crate::types::Error::new("unavailable"))?
            .push(entry);
    }
    if !input["structured_value"].is_null()
        && input["body"]
            .as_str()
            .is_none_or(|value| value.trim().is_empty())
    {
        return Err(Error::new("invalid_input"));
    }
    crate::modules::knowledge::structure::validate_edit_in_tx(
        tx,
        ctx,
        &v,
        "body",
        &input["structured_value"],
    )
    .await?;
    crate::modules::knowledge::structure::project_object(&mut v);
    persist(tx, ctx, &v, &["*"]).await?;
    record(tx, ctx, key, input, &v).await?;
    Ok(v)
}

fn validate_business_domain(value: &Value) -> Result<()> {
    let domain = value.as_str().ok_or(Error::new("invalid_input"))?;
    if domain.chars().count() > 240 || domain.trim() != domain {
        return Err(Error::new("invalid_input"));
    }
    Ok(())
}

fn business_domain_entry() -> Value {
    // 只新增可人工维护的归属槽位，不从关联对象推断，也不伪造平台来源。
    json!({"entry_id":"business_domain","path":"business_domain","label":"业务域",
        "source_facts":{"complete":false,"value":"","gap":"尚未提供业务域来源"},
        "suggestion":{},"human_override":null,"effective_value":"","review_state":"unverified"})
}
pub async fn change_state_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &str,
    input: &Value,
    state: &str,
) -> Result<Value> {
    let key = input["operation_id"].as_str().unwrap_or("");
    let command = json!({"object_id":object,"input":input,"state":state});
    if let Some(v) = begin_operation(tx, ctx, key, &command).await? {
        return Ok(v);
    }
    let mut v = locked(
        tx,
        ctx,
        object,
        input["expected_version"].as_str().unwrap_or(""),
    )
    .await?;
    v["state"] = json!(state);
    v["state_origin"] = json!("human");
    next(&mut v, ctx)?;
    persist(tx, ctx, &v, &["*"]).await?;
    record(tx, ctx, key, &command, &v).await?;
    Ok(v)
}
pub async fn reanalyze_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &str,
    input: &Value,
    source_version: u64,
    candidate: &Value,
) -> Result<Value> {
    let key = input["operation_id"].as_str().unwrap_or("");
    let command = json!({"action":"reanalyze","object_id":object,"input":input});
    if let Some(v) = begin_operation(tx, ctx, key, &command).await? {
        return Ok(v);
    }
    let locked = locked(
        tx,
        ctx,
        object,
        input["expected_version"].as_str().unwrap_or(""),
    )
    .await;
    let mut v = match locked {
        Ok(value) => value,
        Err(error) => {
            // 预填会提交superseded回执；对象冲突不能顺带提交空操作占位。
            crate::persistence::receipts::Operation::new(ctx, "knowledge", key, &command)
                .discard_pending(tx)
                .await?;
            return Err(error);
        }
    };
    // 来源撤下的条目不能继续当有效来源；人工内容保留并明确需要重新核对。
    let candidates = candidate["entries"]
        .as_array()
        .ok_or(Error::new("invalid_input"))?;
    v["entries"]
        .as_array_mut()
        .ok_or(Error::new("invalid_input"))?
        .retain(|entry| {
            !entry["human_override"].is_null()
                || candidates
                    .iter()
                    .any(|new| new["entry_id"] == entry["entry_id"])
        });
    let mut manual_relations = None;
    for entry in v["entries"]
        .as_array_mut()
        .ok_or(Error::new("invalid_input"))?
    {
        if let Some(new) = candidate["entries"]
            .as_array()
            .and_then(|a| a.iter().find(|e| e["entry_id"] == entry["entry_id"]))
        {
            entry["source_facts"] = new["source_facts"].clone();
            entry["suggestion"] = new["suggestion"].clone();
            if entry["human_override"].is_null() {
                entry["effective_value"] = new["effective_value"].clone();
                entry["review_state"] = json!("unverified");
            } else {
                entry["review_state"] = json!("needs_review");
            }
        } else {
            entry["source_facts"] = json!({"source_id":candidate["source_id"],"version":source_version.to_string(),"complete":false,"gap":"来源已撤下此条目，保留人工内容待复核"});
            entry["suggestion"] = json!({});
            entry["review_state"] = json!("needs_review");
        }
        if entry["human_override"]["related_ids"].is_array() {
            manual_relations = Some(entry["human_override"]["related_ids"].clone());
        }
    }
    for entry in candidate["entries"]
        .as_array()
        .ok_or(Error::new("invalid_input"))?
    {
        if !v["entries"]
            .as_array()
            .is_some_and(|items| items.iter().any(|old| old["entry_id"] == entry["entry_id"]))
        {
            v["entries"]
                .as_array_mut()
                .ok_or(Error::new("invalid_input"))?
                .push(entry.clone());
        }
    }
    if v["state"] == "disabled" && v["state_origin"] == "platform" {
        v["state"] = json!("enabled");
    }
    v["name"] = candidate["name"].clone();
    v["related_ids"] = manual_relations.unwrap_or_else(|| candidate["related_ids"].clone());
    v["source_version"] = json!(source_version.to_string());
    crate::modules::knowledge::structure::project_object(&mut v);
    crate::modules::knowledge::structure::validate_single_structure(&v)?;
    next(&mut v, ctx)?;
    persist(tx, ctx, &v, &["*"]).await?;
    record(tx, ctx, key, &command, &v).await?;
    Ok(v)
}
