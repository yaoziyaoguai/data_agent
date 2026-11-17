use data_agent::{
    contracts,
    modules::knowledge,
    persistence::{self, AppTx},
    types::AccessContext,
};
use serde_json::json;
use sqlx::{MySqlPool, Row};

// 扇出修复链对终态failed准备的真实重排：非unknown失败（重试耗尽/成果不合法，
// 调用已结算或从未发起）复位后其作业必须重新排队，否则行停在pending冒充待处理；
// model_unknown终态（结果不确定、预算预留保留）不得被复位或重排，不自动重整。
static SERIAL: std::sync::LazyLock<tokio::sync::Mutex<()>> =
    std::sync::LazyLock::new(|| tokio::sync::Mutex::new(()));

async fn harness_pool() -> MySqlPool {
    persistence::connect(
        &std::env::var("DATA_AGENT_DATABASE_URL").expect("isolated harness database"),
    )
    .await
    .unwrap()
}

// 生产保存组合：模块保存（或整理应用）＋保存后跨模块登记同事务执行；
// 扇出作业由组合层登记，测试按同组合驱动。
async fn register_saved_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    saved: &[serde_json::Value],
) {
    data_agent::use_cases::dependency_registration::after_content_saved_in_tx(tx, ctx, saved)
        .await
        .unwrap();
}

// 构造：source_heads v2 + prepare_source 作业置终态 + 指定错误码的failed准备行，
// C 的陈述引用该来源v2并支持引用B，clear_override 后成为有效依赖；B改版触发扇出。
async fn arrange(pool: &MySqlPool, source: &str, error_code: Option<&str>, job_state: &str) {
    let ctx = AccessContext {
        user_id: "alice".into(),
        space_id: "demo".into(),
        request_id: format!("fanout-recovery-{source}"),
    };
    sqlx::query("INSERT INTO source_heads(id,space_id,version,fingerprint) VALUES(?,?,?,?)")
        .bind(source)
        .bind(&ctx.space_id)
        .bind(2u64)
        .bind(format!("{source}-fingerprint"))
        .execute(pool)
        .await
        .unwrap();
    let mut tx = AppTx::begin(pool).await.unwrap();
    data_agent::modules::jobs::enqueue_source_in_tx(&mut tx, "prepare_source", source, 2)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    sqlx::query("UPDATE background_jobs SET state=? WHERE kind='prepare_source' AND resource_id=?")
        .bind(job_state)
        .bind(source)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO source_preparations(source_id,space_id,revision,method_version,input_fingerprint,dependency_fingerprint,unresolved,semantic_status,error_code,call_state) VALUES(?,?,?,?,?,?,CAST('[]' AS JSON),'failed',?,NULL)",
    )
    .bind(source)
    .bind(&ctx.space_id)
    .bind(2u64)
    .bind(data_agent::modules::ingestion::preparation::PREPARATION_METHOD)
    .bind(format!("{source}-input"))
    .bind(format!("{source}-dependency"))
    .bind(error_code)
    .execute(pool)
    .await
    .unwrap();

    let mut tx = AppTx::begin(pool).await.unwrap();
    let depended = knowledge::create_in_tx(
        &mut tx,
        &ctx,
        &json!({"operation_id":format!("create-depended-{source}"),"kind":"term","name":"被依赖口径",
            "body":"被依赖内容","related_ids":[],"source_url":null,"structured_value":null}),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let depended_id = depended["id"].as_str().unwrap().to_owned();
    let mut tx = AppTx::begin(pool).await.unwrap();
    let citing = knowledge::create_in_tx(
        &mut tx,
        &ctx,
        &json!({"operation_id":format!("create-citing-{source}"),"kind":"term","name":"引用方口径",
            "body":"引用方初稿","related_ids":[],"source_url":null,"structured_value":null}),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let citing_id = citing["id"].as_str().unwrap().to_owned();
    let mut tx = AppTx::begin(pool).await.unwrap();
    let prepared = knowledge::apply_preparation_in_tx(
        &mut tx,
        &ctx,
        &format!("apply-citing-{source}"),
        &contracts::decode("SourceKey", json!({"kind":"platform","id":source})).unwrap(),
        "2",
        &json!({"statements":[{"key":"citing-rule",
            "target":{"object_id":citing_id,"version":"1","path":"body"},
            "text":"引用方陈述","scope_text":"",
            "citations":[{"source":{"kind":"platform","id":source},"revision":"2","locator":{"offset":0,"length":6}}],
            "supports":[{"key":"precondition","role":"prerequisite",
                "reference":{"kind":"knowledge","ref":{"object_id":depended_id,"version":"1","path":"body"}},
                "content":"被依赖口径是本陈述的前提","embedded_in":null}]}],
            "relations":[],"unresolved":[],"semantic_status":"ready"}),
    )
    .await
    .unwrap();
    register_saved_in_tx(&mut tx, &ctx, &prepared).await;
    tx.commit().await.unwrap();
    let mut tx = AppTx::begin(pool).await.unwrap();
    let citing_cleared = knowledge::save_edit_in_tx(
        &mut tx,
        &ctx,
        &citing_id,
        &json!({"operation_id":format!("clear-citing-{source}"),"expected_version":"2",
            "entry_id":"body","clear_override":true}),
        None,
    )
    .await
    .unwrap();
    register_saved_in_tx(&mut tx, &ctx, std::slice::from_ref(&citing_cleared)).await;
    tx.commit().await.unwrap();

    let mut tx = AppTx::begin(pool).await.unwrap();
    let depended_edited = knowledge::save_edit_in_tx(
        &mut tx,
        &ctx,
        &depended_id,
        &json!({"operation_id":format!("edit-depended-{source}"),"expected_version":"1",
            "entry_id":"body","value":"被依赖口径已改版","structured_value":null}),
        None,
    )
    .await
    .unwrap();
    register_saved_in_tx(&mut tx, &ctx, std::slice::from_ref(&depended_edited)).await;
    tx.commit().await.unwrap();
}

async fn preparation_and_job(
    pool: &MySqlPool,
    source: &str,
) -> ((String, Option<String>), Option<String>) {
    let prep_row = sqlx::query(
        "SELECT semantic_status,call_state FROM source_preparations WHERE source_id=? AND revision=2",
    )
    .bind(source)
    .fetch_one(pool)
    .await
    .unwrap();
    let prep = (
        prep_row.get::<String, _>("semantic_status"),
        prep_row.get::<Option<String>, _>("call_state"),
    );
    let job = sqlx::query(
        "SELECT state FROM background_jobs WHERE kind='prepare_source' AND resource_id=? AND resource_version=2",
    )
    .bind(source)
    .fetch_optional(pool)
    .await
    .unwrap()
    .map(|row| row.get::<String, _>("state"));
    (prep, job)
}

#[tokio::test]
async fn fanout_reopens_settled_failures_and_requeues_their_work() {
    let _guard = SERIAL.lock().await;
    let pool = harness_pool().await;
    // 非unknown失败：调用侧已结算（如成果两次不合法），依赖失效后必须真重整。
    arrange(
        &pool,
        "fanout-recovery-settled",
        Some("model_error"),
        "failed",
    )
    .await;
    for _ in 0..16 {
        if !data_agent::use_cases::source_fanout::process_due(&pool)
            .await
            .unwrap()
        {
            break;
        }
    }
    let ((status, call), job) = preparation_and_job(&pool, "fanout-recovery-settled").await;
    assert_eq!(status, "pending", "已结算的failed准备被复位重整");
    assert_eq!(call, None, "复位后无在途调用");
    assert_eq!(
        job.as_deref(),
        Some("queued"),
        "复位后的failed作业必须重新排队，否则扇出修复链断裂"
    );
}

#[tokio::test]
async fn fanout_leaves_unknown_terminated_preparations_untouched() {
    let _guard = SERIAL.lock().await;
    let pool = harness_pool().await;
    // model_unknown终态：结果不确定的回执预算预留保留，扇出不得复位重排，
    // 否则以新调用身份自动重发违反unknown纪律。
    arrange(
        &pool,
        "fanout-recovery-unknown",
        Some("model_unknown"),
        "failed",
    )
    .await;
    for _ in 0..16 {
        if !data_agent::use_cases::source_fanout::process_due(&pool)
            .await
            .unwrap()
        {
            break;
        }
    }
    let ((status, call), job) = preparation_and_job(&pool, "fanout-recovery-unknown").await;
    assert_eq!(status, "failed", "unknown终态不被扇出复位");
    assert_eq!(call, None);
    let error = sqlx::query(
        "SELECT error_code FROM source_preparations WHERE source_id='fanout-recovery-unknown' AND revision=2",
    )
    .fetch_one(&pool)
    .await
    .unwrap()
    .get::<Option<String>, _>("error_code")
    .unwrap();
    assert_eq!(error, "model_unknown", "unknown错误码保留，不冒充其他失败");
    assert_eq!(
        job.as_deref(),
        Some("failed"),
        "unknown作业不重排，不自动重整"
    );
}
