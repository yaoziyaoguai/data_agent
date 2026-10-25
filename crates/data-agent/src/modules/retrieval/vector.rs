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
// 旧形状集合（仅dense）不能原地加BM25函数字段；带_h1后缀的新代集合自动创建，
// 旧集合不删不改，统一切换按08执行。
const GENERATION_SUFFIX: &str = "_h1";
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
    // Some(true)=新形状（dense+BM25），Some(false)=旧形状，None=不存在。
    async fn generation(&self) -> Result<Option<bool>> {
        let described = self.call("collections/describe", json!({})).await?;
        let fields = described["fields"].as_array();
        let hybrid = fields.is_some_and(|fields| {
            fields
                .iter()
                .any(|f| f["name"] == "sparse" || f["fieldName"] == "sparse")
        });
        Ok(Some(hybrid))
    }
    async fn create_current(&self) -> Result<()> {
        let create = self
            .call(
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
            .await;
        match create {
            Ok(_) => Ok(()),
            Err(_) => {
                // 并发创建者已建成时按现状继续；形状仍不对才真正失败。
                if self.generation().await? == Some(true) {
                    Ok(())
                } else {
                    Err(Error::new("vector_unavailable"))
                }
            }
        }
    }
    // 解析实际使用的集合代次：配置名不存在→新形状建于配置名；旧形状→
    // 配置名+GENERATION_SUFFIX（不存在则创建）。旧集合不删不改。
    async fn resolve_generation(self) -> Result<Self> {
        match self.generation().await {
            Ok(Some(true)) => Ok(self),
            Ok(Some(false)) => {
                let mut next = self;
                next.collection = format!("{}{}", next.collection, GENERATION_SUFFIX);
                if next.generation().await? != Some(true) {
                    next.create_current().await?;
                }
                Ok(next)
            }
            _ => {
                self.create_current().await?;
                Ok(self)
            }
        }
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
    Milvus::configured()?
        .resolve_generation()
        .await?
        .identity()
        .await
}

// BM25与dense两路同批并发检索；两路任一失败按整体不可用降级（同集合同服务）。
async fn run_batch(
    milvus: &Milvus,
    filter: &str,
    output: &Value,
    query: &str,
    vector: &[f32],
    batch: usize,
) -> Result<(Value, Value)> {
    let (dense, lexical) = tokio::join!(
        milvus.call("entities/search", json!({"data":[vector],"annsField":"vector","filter":filter,"limit":batch,"outputFields":output,"consistencyLevel":"Strong"})),
        milvus.call("entities/search", json!({"data":[query],"annsField":"sparse","filter":filter,"limit":batch,"outputFields":output,"consistencyLevel":"Strong"}))
    );
    Ok((dense?, lexical?))
}
pub struct Candidates {
    pub values: Vec<Value>,
    pub lexical: Vec<Value>,
    pub raw: RawCandidates,
    pub state: &'static str,
    pub bounded: bool,
    pub target: Option<String>,
}
impl Candidates {
    pub fn lexical() -> Self {
        Self {
            values: vec![],
            lexical: vec![],
            raw: RawCandidates::empty("unconfigured", false),
            state: "unconfigured",
            bounded: false,
            target: None,
        }
    }
}

// 原文摘录通道命中：按通道RRF排序的摘录行（citation字段齐全），供组合层
// 门控与回源；06再接入公开v2 hits。bounded只覆盖本通道执行事实（某路为空/
// 到界），查询长度等上层条件由调用方合并。
pub struct RawCandidates {
    pub hits: Vec<Value>,
    pub state: &'static str,
    pub bounded: bool,
}
impl RawCandidates {
    pub fn empty(state: &'static str, bounded: bool) -> Self {
        Self {
            hits: vec![],
            state,
            bounded,
        }
    }
}

pub async fn search(space: &str, query: &str, vector: Vec<f32>, limit: usize) -> Candidates {
    search_scoped(
        space,
        query,
        vector,
        &crate::search_scope::KnowledgeSearchScope::default(),
        limit,
    )
    .await
}

// 执行包05初值：每路首批max(50,5*limit)，命中不足（两路合计对象数低于2*limit）时
// 扩一轮到200；合计候选上限1000。批次间分数来自同集合同metric，按原始分数合并排序。
const EXPAND_BATCH: usize = 200;
const CANDIDATE_CEILING: usize = 1000;

pub async fn search_scoped(
    space: &str,
    query: &str,
    vector: Vec<f32>,
    scope: &crate::search_scope::KnowledgeSearchScope,
    limit: usize,
) -> Candidates {
    if !enabled() {
        return Candidates::lexical();
    }
    let search = async {
        let milvus = Milvus::configured()?.resolve_generation().await?;
        let identity = milvus.identity().await?;
        let mut filter = format!(
            "space_id == {} && model == {}",
            json!(space),
            json!(embedding::SPEC.version)
        );
        if scope.kinds.is_empty() {
            // 同集合还承载原文摘录（kind=source_excerpt）：知识检索只命中知识对象，
            // 摘录通道单独按kind=source_excerpt检索。
            filter.push_str(" && kind != \"source_excerpt\"");
        } else {
            filter.push_str(&format!(" && kind in {}", json!(scope.kinds)));
        }
        // BM25与dense两路独立检索：BM25走chinese分析器保留否定/顺序/例外，
        // dense走嵌入语义；两路都带可比较原始分数与同形状输出字段。
        let output = json!([
            "id",
            "object_id",
            "object_version",
            "kind",
            "entry_id",
            "char_offset",
            "char_length",
            "content_hash"
        ]);

        let collect = |dense: &Value, lexical: &Value| -> Result<(Vec<Value>, Vec<Value>)> {
            let aggregate = |hits: &Value| -> Result<Vec<Value>> {
                let items = hits
                    .as_array()
                    .ok_or(Error::new("vector_unavailable"))?
                    .clone();
                let mut values: Vec<Value> = Vec::new();
                let mut positions = std::collections::HashMap::new();
                for item in items {
                    let id = item["object_id"]
                        .as_str()
                        .ok_or(Error::new("vector_unavailable"))?
                        .to_owned();
                    let version = item["object_version"]
                        .as_u64()
                        .ok_or(Error::new("vector_unavailable"))?;
                    let position = *positions.entry((id.clone(), version)).or_insert_with(|| {
                        values.push(json!({"id":id,"version":version.to_string(),"matches":[]}));
                        values.len() - 1
                    });
                    // 保留命中位置与原始分数，不把索引中的正文直接交给读者；旧条目没有这些字段。
                    values[position]["matches"]
                        .as_array_mut()
                        .expect("matches")
                        .push(json!({
                        "fragment_id":item["id"],"entry_id":item["entry_id"],"offset":item["char_offset"],
                            "length":item["char_length"],"content_hash":item["content_hash"],
                            "score":item["distance"]
                        }));
                }
                Ok(values)
            };
            Ok((aggregate(dense)?, aggregate(lexical)?))
        };
        let first = (50usize).max(5 * limit).min(EXPAND_BATCH);
        let (dense, lexical) = run_batch(&milvus, &filter, &output, query, &vector, first).await?;
        let (mut values, mut lexical_hits) = collect(&dense, &lexical)?;
        let mut fragments =
            dense.as_array().map_or(0, Vec::len) + lexical.as_array().map_or(0, Vec::len);
        let mut hit_ceiling = fragments >= CANDIDATE_CEILING;
        if values.len() + lexical_hits.len() < 2 * limit && first < EXPAND_BATCH {
            let (dense2, lexical2) =
                run_batch(&milvus, &filter, &output, query, &vector, EXPAND_BATCH).await?;
            fragments +=
                dense2.as_array().map_or(0, Vec::len) + lexical2.as_array().map_or(0, Vec::len);
            hit_ceiling = hit_ceiling || fragments >= CANDIDATE_CEILING;
            let (dense_values, lexical_values) = collect(&dense2, &lexical2)?;
            let merge = |mut primary: Vec<Value>, extra: Vec<Value>| {
                for hit in extra {
                    if !primary
                        .iter()
                        .any(|v| v["id"] == hit["id"] && v["version"] == hit["version"])
                    {
                        primary.push(hit);
                    }
                }
                primary
            };
            values = merge(values, dense_values);
            lexical_hits = merge(lexical_hits, lexical_values);
        }
        let bounded = values.is_empty()
            || lexical_hits.is_empty()
            || hit_ceiling
            || query.chars().count() > 1600
            || scope.anchor.is_some()
            || scope.domain.is_some();
        // 原文摘录通道（同集合kind=source_excerpt）：与知识通道共用同一次会话、
        // 同批纪律与2秒预算，不重复解析目标；通道行按序进RRF融合。
        let raw_filter = format!(
            "space_id == {} && model == {} && kind == \"source_excerpt\"",
            json!(space),
            json!(embedding::SPEC.version)
        );
        let raw_output = json!([
            "id",
            "object_id",
            "object_version",
            "char_offset",
            "char_length",
            "content_hash",
            "source_kind"
        ]);
        let (raw_dense, raw_lexical) =
            run_batch(&milvus, &raw_filter, &raw_output, query, &vector, first).await?;
        let mut raw_rows_dense = excerpt_rows(&raw_dense)?;
        let mut raw_rows_lexical = excerpt_rows(&raw_lexical)?;
        let mut raw_fragments =
            raw_dense.as_array().map_or(0, Vec::len) + raw_lexical.as_array().map_or(0, Vec::len);
        let mut raw_ceiling = raw_fragments >= CANDIDATE_CEILING;
        if raw_rows_dense.len() + raw_rows_lexical.len() < 2 * limit && first < EXPAND_BATCH {
            let (dense2, lexical2) = run_batch(
                &milvus,
                &raw_filter,
                &raw_output,
                query,
                &vector,
                EXPAND_BATCH,
            )
            .await?;
            raw_fragments +=
                dense2.as_array().map_or(0, Vec::len) + lexical2.as_array().map_or(0, Vec::len);
            raw_ceiling = raw_ceiling || raw_fragments >= CANDIDATE_CEILING;
            merge_excerpt_rows(&mut raw_rows_dense, excerpt_rows(&dense2)?);
            merge_excerpt_rows(&mut raw_rows_lexical, excerpt_rows(&lexical2)?);
        }
        let raw = RawCandidates {
            hits: super::rrf_merge_rows(&raw_rows_dense, &raw_rows_lexical),
            state: "available",
            bounded: raw_rows_dense.is_empty() || raw_rows_lexical.is_empty() || raw_ceiling,
        };
        Ok::<_, Error>(Candidates {
            values,
            lexical: lexical_hits,
            raw,
            state: "available",
            bounded,
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
                lexical: vec![],
                raw: RawCandidates::empty("unavailable", true),
                state: "unavailable",
                bounded: true,
                target: None,
            }
        }
    }
}

// 摘录行只带citation身份（source_key种类/来源id/修订/位置/hash）与通道原始
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
        if rows.iter().any(|row| row["id"] == *id) {
            continue;
        }
        rows.push(json!({
            "id":id,
            "source_kind":item["source_kind"],
            "source_id":item["object_id"],
            "revision":item["object_version"],
            "offset":item["char_offset"],
            "length":item["char_length"],
            "content_hash":item["content_hash"],
            "distance":item["distance"],
        }));
    }
    Ok(rows)
}

// 扩批合并保持主批在前：主批与扩批都按通道metric有序，追加的新行只会更靠后。
fn merge_excerpt_rows(primary: &mut Vec<Value>, extra: Vec<Value>) {
    for row in extra {
        if !primary.iter().any(|v| v["id"] == row["id"]) {
            primary.push(row);
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
                "{} {} {} {}：{}",
                object["name"].as_str().unwrap_or(""),
                object["kind"].as_str().unwrap_or(""),
                super::query_example_index_text(entry),
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
            pieces.push(json!({"id":key,"space_id":space,"object_id":object["id"],"object_version":object["version"].as_str().unwrap_or("0").parse::<u64>().unwrap_or(0),"kind":object["kind"],"model":embedding::SPEC.version,"entry_id":entry["entry_id"],"char_offset":offset,"char_length":body.chars().count(),"content_hash":fingerprint(&json!(body)),"text":text}));
        }
    }
    if pieces.is_empty() {
        pieces.push(json!({"id":fingerprint(&json!([space,object["id"],object["version"],embedding::SPEC.version])),"space_id":space,"object_id":object["id"],"object_version":object["version"].as_str().unwrap_or("0").parse::<u64>().unwrap_or(0),"kind":object["kind"],"model":embedding::SPEC.version,"text":object["name"]}));
    }
    (pieces, bounded)
}

// 老索引仅保存片段键；复用同一生成器从当前授权正文还原位置，不触发向量化或写索引。
pub(super) fn fragment_locations(
    space: &str,
    object: &Value,
) -> std::collections::HashMap<String, Value> {
    fragments(space, object)
        .0
        .into_iter()
        .map(|piece| {
            (
                piece["id"].as_str().expect("fragment id").to_owned(),
                json!({
                    "entry_id":piece["entry_id"],"offset":piece["char_offset"],
                    "length":piece["char_length"],"content_hash":piece["content_hash"]
                }),
            )
        })
        .collect()
}

// 不可变版本/片段键使重发可查证；旧任务只能删除比自己更旧的片段，不能覆盖新版。
pub async fn apply<F, Fut>(space: &str, objects: &[Value], mut embed: F) -> Result<Vec<Value>>
where
    F: FnMut(Value, usize, Vec<String>) -> Fut + Send,
    Fut: Future<Output = Result<Vec<Vec<f32>>>> + Send,
{
    let milvus = Milvus::configured()?.resolve_generation().await?;
    // 调用者领取前已核验集合；中途丢库由下一次领取重新核验，避免每对象重复describe。
    let mut reports = Vec::new();
    for object in objects {
        let (pieces, bounded) = fragments(space, object);
        for (batch, chunk) in embedding::batches(&pieces)?.into_iter().enumerate() {
            let ids = chunk.iter().map(|v| v["id"].clone()).collect::<Vec<_>>();
            let existing=milvus.call("entities/query",json!({"filter":format!("id in {}",json!(ids)),"outputFields":["id","entry_id","char_offset","char_length","content_hash"],"limit":512,"consistencyLevel":"Strong"})).await?;
            let present: std::collections::HashMap<_, _> = existing
                .as_array()
                .ok_or(Error::new("vector_unavailable"))?
                .iter()
                .filter_map(|v| v["id"].as_str().map(|id| (id, v)))
                .collect();
            if chunk.iter().all(|piece| {
                present
                    .get(piece["id"].as_str().unwrap_or(""))
                    .is_some_and(|stored| {
                        ["entry_id", "char_offset", "char_length", "content_hash"]
                            .iter()
                            .all(|key| stored[*key] == piece[*key])
                    })
            }) {
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
                    // text随向量同写供BM25通道分词；sparse由集合的BM25函数生成。
                    // target标量区分索引目标：knowledge_entry/source_excerpt（05切片2）。
                    let mut piece = piece.clone();
                    if piece["target"].is_null() {
                        piece["target"] = json!("knowledge_entry");
                    }
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

// 05切片2/3：原文摘录目标（source_excerpt）。raw键绑定SourceKey/revision/locator/
// 切块版本/嵌入规格；原文无需等待模型整理即可进入索引，整理pending/failed同样索引。
// 正文与结构背景合并为BM25文本（背景在前的结构词），content_hash只对正文。
pub async fn apply_source_excerpts<F, Fut>(
    space: &str,
    segments: &[super::source_segments::SourceSegment],
    mut embed: F,
) -> Result<()>
where
    F: FnMut(usize, Vec<String>) -> Fut + Send,
    Fut: Future<Output = Result<Vec<Vec<f32>>>> + Send,
{
    let milvus = Milvus::configured()?.resolve_generation().await?;
    let mut pieces = Vec::new();
    for segment in segments {
        let background = segment
            .background
            .iter()
            .map(|item| item.text.as_str())
            .collect::<Vec<_>>()
            .join("；");
        let body = segment.text.as_str();
        let text = if background.is_empty() {
            body.to_owned()
        } else {
            format!("{background}\n{body}")
        };
        pieces.push(json!({
            "id":fingerprint(&json!([
                space, segment.citation.source, segment.citation.revision,
                segment.citation.locator.offset, segment.citation.locator.length,
                super::source_segments::SEGMENTATION_VERSION, embedding::SPEC.version
            ])),
            "space_id":space,
            "object_id":segment.citation.source.id,
            // 与知识通道同纪律：修订按数值存储，升版清理的过滤才能做数值比较。
            "object_version":segment.citation.revision.parse::<u64>().unwrap_or(0),
            "kind":"source_excerpt",
            "target":"source_excerpt",
            // 回源需要SourceKey种类（document-{id}还是平台source_id）；只随摘录
            // 存身份，不存业务引用。
            "source_kind":match segment.citation.source.kind {
                crate::contracts::generated::SourceKeyKind::Document => "document",
                crate::contracts::generated::SourceKeyKind::Platform => "platform",
            },
            "model":embedding::SPEC.version,
            "entry_id":Value::Null,
            "char_offset":segment.citation.locator.offset,
            "char_length":segment.citation.locator.length,
            "content_hash":segment.content_hash,
            "text":text,
        }));
    }
    if pieces.is_empty() {
        return Ok(());
    }
    for (batch, chunk) in embedding::batches(&pieces)?.into_iter().enumerate() {
        let ids = chunk.iter().map(|v| v["id"].clone()).collect::<Vec<_>>();
        let existing=milvus.call("entities/query",json!({"filter":format!("id in {}",json!(ids)),"outputFields":["id","char_offset","char_length","content_hash"],"limit":512,"consistencyLevel":"Strong"})).await?;
        let present: std::collections::HashMap<_, _> = existing
            .as_array()
            .ok_or(Error::new("vector_unavailable"))?
            .iter()
            .filter_map(|v| v["id"].as_str().map(|id| (id, v)))
            .collect();
        if chunk.iter().all(|piece| {
            present
                .get(piece["id"].as_str().unwrap_or(""))
                .is_some_and(|stored| {
                    ["char_offset", "char_length", "content_hash"]
                        .iter()
                        .all(|key| stored[*key] == piece[*key])
                })
        }) {
            continue;
        }
        let vectors = embed(
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
                // 与知识片段同纪律：text保留供BM25通道，sparse由函数生成。
                let mut piece = piece.clone();
                piece["vector"] = json!(vector);
                piece
            })
            .collect::<Vec<_>>();
        milvus.call("entities/upsert", json!({"data":data})).await?;
    }
    Ok(())
}

// 原文来源修订升版：删除该来源旧修订的摘录向量（同知识对象升版语义）。
pub async fn drop_source_excerpts(space: &str, source: &str, before: u64) -> Result<()> {
    let milvus = Milvus::configured()?.resolve_generation().await?;
    milvus
        .call(
            "entities/delete",
            json!({"filter":format!(
                "space_id == {} && model == {} && target == \"source_excerpt\" && object_id == {} && object_version < {}",
                json!(space), json!(embedding::SPEC.version), json!(source), before
            )}),
        )
        .await?;
    Ok(())
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
