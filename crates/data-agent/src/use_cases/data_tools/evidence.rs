use super::*;

pub(super) struct SearchReplyInput<'a> {
    pub stage: super::super::knowledge::ScopedSearchStage,
    pub selection: &'a SearchSelection,
    pub task: &'a Option<(String, u64)>,
    pub source_gate: Option<&'a super::super::source_limits::SourceGate>,
    pub budget: Option<&'a contracts::generated::ResponseBudget>,
    pub text_results: &'a super::super::context_authority::CheckedTextResults,
    pub memory_candidates: &'a [Value],
    pub memory_retrieval: &'a str,
    pub deadline: tokio::time::Instant,
    pub limit: usize,
    pub query: &'a str,
    pub asset_after: Option<&'a str>,
    pub operation_id: &'a str,
}

pub(super) async fn search(
    tx: &mut AppTx<'_>,
    pool: &MySqlPool,
    ctx: &AccessContext,
    input: SearchReplyInput<'_>,
    authority: &mut Value,
) -> Result<Value> {
    let SearchReplyInput {
        stage,
        selection: search_selection,
        task: evidence_task,
        source_gate,
        budget: response_budget,
        text_results,
        memory_candidates,
        mut memory_retrieval,
        deadline: search_deadline,
        limit,
        query,
        asset_after,
        operation_id,
    } = input;
    // 召回与目录已在锁外短读事务完成；提交前重核对象、依赖与资产版本。
    super::super::knowledge::assert_search_fresh_in_tx(tx, ctx, &stage).await?;
    let search = stage.search;
    let mut items = stage.items;
    let initial_count = items.len();
    super::super::personal_assets::retain_authorized_skills_in_tx(
        tx,
        ctx,
        &mut items,
        text_results,
    )
    .await?;
    let mut page = if initial_count == items.len() {
        stage.page
    } else {
        retrieval::asset_directory(items.clone(), query, asset_after, limit)
    };
    if !memory_candidates.is_empty() {
        let mut merged = Vec::new();
        for hit in memory_candidates {
            if let Some(asset) = items.iter().find(|asset| {
                asset["kind"] == "memory"
                    && asset["id"] == hit["asset_id"]
                    && asset["version"] == hit["version"]
            }) {
                let preview = retrieval::asset_directory(vec![asset.clone()], "*", None, 1);
                merged.extend(
                    preview["memories"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .cloned(),
                );
            }
            if merged.len() >= limit || serde_json::to_vec(&merged).expect("memories").len() > 9000
            {
                break;
            }
        }
        for memory in page["memories"].as_array().into_iter().flatten() {
            if !merged.iter().any(|m| m["id"] == memory["id"]) {
                merged.push(memory.clone());
            }
        }
        // 召回候选可补充目录，但不能挤掉游标已经越过的当页资产。
        page["memories"] = json!(merged);
    }
    if let Some(gate) = source_gate {
        let allowed_assets =
            super::super::knowledge::valid_assets_in_tx(tx, ctx, items.clone(), Some(gate)).await?;
        // 目录预览只带正文片段与身份。授权使用同版资产的显式引用。
        for key in ["memories", "selected_skills"] {
            let mut kept = Vec::new();
            for preview in page[key].as_array().into_iter().flatten() {
                let Some(asset) = items.iter().find(|asset| {
                    asset["id"] == preview["id"] && asset["version"] == preview["version"]
                }) else {
                    continue;
                };
                let allowed = if asset.get("skill_sources").is_some() {
                    match super::super::personal_assets::authorize_skill_in_tx(
                        tx,
                        ctx,
                        asset,
                        Some(gate),
                        text_results,
                    )
                    .await
                    {
                        Ok(_) => true,
                        Err(error)
                            if super::super::personal_assets::unavailable_text(&error)
                                || error.code == "source_not_allowed" =>
                        {
                            false
                        }
                        Err(error) => return Err(error),
                    }
                } else {
                    allowed_assets
                        .iter()
                        .any(|allowed| allowed["id"] == asset["id"])
                };
                if allowed {
                    kept.push(preview.clone());
                }
            }
            page[key] = json!(kept);
        }
        if page["memories"]
            .as_array()
            .is_none_or(|memories| memories.is_empty())
        {
            memory_retrieval = "excluded_by_source_limits";
        }
    }
    let reply = {
        let active = &evidence_task;
        let mut hits = Vec::with_capacity(search.hits.len());
        let mut support_pages = Vec::with_capacity(search.hits.len());
        let mut support_deadline = false;
        for hit in &search.hits {
            let mut support_position = None;
            let hit = match hit {
                super::super::knowledge::SearchHit::Knowledge { content, .. } => {
                    let entry = &content["entries"][0];
                    let statement = &entry["statement_content"];
                    let offset = statement["statement_offset"]
                        .as_u64()
                        .or_else(|| entry["content_page"]["offset"].as_u64())
                        .unwrap_or(0);
                    let value = entry["effective_value"].as_str().unwrap_or("");
                    let end = offset + value.chars().count() as u64;
                    // 携statement_id补读时坐标属于单陈述，不能使用整个entry的基址或长度。
                    let total = if statement.is_object() {
                        let scope = statement["scope_chars"].as_u64().unwrap_or(0);
                        statement["text_chars"].as_u64().unwrap_or(0)
                            + if scope > 0 { 1 + scope } else { 0 }
                    } else {
                        entry["content_page"]["total_chars"].as_u64().unwrap_or(end)
                    };
                    let reference: contracts::generated::EvidenceRef = serde_json::from_value(json!({
                            "object_id":content["id"],"version":content["version"],"path":entry["path"],
                        })).map_err(|_| Error::new("invalid_input"))?;
                    let statement_id = statement["statement_id"].as_str();
                    let mut support_selection =
                        super::super::knowledge_supports::SupportSelection::new(
                            &json!({"space_id":ctx.space_id,"user_id":ctx.user_id,
                                "object_id":reference.object_id,"path":reference.path,
                                "statement_id":statement_id,"structure_only":false,
                                "task_id":active.as_ref().map(|(task,_)|task),
                                "limits":source_gate.map(SourceGate::allowed_sources)}),
                            &reference.version,
                            active.as_ref().map(|(_, version)| *version),
                            None,
                        )?;
                    let definition_path = format!("/hits/{}/definition", hits.len());
                    let scope_path = format!("/hits/{}/scope_text", hits.len());
                    let statement_offset = statement["statement_offset"].as_u64().unwrap_or(0);
                    let scope_offset = statement_offset
                        .saturating_sub(statement["text_chars"].as_u64().unwrap_or(0) + 1);
                    let visible = [
                        super::super::knowledge_supports::VisibleSupportContent {
                            field: Some("text"),
                            offset: statement_offset,
                            text: statement["text"].as_str().unwrap_or(""),
                            path: &definition_path,
                        },
                        super::super::knowledge_supports::VisibleSupportContent {
                            field: Some("scope_text"),
                            offset: scope_offset,
                            text: statement["scope_text"].as_str().unwrap_or(""),
                            path: &scope_path,
                        },
                    ];
                    // 支持读取仍受本次搜索绝对期限约束；超时留下原支持位置，
                    // 不丢弃已取主命中，也不把未读目录说成没有条件。
                    let prepared = if tokio::time::Instant::now() < search_deadline {
                        tokio::time::timeout_at(search_deadline, async {
                            let mut support_tx = AppTx::begin(pool).await?;
                            let page = super::super::knowledge_supports::read_in_tx(
                                &mut support_tx,
                                ctx,
                                super::super::knowledge_supports::SupportRead {
                                    reference: &reference,
                                    statement_id,
                                    selection: &mut support_selection,
                                    visible: &visible,
                                },
                                source_gate,
                            )
                            .await?;
                            support_tx.commit().await?;
                            Ok::<_, Error>(page)
                        })
                        .await
                        .ok()
                    } else {
                        None
                    };
                    let support_page = match prepared {
                        Some(page) => page?,
                        None => {
                            let total = statement["supports"].as_array().map(Vec::len);
                            support_deadline |= total != Some(0);
                            json!({"supports":[], "total":total,
                                        "next_cursor":support_selection.next_cursor(&[], &[])?})
                        }
                    };
                    let incomplete_support = support_page["total"].as_u64().is_some_and(|total| {
                        support_page["supports"].as_array().map_or(0, Vec::len) < total as usize
                    }) || support_page["supports"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .any(super::super::knowledge_supports::incomplete);
                    let complete = if statement.is_object() {
                        statement["statement_offset"] == 0
                            && statement["text"].as_str().unwrap_or("").chars().count() as u64
                                == statement["text_chars"].as_u64().unwrap_or(0)
                            && statement["scope_text"]
                                .as_str()
                                .unwrap_or("")
                                .chars()
                                .count() as u64
                                == statement["scope_chars"].as_u64().unwrap_or(0)
                    } else {
                        offset == 0 && end == total
                    };
                    let mut hit = json!({
                        "record_kind":"knowledge_entry",
                        "ref":{"object_id":content["id"],"version":content["version"],"path":entry["path"]},
                        "name":content["name"],"kind":content["kind"],
                        "definition":if statement.is_object(){statement["text"].clone()}else{json!(value)},
                        "scope_text":statement["scope_text"].as_str().unwrap_or(""),
                        "support_state":if incomplete_support{"partial"}else if statement["supports_complete"]==true{"delivered"}else{"unknown"},
                        "supports":support_page["supports"],"supports_complete":statement["supports_complete"],"example_refs":[],
                        "citations":statement["citations"].as_array().cloned().unwrap_or_default(),
                        "content_state":if complete{"complete"}else{"partial"},
                        "continuation":{"content_next_offset":if end < total {Some(end)}else{None},"supports_next_cursor":support_page["next_cursor"]}
                    });
                    if statement["statement_id"].is_string() {
                        hit["statement_id"] = statement["statement_id"].clone();
                    }
                    support_position = Some(super::super::knowledge_supports::SupportPage {
                        selection: support_selection,
                        total: support_page["total"].as_u64().map(|total| total as usize),
                        positions: support_page["positions"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .map(|position| position.as_u64().unwrap_or(0) as usize)
                            .collect(),
                    });
                    hit
                }
                super::super::knowledge::SearchHit::SourceExcerpt { content, .. } => json!({
                    "record_kind":"source_excerpt","citation":content["citation"],
                    "source_length":content["source_length"],"text":content["text"],"name":content["name"],
                    "content_state":content["content_state"],"support_state":"unknown","semantic_status":content["semantic_status"]
                }),
            };
            hits.push(hit);
            support_pages.push(support_position);
        }
        let exact = &search.scan_progress["exact"];
        let mut channels = vec![json!({"channel":"exact","state":exact})];
        let mut reasons = Vec::new();
        if exact == "unavailable" {
            reasons.push("channel_unavailable");
        }
        if search.scan_progress["deadline"] == true {
            reasons.push("deadline");
        }
        for (channel, keys) in [
            ("bm25", ["lexical", "raw_lexical"]),
            ("dense", ["dense", "raw_dense"]),
        ] {
            let cursors = keys
                .iter()
                .filter_map(|key| search.scan_progress["milvus"].get(*key))
                .collect::<Vec<_>>();
            // 空分片游标（该路未配置/未派发）不能为通道作保：只有真实
            // 成功过的分片证明可用。
            let shard_succeeded = cursors.iter().any(|cursor| {
                cursor["shards"]
                    .as_array()
                    .is_some_and(|shards| shards.iter().any(|shard| shard["succeeded"] == true))
            });
            // R12：BM25整路明确失败时SQL替代词法正文，替代真实成功仍算
            // 词法能力可用；dense没有SQL替代票。
            let sql_substitute = channel == "bm25"
                && search.scan_progress["sql"]
                    .as_array()
                    .is_some_and(|sql| sql.iter().any(|cursor| cursor["succeeded"] == true));
            let available = shard_succeeded || sql_substitute;
            let state = if available {
                "available"
            } else if cursors.is_empty() {
                "not_configured"
            } else {
                "unavailable"
            };
            // R14：某片成功不抹掉另片失败。部分失败时通道保持available
            // （仍有可用正文），同时以channel_unavailable并列说明未覆盖
            // 的失败分片；不把局部失败改成全败。
            let shard_failed = cursors.iter().any(|cursor| {
                cursor["shards"]
                    .as_array()
                    .is_some_and(|shards| shards.iter().any(|shard| shard["failed"] == true))
            });
            if (state == "unavailable" || shard_failed) && !reasons.contains(&"channel_unavailable")
            {
                reasons.push("channel_unavailable");
            }
            channels.push(json!({"channel":channel,"state":state}));
        }
        if support_deadline && !reasons.contains(&"deadline") {
            reasons.push("deadline");
        }
        // R13：只有真实查到旧投影/漏索引才报index_lag；期限耗尽/读取
        // 超时的未核完由deadline事实表达，不能反推滞后。
        if search.coverage["index_lag"] == true {
            reasons.push("index_lag");
        }
        if search.coverage["state"] == "candidate_limit" {
            reasons.push("candidate_limit");
        }
        let reply = json!({"hits":hits,
                    "search_coverage":{"channels":channels,"state":if search.coverage["state"]=="complete" && reasons.is_empty(){"searched"}else{"bounded"},"reasons":reasons,"next":null},
                    "personal_memories":page["memories"],"selected_skills":page["selected_skills"],
                    "next_asset_after":page["next_asset_after"],"asset_total":page["total"],
                    "asset_cursor_invalid":page["cursor_invalid"]==true,"memory_retrieval":memory_retrieval});
        let reply = super::super::evidence_delivery::search_reply(
            reply,
            response_budget,
            super::super::evidence_delivery::SearchDelivery {
                search: &search,
                selection: search_selection,
                support_pages: &support_pages,
                assets: &page,
                asset_after,
                public_next: &format!("{SEARCH_RECEIPT_PREFIX}{}", operation_id),
            },
        )?;
        contracts::validate("KnowledgeSearchReply", &reply)?;
        reply
    };
    // 登记实际交付的结构。条目必要来源由该条目回源核验，不当作另一次原文读取。
    let retained = super::super::context_authority::items(&reply["hits"]).len();
    for hit in search.hits.iter().take(retained) {
        if let super::super::knowledge::SearchHit::Knowledge { content, .. } = hit {
            super::super::context_authority::observe(authority, &content["structure_dependencies"]);
        }
    }
    for preview in super::super::context_authority::items(&reply["selected_skills"]) {
        if let Some(asset) = items
            .iter()
            .find(|asset| asset["id"] == preview["id"] && asset.get("skill_sources").is_some())
        {
            let skill = super::super::personal_assets::skill_authority(asset);
            super::super::context_authority::merge(authority, &skill)?;
        }
    }
    Ok(reply)
}

pub(super) async fn read_knowledge(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    cid: &str,
    args: &Value,
    evidence_task: &Option<(String, u64)>,
    (source_gate, checked, authority): (
        Option<&super::super::source_limits::SourceGate>,
        &super::super::context_authority::CheckedTextResults,
        &mut Value,
    ),
    response_budget: Option<&contracts::generated::ResponseBudget>,
) -> Result<(Value, Vec<Value>)> {
    let request: contracts::generated::KnowledgeReadInput =
        serde_json::from_value(args.clone()).map_err(|_| Error::new("invalid_input"))?;
    let active = evidence_task;
    let mut adopted_assets = Vec::new();
    let mut skill_sources = std::collections::HashMap::new();
    let mut items = Vec::with_capacity(request.items.len());
    let mut support_pages = Vec::with_capacity(request.items.len());
    for (index, item) in request.items.into_iter().enumerate() {
        let mut support_position = None;
        let identity = match &item {
            contracts::generated::KnowledgeReadItem::Knowledge {
                knowledge_read_item_ref: reference,
                ..
            } => json!({"kind":"knowledge","ref":reference}),
            contracts::generated::KnowledgeReadItem::Memory {
                asset_ref, part, ..
            } => {
                json!({"kind":"memory","asset_ref":asset_ref,"part":part})
            }
            contracts::generated::KnowledgeReadItem::Skill { asset_ref } => {
                json!({"kind":"skill","asset_ref":asset_ref})
            }
        };
        let result: Result<Value> = async {
                    match item {
                        contracts::generated::KnowledgeReadItem::Knowledge {
                            knowledge_read_item_ref: reference, statement_id, structure_only, offset, limit, supports_cursor,
                        } => {
                            let structure_only = structure_only.unwrap_or(false);
                            let mut support_selection = super::super::knowledge_supports::SupportSelection::new(
                                &json!({"space_id":ctx.space_id,"user_id":ctx.user_id,
                                    "object_id":reference.object_id,"path":reference.path,
                                    "statement_id":statement_id,"structure_only":structure_only,
                                    "task_id":active.as_ref().map(|(task,_)|task),
                                    "limits":source_gate.map(SourceGate::allowed_sources)}),
                                &reference.version, active.as_ref().map(|(_,version)|*version),
                                supports_cursor.as_deref(),
                            )?;
                            let meta = knowledge::read_selected_structure_in_tx(
                                tx, ctx, &reference.object_id, epoch(&reference.version)?, Some(&reference.path),
                            ).await.map_err(|error| if supports_cursor.is_some() && error.code == "stale_knowledge" {
                                Error::new("stale_cursor")
                            } else if error.code == "invalid_evidence" { Error::new("not_available") } else { error })?;
                            let selected_path = meta["entries"][0]["path"].as_str().ok_or(Error::new("invalid_evidence"))?;
                            let canonical_reference=contracts::generated::EvidenceRef {path:selected_path.to_owned(),..reference.clone()};
                            // 范围先于正文，读取、采用和草稿共用owner核实的条目选择。
                            if let Some(gate) = source_gate
                                && !gate.allows_object(&meta) {
                                return Err(Error::new("source_not_allowed"));
                            }
                            super::super::knowledge::assert_selection_sources_in_tx(tx, ctx, &meta, selected_path).await
                                .map_err(|error| if supports_cursor.is_some() && matches!(error.code,"stale_context"|"stale_source"|"stale_knowledge") {
                                    Error::new("stale_cursor")
                                } else { error })?;
                            let mut page = knowledge::read_entry_page_in_tx(
                                tx, ctx, &canonical_reference, statement_id.as_deref(), structure_only,
                                offset.unwrap_or(0) as usize, limit.unwrap_or(4096) as usize,
                            ).await?;
                            let support_refs = page["supports"].as_array().into_iter().flatten()
                                .filter(|support| support["reference"]["kind"] == "knowledge")
                                .map(|support| support["reference"]["ref"].clone()).collect::<Vec<_>>();
                            super::super::knowledge::check_refs_for_task_in_tx(tx, ctx, &json!(support_refs), source_gate).await?;
                            let mut reply = json!({"kind":"knowledge","ref":reference,"state":"ok"});
                            if let Some(statement_id) = &statement_id {
                                reply["statement_id"] = json!(statement_id);
                            }
                            if structure_only {
                                // 分页正文不能替代完整列绑定；只取所选的有界结构交给原采用规则。
                                let binding = json!({"id":reference.object_id,"version":reference.version,
                                    "kind":meta["kind"],"name":meta["name"],"related_ids":page["related_ids"],
                                    "entries":[{"entry_id":page["entry_id"],"path":canonical_reference.path,
                                        "effective_structure":page["binding_structure"]}]});
                                let checked = super::super::knowledge::semantic_object_in_tx(tx, ctx, binding).await?;
                                reply["structure_coverage"] = checked["structure_coverage"].clone();
                                reply["structure_dependencies"] = checked["structure_dependencies"].clone();
                                if checked["structure_coverage"]["state"] != "complete" {
                                    page["content"] = json!("");
                                    page["content_page"] = json!({"offset":0,"total_chars":0,"complete":true,"next_offset":null});
                                    page["structure_text"] = json!("");
                                    page["structure_page"] = page["content_page"].clone();
                                    page["effective_structure"] = Value::Null;
                                }
                                for field in ["structure_text", "structure_page", "effective_structure"] {
                                    reply[field] = page[field].clone();
                                }
                            }
                            let content_path = format!("/items/{index}/content");
                            let visible = [super::super::knowledge_supports::VisibleSupportContent {
                                field: None, offset: page["content_page"]["offset"].as_u64().unwrap_or(0),
                                text: page["content"].as_str().unwrap_or(""), path: &content_path,
                            }];
                            let support_page = super::super::knowledge_supports::read_in_tx(
                                tx, ctx, super::super::knowledge_supports::SupportRead {
                                    reference:&canonical_reference, statement_id:statement_id.as_deref(), selection:&mut support_selection,
                                    visible: if structure_only { &[] } else { &visible },
                                }, source_gate,
                            ).await.map_err(|error| if supports_cursor.is_some() && matches!(error.code,"stale_context"|"stale_source"|"stale_knowledge") {
                                Error::new("stale_cursor")
                            } else { error })?;
                            reply["content"] = page["content"].clone();
                            reply["content_page"] = page["content_page"].clone();
                            reply["supports"] = support_page["supports"].clone();
                            reply["supports_total"] = support_page["total"].clone();
                            reply["supports_complete"] = page["supports_complete"].clone();
                            reply["citations"] = page["citations"].clone();
                            reply["content_state"] = json!(if page["content_page"]["next_offset"].is_null(){"complete"}else{"partial"});
                            reply["support_state"] = json!(if support_page["total"].as_u64().is_some_and(|total| support_page["supports"].as_array().map_or(0, Vec::len) < total as usize)
                                || support_page["supports"].as_array().into_iter().flatten().any(super::super::knowledge_supports::incomplete) {
                                "partial"
                            } else if page["supports_complete"] == true { "delivered" } else { "unknown" });
                            reply["continuation"] = json!({"content_next_offset":page["content_page"]["next_offset"],"supports_next_cursor":support_page["next_cursor"]});
                            support_position = Some(super::super::knowledge_supports::SupportPage {
                                selection: support_selection,
                                total: support_page["total"].as_u64().map(|total| total as usize),
                                positions: support_page["positions"]
                                    .as_array()
                                    .into_iter()
                                    .flatten()
                                    .map(|position| position.as_u64().unwrap_or(0) as usize)
                                    .collect(),
                            });
                            Ok(reply)
                        }
                        contracts::generated::KnowledgeReadItem::Memory { asset_ref, part, offset, limit } => {
                            let asset = assets::read_in_tx(tx, ctx, &asset_ref.id, true).await?;
                            if asset["kind"] != "memory" {
                                return Err(Error::new("not_available"));
                            }
                            if asset["version"] != asset_ref.version {
                                return Err(Error::new("stale_knowledge"));
                            }
                            super::super::source_limits::assert_asset_in_tx(tx,ctx,source_gate,&asset).await?;
                            let field = match part {
                                contracts::generated::PartEnum::Body => "body",
                                contracts::generated::PartEnum::Scope => "scope",
                                contracts::generated::PartEnum::SourceText => "source_text",
                            };
                            let offset = offset.unwrap_or(0) as usize;
                            if offset > asset[field].as_str().unwrap_or("").chars().count() {
                                return Err(Error::new("invalid_input"));
                            }
                            adopted_assets.push(json!({"id":asset["id"],"version":asset["version"]}));
                            let asset = retrieval::model_page(asset, offset, limit.unwrap_or(4096) as usize, Some(field));
                            Ok(json!({"kind":"memory","asset_ref":asset_ref,"part":part,"state":"ok","asset":asset}))
                        }
                        contracts::generated::KnowledgeReadItem::Skill { asset_ref } => {
                            let asset = assets::read_with_sources_in_tx(tx, ctx, &asset_ref.id, true).await?;
                            if asset["kind"] != "skill" {
                                return Err(Error::new("not_available"));
                            }
                            if asset["version"] != asset_ref.version {
                                return Err(Error::new("stale_knowledge"));
                            }
                            if !assets::selected_in_tx(tx, ctx, cid).await?.iter()
                                .any(|selected| selected["id"] == asset_ref.id && selected["version"] == asset_ref.version)
                            {
                                return Err(Error::new("not_available"));
                            }
                            let proof = super::super::personal_assets::authorize_skill_in_tx(tx, ctx, &asset, source_gate, checked).await?;
                            if asset.get("skill_sources").is_some() {
                                skill_sources.insert(asset_ref.id.clone(), proof);
                            }
                            adopted_assets.push(json!({"id":asset["id"],"version":asset["version"]}));
                            let mut descriptor = assets::skill_files::descriptor(&asset);
                            let scope = asset["scope"].as_str().unwrap_or("").chars().count();
                            let visible = descriptor["scope"].as_str().unwrap_or("").chars().count();
                            descriptor["scope_page"] = json!({"offset":0,"total_chars":scope,
                                "complete":visible==scope,"next_offset":if visible<scope {Some(visible)} else {None}});
                            Ok(json!({"kind":"skill","asset_ref":asset_ref,"state":"ok","asset":descriptor}))
                        }
                    }
                }.await;
        support_pages.push(support_position);
        match result {
            Ok(value) => items.push(value),
            Err(error) if error.code == "stale_knowledge" => {
                let mut value = identity;
                value["state"] = json!("stale");
                items.push(value);
            }
            Err(error)
                if matches!(
                    error.code,
                    "not_available"
                        | "forbidden"
                        | "source_not_allowed"
                        | "stale_context"
                        | "result_expired"
                        | "result_unavailable"
                ) =>
            {
                let mut value = identity;
                value["state"] = json!("not_available");
                items.push(value);
            }
            Err(error) if error.code == "unavailable" => {
                return Err(Error::new("upstream_failed"));
            }
            Err(error) => return Err(error),
        }
    }
    let reply = super::super::evidence_delivery::knowledge_reply(
        json!({"items":items}),
        response_budget,
        &support_pages,
    )?;
    for item in super::super::context_authority::items(&reply["items"]) {
        if item["state"] == "ok"
            && item["kind"] == "skill"
            && let Some(proof) =
                skill_sources.get(item["asset_ref"]["id"].as_str().expect("Skill reply ID"))
        {
            super::super::context_authority::merge(authority, proof)?;
        }
    }
    contracts::validate("KnowledgeReadReply", &reply)?;
    Ok((reply, adopted_assets))
}
