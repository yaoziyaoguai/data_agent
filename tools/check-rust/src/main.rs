//! 开发依赖烟测；临时 HTTP 服务结束即关闭，不是正式应用入口。

use axum::{Json, Router, routing::get};
use serde::{Deserialize, Serialize};
use sqlx::{Connection, MySqlConnection, mysql::MySqlConnectOptions};
use std::{error::Error, time::Duration};
use tokio::{net::TcpListener, sync::oneshot};

#[derive(Debug, Deserialize, PartialEq, Serialize)]
struct Health {
    status: String,
    scope: String,
}

async fn health() -> Json<Health> {
    Json(Health {
        status: "ok".into(),
        scope: "development-dependencies".into(),
    })
}

async fn check_mysql() -> Result<(), Box<dyn Error>> {
    // 仅读取本项目环境准备生成的密码，不读取已有 .env 或用户凭据。
    let secret = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../.local/infra/mysql-app-password");
    let password = std::fs::read_to_string(secret)
        .map_err(|_| "Missing project MySQL secret; run make infra-up first")?;
    let options = MySqlConnectOptions::new()
        .host("127.0.0.1")
        .port(13306)
        .username("data_agent")
        .database("data_agent")
        .password(password.trim());
    let mut connection = tokio::time::timeout(
        Duration::from_secs(10),
        MySqlConnection::connect_with(&options),
    )
    .await?
    .map_err(|_| "Project MySQL connection failed; check make infra-status")?;
    // 临时表只存在于此连接，退出后自动清理，不修改业务表或已有数据。
    sqlx::query("CREATE TEMPORARY TABLE data_agent_dependency_probe (value INT NOT NULL)")
        .execute(&mut connection)
        .await?;
    sqlx::query("INSERT INTO data_agent_dependency_probe (value) VALUES (?)")
        .bind(42_i32)
        .execute(&mut connection)
        .await?;
    let value: i32 = sqlx::query_scalar("SELECT value FROM data_agent_dependency_probe")
        .fetch_one(&mut connection)
        .await?;
    connection.close().await?;
    if value != 42 {
        return Err("MySQL parameter binding round trip did not match".into());
    }
    Ok(())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let arguments: Vec<_> = std::env::args().skip(1).collect();
    let with_mysql = arguments.as_slice() == ["--mysql"];
    if !arguments.is_empty() && !with_mysql {
        return Err("Usage: data-agent-env-check [--mysql]".into());
    }
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let (stop, stopped) = oneshot::channel::<()>();
    let server = tokio::spawn(async move {
        axum::serve(listener, Router::new().route("/health", get(health)))
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await
    });

    // 强制本地直连，避免系统代理干扰回环检查。
    let response = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()?
        .get(format!("http://{address}/health"))
        .send()
        .await?
        .error_for_status()?
        .json::<Health>()
        .await?;
    let _ = stop.send(());
    tokio::time::timeout(Duration::from_secs(5), server).await???;
    if response != health().await.0 {
        return Err("HTTP JSON round trip did not match".into());
    }

    // 此处仅验证驱动可构建；真实数据库读写由独立容器烟测覆盖。
    let _query = sqlx::query::<sqlx::MySql>("SELECT 1");
    if with_mysql {
        tokio::time::timeout(Duration::from_secs(20), check_mysql()).await??;
    }
    println!(
        "{}",
        serde_json::json!({
            "status": "passed",
            "axum_tokio_reqwest_json": "loopback HTTP round trip passed",
            "sqlx_mysql": if with_mysql { "live parameter binding round trip passed" }
                else { "driver compiled; live connection not requested" },
            "scope": "development dependencies; no application or model invocation"
        })
    );
    Ok(())
}
