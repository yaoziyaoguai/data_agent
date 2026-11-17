use data_agent::{
    contracts::generated::{SourceKey, SourceKeyKind},
    modules::{
        jobs, knowledge,
        retrieval::{
            embedding::{self, SPEC},
            source_segments::{SourceFormat, SourceText, segment_source},
        },
    },
    persistence::{AppTx, connect},
    types::AccessContext,
    use_cases::{Binding, embed, raw_index_handover},
};
use serde_json::{Value, json};
use sqlx::Row;

fn test_url() -> Option<String> {
    let url = std::env::var("DATA_AGENT_DATABASE_URL").ok()?;
    if !url.contains("/data_agent_test_")
        || std::env::var("DATA_AGENT_VECTOR_URL").is_err()
        || !std::env::var("DATA_AGENT_VECTOR_COLLECTION")
            .unwrap_or_default()
            .starts_with("data_agent_test_")
    {
        return None;
    }
    Some(url)
}

const SPACE: &str = "demo";

// 本地嵌入协议替身：记录每次外发文本批并按固定规格应答，用于区分“回执回放”
// 与“真实新发送”。不依赖外部付费调用。
struct EmbeddingStub {
    port: u16,
    sent: std::sync::Arc<std::sync::Mutex<Vec<Vec<String>>>>,
    fail: std::sync::Arc<std::sync::atomic::AtomicBool>,
}
impl EmbeddingStub {
    fn start() -> Self {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let sent = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let record = sent.clone();
        let fail = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let failing = fail.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let mut buffer = Vec::new();
                let mut chunk = [0u8; 8192];
                loop {
                    match std::io::Read::read(&mut stream, &mut chunk) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            buffer.extend_from_slice(&chunk[..n]);
                            let head_end = buffer
                                .windows(4)
                                .position(|w| w == b"\r\n\r\n")
                                .map(|i| i + 4);
                            let Some(head_end) = head_end else { continue };
                            let head = String::from_utf8_lossy(&buffer[..head_end]).into_owned();
                            let length = head
                                .lines()
                                .find_map(|line| line.strip_prefix("content-length:"))
                                .and_then(|v| v.trim().parse::<usize>().ok())
                                .unwrap_or(0);
                            if buffer.len() >= head_end + length {
                                break;
                            }
                        }
                    }
                }
                let head_end = buffer
                    .windows(4)
                    .position(|w| w == b"\r\n\r\n")
                    .unwrap_or(buffer.len());
                let payload: Value =
                    serde_json::from_slice(&buffer[head_end..]).unwrap_or(Value::Null);
                if let Some(texts) = payload["input"].as_array() {
                    record.lock().unwrap().push(
                        texts
                            .iter()
                            .filter_map(|v| v.as_str().map(str::to_owned))
                            .collect(),
                    );
                }
                if failing.load(std::sync::atomic::Ordering::SeqCst) {
                    let body = br#"{"error":"synthetic_failure"}"#;
                    let response = format!(
                        "HTTP/1.1 503 Service Unavailable\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = std::io::Write::write_all(&mut stream, response.as_bytes());
                    let _ = std::io::Write::write_all(&mut stream, body);
                    continue;
                }
                let data: Vec<Value> = (0..payload["input"].as_array().map(Vec::len).unwrap_or(0))
                    .map(|index| {
                        let mut vector = vec![0.0f64; SPEC.dimension];
                        vector[index % SPEC.dimension] = 1.0;
                        json!({"index": index, "embedding": vector})
                    })
                    .collect();
                let body = json!({"data": data, "usage": {"prompt_tokens": 16}});
                let body = serde_json::to_vec(&body).unwrap();
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                    body.len()
                );
                let _ = std::io::Write::write_all(&mut stream, response.as_bytes());
                let _ = std::io::Write::write_all(&mut stream, &body);
            }
        });
        EmbeddingStub { port, sent, fail }
    }
    fn sends(&self) -> usize {
        self.sent.lock().unwrap().len()
    }
    fn set_fail(&self, value: bool) {
        self.fail.store(value, std::sync::atomic::Ordering::SeqCst);
    }
}

struct RecoveryHarness {
    pool: sqlx::MySqlPool,
    stub: EmbeddingStub,
    ctx: AccessContext,
    target: String,
    restore: Vec<(String, String)>,
    trials: Vec<String>,
    documents: Vec<String>,
}
impl RecoveryHarness {
    async fn start(trial: &str) -> Self {
        let url = test_url().expect("仅在check-shared-index-todo的隔离环境中运行");
        let stub = EmbeddingStub::start();
        let restore: Vec<(String, String)> = [
            "DATA_AGENT_MODE",
            "DATA_AGENT_EMBEDDING_TEST",
            "DATA_AGENT_EMBEDDING_URL",
            "DATA_AGENT_EMBEDDING_PROFILE",
        ]
        .into_iter()
        .map(|key| (key.to_owned(), std::env::var(key).unwrap_or_default()))
        .collect();
        unsafe {
            std::env::set_var("DATA_AGENT_MODE", "development");
            std::env::set_var("DATA_AGENT_EMBEDDING_TEST", "1");
            std::env::set_var(
                "DATA_AGENT_EMBEDDING_URL",
                format!("http://127.0.0.1:{}", stub.port),
            );
            std::env::set_var(
                "DATA_AGENT_EMBEDDING_PROFILE",
                json!({"trial_id":trial,"call_limit":100000,"cost_limit_micros":"1000000"})
                    .to_string(),
            );
        }
        let pool = connect(&url).await.unwrap();
        sqlx::query("DELETE FROM model_trials WHERE id=?")
            .bind(trial)
            .execute(&pool)
            .await
            .unwrap();
        let target = data_agent::modules::retrieval::vector::index_target()
            .await
            .unwrap();
        Self {
            pool,
            stub,
            ctx: AccessContext {
                user_id: "index-recovery-fixture".into(),
                space_id: SPACE.into(),
                request_id: "index-recovery".into(),
            },
            target,
            restore,
            trials: vec![trial.to_owned()],
            documents: Vec::new(),
        }
    }
    fn document(key: &str, body: &str) -> Value {
        json!({
            "id":key,"kind":"document","name":"恢复夹具文档","state":"enabled","version":"1",
            "entries":[{"entry_id":"body","path":"body","label":"正文","effective_value":body}]
        })
    }
    async fn seed_document(&mut self, id: &str, body: &str, register: bool) -> Value {
        for statement in [
            format!("DELETE FROM knowledge_index_jobs WHERE object_id='{id}'"),
            format!("DELETE FROM retrieval_source_projections WHERE source_id='{id}'"),
            format!("DELETE FROM knowledge_versions WHERE object_id='{id}'"),
            format!("DELETE FROM knowledge_objects WHERE id='{id}'"),
            format!(
                "DELETE FROM background_jobs WHERE kind='raw_source_index' AND resource_id='document-{id}'"
            ),
        ] {
            sqlx::query(sqlx::AssertSqlSafe(statement.clone()))
                .execute(&self.pool)
                .await
                .unwrap();
        }
        let document = Self::document(id, body);
        sqlx::query("INSERT INTO knowledge_objects(id,space_id,kind,name,version,state,body,source_version,updated_by) VALUES(?,?,?,?,?,?,?,0,'index-recovery')")
            .bind(id).bind(SPACE).bind("document").bind("恢复夹具文档").bind(1u64).bind("enabled")
            .bind(sqlx::types::Json(&document))
            .execute(&self.pool).await.unwrap();
        sqlx::query("INSERT INTO knowledge_versions(object_id,version,body) VALUES(?,?,?)")
            .bind(id)
            .bind(1u64)
            .bind(sqlx::types::Json(&document))
            .execute(&self.pool)
            .await
            .unwrap();
        if register {
            let mut tx = AppTx::begin(&self.pool).await.unwrap();
            data_agent::use_cases::knowledge_documents::register_document_preparation_in_tx(
                &mut tx, SPACE, &document,
            )
            .await
            .unwrap();
            tx.commit().await.unwrap();
            // 知识目标与rebuild登记同形：显式补一行，夹具不依赖全库重建入口。
            sqlx::query(
                "INSERT INTO knowledge_index_jobs(target_kind,object_id,version,space_id,state) \
                 VALUES('knowledge_entry',?,1,?,'pending')",
            )
            .bind(id)
            .bind(SPACE)
            .execute(&self.pool)
            .await
            .unwrap();
        }
        self.documents.push(id.to_owned());
        document
    }
    // 与统一消费者相同的确定性切块与分批，用于重建每批操作身份。
    fn batches(key: &str, revision: u64, body: &str) -> Vec<Vec<String>> {
        let source = SourceText {
            source: &SourceKey {
                kind: SourceKeyKind::Document,
                id: key.to_owned(),
            },
            revision: &revision.to_string(),
            text: body,
            format: SourceFormat::Markdown,
            background: &[],
        };
        let mut pieces = Vec::new();
        let mut cursor = None;
        loop {
            let batch = segment_source(&source, cursor.as_ref()).unwrap();
            for segment in &batch.segments {
                pieces.push(json!({"text": segment.text}));
            }
            match batch.next_cursor {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }
        embedding::batches(&pieces)
            .unwrap()
            .into_iter()
            .map(|chunk| {
                chunk
                    .iter()
                    .map(|piece| piece["text"].as_str().unwrap_or("").to_owned())
                    .collect()
            })
            .collect()
    }
    fn attempt_identity(key: &str, revision: u64, texts: &[String]) -> (String, String, String) {
        let texts_fp = data_agent::types::fingerprint(&json!(texts));
        let request = embedding::prepare(texts).unwrap();
        let operation = data_agent::types::fingerprint(&json!([
            "raw-source-index",
            SPACE,
            format!("document-{key}"),
            revision,
            SPEC.version,
            texts_fp
        ]));
        (
            data_agent::types::fingerprint(&json!([
                "shared-embedding",
                operation,
                request.fingerprint
            ])),
            operation,
            request.fingerprint,
        )
    }
    async fn insert_settled(
        &self,
        identity: (&str, &str, &str),
        vectors: Vec<Vec<f32>>,
        trial: &str,
    ) {
        let (id, operation, parameters) = identity;
        let _ = sqlx::query("DELETE FROM model_call_attempts WHERE id=?")
            .bind(id)
            .execute(&self.pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO model_call_attempts(id,budget_scope_id,run_id,state,parameters_fingerprint,\
             input_tokens_upper,output_tokens_max,reserved_micros,purpose,trial_id,operation_id,\
             price_version,actual_micros,usage_json,response_json) \
             VALUES(?,NULL,NULL,'settled',?,?,0,64,'knowledge_embedding',?,?,?,0,?,?)",
        )
        .bind(id)
        .bind(parameters)
        .bind(64u32)
        .bind(trial)
        .bind(operation)
        .bind("2026-10-05-qwen-cny-usd-ceiling")
        .bind(sqlx::types::Json(json!({"input_tokens":8,"output_tokens":0,"elapsed_ms":1})))
        .bind(sqlx::types::Json(json!(vectors)))
        .execute(&self.pool)
        .await
        .unwrap();
    }
    async fn insert_unknown(&self, identity: (&str, &str, &str), trial: &str) {
        let (id, operation, parameters) = identity;
        let _ = sqlx::query("DELETE FROM model_call_attempts WHERE id=?")
            .bind(id)
            .execute(&self.pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO model_call_attempts(id,budget_scope_id,run_id,state,parameters_fingerprint,\
             input_tokens_upper,output_tokens_max,reserved_micros,purpose,trial_id,operation_id,price_version) \
             VALUES(?,NULL,NULL,'unknown',?,?,0,64,'knowledge_embedding',?,?,?)",
        )
        .bind(id)
        .bind(parameters)
        .bind(64u32)
        .bind(trial)
        .bind(operation)
        .bind("2026-10-05-qwen-cny-usd-ceiling")
        .execute(&self.pool)
        .await
        .unwrap();
    }
    // 模拟消费中途崩溃：真实领取后仅前两批真实嵌入并结算，随后放弃租约；
    // 目标保持冻结配置、已结算批次可回放、其余批次从未发送。租约由
    // expire_source_leases 统一过期，让存活租约在多个目标间挡住队首重复领取。
    async fn crash_after_two_batches(&self, id: &str, revision: u64, batches: &[Vec<String>]) {
        let mut tx = AppTx::begin(&self.pool).await.unwrap();
        let job =
            knowledge::claim_source_index_in_tx(&mut tx, SPACE, true, Some(&self.target), None)
                .await
                .unwrap()
                .expect("冻结夹具目标必须可领取");
        tx.commit().await.unwrap();
        assert_eq!(job["object_id"], json!(id), "领取的必须是队首目标 {id}");
        let alias = format!("document-{id}");
        for texts in batches.iter().take(2) {
            let fp = data_agent::types::fingerprint(&json!(texts));
            embed(
                &self.pool,
                &self.ctx,
                Binding::RawIndex(&job, &alias, revision, fp),
                texts.clone(),
                None,
            )
            .await
            .unwrap();
        }
    }
    async fn expire_source_lease(&self, id: &str, revision: u64) {
        sqlx::query(
            "UPDATE knowledge_index_jobs SET lease_until=TIMESTAMPADD(SECOND,-1,UTC_TIMESTAMP(3)) \
             WHERE target_kind='source_excerpt' AND source_kind='document' AND object_id=? AND version=?",
        )
        .bind(id)
        .bind(revision)
        .execute(&self.pool)
        .await
        .unwrap();
    }
    // 旧raw移交：背景队列以原次数移交到公共待办，目标无冻结配置。
    async fn hand_over(&self, id: &str, revision: u64, attempts: u32) {
        let mut tx = AppTx::begin(&self.pool).await.unwrap();
        jobs::enqueue_source_in_tx(
            &mut tx,
            "raw_source_index",
            &format!("document-{id}"),
            revision,
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();
        sqlx::query(
            "UPDATE background_jobs SET attempts=? WHERE kind='raw_source_index' AND resource_id=?",
        )
        .bind(attempts)
        .bind(format!("document-{id}"))
        .execute(&self.pool)
        .await
        .unwrap();
        let mut tx = AppTx::begin(&self.pool).await.unwrap();
        raw_index_handover::hand_over_in_tx(&mut tx, SPACE)
            .await
            .unwrap();
        tx.commit().await.unwrap();
    }
    async fn source_state(&self, id: &str) -> (String, u32, Option<String>, Option<Value>) {
        let row = sqlx::query(
            "SELECT vector_state,vector_attempts,vector_error,embedding_profile \
             FROM knowledge_index_jobs WHERE target_kind='source_excerpt' AND source_kind='document' AND object_id=?",
        )
        .bind(id)
        .fetch_one(&self.pool)
        .await
        .unwrap();
        (
            row.get("vector_state"),
            row.get("vector_attempts"),
            row.get("vector_error"),
            row.get::<Option<sqlx::types::Json<Value>>, _>("embedding_profile")
                .map(|v| v.0),
        )
    }
    async fn knowledge_state(&self, id: &str) -> Option<(String, u32)> {
        sqlx::query(
            "SELECT vector_state,vector_attempts FROM knowledge_index_jobs \
             WHERE target_kind='knowledge_entry' AND object_id=?",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .unwrap()
        .map(|row| (row.get("vector_state"), row.get("vector_attempts")))
    }
    async fn knowledge_job(&self, id: &str) -> Value {
        sqlx::query_scalar::<_, sqlx::types::Json<Value>>(
            "SELECT JSON_OBJECT('state',state,'vector_state',vector_state,'attempts',vector_attempts,\
             'epoch',lease_epoch,'target',vector_target,'profile',embedding_profile,\
             'receipt',vector_receipt,'error',vector_error) FROM knowledge_index_jobs \
             WHERE target_kind='knowledge_entry' AND object_id=? AND version=1",
        )
        .bind(id)
        .fetch_one(&self.pool)
        .await
        .unwrap()
        .0
    }
    async fn source_job(&self, id: &str) -> Value {
        sqlx::query_scalar::<_, sqlx::types::Json<Value>>(
            "SELECT JSON_OBJECT('state',state,'vector_state',vector_state,'attempts',vector_attempts,\
             'epoch',lease_epoch,'target',vector_target,'profile',embedding_profile,\
             'receipt',vector_receipt,'error',vector_error) FROM knowledge_index_jobs \
             WHERE target_kind='source_excerpt' AND source_kind='document' AND object_id=? AND version=1",
        )
        .bind(id)
        .fetch_one(&self.pool)
        .await
        .unwrap()
        .0
    }
    // 走真实整理应用入口：只更新同修订派生陈述，不推进文档原文修订。
    async fn apply_same_version(&self, id: &str, operation: &str, text: &str) -> Value {
        let source = SourceKey {
            kind: SourceKeyKind::Document,
            id: id.to_owned(),
        };
        let mut tx = AppTx::begin(&self.pool).await.unwrap();
        let saved = knowledge::apply_preparation_in_tx(
            &mut tx,
            &self.ctx,
            operation,
            &source,
            "1",
            &json!({"statements":[{
                "key":"same-version-projection",
                "target":{"object_id":id,"version":"1","path":"body"},
                "text":text,
                "scope_text":"",
                "citations":[{"source":source,"revision":"1","locator":{"offset":0,"length":6}}],
                "supports":[],
                "supports_complete":true
            }],"relations":[],"unresolved":[],"semantic_status":"ready"}),
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();
        saved[0].clone()
    }
    async fn coverage(&self, id: &str) -> &'static str {
        let scope = data_agent::search_scope::KnowledgeSearchScope::default();
        let allowed = [id.to_owned()];
        let mut tx = AppTx::begin(&self.pool).await.unwrap();
        let state = knowledge::index_coverage_in_tx(
            &mut tx,
            &self.ctx,
            &self.target,
            &scope,
            Some(&allowed),
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();
        state
    }
    async fn finish(self) {
        for id in &self.documents {
            let _ = data_agent::modules::retrieval::vector::drop_source_excerpts(
                SPACE, "document", id, 2,
            )
            .await;
            for statement in [
                format!("DELETE FROM knowledge_index_jobs WHERE object_id='{id}'"),
                format!("DELETE FROM retrieval_source_projections WHERE source_id='{id}'"),
                format!("DELETE FROM knowledge_versions WHERE object_id='{id}'"),
                format!("DELETE FROM knowledge_objects WHERE id='{id}'"),
                format!(
                    "DELETE FROM background_jobs WHERE kind='raw_source_index' AND resource_id='document-{id}'"
                ),
            ] {
                sqlx::query(sqlx::AssertSqlSafe(statement.clone()))
                    .execute(&self.pool)
                    .await
                    .unwrap();
            }
        }
        for trial in &self.trials {
            sqlx::query("DELETE FROM model_call_attempts WHERE trial_id=?")
                .bind(trial)
                .execute(&self.pool)
                .await
                .unwrap();
            sqlx::query("DELETE FROM model_trials WHERE id=?")
                .bind(trial)
                .execute(&self.pool)
                .await
                .unwrap();
        }
        unsafe {
            for (key, value) in self.restore {
                if value.is_empty() {
                    std::env::remove_var(&key);
                } else {
                    std::env::set_var(&key, value);
                }
            }
        }
        drop(self.stub);
        self.pool.close().await;
    }
}

fn body_of(lines: usize) -> String {
    (0..lines)
        .map(|i| format!("-- 恢复样本第{i}行：口径说明与依据记录。\n"))
        .collect()
}

// 只读核对真实向量库中的知识投影；不经产品检索路径，避免把查询侧行为
// 混入同版重新整理的投影证据。
async fn knowledge_rows(id: &str) -> Vec<Value> {
    let url = std::env::var("DATA_AGENT_VECTOR_URL").unwrap();
    let collection = std::env::var("DATA_AGENT_VECTOR_COLLECTION").unwrap();
    let token =
        std::fs::read_to_string(std::env::var("DATA_AGENT_VECTOR_TOKEN_FILE").unwrap()).unwrap();
    let response: Value = reqwest::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .unwrap()
        .post(format!("{url}/v2/vectordb/entities/query"))
        .bearer_auth(format!("root:{}", token.trim()))
        .json(&json!({
            "collectionName":collection,"dbName":"default",
            "filter":format!("target == \"knowledge_entry\" && object_id == {}",json!(id)),
            "outputFields":["id","object_id","object_version","content_hash","text"],
            "limit":64,"consistencyLevel":"Strong"
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(response["code"], 0, "{response}");
    response["data"].as_array().cloned().unwrap_or_default()
}

// 混合队列资格判定：当前配置非法时，队首无绑定新目标不空耗索引次数、不挡
// 后面的冻结或可恢复目标；冻结目标沿原冻结值续跑，旧raw按原账本回放/有限
// 处置收敛，无可复用回执且无有效配置的目标保持真实pending。
#[tokio::test]
async fn mixed_queue_skips_unconfigured_targets_and_recovers_frozen_and_ledger_backlogs() {
    const TRIAL: &str = "recovery-mixed-frozen-trial";
    let mut fixture = RecoveryHarness::start(TRIAL).await;
    // 阶段0：有效配置下清空既有待办，后续队列只含本夹具目标。
    while data_agent::use_cases::knowledge::process_index(&fixture.pool)
        .await
        .unwrap()
    {}
    let bb_batches = RecoveryHarness::batches("recovery-bb-frozen", 1, &body_of(600));
    let cc_batches = RecoveryHarness::batches("recovery-cc-replay", 1, &body_of(320));
    let dd_batches = RecoveryHarness::batches("recovery-dd-unknown", 1, &body_of(320));
    assert!(bb_batches.len() >= 4, "冻结夹具须有至少4个嵌入批");
    assert!(cc_batches.len() >= 2 && dd_batches.len() >= 2);
    fixture
        .seed_document("recovery-bb-frozen", &body_of(600), true)
        .await;
    // 知识批次完成后再进原文：一次消费只领一类工作。
    assert!(
        data_agent::use_cases::knowledge::process_index(&fixture.pool)
            .await
            .unwrap()
    );
    assert_eq!(
        fixture.knowledge_state("recovery-bb-frozen").await,
        Some(("indexed".into(), 1)),
        "冻结夹具的知识侧先完成"
    );
    fixture
        .crash_after_two_batches("recovery-bb-frozen", 1, &bb_batches)
        .await;
    fixture.expire_source_lease("recovery-bb-frozen", 1).await;
    let crashed = fixture.source_state("recovery-bb-frozen").await;
    assert_eq!(crashed.0, "sending");
    assert_eq!(crashed.1, 1);
    assert_eq!(
        crashed.3.as_ref().and_then(|p| p["trial_id"].as_str()),
        Some(TRIAL),
        "夹具目标必须已冻结原配置"
    );
    fixture
        .seed_document("recovery-cc-replay", &body_of(320), false)
        .await;
    fixture.hand_over("recovery-cc-replay", 1, 1).await;
    for texts in cc_batches.iter() {
        let vectors = texts.iter().map(|_| vec![0.5f32; SPEC.dimension]).collect();
        let identity = RecoveryHarness::attempt_identity("recovery-cc-replay", 1, texts);
        fixture
            .insert_settled(
                (&identity.0, &identity.1, &identity.2),
                vectors,
                "recovery-legacy-trial",
            )
            .await;
    }
    fixture
        .seed_document("recovery-dd-unknown", &body_of(320), false)
        .await;
    fixture.hand_over("recovery-dd-unknown", 1, 1).await;
    let vectors = vec![vec![0.5f32; SPEC.dimension]; dd_batches[0].len()];
    let settled = RecoveryHarness::attempt_identity("recovery-dd-unknown", 1, &dd_batches[0]);
    fixture
        .insert_settled(
            (&settled.0, &settled.1, &settled.2),
            vectors,
            "recovery-legacy-trial",
        )
        .await;
    let unknown = RecoveryHarness::attempt_identity("recovery-dd-unknown", 1, &dd_batches[1]);
    fixture
        .insert_unknown(
            (&unknown.0, &unknown.1, &unknown.2),
            "recovery-legacy-trial",
        )
        .await;
    fixture.trials.push("recovery-legacy-trial".into());
    fixture
        .seed_document("recovery-ee-pending", &body_of(320), false)
        .await;
    fixture.hand_over("recovery-ee-pending", 1, 2).await;

    // 阶段1：当前配置非法；队首放入无绑定新目标。
    unsafe {
        std::env::set_var("DATA_AGENT_EMBEDDING_PROFILE", "invalid-embedding-profile");
    }
    fixture
        .seed_document("recovery-aa-unbound", &body_of(320), true)
        .await;
    let crash_sends = fixture.stub.sends();
    // 冻结目标沿原冻结值续跑：已结算两批回放，其余批次真实发送。
    assert!(
        data_agent::use_cases::knowledge::process_index(&fixture.pool)
            .await
            .unwrap()
    );
    let frozen = fixture.source_state("recovery-bb-frozen").await;
    assert_eq!(frozen.0, "indexed");
    assert_eq!(
        frozen.3.as_ref().and_then(|p| p["trial_id"].as_str()),
        Some(TRIAL)
    );
    assert_eq!(
        fixture.stub.sends() - crash_sends,
        bb_batches.len() - 2,
        "冻结目标只补发未发送批次"
    );
    // 队首无绑定新目标：知识侧与原文侧都不领取、不耗次数。
    assert_eq!(
        fixture.knowledge_state("recovery-aa-unbound").await,
        Some(("pending".into(), 0)),
        "无有效配置的新知识目标不空耗索引次数"
    );
    assert_eq!(fixture.source_state("recovery-aa-unbound").await.1, 0);
    // 旧raw整批成功回执：纯回放收敛，零新发送。
    let after_bf = fixture.stub.sends();
    assert!(
        data_agent::use_cases::knowledge::process_index(&fixture.pool)
            .await
            .unwrap()
    );
    assert_eq!(
        fixture.source_state("recovery-cc-replay").await.0,
        "indexed"
    );
    assert_eq!(fixture.stub.sends(), after_bf, "成功回执接回零重发");
    // 旧raw未知回执：沿原有限处置推进尝试，不重发。
    assert!(
        data_agent::use_cases::knowledge::process_index(&fixture.pool)
            .await
            .unwrap()
    );
    assert_eq!(
        fixture.source_state("recovery-dd-unknown").await,
        ("unknown".into(), 2, Some("embedding_unknown".into()), None)
    );
    assert_eq!(fixture.stub.sends(), after_bf, "未知回执不得重发");
    // 错误收尾保留5秒宽限租约；等宽限过期后再领取，收敛为明确失败。
    tokio::time::sleep(std::time::Duration::from_millis(5300)).await;
    assert!(
        data_agent::use_cases::knowledge::process_index(&fixture.pool)
            .await
            .unwrap()
    );
    assert_eq!(
        fixture.source_state("recovery-dd-unknown").await,
        ("failed".into(), 3, Some("embedding_unknown".into()), None)
    );
    // 无可复用回执且无有效配置的旧raw：保持真实pending，次数不增长，队列收尾。
    assert!(
        !data_agent::use_cases::knowledge::process_index(&fixture.pool)
            .await
            .unwrap()
    );
    assert_eq!(
        fixture.source_state("recovery-ee-pending").await,
        ("pending".into(), 2, None, None),
        "origin/attempts不能换来发送资格"
    );
    assert_eq!(
        fixture.knowledge_state("recovery-aa-unbound").await,
        Some(("pending".into(), 0))
    );
    assert_eq!(fixture.stub.sends(), after_bf);
    fixture.finish().await;
}

// 冻结目标的未发送批次不依赖当前配置：缺失、非法、同trial改值、合法新trial
// 四种条件下都沿原冻结trial续跑；不登记根本不用的当前trial。
#[tokio::test]
async fn frozen_targets_continue_on_frozen_profile_across_config_conditions() {
    const TRIAL: &str = "recovery-conditions-frozen-trial";
    const NEW_TRIAL: &str = "recovery-conditions-unused-trial";
    let mut fixture = RecoveryHarness::start(TRIAL).await;
    while data_agent::use_cases::knowledge::process_index(&fixture.pool)
        .await
        .unwrap()
    {}
    let mut batches = Vec::new();
    for id in [
        "recovery-bf-missing",
        "recovery-bg-changed",
        "recovery-bh-newtrial",
    ] {
        let body = body_of(600);
        batches.push(RecoveryHarness::batches(id, 1, &body));
        fixture.seed_document(id, &body, true).await;
    }
    // 知识批次完成后再制造原文崩溃：一次消费只领一类工作，知识待办清空
    // 之前不会领取原文目标，三个目标因此都停在"冻结配置+两批已结算"。
    loop {
        let pending: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM knowledge_index_jobs \
             WHERE target_kind='knowledge_entry' AND space_id=? AND state='pending'",
        )
        .bind(SPACE)
        .fetch_one(&fixture.pool)
        .await
        .unwrap();
        if pending == 0 {
            break;
        }
        assert!(
            data_agent::use_cases::knowledge::process_index(&fixture.pool)
                .await
                .unwrap()
        );
    }
    for (id, target_batches) in [
        "recovery-bf-missing",
        "recovery-bg-changed",
        "recovery-bh-newtrial",
    ]
    .into_iter()
    .zip(&batches)
    {
        fixture.crash_after_two_batches(id, 1, target_batches).await;
    }
    for id in [
        "recovery-bf-missing",
        "recovery-bg-changed",
        "recovery-bh-newtrial",
    ] {
        fixture.expire_source_lease(id, 1).await;
    }
    fixture.trials.push(NEW_TRIAL.into());

    // 条件1：当前配置缺失。
    unsafe { std::env::remove_var("DATA_AGENT_EMBEDDING_PROFILE") };
    let baseline = fixture.stub.sends();
    assert!(
        data_agent::use_cases::knowledge::process_index(&fixture.pool)
            .await
            .unwrap()
    );
    let missing = fixture.source_state("recovery-bf-missing").await;
    assert_eq!(missing.0, "indexed");
    assert_eq!(
        missing.3.as_ref().and_then(|p| p["trial_id"].as_str()),
        Some(TRIAL)
    );
    assert_eq!(fixture.stub.sends() - baseline, batches[0].len() - 2);

    // 条件2：同trial但内容改变——不能提前冲突，仍用冻结值。
    unsafe {
        std::env::set_var(
            "DATA_AGENT_EMBEDDING_PROFILE",
            json!({"trial_id":TRIAL,"call_limit":999999,"cost_limit_micros":"1000000"}).to_string(),
        );
    }
    let frozen_fingerprint: String =
        sqlx::query_scalar("SELECT configuration_fingerprint FROM model_trials WHERE id=?")
            .bind(TRIAL)
            .fetch_one(&fixture.pool)
            .await
            .unwrap();
    let before_changed = fixture.stub.sends();
    assert!(
        data_agent::use_cases::knowledge::process_index(&fixture.pool)
            .await
            .unwrap()
    );
    let changed = fixture.source_state("recovery-bg-changed").await;
    assert_eq!(changed.0, "indexed");
    assert_eq!(
        changed.3.as_ref().and_then(|p| p["trial_id"].as_str()),
        Some(TRIAL)
    );
    assert_eq!(fixture.stub.sends() - before_changed, batches[1].len() - 2);
    let fingerprint_after: String =
        sqlx::query_scalar("SELECT configuration_fingerprint FROM model_trials WHERE id=?")
            .bind(TRIAL)
            .fetch_one(&fixture.pool)
            .await
            .unwrap();
    assert_eq!(
        frozen_fingerprint, fingerprint_after,
        "同trial改值不得覆盖冻结配置"
    );

    // 条件3：合法新trial——不登记、不派发、不换trial补额。
    unsafe {
        std::env::set_var(
            "DATA_AGENT_EMBEDDING_PROFILE",
            json!({"trial_id":NEW_TRIAL,"call_limit":100000,"cost_limit_micros":"1000000"})
                .to_string(),
        );
    }
    let before_new = fixture.stub.sends();
    assert!(
        data_agent::use_cases::knowledge::process_index(&fixture.pool)
            .await
            .unwrap()
    );
    let new_trial = fixture.source_state("recovery-bh-newtrial").await;
    assert_eq!(new_trial.0, "indexed");
    assert_eq!(
        new_trial.3.as_ref().and_then(|p| p["trial_id"].as_str()),
        Some(TRIAL)
    );
    assert_eq!(fixture.stub.sends() - before_new, batches[2].len() - 2);
    let registered: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM model_trials WHERE id=?")
        .bind(NEW_TRIAL)
        .fetch_one(&fixture.pool)
        .await
        .unwrap();
    assert_eq!(registered, 0, "不登记根本不用的当前trial");
    let dispatched: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM model_call_attempts WHERE trial_id=?")
            .bind(NEW_TRIAL)
            .fetch_one(&fixture.pool)
            .await
            .unwrap();
    assert_eq!(dispatched, 0, "新trial零派发");
    fixture.finish().await;
}

#[tokio::test]
async fn exhausted_source_index_converges_without_current_configuration() {
    let mut fixture = RecoveryHarness::start("recovery-exhausted-trial").await;
    while data_agent::use_cases::knowledge::process_index(&fixture.pool)
        .await
        .unwrap()
    {}
    let id = "recovery-exhausted-source";
    fixture.seed_document(id, &body_of(5), false).await;
    fixture.hand_over(id, 1, 2).await;
    let mut tx = AppTx::begin(&fixture.pool).await.unwrap();
    let job =
        knowledge::claim_source_index_in_tx(&mut tx, SPACE, true, Some(&fixture.target), None)
            .await
            .unwrap()
            .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(job["object_id"], id);
    assert_eq!(fixture.source_state(id).await.1, 3);

    // 最后一次领取后退出，未走finish；恢复只需收敛原状态，不需要发送配置。
    fixture.expire_source_lease(id, 1).await;
    unsafe { std::env::remove_var("DATA_AGENT_EMBEDDING_PROFILE") };
    let sent = fixture.stub.sends();
    assert!(
        !data_agent::use_cases::knowledge::process_index(&fixture.pool)
            .await
            .unwrap()
    );
    assert_eq!(
        fixture.source_state(id).await,
        (
            "failed".into(),
            3,
            Some("vector_receipt_unknown".into()),
            None
        )
    );
    assert_eq!(fixture.stub.sends(), sent, "状态收敛不能派发模型调用");
    fixture.finish().await;
}

#[tokio::test]
async fn frozen_source_index_resumes_before_trial_registration() {
    let mut fixture = RecoveryHarness::start("recovery-trial-bootstrap").await;
    while data_agent::use_cases::knowledge::process_index(&fixture.pool)
        .await
        .unwrap()
    {}
    let id = "recovery-unregistered-source";
    let body = body_of(5);
    let batches = RecoveryHarness::batches(id, 1, &body);
    fixture.seed_document(id, &body, false).await;
    fixture.hand_over(id, 1, 0).await;
    let profile = json!({
        "trial_id":"recovery-unregistered-trial",
        "call_limit":100000,
        "cost_limit_micros":"1000000",
    });
    fixture.trials.push("recovery-unregistered-trial".into());
    let mut tx = AppTx::begin(&fixture.pool).await.unwrap();
    let job =
        knowledge::claim_source_index_in_tx(&mut tx, SPACE, true, Some(&fixture.target), None)
            .await
            .unwrap()
            .unwrap();
    assert_eq!(job["object_id"], id);
    assert!(
        knowledge::bound_source_index_embedding_in_tx(&mut tx, &job)
            .await
            .unwrap()
            .is_none()
    );
    knowledge::freeze_source_index_embedding_in_tx(&mut tx, &job, &profile)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let registered: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM model_trials WHERE id=?")
        .bind("recovery-unregistered-trial")
        .fetch_one(&fixture.pool)
        .await
        .unwrap();
    assert_eq!(registered, 0, "冻结提交后的断点尚未登记trial");
    fixture.expire_source_lease(id, 1).await;
    unsafe { std::env::remove_var("DATA_AGENT_EMBEDDING_PROFILE") };
    let sent = fixture.stub.sends();
    assert!(
        data_agent::use_cases::knowledge::process_index(&fixture.pool)
            .await
            .unwrap()
    );
    let recovered = fixture.source_state(id).await;
    assert_eq!(recovered.0, "indexed");
    assert_eq!(recovered.3, Some(profile.clone()));
    let registered = sqlx::query(
        "SELECT configuration_fingerprint,allocated_calls FROM model_trials WHERE id=?",
    )
    .bind("recovery-unregistered-trial")
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert_eq!(
        registered.get::<String, _>("configuration_fingerprint"),
        data_agent::types::fingerprint(&profile)
    );
    assert_eq!(
        registered.get::<u32, _>("allocated_calls") as usize,
        batches.len()
    );
    assert_eq!(fixture.stub.sends() - sent, batches.len());
    assert!(
        !data_agent::use_cases::knowledge::process_index(&fixture.pool)
            .await
            .unwrap()
    );
    assert_eq!(
        fixture.stub.sends() - sent,
        batches.len(),
        "恢复后不重复派发"
    );
    fixture.finish().await;
}

#[tokio::test]
async fn knowledge_coverage_rejects_old_projection_receipts_without_rebinding_work() {
    use data_agent::{
        modules::retrieval::vector::{AllowedRecords, Candidates},
        search_scope::KnowledgeSearchScope,
        use_cases::knowledge::{ScopedSearchRequest, search_stage_outside_lock},
    };
    let mut fixture = RecoveryHarness::start("recovery-knowledge-projection-trial").await;
    while data_agent::use_cases::knowledge::process_index(&fixture.pool)
        .await
        .unwrap()
    {}
    let id = "recovery-knowledge-projection";
    fixture
        .seed_document(id, "projectioncoverageneedle 合成索引覆盖正文。", true)
        .await;
    while data_agent::use_cases::knowledge::process_index(&fixture.pool)
        .await
        .unwrap()
    {}
    let receipt: sqlx::types::Json<Value> = sqlx::query_scalar(
        "SELECT vector_receipt FROM knowledge_index_jobs WHERE target_kind='knowledge_entry' AND object_id=? AND version=1",
    ).bind(id).fetch_one(&fixture.pool).await.unwrap();
    let allowed = AllowedRecords {
        knowledge_ids: vec![id.to_owned()],
        sources: vec![],
    };
    let inspect = |query: &'static str| {
        let pool = fixture.pool.clone();
        let ctx = fixture.ctx.clone();
        let allowed = allowed.clone();
        async move {
            search_stage_outside_lock(
                &pool,
                &ctx,
                &mut ScopedSearchRequest {
                    query,
                    limit: 1,
                    launch: None,
                    vector: Candidates::lexical(),
                    scope: &KnowledgeSearchScope::default(),
                    allowed: Some(&allowed),
                    asset_after: None,
                    hints: None,
                    cid: "",
                    text_results: &Default::default(),
                    include_raw: false,
                },
            )
            .await
            .unwrap()
        }
    };
    let current = inspect("projectioncoverageneedle").await;
    assert_eq!(
        current.search.hits.len(),
        1,
        "正式writer和真实Milvus须先证明当前内容可交付"
    );
    assert_eq!(current.search.coverage["index_state"], "current");
    let before: sqlx::types::Json<Value> = sqlx::query_scalar(
        "SELECT JSON_OBJECT('target',vector_target,'state',vector_state,'attempts',vector_attempts,'epoch',lease_epoch,'profile',embedding_profile) FROM knowledge_index_jobs WHERE target_kind='knowledge_entry' AND object_id=? AND version=1",
    ).bind(id).fetch_one(&fixture.pool).await.unwrap();
    let ledger_before: sqlx::types::Json<Value> = sqlx::query_scalar(
        "SELECT JSON_OBJECT('attempts',(SELECT COUNT(*) FROM model_call_attempts),'trial',JSON_OBJECT('calls',allocated_calls,'spent',spent_micros,'reserved',reserved_micros)) FROM model_trials WHERE id='recovery-knowledge-projection-trial'",
    ).fetch_one(&fixture.pool).await.unwrap();
    let sends = fixture.stub.sends();
    for projection in [None, Some("knowledge-window-2")] {
        let mut old = receipt.0.clone();
        if let Some(projection) = projection {
            old["projection_version"] = json!(projection);
        } else {
            old.as_object_mut().unwrap().remove("projection_version");
        }
        sqlx::query("UPDATE knowledge_index_jobs SET vector_receipt=? WHERE target_kind='knowledge_entry' AND object_id=? AND version=1")
            .bind(sqlx::types::Json(&old)).bind(id).execute(&fixture.pool).await.unwrap();
        let stage = inspect("projectioncoverageabsent").await;
        assert!(stage.search.hits.is_empty());
        assert_eq!(
            stage.search.coverage["index_state"], "incomplete",
            "旧或缺失表示版本不能冒充当前覆盖：{projection:?}"
        );
        assert_eq!(stage.search.coverage["state"], "bounded");
        let after: sqlx::types::Json<Value> = sqlx::query_scalar(
            "SELECT JSON_OBJECT('target',vector_target,'state',vector_state,'attempts',vector_attempts,'epoch',lease_epoch,'profile',embedding_profile) FROM knowledge_index_jobs WHERE target_kind='knowledge_entry' AND object_id=? AND version=1",
        ).bind(id).fetch_one(&fixture.pool).await.unwrap();
        assert_eq!(after, before, "查询不重领或改绑旧索引作业");
    }
    sqlx::query("UPDATE knowledge_index_jobs SET vector_receipt=? WHERE target_kind='knowledge_entry' AND object_id=? AND version=1")
        .bind(&receipt).bind(id).execute(&fixture.pool).await.unwrap();
    assert_eq!(
        receipt.0["projection_version"],
        data_agent::types::KNOWLEDGE_PROJECTION,
        "正式writer回执须标实际知识表示"
    );
    assert_eq!(
        inspect("projectioncoverageneedle").await.search.coverage["index_state"],
        "current"
    );
    let ledger_after: sqlx::types::Json<Value> = sqlx::query_scalar(
        "SELECT JSON_OBJECT('attempts',(SELECT COUNT(*) FROM model_call_attempts),'trial',JSON_OBJECT('calls',allocated_calls,'spent',spent_micros,'reserved',reserved_micros)) FROM model_trials WHERE id='recovery-knowledge-projection-trial'",
    ).fetch_one(&fixture.pool).await.unwrap();
    assert_eq!(
        ledger_after, ledger_before,
        "覆盖检查不创建许可或改变原trial预算"
    );
    assert_eq!(fixture.stub.sends(), sends, "查询不因旧投影自动补Embedding");
    fixture.finish().await;
}

// 同修订重新整理的知识目标沿原row身份推进：首次冻结配置、原调用账本和
// 单调租约代次保留，新派生内容确实重新投影；相同输入重存不重置重试周期。
#[tokio::test]
async fn same_version_preparation_repends_projection_with_frozen_profile() {
    const TRIAL: &str = "recovery-same-version-trial";
    const UNUSED: &str = "recovery-same-version-unused-trial";
    let mut fixture = RecoveryHarness::start(TRIAL).await;
    while data_agent::use_cases::knowledge::process_index(&fixture.pool)
        .await
        .unwrap()
    {}
    let id = "recovery-same-version";
    let body = "同版重新整理投影验收正文：收入按结算日统计。";
    fixture.seed_document(id, body, true).await;
    while data_agent::use_cases::knowledge::process_index(&fixture.pool)
        .await
        .unwrap()
    {}
    let initial = fixture.knowledge_job(id).await;
    assert_eq!(initial["vector_state"].as_str(), Some("indexed"));
    assert_eq!(
        initial["profile"]["trial_id"].as_str(),
        Some(TRIAL),
        "首次投影冻结当前配置"
    );
    assert_eq!(
        initial["receipt"]["projection_version"].as_str(),
        Some(data_agent::types::KNOWLEDGE_PROJECTION)
    );
    let raw_before = fixture.source_job(id).await;
    let mut sends = fixture.stub.sends();
    let mut epoch = initial["epoch"].as_u64().unwrap();
    // 当前配置切到未使用的新trial：同版整理后的新文本仍须沿首次冻结的A。
    unsafe {
        std::env::set_var(
            "DATA_AGENT_EMBEDDING_PROFILE",
            json!({"trial_id":UNUSED,"call_limit":100000,"cost_limit_micros":"1000000"})
                .to_string(),
        );
    }
    for round in 1..=4u32 {
        let text = format!("第{round}轮同版整理投影陈述");
        fixture
            .apply_same_version(id, &format!("same-version-apply-{round}"), &text)
            .await;
        let pending = fixture.knowledge_job(id).await;
        assert_eq!(
            pending["state"].as_str(),
            Some("pending"),
            "第{round}轮重开待办"
        );
        assert_eq!(pending["vector_state"].as_str(), Some("pending"));
        assert_eq!(pending["attempts"], 0, "已知终态后的新内容开启新尝试周期");
        assert_eq!(
            pending["profile"]["trial_id"].as_str(),
            Some(TRIAL),
            "重开不换冻结配置"
        );
        assert_eq!(
            pending["epoch"].as_u64().unwrap(),
            epoch + 1,
            "租约代次单调推进"
        );
        assert_eq!(pending["receipt"], Value::Null, "旧成功回执不再代表新内容");
        assert_eq!(
            fixture.coverage(id).await,
            "incomplete",
            "重开待办未完成前不能报current"
        );
        while data_agent::use_cases::knowledge::process_index(&fixture.pool)
            .await
            .unwrap()
        {}
        let indexed = fixture.knowledge_job(id).await;
        assert_eq!(
            indexed["vector_state"].as_str(),
            Some("indexed"),
            "第{round}轮投影完成"
        );
        assert_eq!(indexed["attempts"], 1);
        assert_eq!(
            indexed["profile"]["trial_id"].as_str(),
            Some(TRIAL),
            "消费沿用冻结配置"
        );
        assert_eq!(fixture.coverage(id).await, "current");
        assert!(
            fixture.stub.sends() > sends,
            "第{round}轮新文本确实重新嵌入"
        );
        sends = fixture.stub.sends();
        let rows = knowledge_rows(id).await;
        assert!(
            rows.iter().any(|row| {
                row["text"]
                    .as_str()
                    .is_some_and(|text| text.contains(&format!("第{round}轮同版整理投影陈述")))
            }),
            "第{round}轮新陈述进入真实投影: {rows:?}"
        );
        epoch = indexed["epoch"].as_u64().unwrap();
    }
    assert_eq!(
        fixture.source_job(id).await,
        raw_before,
        "同版整理不触碰原文目标及其进度"
    );
    // 相同输入恢复不重置原重试周期：连续三次真实失败后同文重存保持失败态。
    fixture
        .apply_same_version(id, "same-version-apply-5", "第5轮同版整理投影陈述")
        .await;
    fixture.stub.set_fail(true);
    for attempt in 0..3 {
        assert!(
            data_agent::use_cases::knowledge::process_index(&fixture.pool)
                .await
                .unwrap()
        );
        if attempt < 2 {
            // 失败后的短暂退避自然到期，等价于等待下一次可领取时点。
            sqlx::query(
                "UPDATE knowledge_index_jobs SET lease_until=TIMESTAMPADD(SECOND,-1,UTC_TIMESTAMP(3)) \
                 WHERE target_kind='knowledge_entry' AND object_id=? AND version=1",
            )
            .bind(id)
            .execute(&fixture.pool)
            .await
            .unwrap();
        }
    }
    let exhausted = fixture.knowledge_job(id).await;
    assert_eq!(
        exhausted["vector_state"].as_str(),
        Some("failed"),
        "三次真实失败到达原上限"
    );
    assert_eq!(exhausted["attempts"], 3);
    assert!(exhausted["error"].is_string(), "失败原因如实保留");
    fixture
        .apply_same_version(id, "same-version-apply-same", "第5轮同版整理投影陈述")
        .await;
    assert_eq!(
        fixture.knowledge_job(id).await,
        exhausted,
        "相同输入重存不重置失败次数、错误或租约代次"
    );
    // 已知终态后的真实内容变化按原规则开启新的尝试周期。
    fixture.stub.set_fail(false);
    fixture
        .apply_same_version(id, "same-version-apply-6", "第6轮同版整理投影陈述")
        .await;
    let renewed = fixture.knowledge_job(id).await;
    assert_eq!(renewed["state"].as_str(), Some("pending"));
    assert_eq!(renewed["attempts"], 0);
    assert_eq!(renewed["error"], Value::Null);
    assert_eq!(renewed["profile"]["trial_id"].as_str(), Some(TRIAL));
    while data_agent::use_cases::knowledge::process_index(&fixture.pool)
        .await
        .unwrap()
    {}
    assert_eq!(
        fixture.knowledge_job(id).await["vector_state"].as_str(),
        Some("indexed")
    );
    let registered: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM model_trials WHERE id=?")
        .bind(UNUSED)
        .fetch_one(&fixture.pool)
        .await
        .unwrap();
    assert_eq!(registered, 0, "根本不用的当前trial不登记");
    fixture.finish().await;
}

#[tokio::test]
async fn source_recovery_propagates_storage_failure_without_consuming_attempts() {
    let mut fixture = RecoveryHarness::start("recovery-storage-trial").await;
    while data_agent::use_cases::knowledge::process_index(&fixture.pool)
        .await
        .unwrap()
    {}
    let id = "recovery-storage-source";
    fixture.seed_document(id, &body_of(5), false).await;
    fixture.hand_over(id, 1, 1).await;
    unsafe { std::env::remove_var("DATA_AGENT_EMBEDDING_PROFILE") };
    let sent = fixture.stub.sends();
    // 当前修订从knowledge_objects读取；仅移开正文列，保留候选头并触发真实读取错误。
    sqlx::query("ALTER TABLE knowledge_objects RENAME COLUMN body TO unavailable_body")
        .execute(&fixture.pool)
        .await
        .unwrap();
    let result = data_agent::use_cases::knowledge::process_index(&fixture.pool).await;
    sqlx::query("ALTER TABLE knowledge_objects RENAME COLUMN unavailable_body TO body")
        .execute(&fixture.pool)
        .await
        .unwrap();
    let state = fixture.source_state(id).await;
    let after = fixture.stub.sends();
    fixture.finish().await;
    assert_eq!(state, ("pending".into(), 1, None, None));
    assert_eq!(after, sent, "读取失败不能增加派发或索引尝试");
    assert_eq!(result.unwrap_err().code, "unavailable");
}
