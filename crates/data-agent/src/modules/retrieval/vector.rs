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
    Milvus::configured()?.identity().await
}

// 仅显式维护动作可准备配置的集合；查询和后台消费不创建或推导其他目标。
pub async fn prepare_index_target() -> Result<String> {
    let milvus = Milvus::configured()?;
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
pub struct Candidates {
    pub values: Vec<Value>,
    pub lexical: Vec<Value>,
    pub raw: RawCandidates,
    pub state: &'static str,
    pub bounded: bool,
    pub target: Option<String>,
    pub space: Option<String>,
    // 逐通道执行状态（05接续）：available含成功空结果；unavailable才是失败，
    // 数组空/非空不能代替通道状态——成功空不触发后备词法路，也不计bounded。
    pub dense_state: &'static str,
    pub lexical_state: &'static str,
    // 本次调用的共同候选预算：SQL后备词法路与后续有界补取沿同一账本分配，
    // 不另起1000上限（05接续）。
    pub budget: CandidateBudget,
    pub lexical_progress: ChannelProgress,
    pub dense_progress: ChannelProgress,
    // 原文摘录通道仅include_raw时执行；未执行为None。
    pub raw_progress: Option<ChannelProgress>,
    // 各通道分片游标与dense查询向量（05切片3）：组合层按可交付候选驱动后续轮
    // 时沿各片位置前进，不在通道内以命中数量自判扩轮。deadline是本次检索的
    // 共享绝对期限，推进轮沿同一期限执行。
    pub cursors: SearchCursors,
    pub dense_vector: Option<Vec<f32>>,
    pub deadline: tokio::time::Instant,
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
            space: None,
            dense_state: "unconfigured",
            lexical_state: "unconfigured",
            budget: CandidateBudget::default(),
            lexical_progress: ChannelProgress::default(),
            dense_progress: ChannelProgress::default(),
            raw_progress: None,
            cursors: SearchCursors {
                lexical: None,
                dense: None,
                raw_lexical: None,
                raw_dense: None,
            },
            dense_vector: None,
            deadline: retrieval_deadline(),
        }
    }

    // 共同排序的通道视图：BM25/dense知识命中与raw两通道摘录行。
    pub fn sql_lexical_active(&self) -> bool {
        let mut shards = [
            self.cursors.lexical.as_ref(),
            self.cursors.raw_lexical.as_ref(),
        ]
        .into_iter()
        .flatten()
        .flat_map(|cursor| &cursor.shards)
        .peekable();
        if self.cursors.lexical.is_none() && self.cursors.raw_lexical.is_none() {
            true
        } else {
            shards.peek().is_some() && shards.all(|shard| shard.failed && !shard.succeeded)
        }
    }

    pub fn channels(&self) -> super::Channels<'_> {
        super::Channels {
            bm25: &self.lexical,
            dense: &self.values,
            raw_bm25: &self.raw.lexical,
            raw_dense: &self.raw.dense,
        }
    }

    // 候选量边界（非期限/故障）：任一执行通道停在额度或深度边界，coverage.state
    // 据此报candidate_limit而不是bounded（05接续）。
    pub fn quota_limited(&self) -> bool {
        [&self.lexical_progress, &self.dense_progress]
            .into_iter()
            .chain(self.raw_progress.as_ref())
            .any(|progress| progress.uncovered == Some("candidate_limit"))
    }
}

// 05切片3：来源门的允许记录集下推到每条召回通道。knowledge_ids是组合层按
// 实际贡献根判定的可交付知识对象id；sources是SourceKey(kind,id)对，供原文
// 摘录通道按来源身份过滤。两者都为空的门是"范围内无可召回记录"，不是全库。
#[derive(Clone)]
pub struct AllowedRecords {
    pub knowledge_ids: Vec<String>,
    pub sources: Vec<(String, String)>,
}

// 原文摘录通道命中：按通道保留有序摘录行（citation字段齐全、通道原始分数），
// 供组合层与知识行做一次共同RRF（05切片4起不再在通道层预融合）与门控回源；
// bounded只覆盖本通道执行事实（某路为空/到界），查询长度等上层条件由调用方合并。
pub struct RawCandidates {
    pub dense: Vec<Value>,
    pub lexical: Vec<Value>,
    pub state: &'static str,
    pub bounded: bool,
}
impl RawCandidates {
    pub fn empty(state: &'static str, bounded: bool) -> Self {
        Self {
            dense: vec![],
            lexical: vec![],
            state,
            bounded,
        }
    }
}

pub async fn search(space: &str, query: &str, vector: Vec<f32>, limit: usize) -> Candidates {
    // 内部双类型集成入口：原文摘录通道显式启用（生产检索按可交付类型关闭）。
    search_scoped(ScopedQuery {
        space,
        query,
        vector: Some(vector),
        scope: &crate::search_scope::KnowledgeSearchScope::default(),
        limit,
        allowed: None,
        include_raw: true,
        deadline: retrieval_deadline(),
    })
    .await
}

// 检索use_case用同一入口创建共享绝对期限（05接续）：覆盖嵌入、各通道分片与
// 后续核验；后台索引Embedding不受此期限影响。
pub fn retrieval_deadline() -> tokio::time::Instant {
    tokio::time::Instant::now() + SEARCH_DEADLINE
}

// 执行包05初值：每路首批max(50,5*limit)，命中不足（两路合计对象数低于2*limit）时
// 扩一轮到200；合计候选上限1000。批次间分数来自同集合同metric，按原始分数合并排序。
const EXPAND_BATCH: usize = 200;
const CANDIDATE_CEILING: usize = 1000;
// 最多5轮包含首轮；轮表示本次检索深度推进，允许集分片、raw/knowledge和同深度
// 拆请求不另获得轮数。
const MAX_ROUNDS: usize = 5;
// 允许集标量过滤的分片大小：控制Milvus表达式长度，同通道跨片按原始分数合并。
const ALLOWED_SHARD: usize = 200;

// 一次检索调用的共同候选预算（05接续）：1000计本次接收的唯一记录身份——知识沿
// EvidenceRef/条目定位/投影版本（即索引行id的构成），raw沿SourceKey/修订/locator/
// 表示版本（摘录行id）——不能退化成对象ID；在有效性筛除/窗口合并前累计，跨通道/
// 跨轮重复不重复计，失效或合并后不退还。每条请求发出前按剩余额度分配上限，不先
// 接收超额响应再裁；并发请求合计不得超过剩余额度，结构不便分配就顺序执行。
// 组合入口独占更新；异步请求只携预留值，接回后由同一owner结算。
#[derive(Default)]
pub struct CandidateBudget {
    seen: std::collections::HashSet<String>,
    rounds: usize,
    reserved: usize,
}
impl CandidateBudget {
    pub fn count(&self) -> usize {
        self.seen.len()
    }
    pub fn remaining(&self) -> usize {
        CANDIDATE_CEILING.saturating_sub(self.seen.len() + self.reserved)
    }
    pub fn rounds(&self) -> usize {
        self.rounds
    }
    /// 将恢复的唯一候选计入当前请求；保留当前预留与实际派发深度，不退款或续期。
    pub fn restore_candidates(&mut self, identities: impl Iterator<Item = String>) -> Result<()> {
        let mut restored = std::collections::HashSet::new();
        for identity in identities {
            if !self.seen.contains(&identity) {
                restored.insert(identity);
                if self.seen.len() + self.reserved + restored.len() > CANDIDATE_CEILING {
                    return Err(Error::new("tool_response_capacity"));
                }
            }
        }
        self.seen.extend(restored);
        Ok(())
    }
    // 请求前分配：返回该请求最多可带回的新增记录数；超过最大轮深或到界返回0。
    pub fn allocate(&mut self, depth: usize, wanted: usize) -> usize {
        if depth > MAX_ROUNDS {
            return 0;
        }
        let granted = wanted.min(CANDIDATE_CEILING.saturating_sub(self.seen.len() + self.reserved));
        if granted > 0 {
            self.rounds = self.rounds.max(depth);
        }
        self.reserved += granted;
        granted
    }
    // 接收后按唯一身份记账（重复不重复计，不退还），返回本次新增数。
    pub fn record(&mut self, reserved: usize, identities: impl Iterator<Item = String>) -> usize {
        self.reserved -= reserved;
        let before = self.seen.len();
        self.seen.extend(identities);
        self.seen.len() - before
    }
}

// 逐通道有界进度（05接续）：实际深度（含首轮）、已完成分片/总分片、是否穷举该
// 通道（足够本页结果不表示穷举），以及未覆盖原因（candidate_limit/deadline）。
#[derive(Debug, Clone, Default)]
pub struct ChannelProgress {
    pub rounds: usize,
    pub shards: usize,
    pub completed: usize,
    pub exhausted: bool,
    pub uncovered: Option<&'static str>,
}

fn batch_first(limit: usize) -> usize {
    (50usize).max(5 * limit).min(EXPAND_BATCH)
}

// 知识通道的基础标量过滤与允许集分片：v1词法/dense两相共用同一组分片。
fn knowledge_shards(
    milvus_base: String,
    allowed: Option<&AllowedRecords>,
    include_raw: bool,
) -> Vec<String> {
    match allowed {
        None if include_raw => vec![format!("{milvus_base} && (kind != \"document\" || statement_id != \"\")")],
        None => vec![milvus_base],
        Some(records) if records.knowledge_ids.is_empty() => Vec::new(),
        Some(records) => records
            .knowledge_ids
            .chunks(ALLOWED_SHARD)
            .map(|chunk| {
                let mut filter = format!("{milvus_base} && object_id in {}", json!(chunk));
                if include_raw {
                    let raw_documents = records.sources.iter()
                        .filter(|(kind, id)| kind == "document" && chunk.contains(id))
                        .map(|(_, id)| id).collect::<Vec<_>>();
                    if !raw_documents.is_empty() {
                        filter.push_str(&format!(" && (kind != \"document\" || statement_id != \"\" || object_id not in {})", json!(raw_documents)));
                    }
                }
                filter
            })
            .collect(),
    }
}

fn knowledge_base_filter(space: &str, scope: &crate::search_scope::KnowledgeSearchScope) -> String {
    let mut base = format!(
        "space_id == {} && model == {}",
        json!(space),
        json!(embedding::SPEC.version)
    );
    if scope.kinds.is_empty() {
        // 同集合还承载原文摘录（kind=source_excerpt）：知识检索只命中知识对象，
        // 摘录通道单独按kind=source_excerpt检索。
        base.push_str(" && kind != \"source_excerpt\"");
    } else {
        base.push_str(&format!(" && kind in {}", json!(scope.kinds)));
    }
    base.push_str(&format!(
        " && projection_version == {}",
        json!(crate::types::KNOWLEDGE_PROJECTION)
    ));
    base
}

const KNOWLEDGE_OUTPUT: &[&str] = &[
    "id",
    "object_id",
    "object_version",
    "kind",
    "entry_id",
    "entry_path",
    "statement_id",
    "statement_offset",
    "char_offset",
    "char_length",
    "content_hash",
];

// BM25与dense两路独立检索：BM25走chinese分析器保留否定/顺序/例外，dense走嵌入
// 语义；两路都带可比较原始分数与同形状输出字段。
fn knowledge_output() -> Value {
    json!(KNOWLEDGE_OUTPUT)
}

// 05切片3：单通道分片游标。位置按该片实际消费的原始record行数前进（与其他片
// 重复的身份也占该片扫描位置，但候选按唯一身份只计一次）；轮次由组合层按可
// 交付候选驱动，通道层不再自判扩轮。
pub struct ShardCursor {
    pub filter: String,
    pub consumed: usize,
    pub failed: bool,
    // 成功空/成功未满页/成功满页/失败/未执行在位事实：穷尽只由"成功且返回数<
    // 请求额度"证明；失败片后续轮不再请求、不计completed。
    pub full_page: bool,
    pub requested: bool,
    pub succeeded: bool,
    // 同一owner轮内，临时预留不足后只补尚未派发的分片。
    pub dispatched_round: usize,
    pub in_flight: bool,
}
pub struct ChannelCursor {
    pub shards: Vec<ShardCursor>,
    pub hits: Vec<Value>,
    pub rounds: usize,
    pub failed: bool,
    pub stopped: Option<&'static str>,
    last_full_page: bool,
}

impl ChannelCursor {
    fn new(filters: Vec<String>) -> Self {
        Self {
            shards: filters
                .into_iter()
                .map(|filter| ShardCursor {
                    filter,
                    consumed: 0,
                    failed: false,
                    full_page: false,
                    requested: false,
                    succeeded: false,
                    dispatched_round: 0,
                    in_flight: false,
                })
                .collect(),
            hits: Vec::new(),
            rounds: 0,
            failed: false,
            stopped: None,
            last_full_page: false,
        }
    }
    // 通道见底：已执行过、无失败片、无停轮原因且末轮无满页片——只有成功未满页
    // 可证明穷尽；任一片满页说明该片段内可能还有更多record。
    pub fn drained(&self) -> bool {
        !self.failed
            && self.rounds > 0
            && self.stopped.is_none()
            && !self.last_full_page
            && self
                .shards
                .iter()
                .all(|shard| shard.requested && !shard.in_flight && !shard.full_page)
    }
    pub fn progress(&self) -> ChannelProgress {
        let completed = self.shards.iter().filter(|shard| shard.succeeded).count();
        ChannelProgress {
            rounds: self.rounds,
            shards: self.shards.len(),
            completed,
            // 空允许集：范围内无可召回记录，按已覆盖穷举（不发全库查询）。
            exhausted: self.shards.is_empty() || self.drained(),
            uncovered: if self.shards.is_empty() {
                None
            } else {
                self.stopped.or(if self.last_full_page {
                    Some("candidate_limit")
                } else {
                    None
                })
            },
        }
    }
    // 该通道是否还能推进：有分片、未失败、未停轮、未穷尽且仍有可请求分片。
    pub fn advanceable(&self) -> bool {
        !self.shards.is_empty()
            && self.stopped.is_none()
            && !self.drained()
            && self
                .shards
                .iter()
                .any(|shard| !shard.failed && (!shard.requested || shard.full_page))
    }
}

// 各通道分片游标集合（05切片3）：advanceable()是组合层推进循环的条件——任一
// 通道仍可按原位置再取一批原始record。
pub struct SearchCursors {
    pub lexical: Option<ChannelCursor>,
    pub dense: Option<ChannelCursor>,
    pub raw_lexical: Option<ChannelCursor>,
    pub raw_dense: Option<ChannelCursor>,
}
// 一次有界检索的请求事实：空间、查询表示、硬范围与来源允许集、交付限额、
// 是否执行原文通道，以及本次调用的共享绝对期限。
pub struct ScopedQuery<'a> {
    pub space: &'a str,
    pub query: &'a str,
    pub vector: Option<Vec<f32>>,
    pub scope: &'a crate::search_scope::KnowledgeSearchScope,
    pub limit: usize,
    pub allowed: Option<&'a AllowedRecords>,
    pub include_raw: bool,
    pub deadline: tokio::time::Instant,
}

// 协议检查入口只取一个深度；业务扩深与正文选择统一由knowledge用例驱动。
pub async fn search_scoped(request: ScopedQuery<'_>) -> Candidates {
    let mut candidates = prepare_cursors(
        request.space,
        request.scope,
        request.allowed,
        request.include_raw,
        request.deadline,
    );
    candidates.dense_vector = request.vector;
    if !enabled() {
        return candidates;
    }
    candidates.target = match call_at_deadline(request.deadline, index_target()).await {
        Ok(Ok(target)) => Some(target),
        _ => {
            candidates.lexical_state = "unavailable";
            candidates.dense_state = "unavailable";
            candidates.bounded = true;
            candidates.fail_channels();
            return candidates;
        }
    };
    if candidates.dense_vector.is_none() {
        candidates.mark_embedding_unavailable();
    }
    for channel in [
        ScanChannel::Lexical,
        ScanChannel::Dense,
        ScanChannel::RawLexical,
        ScanChannel::RawDense,
    ] {
        while let Some(page) = candidates.next_page(channel, request.query, 1, request.limit) {
            candidates.accept_page(fetch_page(page).await);
        }
    }
    candidates.refresh_progress();
    candidates.bounded |= request.query.chars().count() > 1600;
    candidates
}

// 页请求拥有自己的输入，异步期间不借用整个候选集；组合层吸收已就绪结果。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScanChannel {
    Lexical,
    Dense,
    RawLexical,
    RawDense,
}
impl ScanChannel {
    pub fn raw(self) -> bool {
        matches!(self, Self::RawLexical | Self::RawDense)
    }
    fn dense(self) -> bool {
        matches!(self, Self::Dense | Self::RawDense)
    }
}

pub struct PageRequest {
    pub channel: ScanChannel,
    pub shard: usize,
    pub round: usize,
    pub offset: usize,
    pub reserved: usize,
    filter: String,
    query: String,
    vector: Option<Vec<f32>>,
    deadline: tokio::time::Instant,
}
pub struct CandidatePage {
    pub request: PageRequest,
    count: usize,
    rows: Vec<Value>,
    failed: bool,
}

pub async fn fetch_page(request: PageRequest) -> CandidatePage {
    let outcome = async {
        let milvus = Milvus::configured()?;
        let output = if request.channel.raw() {
            json!([
                "id",
                "object_id",
                "object_version",
                "char_offset",
                "char_length",
                "content_hash",
                "source_kind",
                "segmentation_version"
            ])
        } else {
            knowledge_output()
        };
        if request.channel.dense() {
            run_dense(
                &milvus,
                &request.filter,
                &output,
                request.vector.as_deref().expect("dense query"),
                request.reserved,
                request.offset,
                request.deadline,
            )
            .await
        } else {
            run_lexical(
                &milvus,
                &request.filter,
                &output,
                &request.query,
                request.reserved,
                request.offset,
                request.deadline,
            )
            .await
        }
    }
    .await;
    let (count, rows, failed) = absorb_batch(
        outcome,
        if request.channel.raw() {
            excerpt_rows
        } else {
            aggregate_hits
        },
    );
    CandidatePage {
        request,
        count,
        rows,
        failed,
    }
}

pub fn prepare_cursors(
    space: &str,
    scope: &crate::search_scope::KnowledgeSearchScope,
    allowed: Option<&AllowedRecords>,
    include_raw: bool,
    deadline: tokio::time::Instant,
) -> Candidates {
    let mut candidates = Candidates::lexical();
    candidates.deadline = deadline;
    candidates.space = Some(space.to_owned());
    if !enabled() {
        return candidates;
    }
    let mut base = knowledge_base_filter(space, scope);
    // 独立文档正文走raw；同步派生文档没有独立raw索引，保留其知识窗口。
    if !include_raw {
        base.push_str(" && (kind != \"document\" || statement_id == \"\")");
    }
    let filters = knowledge_shards(base, allowed, include_raw);
    candidates.cursors.lexical = Some(ChannelCursor::new(filters.clone()));
    candidates.cursors.dense = Some(ChannelCursor::new(filters));
    if include_raw {
        let base = format!(
            "space_id == {} && model == {} && kind == \"source_excerpt\" && segmentation_version == {}",
            json!(space),
            json!(embedding::SPEC.version),
            json!(super::source_segments::SEGMENTATION_VERSION)
        );
        let filters = match allowed {
            None => vec![base],
            Some(records) => {
                let mut filters = Vec::new();
                for kind in ["document", "platform"] {
                    let ids = records
                        .sources
                        .iter()
                        .filter(|(k, _)| k == kind)
                        .map(|(_, id)| id)
                        .collect::<Vec<_>>();
                    for chunk in ids.chunks(ALLOWED_SHARD) {
                        filters.push(format!(
                            "{base} && source_kind == {kind:?} && object_id in {}",
                            json!(chunk)
                        ));
                    }
                }
                filters
            }
        };
        candidates.cursors.raw_lexical = Some(ChannelCursor::new(filters.clone()));
        candidates.cursors.raw_dense = Some(ChannelCursor::new(filters));
    }
    candidates.lexical_state = "pending";
    candidates.dense_state = "pending";
    candidates.state = "unavailable";
    candidates
}

/// 游标绑定的索引事实；调用方仍须绑定查询、任务条件和当前授权范围。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IndexFacts {
    pub target: Option<String>,
    pub projection: String,
    pub segmentation: String,
}

/// 只含扫描位置和范围指纹；不保存 filter、允许记录清单或查询向量。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScanSnapshot {
    #[serde(rename = "i")]
    pub facts: IndexFacts,
    #[serde(rename = "c")]
    channels: [Option<ChannelBookmark>; 4],
}
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct ChannelBookmark {
    #[serde(rename = "b")]
    binding: String,
    // consumed 与 requested/succeeded/failed/full_page 位图。
    #[serde(rename = "s")]
    shards: Vec<(usize, u8)>,
}
impl ScanSnapshot {
    pub fn has_more(&self) -> bool {
        self.channels.iter().flatten().any(|channel| {
            channel
                .shards
                .iter()
                .any(|(_, flags)| flags & 4 == 0 && (flags & 1 == 0 || flags & 8 != 0))
        })
    }
    pub fn validate(&self) -> Result<()> {
        if self.facts.projection != crate::types::KNOWLEDGE_PROJECTION
            || self.facts.segmentation != super::source_segments::SEGMENTATION_VERSION
        {
            return Err(Error::new("stale_cursor"));
        }
        if self.channels.iter().flatten().any(|channel| {
            channel.shards.len() > CANDIDATE_CEILING
                || channel.binding.len() != 64
                || !channel.binding.bytes().all(|byte| byte.is_ascii_hexdigit())
                || channel.shards.iter().any(|(consumed, flags)| {
                    *flags > 15
                        || (*consumed > 0 && flags & 1 == 0)
                        || (flags & 2 != 0 && flags & 1 == 0)
                        || (flags & 8 != 0 && (flags & 2 == 0 || flags & 4 != 0))
                })
        }) {
            return Err(Error::new("invalid_cursor"));
        }
        Ok(())
    }
}
impl Candidates {
    pub fn snapshot_scan(&self) -> Result<ScanSnapshot> {
        let mut channels = [None, None, None, None];
        for (index, channel) in [
            ScanChannel::Lexical,
            ScanChannel::Dense,
            ScanChannel::RawLexical,
            ScanChannel::RawDense,
        ]
        .into_iter()
        .enumerate()
        {
            if let Some(cursor) = self.cursors.cursor(channel) {
                if cursor.shards.iter().any(|shard| shard.in_flight) {
                    return Err(Error::new("invalid_cursor"));
                }
                channels[index] = Some(ChannelBookmark {
                    binding: fingerprint(&json!(
                        cursor
                            .shards
                            .iter()
                            .map(|shard| &shard.filter)
                            .collect::<Vec<_>>()
                    )),
                    shards: cursor
                        .shards
                        .iter()
                        .map(|shard| {
                            (
                                shard.consumed,
                                u8::from(shard.requested)
                                    | (u8::from(shard.succeeded) << 1)
                                    | (u8::from(shard.failed) << 2)
                                    | (u8::from(shard.full_page) << 3),
                            )
                        })
                        .collect(),
                });
            }
        }
        let snapshot = ScanSnapshot {
            facts: IndexFacts {
                target: self.target.clone(),
                projection: crate::types::KNOWLEDGE_PROJECTION.into(),
                segmentation: super::source_segments::SEGMENTATION_VERSION.into(),
            },
            channels,
        };
        snapshot.validate()?;
        Ok(snapshot)
    }

    /// 接收边界已核验的 bookmark，核对本次范围；不建立预算、不重置期限。
    pub fn restore_scan(&mut self, snapshot: &ScanSnapshot) -> Result<()> {
        for (index, channel) in [
            ScanChannel::Lexical,
            ScanChannel::Dense,
            ScanChannel::RawLexical,
            ScanChannel::RawDense,
        ]
        .into_iter()
        .enumerate()
        {
            match (self.cursors.cursor_mut(channel), &snapshot.channels[index]) {
                (Some(cursor), Some(saved)) => {
                    let binding = fingerprint(&json!(
                        cursor
                            .shards
                            .iter()
                            .map(|shard| &shard.filter)
                            .collect::<Vec<_>>()
                    ));
                    if binding != saved.binding || cursor.shards.len() != saved.shards.len() {
                        return Err(Error::new("stale_cursor"));
                    }
                    cursor.rounds =
                        usize::from(saved.shards.iter().any(|(_, flags)| flags & 1 != 0));
                    cursor.failed = false;
                    cursor.stopped = None;
                    for (shard, (consumed, flags)) in cursor.shards.iter_mut().zip(&saved.shards) {
                        shard.consumed = *consumed;
                        shard.requested = flags & 1 != 0;
                        shard.succeeded = flags & 2 != 0;
                        shard.failed = flags & 4 != 0;
                        shard.full_page = flags & 8 != 0;
                        shard.dispatched_round = 0;
                        shard.in_flight = false;
                        cursor.failed |= shard.failed;
                    }
                    cursor.last_full_page = cursor.shards.iter().any(|shard| shard.full_page);
                }
                (None, None) => (),
                _ => return Err(Error::new("stale_cursor")),
            }
        }
        self.target = snapshot.facts.target.clone();
        self.refresh_progress();
        Ok(())
    }
}

impl SearchCursors {
    pub fn cursor(&self, channel: ScanChannel) -> Option<&ChannelCursor> {
        match channel {
            ScanChannel::Lexical => self.lexical.as_ref(),
            ScanChannel::Dense => self.dense.as_ref(),
            ScanChannel::RawLexical => self.raw_lexical.as_ref(),
            ScanChannel::RawDense => self.raw_dense.as_ref(),
        }
    }
    fn cursor_mut(&mut self, channel: ScanChannel) -> Option<&mut ChannelCursor> {
        match channel {
            ScanChannel::Lexical => self.lexical.as_mut(),
            ScanChannel::Dense => self.dense.as_mut(),
            ScanChannel::RawLexical => self.raw_lexical.as_mut(),
            ScanChannel::RawDense => self.raw_dense.as_mut(),
        }
    }
}

impl Candidates {
    // 同通道只保留一个在途页；不同通道独立等待，未派发分片沿当前轮继续。
    pub fn next_page(
        &mut self,
        channel: ScanChannel,
        query: &str,
        round: usize,
        limit: usize,
    ) -> Option<PageRequest> {
        if tokio::time::Instant::now() >= self.deadline
            || round > MAX_ROUNDS
            || (channel.dense() && self.dense_vector.is_none())
        {
            return None;
        }
        let cursor = self.cursors.cursor_mut(channel)?;
        if cursor.stopped.is_some() || cursor.shards.iter().any(|shard| shard.in_flight) {
            return None;
        }
        let (index, shard) = cursor.shards.iter_mut().enumerate().find(|(_, shard)| {
            !shard.failed && (!shard.requested || shard.full_page) && shard.dispatched_round < round
        })?;
        let batch = if round == 1 {
            batch_first(limit)
        } else {
            EXPAND_BATCH
        };
        let granted = self.budget.allocate(round, batch);
        if granted == 0 {
            return None;
        }
        shard.in_flight = true;
        shard.dispatched_round = round;
        cursor.rounds = round;
        Some(PageRequest {
            channel,
            shard: index,
            round,
            offset: shard.consumed,
            reserved: granted,
            filter: shard.filter.clone(),
            query: query.to_owned(),
            vector: self.dense_vector.clone(),
            deadline: self.deadline,
        })
    }

    pub fn accept_page(&mut self, page: CandidatePage) {
        let CandidatePage {
            request,
            count,
            rows,
            failed,
        } = page;
        self.budget.record(
            request.reserved,
            rows.iter().map(|row| {
                if request.channel.raw() {
                    format!(
                        "raw:{}",
                        super::raw_record(row).expect("validated raw location")
                    )
                } else {
                    super::knowledge_record(row).to_owned()
                }
            }),
        );
        let cursor = self
            .cursors
            .cursor_mut(request.channel)
            .expect("dispatched cursor");
        let shard = &mut cursor.shards[request.shard];
        shard.in_flight = false;
        shard.requested = true;
        shard.succeeded |= !failed;
        shard.failed = failed;
        shard.full_page = !failed && count == request.reserved;
        shard.consumed += count;
        cursor.failed |= failed;
        cursor.last_full_page = cursor.shards.iter().any(|shard| shard.full_page);
        if tokio::time::Instant::now() >= self.deadline {
            cursor.stopped = Some("deadline");
        }
        let progress = cursor.progress();
        let state = if cursor.shards.is_empty() || progress.completed > 0 {
            "available"
        } else if cursor.shards.iter().all(|shard| shard.failed) {
            "unavailable"
        } else {
            "pending"
        };
        self.bounded |= failed;
        match request.channel {
            ScanChannel::Lexical => {
                self.lexical =
                    merge_by_score(std::mem::take(&mut self.lexical), rows, object_best_score);
                self.lexical_progress = progress;
                self.lexical_state = state;
            }
            ScanChannel::Dense => {
                self.values =
                    merge_by_score(std::mem::take(&mut self.values), rows, object_best_score);
                self.dense_progress = progress;
                self.dense_state = state;
            }
            ScanChannel::RawLexical => {
                self.raw.lexical =
                    merge_by_score(std::mem::take(&mut self.raw.lexical), rows, row_score);
            }
            ScanChannel::RawDense => {
                self.raw.dense =
                    merge_by_score(std::mem::take(&mut self.raw.dense), rows, row_score);
            }
        }
        self.refresh_progress();
    }

    pub fn refresh_progress(&mut self) {
        if let Some(cursor) = &self.cursors.lexical {
            self.lexical_progress = cursor.progress();
            if cursor.shards.is_empty() || self.lexical_progress.completed > 0 {
                self.lexical_state = "available";
            } else if cursor.shards.iter().all(|shard| shard.failed) {
                self.lexical_state = "unavailable";
            }
        }
        if let Some(cursor) = &self.cursors.dense {
            self.dense_progress = cursor.progress();
            if cursor.shards.is_empty() || self.dense_progress.completed > 0 {
                self.dense_state = "available";
            } else if cursor.shards.iter().all(|shard| shard.failed) {
                self.dense_state = "unavailable";
            }
        }
        if let Some(lexical) = &self.cursors.raw_lexical {
            let dense = self.cursors.raw_dense.as_ref().expect("raw dense cursor");
            let l = lexical.progress();
            let d = dense.progress();
            self.raw_progress = Some(ChannelProgress {
                rounds: l.rounds.max(d.rounds),
                shards: l.shards,
                completed: l.completed.min(d.completed),
                exhausted: l.exhausted && d.exhausted,
                uncovered: l.uncovered.or(d.uncovered),
            });
            let ok = lexical.shards.is_empty() || l.completed > 0 || d.completed > 0;
            self.raw.state = if ok { "available" } else { "unavailable" };
            self.raw.bounded = lexical.failed
                || dense.failed
                || self
                    .raw_progress
                    .as_ref()
                    .is_some_and(|p| p.uncovered.is_some());
        }
        self.state = if self.lexical_state == "available"
            || self.dense_state == "available"
            || (self.cursors.raw_lexical.is_some() && self.raw.state == "available")
        {
            "available"
        } else if self.cursors.lexical.is_none()
            && self.cursors.dense.is_none()
            && self.cursors.raw_lexical.is_none()
            && self.cursors.raw_dense.is_none()
        {
            "unconfigured"
        } else {
            "unavailable"
        };
    }

    pub fn mark_embedding_unavailable(&mut self) {
        for channel in [ScanChannel::Dense, ScanChannel::RawDense] {
            if let Some(cursor) = self.cursors.cursor_mut(channel)
                && !cursor.shards.is_empty()
            {
                cursor.stopped = Some("embedding_unavailable");
            }
        }
        self.dense_state = "unavailable";
        self.bounded = true;
        self.refresh_progress();
    }

    pub fn fail_channels(&mut self) {
        for channel in [
            ScanChannel::Lexical,
            ScanChannel::Dense,
            ScanChannel::RawLexical,
            ScanChannel::RawDense,
        ] {
            if let Some(cursor) = self.cursors.cursor_mut(channel) {
                for shard in &mut cursor.shards {
                    shard.failed = true;
                }
                cursor.failed = !cursor.shards.is_empty();
            }
        }
        self.refresh_progress();
    }

    pub fn stop_scans(&mut self, reason: &'static str) {
        for channel in [
            ScanChannel::Lexical,
            ScanChannel::Dense,
            ScanChannel::RawLexical,
            ScanChannel::RawDense,
        ] {
            if let Some(cursor) = self.cursors.cursor_mut(channel)
                && cursor.advanceable()
            {
                cursor.stopped = Some(reason);
            }
        }
        self.refresh_progress();
    }
}

// 同通道跨允许集分片合并：同版对象保留新增命中位置，同一片段只保留较高分。
// 不同对象版本分别留给回源核验；分数同metric可比，按原始分数降序、同分按id稳定。
fn merge_by_score(
    mut primary: Vec<Value>,
    extra: Vec<Value>,
    score: fn(&Value) -> f64,
) -> Vec<Value> {
    for row in extra {
        if let Some(existing) = primary.iter_mut().find(|value| {
            super::knowledge_record(value) == super::knowledge_record(&row)
                && value["version"] == row["version"]
        }) {
            if let (Some(matches), Some(incoming)) = (
                existing["matches"].as_array_mut(),
                row["matches"].as_array(),
            ) {
                for incoming in incoming {
                    if let Some(found) = matches
                        .iter_mut()
                        .find(|found| found["fragment_id"] == incoming["fragment_id"])
                    {
                        if incoming["score"].as_f64() > found["score"].as_f64() {
                            *found = incoming.clone();
                        }
                    } else {
                        matches.push(incoming.clone());
                    }
                }
            } else if score(&row) > score(existing) {
                *existing = row;
            }
        } else {
            primary.push(row);
        }
    }
    primary.sort_by(|a, b| {
        score(b)
            .total_cmp(&score(a))
            .then_with(|| a["id"].as_str().cmp(&b["id"].as_str()))
    });
    primary
}

// 摘录行携带通道原始分数distance；知识对象聚合取其片段最高分。
fn row_score(row: &Value) -> f64 {
    row["distance"].as_f64().unwrap_or(0.)
}
fn object_best_score(value: &Value) -> f64 {
    value["matches"].as_array().map_or(0., |matches| {
        matches
            .iter()
            .map(|m| m["score"].as_f64().unwrap_or(0.))
            .fold(f64::NEG_INFINITY, f64::max)
    })
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

fn fragments(space: &str, object: &Value) -> (Vec<Value>, bool) {
    if object["state"] != "enabled" {
        return (vec![], false);
    }
    let mut pieces = Vec::new();
    let bounded = false;
    for entry in object["entries"].as_array().into_iter().flatten() {
        if matches!(entry["path"].as_str(), Some("ddl" | "etl")) {
            continue;
        }
        let layer = if object["kind"] == "document" {
            "suggestion"
        } else if entry["human_override"].is_object() {
            "human_override"
        } else if entry["suggestion"]["value"].is_string() {
            "suggestion"
        } else {
            "source_facts"
        };
        let statements = entry[layer]["statements"].as_array();
        let mut units = Vec::new();
        if let Some(statements) = statements.filter(|items| !items.is_empty()) {
            let mut entry_offset = 0;
            for statement in statements {
                let text = statement["text"].as_str().unwrap_or("");
                let scope = statement["scope_text"].as_str().unwrap_or("");
                let body = if scope.is_empty() {
                    text.to_owned()
                } else {
                    format!("{text}\n{scope}")
                };
                units.push((
                    statement["statement_id"].clone(),
                    entry_offset,
                    body.clone(),
                ));
                entry_offset += body.chars().count() + 2;
            }
        }
        if object["kind"] != "document"
            && !units.is_empty()
            && units
                .iter()
                .map(|(_, _, text)| text.as_str())
                .collect::<Vec<_>>()
                .join("\n\n")
                != entry["effective_value"].as_str().unwrap_or("")
        {
            units.clear();
        }
        if (object["kind"] == "document" || units.is_empty())
            && let Some(text) = entry["effective_value"].as_str()
        {
            units.push((Value::Null, 0, text.to_owned()));
        }
        for (statement_id, entry_offset, text) in units {
            let chars = text.chars().collect::<Vec<_>>();
            for local_offset in (0..chars.len()).step_by(crate::types::KNOWLEDGE_STRIDE) {
                let body = chars
                    .iter()
                    .skip(local_offset)
                    .take(crate::types::KNOWLEDGE_WINDOW)
                    .collect::<String>();
                let offset = if object["kind"] == "document" && !statement_id.is_null() {
                    local_offset
                } else {
                    entry_offset + local_offset
                };
                let text = format!(
                    "{} {} {} {}：{}",
                    object["name"].as_str().unwrap_or(""),
                    object["kind"].as_str().unwrap_or(""),
                    super::query_example_index_text(entry),
                    entry["label"].as_str().unwrap_or(""),
                    body
                );
                let mut location = entry.clone();
                location["statement_id"] = statement_id.clone();
                let key = crate::types::knowledge_record_id(space, object, &location, offset);
                pieces.push(json!({"id":key,"space_id":space,"object_id":object["id"],"object_version":object["version"].as_str().unwrap_or("0").parse::<u64>().unwrap_or(0),"kind":object["kind"],"model":embedding::SPEC.version,"projection_version":crate::types::KNOWLEDGE_PROJECTION,"entry_id":entry["entry_id"],"entry_path":entry["path"],"statement_id":statement_id.as_str().unwrap_or(""),"statement_offset":local_offset,"char_offset":offset,"char_length":body.chars().count(),"content_hash":fingerprint(&json!(body)),"text":text}));
            }
        }
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
        .flat_map(|piece| {
            let location = json!({
                "entry_id":piece["entry_id"],"statement_id":piece["statement_id"],
                "statement_offset":piece["statement_offset"],"offset":piece["char_offset"],
                "length":piece["char_length"],"content_hash":piece["content_hash"]
            });
            let legacy = fingerprint(&json!([
                space,
                object["id"],
                object["version"],
                piece["entry_id"],
                piece["char_offset"],
                embedding::SPEC.version,
            ]));
            [
                (
                    piece["id"].as_str().expect("fragment id").to_owned(),
                    location.clone(),
                ),
                (legacy, location),
            ]
        })
        .collect()
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
        reports.push(json!({"id":object["id"],"version":object["version"],"projection_version":crate::types::KNOWLEDGE_PROJECTION,"state":if bounded{"bounded"}else{"indexed"}}));
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
    let milvus = Milvus::configured()?;
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
            "segmentation_version":super::source_segments::SEGMENTATION_VERSION,
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
        let existing=milvus.call("entities/query",json!({"filter":format!("id in {}",json!(ids)),"outputFields":["id","char_offset","char_length","content_hash","segmentation_version"],"limit":512,"consistencyLevel":"Strong"})).await?;
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
                    [
                        "char_offset",
                        "char_length",
                        "content_hash",
                        "segmentation_version",
                    ]
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

// 原文来源修订升版：删除该来源旧修订的摘录向量。清旧身份与写入一致——
// SourceKey的kind与裸id共同定位，平台与文档同ID不互删，document-调用别名
// 不直接当Milvus的裸object_id。
pub async fn drop_source_excerpts(
    space: &str,
    source_kind: &str,
    source: &str,
    before: u64,
) -> Result<()> {
    let milvus = Milvus::configured()?;
    milvus
        .call(
            "entities/delete",
            json!({"filter":format!(
                "space_id == {} && model == {} && target == \"source_excerpt\" && source_kind == {} && object_id == {} && object_version < {}",
                json!(space), json!(embedding::SPEC.version), json!(source_kind), json!(source), before
            )}),
        )
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn continuation_scan_restores_offsets_without_filter_or_budget_reset() {
        let mut original = Candidates::lexical();
        original.target = Some("synthetic-target".into());
        original.cursors.lexical = Some(ChannelCursor::new(vec!["private-filter".into()]));
        let page = original
            .next_page(ScanChannel::Lexical, "合成问题", 1, 1)
            .unwrap();
        original.accept_page(CandidatePage {
            count: page.reserved,
            request: page,
            rows: vec![],
            failed: false,
        });
        let snapshot = original.snapshot_scan().unwrap();
        let encoded = serde_json::to_string(&snapshot).unwrap();
        assert!(!encoded.contains("private-filter"));
        let mut resumed = Candidates::lexical();
        resumed.cursors.lexical = Some(ChannelCursor::new(vec!["private-filter".into()]));
        let deadline = resumed.deadline;
        assert_eq!(resumed.budget.allocate(1, 950), 950);
        resumed
            .budget
            .restore_candidates(["restored".to_owned()].into_iter())
            .unwrap();
        resumed.restore_scan(&snapshot).unwrap();
        let page = resumed
            .next_page(ScanChannel::Lexical, "合成问题", 1, 1)
            .unwrap();
        assert_eq!(page.offset, 50);
        assert_eq!(page.reserved, 49, "恢复候选与在途预留共用1000额度");
        assert_eq!(resumed.deadline, deadline, "内部恢复不能续期");
        assert_eq!(resumed.budget.count(), 1);
    }

    #[test]
    fn continuation_scan_rejects_live_pages_and_changed_current_scope() {
        let mut original = Candidates::lexical();
        original.cursors.lexical = Some(ChannelCursor::new(vec!["original-scope".into()]));
        let page = original
            .next_page(ScanChannel::Lexical, "合成问题", 1, 1)
            .unwrap();
        assert_eq!(original.snapshot_scan().unwrap_err().code, "invalid_cursor");
        original.accept_page(CandidatePage {
            request: page,
            count: 0,
            rows: vec![],
            failed: false,
        });
        let snapshot = original.snapshot_scan().unwrap();
        let mut changed = Candidates::lexical();
        changed.cursors.lexical = Some(ChannelCursor::new(vec!["changed-scope".into()]));
        assert_eq!(
            changed.restore_scan(&snapshot).unwrap_err().code,
            "stale_cursor"
        );
    }

    #[test]
    fn restored_candidates_cannot_spend_reserved_capacity_or_an_extra_depth() {
        let mut budget = CandidateBudget::default();
        assert_eq!(budget.allocate(1, 999), 999);
        budget
            .restore_candidates(["restored".into()].into_iter())
            .unwrap();
        assert_eq!(
            budget
                .restore_candidates(["overflow".into()].into_iter())
                .unwrap_err()
                .code,
            "tool_response_capacity"
        );
        assert_eq!(budget.count(), 1, "失败不部分修改账本");
        budget.record(999, std::iter::empty());
        assert_eq!(budget.allocate(5, 999), 999);
        assert_eq!(budget.allocate(6, 1), 0);
        assert_eq!(budget.rounds(), 5);
    }

    #[test]
    fn channel_failures_isolate_and_report_partial_availability() {
        for (knowledge, raw, expected) in [
            (Some(true), Some(true), ("available", false)),
            (Some(true), Some(false), ("available", true)),
            (Some(false), Some(true), ("available", true)),
            (Some(false), Some(false), ("unavailable", true)),
            (Some(false), None, ("unavailable", true)),
            (None, Some(false), ("unavailable", true)),
            (None, None, ("available", false)),
        ] {
            let mut candidates = Candidates::lexical();
            if knowledge.is_some() || raw.is_none() {
                let filters = if knowledge.is_some() {
                    vec!["synthetic".to_owned()]
                } else {
                    vec![]
                };
                candidates.cursors.lexical = Some(ChannelCursor::new(filters));
            }
            if raw.is_some() {
                candidates.cursors.raw_lexical =
                    Some(ChannelCursor::new(vec!["synthetic".to_owned()]));
                candidates.cursors.raw_dense = Some(ChannelCursor::new(vec![]));
            }
            for (channel, available) in [
                (ScanChannel::Lexical, knowledge),
                (ScanChannel::RawLexical, raw),
            ] {
                if let Some(available) = available {
                    let request = candidates.next_page(channel, "范围", 1, 1).unwrap();
                    candidates.accept_page(CandidatePage {
                        request,
                        count: 0,
                        rows: vec![],
                        failed: !available,
                    });
                }
            }
            candidates.refresh_progress();
            assert_eq!((candidates.state, candidates.bounded), expected);
        }
        // 单路批次吸收：失败只记本路，不改写为空成功；解析失败同样只记本路。
        let ok = absorb_batch(
            Ok(
                json!([{"id":"frag-1","object_id":"a","object_version":1,"entry_id":"body",
                "char_offset":0,"char_length":10,"content_hash":"h","distance":1.5}]),
            ),
            aggregate_hits,
        );
        assert_eq!(
            ok,
            (
                1,
                vec![
                    json!({"id":"a","version":"1","record_id":"frag-1","matches":[{"fragment_id":"frag-1",
                    "entry_id":"body","path":null,"offset":0,"length":10,"content_hash":"h","score":1.5}]})
                ],
                false
            )
        );
        for failed in [
            absorb_batch(Err(Error::new("unavailable")), aggregate_hits),
            absorb_batch(Ok(json!({"not":"array"})), aggregate_hits),
        ] {
            assert_eq!(failed, (0, Vec::<Value>::new(), true));
        }
    }

    #[test]
    fn raw_response_requires_explicit_current_representation_and_location() {
        let hit = json!({"id":"raw-fragment","source_kind":"document","object_id":"synthetic-source",
            "object_version":1,"char_offset":12,"char_length":36,"content_hash":"synthetic-hash",
            "segmentation_version":"source-structure-1","distance":0.75});
        let (count, rows, failed) = absorb_batch(Ok(json!([hit])), excerpt_rows);
        assert_eq!(count, 1);
        assert!(!failed);
        assert_eq!(
            super::super::raw_record(&rows[0]).as_deref(),
            Some("document:synthetic-source:1:12:36:source-structure-1")
        );
        for field in [
            "id",
            "source_kind",
            "object_id",
            "object_version",
            "char_offset",
            "char_length",
            "content_hash",
            "segmentation_version",
            "distance",
        ] {
            let mut missing = hit.clone();
            missing.as_object_mut().unwrap().remove(field);
            assert_eq!(
                absorb_batch(Ok(json!([missing])), excerpt_rows),
                (0, vec![], true),
                "缺失{field}须在Milvus响应边界判为该路失败"
            );
        }
        for (field, value) in [
            ("source_kind", json!("unknown")),
            ("object_version", json!("1")),
            ("char_offset", json!(-1)),
            ("char_length", json!(0)),
            ("content_hash", json!(42)),
            ("segmentation_version", json!("source-structure-0")),
            ("distance", json!("0.75")),
        ] {
            let mut invalid = hit.clone();
            invalid[field] = value;
            assert_eq!(
                absorb_batch(Ok(json!([invalid])), excerpt_rows),
                (0, vec![], true),
                "非法{field}须在Milvus响应边界判为该路失败"
            );
        }
    }

    #[tokio::test]
    async fn deadline_cuts_slow_calls_at_one_shared_instant() {
        // 一次调用统一截止：后续批次沿用同一绝对期限的剩余预算，不逐批重置。
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(80);
        let started = std::time::Instant::now();
        assert!(
            call_at_deadline(
                deadline,
                tokio::time::sleep(std::time::Duration::from_secs(2))
            )
            .await
            .is_err()
        );
        assert!(
            call_at_deadline(
                deadline,
                tokio::time::sleep(std::time::Duration::from_secs(2))
            )
            .await
            .is_err()
        );
        assert!(started.elapsed() < std::time::Duration::from_secs(1));
        assert_eq!(
            call_at_deadline(
                tokio::time::Instant::now() + std::time::Duration::from_secs(1),
                async { serde_json::json!({"ok":true}) }
            )
            .await
            .unwrap()["ok"],
            true
        );
    }

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

    #[test]
    fn statement_projection_keeps_original_entry_offsets_and_distinct_identity() {
        let first = "合成背景🌏。".repeat(151);
        let second = "设备停用后不得计入有效设备数。\n仅适用完成复核的设备。";
        let entry = json!({"entry_id":"rules","path":"rules","label":"规则",
            "effective_value":format!("{first}\n\n{second}"),"human_override":null,
            "suggestion":{"value":format!("{first}\n\n{second}"),"statements":[
                {"statement_id":"first","text":first,"scope_text":""},
                {"statement_id":"second","text":"设备停用后不得计入有效设备数。","scope_text":"仅适用完成复核的设备。"}]}});
        let object = json!({"id":"metric","name":"合成资料","version":"1","state":"enabled","kind":"metric","entries":[entry]});
        let (pieces, _) = fragments("demo", &object);
        let selected = pieces
            .iter()
            .find(|piece| piece["statement_id"] == "second")
            .unwrap();
        assert_eq!(selected["char_offset"], first.chars().count() + 2);
        assert_eq!(selected["statement_offset"], 0);
        assert_eq!(selected["char_length"], second.chars().count());
        assert_eq!(selected["content_hash"], fingerprint(&json!(second)));
        let mut locator = object["entries"][0].clone();
        locator["statement_id"] = json!("second");
        assert_eq!(
            selected["id"],
            crate::types::knowledge_record_id("demo", &object, &locator, first.chars().count() + 2)
        );
        let mut modified = object.clone();
        modified["entries"][0]["effective_value"] = json!("人工已替换正文，旧陈述不再有效。");
        let (modified, _) = fragments("demo", &modified);
        assert!(modified.iter().all(|piece| piece["statement_id"] == ""));
        assert!(
            modified
                .iter()
                .all(|piece| piece["text"].as_str().unwrap().contains("人工已替换正文"))
        );
    }

    #[test]
    fn document_statements_keep_local_coordinates_without_replacing_original_text() {
        let object = json!({"id":"document","name":"合成文档","version":"1","state":"enabled","kind":"document",
            "entries":[{"entry_id":"body","path":"body","label":"正文","effective_value":"这是独立保存的原文。",
                "human_override":{"value":"这是独立保存的原文。"},"suggestion":{"statements":[
                    {"statement_id":"derived","text":"整理后的定义。","scope_text":"仅限合成范围。"}]}}]});
        let (pieces, _) = fragments("demo", &object);
        let original = pieces
            .iter()
            .find(|piece| piece["statement_id"] == "")
            .unwrap();
        let derived = pieces
            .iter()
            .find(|piece| piece["statement_id"] == "derived")
            .unwrap();
        assert_eq!(derived["char_offset"], 0);
        assert_eq!(derived["statement_offset"], 0);
        assert_eq!(
            derived["content_hash"],
            fingerprint(&json!("整理后的定义。\n仅限合成范围。"))
        );
        assert!(
            original["text"]
                .as_str()
                .unwrap()
                .contains("这是独立保存的原文。")
        );
        assert_ne!(original["id"], derived["id"]);
    }

    // 允许集分片合并按原始分数全局排序：不同身份子集的命中不能以批次顺序拼接，
    // 同id去重保留首批已收行。
    #[test]
    fn shard_merges_rank_by_raw_score_across_batches() {
        let rows = |pairs: &[(&str, f64)]| {
            pairs
                .iter()
                .map(|(id, distance)| json!({"id":id,"distance":distance}))
                .collect::<Vec<_>>()
        };
        let primary = rows(&[("a", 0.9), ("b", 0.4)]);
        let extra = rows(&[("c", 0.95), ("a", 0.1), ("d", 0.7)]);
        let merged = merge_by_score(primary, extra, row_score);
        assert_eq!(
            merged
                .iter()
                .map(|v| v["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["c", "a", "d", "b"]
        );
        // 知识对象聚合取片段最高分参与排序，不丢片段。
        let object = |id: &str, scores: &[f64]| {
            json!({"id":id,"matches":scores
                .iter()
                .map(|score| json!({"score":score}))
                .collect::<Vec<_>>()})
        };
        let merged_objects = merge_by_score(
            vec![object("k1", &[0.2, 0.5])],
            vec![object("k2", &[0.3, 0.8])],
            object_best_score,
        );
        assert_eq!(
            merged_objects
                .iter()
                .map(|v| v["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["k2", "k1"]
        );
        assert_eq!(merged_objects[0]["matches"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn deeper_results_keep_new_positions_and_the_best_channel_score() {
        let first = json!({"id":"document-a","version":"1","matches":[
            {"fragment_id":"definition","entry_id":"body","offset":0,"length":80,"score":0.5}
        ]});
        let expanded = json!({"id":"document-a","version":"1","matches":[
            {"fragment_id":"definition","entry_id":"body","offset":0,"length":80,"score":0.7},
            {"fragment_id":"exception","entry_id":"body","offset":600,"length":80,"score":0.6}
        ]});
        let second = json!({"id":"document-b","version":"1","matches":[
            {"fragment_id":"other","entry_id":"body","offset":0,"length":80,"score":0.65}
        ]});
        let merged = merge_by_score(vec![first, second], vec![expanded], object_best_score);
        assert_eq!(merged[0]["id"], "document-a", "同通道的新高分参与排序");
        let positions = merged[0]["matches"].as_array().unwrap();
        assert_eq!(positions.len(), 2, "扩深得到的例外片段不能被整行丢弃");
        assert_eq!(positions[0]["score"], 0.7);
        assert_eq!(positions[1]["offset"], 600);
    }

    // 05接续：共享候选预算的账本真值——唯一身份跨通道/跨轮去重、在合并/筛除前
    // 计数、失效不退还；请求前分配永不超过剩余额度；超过最大轮深返回0。
    #[test]
    fn concurrent_candidate_requests_share_remaining_capacity() {
        let mut budget = CandidateBudget::default();
        budget.allocate(1, 900);
        budget.record(900, (0..900).map(|i| format!("entry:{i}")));
        let lexical = budget.allocate(2, 100);
        let dense = budget.allocate(2, 100);
        assert_eq!(lexical + dense, 100, "在途请求不能重复占用剩余名额");
    }

    #[test]
    fn candidate_budget_allocates_before_requests_and_counts_unique_identities() {
        let mut budget = CandidateBudget::default();
        assert_eq!(budget.allocate(1, 200), 200);
        assert_eq!(
            budget.record(200, (0..200).map(|i| format!("entry:{i}"))),
            200
        );
        assert_eq!(budget.allocate(1, 250), 250);
        assert_eq!(
            budget.record(250, (0..250).map(|i| format!("entry:{i}"))),
            50
        );
        assert_eq!(budget.count(), 250);
        assert_eq!(budget.remaining(), 750);
        assert_eq!(budget.allocate(2, 800), 750);
        assert_eq!(budget.allocate(2, 100), 0, "在途请求已占满剩余额度");
        assert_eq!(budget.rounds(), 2);
        assert_eq!(budget.allocate(6, 100), 0);
        // 请求失败或返回重复身份时释放未消费的预留，不退还已收到的记录。
        budget.record(750, std::iter::empty());
        assert_eq!(budget.remaining(), 750);
        assert_eq!(budget.allocate(2, 1), 1);
        assert_eq!(budget.record(1, ["sql:obj-1".to_owned()].into_iter()), 1);
        assert_eq!(budget.count(), 251);
        let mut full = CandidateBudget::default();
        full.allocate(1, CANDIDATE_CEILING);
        full.record(
            CANDIDATE_CEILING,
            (0..CANDIDATE_CEILING).map(|i| format!("excerpt:{i}")),
        );
        assert_eq!(full.remaining(), 0);
        assert_eq!(full.allocate(1, 50), 0);
    }

    // 通道进度真值（05切片3游标版）：末轮满页=可能还有更多（足够本页不表示穷
    // 举）；停轮原因如实保留；空分片范围按已覆盖穷举；末轮未满页即该通道穷举。
    #[test]
    fn channel_progress_separates_exhausted_from_uncovered() {
        // 两片都已请求且末轮未满页：穷举、无未覆盖原因。
        let mut drained = ChannelCursor::new(vec!["a".into(), "b".into()]);
        drained.rounds = 1;
        for shard in &mut drained.shards {
            shard.requested = true;
            shard.succeeded = true;
        }
        let progress = drained.progress();
        assert!(progress.exhausted && progress.uncovered.is_none());
        assert_eq!(progress.completed, 2);
        // 末轮任一片满页：可能还有更多，未覆盖原因为candidate_limit。
        let mut full = ChannelCursor::new(vec!["a".into(), "b".into()]);
        full.rounds = 1;
        for shard in &mut full.shards {
            shard.requested = true;
            shard.succeeded = true;
        }
        full.shards[0].full_page = true;
        full.last_full_page = true;
        let progress = full.progress();
        assert!(!progress.exhausted);
        assert_eq!(progress.uncovered, Some("candidate_limit"));
        // 停轮原因如实保留（额度到界）。
        let mut stopped = ChannelCursor::new(vec!["a".into(), "b".into()]);
        stopped.rounds = 2;
        for shard in &mut stopped.shards {
            shard.requested = true;
            shard.succeeded = true;
        }
        stopped.stopped = Some("candidate_limit");
        let progress = stopped.progress();
        assert!(!progress.exhausted);
        assert_eq!(progress.uncovered, Some("candidate_limit"));
        // 期限停止保留deadline原因。
        let mut deadline_hit = ChannelCursor::new(vec!["a".into()]);
        deadline_hit.rounds = 1;
        deadline_hit.shards[0].requested = true;
        deadline_hit.stopped = Some("deadline");
        assert_eq!(deadline_hit.progress().uncovered, Some("deadline"));
        // 空允许集：范围内无可召回记录，按已覆盖穷举。
        let empty = ChannelCursor::new(Vec::new());
        assert!(empty.progress().exhausted && empty.progress().uncovered.is_none());
    }

    #[tokio::test]
    async fn failed_shard_is_not_completed_or_exhausted() {
        // 连接拒绝是实际边界故障，不用空成功结果代替失败。
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        let milvus = Milvus {
            url: reqwest::Url::parse(&format!("http://{address}")).unwrap(),
            client: reqwest::Client::builder().no_proxy().build().unwrap(),
            collection: "synthetic_failed_shard".into(),
            token: "synthetic-only".into(),
        };
        let mut candidates = Candidates::lexical();
        candidates.cursors.lexical = Some(ChannelCursor::new(vec!["space_id == \"demo\"".into()]));
        let request = candidates
            .next_page(ScanChannel::Lexical, "语音定义", 1, 10)
            .unwrap();
        let result = run_lexical(
            &milvus,
            &request.filter,
            &knowledge_output(),
            &request.query,
            request.reserved,
            request.offset,
            request.deadline,
        )
        .await;
        let (count, rows, failed) = absorb_batch(result, aggregate_hits);
        candidates.accept_page(CandidatePage {
            request,
            count,
            rows,
            failed,
        });
        let cursor = candidates.cursors.lexical.as_ref().unwrap();
        assert!(cursor.failed);
        assert_eq!(cursor.progress().completed, 0, "失败分片没有完成检索");
        assert!(!cursor.drained(), "请求失败不能说明该通道已见底");
        assert!(!cursor.progress().exhausted, "失败不能成为穷举证据");
    }

    // 合同“有效候选不足才扩大”的反向：通道返回数未达额度即该深度已见底，
    // 不得为凑轮数重复发同一批请求（05切片3起以游标事实判定）。
    #[test]
    fn drained_rounds_stop_expansion_instead_of_repeating_requests() {
        let mut drained = ChannelCursor::new(vec!["base".into()]);
        drained.rounds = 1;
        drained.shards[0].requested = true;
        assert!(drained.drained(), "未满页的分片执行即通道见底");
        assert!(!drained.advanceable());
        // 未执行任何分片（空允许集/期限已过）不构成见底，避免把未尝试当成已穷举。
        let mut skipped = ChannelCursor::new(vec!["base".into()]);
        skipped.stopped = Some("deadline");
        assert!(!skipped.drained());
        assert!(!skipped.advanceable());
        // 满页说明可能还有更多，仍值得扩轮（offset位置前进，不重复请求）。
        let mut full = ChannelCursor::new(vec!["base".into()]);
        full.rounds = 1;
        full.shards[0].requested = true;
        full.shards[0].full_page = true;
        full.last_full_page = true;
        assert!(!full.drained());
        assert!(full.advanceable());
        // 失败片不再重试，也不计入completed。
        let mut failed = ChannelCursor::new(vec!["base".into()]);
        failed.rounds = 1;
        failed.shards[0].requested = true;
        failed.shards[0].failed = true;
        failed.failed = true;
        assert!(!failed.advanceable());
        assert_eq!(failed.progress().completed, 0);
    }
}
