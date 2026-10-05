use serde_json::Value;
use sha2::{Digest, Sha256};

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug)]
pub struct Error {
    pub code: &'static str,
}
impl Error {
    pub fn new(code: &'static str) -> Self {
        Self { code }
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
        Self::new("unavailable")
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
