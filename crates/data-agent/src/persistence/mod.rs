use crate::types::{Error, Result, id};
use sqlx::{MySql, MySqlConnection, MySqlPool, Transaction};

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
    let pool = sqlx::mysql::MySqlPoolOptions::new()
        .max_connections(12)
        .connect(url)
        .await?;
    sqlx::migrate!("../../migrations")
        .run(&pool)
        .await
        .map_err(|_| Error::new("unavailable"))?;
    Ok(pool)
}
