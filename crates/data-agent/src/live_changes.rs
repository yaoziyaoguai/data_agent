//! 已提交写入的实时通知。历史重放仍使用原会话事件。
use serde::{Deserialize, Serialize};
use std::{sync::OnceLock, time::Duration};
use tokio::sync::mpsc;

#[derive(Clone, Debug, PartialEq, Eq, Hash, Deserialize, Serialize)]
pub struct ConversationScope {
    pub conversation_id: String,
    pub user_id: String,
    pub space_id: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Change {
    Timeline {
        scope: ConversationScope,
        event: serde_json::Value,
    },
    Run {
        scope: ConversationScope,
    },
    Activity {
        conversation_id: String,
    },
    Query {
        conversation_id: String,
    },
    ConversationDeleted {
        conversation_id: String,
    },
    Catalog {
        space_id: String,
    },
    Corrections {
        space_id: String,
    },
    Authority {
        space_id: String,
    },
    SessionRevoked {
        session_hash: String,
    },
}

pub enum Publisher {
    Local(mpsc::Sender<Vec<Change>>),
    Worker {
        client: reqwest::Client,
        api: reqwest::Url,
        token: String,
    },
}

static PUBLISHER: OnceLock<Publisher> = OnceLock::new();

pub fn install(publisher: Publisher) -> crate::types::Result<()> {
    PUBLISHER
        .set(publisher)
        .map_err(|_| crate::types::Error::new("invalid_input"))
}

pub(crate) fn enabled() -> bool {
    PUBLISHER.get().is_some()
}

pub(crate) async fn committed(changes: Vec<Change>) {
    if changes.is_empty() {
        return;
    }
    match PUBLISHER.get() {
        Some(Publisher::Local(sender)) => {
            if sender.send(changes).await.is_err() {
                eprintln!("live_changes_api_unavailable");
            }
        }
        Some(Publisher::Worker { client, api, token }) => {
            let result = client
                .post(api.clone())
                .bearer_auth(token)
                .timeout(Duration::from_secs(3))
                .json(&changes)
                .send()
                .await;
            if !matches!(result, Ok(response) if response.status().is_success()) {
                // 事务已经成功；连接重开时可从已提交事件补齐。
                eprintln!("live_changes_worker_notification_unconfirmed");
            }
        }
        None => {}
    }
}
