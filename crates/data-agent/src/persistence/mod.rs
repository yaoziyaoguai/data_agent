use crate::types::{Error, Result, id};
pub use sqlx::MySqlPool;
use sqlx::{MySql, MySqlConnection, Transaction};

pub struct AppTx<'a> {
    transaction: Transaction<'a, MySql>,
    id: String,
    rank: u8,
}
impl<'a> AppTx<'a> {
    pub async fn begin(pool: &'a MySqlPool) -> Result<Self> {
        Ok(Self {
            transaction: pool.begin().await?,
            id: id(),
            rank: 0,
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
    pub async fn commit(self) -> Result<()> {
        self.transaction.commit().await?;
        Ok(())
    }
}
pub async fn connect(url: &str) -> Result<MySqlPool> {
    connect_with_default(url, 24).await
}
// 池上限来自部署配置；默认值按调用方角色区分（API 24、Worker 32）。
pub async fn connect_with_default(url: &str, default_max: u32) -> Result<MySqlPool> {
    let max_connections = std::env::var("DATA_AGENT_DB_MAX_CONNECTIONS")
        .ok()
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(default_max);
    let pool = sqlx::mysql::MySqlPoolOptions::new()
        .max_connections(max_connections)
        .acquire_timeout(std::time::Duration::from_secs(5))
        .idle_timeout(std::time::Duration::from_secs(300))
        .connect(url)
        .await?;
    sqlx::migrate!("../../migrations")
        .run(&pool)
        .await
        .map_err(|_| Error::new("unavailable"))?;
    Ok(pool)
}
