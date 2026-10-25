use serde_json::Value;
use sha2::{Digest, Sha256};

mod source_locator;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug)]
pub struct Error {
    pub code: &'static str,
    pub message: Option<String>,
    transient_storage: bool,
}
impl Error {
    pub fn new(code: &'static str) -> Self {
        Self {
            code,
            message: None,
            transient_storage: false,
        }
    }
    pub fn transient_storage() -> Self {
        Self {
            code: "unavailable",
            message: None,
            transient_storage: true,
        }
    }
    pub fn is_transient_storage(&self) -> bool {
        self.transient_storage
    }
    pub fn with_message(mut self, message: String) -> Self {
        self.message = Some(message);
        self
    }
}
impl From<sqlx::Error> for Error {
    fn from(error: sqlx::Error) -> Self {
        if let sqlx::Error::ColumnDecode { index, .. } = &error {
            eprintln!("storage_decode column={index}");
        }

        if let Some(database) = error.as_database_error() {
            eprintln!(
                "storage_failure kind=database code={}",
                database.code().as_deref().unwrap_or("unknown")
            );
        } else {
            eprintln!(
                "storage_failure kind=transport category={:?}",
                std::mem::discriminant(&error)
            );
        }
        // 只在连接/锁竞争可恢复时由worker重试；SQL、迁移和解码错误不能伪装成临时断库。
        let transient = match &error {
            sqlx::Error::Io(_) | sqlx::Error::Tls(_) | sqlx::Error::PoolTimedOut => true,
            sqlx::Error::Database(database) => {
                let state = database.code();
                state.as_deref().is_some_and(|code| code.starts_with("08"))
                    || database
                        .try_downcast_ref::<sqlx::mysql::MySqlDatabaseError>()
                        .is_some_and(|error| matches!(error.number(), 1205 | 1213))
            }
            _ => false,
        };
        Self {
            code: "unavailable",
            message: None,
            transient_storage: transient,
        }
    }
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code)
    }
}
impl std::error::Error for Error {}
pub fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
pub fn fingerprint(value: &Value) -> String {
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(value).expect("JSON value"))
    )
}
pub fn epoch(value: &str) -> Result<u64> {
    value.parse().map_err(|_| Error::new("invalid_input"))
}

#[derive(Clone, Debug)]
pub struct AccessContext {
    pub user_id: String,
    pub space_id: String,
    pub request_id: String,
}
#[derive(Clone, Debug)]
pub struct RunLocation {
    pub conversation_id: String,
    pub owner_id: String,
    pub space_id: String,
}

#[cfg(test)]
mod tests {
    use super::Error;

    #[test]
    fn storage_retry_classification_keeps_permanent_and_business_failures_distinct() {
        assert!(Error::from(sqlx::Error::PoolTimedOut).is_transient_storage());
        assert!(
            Error::from(sqlx::Error::Io(std::io::Error::from(
                std::io::ErrorKind::ConnectionReset,
            )))
            .is_transient_storage()
        );
        for failure in [
            sqlx::Error::RowNotFound,
            sqlx::Error::ColumnNotFound("synthetic".into()),
        ] {
            let error = Error::from(failure);
            assert_eq!(error.code, "unavailable");
            assert!(!error.is_transient_storage());
        }
        assert!(!Error::new("unavailable").is_transient_storage());
    }
}
