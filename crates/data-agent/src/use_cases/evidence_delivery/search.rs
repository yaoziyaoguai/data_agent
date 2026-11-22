use super::*;

pub(in crate::use_cases) struct SearchDelivery<'a> {
    pub search: &'a super::super::knowledge::KnowledgeSearch,
    pub selection: &'a SearchSelection,
    pub support_pages: &'a [Option<super::super::knowledge_supports::SupportPage>],
    pub assets: &'a Value,
    pub asset_after: Option<&'a str>,
    /// 本次成功回执对外发布的短引用（rc1:<operation_id>），仅用于容量按公开形态计算。
    pub public_next: &'a str,
}

pub(in crate::use_cases) fn search_reply(
    mut reply: Value,
    budget: Option<&ResponseBudget>,
    delivery: SearchDelivery<'_>,
) -> Result<Value> {
    let capacity = ResponseCapacity::new(budget);
    let key_hints = key_hints(&delivery.search.objects);
    if !key_hints.is_empty() {
        reply["key_hints"] = json!(key_hints);
    }
    let hits = reply["hits"]
        .as_array()
        .ok_or(Error::new("invalid_input"))?
        .clone();
    let records = delivery
        .search
        .hits
        .iter()
        .flat_map(super::super::knowledge::SearchHit::record_keys)
        .collect::<Vec<_>>();
    // §4.1：容量按模型真正可见的公开投影（短引用）计算；完整续取窗口
    // 只在返回前放回宿主持久回执，不占模型可见预算，也不改命中与排名。
    let mut full_next = delivery.selection.next(delivery.search, &records)?;
    reply["search_coverage"]["next"] = json!(delivery.public_next);
    let count: usize = hits
        .iter()
        .map(|hit| hit["supports"].as_array().map_or(0, Vec::len))
        .sum();
    if count <= 50 && capacity.fits(&reply) {
        reply["search_coverage"]["next"] = full_next;
        return Ok(reply);
    }
    // 键摘要只用剩余空间，不能占掉正文、条件或续读位置。
    reply
        .as_object_mut()
        .ok_or(crate::types::Error::new("unavailable"))?
        .remove("key_hints");
    let original = reply.clone();
    let mut minimal = Vec::with_capacity(hits.len());
    let mut supports = Vec::with_capacity(hits.len());
    for (index, hit) in hits.iter().enumerate() {
        if hit["record_kind"] == "knowledge_entry" {
            let mut full = hit["supports"]
                .as_array()
                .ok_or(Error::new("invalid_input"))?
                .clone();
            for support in &mut full {
                restore_support_content(support, &original)?;
            }
            supports.push(full);
            let mut item = search_content(hit, &delivery.search.hits[index], 0, 0)?;
            knowledge_support_page(
                &mut item,
                vec![],
                delivery.support_pages[index]
                    .as_ref()
                    .ok_or(Error::new("invalid_input"))?,
            )?;
            minimal.push(item);
        } else {
            supports.push(vec![]);
            minimal.push(search_content(hit, &delivery.search.hits[index], 1, 0)?);
        }
    }
    // 目录拆成两种类型前的原顺序决定游标；Mem0额外召回不在目录页内。先为
    // 全部已核验额外项保留不可静默删除的最小身份（id/version/补读位置），再用
    // 余量交目录前缀并正确保其cursor；容量裁剪只作用于目录尾部与命中，额外项
    // 不进入可从尾部删除的混合数组，装不下沿tool_response_capacity如实失败。
    let mut assets: Vec<Value> = delivery.assets["order"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|id| {
            original["personal_memories"]
                .as_array()
                .into_iter()
                .flatten()
                .chain(original["selected_skills"].as_array().into_iter().flatten())
                .find(|asset| asset["id"] == *id)
                .cloned()
        })
        .collect();
    let directory_len = assets.len();
    let extras: Vec<Value> = original["personal_memories"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|extra| !assets.iter().any(|asset| asset["id"] == extra["id"]))
        .cloned()
        .collect();
    assets.extend(extras.iter().cloned());
    let mut minimal_assets = assets.clone();
    for (asset, full) in minimal_assets.iter_mut().zip(&assets) {
        if asset["kind"] == "memory" {
            for field in ["body", "scope"] {
                memory_content(asset, full, field, 0)?;
            }
        } else {
            asset["scope"] = json!("");
            if full["scope"].as_str().is_some_and(|text| !text.is_empty()) {
                asset["scope_complete"] = json!(false);
            }
        }
    }
    let mut kept_hits = minimal.len();
    let mut kept_directory = directory_len;
    loop {
        reply["hits"] = json!(&minimal[..kept_hits]);
        let records = delivery.search.hits[..kept_hits]
            .iter()
            .flat_map(super::super::knowledge::SearchHit::record_keys)
            .collect::<Vec<_>>();
        full_next = delivery.selection.next(delivery.search, &records)?;
        reply["search_coverage"]["next"] = json!(delivery.public_next);
        let visible: Vec<&Value> = minimal_assets[..kept_directory]
            .iter()
            .chain(minimal_assets[directory_len..].iter())
            .collect();
        reply["personal_memories"] = json!(
            visible
                .iter()
                .filter(|asset| asset["kind"] == "memory")
                .collect::<Vec<_>>()
        );
        reply["selected_skills"] = json!(
            visible
                .iter()
                .filter(|asset| asset["kind"] == "skill")
                .collect::<Vec<_>>()
        );
        // 游标只反映目录位置：目录资产被裁才回指最后保留的目录项，
        // 仅裁掉Mem0额外项时保持原目录后继，额外项不得成为游标。
        reply["next_asset_after"] = if kept_directory < directory_len {
            (kept_directory > 0)
                .then(|| minimal_assets[kept_directory - 1]["id"].clone())
                .or_else(|| delivery.asset_after.map(|after| json!(after)))
                .ok_or(Error::new("tool_response_capacity"))?
        } else {
            original["next_asset_after"].clone()
        };
        if capacity.fits(&reply) {
            break;
        }
        if kept_directory > 1 {
            kept_directory -= 1;
        } else if kept_hits > 1 {
            kept_hits -= 1;
        } else if kept_directory > 0 && delivery.asset_after.is_some() {
            kept_directory -= 1;
        } else if kept_hits > 0 {
            kept_hits -= 1;
        } else {
            return Err(Error::new("tool_response_capacity"));
        }
    }
    // 完整适用条件与支持先占空间；正文稍后填入，裁掉的承载映射已还原为完整内容。
    for index in 0..kept_hits {
        if hits[index]["record_kind"] != "knowledge_entry" {
            continue;
        }
        let before = reply["hits"][index].clone();
        let scope = hits[index]["scope_text"]
            .as_str()
            .unwrap_or("")
            .chars()
            .count();
        let mut candidate = search_content(&hits[index], &delivery.search.hits[index], 0, scope)?;
        candidate["supports"] = before["supports"].clone();
        candidate["support_state"] = before["support_state"].clone();
        candidate["continuation"]["supports_next_cursor"] =
            before["continuation"]["supports_next_cursor"].clone();
        reply["hits"][index] = candidate;
        if !capacity.fits(&reply) {
            reply["hits"][index] = before;
        }
    }
    let mut support_count = 0;
    for index in 0..kept_hits {
        let Some(position) = &delivery.support_pages[index] else {
            continue;
        };
        let mut selected = Vec::new();
        for support in &supports[index] {
            if support_count == 50 {
                break;
            }
            selected.push(support.clone());
            knowledge_support_page(&mut reply["hits"][index], selected.clone(), position)?;
            if !capacity.fits(&reply) {
                // 余量只分片仍有剩余内容的长条件；完整短支持装不下就留到下页，
                // 不切半条冒充可分页。
                let mut low = 0;
                let mut high =
                    if support_count == 0 || support["content_page"]["next_offset"].is_u64() {
                        support["content"].as_str().unwrap_or("").chars().count()
                    } else {
                        0
                    };
                while low < high {
                    let keep = (low + high).div_ceil(2);
                    *selected
                        .last_mut()
                        .ok_or(crate::types::Error::new("unavailable"))? =
                        support_content(support, keep)?;
                    knowledge_support_page(&mut reply["hits"][index], selected.clone(), position)?;
                    if capacity.fits(&reply) {
                        low = keep;
                    } else {
                        high = keep - 1;
                    }
                }
                if low > 0 {
                    *selected
                        .last_mut()
                        .ok_or(crate::types::Error::new("unavailable"))? =
                        support_content(support, low)?;
                    support_count += 1;
                } else {
                    selected.pop();
                }
                knowledge_support_page(&mut reply["hits"][index], selected.clone(), position)?;
                break;
            }
            support_count += 1;
        }
    }
    for index in 0..kept_hits {
        let base = reply["hits"][index].clone();
        let field = if hits[index]["record_kind"] == "knowledge_entry" {
            "definition"
        } else {
            "text"
        };
        let scope = base["scope_text"].as_str().unwrap_or("").chars().count();
        let mut low = base[field].as_str().unwrap_or("").chars().count();
        let mut high = hits[index][field].as_str().unwrap_or("").chars().count();
        while low < high {
            let keep = (low + high).div_ceil(2);
            let mut candidate =
                search_content(&hits[index], &delivery.search.hits[index], keep, scope)?;
            if field == "definition" {
                candidate["supports"] = base["supports"].clone();
                candidate["support_state"] = base["support_state"].clone();
                candidate["continuation"]["supports_next_cursor"] =
                    base["continuation"]["supports_next_cursor"].clone();
            }
            reply["hits"][index] = candidate;
            if capacity.fits(&reply) {
                low = keep;
            } else {
                high = keep - 1;
            }
        }
        let mut item = search_content(&hits[index], &delivery.search.hits[index], low, scope)?;
        if field == "definition" {
            item["supports"] = base["supports"].clone();
            item["support_state"] = base["support_state"].clone();
            item["continuation"]["supports_next_cursor"] =
                base["continuation"]["supports_next_cursor"].clone();
        }
        reply["hits"][index] = item;
    }
    for key in ["personal_memories", "selected_skills"] {
        let length = reply[key]
            .as_array()
            .ok_or(crate::types::Error::new("unavailable"))?
            .len();
        for index in 0..length {
            let full = assets
                .iter()
                .find(|asset| asset["id"] == reply[key][index]["id"])
                .ok_or(crate::types::Error::new("unavailable"))?;
            for field in if key == "personal_memories" {
                &["body", "scope"][..]
            } else {
                &["scope"][..]
            } {
                let base = reply[key][index].clone();
                let mut low = 0;
                let mut high = full[field].as_str().unwrap_or("").chars().count();
                while low < high {
                    let keep = (low + high).div_ceil(2);
                    if key == "personal_memories" {
                        memory_content(&mut reply[key][index], full, field, keep)?;
                    } else {
                        reply[key][index][field] = json!(
                            full[field]
                                .as_str()
                                .unwrap_or("")
                                .chars()
                                .take(keep)
                                .collect::<String>()
                        );
                        reply[key][index]["scope_complete"] = json!(
                            full["scope_complete"] == true
                                && keep == full[field].as_str().unwrap_or("").chars().count()
                        );
                    }
                    if capacity.fits(&reply) {
                        low = keep;
                    } else {
                        high = keep - 1;
                    }
                }
                reply[key][index] = base;
                if key == "personal_memories" {
                    memory_content(&mut reply[key][index], full, field, low)?;
                } else {
                    reply[key][index][field] = json!(
                        full[field]
                            .as_str()
                            .unwrap_or("")
                            .chars()
                            .take(low)
                            .collect::<String>()
                    );
                    reply[key][index]["scope_complete"] = json!(
                        full["scope_complete"] == true
                            && low == full[field].as_str().unwrap_or("").chars().count()
                    );
                }
            }
        }
    }
    if !capacity.fits(&reply)
        || (kept_hits == 0
            && kept_directory == 0
            && extras.is_empty()
            && (!hits.is_empty() || !assets.is_empty()))
    {
        return Err(Error::new("tool_response_capacity"));
    }
    reply["search_coverage"]["next"] = full_next;
    Ok(reply)
}

fn key_hints(objects: &[Value]) -> Vec<String> {
    let metrics = objects
        .iter()
        .filter(|object| object["kind"] == "metric")
        .count();
    if metrics < 2 {
        return Vec::new();
    }
    let table_names = objects
        .iter()
        .filter(|object| object["kind"] == "table")
        .filter_map(|table| Some((table["id"].as_str()?, table["name"].as_str()?)))
        .collect::<std::collections::HashMap<_, _>>();
    let entries = objects.iter().flat_map(|object| {
        object["entries"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|entry| entry["review_state"] == "confirmed")
            .map(move |entry| (object, &entry["effective_structure"]))
    });
    entries
        .filter_map(|(object, structure)| match structure["kind"].as_str()? {
            "table" => {
                let keys = structure["unique_keys"].as_array()?;
                (!keys.is_empty()).then(|| {
                    format!(
                        "{} 唯一键 {}",
                        object["name"].as_str().unwrap_or(""),
                        structure["unique_keys"]
                    )
                })
            }
            "relationship" => {
                let left = table_names.get(structure["left_table"]["object_id"].as_str()?)?;
                let right = table_names.get(structure["right_table"]["object_id"].as_str()?)?;
                Some(format!(
                    "{left} ↔ {right} 关联键 {}，关系 {}",
                    structure["join_keys"], structure["cardinality"]
                ))
            }
            _ => None,
        })
        .filter(|hint| hint.chars().count() <= 500)
        .take(8)
        .collect()
}

fn search_content(
    hit: &Value,
    saved: &super::super::knowledge::SearchHit,
    definition: usize,
    scope: usize,
) -> Result<Value> {
    let mut item = hit.clone();
    match saved {
        super::super::knowledge::SearchHit::Knowledge { content, .. } => {
            let entry = &content["entries"][0];
            let statement = &entry["statement_content"];
            let full_definition = hit["definition"]
                .as_str()
                .ok_or(Error::new("invalid_input"))?;
            let full_scope = hit["scope_text"]
                .as_str()
                .ok_or(Error::new("invalid_input"))?;
            item["definition"] =
                json!(full_definition.chars().take(definition).collect::<String>());
            item["scope_text"] = json!(full_scope.chars().take(scope).collect::<String>());
            if definition < full_definition.chars().count() || scope < full_scope.chars().count() {
                let start = statement["statement_offset"]
                    .as_u64()
                    .or_else(|| entry["content_page"]["offset"].as_u64())
                    .ok_or(Error::new("invalid_input"))?;
                let next = if definition < full_definition.chars().count() {
                    start + definition as u64
                } else {
                    start.max(statement["text_chars"].as_u64().unwrap_or(0) + 1) + scope as u64
                };
                item["content_state"] = json!("partial");
                item["continuation"]["content_next_offset"] = json!(next);
            }
        }
        super::super::knowledge::SearchHit::SourceExcerpt { .. } => {
            let full = hit["text"].as_str().ok_or(Error::new("invalid_input"))?;
            item["text"] = json!(full.chars().take(definition).collect::<String>());
            if definition < full.chars().count() {
                item["content_state"] = json!("partial");
            }
        }
    }
    Ok(item)
}

fn restore_support_content(support: &mut Value, reply: &Value) -> Result<()> {
    if let Some(path) = support["delivered_in"]["path"].as_str() {
        let text = reply
            .pointer(path)
            .and_then(Value::as_str)
            .ok_or(Error::new("invalid_input"))?;
        let offset = support["delivered_in"]["locator"]["offset"]
            .as_u64()
            .ok_or(Error::new("invalid_input"))? as usize;
        let length = support["delivered_in"]["locator"]["length"]
            .as_u64()
            .ok_or(Error::new("invalid_input"))? as usize;
        if offset + length > text.chars().count() {
            return Err(Error::new("invalid_input"));
        }
        support["content"] = json!(text.chars().skip(offset).take(length).collect::<String>());
        support
            .as_object_mut()
            .ok_or(crate::types::Error::new("unavailable"))?
            .remove("delivered_in");
    }
    Ok(())
}

// 正文JSON以Rust首次保存的结果为准；Node只作无损SDK包装。
