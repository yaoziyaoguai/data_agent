//! 已提交写入的实时通知。历史重放仍使用原会话事件。
use serde::{Deserialize, Serialize};
use std::{sync::OnceLock, time::Duration};
use tokio::{
    sync::{mpsc, oneshot, watch},
    task::JoinHandle,
};

#[derive(Clone, Debug, PartialEq, Eq, Hash, Deserialize, Serialize)]
pub struct ConversationScope {
    pub conversation_id: String,
    pub user_id: String,
    pub space_id: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Change {
    Resync,
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

#[derive(Clone)]
pub struct Publisher {
    sender: mpsc::Sender<Vec<Change>>,
    missed: watch::Sender<()>,
}

impl Publisher {
    pub fn channel() -> (Self, mpsc::Receiver<Vec<Change>>) {
        let (sender, receiver) = mpsc::channel(128);
        (
            Self {
                sender,
                missed: watch::channel(()).0,
            },
            receiver,
        )
    }

    pub fn subscribe_missed(&self) -> watch::Receiver<()> {
        self.missed.subscribe()
    }

    pub fn invalidate(&self) {
        self.missed.send_replace(());
    }

    pub fn enqueue(&self, changes: Vec<Change>) -> crate::types::Result<()> {
        match self.sender.try_send(changes) {
            Ok(()) => Ok(()),
            Err(mpsc::error::TrySendError::Full(_)) => {
                // 已提交的正文仍按事件序号重放；通知溢出时强制重新核对状态。
                self.invalidate();
                Ok(())
            }
            Err(mpsc::error::TrySendError::Closed(_)) => {
                Err(crate::types::Error::new("unavailable"))
            }
        }
    }
}

static PUBLISHER: OnceLock<Publisher> = OnceLock::new();

pub fn install(publisher: Publisher) -> crate::types::Result<()> {
    PUBLISHER
        .set(publisher)
        .map_err(|_| crate::types::Error::new("invalid_input"))
}

pub fn start_worker(
    client: reqwest::Client,
    api: reqwest::Url,
    token: String,
) -> crate::types::Result<(oneshot::Sender<()>, JoinHandle<()>)> {
    let (publisher, mut incoming) = Publisher::channel();
    let mut missed = publisher.subscribe_missed();
    install(publisher)?;
    let (finish, finished) = oneshot::channel();
    let forward = tokio::spawn(async move {
        let notify_api = |changes: Vec<Change>| {
            let request = client
                .post(api.clone())
                .bearer_auth(&token)
                .timeout(Duration::from_secs(3))
                .json(&changes);
            async move { matches!(request.send().await, Ok(response) if response.status().is_success()) }
        };
        let mut unconfirmed = false;
        let publish = async {
            loop {
                let changes = if unconfirmed {
                    vec![Change::Resync]
                } else {
                    tokio::select! {
                        changes = incoming.recv() => match changes {
                            Some(changes) => changes,
                            None => return,
                        },
                        result = missed.changed() => {
                            if result.is_err() {
                                return;
                            }
                            vec![Change::Resync]
                        }
                    }
                };
                let retrying = unconfirmed;
                unconfirmed = true;
                if notify_api(changes).await {
                    unconfirmed = false;
                } else {
                    if !retrying {
                        eprintln!("live_changes_worker_notification_unconfirmed");
                    }
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
            }
        };
        tokio::select! {
            biased;
            _ = finished => {}
            _ = publish => return,
        }
        // 所有业务写入收尾后，未确认和未发送的通知共用一次限时补读。
        if (unconfirmed || !incoming.is_empty() || matches!(missed.has_changed(), Ok(true)))
            && !notify_api(vec![Change::Resync]).await
        {
            eprintln!("live_changes_worker_shutdown_resync_unconfirmed");
        }
    });
    Ok((finish, forward))
}

pub(crate) fn enabled() -> bool {
    PUBLISHER.get().is_some()
}

pub(crate) fn committed(changes: Vec<Change>) {
    if !changes.is_empty()
        && let Some(publisher) = PUBLISHER.get()
        && publisher.enqueue(changes).is_err()
    {
        eprintln!("live_changes_publisher_unavailable");
    }
}
