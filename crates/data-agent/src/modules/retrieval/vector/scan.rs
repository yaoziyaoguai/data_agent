use super::cursors::{ChannelCursor, SearchCursors};
use super::{
    Milvus, SEARCH_DEADLINE, absorb_batch, aggregate_hits, call_at_deadline, embedding, enabled,
    excerpt_rows, index_target, run_dense, run_lexical,
};
use crate::types::{Error, Result};
use serde_json::{Value, json};

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

    pub fn channels(&self) -> super::super::Channels<'_> {
        super::super::Channels {
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

impl AllowedRecords {
    pub fn allows_knowledge(&self, id: &str) -> bool {
        self.knowledge_ids.iter().any(|allowed| allowed == id)
    }

    pub fn allows_source(&self, kind: &str, id: &str) -> bool {
        self.sources.iter().any(|(k, key)| k == kind && key == id)
    }
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
pub(super) const CANDIDATE_CEILING: usize = 1000;
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
fn knowledge_shards(milvus_base: String, allowed: Option<&AllowedRecords>) -> Vec<String> {
    match allowed {
        None => vec![milvus_base],
        Some(records) => records
            .knowledge_ids
            .chunks(ALLOWED_SHARD)
            .map(|chunk| format!("{milvus_base} && object_id in {}", json!(chunk)))
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
pub(super) fn knowledge_output() -> Value {
    json!(KNOWLEDGE_OUTPUT)
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
            candidates.accept_page(fetch_page(page).await, request.allowed);
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
    pub(super) filter: String,
    pub(super) query: String,
    vector: Option<Vec<f32>>,
    pub(super) deadline: tokio::time::Instant,
}
pub struct CandidatePage {
    pub request: PageRequest,
    pub(super) count: usize,
    pub(super) rows: Vec<Value>,
    pub(super) failed: bool,
}

pub async fn fetch_page(request: PageRequest) -> CandidatePage {
    let outcome = async {
        let milvus = Milvus::shared()?;
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
                milvus,
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
                milvus,
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
    if !include_raw {
        base.push_str(" && (kind != \"document\" || statement_id == \"\")");
    }
    let filters = knowledge_shards(base, allowed);
    candidates.cursors.lexical = Some(ChannelCursor::new(filters.clone()));
    candidates.cursors.dense = Some(ChannelCursor::new(filters));
    if include_raw {
        let base = format!(
            "space_id == {} && model == {} && kind == \"source_excerpt\" && source_kind == \"platform\" && segmentation_version == {}",
            json!(space),
            json!(embedding::SPEC.version),
            json!(super::super::source_segments::SEGMENTATION_VERSION)
        );
        let filters = match allowed {
            None => vec![base],
            Some(records) => {
                let ids = records
                    .sources
                    .iter()
                    .filter(|(kind, _)| kind == "platform")
                    .map(|(_, id)| id)
                    .collect::<Vec<_>>();
                ids.chunks(ALLOWED_SHARD)
                    .map(|chunk| format!("{base} && object_id in {}", json!(chunk)))
                    .collect()
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

    pub fn accept_page(&mut self, page: CandidatePage, allowed: Option<&AllowedRecords>) {
        let CandidatePage {
            request,
            count,
            mut rows,
            mut failed,
        } = page;
        // 向量过滤决定候选排名范围，宿主在接收外部响应时核同一允许集。
        if let Some(allowed) = allowed
            && rows.iter().any(|row| {
                if request.channel.raw() {
                    !allowed.allows_source(
                        row["source_kind"].as_str().expect("decoded source kind"),
                        row["source_id"].as_str().expect("decoded source id"),
                    )
                } else {
                    !allowed.allows_knowledge(row["id"].as_str().expect("decoded knowledge id"))
                }
            })
        {
            rows.clear();
            failed = true;
        }
        self.budget.record(
            request.reserved,
            rows.iter().map(|row| {
                if request.channel.raw() {
                    format!(
                        "raw:{}",
                        super::super::raw_record(row).expect("validated raw location")
                    )
                } else {
                    super::super::knowledge_record(row).to_owned()
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
pub(super) fn merge_by_score(
    mut primary: Vec<Value>,
    extra: Vec<Value>,
    score: fn(&Value) -> f64,
) -> Vec<Value> {
    for row in extra {
        if let Some(existing) = primary.iter_mut().find(|value| {
            super::super::knowledge_record(value) == super::super::knowledge_record(&row)
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
pub(super) fn row_score(row: &Value) -> f64 {
    row["distance"].as_f64().unwrap_or(0.)
}
pub(super) fn object_best_score(value: &Value) -> f64 {
    value["matches"].as_array().map_or(0., |matches| {
        matches
            .iter()
            .map(|m| m["score"].as_f64().unwrap_or(0.))
            .fold(f64::NEG_INFINITY, f64::max)
    })
}

// 摘录行只带citation身份（source_key种类/来源id/修订/位置/hash）与通道原始
