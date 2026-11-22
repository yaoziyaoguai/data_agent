use data_agent::{
    contracts,
    modules::{
        ingestion::{self, preparation},
        jobs, knowledge, runtime,
    },
    persistence::AppTx,
    types::AccessContext,
};
use serde_json::{Value, json};
use sqlx::MySqlPool;

async fn harness_pool() -> MySqlPool {
    let url = std::env::var("DATA_AGENT_DATABASE_URL").expect("isolated harness database");
    assert!(
        url.contains("/data_agent_test_"),
        "must use the isolated harness"
    );
    sqlx::mysql::MySqlPoolOptions::new()
        .max_connections(4)
        .connect(&url)
        .await
        .unwrap()
}

#[tokio::test]
async fn prefill_review_uses_frozen_tail_without_fetching_source_text_again() {
    let pool = harness_pool().await;
    let ctx = AccessContext {
        user_id: "alice".into(),
        space_id: "demo".into(),
        request_id: "frozen-review-tail".into(),
        table_access: None,
    };
    let body = format!(
        "首部规则：金额以元保存。\n{}中段规则：按付款日归属。\n{}原文尾部例外：退款拒收不计入。\n",
        "普通说明。\n".repeat(1000),
        "普通说明。\n".repeat(1000)
    );
    let target = json!({"id":"frozen-review-target","kind":"term","name":"合成冻结复核","version":"1","state":"enabled",
        "source_id":null,"source_version":"0","related_ids":[],"updated_by":"alice","owner_id":"alice",
        "entries":[{"entry_id":"meaning","path":"meaning","label":"含义","source_facts":{},"suggestion":{},
            "human_override":null,"effective_value":"待分析定义","review_state":"unverified"}]});
    let document = json!({"id":"frozen-review-document","kind":"document","name":"冻结复核合成原文","version":"1","state":"enabled",
        "source_id":null,"source_version":"0","related_ids":["frozen-review-target"],"updated_by":"alice","owner_id":"alice",
        "entries":[{"entry_id":"body","path":"body","label":"正文","source_facts":{},"suggestion":{},
            "human_override":{"value":body},"effective_value":body,"review_state":"verified"}]});
    let mut tx = AppTx::begin(&pool).await.unwrap();
    knowledge::seed_in_tx(&mut tx, &ctx, &json!({"objects":[target,document]}))
        .await
        .unwrap();
    let material = json!({"sources":[]});
    ingestion::queue_prefill_in_tx(&mut tx, &ctx, &target, &material)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert!(
        data_agent::use_cases::semantic_prefill::process_due(&pool)
            .await
            .unwrap()
    );
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let status = ingestion::prefill_status_in_tx(&mut tx, &ctx, "frozen-review-target")
        .await
        .unwrap();
    assert_eq!(
        status["state"], "succeeded",
        "冻结后复核不再依赖正文存储，且仍完成两阶段核验：{status}"
    );
    let saved = knowledge::read_in_tx(&mut tx, &ctx, "frozen-review-target", None, true)
        .await
        .unwrap();
    assert!(
        saved["entries"][0]["suggestion"]["evidence"]
            .as_array()
            .unwrap()
            .iter()
            .any(|evidence| evidence["quote"] == "原文尾部例外：退款拒收不计入。")
    );
    tx.commit().await.unwrap();
    pool.close().await;
}

#[tokio::test]
async fn prefill_legacy_truncation_keeps_original_total_and_unread_ranges() {
    let pool = harness_pool().await;
    let ctx = AccessContext {
        user_id: "alice".into(),
        space_id: "demo".into(),
        request_id: "frozen-review-legacy".into(),
        table_access: None,
    };
    let prefix = format!("首部规则：金额以元保存。\n{}", "普通说明。\n".repeat(1000));
    let body = format!(
        "{prefix}{}未读最终例外：只用于人工后续调查。\n",
        "边界合成🧪e\u{301}。\n".repeat(6000)
    );
    let target = json!({"id":"frozen-review-legacy-target","kind":"term","name":"合成旧作业冻结复核","version":"1","state":"enabled",
        "source_id":null,"source_version":"0","related_ids":[],"updated_by":"alice","owner_id":"alice",
        "entries":[{"entry_id":"meaning","path":"meaning","label":"含义","source_facts":{},"suggestion":{},
            "human_override":null,"effective_value":"待分析定义","review_state":"unverified"}]});
    let document = json!({"id":"frozen-review-legacy-document","kind":"document","name":"旧作业超长合成原文","version":"1","state":"enabled",
        "source_id":null,"source_version":"0","related_ids":["frozen-review-legacy-target"],"updated_by":"alice","owner_id":"alice",
        "entries":[{"entry_id":"body","path":"body","label":"正文","source_facts":{},"suggestion":{},
            "human_override":{"value":body},"effective_value":body,"review_state":"verified"}]});
    let material = json!({"sources":[{"source_id":"document-frozen-review-legacy-document","version":"1","body":prefix,
        "complete":false,"source_complete":true,"body_range":{"start_byte":0,"end_byte":prefix.len(),"start_line":1,"total_bytes":body.len()}}],
        "coverage":{"state":"incomplete","gaps":[{"source_id":"document-frozen-review-legacy-document","reason":"body_limit",
            "included_bytes":prefix.len(),"total_bytes":body.len()}]}});
    let mut tx = AppTx::begin(&pool).await.unwrap();
    knowledge::seed_in_tx(&mut tx, &ctx, &json!({"objects":[target,document]}))
        .await
        .unwrap();
    ingestion::queue_prefill_in_tx(&mut tx, &ctx, &target, &material)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert!(
        data_agent::use_cases::semantic_prefill::process_due(&pool)
            .await
            .unwrap()
    );
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let status = ingestion::prefill_status_in_tx(&mut tx, &ctx, "frozen-review-legacy-target")
        .await
        .unwrap();
    assert_eq!(
        status["state"], "succeeded",
        "旧裁剪输入在首次调用前冻结补料且不冒充全文：{status}"
    );
    let saved = knowledge::read_in_tx(&mut tx, &ctx, "frozen-review-legacy-target", None, true)
        .await
        .unwrap();
    let ranges = &saved["entries"][0]["suggestion"]["material_coverage"]["source_ranges"][0];
    assert_eq!(ranges["total_bytes"], body.len());
    assert!(ranges["seen_byte_ranges"][0]["end"].as_u64().unwrap() < body.len() as u64);
    assert!(
        saved["entries"][0]["suggestion"]["evidence"]
            .as_array()
            .unwrap()
            .iter()
            .any(|evidence| evidence["quote"] == "边界合成🧪e\u{301}。")
    );
    tx.commit().await.unwrap();
    pool.close().await;
}

#[tokio::test]
async fn terminal_prefill_releases_only_temporary_material_and_keeps_late_usage_identity() {
    let pool = harness_pool().await;
    let ctx = AccessContext {
        user_id: "alice".into(),
        space_id: "frozen-prefill-terminal".into(),
        request_id: "frozen-prefill-terminal".into(),
        table_access: None,
    };
    let profile = contracts::decode("ModelProfile", json!({
        "provider_id":"deepseek","model_id":"deepseek-flash","trial_id":"frozen-prefill-terminal-trial",
        "price_version":"2026-10-04-peak-usd","input_limit":32768,"output_limit":2048,
        "trial_call_limit":12,"trial_cost_micros":"5000000","request_call_limit":12,"toolset":"data",
        "payload_bytes_limit":65536
    })).unwrap();
    runtime::configure_trial(&pool, &profile).await.unwrap();
    let coverage = json!({"state":"incomplete","gaps":[{"reason":"body_limit","source_id":"synthetic-rule"}],
        "source_ranges":[{"source_id":"synthetic-rule","version":"1","total_bytes":60000,
            "visible_byte_ranges":[{"start":24576,"end":49152}],"seen_byte_ranges":[{"start":0,"end":49152}]}]});
    let analysis = json!({"entries":[{"entry_id":"meaning","value":"原分析结果必须保留。","gaps":[],
        "evidence":[{"source_id":"synthetic-rule","version":"1","location":"原文首行","quote":"必要原引文。"}]}]});
    let review_input = json!({"sources":[{"source_id":"synthetic-rule","version":"1","body":"临时复核正文。"}],"coverage":coverage});
    for (index, state) in ["succeeded", "invalid_prefill", "unknown", "expired"]
        .into_iter()
        .enumerate()
    {
        let object = json!({"id":format!("terminal-prefill-{state}"),"version":"1","kind":"term","name":"合成规则",
            "entries":[{"entry_id":"meaning","path":"meaning","effective_value":"待分析旧正文。"}]});
        let material = json!({"sources":[{"source_id":"synthetic-rule","version":"1","body":"临时首轮正文。",
            "body_range":{"start_byte":0,"end_byte":24576,"total_bytes":60000},"source_complete":true,"complete":false}],
            "coverage":coverage,"frozen_review_sources":[{"source_id":"synthetic-rule","version":"1","body":"私有冻结正文。"}]});
        let mut tx = AppTx::begin(&pool).await.unwrap();
        ingestion::queue_prefill_in_tx(&mut tx, &ctx, &object, &material)
            .await
            .unwrap();
        let claimed = ingestion::claim_prefill_in_tx(&mut tx, &ctx.space_id)
            .await
            .unwrap()
            .unwrap();
        let attempt = claimed["id"].as_str().unwrap().to_owned();
        runtime::reserve_maintenance_in_tx(&mut tx, &attempt, &profile)
            .await
            .unwrap();
        ingestion::record_prefill_draft_in_tx(&mut tx, &attempt, &analysis, &review_input)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        if state == "expired" {
            sqlx::query("UPDATE prefill_attempts SET issued_until=TIMESTAMPADD(SECOND,-1,UTC_TIMESTAMP(3)) WHERE id=?")
                .bind(&attempt).execute(&pool).await.unwrap();
            let mut tx = AppTx::begin(&pool).await.unwrap();
            assert!(
                ingestion::claim_prefill_in_tx(&mut tx, &ctx.space_id)
                    .await
                    .unwrap()
                    .is_none()
            );
            tx.commit().await.unwrap();
        } else {
            let mut tx = AppTx::begin(&pool).await.unwrap();
            ingestion::finish_prefill_in_tx(
                &mut tx,
                &attempt,
                state,
                &json!({"analysis":analysis,"review_input":review_input,"review":{"entries":[]}}),
                (state != "succeeded").then_some("model_unknown"),
            )
            .await
            .unwrap();
            tx.commit().await.unwrap();
        }
        let stored = sqlx::query_scalar::<_, sqlx::types::Json<Value>>(
            "SELECT JSON_OBJECT('input',input_json,'result',result_json,'state',state,'fingerprint',input_fingerprint) FROM prefill_attempts WHERE id=?")
            .bind(&attempt).fetch_one(&pool).await.unwrap().0;
        assert_eq!(
            stored["state"],
            if state == "expired" { "unknown" } else { state }
        );
        assert!(
            stored["input"].get("frozen_review_sources").is_none(),
            "{state}:私有冻结正文在实际终态释放"
        );
        assert!(
            stored["input"]["sources"][0].get("body").is_none(),
            "{state}:首轮临时正文在实际终态释放"
        );
        assert_eq!(stored["input"]["coverage"], coverage);
        assert_eq!(stored["input"]["sources"][0]["source_id"], "synthetic-rule");
        assert_eq!(stored["input"]["sources"][0]["version"], "1");
        assert!(
            stored["input"]["object"].get("entries").is_none(),
            "{state}:旧目标条目正文不成为历史全文副本"
        );
        assert_eq!(
            stored["result"]["analysis"], analysis,
            "{state}:分析结果及原引文保留"
        );
        assert_eq!(stored["result"]["material_coverage"], coverage);
        assert!(stored["result"].get("review_input").is_none());
        assert_eq!(stored["fingerprint"].as_str().unwrap().len(), 64);
        let call = sqlx::query_scalar::<_, sqlx::types::Json<Value>>(
            "SELECT JSON_OBJECT('id',id,'state',state,'reserved',reserved_micros) FROM maintenance_model_calls WHERE id=?")
            .bind(&attempt).fetch_one(&pool).await.unwrap().0;
        assert_eq!(call["id"], attempt);
        assert_eq!(call["state"], "issued", "终态正文清理不释放未知费用预留");
        assert!(call["reserved"].as_u64().unwrap() > 0);
        let mut tx = AppTx::begin(&pool).await.unwrap();
        runtime::settle_maintenance_in_tx(
            &mut tx,
            &attempt,
            &profile,
            &json!({"prompt_tokens":100,"completion_tokens":10}),
        )
        .await
        .unwrap();
        let status = ingestion::prefill_status_in_tx(&mut tx, &ctx, object["id"].as_str().unwrap())
            .await
            .unwrap();
        assert_eq!(status["attempt_id"], attempt);
        assert_eq!(
            status["state"], stored["state"],
            "晚到usage沿原调用结算，不重开原作业"
        );
        assert!(
            ingestion::claim_prefill_in_tx(&mut tx, &ctx.space_id)
                .await
                .unwrap()
                .is_none()
        );
        tx.commit().await.unwrap();
        let trial = sqlx::query_scalar::<_, sqlx::types::Json<Value>>(
            "SELECT JSON_OBJECT('calls',allocated_calls,'reserved',reserved_micros) FROM model_trials WHERE id='frozen-prefill-terminal-trial'")
            .fetch_one(&pool).await.unwrap().0;
        assert_eq!(trial["calls"], (index + 1) as u64);
        assert_eq!(trial["reserved"], 0);
    }
    pool.close().await;
}

#[tokio::test]
async fn expired_preparation_releases_frozen_text_without_reopening_unknown_calls() {
    let pool = harness_pool().await;
    let expired = "frozen-preparation-expired";
    let applying = "frozen-preparation-applying";
    let active = "frozen-preparation-active";
    let frozen = json!({"segments":[{"text":"仅供本批分析与复核的合成正文。"}],
        "coverage":{"batch_start":0,"batch_segments":1,"batch_chars":17,"final_batch":true}});
    let mut tx = AppTx::begin(&pool).await.unwrap();
    for source in [expired, applying, active] {
        preparation::ensure_preparation_in_tx(&mut tx, "demo", source, 1, "input-fp", "dep-fp")
            .await
            .unwrap();
        preparation::begin_batch_in_tx(&mut tx, source, 1, &frozen, "dep-fp", 60)
            .await
            .unwrap();
    }
    preparation::stage_draft_in_tx(&mut tx, applying, 1, &json!({"statements":[]}), 60)
        .await
        .unwrap();
    preparation::stage_apply_in_tx(&mut tx, applying, 1, &json!({"statements":[]}))
        .await
        .unwrap();
    tx.commit().await.unwrap();
    // 只在隔离夹具推进时间；行为由公开过期清扫与读取接口验证。
    sqlx::query("UPDATE source_preparations SET issued_until=TIMESTAMPADD(SECOND,-1,UTC_TIMESTAMP(3)) WHERE source_id=?")
        .bind(expired).execute(&pool).await.unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    preparation::expire_issued_preparations_in_tx(&mut tx)
        .await
        .unwrap();
    let unknown = preparation::read_preparation_in_tx(&mut tx, "demo", expired, 1)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(unknown["call_state"], "unknown");
    assert_eq!(unknown["error_code"], "model_unknown");
    assert!(
        unknown["frozen_batch"].is_null(),
        "unknown不会续用本批正文，应在过期清扫时释放"
    );
    assert_eq!(unknown["input_fingerprint"], "input-fp");
    assert_eq!(unknown["dependency_fingerprint"], "dep-fp");
    assert_eq!(unknown["batch_sequence"], 1);
    assert_eq!(unknown["segments_read"], 0);
    assert_eq!(unknown["covered_chars"], 0);
    assert_eq!(
        preparation::begin_batch_in_tx(&mut tx, expired, 1, &frozen, "dep-fp", 60)
            .await
            .unwrap_err()
            .code,
        "version_conflict"
    );
    preparation::supersede_preparation_in_tx(&mut tx, expired, 1)
        .await
        .unwrap();
    assert_eq!(
        preparation::read_preparation_in_tx(&mut tx, "demo", expired, 1)
            .await
            .unwrap()
            .unwrap(),
        unknown,
        "来源失效或改版不能改写已知unknown事实或重开原调用"
    );
    for source in [applying, active] {
        let retained = preparation::read_preparation_in_tx(&mut tx, "demo", source, 1)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            retained["frozen_batch"], frozen,
            "合法在途和applying恢复仍需要冻结正文"
        );
    }
    tx.commit().await.unwrap();
    pool.close().await;
}

#[tokio::test]
async fn resumed_preparation_releases_invalid_source_material_and_applies_enabled_source() {
    let pool = harness_pool().await;
    let ctx = AccessContext {
        user_id: "alice".into(),
        space_id: "demo".into(),
        request_id: "frozen-preparation-source-retired".into(),
        table_access: None,
    };
    let profile = contracts::decode(
        "ModelProfile",
        json!({
            "provider_id":"deepseek","model_id":"deepseek-flash","trial_id":"frozen-source-retired-trial",
            "price_version":"2026-10-04-peak-usd","input_limit":32768,"output_limit":2048,
            "trial_call_limit":12,"trial_cost_micros":"5000000","request_call_limit":12,
            "toolset":"data","payload_bytes_limit":65536
        }),
    )
    .unwrap();
    runtime::configure_trial(&pool, &profile).await.unwrap();
    for state in ["disabled", "deleted", "enabled"] {
        let body = "合成整理恢复规则：金额以元保存，退款拒收不计入。";
        let document = data_agent::use_cases::knowledge::edit(
            &pool,
            &ctx,
            None,
            "create",
            json!({"operation_id":format!("create-frozen-source-{state}"),"kind":"document",
                "name":format!("合成{state}恢复原文"),"body":body,"related_ids":[]}),
        )
        .await
        .unwrap();
        let document_id = document["id"].as_str().unwrap();
        let source = format!("document-{document_id}");
        let revision = document["version"]
            .as_str()
            .unwrap()
            .parse::<u64>()
            .unwrap();
        let job =
            jobs::claim_source_work(&pool, "interrupted-preparation", 60_000, "prepare_source")
                .await
                .unwrap()
                .unwrap();
        assert_eq!(job.resource_id, source);
        assert_eq!(job.resource_version, Some(revision));
        let output =
            json!({"statements":[],"relations":[],"unresolved":[],"semantic_status":"ready"});
        let input_fingerprint = data_agent::types::fingerprint(&json!([source, revision, body]));
        let mut tx = AppTx::begin(&pool).await.unwrap();
        jobs::begin_attempt_in_tx(&mut tx, &job.lease)
            .await
            .unwrap();
        let objects = knowledge::source_objects_in_tx(&mut tx, &ctx, &source)
            .await
            .unwrap();
        let dependency = preparation::dependency_fingerprint(&objects);
        let frozen = json!({"source":{"kind":"document","id":document_id},"revision":revision.to_string(),
            "segments":[{"citation":{"source":{"kind":"document","id":document_id},
                "revision":revision.to_string(),"locator":{"offset":0,"length":body.chars().count()}},
                "text":body,"background":[]}],"objects":objects,"next_cursor":null,
            "coverage":{"batch_start":0,"batch_segments":1,"batch_chars":body.chars().count(),"final_batch":true}});
        preparation::validate_preparation_output(
            &frozen["source"],
            &revision.to_string(),
            &frozen,
            &output,
        )
        .unwrap();
        preparation::ensure_preparation_in_tx(
            &mut tx,
            &ctx.space_id,
            &source,
            revision,
            &input_fingerprint,
            &dependency,
        )
        .await
        .unwrap();
        preparation::begin_batch_in_tx(&mut tx, &source, revision, &frozen, &dependency, 60)
            .await
            .unwrap();
        let analysis_call = preparation::analysis_call_id(&source, revision, 1);
        let review_call = preparation::review_call_id(&source, revision, 1);
        runtime::reserve_maintenance_in_tx(&mut tx, &analysis_call, &profile)
            .await
            .unwrap();
        runtime::settle_maintenance_in_tx(
            &mut tx,
            &analysis_call,
            &profile,
            &json!({"prompt_tokens":100,"completion_tokens":10}),
        )
        .await
        .unwrap();
        preparation::stage_draft_in_tx(&mut tx, &source, revision, &output, 60)
            .await
            .unwrap();
        runtime::reserve_maintenance_in_tx(&mut tx, &review_call, &profile)
            .await
            .unwrap();
        runtime::settle_maintenance_in_tx(
            &mut tx,
            &review_call,
            &profile,
            &json!({"prompt_tokens":100,"completion_tokens":10}),
        )
        .await
        .unwrap();
        preparation::stage_apply_in_tx(&mut tx, &source, revision, &output)
            .await
            .unwrap();
        let before = preparation::read_preparation_in_tx(&mut tx, &ctx.space_id, &source, revision)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(before["call_state"], "applying");
        assert_eq!(before["frozen_batch"], frozen);
        assert_eq!(before["pending_draft"], output);
        tx.commit().await.unwrap();
        if state != "enabled" {
            data_agent::use_cases::knowledge::edit(
                &pool, &ctx, Some(document_id), state,
                json!({"operation_id":format!("retire-frozen-source-{state}"),"expected_version":document["version"]}),
            ).await.unwrap();
        }
        let calls_before = sqlx::query_scalar::<_, sqlx::types::Json<Value>>(
            "SELECT JSON_OBJECT('id',id,'trial',trial_id,'state',state,'reserved',reserved_micros,'usage',usage_json) FROM maintenance_model_calls WHERE trial_id=? ORDER BY id")
            .bind(&profile.trial_id).fetch_all(&pool).await.unwrap();
        let budget_before = sqlx::query_scalar::<_, sqlx::types::Json<Value>>(
            "SELECT JSON_OBJECT('calls',allocated_calls,'spent',spent_micros,'reserved',reserved_micros,'state',state) FROM model_trials WHERE id=?")
            .bind(&profile.trial_id).fetch_one(&pool).await.unwrap().0;
        // 仅推进隔离库的旧租约；恢复仍须重领同一作业、沿原已提交成果应用。
        sqlx::query("UPDATE background_jobs SET lease_until=TIMESTAMPADD(SECOND,-1,UTC_TIMESTAMP(3)) WHERE id=?")
            .bind(&job.lease.id).execute(&pool).await.unwrap();
        assert!(
            data_agent::use_cases::source_preparation::process_due(&pool)
                .await
                .unwrap()
        );
        let mut tx = AppTx::begin(&pool).await.unwrap();
        assert_eq!(
            jobs::latest_source_job_state_in_tx(&mut tx, "prepare_source", &source, revision)
                .await
                .unwrap()
                .as_deref(),
            Some("finished")
        );
        let after = preparation::read_preparation_in_tx(&mut tx, &ctx.space_id, &source, revision)
            .await
            .unwrap()
            .unwrap();
        assert!(
            after["frozen_batch"].is_null(),
            "{state}:实际终态必须释放本批冻结正文：{after}"
        );
        assert!(
            after["pending_draft"].is_null(),
            "{state}:实际终态不保留待应用材料"
        );
        assert!(after["call_state"].is_null());
        for field in [
            "input_fingerprint",
            "dependency_fingerprint",
            "batch_sequence",
            "unresolved",
        ] {
            assert_eq!(after[field], before[field], "{state}:保留原{field}");
        }
        if state == "enabled" {
            assert_eq!(
                after["semantic_status"], "ready",
                "启用来源仍能应用已保存成果"
            );
            assert_eq!(after["segments_read"], 1);
            assert_eq!(after["covered_chars"], body.chars().count());
        } else {
            assert!(
                ["failed", "superseded"].contains(&after["semantic_status"].as_str().unwrap()),
                "{state}:来源已失效的准备行须收敛终态"
            );
            for field in ["segment_cursor", "segments_read", "covered_chars"] {
                assert_eq!(after[field], before[field], "{state}:不得伪造覆盖进度");
            }
        }
        tx.commit().await.unwrap();
        let resumed = sqlx::query_scalar::<_, sqlx::types::Json<Value>>(
            "SELECT JSON_OBJECT('id',id,'epoch',lease_epoch,'attempts',attempts,'state',state) FROM background_jobs WHERE kind='prepare_source' AND resource_id=? AND resource_version=?")
            .bind(&source).bind(revision).fetch_one(&pool).await.unwrap().0;
        assert_eq!(resumed["id"], job.lease.id);
        assert_eq!(resumed["epoch"], job.lease.lease_epoch + 1);
        assert_eq!(resumed["attempts"], 1, "恢复不清零原尝试次数");
        let calls_after = sqlx::query_scalar::<_, sqlx::types::Json<Value>>(
            "SELECT JSON_OBJECT('id',id,'trial',trial_id,'state',state,'reserved',reserved_micros,'usage',usage_json) FROM maintenance_model_calls WHERE trial_id=? ORDER BY id")
            .bind(&profile.trial_id).fetch_all(&pool).await.unwrap();
        assert_eq!(
            calls_after, calls_before,
            "{state}:不重发分析或复核，也不改原调用账本"
        );
        let budget_after = sqlx::query_scalar::<_, sqlx::types::Json<Value>>(
            "SELECT JSON_OBJECT('calls',allocated_calls,'spent',spent_micros,'reserved',reserved_micros,'state',state) FROM model_trials WHERE id=?")
            .bind(&profile.trial_id).fetch_one(&pool).await.unwrap().0;
        assert_eq!(budget_after, budget_before, "{state}:原预算与费用保持");
        assert!(
            !data_agent::use_cases::source_preparation::process_due(&pool)
                .await
                .unwrap(),
            "不重领已结束作业"
        );
    }
    pool.close().await;
}
