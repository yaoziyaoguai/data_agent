use super::*;

pub(super) const SEARCH_CURSOR_BYTES: usize = 65_536;

// 定位只投影白名单字段；名称、正文、filter、允许集和dense向量不进入快照。
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct SavedLocation {
    #[serde(rename = "e")]
    pub(super) entry_id: Option<String>,
    #[serde(rename = "p")]
    pub(super) path: Option<String>,
    #[serde(rename = "s")]
    pub(super) statement_id: Option<String>,
    #[serde(rename = "t")]
    pub(super) statement_offset: Option<u64>,
    #[serde(rename = "o")]
    pub(super) offset: Option<u64>,
    #[serde(rename = "l")]
    pub(super) length: Option<u64>,
    #[serde(rename = "h")]
    pub(super) content_hash: Option<String>,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub(super) enum SavedCandidate {
    #[serde(rename = "k")]
    Knowledge(String, String, String, Vec<SavedLocation>),
    #[serde(rename = "r")]
    Raw(String, String, u64, u64, u64, String),
}
impl SavedCandidate {
    pub(super) fn capture(row: &Value, raw: bool) -> Result<Self> {
        let invalid = || Error::new("invalid_cursor");
        if raw {
            return Ok(Self::Raw(
                row["source_kind"]
                    .as_str()
                    .filter(|kind| matches!(*kind, "document" | "platform"))
                    .ok_or_else(invalid)?
                    .into(),
                row["source_id"].as_str().ok_or_else(invalid)?.into(),
                row["revision"].as_u64().ok_or_else(invalid)?,
                row["offset"].as_u64().ok_or_else(invalid)?,
                row["length"]
                    .as_u64()
                    .filter(|length| *length > 0 && *length <= 2400)
                    .ok_or_else(invalid)?,
                row["content_hash"].as_str().ok_or_else(invalid)?.into(),
            ));
        }
        let locations = row["matches"]
            .as_array()
            .ok_or_else(invalid)?
            .iter()
            .map(|location| {
                serde_json::from_value(json!({"e":location["entry_id"],"p":location["path"],
                "s":location["statement_id"],"t":location["statement_offset"],
                "o":location["offset"],"l":location["length"],"h":location["content_hash"]}))
                .map_err(|_| invalid())
            })
            .collect::<Result<Vec<SavedLocation>>>()?;
        if locations.is_empty() || locations.len() > 1000 {
            return Err(invalid());
        }
        Ok(Self::Knowledge(
            row["id"].as_str().ok_or_else(invalid)?.into(),
            row["version"].as_str().ok_or_else(invalid)?.into(),
            retrieval::knowledge_record(row).to_owned(),
            locations,
        ))
    }
    pub(super) fn row(&self, score: f64) -> Value {
        match self {
            Self::Knowledge(id, version, record, locations) => {
                json!({"id":id,"version":version,"record_id":record,
                "matches":locations.iter().map(|location| json!({"fragment_id":record,"entry_id":location.entry_id,
                    "path":location.path,"statement_id":location.statement_id,"statement_offset":location.statement_offset,
                    "offset":location.offset,"length":location.length,"content_hash":location.content_hash,"score":score})).collect::<Vec<_>>()})
            }
            Self::Raw(kind, id, revision, offset, length, hash) => {
                json!({"source_kind":kind,"source_id":id,
                "revision":revision,"offset":offset,"length":length,"content_hash":hash,
                "segmentation_version":source_segments::SEGMENTATION_VERSION,"distance":score,"score":score})
            }
        }
    }
    pub(super) fn key(&self) -> String {
        match self {
            Self::Knowledge(_, _, record, _) => format!("k:{record}"),
            Self::Raw(..) => format!(
                "raw:{}",
                retrieval::raw_record(&self.row(0.)).expect("saved raw identity")
            ),
        }
    }
}

/// 有界排序窗口与扫描位置。外层绑定查询/任务/权限；本值本身不能授权读取。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(try_from = "SearchContinuationWire", into = "SearchContinuationWire")]
pub struct SearchContinuation {
    #[serde(skip)]
    pub(super) space: Option<String>,
    #[serde(rename = "v")]
    pub(super) schema: u8,
    #[serde(rename = "s")]
    pub(super) scan: retrieval::vector::ScanSnapshot,
    #[serde(rename = "r")]
    pub(super) records: Vec<SavedCandidate>,
    // SQL两owner先合成一条有序词法输入，不另添RRF票。
    #[serde(rename = "c")]
    pub(super) channels: [Vec<(usize, f64)>; 5],
    #[serde(rename = "q")]
    pub(super) sql: [(usize, bool, bool); 2],
    #[serde(rename = "d")]
    pub(super) retired: Vec<usize>,
    #[serde(rename = "a")]
    pub(super) sql_active: bool,
}
// 仍由同一类型直接serde恢复；紧凑表示只去重定位常量并编码原摘要，不重扫窗口。
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct SearchContinuationWire {
    pub(super) v: u8,
    pub(super) s: retrieval::vector::ScanSnapshot,
    #[serde(default)]
    pub(super) r: Vec<SavedCandidate>,
    #[serde(default)]
    pub(super) c: [Vec<(usize, f64)>; 5],
    pub(super) q: [(usize, bool, bool); 2],
    pub(super) d: SavedRetired,
    pub(super) a: bool,
    pub(super) h: SavedHistory,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) p: Option<CompactWindow>,
}
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(untagged)]
enum SavedHistory {
    Digests(Vec<String>),
    Packed(String),
}
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(untagged)]
enum SavedRetired {
    Indexes(Vec<usize>),
    Bitmap(String),
}
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct CompactWindow {
    pub(super) s: String,
    pub(super) n: usize,
    pub(super) g: Vec<CompactGroup>,
    pub(super) f: Vec<(usize, SavedCandidate)>,
    // 词法（含SQL替代）与dense共同原名次；原始分数只用于形成这些名次。
    pub(super) c: [Vec<usize>; 2],
}
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct CompactGroup {
    pub(super) r: SavedCandidate,
    pub(super) b: Option<i64>,
    // 每项为原成员下标u16、原offset u64、原SHA-256 32字节，均为大端。
    pub(super) d: String,
    // SQL owner未读取正文，未知hash只保存成员及位置，恢复时仍为null。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(super) u: Vec<(usize, u64)>,
}
impl From<SearchContinuation> for SearchContinuationWire {
    fn from(saved: SearchContinuation) -> Self {
        let compact = saved.space.as_deref().filter(|_| !saved.records.is_empty()).map(|space| {
            let mut compact = CompactWindow { s: space.to_owned(), n: saved.records.len(),
                g: vec![], f: vec![], c: std::array::from_fn(|_| vec![]) };
            let mut groups: Vec<(CompactGroup, Vec<u8>)> = Vec::new();
            for (index, record) in saved.records.iter().enumerate() {
                let fields = match record {
                    SavedCandidate::Knowledge(id, version, key, locations) if locations.len() == 1 => {
                        let location = &locations[0];
                        location.offset.and_then(|offset| {
                            let expected = crate::types::knowledge_record_id(space,
                                &json!({"id":id,"version":version}),
                                &json!({"entry_id":location.entry_id,"path":location.path,"statement_id":location.statement_id}),
                                usize::try_from(offset).ok()?);
                            if expected != *key { return None; }
                            let base = location.statement_offset.map(|local| i64::try_from(offset as i128 - local as i128)).transpose().ok()?;
                            let mut template = location.clone();
                            template.offset = None; template.statement_offset = None; template.content_hash = None;
                            Some((SavedCandidate::Knowledge(id.clone(), version.clone(), String::new(), vec![template]), base, offset, location.content_hash.as_ref()))
                        })
                    }
                    SavedCandidate::Raw(kind, id, revision, offset, length, hash) =>
                        Some((SavedCandidate::Raw(kind.clone(), id.clone(), *revision, 0, *length, String::new()), None, *offset, Some(hash))),
                    _ => None,
                };
                let Some((template, base, offset, hash)) = fields.filter(|(_, _, _, hash)| hash.is_none_or(|hash|
                    hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))) else {
                    compact.f.push((index, record.clone())); continue;
                };
                let (group, bytes) = if let Some(group) = groups.iter_mut().find(|(group, _)| group.r == template && group.b == base) {
                    group
                } else {
                    groups.push((CompactGroup { r: template, b: base, d: String::new(), u: vec![] }, vec![]));
                    groups.last_mut().expect("new location group")
                };
                if let Some(hash) = hash {
                    bytes.extend_from_slice(&(index as u16).to_be_bytes());
                    bytes.extend_from_slice(&offset.to_be_bytes());
                    for pair in hash.as_bytes().as_chunks::<2>().0.iter() {
                        bytes.push(u8::from_str_radix(std::str::from_utf8(pair).expect("hex pair"), 16).expect("validated SHA-256"));
                    }
                } else {
                    group.u.push((index, offset));
                }
            }
            compact.g = groups.into_iter().map(|(mut group, bytes)| { group.d = URL_SAFE_NO_PAD.encode(bytes); group }).collect();
            for (channel, indexes) in compact.c.iter_mut().enumerate() {
                let mut rows: Vec<_> = match channel {
                    0 => saved.channels[if saved.sql_active { 4 } else { 0 }].iter().chain(&saved.channels[2]).copied().collect(),
                    _ => saved.channels[1].iter().chain(&saved.channels[3]).copied().collect(),
                };
                rows.sort_by(|(left, a), (right, b)| b.total_cmp(a)
                    .then_with(|| saved.records[*left].key().cmp(&saved.records[*right].key())));
                indexes.extend(rows.into_iter().map(|(index, _)| index));
            }
            compact
        });
        let retired = if compact.is_some() && !saved.retired.is_empty() {
            // 原成员编号对应固定位；接近交齐也不因索引列表增长而丢失末项。
            let mut bytes = vec![0u8; saved.records.len().div_ceil(8)];
            for index in &saved.retired {
                bytes[index / 8] |= 1 << (index % 8);
            }
            SavedRetired::Bitmap(URL_SAFE_NO_PAD.encode(bytes))
        } else {
            SavedRetired::Indexes(saved.retired)
        };
        Self {
            v: saved.schema,
            s: saved.scan,
            r: if compact.is_some() {
                vec![]
            } else {
                saved.records
            },
            c: if compact.is_some() {
                std::array::from_fn(|_| vec![])
            } else {
                saved.channels
            },
            q: saved.sql,
            d: retired,
            a: saved.sql_active,
            // R07窗口生命周期：新cursor不携带跨窗去重记录；h仅保持旧格式兼容，
            // 解码时命中的本窗成员并入retired后释放（见absorb_legacy_history）。
            h: SavedHistory::Digests(vec![]),
            p: compact,
        }
    }
}
impl TryFrom<SearchContinuationWire> for SearchContinuation {
    type Error = String;
    fn try_from(wire: SearchContinuationWire) -> std::result::Result<Self, Self::Error> {
        let history = match wire.h {
            SavedHistory::Digests(values) => values,
            SavedHistory::Packed(value) => {
                if value.len() > 42_667 {
                    return Err("oversized identity history".into());
                }
                let bytes = URL_SAFE_NO_PAD
                    .decode(value)
                    .map_err(|_| "invalid identity history")?;
                if bytes.len() % 32 != 0 {
                    return Err("invalid identity history length".into());
                }
                bytes
                    .as_chunks::<32>()
                    .0
                    .iter()
                    .map(|digest| digest.iter().map(|byte| format!("{byte:02x}")).collect())
                    .collect()
            }
        };
        let retired = match wire.d {
            SavedRetired::Indexes(indexes) => indexes,
            SavedRetired::Bitmap(value) => {
                let count = wire.p.as_ref().ok_or("bitmap without compact window")?.n;
                if count == 0 || count > 1000 || value.len() > 167 {
                    return Err("invalid retired bitmap".into());
                }
                let bytes = URL_SAFE_NO_PAD
                    .decode(value)
                    .map_err(|_| "invalid retired bitmap")?;
                if bytes.len() != count.div_ceil(8)
                    || (count % 8 != 0 && bytes[bytes.len() - 1] >> (count % 8) != 0)
                {
                    return Err("invalid retired bitmap length".into());
                }
                (0..count)
                    .filter(|index| bytes[index / 8] & (1 << (index % 8)) != 0)
                    .collect()
            }
        };
        let mut saved = Self {
            schema: wire.v,
            scan: wire.s,
            records: wire.r,
            channels: wire.c,
            sql: wire.q,
            retired,
            sql_active: wire.a,
            space: None,
        };
        let Some(compact) = wire.p else {
            saved.absorb_legacy_history(&history);
            return Ok(saved);
        };
        if compact.n > 1000
            || compact.s.is_empty()
            || compact.s.len() > 64
            || !saved.records.is_empty()
            || saved.channels.iter().any(|channel| !channel.is_empty())
            || compact.g.len() > 1000
            || compact.f.len() > 1000
        {
            return Err("invalid compact search window".into());
        }
        let mut records = vec![None; compact.n];
        for (index, record) in compact.f {
            let slot = records
                .get_mut(index)
                .filter(|slot| slot.is_none())
                .ok_or("duplicate window member")?;
            *slot = Some(record);
        }
        for group in compact.g {
            if group.d.len() > 56_000 || group.u.len() > 1000 {
                return Err("oversized location group".into());
            }
            let bytes = URL_SAFE_NO_PAD
                .decode(&group.d)
                .map_err(|_| "invalid location encoding")?;
            if (bytes.is_empty() && group.u.is_empty()) || bytes.len() % 42 != 0 {
                return Err("invalid location group".into());
            }
            let hashed = bytes.as_chunks::<42>().0.iter().map(|item| {
                let index =
                    u16::from_be_bytes(item[..2].try_into().expect("fixed member index")) as usize;
                let offset = u64::from_be_bytes(item[2..10].try_into().expect("fixed offset"));
                let hash = item[10..]
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>();
                (index, offset, Some(hash))
            });
            for (index, offset, hash) in hashed.chain(
                group
                    .u
                    .into_iter()
                    .map(|(index, offset)| (index, offset, None)),
            ) {
                let record = match &group.r {
                    SavedCandidate::Knowledge(id, version, key, locations)
                        if key.is_empty() && locations.len() == 1 =>
                    {
                        let mut location = locations[0].clone();
                        if location.offset.is_some()
                            || location.statement_offset.is_some()
                            || location.content_hash.is_some()
                        {
                            return Err("invalid location template".into());
                        }
                        location.offset = Some(offset);
                        location.content_hash = hash;
                        location.statement_offset = group
                            .b
                            .map(|base| u64::try_from(offset as i128 - base as i128))
                            .transpose()
                            .map_err(|_| "invalid statement offset")?;
                        let key = crate::types::knowledge_record_id(
                            &compact.s,
                            &json!({"id":id,"version":version}),
                            &json!({"entry_id":location.entry_id,"path":location.path,"statement_id":location.statement_id}),
                            usize::try_from(offset).map_err(|_| "invalid offset")?,
                        );
                        SavedCandidate::Knowledge(id.clone(), version.clone(), key, vec![location])
                    }
                    SavedCandidate::Raw(kind, id, revision, 0, length, hash_template)
                        if hash_template.is_empty() && group.b.is_none() =>
                    {
                        SavedCandidate::Raw(
                            kind.clone(),
                            id.clone(),
                            *revision,
                            offset,
                            *length,
                            hash.ok_or("raw location requires content hash")?,
                        )
                    }
                    _ => return Err("invalid member template".into()),
                };
                let slot = records
                    .get_mut(index)
                    .filter(|slot| slot.is_none())
                    .ok_or("duplicate window member")?;
                *slot = Some(record);
            }
        }
        saved.records = records
            .into_iter()
            .collect::<Option<Vec<_>>>()
            .ok_or("missing window member")?;
        for (channel, order) in compact.c.into_iter().enumerate() {
            if order.len() > 1000 {
                return Err("oversized channel order".into());
            }
            let count = order.len();
            let mut seen = std::collections::HashSet::new();
            for (rank, index) in order.into_iter().enumerate() {
                let record = saved
                    .records
                    .get(index)
                    .filter(|_| seen.insert(index))
                    .ok_or("invalid channel member")?;
                let target = match (channel, record) {
                    (0, SavedCandidate::Knowledge(..)) => {
                        if saved.sql_active {
                            4
                        } else {
                            0
                        }
                    }
                    (0, SavedCandidate::Raw(..)) => 2,
                    (1, SavedCandidate::Knowledge(..)) => 1,
                    (1, SavedCandidate::Raw(..)) => 3,
                    _ => return Err("invalid channel member".into()),
                };
                saved.channels[target].push((index, (count - rank) as f64));
            }
        }
        saved.space = Some(compact.s);
        saved.absorb_legacy_history(&history);
        Ok(saved)
    }
}
impl SearchContinuation {
    pub fn index_facts(&self) -> &retrieval::vector::IndexFacts {
        &self.scan.facts
    }

    pub fn capture(
        vector: &retrieval::vector::Candidates,
        sql: &[Vec<Value>; 2],
        retired: &[String],
    ) -> Result<Self> {
        let mut saved = Self {
            space: vector.space.clone().or_else(|| {
                vector
                    .lexical
                    .iter()
                    .chain(&vector.values)
                    .find_map(|row| row["space_id"].as_str().map(str::to_owned))
            }),
            schema: 1,
            scan: vector.snapshot_scan()?,
            records: vec![],
            channels: std::array::from_fn(|_| vec![]),
            sql: [(0, false, false); 2],
            retired: vec![],
            sql_active: vector.sql_lexical_active() && vector.lexical.is_empty(),
        };
        let mut keys = std::collections::HashMap::new();
        let sql = retrieval::merge_sql_lexical(sql[0].clone(), sql[1].clone());
        for (channel, rows) in [
            &vector.lexical,
            &vector.values,
            &vector.raw.lexical,
            &vector.raw.dense,
            &sql,
        ]
        .into_iter()
        .enumerate()
        {
            for row in rows {
                let candidate = SavedCandidate::capture(row, channel == 2 || channel == 3)?;
                let key = candidate.key();
                let index = if let Some(index) = keys.get(&key) {
                    *index
                } else {
                    if saved.records.len() >= 1000 {
                        return Err(Error::new("tool_response_capacity"));
                    }
                    let index = saved.records.len();
                    keys.insert(key, index);
                    saved.records.push(candidate);
                    index
                };
                let score = if channel == 2 || channel == 3 {
                    row["distance"].as_f64().unwrap_or(0.)
                } else {
                    row["matches"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|location| location["score"].as_f64())
                        .max_by(f64::total_cmp)
                        .unwrap_or(0.)
                };
                if !saved.channels[channel]
                    .iter()
                    .any(|(seen, _)| *seen == index)
                {
                    saved.channels[channel].push((index, score));
                }
            }
        }
        saved.retired = retired
            .iter()
            .filter_map(|key| keys.get(key).copied())
            .collect();
        saved.retired.sort_unstable();
        saved.retired.dedup();
        Ok(saved)
    }
    pub(super) fn rows(&self, channel: usize) -> Vec<Value> {
        self.channels[channel]
            .iter()
            .map(|(index, score)| self.records[*index].row(*score))
            .collect()
    }
    pub(super) fn has_pending(&self) -> bool {
        self.retired.len() < self.records.len()
    }
    pub(super) fn has_more(&self) -> bool {
        self.has_pending()
            || self.scan.has_more()
            || (self.sql_active && self.sql.iter().any(|(_, _, exhausted)| !exhausted))
    }
    /// 只核对本窗尚未交付的知识版本；当前元信息由owner核验后提供。
    pub fn assert_pending_knowledge(&self, current: &[Value]) -> Result<()> {
        for record in &self.records {
            if self.suppresses(&record.key()) {
                continue;
            }
            if let SavedCandidate::Knowledge(id, version, key, _) = record
                && !current.iter().any(|row| {
                    row["id"] == *id
                        && row["version"] == *version
                        && retrieval::knowledge_record(row) == key
                })
            {
                return Err(Error::new("stale_cursor"));
            }
        }
        Ok(())
    }
    pub fn snapshot(
        &self,
        delivered_records: &[String],
        max_bytes: usize,
    ) -> Result<Option<String>> {
        self.validate()?;
        let mut saved = self.clone();
        for key in delivered_records {
            let index = saved
                .records
                .iter()
                .position(|record| record.key() == *key)
                .ok_or(Error::new("invalid_cursor"))?;
            if !saved.retired.contains(&index) {
                saved.retired.push(index);
            }
        }
        saved.retired.sort_unstable();
        if !saved.has_more() {
            return Ok(None);
        }
        if !saved.has_pending() {
            // R07窗口生命周期：本窗全部消费完即释放成员与去重状态，游标只保
            // 通道/分片已消费位置、必要未交引用与原范围/修订事实；跨新窗允许
            // 同身份重现，不再把已结束窗口身份累计进全查询去重记录。
            saved.records.clear();
            saved.channels.iter_mut().for_each(Vec::clear);
            saved.retired.clear();
        }
        let encoded = serde_json::to_string(&saved).map_err(|_| Error::new("invalid_cursor"))?;
        if encoded.len() > max_bytes {
            return Err(Error::new("tool_response_capacity"));
        }
        Ok(Some(encoded))
    }
    pub fn decode(encoded: &str) -> Result<Self> {
        if encoded.len() > SEARCH_CURSOR_BYTES {
            return Err(Error::new("invalid_cursor"));
        }
        let saved: Self =
            serde_json::from_str(encoded).map_err(|_| Error::new("invalid_cursor"))?;
        saved.validate()?;
        Ok(saved)
    }
    /// 已由外层边界反序列化的值复用同一核验，不重做JSON解析。
    pub fn validate(&self) -> Result<()> {
        let saved = self;
        saved.scan.validate()?;
        if saved.schema != 1
            || saved.records.len() > 1000
            || saved.channels.iter().any(|channel| {
                channel.len() > 1000
                    || channel
                        .iter()
                        .any(|(index, score)| *index >= saved.records.len() || !score.is_finite())
            })
            || saved.retired.len() > saved.records.len()
            || saved
                .retired
                .iter()
                .any(|index| *index >= saved.records.len())
        {
            return Err(Error::new("invalid_cursor"));
        }
        let mut keys = std::collections::HashSet::new();
        let mut locations = 0;
        for record in &saved.records {
            if !keys.insert(record.key()) {
                return Err(Error::new("invalid_cursor"));
            }
            match record {
                SavedCandidate::Knowledge(id, version, key, matches) => {
                    locations += matches.len();
                    if id.is_empty()
                        || id.len() > 64
                        || key.is_empty()
                        || key.len() > 128
                        || version
                            .parse::<u64>()
                            .ok()
                            .filter(|version| *version > 0)
                            .is_none()
                        || matches.is_empty()
                        || matches.iter().any(|location| {
                            location.length.is_some_and(|length| {
                                length == 0 || length > crate::types::KNOWLEDGE_WINDOW as u64
                            }) || location.offset.zip(location.length).is_some_and(
                                |(offset, length)| offset.checked_add(length).is_none(),
                            ) || [
                                &location.entry_id,
                                &location.path,
                                &location.statement_id,
                                &location.content_hash,
                            ]
                            .into_iter()
                            .flatten()
                            .any(|value| value.len() > 200)
                        })
                    {
                        return Err(Error::new("invalid_cursor"));
                    }
                }
                SavedCandidate::Raw(kind, id, revision, offset, length, hash) => {
                    locations += 1;
                    if !matches!(kind.as_str(), "document" | "platform")
                        || id.is_empty()
                        || id.len() > 64
                        || *revision == 0
                        || *length == 0
                        || *length > 2400
                        || offset.checked_add(*length).is_none()
                        || hash.is_empty()
                        || hash.len() > 128
                    {
                        return Err(Error::new("invalid_cursor"));
                    }
                }
            }
        }
        if locations > 1000
            || saved.retired.windows(2).any(|pair| pair[0] >= pair[1])
            || saved.channels.iter().any(|channel| {
                let mut seen = std::collections::HashSet::new();
                channel.iter().any(|(index, _)| !seen.insert(index))
            })
        {
            return Err(Error::new("invalid_cursor"));
        }
        Ok(())
    }
    pub(super) fn retire(&mut self, keys: impl Iterator<Item = String>) {
        for key in keys {
            if let Some(index) = self.records.iter().position(|record| record.key() == key)
                && !self.retired.contains(&index)
            {
                self.retired.push(index);
            }
        }
        self.retired.sort_unstable();
    }
    // R07窗口生命周期：抑制只覆盖本窗已交付/已否决成员；跨新窗同身份重现合法。
    pub(super) fn suppresses(&self, key: &str) -> bool {
        self.retired
            .iter()
            .any(|index| self.records[*index].key() == key)
    }
    pub(super) fn restore_window(&self, vector: &mut retrieval::vector::Candidates) -> Result<()> {
        // 同一窗口中已交付项仍影响通道原名次，也属于本次接回的候选输入。
        vector
            .budget
            .restore_candidates(self.records.iter().map(|record| {
                let key = record.key();
                key.strip_prefix("k:").unwrap_or(&key).to_owned()
            }))?;
        vector.lexical = self.rows(0);
        vector.values = self.rows(1);
        vector.raw.lexical = self.rows(2);
        vector.raw.dense = self.rows(3);
        Ok(())
    }
    // R07旧cursor薄转换：命中旧全查询去重记录的本窗成员并入本窗retired，随后
    // 释放全查询history；不能直接清空导致当前窗旧抑制成员重新交付。
    pub(super) fn absorb_legacy_history(&mut self, history: &[String]) {
        if history.is_empty() {
            return;
        }
        for (index, record) in self.records.iter().enumerate() {
            if history.contains(&fingerprint(&json!(record.key())))
                && !self.retired.contains(&index)
            {
                self.retired.push(index);
            }
        }
        self.retired.sort_unstable();
        self.retired.dedup();
    }
    /// 先用完整窗口恢复原通道排名，再去掉已交付/已否决成员，避免局部rank归零。
    pub fn rank_window(&self, query: &str, objects: Vec<Value>) -> retrieval::CommonRank {
        let lexical = if self.sql_active {
            self.rows(4)
        } else {
            self.rows(0)
        };
        let dense = self.rows(1);
        let raw_lexical = self.rows(2);
        let raw_dense = self.rows(3);
        let mut rank = retrieval::rank_common(
            query,
            objects,
            &retrieval::Channels::all(&lexical, &dense, &raw_lexical, &raw_dense),
            1000,
            true,
        );
        rank.sequence.retain(|(_, key)| !self.suppresses(key));
        rank.objects
            .retain(|row| !self.suppresses(&format!("k:{}", retrieval::knowledge_record(row))));
        rank.raw.retain(|row| {
            !self.suppresses(&format!(
                "raw:{}",
                retrieval::raw_record(row).expect("saved raw identity")
            ))
        });
        rank
    }
}
