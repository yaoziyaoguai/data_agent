use crate::types::fingerprint;
use serde_json::{Value, json};

// 调用者已完成回源授权；只从当前正式正文重建片段，不信任索引摘要。
pub fn attach_matches(space: &str, object: &mut Value, candidate: &Value) {
    if object["id"] != candidate["id"] || object["version"] != candidate["version"] {
        return;
    }
    let mut excerpts = Vec::new();
    let mut legacy_locations = None;
    for hit in candidate["matches"].as_array().into_iter().flatten() {
        let hit = if ["entry_id", "offset", "length", "content_hash"]
            .iter()
            .all(|key| hit[*key].is_null())
        {
            let locations = legacy_locations
                .get_or_insert_with(|| super::vector::fragment_locations(space, object));
            let Some(location) = hit["fragment_id"].as_str().and_then(|id| locations.get(id))
            else {
                continue;
            };
            location
        } else {
            hit
        };
        let Some(excerpt) = checked_excerpt(object, hit) else {
            continue;
        };
        if !excerpts.contains(&excerpt) {
            excerpts.push(excerpt);
        }
    }
    // 先保留不同条目的首个命中，避免同一条目的重叠窗口挤掉另一项依据。
    let mut selected = Vec::new();
    for excerpt in &excerpts {
        if selected.len() == 3 {
            break;
        }
        if !selected
            .iter()
            .any(|v: &Value| v["entry_id"] == excerpt["entry_id"])
        {
            selected.push(excerpt.clone());
        }
    }
    for excerpt in excerpts {
        if selected.len() == 3 {
            break;
        }
        if !selected.contains(&excerpt) {
            selected.push(excerpt);
        }
    }
    let located = !selected.is_empty();
    object["retrieval"] = json!({
        "state":if located {"located"} else {"unlocated"},
        "excerpts":selected,
        "note":if located {
            "片段来自当前有权读取的正式正文，只覆盖命中范围。使用本对象id/version与片段entry_id，通过read_knowledge从offset=0分页读取完整条目，再核对结论。"
        } else {
            "向量命中缺少可核验的位置，目录开头不是命中片段。请用本对象id/version通过read_knowledge补读全文；需受控重建索引后才能补齐位置，本次未自动重建。"
        }
    });
}

fn checked_excerpt(object: &Value, hit: &Value) -> Option<Value> {
    let entry_id = hit["entry_id"].as_str()?;
    let offset = usize::try_from(hit["offset"].as_u64()?).ok()?;
    let length = usize::try_from(hit["length"].as_u64()?).ok()?;
    if !(1..=360).contains(&length) {
        return None;
    }
    let entry = object["entries"]
        .as_array()?
        .iter()
        .find(|e| e["entry_id"] == entry_id)?;
    let value = entry["effective_value"].as_str()?;
    let total = value.chars().count();
    if offset.checked_add(length)? > total {
        return None;
    }
    let text: String = value.chars().skip(offset).take(length).collect();
    if hit["content_hash"].as_str()? != fingerprint(&json!(text)) {
        return None;
    }
    Some(
        json!({"entry_id":entry_id,"path":entry["path"],"offset":offset,
        "length":length,"total_chars":total,"text":text}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hit(entry: &str, offset: usize, text: &str) -> Value {
        json!({"entry_id":entry,"offset":offset,"length":text.chars().count(),
            "content_hash":fingerprint(&json!(text))})
    }

    #[test]
    fn excerpts_keep_unicode_offsets_distinct_entries_and_authoritative_text() {
        let prefix = "无关前言🌏".repeat(150);
        let rule = "设备超过校准期限必须停用。";
        let mut object = json!({"id":"manual","version":"7","entries":[
            {"entry_id":"safety","path":"safety","effective_value":format!("{prefix}{rule}")},
            {"entry_id":"scope","path":"scope","effective_value":"仅适用于检测设备。"}]});
        let candidate = json!({"id":"manual","version":"7","matches":[
            hit("safety",prefix.chars().count(),rule),hit("safety",prefix.chars().count(),rule),
            hit("scope",0,"仅适用于检测设备。") ]});
        attach_matches("demo", &mut object, &candidate);
        assert_eq!(object["retrieval"]["state"], "located");
        assert_eq!(object["retrieval"]["excerpts"].as_array().unwrap().len(), 2);
        assert_eq!(object["retrieval"]["excerpts"][0]["text"], rule);
        assert_eq!(
            object["retrieval"]["excerpts"][0]["offset"],
            prefix.chars().count()
        );
        assert_eq!(object["retrieval"]["excerpts"][1]["entry_id"], "scope");
        assert!(
            object["entries"][0]["effective_value"]
                .as_str()
                .unwrap()
                .starts_with(&prefix)
        );
    }

    #[test]
    fn legacy_invalid_and_stale_hits_cannot_claim_a_source_excerpt() {
        let base = json!({"id":"manual","version":"2","entries":[
            {"entry_id":"body","path":"body","effective_value":"当前规则"}]});
        for bad in [
            json!({}),
            hit("missing", 0, "当前规则"),
            hit("body", 999, "当前规则"),
            hit("body", 0, "已废规则"),
            json!({"entry_id":"body","offset":0,"length":361,"content_hash":""}),
        ] {
            let mut object = base.clone();
            attach_matches(
                "demo",
                &mut object,
                &json!({"id":"manual","version":"2","matches":[bad]}),
            );
            assert_eq!(object["retrieval"]["state"], "unlocated");
            assert_eq!(object["retrieval"]["excerpts"], json!([]));
            assert!(
                object["retrieval"]["note"]
                    .as_str()
                    .unwrap()
                    .contains("本次未自动重建")
            );
        }
        let mut current = base;
        attach_matches(
            "demo",
            &mut current,
            &json!({"id":"manual","version":"1","matches":[hit("body",0,"当前规则")]}),
        );
        assert!(current.get("retrieval").is_none());
    }

    #[test]
    fn legacy_fragment_key_restores_the_same_current_source_range_only() {
        let text = format!("{}只允许馆内使用。", "资料背景🌏".repeat(150));
        let base = json!({"id":"manual","name":"借阅规则","kind":"document","state":"enabled","version":"2",
            "entries":[{"entry_id":"body","path":"body","label":"正文","effective_value":text}]});
        let key = fingerprint(&json!([
            "demo",
            "manual",
            "2",
            "body",
            560,
            super::super::embedding::SPEC.version
        ]));
        let candidate = json!({"id":"manual","version":"2","matches":[{"fragment_id":key}]});
        let mut current = base.clone();
        attach_matches("demo", &mut current, &candidate);
        assert_eq!(current["retrieval"]["state"], "located");
        let excerpt = &current["retrieval"]["excerpts"][0];
        assert_eq!(excerpt["offset"], 560);
        assert_eq!(
            excerpt["text"],
            text.chars().skip(560).take(360).collect::<String>()
        );
        let mut other_space = base;
        attach_matches("other", &mut other_space, &candidate);
        assert_eq!(other_space["retrieval"]["state"], "unlocated");
    }
}
