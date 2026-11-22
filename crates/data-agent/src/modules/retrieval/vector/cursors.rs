use super::scan::{CANDIDATE_CEILING, Candidates, ChannelProgress, ScanChannel};
use crate::types::{Error, Result, fingerprint};
use serde_json::{Value, json};

// 05切片3：单通道分片游标。位置按该片实际消费的原始record行数前进（与其他片
// 重复的身份也占该片扫描位置，但候选按唯一身份只计一次）；轮次由组合层按可
// 交付候选驱动，通道层不再自判扩轮。
pub struct ShardCursor {
    pub filter: String,
    pub consumed: usize,
    pub failed: bool,
    // 成功空/成功未满页/成功满页/失败/未执行在位事实：穷尽只由"成功且返回数<
    // 请求额度"证明；失败片后续轮不再请求、不计completed。
    pub full_page: bool,
    pub requested: bool,
    pub succeeded: bool,
    // 同一owner轮内，临时预留不足后只补尚未派发的分片。
    pub dispatched_round: usize,
    pub in_flight: bool,
}
pub struct ChannelCursor {
    pub shards: Vec<ShardCursor>,
    pub hits: Vec<Value>,
    pub rounds: usize,
    pub failed: bool,
    pub stopped: Option<&'static str>,
    pub(super) last_full_page: bool,
}

impl ChannelCursor {
    pub(super) fn new(filters: Vec<String>) -> Self {
        Self {
            shards: filters
                .into_iter()
                .map(|filter| ShardCursor {
                    filter,
                    consumed: 0,
                    failed: false,
                    full_page: false,
                    requested: false,
                    succeeded: false,
                    dispatched_round: 0,
                    in_flight: false,
                })
                .collect(),
            hits: Vec::new(),
            rounds: 0,
            failed: false,
            stopped: None,
            last_full_page: false,
        }
    }
    // 通道见底：已执行过、无失败片、无停轮原因且末轮无满页片——只有成功未满页
    // 可证明穷尽；任一片满页说明该片段内可能还有更多record。
    pub fn drained(&self) -> bool {
        !self.failed
            && self.rounds > 0
            && self.stopped.is_none()
            && !self.last_full_page
            && self
                .shards
                .iter()
                .all(|shard| shard.requested && !shard.in_flight && !shard.full_page)
    }
    pub fn progress(&self) -> ChannelProgress {
        let completed = self.shards.iter().filter(|shard| shard.succeeded).count();
        ChannelProgress {
            rounds: self.rounds,
            shards: self.shards.len(),
            completed,
            // 空允许集：范围内无可召回记录，按已覆盖穷举（不发全库查询）。
            exhausted: self.shards.is_empty() || self.drained(),
            uncovered: if self.shards.is_empty() {
                None
            } else {
                self.stopped.or(if self.last_full_page {
                    Some("candidate_limit")
                } else {
                    None
                })
            },
        }
    }
    // 该通道是否还能推进：有分片、未失败、未停轮、未穷尽且仍有可请求分片。
    pub fn advanceable(&self) -> bool {
        !self.shards.is_empty()
            && self.stopped.is_none()
            && !self.drained()
            && self
                .shards
                .iter()
                .any(|shard| !shard.failed && (!shard.requested || shard.full_page))
    }
}

// 各通道分片游标集合（05切片3）：advanceable()是组合层推进循环的条件——任一
// 通道仍可按原位置再取一批原始record。
pub struct SearchCursors {
    pub lexical: Option<ChannelCursor>,
    pub dense: Option<ChannelCursor>,
    pub raw_lexical: Option<ChannelCursor>,
    pub raw_dense: Option<ChannelCursor>,
}
/// 游标绑定的索引事实；调用方仍须绑定查询、任务条件和当前授权范围。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IndexFacts {
    pub target: Option<String>,
    pub projection: String,
    pub segmentation: String,
}

/// 只含扫描位置和范围指纹；不保存 filter、允许记录清单或查询向量。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScanSnapshot {
    #[serde(rename = "i")]
    pub facts: IndexFacts,
    #[serde(rename = "c")]
    channels: [Option<ChannelBookmark>; 4],
}
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct ChannelBookmark {
    #[serde(rename = "b")]
    binding: String,
    // consumed 与 requested/succeeded/failed/full_page 位图。
    #[serde(rename = "s")]
    shards: Vec<(usize, u8)>,
}
impl ScanSnapshot {
    pub fn has_more(&self) -> bool {
        self.channels.iter().flatten().any(|channel| {
            channel
                .shards
                .iter()
                .any(|(_, flags)| flags & 4 == 0 && (flags & 1 == 0 || flags & 8 != 0))
        })
    }
    pub fn validate(&self) -> Result<()> {
        if self.facts.projection != crate::types::KNOWLEDGE_PROJECTION
            || self.facts.segmentation != super::super::source_segments::SEGMENTATION_VERSION
        {
            return Err(Error::new("stale_cursor"));
        }
        if self.channels.iter().flatten().any(|channel| {
            channel.shards.len() > CANDIDATE_CEILING
                || channel.binding.len() != 64
                || !channel.binding.bytes().all(|byte| byte.is_ascii_hexdigit())
                || channel.shards.iter().any(|(consumed, flags)| {
                    *flags > 15
                        || (*consumed > 0 && flags & 1 == 0)
                        || (flags & 2 != 0 && flags & 1 == 0)
                        || (flags & 8 != 0 && (flags & 2 == 0 || flags & 4 != 0))
                })
        }) {
            return Err(Error::new("invalid_cursor"));
        }
        Ok(())
    }
}
impl Candidates {
    pub fn snapshot_scan(&self) -> Result<ScanSnapshot> {
        let mut channels = [None, None, None, None];
        for (index, channel) in [
            ScanChannel::Lexical,
            ScanChannel::Dense,
            ScanChannel::RawLexical,
            ScanChannel::RawDense,
        ]
        .into_iter()
        .enumerate()
        {
            if let Some(cursor) = self.cursors.cursor(channel) {
                if cursor.shards.iter().any(|shard| shard.in_flight) {
                    return Err(Error::new("invalid_cursor"));
                }
                channels[index] = Some(ChannelBookmark {
                    binding: fingerprint(&json!(
                        cursor
                            .shards
                            .iter()
                            .map(|shard| &shard.filter)
                            .collect::<Vec<_>>()
                    )),
                    shards: cursor
                        .shards
                        .iter()
                        .map(|shard| {
                            (
                                shard.consumed,
                                u8::from(shard.requested)
                                    | (u8::from(shard.succeeded) << 1)
                                    | (u8::from(shard.failed) << 2)
                                    | (u8::from(shard.full_page) << 3),
                            )
                        })
                        .collect(),
                });
            }
        }
        let snapshot = ScanSnapshot {
            facts: IndexFacts {
                target: self.target.clone(),
                projection: crate::types::KNOWLEDGE_PROJECTION.into(),
                segmentation: super::super::source_segments::SEGMENTATION_VERSION.into(),
            },
            channels,
        };
        snapshot.validate()?;
        Ok(snapshot)
    }

    /// 接收边界已核验的 bookmark，核对本次范围；不建立预算、不重置期限。
    pub fn restore_scan(&mut self, snapshot: &ScanSnapshot) -> Result<()> {
        for (index, channel) in [
            ScanChannel::Lexical,
            ScanChannel::Dense,
            ScanChannel::RawLexical,
            ScanChannel::RawDense,
        ]
        .into_iter()
        .enumerate()
        {
            match (self.cursors.cursor_mut(channel), &snapshot.channels[index]) {
                (Some(cursor), Some(saved)) => {
                    let binding = fingerprint(&json!(
                        cursor
                            .shards
                            .iter()
                            .map(|shard| &shard.filter)
                            .collect::<Vec<_>>()
                    ));
                    if binding != saved.binding || cursor.shards.len() != saved.shards.len() {
                        return Err(Error::new("stale_cursor"));
                    }
                    cursor.rounds =
                        usize::from(saved.shards.iter().any(|(_, flags)| flags & 1 != 0));
                    cursor.failed = false;
                    cursor.stopped = None;
                    for (shard, (consumed, flags)) in cursor.shards.iter_mut().zip(&saved.shards) {
                        shard.consumed = *consumed;
                        shard.requested = flags & 1 != 0;
                        shard.succeeded = flags & 2 != 0;
                        shard.failed = flags & 4 != 0;
                        shard.full_page = flags & 8 != 0;
                        shard.dispatched_round = 0;
                        shard.in_flight = false;
                        cursor.failed |= shard.failed;
                    }
                    cursor.last_full_page = cursor.shards.iter().any(|shard| shard.full_page);
                }
                (None, None) => (),
                _ => return Err(Error::new("stale_cursor")),
            }
        }
        self.target = snapshot.facts.target.clone();
        self.refresh_progress();
        Ok(())
    }
}

impl SearchCursors {
    pub fn cursor(&self, channel: ScanChannel) -> Option<&ChannelCursor> {
        match channel {
            ScanChannel::Lexical => self.lexical.as_ref(),
            ScanChannel::Dense => self.dense.as_ref(),
            ScanChannel::RawLexical => self.raw_lexical.as_ref(),
            ScanChannel::RawDense => self.raw_dense.as_ref(),
        }
    }
    pub(super) fn cursor_mut(&mut self, channel: ScanChannel) -> Option<&mut ChannelCursor> {
        match channel {
            ScanChannel::Lexical => self.lexical.as_mut(),
            ScanChannel::Dense => self.dense.as_mut(),
            ScanChannel::RawLexical => self.raw_lexical.as_mut(),
            ScanChannel::RawDense => self.raw_dense.as_mut(),
        }
    }
}
