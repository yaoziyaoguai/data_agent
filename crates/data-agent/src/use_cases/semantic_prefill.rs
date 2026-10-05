use crate::{
    contracts,
    modules::{access, ingestion, knowledge, runtime},
    persistence::AppTx,
    types::{AccessContext, Error, Result, epoch, id},
};
use serde_json::{Value, json};
use sqlx::MySqlPool;

// 固定分析与依据复核各一次；没有Agent规划循环，网络与业务提交分开。
pub async fn process_due(pool: &MySqlPool) -> Result<bool> {
    let ctx = AccessContext {
        user_id: "synthetic-prefill".into(),
        space_id: "demo".into(),
        request_id: id(),
    };
    let mut tx = AppTx::begin(pool).await?;
    let Some(mut job) = ingestion::claim_prefill_in_tx(&mut tx, &ctx.space_id).await? else {
        tx.commit().await?;
        return Ok(false);
    };
    let attempt_id = job["id"]
        .as_str()
        .ok_or(Error::new("invalid_input"))?
        .to_owned();
    let attempt = attempt_id.as_str();
    // 领取事务只碰任务队列，不能持有队列锁再等待来源同步/知识写入。
    tx.commit().await?;
    if job["input"].get("coverage").is_none() {
        let mut tx = AppTx::begin(pool).await?;
        let prepared = async {
            check_current_in_tx(&mut tx, &ctx, &job).await?;
            let mut material = super::prefill_materials::collect_in_tx(
                &mut tx,
                &ctx,
                &job["input"]["object"],
                job["input"]["sources"]
                    .as_array()
                    .ok_or(Error::new("invalid_input"))?
                    .clone(),
            )
            .await?;
            material["object"] = job["input"]["object"].clone();
            super::prefill_materials::check_in_tx(&mut tx, &ctx, &material).await?;
            ingestion::freeze_prefill_input_in_tx(&mut tx, attempt, &material).await?;
            Ok::<Value, Error>(material)
        }
        .await;
        match prepared {
            Ok(material) => job["input"] = material,
            Err(error) => {
                ingestion::finish_prefill_in_tx(
                    &mut tx,
                    attempt,
                    error_state(&error),
                    &Value::Null,
                    Some(error.code),
                )
                .await?;
                tx.commit().await?;
                return Ok(true);
            }
        }
        tx.commit().await?;
    }
    let prepared = prepare(&job);
    let (profile, request) = match prepared {
        Ok(v) => v,
        Err(error) => {
            finish_error(pool, attempt, &error).await?;
            return Ok(true);
        }
    };
    if let Err(error) = runtime::configure_trial(pool, &profile).await {
        finish_error(pool, attempt, &error).await?;
        return Ok(true);
    }
    let mut tx = AppTx::begin(pool).await?;
    let ready = match check_current_in_tx(&mut tx, &ctx, &job).await {
        Ok(()) => ingestion::assert_prefill_active_in_tx(&mut tx, attempt).await,
        Err(error) => Err(error),
    };
    let ready = match ready {
        Ok(()) => runtime::reserve_maintenance_in_tx(&mut tx, attempt, &profile).await,
        Err(error) => Err(error),
    };
    if let Err(error) = ready {
        ingestion::finish_prefill_in_tx(
            &mut tx,
            attempt,
            error_state(&error),
            &Value::Null,
            Some(error.code),
        )
        .await?;
        tx.commit().await?;
        return Ok(true);
    }
    tx.commit().await?;
    let response = request.analyze().await;
    let mut tx = AppTx::begin(pool).await?;
    let (draft, usage) = match response {
        Ok(result) => result,
        Err(error) => {
            ingestion::finish_prefill_in_tx(
                &mut tx,
                attempt,
                "unknown",
                &Value::Null,
                Some(error.code),
            )
            .await?;
            tx.commit().await?;
            return Ok(true);
        }
    };
    let settled = runtime::settle_maintenance_in_tx(&mut tx, attempt, &profile, &usage).await;
    // 已收到的用量独立落账；后续来源/版本冲突不能回滚结算，也不持trial锁等来源锁。
    tx.commit().await?;
    let mut tx = AppTx::begin(pool).await?;
    let valid = settled.and(ingestion::prefill::validate_result(&job["input"], &draft).map(|_| ()));
    let ready = match valid {
        Ok(()) => check_current_in_tx(&mut tx, &ctx, &job).await,
        Err(error) => Err(error),
    };
    if let Err(error) = ready {
        ingestion::finish_prefill_in_tx(
            &mut tx,
            attempt,
            error_state(&error),
            &json!({"analysis":draft}),
            Some(error.code),
        )
        .await?;
        tx.commit().await?;
        return Ok(true);
    }
    // 只有合法且仍适用的草稿进入复核；失败不得把第一轮当成成功建议应用。
    if let Err(error) = ingestion::record_prefill_draft_in_tx(&mut tx, attempt, &draft).await {
        ingestion::finish_prefill_in_tx(
            &mut tx,
            attempt,
            error_state(&error),
            &json!({"analysis":draft}),
            Some(error.code),
        )
        .await?;
        tx.commit().await?;
        return Ok(true);
    }
    tx.commit().await?;
    let review = match ingestion::prefill::prepare_review(&job["input"], &profile, &draft) {
        Ok(review) => review,
        Err(error) => {
            let mut tx = AppTx::begin(pool).await?;
            ingestion::finish_prefill_in_tx(
                &mut tx,
                attempt,
                error_state(&error),
                &json!({"analysis":draft}),
                Some(error.code),
            )
            .await?;
            tx.commit().await?;
            return Ok(true);
        }
    };
    let review_call = format!("{attempt}:review");
    let mut tx = AppTx::begin(pool).await?;
    let ready = match check_current_in_tx(&mut tx, &ctx, &job).await {
        Ok(()) => ingestion::assert_prefill_active_in_tx(&mut tx, attempt).await,
        Err(error) => Err(error),
    };
    let ready = match ready {
        Ok(()) => runtime::reserve_maintenance_in_tx(&mut tx, &review_call, &profile).await,
        Err(error) => Err(error),
    };
    if let Err(error) = ready {
        ingestion::finish_prefill_in_tx(
            &mut tx,
            attempt,
            error_state(&error),
            &json!({"analysis":draft}),
            Some(error.code),
        )
        .await?;
        tx.commit().await?;
        return Ok(true);
    }
    tx.commit().await?;
    let response = review.analyze().await;
    let mut tx = AppTx::begin(pool).await?;
    let (output, usage) = match response {
        Ok(result) => result,
        Err(error) => {
            ingestion::finish_prefill_in_tx(
                &mut tx,
                attempt,
                "unknown",
                &json!({"analysis":draft}),
                Some(error.code),
            )
            .await?;
            tx.commit().await?;
            return Ok(true);
        }
    };
    let history = json!({"analysis":draft,"review":output});
    let settled = runtime::settle_maintenance_in_tx(&mut tx, &review_call, &profile, &usage).await;
    tx.commit().await?;
    let mut tx = AppTx::begin(pool).await?;
    let candidate = ingestion::prefill::validate_result(&job["input"], &output);
    let valid = settled.and(candidate);
    let valid = match valid {
        Ok(candidate) => match check_current_in_tx(&mut tx, &ctx, &job).await {
            Ok(()) => ingestion::assert_prefill_active_in_tx(&mut tx, attempt)
                .await
                .map(|_| candidate),
            Err(error) => Err(error),
        },
        Err(error) => Err(error),
    };
    match valid {
        Ok(candidate) => {
            let command = json!({"operation_id":format!("prefill-{attempt}"),"expected_version":job["expected_version"]});
            let applied = knowledge::reanalyze_in_tx(
                &mut tx,
                &ctx,
                job["object_id"].as_str().unwrap_or(""),
                &command,
                epoch(candidate["source_version"].as_str().unwrap_or("0"))?,
                &candidate,
            )
            .await;
            match applied {
                Ok(_) => {
                    ingestion::finish_prefill_in_tx(&mut tx, attempt, "succeeded", &history, None)
                        .await?
                }
                Err(error) if error.code == "version_conflict" => {
                    ingestion::finish_prefill_in_tx(
                        &mut tx,
                        attempt,
                        "superseded",
                        &history,
                        Some(error.code),
                    )
                    .await?
                }
                Err(error) => return Err(error),
            }
        }
        Err(error) => {
            ingestion::finish_prefill_in_tx(
                &mut tx,
                attempt,
                if error.code == "model_usage_unknown" || error.code == "model_unknown" {
                    "unknown"
                } else if error.code == "stale_knowledge" || error.code == "version_conflict" {
                    "superseded"
                } else {
                    "invalid_prefill"
                },
                &history,
                Some(error.code),
            )
            .await?;
        }
    }
    tx.commit().await?;
    Ok(true)
}

fn prepare(
    job: &Value,
) -> Result<(
    contracts::generated::ModelProfile,
    ingestion::prefill::PreparedPrefill,
)> {
    let raw = std::env::var("DATA_AGENT_PREFILL_PROFILE")
        .map_err(|_| Error::new("budget_unavailable"))?;
    let configuration = serde_json::from_str(&raw).map_err(|_| Error::new("invalid_input"))?;
    let profile =
        contracts::decode::<contracts::generated::ModelProfile>("ModelProfile", configuration)?;
    access::authorize_model("deepseek")?;
    let request = ingestion::prefill::prepare(&job["input"], &profile)?;
    Ok((profile, request))
}
fn error_state(error: &Error) -> &'static str {
    match error.code {
        "budget_unavailable" | "budget_exhausted" => "budget_unavailable",
        "stale_knowledge" | "version_conflict" | "not_available" => "superseded",
        "model_unknown" | "model_usage_unknown" => "unknown",
        _ => "invalid_prefill",
    }
}
async fn finish_error(pool: &MySqlPool, attempt: &str, error: &Error) -> Result<()> {
    let mut tx = AppTx::begin(pool).await?;
    ingestion::finish_prefill_in_tx(
        &mut tx,
        attempt,
        error_state(error),
        &Value::Null,
        Some(error.code),
    )
    .await?;
    tx.commit().await
}
async fn check_current_in_tx(tx: &mut AppTx<'_>, ctx: &AccessContext, job: &Value) -> Result<()> {
    super::prefill_materials::check_in_tx(tx, ctx, &job["input"]).await
}
