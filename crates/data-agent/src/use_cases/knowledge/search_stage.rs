use super::*;

#[derive(Default)]
struct SqlCursor {
    pub(super) consumed: usize,
    pub(super) dispatched_round: usize,
    pub(super) in_flight: bool,
    pub(super) succeeded: bool,
    pub(super) exhausted: bool,
    pub(super) hits: Vec<Value>,
}
impl SqlCursor {
    fn accept(
        &mut self,
        budget: &mut retrieval::vector::CandidateBudget,
        reserved: usize,
        result: Result<Option<Vec<Value>>>,
    ) -> Result<bool> {
        self.in_flight = false;
        match result {
            Ok(Some(rows)) => {
                budget.record(
                    reserved,
                    rows.iter()
                        .map(|row| retrieval::knowledge_record(row).to_owned()),
                );
                self.succeeded = true;
                self.consumed += rows.len();
                self.exhausted = rows.len() < reserved;
                self.hits = retrieval::merge_sql_lexical(std::mem::take(&mut self.hits), rows);
                Ok(false)
            }
            Ok(None) => {
                budget.record(reserved, std::iter::empty());
                Ok(true)
            }
            Err(error) => {
                budget.record(reserved, std::iter::empty());
                Err(error)
            }
        }
    }
}
enum SearchEvent {
    Target(Result<String>),
    Page(retrieval::vector::CandidatePage),
    Sql {
        source: usize,
        reserved: usize,
        result: Result<Option<Vec<Value>>>,
    },
}

fn cursor_read_error(error: Error) -> Error {
    if matches!(
        error.code,
        "not_available" | "stale_knowledge" | "stale_source"
    ) {
        Error::new("stale_cursor")
    } else {
        error
    }
}

// 一次调用内的唯一推进：就绪通道、SQL替代词法和owner内容读取共享身份及期限。
#[allow(clippy::too_many_arguments)]
async fn drive_stage(
    pool: &MySqlPool,
    ctx: &AccessContext,
    query: &str,
    limit: usize,
    launch: Option<crate::use_cases::knowledge_embeddings::SearchLaunch>,
    vector: &mut retrieval::vector::Candidates,
    scope: &KnowledgeSearchScope,
    allowed: Option<&retrieval::vector::AllowedRecords>,
    include_raw: bool,
    hints: Option<&crate::contracts::generated::Hints>,
    resume: Option<SearchContinuation>,
) -> Result<(VerdictCache, StageReads)> {
    use retrieval::vector::ScanChannel;
    const CHANNELS: [ScanChannel; 4] = [
        ScanChannel::Lexical,
        ScanChannel::Dense,
        ScanChannel::RawLexical,
        ScanChannel::RawDense,
    ];
    let deadline = vector.deadline;
    // SQL后备同样以当前请求的space重建规范身份，不依赖向量配置或候选附带字段。
    vector.space = Some(ctx.space_id.clone());
    let mut embedding = launch.map(|launch| launch.embedding);
    let mut resume = resume;
    let restored_window = resume.as_ref().is_some_and(SearchContinuation::has_pending);
    let mut setup_error = None;
    let target_expected = resume
        .as_ref()
        .map(|saved| saved.index_facts().target.clone());
    let mut events = tokio::task::JoinSet::new();
    let mut target_ready = !retrieval::vector::enabled();
    if retrieval::vector::enabled() {
        let query_vector = vector.dense_vector.take();
        let budget = std::mem::take(&mut vector.budget);
        *vector = retrieval::vector::prepare_cursors(
            &ctx.space_id,
            scope,
            allowed,
            include_raw,
            deadline,
        );
        vector.budget = budget;
        vector.dense_vector = query_vector;
        if let Some(saved) = &resume
            && let Err(error) = vector.restore_scan(&saved.scan)
        {
            setup_error = Some(error);
        }
        if embedding.is_none() && vector.dense_vector.is_none() {
            vector.mark_embedding_unavailable();
        }
        events.spawn(async move {
            SearchEvent::Target(
                match tokio::time::timeout_at(deadline, retrieval::vector::index_target()).await {
                    Ok(value) => value,
                    Err(_) => Err(Error::new("unavailable")),
                },
            )
        });
    }
    if !retrieval::vector::enabled()
        && let Some(saved) = &resume
        && let Err(error) = vector.restore_scan(&saved.scan)
    {
        setup_error = Some(error);
    }
    if restored_window
        && let Err(error) = resume
            .as_ref()
            .expect("restored window")
            .restore_window(vector)
    {
        setup_error = Some(error);
    }
    let mut sql = [SqlCursor::default(), SqlCursor::default()];
    if let Some(saved) = &resume {
        for (cursor, (consumed, succeeded, exhausted)) in sql.iter_mut().zip(saved.sql) {
            cursor.consumed = consumed;
            cursor.succeeded = succeeded;
            cursor.exhausted = exhausted;
        }
    }
    let mut round = 1usize;
    let terms = retrieval::candidate_terms(query);
    // R12：SQL 24词截断只裁SQL后备候选。是否算覆盖受限取决于SQL是否实际参与
    // 当前候选窗：恢复窗沿用快照sql_active，不因续页未重新发SQL丢状态。
    let mut window_sql_active = resume.as_ref().is_some_and(|saved| saved.sql_active);
    let mut seen_terms = std::collections::HashSet::new();
    let scoring_terms: Vec<_> = retrieval::tokens(query)
        .into_iter()
        .filter(|term| seen_terms.insert(term.clone()))
        .collect();
    let mut cache = VerdictCache::default();
    let mut reads = StageReads::default();
    let mut evaluated = std::collections::HashSet::new();
    let mut embedding_error = None;
    let mut pending_events = std::collections::VecDeque::new();
    let outcome: Result<()> = async {
        if let Some(error) = setup_error { return Err(error); }
        loop {
            if tokio::time::Instant::now() >= deadline {
                reads.deadline_capped = true;
                vector.stop_scans("deadline");
                break;
            }
            // 所有已就绪事件先入共同排名，再分配下一笔主命中读取。
            loop {
                let event = if let Some(event) = pending_events.pop_front() { event }
                    else if let Some(event) = events.try_join_next() {
                        event.map_err(|error| Error::new("unavailable").with_message(format!("search task: {error}")))?
                    } else { break; };
                match event {
                    SearchEvent::Target(result) => {
                        target_ready = true;
                        match result {
                            Ok(target) => {
                                if resume.as_ref().is_some_and(|saved| saved.index_facts().target.as_ref() != Some(&target)) {
                                    return Err(Error::new("stale_cursor"));
                                }
                                vector.target = Some(target);
                            },
                            Err(error) => {
                                if resume.is_some() { return Err(error); }
                                vector.lexical_state = "unavailable";
                                vector.dense_state = "unavailable";
                                vector.bounded = true;
                                vector.fail_channels();
                            }
                        }
                    }
                    SearchEvent::Page(page) => vector.accept_page(page),
                    SearchEvent::Sql { source, reserved, result } => {
                        reads.deadline_capped |= sql[source].accept(&mut vector.budget, reserved, result)?;
                    }
                }
            }
            if embedding.as_ref().is_some_and(|handle| handle.is_finished()) {
                let result = embedding.take().expect("ready embedding").await
                    .map_err(|error| Error::new("unavailable").with_message(format!("embedding task: {error}")))?;
                match result {
                    Ok(query_vector) => {
                        vector.dense_vector = query_vector;
                        if vector.dense_vector.is_none() {
                            vector.mark_embedding_unavailable();
                        }
                    }
                    Err(error) => { embedding_error = Some(error); break; }
                }
            }
            // 只有整条BM25明确失败才替代词法；成功空、成功页及尚未执行的分片都阻止SQL加票。
            let sql_active = if restored_window { resume.as_ref().expect("restored window").sql_active }
                else { vector.sql_lexical_active() };
            window_sql_active |= sql_active;
            // 先让本轮各路开始，之后可在其I/O期间核验已收内容；临时零预留不封死游标。
            if target_ready && !restored_window {
                for channel in CHANNELS {
                    if let Some(page) = vector.next_page(channel, query, round, limit) {
                        events.spawn(async move { SearchEvent::Page(retrieval::vector::fetch_page(page).await) });
                    }
                }
                if sql_active {
                    for (source, cursor) in sql.iter_mut().enumerate() {
                        if cursor.exhausted || cursor.in_flight || cursor.dispatched_round >= round { continue; }
                        let wanted = if cursor.dispatched_round == 0 { 50usize.max(5 * limit).min(200) } else { 200 };
                        let reserved = vector.budget.allocate(round, wanted);
                        if reserved == 0 { continue; }
                        cursor.in_flight = true;
                        cursor.dispatched_round = round;
                        let consumed = cursor.consumed;
                        let pool = pool.clone();
                        let ctx = ctx.clone();
                        let scope = scope.clone();
                        let allowed = allowed.cloned();
                        let terms = terms.values.clone();
                        let scoring_terms = scoring_terms.clone();
                        let query = query.to_owned();
                        // 仅有原文通道时才用其替代未整理文档；纯词法仍须保留可补读的正文候选。
                        let raw_projection = include_raw && retrieval::vector::enabled();
                        events.spawn(async move {
                            let result = tokio::time::timeout_at(deadline, async {
                                let mut tx = AppTx::begin(&pool).await?;
                                let allowed = allowed.as_ref().map(|records| records.knowledge_ids.as_slice());
                                let rows = if source == 0 {
                                    knowledge::matching_content_in_tx(&mut tx, &ctx, &query, &terms, &scoring_terms, &scope, allowed, reserved, consumed, raw_projection).await?
                                } else {
                                    retrieval::content_candidates_scoped_in_tx(&mut tx, &ctx.space_id, &query, &terms, &scoring_terms, &scope, allowed, reserved, consumed, raw_projection).await?
                                };
                                tx.commit().await?;
                                Ok::<_, Error>(rows)
                            }).await;
                            SearchEvent::Sql { source, reserved, result: match result {
                                Ok(result) => result.map(Some), Err(_) => Ok(None),
                            }}
                        });
                    }
                }
            }
            if !target_ready && restored_window {
                if let Some(event) = events.join_next().await { pending_events.push_back(event.map_err(|error| Error::new("unavailable").with_message(format!("search task: {error}")))?); }
                continue;
            }
            let lexical = if restored_window && sql_active { resume.as_ref().expect("restored window").rows(4) }
                else if sql_active { retrieval::merge_sql_lexical(sql[0].hits.clone(), sql[1].hits.clone()) }
                else { vector.lexical.clone() };
            let mut enough = false;
            let ordered = ordered_candidates_with(&lexical, vector);
            if !ordered.is_empty() || (include_raw && (!vector.raw.lexical.is_empty() || !vector.raw.dense.is_empty())) {
                let mut tx = match tokio::time::timeout_at(deadline, AppTx::begin(pool)).await {
                    Ok(tx) => tx?, Err(_) => { reads.deadline_capped = true; break; }
                };
                let ranked = match tokio::time::timeout_at(deadline,
                    ranked_candidates_in_tx(&mut tx, ctx, &ordered, scope, hints, &mut cache)).await {
                    Ok(ranked) => ranked?, Err(_) => { reads.deadline_capped = true; break; }
                };
                if restored_window {
                    let checked = tokio::time::timeout_at(deadline, async {
                    let saved = resume.as_ref().expect("restored window");
                    // 先重核整批未交付引用；不存在/换版不能当作普通失效候选静默舍弃。
                    saved.assert_pending_knowledge(&ranked)?;
                    for record in &saved.records {
                        if saved.suppresses(&record.key()) { continue; }
                        if let SavedCandidate::Raw(kind, id, revision, ..) = record {
                            let source = if kind == "document" { format!("document-{id}") } else { id.clone() };
                            let meta = crate::use_cases::knowledge_sources::read_meta_in_tx(&mut tx, ctx, &source, None).await
                                .map_err(cursor_read_error)?;
                            if meta["version"].as_str() != Some(revision.to_string().as_str()) {
                                return Err(Error::new("stale_cursor"));
                            }
                        }
                    }
                    Ok::<_, Error>(())
                    }).await;
                    match checked {
                        Ok(result) => result?,
                        Err(_) => { reads.deadline_capped = true; break; }
                    }
                }
                reads.ranked = ranked.clone();
                let channels = retrieval::Channels::all(&lexical, &vector.values, &vector.raw.lexical, &vector.raw.dense);
                let mut rank = if restored_window { resume.as_ref().expect("restored window").rank_window(query, ranked) }
                    else { retrieval::rank_common(query, ranked, &channels, 1000, include_raw) };
                reads.exact_checked = true;
                if let Some(hints) = hints {
                    // 原文文档沿同一owner窄元信息匹配；不为软排序读取正文或收窄允许集。
                    let mut documents: Vec<String> = rank.raw.iter()
                        .filter(|candidate| candidate["source_kind"] == "document")
                        .filter_map(|candidate| candidate["source_id"].as_str())
                        .filter(|id| !cache.meta.contains_key(*id))
                        .map(str::to_owned).collect();
                    documents.sort(); documents.dedup();
                    for chunk in documents.chunks(50) {
                        let values = match tokio::time::timeout_at(deadline,
                            knowledge::candidate_meta_in_tx(&mut tx, ctx, chunk, Some(hints))).await {
                            Ok(values) => values?,
                            Err(_) => { reads.deadline_capped = true; break; }
                        };
                        for id in chunk { cache.meta.insert(id.clone(), None); }
                        for value in values {
                            cache.meta.insert(value["id"].as_str().unwrap_or_default().to_owned(), Some(value));
                        }
                    }
                    if reads.deadline_capped { break; }
                    let mut matches = rank.objects.iter().map(|candidate| {
                        let score = candidate["id"].as_str().and_then(|id| cache.meta.get(id))
                            .and_then(Option::as_ref).and_then(|meta| meta["hint_match"].as_i64()).unwrap_or(0);
                        (format!("k:{}", retrieval::knowledge_record(candidate)), score)
                    }).collect::<std::collections::HashMap<_, _>>();
                    for candidate in &rank.raw {
                        let id = candidate["source_id"].as_str().unwrap_or_default();
                        let score = if candidate["source_kind"] == "document" {
                            cache.meta.get(id).and_then(Option::as_ref)
                                .filter(|meta| meta["version"].as_str().and_then(|value| value.parse::<u64>().ok()) == candidate["revision"].as_u64())
                                .and_then(|meta| meta["hint_match"].as_i64()).unwrap_or(0)
                        } else {
                            i64::from(hints.related_object_ids.as_ref().is_some_and(|ids| ids.iter().any(|value| value == id)))
                        };
                        matches.insert(format!("raw:{}", retrieval::raw_record(candidate).expect("ranked raw identity")), score);
                    }
                    // 精确ID/名称优先级沿原score保留；同级才按提示稳定提升。
                    rank.sequence.sort_by_key(|(score, key)| std::cmp::Reverse((*score >= 100., matches.get(key).copied().unwrap_or(0))));
                }
                reads.sequence = rank.sequence.clone();
                evaluated.extend(ordered.iter().map(|candidate| format!("k:{}", retrieval::knowledge_record(candidate))));
                evaluated.extend(rank.sequence.iter().map(|(_, key)| key.clone()));
                let mut selected = 0usize;
                for (_, key) in &rank.sequence {
                    // I/O期间就绪的新通道先处理；不让慢后页独占整个循环。
                    if let Some(event) = events.try_join_next() {
                        pending_events.push_back(event.map_err(|error| Error::new("unavailable").with_message(format!("search task: {error}")))?);
                        break;
                    }
                    if embedding.as_ref().is_some_and(|handle| handle.is_finished()) { break; }
                    if selected >= limit { enough = true; break; }
                    if reads.objects.contains_key(key) || reads.raw.contains_key(key) { selected += 1; continue; }
                    if reads.failed.contains(key) || reads.spent >= 30 { continue; }
                    if tokio::time::Instant::now() >= deadline { reads.deadline_capped = true; break; }
                    reads.spent += 1;
                    let content = if let Some(record) = key.strip_prefix("k:") {
                        let candidate = rank.objects.iter().find(|value| retrieval::knowledge_record(value) == record).expect("ranked content");
                        tokio::time::timeout_at(deadline, load_selected_in_tx(&mut tx, ctx, candidate, scope, &cache)).await
                    } else {
                        let record = key.strip_prefix("raw:").expect("raw content");
                        let candidate = rank.raw.iter().find(|value| retrieval::raw_record(value).as_deref() == Some(record)).expect("ranked raw content");
                        tokio::time::timeout_at(deadline, async {
                            let reply = crate::use_cases::knowledge_sources::recall_excerpts_in_tx(&mut tx, ctx, None, std::slice::from_ref(candidate)).await?;
                            Ok::<_, Error>(reply["hits"].as_array().and_then(|hits| hits.first()).cloned())
                        }).await
                    };
                    match content {
                        Ok(Err(error)) => return Err(error),
                        Ok(Ok(Some(content))) if tokio::time::Instant::now() < deadline => {
                            if key.starts_with("k:") { reads.objects.insert(key.clone(), content); }
                            else { reads.raw.insert(key.clone(), content); }
                            selected += 1;
                        }
                        Ok(Ok(None)) => {
                            if restored_window { return Err(Error::new("stale_cursor")); }
                            reads.failed.insert(key.clone());
                        }
                        Ok(Ok(Some(_))) | Err(_) => { reads.deadline_capped = true; break; }
                    }
                }
                enough |= selected >= limit;
                tx.commit().await?;
            }
            if reads.deadline_capped { break; }
            if !pending_events.is_empty() || embedding.as_ref().is_some_and(|handle| handle.is_finished()) { continue; }
            if restored_window || enough || reads.spent >= 30 {
                if events.is_empty() && embedding.is_none() { break; }
            } else if events.is_empty() {
                let can_advance = CHANNELS.into_iter().any(|channel| vector.cursors.cursor(channel).is_some_and(|cursor| {
                    cursor.advanceable() && cursor.shards.iter().any(|shard| {
                        !shard.failed && shard.full_page && shard.dispatched_round == round
                    })
                })) || (sql_active && sql.iter().any(|cursor| {
                    !cursor.exhausted && cursor.dispatched_round == round
                }));
                if can_advance && vector.budget.remaining() > 0 && round < 5 {
                    round += 1;
                    continue;
                }
                if embedding.is_none() {
                    if can_advance { vector.stop_scans("candidate_limit"); }
                    break;
                }
            }
            // 等任一事件，不等完整通道/轮。接到的结果回填，下轮先吸收所有就绪结果。
            tokio::select! {
                event = events.join_next(), if !events.is_empty() => {
                    if let Some(event) = event {
                        let event = event.map_err(|error| Error::new("unavailable").with_message(format!("search task: {error}")))?;
                        pending_events.push_back(event);
                    }
                }
                result = async { embedding.as_mut().expect("pending embedding").await }, if embedding.is_some() => {
                    embedding = None;
                    match result.map_err(|error| Error::new("unavailable").with_message(format!("embedding task: {error}")))? {
                        Ok(query_vector) => {
                            vector.dense_vector = query_vector;
                            if vector.dense_vector.is_none() { vector.mark_embedding_unavailable(); }
                        }
                        Err(error) => { embedding_error = Some(error); break; }
                    }
                }
                _ = tokio::time::sleep_until(deadline) => { reads.deadline_capped = true; break; }
            }
        }
        Ok(())
    }.await;
    // 错误与期限出口仍等待已发Embedding的原结算；只读页亦接回释放预留。
    let mut completion_error = None;
    loop {
        let event = if let Some(event) = pending_events.pop_front() {
            Some(Ok(event))
        } else {
            events.join_next().await
        };
        let Some(event) = event else {
            break;
        };
        match event {
            Ok(SearchEvent::Page(page)) => vector.accept_page(page),
            Ok(SearchEvent::Sql {
                source,
                reserved,
                result,
            }) => match sql[source].accept(&mut vector.budget, reserved, result) {
                Ok(deadline_capped) => reads.deadline_capped |= deadline_capped,
                Err(error) => {
                    completion_error.get_or_insert(error);
                }
            },
            Ok(SearchEvent::Target(result)) => match result {
                Ok(target) => {
                    if target_expected
                        .as_ref()
                        .is_some_and(|expected| expected.as_ref() != Some(&target))
                    {
                        completion_error.get_or_insert_with(|| Error::new("stale_cursor"));
                    }
                    vector.target = Some(target);
                }
                Err(error) if target_expected.is_some() => {
                    completion_error.get_or_insert(error);
                }
                Err(_) => (),
            },
            Err(error) => {
                completion_error.get_or_insert_with(|| {
                    Error::new("unavailable").with_message(format!("search task: {error}"))
                });
            }
        }
    }
    let settlement = if let Some(handle) = embedding {
        handle.await.map_err(|error| {
            Error::new("unavailable").with_message(format!("embedding task: {error}"))
        })?
    } else {
        Ok(None)
    };
    settlement?;
    if let Some(error) = completion_error {
        return Err(error);
    }
    if let Some(error) = embedding_error {
        return Err(error);
    }
    outcome?;
    // 快速Embedding失败也可能使bookmark无路可派；不能空成功重传原游标。
    if resume.is_some()
        && reads.objects.is_empty()
        && reads.raw.is_empty()
        && (vector.budget.rounds() == 0 || (restored_window && reads.deadline_capped))
    {
        return Err(Error::new("unavailable"));
    }
    // 元信息跨期或出口才接回的候选只保留定位，后续正常重核前不能当作可交付命中。
    let sql_lexical = retrieval::merge_sql_lexical(sql[0].hits.clone(), sql[1].hits.clone());
    reads.unverified = ordered_candidates_with(&sql_lexical, vector)
        .into_iter()
        .filter(|candidate| {
            let key = format!("k:{}", retrieval::knowledge_record(candidate));
            !evaluated.contains(&key)
                && !resume
                    .as_ref()
                    .is_some_and(|saved| restored_window && saved.suppresses(&key))
        })
        .collect();
    for candidate in vector.raw.lexical.iter().chain(&vector.raw.dense) {
        let key = format!(
            "raw:{}",
            retrieval::raw_record(candidate).expect("validated raw candidate")
        );
        if !resume
            .as_ref()
            .is_some_and(|saved| restored_window && saved.suppresses(&key))
            && evaluated.insert(key)
        {
            reads.unverified.push(candidate.clone());
        }
    }
    if reads.deadline_capped {
        vector.stop_scans("deadline");
    }
    vector.bounded |= reads.deadline_capped || (!terms.complete && window_sql_active);
    vector.refresh_progress();
    if sql.iter().any(|cursor| cursor.dispatched_round > 0) {
        vector.lexical_progress = retrieval::vector::ChannelProgress {
            rounds: sql
                .iter()
                .map(|cursor| cursor.dispatched_round)
                .max()
                .unwrap_or(0),
            shards: sql.len(),
            completed: sql.iter().filter(|cursor| cursor.succeeded).count(),
            exhausted: sql.iter().all(|cursor| cursor.exhausted),
            uncovered: if reads.deadline_capped {
                Some("deadline")
            } else if sql.iter().any(|cursor| !cursor.exhausted) {
                Some("candidate_limit")
            } else {
                None
            },
        };
    }
    let milvus = CHANNELS.into_iter().filter_map(|channel| {
        let cursor = vector.cursors.cursor(channel)?;
        let name = match channel {
            ScanChannel::Lexical => "lexical",
            ScanChannel::Dense => "dense",
            ScanChannel::RawLexical => "raw_lexical",
            ScanChannel::RawDense => "raw_dense",
        };
        Some((name.to_owned(), json!({
            "rounds":cursor.rounds,"stopped":cursor.stopped,
            "shards":cursor.shards.iter().map(|shard| json!({
                "consumed":shard.consumed,"round":shard.dispatched_round,
                "requested":shard.requested,"succeeded":shard.succeeded,
                "failed":shard.failed,"in_flight":shard.in_flight,
                "exhausted":shard.succeeded && !shard.failed && !shard.in_flight && !shard.full_page
            })).collect::<Vec<_>>()
        })))
    }).collect::<serde_json::Map<_, _>>();
    reads.scan_progress = json!({
        "rounds":vector.budget.rounds(),"main_reads":reads.spent,"milvus":milvus,
        "sql":sql.iter().enumerate().map(|(source,cursor)| json!({
            "owner":if source==0{"knowledge"}else{"retrieval"},
            "consumed":cursor.consumed,"round":cursor.dispatched_round,
            "requested":cursor.dispatched_round>0,"succeeded":cursor.succeeded,
            "exhausted":cursor.exhausted,"in_flight":cursor.in_flight
        })).collect::<Vec<_>>()
    });
    if include_raw {
        let mut continuation = if restored_window {
            resume.take().expect("restored window")
        } else {
            SearchContinuation::capture(vector, &[sql[0].hits.clone(), sql[1].hits.clone()], &[])?
        };
        continuation.scan = vector.snapshot_scan()?;
        continuation.sql = std::array::from_fn(|index| {
            (
                sql[index].consumed,
                sql[index].succeeded,
                sql[index].exhausted,
            )
        });
        let mut retired: Vec<_> = reads.failed.iter().cloned().collect();
        // 已判定无效的首次候选可以退休；出口才接回、尚未核验的引用继续保留。
        let ranked_keys: std::collections::HashSet<_> = reads
            .ranked
            .iter()
            .map(|row| format!("k:{}", retrieval::knowledge_record(row)))
            .collect();
        retired.extend(
            continuation
                .records
                .iter()
                .map(SavedCandidate::key)
                .filter(|key| {
                    !restored_window
                        && key.starts_with("k:")
                        && evaluated.contains(key)
                        && !ranked_keys.contains(key)
                }),
        );
        continuation.retire(retired.into_iter());
        reads.continuation = Some(continuation);
    }
    Ok((cache, reads))
}

// 锁外检索阶段（工具路径）：共享组合推进后，最终装配与资产目录在自己的短读事务
// 中完成，不持会话/运行锁；慢读取期间宿主心跳可正常续租，提交前由
// assert_search_fresh_in_tx 重核版本。
pub async fn search_stage_outside_lock(
    pool: &MySqlPool,
    ctx: &AccessContext,
    request: &mut ScopedSearchRequest<'_>,
) -> Result<ScopedSearchStage> {
    run_search_stage(pool, ctx, request, None).await
}

/// 用当前 scope/AllowedRecords 和边界已建立的 deadline 续取；游标不能授予访问权。
/// v2 的 asset_after 只推进个人资产目录，公共 cursor 独立恢复。
pub async fn restore_search_stage_outside_lock(
    pool: &MySqlPool,
    ctx: &AccessContext,
    request: &mut ScopedSearchRequest<'_>,
    continuation: SearchContinuation,
) -> Result<ScopedSearchStage> {
    let mut validation = Ok(());
    if !request.include_raw || request.query == "*" {
        validation = Err(Error::new("invalid_cursor"));
    }
    // 权限变化由本次解析的允许集约束；不使用游标内的旧范围。
    if let Some(allowed) = request.allowed {
        for record in &continuation.records {
            if continuation.suppresses(&record.key()) {
                continue;
            }
            let permitted = match record {
                SavedCandidate::Knowledge(id, ..) => allowed.knowledge_ids.contains(id),
                SavedCandidate::Raw(kind, id, ..) => allowed
                    .sources
                    .iter()
                    .any(|source| source.0 == *kind && source.1 == *id),
            };
            if !permitted {
                validation = Err(Error::new("stale_cursor"));
                break;
            }
        }
    }
    if let Err(error) = validation {
        if let Some(launch) = request.launch.take() {
            launch
                .embedding
                .await
                .map_err(|_| Error::new("unavailable"))??;
        }
        return Err(error);
    }
    run_search_stage(pool, ctx, request, Some(continuation)).await
}

async fn run_search_stage(
    pool: &MySqlPool,
    ctx: &AccessContext,
    request: &mut ScopedSearchRequest<'_>,
    continuation: Option<SearchContinuation>,
) -> Result<ScopedSearchStage> {
    let mut reads =
        if request.query == "*" || (!request.include_raw && request.asset_after.is_some()) {
            StageReads {
                scan_progress: json!({"rounds":0,"main_reads":0,"milvus":{},"sql":[]}),
                ..StageReads::default()
            }
        } else {
            drive_stage(
                pool,
                ctx,
                request.query,
                request.limit,
                request.launch.take(),
                &mut request.vector,
                request.scope,
                request.allowed,
                request.include_raw,
                request.hints,
                continuation,
            )
            .await?
            .1
        };
    let search = assemble_search_in_tx(
        pool,
        ctx,
        request.query,
        request.limit,
        &request.vector,
        request.scope,
        request.allowed,
        &mut reads,
    )
    .await?;
    finish_search_stage(pool, ctx, request, search, vec![]).await
}

pub(super) async fn finish_search_stage(
    pool: &MySqlPool,
    ctx: &AccessContext,
    request: &ScopedSearchRequest<'_>,
    search: KnowledgeSearch,
    source_selection_versions: Vec<(String, String)>,
) -> Result<ScopedSearchStage> {
    // 资产/记忆读取与普通检索共用原目录入口，选择原文不改变个人资产能力。
    let mut tx = AppTx::begin(pool).await?;
    let memories = crate::modules::assets::list_in_tx(&mut tx, ctx, true)
        .await?
        .into_iter()
        .filter(|v| v["kind"] == "memory")
        .collect();
    let mut items =
        valid_assets_in_tx(&mut tx, ctx, memories, request.cid, request.text_results).await?;
    let selected = crate::modules::assets::selected_in_tx(&mut tx, ctx, request.cid).await?;
    items.extend(
        valid_assets_in_tx(&mut tx, ctx, selected, request.cid, request.text_results).await?,
    );
    let page = retrieval::asset_directory(
        items.clone(),
        request.query,
        request.asset_after,
        request.limit,
    );
    tx.commit().await?;
    Ok(ScopedSearchStage {
        search,
        items,
        page,
        source_selection_versions,
    })
}

// 已知对象的精确原文选择复用raw候选、补读和原回执游标；不启动另一套检索。
