use crate::{
    live_changes::{self, Change},
    types::{Error, Result, id},
};
pub use sqlx::MySqlPool;
use sqlx::{MySql, MySqlConnection, Transaction};
use std::time::Duration;

pub(crate) mod delivery;
pub mod receipts;

static MIGRATIONS: sqlx::migrate::Migrator = sqlx::migrate!("../../migrations");

pub struct AppTx<'a> {
    transaction: Transaction<'a, MySql>,
    id: String,
    rank: u8,
    changes: Vec<Change>,
}
impl<'a> AppTx<'a> {
    pub async fn begin(pool: &'a MySqlPool) -> Result<Self> {
        Ok(Self {
            transaction: pool.begin().await?,
            id: id(),
            rank: 0,
            changes: Vec::new(),
        })
    }
    pub fn id(&self) -> &str {
        &self.id
    }
    // 只供模块私有存储使用；协调层访问由架构检查拒绝。
    pub(crate) fn connection(&mut self) -> &mut MySqlConnection {
        &mut self.transaction
    }
    pub(crate) fn lock_rank(&mut self, rank: u8) -> Result<()> {
        if rank < self.rank {
            return Err(Error::new("invalid_input"));
        }
        self.rank = rank;
        Ok(())
    }
    pub fn assert_snapshot(&self, transaction_id: &str) -> Result<()> {
        if self.id != transaction_id {
            return Err(Error::new("invalid_input"));
        }
        Ok(())
    }
    pub fn notify(&mut self, change: Change) {
        if live_changes::enabled() {
            self.changes.push(change);
        }
    }
    pub async fn commit(self) -> Result<()> {
        self.transaction.commit().await?;
        live_changes::committed(self.changes);
        Ok(())
    }
}
pub async fn connect(url: &str) -> Result<MySqlPool> {
    let pool = connect_pool(url, 24).await?;
    MIGRATIONS
        .run(&pool)
        .await
        .map_err(|_| Error::new("unavailable"))?;
    Ok(pool)
}

pub async fn connect_worker(url: &str, default_max: u32) -> Result<MySqlPool> {
    let pool = connect_pool(url, default_max).await?;
    let version = MIGRATIONS
        .iter()
        .next_back()
        .ok_or_else(|| Error::new("unavailable").with_message("no database migrations".into()))?
        .version;
    // 独立启动也等同库迁移完成，写迁移仍由 API 或导入入口负责。
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let ready: std::result::Result<Option<i64>, sqlx::Error> = sqlx::query_scalar(
                "SELECT version FROM _sqlx_migrations WHERE version=? AND success=TRUE",
            )
            .bind(version)
            .fetch_optional(&pool)
            .await;
            match ready {
                Ok(Some(_)) => return Ok(()),
                Ok(None) => {}
                Err(error)
                    if error.as_database_error().is_some_and(|error| {
                        error
                            .try_downcast_ref::<sqlx::mysql::MySqlDatabaseError>()
                            .is_some_and(|error| error.number() == 1146)
                    }) => {}
                Err(error) => return Err(Error::from(error)),
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    })
    .await
    .map_err(|_| {
        Error::new("unavailable").with_message("database migrations not ready".into())
    })??;
    Ok(pool)
}

async fn connect_pool(url: &str, default_max: u32) -> Result<MySqlPool> {
    let max_connections = std::env::var("DATA_AGENT_DB_MAX_CONNECTIONS")
        .ok()
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(default_max);
    let pool = sqlx::mysql::MySqlPoolOptions::new()
        .max_connections(max_connections)
        .acquire_timeout(Duration::from_secs(5))
        .idle_timeout(Duration::from_secs(120))
        .connect(url)
        .await?;
    Ok(pool)
}
