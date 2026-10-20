use super::secrets;
use crate::{
    contracts::{
        self,
        generated::{ModelProfile, ModelSelection},
    },
    persistence::AppTx,
    types::{AccessContext, Error, Result, epoch, fingerprint},
};
use serde_json::{Value, json};
use sqlx::{MySqlPool, Row};

fn versioned(mut value: Value, version: u64) -> Value {
    value["version"] = json!(version.to_string());
    value.as_object_mut().unwrap().remove("legacy");
    value
        .as_object_mut()
        .unwrap()
        .remove("deployment_credential");
    value
}
fn identity(space: &str, id: &str, version: u64) -> String {
    format!("{space}/{id}/{version}")
}

pub async fn initialize(
    pool: &MySqlPool,
    space: &str,
    profile: Option<&ModelProfile>,
) -> Result<()> {
    let mut tx = AppTx::begin(pool).await?;
    let inserted = sqlx::query("INSERT IGNORE INTO model_space_settings(space_id) VALUES(?)")
        .bind(space)
        .execute(tx.connection())
        .await?
        .rows_affected();
    if inserted == 0 {
        tx.commit().await?;
        return Ok(());
    }
    if let Some(profile) =
        profile.filter(|p| matches!(p.toolset, Some(crate::contracts::generated::Toolset::Data)))
    {
        let key = std::env::var("DEEPSEEK_API_KEY")
            .ok()
            .filter(|key| !key.trim().is_empty());
        let has_keys: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM model_service_versions WHERE encrypted_key IS NOT NULL",
        )
        .fetch_one(tx.connection())
        .await?;
        let encrypted = key
            .as_deref()
            .map(|key| {
                secrets::seal(
                    key,
                    &identity(space, "deployment-deepseek", 1),
                    has_keys == 0,
                )
            })
            .transpose()?;
        let service = json!({"id":"deployment-deepseek","name":"DeepSeek（启动配置）","provider_id":"deepseek","api":"openai-completions","base_url":std::env::var("DEEPSEEK_BASE_URL").unwrap_or_else(|_|"https://api.deepseek.com".into()),"enabled":true,"credential_configured":key.is_some()});
        sqlx::query("INSERT INTO model_services(space_id,id,version,payload,last_fingerprint) VALUES(?,?,1,?,?)").bind(space).bind("deployment-deepseek").bind(&service).bind(fingerprint(&service)).execute(tx.connection()).await?;
        sqlx::query("INSERT INTO model_service_versions(space_id,id,version,payload,encrypted_key,updated_by) VALUES(?,?,1,?,?,'deployment')").bind(space).bind("deployment-deepseek").bind(&service).bind(encrypted).execute(tx.connection()).await?;
        for (id, label, levels, input, output) in [
            (
                "deepseek-flash",
                "DeepSeek Flash",
                json!(["off", "low", "high", "max"]),
                "300000",
                "1200000",
            ),
            (
                "deepseek-v4-pro",
                "DeepSeek Pro",
                json!(["off", "high", "max"]),
                "1320000",
                "3960000",
            ),
        ] {
            let model = json!({"id":id,"service_id":"deployment-deepseek","model_id":id,"label":label,"thinking_levels":levels,"reasoning_supported":true,"default_thinking":if id==profile.model_id {serde_json::to_value(profile).unwrap()["thinking_level"].as_str().unwrap_or("off").to_owned()} else {"off".into()},"input_limit":profile.input_limit,"output_limit":profile.output_limit,"payload_bytes_limit":profile.payload_bytes_limit.unwrap_or(65536),"input_rate":input,"output_rate":output,"enabled":true,"legacy":true});
            sqlx::query("INSERT INTO model_definitions(space_id,id,version,payload,last_fingerprint) VALUES(?,?,1,?,?)").bind(space).bind(id).bind(&model).bind(fingerprint(&model)).execute(tx.connection()).await?;
            sqlx::query("INSERT INTO model_definition_versions(space_id,id,version,payload,updated_by) VALUES(?,?,1,?,'deployment')").bind(space).bind(id).bind(&model).execute(tx.connection()).await?;
        }
        sqlx::query(
            "UPDATE model_space_settings SET default_model_id=?,managed=TRUE WHERE space_id=?",
        )
        .bind(&profile.model_id)
        .bind(space)
        .execute(tx.connection())
        .await?;
    }
    tx.commit().await
}

pub async fn snapshot(pool: &MySqlPool, space: &str) -> Result<Value> {
    let mut tx = AppTx::begin(pool).await?;
    let setting = sqlx::query(
        "SELECT version,default_model_id FROM model_space_settings WHERE space_id=? FOR SHARE",
    )
    .bind(space)
    .fetch_one(tx.connection())
    .await?;
    let services =
        sqlx::query("SELECT payload,version FROM model_services WHERE space_id=? ORDER BY id")
            .bind(space)
            .fetch_all(tx.connection())
            .await?
            .into_iter()
            .map(|r| versioned(r.get("payload"), r.get("version")))
            .collect::<Vec<_>>();
    let models =
        sqlx::query("SELECT payload,version FROM model_definitions WHERE space_id=? ORDER BY id")
            .bind(space)
            .fetch_all(tx.connection())
            .await?
            .into_iter()
            .map(|r| versioned(r.get("payload"), r.get("version")))
            .collect::<Vec<_>>();
    let result = json!({"version":setting.get::<u64,_>("version").to_string(),"default_model_id":setting.get::<Option<String>,_>("default_model_id"),"services":services,"models":models});
    tx.commit().await?;
    Ok(result)
}

pub async fn save_service(pool: &MySqlPool, ctx: &AccessContext, input: Value) -> Result<()> {
    let id = input["id"].as_str().ok_or(Error::new("invalid_input"))?;
    let expected = epoch(input["expected_version"].as_str().unwrap_or(""))?;
    let next_version = expected.checked_add(1).ok_or(Error::new("invalid_input"))?;
    let mut tx = AppTx::begin(pool).await?;
    sqlx::query("SELECT version FROM model_space_settings WHERE space_id=? FOR UPDATE")
        .bind(&ctx.space_id)
        .fetch_one(tx.connection())
        .await?;
    let has_keys: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM model_service_versions WHERE encrypted_key IS NOT NULL",
    )
    .fetch_one(tx.connection())
    .await?;
    let fp = secrets::request_fingerprint(&input, has_keys == 0)?;
    let old = sqlx::query(
        "SELECT version,payload,last_fingerprint FROM model_services WHERE space_id=? AND id=?",
    )
    .bind(&ctx.space_id)
    .bind(id)
    .fetch_optional(tx.connection())
    .await?;
    if let Some(row) = &old {
        let version: u64 = row.get("version");
        if version == next_version && row.get::<String, _>("last_fingerprint") == fp {
            tx.commit().await?;
            return Ok(());
        }
        if version != expected {
            return Err(Error::new("version_conflict"));
        }
    } else if expected != 0 {
        return Err(Error::new("version_conflict"));
    }
    let mut payload = input.clone();
    payload.as_object_mut().unwrap().remove("expected_version");
    payload.as_object_mut().unwrap().remove("api_key");
    let models: Vec<Value> = sqlx::query_scalar("SELECT payload FROM model_definitions WHERE space_id=? AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.service_id'))=?")
        .bind(&ctx.space_id).bind(id).fetch_all(tx.connection()).await?;
    for model in models {
        super::validate_model_protocol(&model, &payload)?;
    }
    let version = next_version;
    if input.get("api_key").is_none()
        && let Some(row) = &old
    {
        let previous: Value = row.get("payload");
        if ["base_url", "provider_id", "api"]
            .iter()
            .any(|field| previous[*field] != payload[*field])
        {
            return Err(Error::new("model_credential_required"));
        }
    }
    let key = if let Some(key) = input["api_key"].as_str() {
        Some(key.to_owned())
    } else if old.is_some() {
        let row=sqlx::query("SELECT payload,encrypted_key FROM model_service_versions WHERE space_id=? AND id=? AND version=?").bind(&ctx.space_id).bind(id).bind(expected).fetch_one(tx.connection()).await?;
        let cipher: Option<Vec<u8>> = row.get("encrypted_key");
        cipher
            .map(|cipher| secrets::open(&cipher, &identity(&ctx.space_id, id, expected)))
            .transpose()?
    } else {
        return Err(Error::new("model_credential_required"));
    };
    payload["credential_configured"] = json!(key.is_some());
    let encrypted = key
        .map(|k| secrets::seal(&k, &identity(&ctx.space_id, id, version), has_keys == 0))
        .transpose()?;
    sqlx::query("INSERT INTO model_service_versions(space_id,id,version,payload,encrypted_key,updated_by) VALUES(?,?,?,?,?,?)").bind(&ctx.space_id).bind(id).bind(version).bind(&payload).bind(encrypted).bind(&ctx.user_id).execute(tx.connection()).await?;
    sqlx::query("INSERT INTO model_services(space_id,id,version,payload,last_fingerprint) VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE version=VALUES(version),payload=VALUES(payload),last_fingerprint=VALUES(last_fingerprint)").bind(&ctx.space_id).bind(id).bind(version).bind(&payload).bind(&fp).execute(tx.connection()).await?;
    sqlx::query("UPDATE model_space_settings SET version=version+1 WHERE space_id=?")
        .bind(&ctx.space_id)
        .execute(tx.connection())
        .await?;
    tx.commit().await
}

pub async fn save_model(pool: &MySqlPool, ctx: &AccessContext, input: Value) -> Result<()> {
    let expected = epoch(input["expected_version"].as_str().unwrap_or(""))?;
    let next_version = expected.checked_add(1).ok_or(Error::new("invalid_input"))?;
    let id = input["id"].as_str().unwrap();
    let fp = fingerprint(&input);
    let mut tx = AppTx::begin(pool).await?;
    sqlx::query("SELECT version FROM model_space_settings WHERE space_id=? FOR UPDATE")
        .bind(&ctx.space_id)
        .fetch_one(tx.connection())
        .await?;
    let service = sqlx::query("SELECT payload FROM model_services WHERE space_id=? AND id=?")
        .bind(&ctx.space_id)
        .bind(input["service_id"].as_str().unwrap())
        .fetch_optional(tx.connection())
        .await?;
    let service: Value = service.ok_or(Error::new("not_available"))?.get("payload");
    super::validate_model_protocol(&input, &service)?;
    if let Some(old) = sqlx::query(
        "SELECT version,last_fingerprint FROM model_definitions WHERE space_id=? AND id=?",
    )
    .bind(&ctx.space_id)
    .bind(id)
    .fetch_optional(tx.connection())
    .await?
    {
        let version: u64 = old.get("version");
        if version == next_version && old.get::<String, _>("last_fingerprint") == fp {
            tx.commit().await?;
            return Ok(());
        }
        if version != expected {
            return Err(Error::new("version_conflict"));
        }
    } else if expected != 0 {
        return Err(Error::new("version_conflict"));
    }
    let mut payload = input.clone();
    payload.as_object_mut().unwrap().remove("expected_version");
    let version = next_version;
    sqlx::query("INSERT INTO model_definition_versions(space_id,id,version,payload,updated_by) VALUES(?,?,?,?,?)").bind(&ctx.space_id).bind(id).bind(version).bind(&payload).bind(&ctx.user_id).execute(tx.connection()).await?;
    sqlx::query("INSERT INTO model_definitions(space_id,id,version,payload,last_fingerprint) VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE version=VALUES(version),payload=VALUES(payload),last_fingerprint=VALUES(last_fingerprint)").bind(&ctx.space_id).bind(id).bind(version).bind(&payload).bind(&fp).execute(tx.connection()).await?;
    sqlx::query("UPDATE model_space_settings SET version=version+1,managed=TRUE WHERE space_id=?")
        .bind(&ctx.space_id)
        .execute(tx.connection())
        .await?;
    tx.commit().await
}

pub async fn default_model(pool: &MySqlPool, space: &str, input: Value) -> Result<()> {
    let mut tx = AppTx::begin(pool).await?;
    let row = sqlx::query(
        "SELECT version,default_model_id FROM model_space_settings WHERE space_id=? FOR UPDATE",
    )
    .bind(space)
    .fetch_one(tx.connection())
    .await?;
    let expected = epoch(input["expected_version"].as_str().unwrap())?;
    let next_version = expected.checked_add(1).ok_or(Error::new("invalid_input"))?;
    let version: u64 = row.get("version");
    let id = input["model_id"].as_str().unwrap();
    if version == next_version
        && row.get::<Option<String>, _>("default_model_id").as_deref() == Some(id)
    {
        tx.commit().await?;
        return Ok(());
    }
    if version != expected {
        return Err(Error::new("version_conflict"));
    }
    active_definition(&mut tx, space, id).await?;
    sqlx::query("UPDATE model_space_settings SET version=version+1,default_model_id=?,managed=TRUE WHERE space_id=?").bind(id).bind(space).execute(tx.connection()).await?;
    tx.commit().await
}

async fn active_definition(
    tx: &mut AppTx<'_>,
    space: &str,
    id: &str,
) -> Result<(Value, u64, Value, u64)> {
    let model =
        sqlx::query("SELECT payload,version FROM model_definitions WHERE space_id=? AND id=?")
            .bind(space)
            .bind(id)
            .fetch_optional(tx.connection())
            .await?
            .ok_or(Error::new("model_unavailable"))?;
    let m: Value = model.get("payload");
    let service =
        sqlx::query("SELECT payload,version FROM model_services WHERE space_id=? AND id=?")
            .bind(space)
            .bind(m["service_id"].as_str().unwrap())
            .fetch_optional(tx.connection())
            .await?
            .ok_or(Error::new("model_unavailable"))?;
    let s: Value = service.get("payload");
    if m["enabled"] != true || s["enabled"] != true {
        return Err(Error::new("model_unavailable"));
    }
    Ok((m, model.get("version"), s, service.get("version")))
}

pub async fn selection_in_tx(
    tx: &mut AppTx<'_>,
    space: &str,
    fallback: Option<&ModelProfile>,
    selection: Option<&ModelSelection>,
) -> Result<(Option<ModelProfile>, Option<ModelSelection>)> {
    let row = sqlx::query(
        "SELECT default_model_id,managed FROM model_space_settings WHERE space_id=? FOR SHARE",
    )
    .bind(space)
    .fetch_one(tx.connection())
    .await?;
    let configured = row.get::<bool, _>("managed");
    let chosen = selection
        .map(|s| s.model_id.clone())
        .or(row.get::<Option<String>, _>("default_model_id"));
    let Some(id) = chosen else {
        if configured {
            return Err(Error::new("model_unavailable"));
        }
        return Ok((fallback.cloned(), None));
    };
    let (model, version, service, service_version) = active_definition(tx, space, &id).await?;
    let thinking = selection
        .map(|s| serde_json::to_value(&s.thinking_level).unwrap())
        .unwrap_or_else(|| model["default_thinking"].clone());
    if !model["thinking_levels"]
        .as_array()
        .unwrap()
        .contains(&thinking)
    {
        return Err(Error::new("invalid_input"));
    }
    let selection = contracts::decode::<ModelSelection>(
        "ModelSelection",
        json!({"model_id":id,"thinking_level":thinking}),
    )?;
    let mut profile = fallback
        .map(|p| serde_json::to_value(p).unwrap())
        .unwrap_or_else(|| base_profile(space));
    profile["provider_id"] = service["provider_id"].clone();
    profile["model_id"] = model["model_id"].clone();
    profile["price_version"] = if model["legacy"] == true {
        json!(if id == "deepseek-flash" {
            "2026-10-04-peak-usd"
        } else {
            "2026-10-05-pro-peak-usd"
        })
    } else {
        json!(format!("configured:{id}:{version}"))
    };
    profile["thinking_level"] = thinking;
    for field in ["input_limit", "output_limit", "payload_bytes_limit"] {
        profile[field] = model[field].clone();
    }
    profile["toolset"] = json!("data");
    profile["configured_model"] = json!({"id":id,"version":version.to_string(),"service_id":model["service_id"],"service_version":service_version.to_string(),"api":service["api"],"input_rate":model["input_rate"],"output_rate":model["output_rate"],"reasoning_supported":model["reasoning_supported"]});
    if let Some(mode) = model.get("anthropic_thinking_mode") {
        profile["configured_model"]["anthropic_thinking_mode"] = mode.clone();
    }
    Ok((
        Some(contracts::decode("ModelProfile", profile)?),
        Some(selection),
    ))
}

pub fn base_profile(space: &str) -> Value {
    json!({"provider_id":"deepseek","model_id":"deepseek-flash","trial_id":format!("models-{}",&fingerprint(&json!(space))[..24]),"price_version":"2026-10-04-peak-usd","input_limit":65536,"output_limit":8192,"request_call_limit":24,"toolset":"data","payload_bytes_limit":131072,"thinking_level":"off","budget_mode":"request"})
}

pub async fn assert_active_in_tx(
    tx: &mut AppTx<'_>,
    space: &str,
    profile: &ModelProfile,
) -> Result<()> {
    // 与管理员修改共享空间配置锁；检查发生在发送许可事务内，之后不再重新选择端点。
    let settings =
        sqlx::query("SELECT space_id,managed FROM model_space_settings WHERE space_id=? FOR SHARE")
            .bind(space)
            .fetch_optional(tx.connection())
            .await?;
    if settings.is_none() {
        return if profile.configured_model.is_none() {
            Ok(())
        } else {
            Err(Error::new("model_unavailable"))
        };
    }
    if let Some(config) = &profile.configured_model {
        let model: Value =
            sqlx::query_scalar("SELECT payload FROM model_definitions WHERE space_id=? AND id=?")
                .bind(space)
                .bind(&config.id)
                .fetch_optional(tx.connection())
                .await?
                .ok_or(Error::new("model_unavailable"))?;
        // 模型改绑服务后，旧运行仍检查自己的原服务状态。
        let old = sqlx::query("SELECT payload FROM model_services WHERE space_id=? AND id=?")
            .bind(space)
            .bind(&config.service_id)
            .fetch_optional(tx.connection())
            .await?
            .ok_or(Error::new("model_unavailable"))?;
        let service: Value = old.get("payload");
        if service["enabled"] != true || model["enabled"] != true {
            return Err(Error::new("model_unavailable"));
        }
    } else if profile.provider_id == "deepseek"
        && settings
            .as_ref()
            .is_some_and(|row| row.get::<bool, _>("managed"))
    {
        // 历史消息没有版本引用，其连接来自旧部署；不能随逻辑模型改绑到新服务。
        let model: Option<Value> =
            sqlx::query_scalar("SELECT payload FROM model_definitions WHERE space_id=? AND id=?")
                .bind(space)
                .bind(&profile.model_id)
                .fetch_optional(tx.connection())
                .await?;
        let service: Option<Value> = sqlx::query_scalar(
            "SELECT payload FROM model_services WHERE space_id=? AND id='deployment-deepseek'",
        )
        .bind(space)
        .fetch_optional(tx.connection())
        .await?;
        if model.is_none_or(|m| m["enabled"] != true)
            || service.is_none_or(|s| s["enabled"] != true)
        {
            return Err(Error::new("model_unavailable"));
        }
    }
    Ok(())
}

pub async fn connection_in_tx(
    tx: &mut AppTx<'_>,
    space: &str,
    profile: &ModelProfile,
) -> Result<Value> {
    assert_active_in_tx(tx, space, profile).await?;
    let config = profile
        .configured_model
        .as_ref()
        .ok_or(Error::new("model_unavailable"))?;
    let row=sqlx::query("SELECT payload,encrypted_key FROM model_service_versions WHERE space_id=? AND id=? AND version=?").bind(space).bind(&config.service_id).bind(epoch(&config.service_version)?).fetch_one(tx.connection()).await?;
    let payload: Value = row.get("payload");
    let cipher: Option<Vec<u8>> = row.get("encrypted_key");
    let key = secrets::open(
        &cipher.ok_or(Error::new("model_credential_required"))?,
        &identity(space, &config.service_id, epoch(&config.service_version)?),
    )?;
    Ok(
        json!({"base_url":payload["base_url"],"api":payload["api"],"provider_id":payload["provider_id"],"api_key":key,"runtime_provider":format!("configured_{}",fingerprint(&json!([space,config.service_id,config.service_version])))}),
    )
}
