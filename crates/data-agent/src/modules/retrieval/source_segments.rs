use crate::{
    contracts::generated::{SourceCitation, SourceKey, SourceLocator},
    types::{Error, Result, fingerprint},
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlparser::{
    dialect::GenericDialect,
    tokenizer::{Token, Tokenizer},
};

pub const SEGMENTATION_VERSION: &str = "source-structure-1";
// 投影进度存储的数值版本：与SEGMENTATION_VERSION同升；变更切块规则时同步递增。
pub const SEGMENTATION_VERSION_NUMBER: u32 = 1;
const TARGET_CHARS: usize = 1200;
const MAX_CHARS: usize = 2400;
const OVERLAP_CHARS: usize = 160;
const BATCH_SIZE: usize = 64;
const BACKGROUND_CHARS: usize = 256;

#[derive(Clone, Copy, Debug, Serialize)]
pub enum SourceFormat {
    Text,
    Markdown,
    Sql,
}

pub struct SourceText<'a> {
    pub source: &'a SourceKey,
    pub revision: &'a str,
    pub text: &'a str,
    pub format: SourceFormat,
    pub background: &'a [SourceLocator],
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SegmentCursor {
    binding: String,
    segmentation_version: String,
    next_offset: usize,
}

#[derive(Clone, Debug, Serialize)]
pub struct SegmentBackground {
    pub citation: SourceCitation,
    pub text: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct SourceSegment {
    pub id: String,
    pub citation: SourceCitation,
    pub text: String,
    pub content_hash: String,
    pub background: Vec<SegmentBackground>,
}

#[derive(Debug, Serialize)]
pub struct SegmentBatch {
    pub binding: String,
    pub segments: Vec<SourceSegment>,
    pub next_cursor: Option<SegmentCursor>,
}

pub fn segment_source(
    source: &SourceText<'_>,
    cursor: Option<&SegmentCursor>,
) -> Result<SegmentBatch> {
    segment_source_with_limit(source, cursor, BATCH_SIZE)
}

pub fn segment_source_with_limit(
    source: &SourceText<'_>,
    cursor: Option<&SegmentCursor>,
    max_segments: usize,
) -> Result<SegmentBatch> {
    if !(1..=BATCH_SIZE).contains(&max_segments) {
        return Err(Error::new("invalid_input"));
    }
    let binding = fingerprint(&json!([
        source.source,
        source.revision,
        format!("{:x}", Sha256::digest(source.text.as_bytes())),
        source.format,
        source.background,
        SEGMENTATION_VERSION
    ]));
    let boundaries: Vec<_> = source
        .text
        .char_indices()
        .map(|(byte, _)| byte)
        .chain([source.text.len()])
        .collect();
    let length = boundaries.len() - 1;
    for locator in source.background {
        locator.slice(source.text)?;
    }
    let structure = Structure::read(source.text, source.format);
    let mut start = 0;
    if let Some(cursor) = cursor {
        if cursor.segmentation_version != SEGMENTATION_VERSION {
            return Err(Error::new("invalid_input"));
        }
        if cursor.binding != binding {
            return Err(Error::new("stale_source"));
        }
        if cursor.next_offset == 0 || cursor.next_offset >= length {
            return Err(Error::new("invalid_input"));
        }
        start = cursor.next_offset;
    }
    let mut segments = Vec::new();
    while start < length && segments.len() < max_segments {
        let end = structure.end(start, length);
        let text = &source.text[boundaries[start]..boundaries[end]];
        let citation = citation(source, start, end);
        segments.push(SourceSegment {
            id: fingerprint(&json!([citation, SEGMENTATION_VERSION])),
            citation,
            text: text.to_owned(),
            content_hash: fingerprint(&json!(text)),
            background: structure.background(source, &boundaries, start, end),
        });
        start = if end == length {
            length
        } else {
            end - OVERLAP_CHARS
        };
    }
    Ok(SegmentBatch {
        segments,
        next_cursor: (start < length).then_some(SegmentCursor {
            binding: binding.clone(),
            segmentation_version: SEGMENTATION_VERSION.into(),
            next_offset: start,
        }),
        binding,
    })
}

// 按字符预算截取本批前缀，并返回前缀结束处的续接游标；至少保留一个片段，
// 供后台整理把一批片段限制在模型容量内。整批被取完时沿用原批游标。
pub fn prefix_by_char_budget(
    batch: &SegmentBatch,
    budget_chars: usize,
) -> (Vec<SourceSegment>, Option<SegmentCursor>) {
    let mut used = 0usize;
    let mut take = 0usize;
    for segment in &batch.segments {
        let chars = segment.citation.locator.length.max(0) as usize;
        if take > 0 && used.saturating_add(chars) > budget_chars {
            break;
        }
        used += chars;
        take += 1;
    }
    let taken: Vec<_> = batch.segments.iter().take(take).cloned().collect();
    if take == batch.segments.len() {
        return (taken, batch.next_cursor.clone());
    }
    let last = &batch.segments[take - 1];
    let end = (last.citation.locator.offset + last.citation.locator.length).max(0) as usize;
    // 非末段长度至少为目标片段一半，回退重叠后仍严格前进；防御性下限避免回到0。
    let cursor = SegmentCursor {
        binding: batch.binding.clone(),
        segmentation_version: SEGMENTATION_VERSION.into(),
        next_offset: end.saturating_sub(OVERLAP_CHARS).max(1),
    };
    (taken, Some(cursor))
}

struct Structure {
    ends: Vec<usize>,
    sentences: Vec<usize>,
    headings: Vec<(usize, usize, usize)>,
    tables: Vec<(usize, usize, usize)>,
}

impl Structure {
    fn read(text: &str, format: SourceFormat) -> Self {
        if matches!(format, SourceFormat::Sql)
            && let Some(ends) = sql_boundaries(text)
        {
            return Self {
                ends,
                sentences: Vec::new(),
                headings: Vec::new(),
                tables: Vec::new(),
            };
        }
        let mut ends = Vec::new();
        let mut offset = 0;
        let mut fence = None;
        let mut headings = Vec::new();
        let mut tables = Vec::new();
        let lines = text
            .split_inclusive('\n')
            .map(|line| {
                let start = offset;
                offset += line.chars().count();
                (start, offset, line)
            })
            .collect::<Vec<_>>();
        for (i, &(start, end, line)) in lines.iter().enumerate() {
            let trimmed = line.trim();
            let marker = if trimmed.starts_with("```") {
                Some('`')
            } else if trimmed.starts_with("~~~") {
                Some('~')
            } else {
                None
            };
            if let Some(open) = fence {
                if marker == Some(open) {
                    ends.push(end);
                    fence = None;
                }
            } else if let Some(marker) = marker {
                fence = Some(marker);
            } else {
                let level = trimmed.chars().take_while(|c| *c == '#').count();
                if (1..=6).contains(&level) && trimmed[level..].starts_with(char::is_whitespace) {
                    headings.push((level, start, end));
                    ends.push(start);
                    ends.push(end);
                }
                let cells: Vec<_> = trimmed
                    .trim_matches('|')
                    .split('|')
                    .map(str::trim)
                    .collect();
                let separator = cells.len() >= 2
                    && cells.iter().all(|cell| {
                        cell.contains('-') && cell.chars().all(|c| matches!(c, '-' | ':'))
                    });
                if separator && i > 0 && lines[i - 1].2.contains('|') {
                    let mut table_end = end;
                    for &(_, row_end, row) in lines.iter().skip(i + 1) {
                        if row.trim().is_empty() || !row.contains('|') {
                            break;
                        }
                        ends.push(row_end);
                        table_end = row_end;
                    }
                    tables.push((lines[i - 1].0, end, table_end));
                }
                let numbered_list = [". ", ") "].iter().any(|prefix| {
                    trimmed
                        .trim_start_matches(|c: char| c.is_ascii_digit())
                        .starts_with(prefix)
                });
                if trimmed.is_empty()
                    || ["- ", "* ", "+ "]
                        .iter()
                        .any(|prefix| trimmed.starts_with(prefix))
                    || numbered_list
                {
                    ends.push(end);
                }
            }
        }
        ends.push(offset);
        ends.sort_unstable();
        ends.dedup();
        let sentences = text
            .chars()
            .enumerate()
            .filter_map(|(i, c)| {
                matches!(c, '。' | '！' | '？' | ';' | '；' | '.' | '?' | '!').then_some(i + 1)
            })
            .collect();
        Self {
            ends,
            sentences,
            headings,
            tables,
        }
    }

    fn end(&self, start: usize, length: usize) -> usize {
        let target = (start + TARGET_CHARS).min(length);
        let hard_end = (start + MAX_CHARS).min(length);
        let closest = |points: &[usize]| {
            points
                .iter()
                .copied()
                .filter(|end| *end >= start + TARGET_CHARS / 2 && *end <= hard_end)
                .min_by_key(|end| (end.abs_diff(target), *end))
        };
        closest(&self.ends)
            .or_else(|| closest(&self.sentences))
            .unwrap_or(target)
    }

    fn background(
        &self,
        source: &SourceText<'_>,
        boundaries: &[usize],
        start: usize,
        end: usize,
    ) -> Vec<SegmentBackground> {
        let mut ranges = self
            .tables
            .iter()
            .filter(|(_, header_end, table_end)| *header_end < end && *table_end > start)
            .map(|(a, b, _)| (*a, *b))
            .collect::<Vec<_>>();
        let mut active_headings = Vec::new();
        for &(level, heading_start, heading_end) in &self.headings {
            if heading_start > start {
                break;
            }
            while active_headings
                .last()
                .is_some_and(|(previous, _, _)| *previous >= level)
            {
                active_headings.pop();
            }
            active_headings.push((level, heading_start, heading_end));
        }
        ranges.extend(active_headings.into_iter().map(|(_, a, b)| (a, b)));
        ranges.extend(source.background.iter().map(|locator| {
            (
                locator.offset as usize,
                (locator.offset + locator.length) as usize,
            )
        }));
        let mut remaining = BACKGROUND_CHARS;
        let mut result = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for (a, b) in ranges {
            if remaining == 0 {
                break;
            }
            if a == b || (a >= start && b <= end) || !seen.insert((a, b)) {
                continue;
            }
            let clipped_end = b.min(a + remaining);
            result.push(SegmentBackground {
                citation: citation(source, a, clipped_end),
                text: source.text[boundaries[a]..boundaries[clipped_end]].to_owned(),
            });
            remaining -= clipped_end - a;
        }
        result
    }
}

fn sql_boundaries(text: &str) -> Option<Vec<usize>> {
    // 方言不明或词法失败时只按原文回退；这里不执行SQL，也不改写来源。
    if text.contains("\"\"\"") || text.contains("'''") {
        return None;
    }
    let tokens = Tokenizer::new(&GenericDialect, text)
        .with_unescape(false)
        .tokenize_with_location()
        .ok()?;
    let mut line_starts = vec![0];
    let mut length = 0;
    for character in text.chars() {
        length += 1;
        if character == '\n' {
            line_starts.push(length);
        }
    }
    let tokens = tokens
        .into_iter()
        .filter(|token| !matches!(token.token, Token::Whitespace(_)))
        .collect::<Vec<_>>();
    let mut ends = Vec::new();
    let mut depth = 0usize;
    for (index, token) in tokens.iter().enumerate() {
        let boundary = match &token.token {
            Token::Word(word) if word.quote_style.is_none() && word.value.contains('#') => {
                return None;
            }
            Token::Char(_)
            | Token::LBracket
            | Token::RBracket
            | Token::Sharp
            | Token::DoubleSharp
            | Token::DuckIntDiv => return None,
            Token::LParen => {
                depth += 1;
                false
            }
            Token::RParen => {
                depth = depth.checked_sub(1)?;
                depth == 0
                    && !tokens
                        .get(index + 1)
                        .is_some_and(|next| matches!(next.token, Token::Comma))
            }
            Token::Comma => {
                depth == 0 && index > 0 && matches!(tokens[index - 1].token, Token::RParen)
            }
            Token::SemiColon => depth == 0,
            _ => false,
        };
        if boundary {
            // 注释、换行留在同一个连续区间；下一段仍通过重叠保留边界上下文。
            let end = if let Some(next) = tokens.get(index + 1) {
                let location = next.span.start;
                line_starts.get(usize::try_from(location.line).ok()?.checked_sub(1)?)?
                    + usize::try_from(location.column).ok()?.checked_sub(1)?
            } else {
                length
            };
            ends.push(end);
        }
    }
    if depth != 0 {
        return None;
    }
    ends.push(length);
    Some(ends)
}

fn citation(source: &SourceText<'_>, start: usize, end: usize) -> SourceCitation {
    SourceCitation {
        source: source.source.clone(),
        revision: source.revision.to_owned(),
        locator: SourceLocator {
            offset: start as i64,
            length: (end - start) as i64,
            heading_path: None,
        },
    }
}
