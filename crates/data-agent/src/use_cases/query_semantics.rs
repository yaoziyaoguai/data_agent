use crate::types::{Error, Result};
use serde_json::Value;

/// 只核对已声明的口径决策；引用真实不等于语义充分，不替模型判断是否发现全部歧义。
pub(super) fn validate_resolution(
    args: &Value,
    user_message: &str,
    user_supplied: bool,
) -> Result<()> {
    let Some(resolution) = args.get("semantic_resolution") else {
        return Ok(());
    };
    let basis = resolution["basis"]
        .as_str()
        .ok_or(Error::new("invalid_input"))?;
    let unresolved = resolution["unresolved_differences"]
        .as_array()
        .ok_or(Error::new("invalid_input"))?;
    // 先阻止已知未决口径，避免把准备中的SQL存为可执行稿或使旧稿失效。
    if basis == "needs_clarification" || !unresolved.is_empty() {
        return Err(Error::new("clarification_required"));
    }
    match basis {
        "explicit_user" => {
            let quote = resolution["user_quote"]
                .as_str()
                .filter(|quote| !quote.trim().is_empty())
                .ok_or(Error::new("invalid_evidence"))?;
            // 完整绑定保留否定、条件和例外；引用子串不能代表用户采用。
            if !user_supplied || quote.trim() != user_message.trim() {
                return Err(Error::new("invalid_evidence"));
            }
        }
        "unambiguous" => {}
        _ => return Err(Error::new("invalid_input")),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn decision(basis: &str, quote: Option<&str>, unresolved: Vec<&str>) -> Value {
        json!({"semantic_resolution": {
            "interpretation":"按用户明确的单位与范围计算",
            "basis":basis,
            "user_quote":quote,
            "unresolved_differences":unresolved
        }})
    }

    #[test]
    fn existing_calls_and_unambiguous_decisions_remain_available() {
        assert!(validate_resolution(&json!({}), "给出每月金额", true).is_ok());
        assert!(
            validate_resolution(&decision("unambiguous", None, vec![]), "给出每月金额", true)
                .is_ok()
        );
    }

    #[test]
    fn declared_open_choices_block_even_when_another_field_claims_adoption() {
        for basis in ["explicit_user", "unambiguous", "needs_clarification"] {
            assert_eq!(
                validate_resolution(
                    &decision(basis, Some("按交易数计算"), vec!["时间按创建还是完成归属"]),
                    "按交易数计算",
                    true
                )
                .unwrap_err()
                .code,
                "clarification_required"
            );
        }
        assert_eq!(
            validate_resolution(
                &decision("needs_clarification", None, vec![]),
                "给出比率",
                true
            )
            .unwrap_err()
            .code,
            "clarification_required"
        );
    }

    #[test]
    fn explicit_adoption_quote_must_really_occur_in_this_user_message() {
        let message = "按交易数计算。\n使用北京时间，先不要执行。";
        assert!(
            validate_resolution(
                &decision("explicit_user", Some(message), vec![]),
                message,
                true
            )
            .is_ok()
        );
        for quote in [
            None,
            Some(""),
            Some(" \n "),
            Some("按金额计算"),
            Some("用户已确认交易口径"),
            Some("按交易数计算"),
        ] {
            assert_eq!(
                validate_resolution(&decision("explicit_user", quote, vec![]), message, true)
                    .unwrap_err()
                    .code,
                "invalid_evidence"
            );
        }
    }

    #[test]
    fn creating_a_task_is_not_a_user_adoption_basis() {
        assert_eq!(
            validate_resolution(
                &decision("established_context", None, vec![]),
                "给出比率",
                true
            )
            .unwrap_err()
            .code,
            "invalid_input"
        );
    }

    #[test]
    fn adopting_quote_cannot_strip_negation_or_impersonate_user_input() {
        for message in [
            "不要按订单数计算。",
            "如果能核对完整定义，再按订单数计算；否则先澄清。",
        ] {
            assert_eq!(
                validate_resolution(
                    &decision("explicit_user", Some("按订单数计算"), vec![]),
                    message,
                    true,
                )
                .unwrap_err()
                .code,
                "invalid_evidence"
            );
        }
        let system_message = "查询结果已到达，请解释。";
        assert_eq!(
            validate_resolution(
                &decision("explicit_user", Some(system_message), vec![]),
                system_message,
                false,
            )
            .unwrap_err()
            .code,
            "invalid_evidence"
        );
    }
}
