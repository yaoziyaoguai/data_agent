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
        if !crate::upstream::http_allowed(&url)? {
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
    // 进程级共享：客户端与令牌文件只初始化一次；未成功前不缓存，
    // configured()的原始错误码逐次原样返回，配置修复后无需重启。
    fn shared() -> Result<&'static Milvus> {
        static SHARED: std::sync::OnceLock<Milvus> = std::sync::OnceLock::new();
        if let Some(milvus) = SHARED.get() {
            return Ok(milvus);
        }
        let milvus = Milvus::configured()?;
        Ok(SHARED.get_or_init(|| milvus))
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
    async fn create_current(&self) -> Result<()> {
        self.call(
            "collections/create",
            json!({
                "schema": {
                    "autoId": false,
                    "enableDynamicField": true,
                    "fields": [
                        {"fieldName":"id","dataType":"VarChar","isPrimary":true,
                         "elementTypeParams":{"max_length":"128"}},
                        {"fieldName":"vector","dataType":"FloatVector",
                         "elementTypeParams":{"dim":embedding::SPEC.dimension.to_string()}},
                        {"fieldName":"sparse","dataType":"SparseFloatVector"},
                        {"fieldName":"text","dataType":"VarChar",
                         "elementTypeParams":{"max_length":"65535","enable_analyzer":true,
                             "analyzer_params":{"type":"chinese"}}}
                    ],
                    "functions":[{"name":"text_bm25","type":"BM25",
                        "inputFieldNames":["text"],"outputFieldNames":["sparse"]}]
                },
                "indexParams": [
                    {"fieldName":"vector","indexType":"AUTOINDEX","metricType":"COSINE"},
                    {"fieldName":"sparse","indexType":"SPARSE_INVERTED_INDEX","metricType":"BM25"}
                ],
                "consistencyLevel":"Strong"
            }),
        )
        .await?;
        Ok(())
    }
    async fn identity(&self) -> Result<String> {
        let described = self.call("collections/describe", json!({})).await?;
        fn name(field: &Value) -> Option<&str> {
            field["name"]
                .as_str()
                .or_else(|| field["fieldName"].as_str())
        }
        let vector = described["fields"]
            .as_array()
            .and_then(|fields| fields.iter().find(|f| name(f) == Some("vector")));
        let dimension = vector
            .and_then(|f| f["params"].as_array())
            .and_then(|params| params.iter().find(|p| p["key"] == "dim"))
            .and_then(|p| p["value"].as_str())
            .and_then(|v| v.parse::<usize>().ok());
        if dimension != Some(embedding::SPEC.dimension) {
            return Err(Error::new("vector_dimension_mismatch"));
        }
        if !described["fields"].as_array().is_some_and(|fields| {
            fields.iter().any(|f| name(f) == Some("sparse"))
                && fields.iter().any(|f| name(f) == Some("text"))
        }) {
            return Err(Error::new("vector_schema_mismatch"));
        }
        let id = described
            .get("collectionID")
            .or_else(|| described.get("collectionId"))
            .ok_or(Error::new("vector_unavailable"))?;
        if id.as_str().is_none() && id.as_u64().is_none() {
            return Err(Error::new("vector_unavailable"));
        }
        Ok(fingerprint(&json!([target(), self.collection, id])))
    }
}
pub async fn index_target() -> Result<String> {
    Milvus::shared()?.identity().await
}

// 仅显式维护动作可准备配置的集合；查询和后台消费不创建或推导其他目标。
pub async fn prepare_index_target() -> Result<String> {
    let milvus = Milvus::shared()?;
    let exists = milvus.call("collections/has", json!({})).await?["has"]
        .as_bool()
        .ok_or(Error::new("vector_unavailable"))?;
    if !exists {
        milvus.create_current().await?;
    }
    milvus.identity().await
}

// BM25与dense两路同批并发检索；保留成功结果，失败通道如实标为未覆盖。
// 一次调用的统一截止时间（执行包初值10秒）：所有候选批次共用同一绝对期限，
// 不逐批重置；期限到按该路不可用收尾，不抹另一路已成功结果。
const SEARCH_DEADLINE: std::time::Duration = std::time::Duration::from_secs(10);

// 到期限的调用按本路不可用计；正常错误原样透传给通道吸收。
async fn call_at_deadline<T>(
    deadline: tokio::time::Instant,
    call: impl std::future::Future<Output = T>,
) -> Result<T> {
    match tokio::time::timeout_at(deadline, call).await {
        Ok(value) => Ok(value),
        Err(_) => Err(Error::new("unavailable")),
    }
}

async fn milvus_at_deadline(
    milvus: &Milvus,
    deadline: tokio::time::Instant,
    action: &str,
    body: Value,
) -> Result<Value> {
    match call_at_deadline(deadline, milvus.call(action, body)).await {
        Ok(outcome) => outcome,
        Err(_) => Err(Error::new("unavailable")),
    }
}

// 词法/稠密单路请求：两相拆分后各自由所属阶段调用，共用同一期限与输出形状。
async fn run_lexical(
    milvus: &Milvus,
    filter: &str,
    output: &Value,
    query: &str,
    batch: usize,
    offset: usize,
    deadline: tokio::time::Instant,
) -> Result<Value> {
    milvus_at_deadline(
        milvus,
        deadline,
        "entities/search",
        json!({"data":[query],"annsField":"sparse","filter":filter,"limit":batch,"offset":offset,"outputFields":output,"consistencyLevel":"Strong"}),
    )
    .await
}

async fn run_dense(
    milvus: &Milvus,
    filter: &str,
    output: &Value,
    vector: &[f32],
    batch: usize,
    offset: usize,
    deadline: tokio::time::Instant,
) -> Result<Value> {
    milvus_at_deadline(
        milvus,
        deadline,
        "entities/search",
        json!({"data":[vector],"annsField":"vector","filter":filter,"limit":batch,"offset":offset,"outputFields":output,"consistencyLevel":"Strong"}),
    )
    .await
}

// 单路批次吸收：Ok行解析为候选；任何失败（请求、期限、解析）只记本路不可用。
fn absorb_batch(
    outcome: Result<Value>,
    parse: impl Fn(&Value) -> Result<Vec<Value>>,
) -> (usize, Vec<Value>, bool) {
    match outcome.and_then(|hits| {
        let count = hits.as_array().map_or(0, Vec::len);
        Ok((count, parse(&hits)?))
    }) {
        Ok((count, rows)) => (count, rows, false),
        Err(_) => (0, Vec::new(), true),
    }
}

// 知识通道按规范片段保留定位与原始分数，索引正文不直接交付。
fn aggregate_hits(hits: &Value) -> Result<Vec<Value>> {
    let items = hits
        .as_array()
        .ok_or(Error::new("vector_unavailable"))?
        .clone();
    let mut values = Vec::new();
    for item in items {
        let id = item["object_id"]
            .as_str()
            .ok_or(Error::new("vector_unavailable"))?;
        let version = item["object_version"]
            .as_u64()
            .ok_or(Error::new("vector_unavailable"))?;
        let record = item["id"]
            .as_str()
            .ok_or(Error::new("vector_unavailable"))?;
        let mut row = json!({"id":id,"version":version.to_string(),"record_id":record,
            "matches":[{"fragment_id":record,"entry_id":item["entry_id"],"path":item["entry_path"],
                "offset":item["char_offset"],"length":item["char_length"],
                "content_hash":item["content_hash"],"score":item["distance"]}]});
        // 仅显式空串表示普通entry；缺身份时仍传原坐标，由owner核规范键和冲突。
        if item["statement_id"].as_str() != Some("") {
            for field in ["statement_id", "statement_offset"] {
                if let Some(value) = item.get(field) {
                    row["matches"][0][field] = value.clone();
                }
            }
        }
        values.push(row);
    }
    Ok(values)
}
// 分数，不把索引正文交给读者；正文一律回源核验后交付。
fn excerpt_rows(hits: &Value) -> Result<Vec<Value>> {
    let items = hits
        .as_array()
        .ok_or(Error::new("vector_unavailable"))?
        .clone();
    let mut rows: Vec<Value> = Vec::new();
    for item in items {
        let id = item["id"]
            .as_str()
            .ok_or(Error::new("vector_unavailable"))?;
        let source_kind = item["source_kind"]
            .as_str()
            .filter(|kind| matches!(*kind, "document" | "platform"))
            .ok_or(Error::new("vector_unavailable"))?;
        let source_id = item["object_id"]
            .as_str()
            .ok_or(Error::new("vector_unavailable"))?;
        let revision = item["object_version"]
            .as_u64()
            .ok_or(Error::new("vector_unavailable"))?;
        let offset = item["char_offset"]
            .as_u64()
            .ok_or(Error::new("vector_unavailable"))?;
        let length = item["char_length"]
            .as_u64()
            .filter(|length| *length > 0)
            .ok_or(Error::new("vector_unavailable"))?;
        let segmentation_version = item["segmentation_version"]
            .as_str()
            .filter(|version| *version == super::source_segments::SEGMENTATION_VERSION)
            .ok_or(Error::new("vector_unavailable"))?;
        let content_hash = item["content_hash"]
            .as_str()
            .ok_or(Error::new("vector_unavailable"))?;
        let distance = item["distance"]
            .as_f64()
            .ok_or(Error::new("vector_unavailable"))?;
        if rows.iter().any(|row| row["id"] == *id) {
            continue;
        }
        rows.push(json!({
            "id":id,
            "source_kind":source_kind,
            "source_id":source_id,
            "revision":revision,
            "offset":offset,
            "length":length,
            "segmentation_version":segmentation_version,
            "content_hash":content_hash,
            "distance":distance,
        }));
    }
    Ok(rows)
}

mod cursors;
mod projection;
mod scan;

pub use cursors::{ChannelCursor, IndexFacts, ScanSnapshot, SearchCursors, ShardCursor};
pub(super) use projection::fragment_locations;
pub use projection::{apply, apply_source_excerpts, drop_source_excerpts};
pub use scan::{
    AllowedRecords, CandidateBudget, CandidatePage, Candidates, ChannelProgress, PageRequest,
    RawCandidates, ScanChannel, ScopedQuery, fetch_page, prepare_cursors, retrieval_deadline,
    search, search_scoped,
};

#[cfg(test)]
use projection::fragments;
#[cfg(test)]
use scan::{CANDIDATE_CEILING, knowledge_output, merge_by_score, object_best_score, row_score};
#[cfg(test)]
#[path = "vector/tests/retrieval.rs"]
mod tests;
