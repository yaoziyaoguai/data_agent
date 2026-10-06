use super::embedding;
use crate::types::{Error, Result, fingerprint};
use serde_json::{Value, json};
pub fn enabled() -> bool {
    std::env::var("DATA_AGENT_VECTOR_URL").is_ok_and(|v| !v.is_empty())
}
pub fn target() -> String {
    fingerprint(&json!([
        embedding::SPEC.version,
        std::env::var("DATA_AGENT_VECTOR_URL").unwrap_or_default(),
        std::env::var("DATA_AGENT_VECTOR_COLLECTION")
            .unwrap_or_else(|_| "data_agent_shared_qwen1024".into())
    ]))
}

struct Milvus {
    url: reqwest::Url,
    client: reqwest::Client,
    collection: String,
    token: String,
}
impl Milvus {
    fn configured() -> Result<Self> {
        let url = reqwest::Url::parse(
            &std::env::var("DATA_AGENT_VECTOR_URL")
                .map_err(|_| Error::new("vector_unconfigured"))?,
        )
        .map_err(|_| Error::new("invalid_input"))?;
        if url.scheme() != "http"
            || url.host_str() != Some("127.0.0.1")
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err(Error::new("invalid_input"));
        }
        let collection = std::env::var("DATA_AGENT_VECTOR_COLLECTION")
            .unwrap_or_else(|_| "data_agent_shared_qwen1024".into());
        if collection.is_empty()
            || collection.len() > 128
            || !collection
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_')
        {
            return Err(Error::new("invalid_input"));
        }
        let path = std::env::var("DATA_AGENT_VECTOR_TOKEN_FILE")
            .map_err(|_| Error::new("vector_unconfigured"))?;
        let token = std::fs::read_to_string(path).map_err(|_| Error::new("vector_unconfigured"))?;
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(8))
            .build()
            .map_err(|_| Error::new("vector_unavailable"))?;
        Ok(Self {
            url,
            client,
            collection,
            token: format!("root:{}", token.trim()),
        })
    }
    async fn call(&self, path: &str, payload: Value) -> Result<Value> {
        let mut payload = payload;
        payload["collectionName"] = json!(self.collection);
        payload["dbName"] = json!("default");
        let response = self
            .client
            .post(
                self.url
                    .join(&format!("/v2/vectordb/{path}"))
                    .map_err(|_| Error::new("invalid_input"))?,
            )
            .bearer_auth(&self.token)
            .json(&payload)
            .send()
            .await
            .map_err(|_| Error::new("vector_unavailable"))?;
        if !response.status().is_success()
            || response.content_length().is_some_and(|n| n > 8_000_000)
        {
            return Err(Error::new("vector_unavailable"));
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|_| Error::new("vector_unavailable"))?;
        if bytes.len() > 8_000_000 {
            return Err(Error::new("payload_limit"));
        }
        let value: Value =
            serde_json::from_slice(&bytes).map_err(|_| Error::new("vector_unavailable"))?;
        if value["code"] != 0 {
            return Err(Error::new("vector_unavailable"));
        }
        Ok(value["data"].clone())
    }
    async fn ensure_collection(&self) -> Result<String> {
        if self.call("collections/has", json!({})).await?["has"] == true {
            return self.identity().await;
        }
        let create=self.call("collections/create",json!({"dimension":embedding::SPEC.dimension,"idType":"VarChar","autoID":false,"primaryFieldName":"id","vectorFieldName":"vector","metricType":"COSINE","consistencyLevel":"Strong","params":{"max_length":"128","enableDynamicField":true}})).await;
        if create.is_err() && self.call("collections/has", json!({})).await?["has"] != true {
            return Err(Error::new("vector_unavailable"));
        }
        self.identity().await
    }
    async fn identity(&self) -> Result<String> {
        let description = self.call("collections/describe", json!({})).await?;
        let vector = description["fields"]
            .as_array()
            .and_then(|fields| fields.iter().find(|f| f["name"] == "vector"));
        let dimension = vector
            .and_then(|f| f["params"].as_array())
            .and_then(|params| params.iter().find(|p| p["key"] == "dim"))
            .and_then(|p| p["value"].as_str())
            .and_then(|v| v.parse::<usize>().ok());
        if dimension != Some(embedding::SPEC.dimension) {
            return Err(Error::new("vector_dimension_mismatch"));
        }
        let id = description
            .get("collectionID")
            .or_else(|| description.get("collectionId"))
            .ok_or(Error::new("vector_unavailable"))?;
        if id.as_str().is_none() && id.as_u64().is_none() {
            return Err(Error::new("vector_unavailable"));
        }
        Ok(fingerprint(&json!([target(), id])))
    }
}
pub async fn index_target() -> Result<String> {
    let milvus = Milvus::configured()?;
    milvus.ensure_collection().await
}
pub struct Candidates {
    pub values: Vec<Value>,
    pub state: &'static str,
    pub bounded: bool,
    pub target: Option<String>,
}
impl Candidates {
    pub fn lexical() -> Self {
        Self {
            values: vec![],
            state: "unconfigured",
            bounded: false,
            target: None,
        }
    }
}

pub async fn search(space: &str, query: &str, vector: Vec<f32>) -> Candidates {
    if !enabled() {
        return Candidates::lexical();
    }
    let search = async {
        let milvus = Milvus::configured()?;
        let identity = milvus.identity().await?;
        let value=milvus.call("entities/search",json!({"data":[vector],"annsField":"vector","filter":format!("space_id == {} && model == {}",json!(space),json!(embedding::SPEC.version)),"limit":200,"outputFields":["object_id","object_version","kind"],"consistencyLevel":"Strong"})).await?;
        let items = value.as_array().ok_or(Error::new("vector_unavailable"))?;
        let mut values = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for item in items {
            let id = item["object_id"]
                .as_str()
                .ok_or(Error::new("vector_unavailable"))?;
            let version = item["object_version"]
                .as_u64()
                .ok_or(Error::new("vector_unavailable"))?;
            if seen.insert((id.to_owned(), version)) {
                values.push(json!({"id":id,"version":version.to_string()}));
            }
        }
        Ok::<_, Error>(Candidates {
            values,
            state: "available",
            bounded: items.is_empty() || items.len() == 200 || query.chars().count() > 1600,
            target: Some(identity),
        })
    };
    match tokio::time::timeout(std::time::Duration::from_secs(2), search).await {
        Ok(Ok(value)) => value,
        failed => {
            eprintln!(
                "vector_search_failure code={}",
                match failed {
                    Ok(Err(error)) => error.code,
                    _ => "vector_search_timeout",
                }
            );
            Candidates {
                values: vec![],
                state: "unavailable",
                bounded: true,
                target: None,
            }
        }
    }
}

fn fragments(space: &str, object: &Value) -> (Vec<Value>, bool) {
    if object["state"] != "enabled" {
        return (vec![], false);
    }
    let mut pieces = Vec::new();
    let mut bounded = false;
    for entry in object["entries"].as_array().into_iter().flatten() {
        if matches!(entry["path"].as_str(), Some("ddl" | "etl")) {
            continue;
        }
        let text = entry["effective_value"].as_str().unwrap_or("");
        if text.is_empty() {
            continue;
        }
        let chars = text.chars().collect::<Vec<_>>();
        for offset in (0..chars.len().max(1)).step_by(280) {
            if pieces.len() == 128 {
                bounded = true;
                break;
            }
            let body = chars.iter().skip(offset).take(360).collect::<String>();
            let text = format!(
                "{} {} {}：{}",
                object["name"].as_str().unwrap_or(""),
                object["kind"].as_str().unwrap_or(""),
                entry["label"].as_str().unwrap_or(""),
                body
            );
            let key = fingerprint(&json!([
                space,
                object["id"],
                object["version"],
                entry["entry_id"],
                offset,
                embedding::SPEC.version
            ]));
            pieces.push(json!({"id":key,"space_id":space,"object_id":object["id"],"object_version":object["version"].as_str().unwrap_or("0").parse::<u64>().unwrap_or(0),"kind":object["kind"],"model":embedding::SPEC.version,"text":text}));
        }
    }
    if pieces.is_empty() {
        pieces.push(json!({"id":fingerprint(&json!([space,object["id"],object["version"],embedding::SPEC.version])),"space_id":space,"object_id":object["id"],"object_version":object["version"].as_str().unwrap_or("0").parse::<u64>().unwrap_or(0),"kind":object["kind"],"model":embedding::SPEC.version,"text":object["name"]}));
    }
    (pieces, bounded)
}

// 不可变版本/片段键使重发可查证；旧任务只能删除比自己更旧的片段，不能覆盖新版。
pub async fn apply<F, Fut>(space: &str, objects: &[Value], mut embed: F) -> Result<Vec<Value>>
where
    F: FnMut(Value, usize, Vec<String>) -> Fut + Send,
    Fut: Future<Output = Result<Vec<Vec<f32>>>> + Send,
{
    let milvus = Milvus::configured()?;
    // 调用者领取前已核验集合；中途丢库由下一次领取重新核验，避免每对象重复describe。
    let mut reports = Vec::new();
    for object in objects {
        let (pieces, bounded) = fragments(space, object);
        for (batch, chunk) in embedding::batches(&pieces)?.into_iter().enumerate() {
            let ids = chunk.iter().map(|v| v["id"].clone()).collect::<Vec<_>>();
            let existing=milvus.call("entities/query",json!({"filter":format!("id in {}",json!(ids)),"outputFields":["id"],"limit":512,"consistencyLevel":"Strong"})).await?;
            let present = existing
                .as_array()
                .ok_or(Error::new("vector_unavailable"))?
                .iter()
                .filter_map(|v| v["id"].as_str())
                .collect::<std::collections::HashSet<_>>();
            if chunk
                .iter()
                .all(|v| present.contains(v["id"].as_str().unwrap_or("")))
            {
                continue;
            }
            let vectors = embed(
                object.clone(),
                batch,
                chunk
                    .iter()
                    .map(|v| v["text"].as_str().unwrap_or("").to_owned())
                    .collect(),
            )
            .await?;
            if vectors.len() != chunk.len() {
                return Err(Error::new("embedding_unavailable"));
            }
            let data = chunk
                .iter()
                .zip(vectors)
                .map(|(piece, vector)| {
                    let mut piece = piece.clone();
                    piece.as_object_mut().expect("fragment").remove("text");
                    piece["vector"] = json!(vector);
                    piece
                })
                .collect::<Vec<_>>();
            milvus.call("entities/upsert", json!({"data":data})).await?;
        }
        reports.push(json!({"id":object["id"],"version":object["version"],"state":if bounded{"bounded"}else{"indexed"}}));
    }
    for batch in objects.chunks(64) {
        let mut filters = Vec::new();
        for object in batch {
            let version = object["version"]
                .as_str()
                .unwrap_or("0")
                .parse::<u64>()
                .map_err(|_| Error::new("invalid_input"))?;
            let comparison = if object["state"] == "enabled" {
                "<"
            } else {
                "<="
            };
            filters.push(format!(
                "(object_id == {} && object_version {comparison} {version})",
                object["id"]
            ));
        }
        if !filters.is_empty() {
            milvus.call("entities/delete",json!({"filter":format!("space_id == {} && model == {} && ({})",json!(space),json!(embedding::SPEC.version),filters.join(" || "))})).await?;
        }
    }
    Ok(reports)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn version_and_fragment_keys_cannot_overwrite_newer_documents() {
        let object = json!({"id":"doc","name":"合成说明","kind":"document","state":"enabled","version":"1","entries":[{"entry_id":"body","label":"正文","effective_value":"中文说明".repeat(200)}]});
        let (first, bounded) = fragments("demo", &object);
        assert!(!bounded);
        assert!(first.len() > 1);
        let mut newer = object.clone();
        newer["version"] = json!("2");
        let (second, _) = fragments("demo", &newer);
        assert!(
            first
                .iter()
                .all(|a| second.iter().all(|b| a["id"] != b["id"]))
        );
        newer["state"] = json!("disabled");
        assert!(fragments("demo", &newer).0.is_empty());
    }
}
