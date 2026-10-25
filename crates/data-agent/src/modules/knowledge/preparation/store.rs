use crate::{
    contracts::{self, generated::SourceKey},
    persistence::AppTx,
    types::{AccessContext, Error, Result, epoch, fingerprint},
};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashSet};

pub async fn apply_preparation_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    operation: &str,
    source: &SourceKey,
    revision: &str,
    result: &Value,
) -> Result<Vec<Value>> {
    contracts::validate("SourcePreparationResult", result)?;
    // 成果的所有出处必须绑定正在整理的来源与修订，不能引用他处或旧修订冒充本次依据。
    for citation in result["statements"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|statement| statement["citations"].as_array().into_iter().flatten())
        .chain(
            result["relations"]
                .as_array()
                .into_iter()
                .flatten()
                .flat_map(|relation| relation["citations"].as_array().into_iter().flatten()),
        )
        .chain(
            result["statements"]
                .as_array()
                .into_iter()
                .flatten()
                .flat_map(|statement| statement["supports"].as_array().into_iter().flatten())
                .filter_map(|support| support["reference"].as_object())
                .filter(|reference| reference["kind"] == "source")
                .filter_map(|reference| reference.get("citation")),
        )
    {
        let bound = serde_json::to_value(source).map_err(|_| Error::new("invalid_input"))?;
        if citation["source"] != bound || citation["revision"].as_str() != Some(revision) {
            return Err(Error::new("invalid_prefill"));
        }
    }
    let command = json!({"action":"apply-source-preparation","source":source,"revision":revision,"result":result});
    if let Some(receipt) =
        super::super::store::begin_operation(tx, ctx, operation, &command).await?
    {
        return serde_json::from_value(receipt).map_err(|_| Error::new("invalid_input"));
    }
    let mut targets = BTreeMap::new();
    for reference in result["statements"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|s| &s["target"])
        .chain(
            result["relations"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|r| &r["subject"]),
        )
    {
        let object = reference["object_id"]
            .as_str()
            .ok_or(Error::new("invalid_input"))?;
        let version = reference["version"]
            .as_str()
            .ok_or(Error::new("invalid_input"))?;
        if targets
            .insert(object, version)
            .is_some_and(|old| old != version)
        {
            return Err(Error::new("version_conflict"));
        }
    }
    let mut saved = Vec::new();
    for (object_id, version) in targets {
        let mut object = super::super::store::locked(tx, ctx, object_id, version).await?;
        if object["state"] != "enabled" {
            return Err(Error::new("not_available"));
        }
        let document = object["kind"] == "document";
        let mut keys = HashSet::new();
        for draft in result["statements"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|s| s["target"]["object_id"] == object_id)
        {
            if !keys.insert((
                draft["target"]["path"].clone().to_string(),
                draft["key"].clone().to_string(),
            )) {
                return Err(Error::new("invalid_prefill"));
            }
            let path = draft["target"]["path"]
                .as_str()
                .ok_or(Error::new("invalid_input"))?;
            if matches!(path, "ddl" | "etl" | "type" | "lineage") {
                return Err(Error::new("invalid_prefill"));
            }
            let entry = object["entries"]
                .as_array_mut()
                .and_then(|entries| entries.iter_mut().find(|e| e["path"] == path))
                .ok_or(Error::new("invalid_prefill"))?;
            let statement_id =
                fingerprint(&json!(["statement", source, object_id, path, draft["key"]]));
            let mut supports = Vec::new();
            let mut support_keys = HashSet::new();
            for support in draft["supports"].as_array().into_iter().flatten() {
                if !support_keys.insert(support["key"].to_string()) {
                    return Err(Error::new("invalid_prefill"));
                }
                if !support["embedded_in"].is_null() {
                    let locator = contracts::decode::<contracts::generated::SourceLocator>(
                        "SourceLocator",
                        support["embedded_in"]["locator"].clone(),
                    )?;
                    let field = support["embedded_in"]["field"]
                        .as_str()
                        .ok_or(Error::new("invalid_input"))?;
                    if support["content"].as_str()
                        != Some(locator.slice(draft[field].as_str().unwrap_or(""))?)
                    {
                        return Err(Error::new("invalid_prefill"));
                    }
                }
                supports.push(
                    json!({"support_id":fingerprint(&json!([statement_id,support["key"]])),
                    "role":support["role"],"reference":support["reference"],
                    "content":support["content"],"embedded_in":support["embedded_in"]}),
                );
            }
            let statement = json!({"statement_id":statement_id,"object_ref":draft["target"],
                "text":draft["text"],"scope_text":draft["scope_text"],"origin":"model_inference",
                "citations":draft["citations"],"supports":supports});
            contracts::validate("SemanticStatement", &statement)?;
            let mut statements = entry["suggestion"]["statements"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            if let Some(old) = statements
                .iter_mut()
                .find(|s| s["statement_id"] == statement_id)
            {
                *old = statement;
            } else {
                statements.push(statement);
            }
            entry["suggestion"]["statements"] = json!(statements);
            entry["suggestion"]["analysis_state"] = json!("validated");
            if !document {
                let value = statements
                    .iter()
                    .map(|s| {
                        format!(
                            "{}{}{}",
                            s["text"].as_str().unwrap_or(""),
                            if s["scope_text"].as_str().unwrap_or("").is_empty() {
                                ""
                            } else {
                                "\n"
                            },
                            s["scope_text"].as_str().unwrap_or("")
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n\n");
                entry["suggestion"]["value"] = json!(value);
                if entry["human_override"].is_null() {
                    entry["effective_value"] = json!(value);
                    entry["review_state"] = json!("unverified");
                }
            }
        }
        let mut relations = object["semantic_relations"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        for draft in result["relations"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|r| r["subject"]["object_id"] == object_id)
        {
            let relation_id = fingerprint(&json!(["relation", source, object_id, draft["key"]]));
            let relation = json!({"relation_id":relation_id,"subject":draft["subject"],"predicate":draft["predicate"],
                "target":draft["target"],"scope_text":draft["scope_text"],"citations":draft["citations"],"origin":"model_inference"});
            if let Some(old) = relations
                .iter_mut()
                .find(|r| r["relation_id"] == relation_id)
            {
                *old = relation;
            } else {
                relations.push(relation);
            }
        }
        if !relations.is_empty() {
            object["semantic_relations"] = json!(relations);
        }
        if document {
            // 派生陈述只登记，不推进原文修订：同修订重写登记行，人工正文与版本保持不变。
            let version = epoch(
                object["version"]
                    .as_str()
                    .ok_or(Error::new("invalid_input"))?,
            )?;
            sqlx::query("DELETE FROM knowledge_versions WHERE object_id=? AND version=?")
                .bind(object_id)
                .bind(version)
                .execute(tx.connection())
                .await?;
            sqlx::query("DELETE FROM knowledge_index_jobs WHERE object_id=? AND version=?")
                .bind(object_id)
                .bind(version)
                .execute(tx.connection())
                .await?;
        } else {
            super::super::store::next(&mut object, ctx);
        }
        super::project_object(&mut object);
        super::super::store::persist(tx, ctx, &object).await?;
        saved.push(object);
    }
    super::super::store::record(tx, ctx, operation, &command, &json!(saved)).await?;
    Ok(saved)
}

pub(in crate::modules::knowledge) async fn persist_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &Value,
) -> Result<()> {
    let id = object["id"].as_str().ok_or(Error::new("invalid_input"))?;
    let version = epoch(
        object["version"]
            .as_str()
            .ok_or(Error::new("invalid_input"))?,
    )?;
    sqlx::query("DELETE FROM knowledge_statements WHERE object_id=?")
        .bind(id)
        .execute(tx.connection())
        .await?;
    for entry in object["entries"].as_array().into_iter().flatten() {
        for (layer, field) in [
            ("source_fact", "source_facts"),
            ("model_suggestion", "suggestion"),
            ("human_override", "human_override"),
        ] {
            for statement in entry[field]["statements"].as_array().into_iter().flatten() {
                contracts::validate("SemanticStatement", statement)?;
                sqlx::query("INSERT INTO knowledge_statements(object_id,version,statement_id,space_id,entry_path,layer,body) VALUES(?,?,?,?,?,?,?)")
                    .bind(id).bind(version).bind(statement["statement_id"].as_str()).bind(&ctx.space_id)
                    .bind(entry["path"].as_str()).bind(layer).bind(sqlx::types::Json(statement)).execute(tx.connection()).await?;
            }
        }
    }
    sqlx::query("DELETE FROM knowledge_relations WHERE subject_id=? AND space_id=?")
        .bind(id)
        .bind(&ctx.space_id)
        .execute(tx.connection())
        .await?;
    for relation in object["semantic_relations"]
        .as_array()
        .into_iter()
        .flatten()
    {
        contracts::validate("SemanticRelation", relation)?;
        let reference = &relation["target"];
        let (kind, target) = if reference["kind"] == "source" {
            (
                reference["citation"]["source"]["kind"].as_str(),
                reference["citation"]["source"]["id"].as_str(),
            )
        } else {
            (Some("knowledge"), reference["ref"]["object_id"].as_str())
        };
        sqlx::query("INSERT INTO knowledge_relations(relation_id,space_id,subject_id,subject_version,predicate,target_kind,target_id,body) VALUES(?,?,?,?,?,?,?,?)")
            .bind(relation["relation_id"].as_str()).bind(&ctx.space_id).bind(id).bind(version).bind(relation["predicate"].as_str())
            .bind(kind).bind(target).bind(sqlx::types::Json(relation)).execute(tx.connection()).await?;
    }
    Ok(())
}
