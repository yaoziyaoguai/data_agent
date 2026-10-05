pub mod memory_index;
pub mod memory_provider;
mod store;
pub use store::{
    begin_save_in_tx, begin_selection_in_tx, change_state_in_tx, list_in_tx, read_in_tx,
    record_adoption_in_tx, save_in_tx, select_in_tx, selected_in_tx,
};

// 模型选择本次纠错的适用分句；宿主核对真实原文与明确的临时/否定限定。
// 句边界防止把“不要记住”裁成“记住”来放宽范围，不承担自然语言规划。
pub fn memory_source(message: &str, quote: &str, scope: &str) -> crate::types::Result<String> {
    use crate::types::Error;
    let quote = quote.trim();
    let separator = |c: char| matches!(c, '。' | '！' | '？' | '；' | '\n' | ';' | '!' | '?');
    if quote.is_empty() {
        return Err(Error::new("scope_incomplete"));
    }
    // 明确另起的指令允许接在逗号后；引用只用于定位，审计来源保留尾部限定。
    let separate_instruction = quote.starts_with("另外") || quote.starts_with("此外");
    let source = message
        .match_indices(quote)
        .find_map(|(start, _)| {
            let before =
                message[..start].trim_end_matches(|c: char| c.is_whitespace() && c != '\n');
            if !(before.is_empty()
                || before.chars().next_back().is_some_and(separator)
                || (separate_instruction && before.ends_with([',', '，'])))
            {
                return None;
            }
            let suffix = &message[start + quote.len()..];
            let after = suffix.trim_start_matches(|c: char| c.is_whitespace() && c != '\n');
            if quote.chars().next_back().is_some_and(separator)
                || after.is_empty()
                || after.chars().next().is_some_and(separator)
            {
                Some(quote.to_owned())
            } else if after.starts_with([',', '，']) || quote.ends_with([',', '，']) {
                let end = suffix.find(separator).unwrap_or(suffix.len());
                Some(format!("{quote}{}", &suffix[..end]).trim().to_owned())
            } else {
                None
            }
        })
        .ok_or(Error::new("scope_incomplete"))?;
    let temporary = ["仅本次", "仅这次", "不要记住", "不要保存"]
        .iter()
        .any(|word| source.contains(word) || scope.contains(word));
    if temporary {
        return Err(Error::new("scope_incomplete"));
    }
    Ok(source)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn complete_sentence_quote_can_precede_another_sentence() {
        for ending in ["。", "！", "？", "；", "\n", ";", "!", "?"] {
            let quote = format!("请记住：以后我的分析默认只看web渠道{ending}");
            let message = format!("{quote}现在不查数据。");
            assert_eq!(
                memory_source(&message, &quote, "默认渠道").unwrap(),
                quote.trim()
            );
        }
        for (message, quote) in [
            ("不要记住：以后默认web。现在不查数据。", "以后默认web。"),
            ("仅本次默认web。现在不查数据。", "仅本次默认web。"),
            ("以后默认web，仅本次。现在不查数据。", "以后默认web，"),
        ] {
            assert!(memory_source(message, quote, "默认渠道").is_err());
        }
    }
    #[test]
    fn mixed_intents_bind_memory_to_the_reusable_clause() {
        let input = "以后我的分析默认只看web，但这次查2026年1月全部渠道净收入";
        assert_eq!(
            memory_source(input, "以后我的分析默认只看web", "默认渠道偏好").unwrap(),
            input
        );
        assert_eq!(
            memory_source(input, "以后我的分析默认只看web，", "默认渠道偏好").unwrap(),
            input
        );
        assert_eq!(
            memory_source(
                "以后默认用元，但这次用分；仅本次按web分析。",
                "以后默认用元",
                "金额展示偏好"
            )
            .unwrap(),
            "以后默认用元，但这次用分"
        );
        let input = "仅本次按 web 渠道分析；另外请记住以后金额用元展示。";
        assert!(memory_source(input, "另外请记住以后金额用元展示", "金额展示偏好").is_ok());
        assert!(
            memory_source(
                "仅本次按 web 渠道分析，另外请记住以后金额用元展示。",
                "另外请记住以后金额用元展示",
                "金额展示偏好"
            )
            .is_ok()
        );
        for quote in [
            "仅本次按 web 渠道分析",
            "记住以后金额用元展示",
            "另外请记住以后金额用美元展示",
        ] {
            assert!(memory_source(input, quote, "金额展示偏好").is_err());
        }
        for (input, quote) in [
            ("不要记住，金额用元展示。", "金额用元展示"),
            ("金额用元展示，仅本次。", "金额用元展示"),
            ("金额用元展示，仅本次。", "金额用元展示，"),
            (
                "仅本次按 web 分析，另外金额用元展示，不要保存。",
                "另外金额用元展示",
            ),
            (
                "仅本次按 web 分析，另外金额用元展示，不要保存。",
                "另外金额用元展示，不要保存",
            ),
        ] {
            assert!(memory_source(input, quote, "金额展示偏好").is_err());
        }
        assert!(
            memory_source(
                "不要记住以后金额用元展示",
                "记住以后金额用元展示",
                "金额展示偏好"
            )
            .is_err()
        );
    }
}
