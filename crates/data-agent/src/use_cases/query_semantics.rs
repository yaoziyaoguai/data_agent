use crate::{
    modules::analysis,
    types::{Error, Result},
};
use serde_json::{Value, json};

/// 这些合约字段都可引入资料依据；合并后在同一边界核验，不能只查主knowledge_refs。
pub(super) fn knowledge_references(inputs: &[&Value]) -> Value {
    let mut references = Vec::new();
    for input in inputs {
        let mut groups = vec![
            input.get("knowledge_refs"),
            input["semantic_resolution"].get("evidence_refs"),
        ];
        for role in input["time_roles"].as_array().into_iter().flatten() {
            groups.push(role.get("evidence_refs"));
        }
        for reference in groups
            .into_iter()
            .flatten()
            .filter_map(Value::as_array)
            .flatten()
        {
            if !references.contains(reference) {
                references.push(reference.clone());
            }
        }
    }
    json!(references)
}

fn unresolved_declared(resolution: &Value) -> bool {
    analysis::legacy_resolution_pending(resolution)
}

/// 本轮真实消息亲自采纳的核对：引用必须是本轮用户完整原话，系统结果唤醒不算。
fn verify_current_adoption(
    resolution: &Value,
    user_message: &str,
    user_supplied: bool,
) -> Result<()> {
    let quote = resolution["user_quote"]
        .as_str()
        .filter(|quote| !quote.trim().is_empty())
        .ok_or(Error::new("invalid_evidence"))?;
    // 完整绑定保留否定、条件和例外；引用子串不能代表用户采用。
    if !user_supplied || quote.trim() != user_message.trim() {
        return Err(Error::new("invalid_evidence"));
    }
    Ok(())
}

/// 只核对已声明的口径决策；引用真实不等于语义充分，不替模型判断是否发现全部歧义。
/// explicit_user的采纳身份由宿主绑定：adoption_message_id必须等于本轮真实消息，
/// 模型自由填写旧消息ID不构成采纳证明。
pub(super) fn validate_resolution(
    resolution: Option<&Value>,
    user_message: &str,
    user_supplied: bool,
    message_id: &str,
) -> Result<()> {
    let Some(resolution) = resolution.filter(|value| !value.is_null()) else {
        return Ok(());
    };
    // 先阻止已知未决口径，避免把准备中的SQL存为可执行稿或使旧稿失效。
    if unresolved_declared(resolution) {
        return Err(Error::new("clarification_required"));
    }
    match resolution["basis"].as_str() {
        Some("explicit_user") => {
            verify_current_adoption(resolution, user_message, user_supplied)?;
            // 采纳身份由宿主绑定本轮真实消息：模型省略（null，待绑定）或恰好填对
            // 本轮ID都算新采纳；其余任何ID都不构成采纳证明。
            let adoption = resolution["adoption_message_id"].as_str();
            if adoption.is_some_and(|id| id != message_id) {
                return Err(Error::new("invalid_evidence"));
            }
        }
        Some("unambiguous") => {
            if resolution
                .get("adoption_message_id")
                .is_some_and(|v| !v.is_null())
            {
                return Err(Error::new("invalid_input"));
            }
        }
        _ => return Err(Error::new("invalid_input")),
    }
    Ok(())
}

/// 条件层的口径决策纪律（create完整条件与revise补丁同用）：未决状态允许如实记录，
/// 随后按条件版本阻断草稿保存；explicit_user要么绑定本轮真实消息（省略待宿主绑定
/// 或恰好填对），要么逐字复制同任务当前条件里已验证的原采纳身份；
/// unambiguous不得携带采纳身份。
pub(super) fn validate_condition_resolution(
    resolution: &Value,
    user_message: &str,
    user_supplied: bool,
    message_id: &str,
    inherited: Option<&Value>,
) -> Result<()> {
    if unresolved_declared(resolution) {
        return Ok(());
    }
    match resolution["basis"].as_str() {
        Some("explicit_user") => {
            if resolution["adoption_message_id"]
                .as_str()
                .is_none_or(|id| id == message_id)
            {
                verify_current_adoption(resolution, user_message, user_supplied)
            } else {
                // 复制继承：与当前条件已验证决策逐字一致才成立；改写内容或凭空
                // 引用旧消息ID都不是采纳证明。
                if inherited.is_some_and(|prior| analysis::same_adoption(prior, resolution)) {
                    Ok(())
                } else {
                    Err(Error::new("invalid_evidence"))
                }
            }
        }
        Some("unambiguous") => {
            if resolution
                .get("adoption_message_id")
                .is_some_and(|v| !v.is_null())
            {
                Err(Error::new("invalid_input"))
            } else {
                Ok(())
            }
        }
        _ => Err(Error::new("invalid_input")),
    }
}

/// 草稿决策与目标条件版本对齐：条件声明未决→阻断保存；条件声明已决→草稿省略
/// 即继承该决策、携带则必须与之一致（不一致先修订条件）；条件未声明→草稿自带
/// 决策按本轮绑定纪律独立成立。返回实际持久化到草稿的决策。
pub(super) fn draft_resolution(
    args: Option<&Value>,
    declared: Option<&Value>,
    user_message: &str,
    user_supplied: bool,
    message_id: &str,
) -> Result<Option<Value>> {
    // 采纳身份宿主绑定：模型省略adoption_message_id的新采纳在持久化前回填本轮
    // 真实消息身份，下游继承因此有真实种子；模型永远不需要也不应该知道消息ID。
    let bind = |mut value: Value| -> Value {
        if value["basis"] == "explicit_user" && value["adoption_message_id"].is_null() {
            value["adoption_message_id"] = json!(message_id);
        }
        value
    };
    // 先绑定再比较：模型省略身份的新采纳与条件里已回填的同一决策必须deep-equal，
    // 否则省略的携带会被误判成与声明不一致。
    let args = args
        .filter(|value| !value.is_null())
        .map(|value| bind(value.clone()));
    let Some(declared) = declared.filter(|value| value.is_object()) else {
        validate_resolution(args.as_ref(), user_message, user_supplied, message_id)?;
        return Ok(args);
    };
    if unresolved_declared(declared) {
        return Err(Error::new("clarification_required"));
    }
    // 继承只能复制已有采纳身份，不能把旧记录缺失的来源补成当前用户已采纳。
    if declared["basis"] == "explicit_user"
        && declared["adoption_message_id"]
            .as_str()
            .is_none_or(|id| id.trim().is_empty())
    {
        return Err(Error::new("invalid_evidence"));
    }
    match args {
        None => Ok(Some(declared.clone())),
        Some(args) if args == *declared => Ok(Some(args)),
        Some(_) => Err(Error::new("invalid_input")),
    }
}

/// 新格式只继承目标条件版本；兼容携带也不能为草稿另作一份决定。
pub(super) fn draft_for_condition(
    args: Option<&Value>,
    revision: Option<&analysis::ConditionRevision>,
    user_message: &str,
    user_supplied: bool,
    message_id: &str,
) -> Result<Option<Value>> {
    let declared = revision.and_then(|revision| revision.body.get("semantic_resolution"));
    if revision
        .is_none_or(|revision| revision.decision_state == analysis::DecisionStateVersion::Legacy)
    {
        return draft_resolution(args, declared, user_message, user_supplied, message_id);
    }
    let supplied = args
        .filter(|value| !value.is_null())
        .map(analysis::normalized_adoption)
        .transpose()?;
    let Some(declared) = declared.filter(|value| value.is_object()) else {
        return if supplied.is_some() {
            Err(Error::new("invalid_input"))
        } else {
            Ok(None)
        };
    };
    if declared["basis"] == "explicit_user" && declared["adoption_message_id"].as_str().is_none() {
        return Err(Error::new("invalid_evidence"));
    }
    if let Some(mut supplied) = supplied {
        // 这里只能复制目标版本已有身份，省略不表示本轮又采纳一次。
        if supplied["basis"] == "explicit_user" && supplied["adoption_message_id"].is_null() {
            supplied["adoption_message_id"] = declared["adoption_message_id"].clone();
        }
        if supplied != *declared {
            return Err(Error::new("invalid_input"));
        }
    }
    Ok(Some(declared.clone()))
}

/// 旧未决的早退从未验证采纳；用真实原消息单独核采纳部分，不用resolved状态代替。
pub(super) fn verified_legacy_adoption(
    resolution: Option<&Value>,
    user_message: &str,
    user_supplied: bool,
    message_id: &str,
) -> Option<Value> {
    let mut adopted = resolution.filter(|value| value.is_object())?.clone();
    adopted.as_object_mut()?.remove("unresolved_differences");
    validate_resolution(Some(&adopted), user_message, user_supplied, message_id).ok()?;
    if adopted["basis"] == "explicit_user" && adopted["adoption_message_id"].is_null() {
        adopted["adoption_message_id"] = json!(message_id);
    }
    analysis::normalized_adoption(&adopted).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn decision(basis: &str, quote: Option<&str>, unresolved: Vec<&str>) -> Value {
        json!({
            "interpretation":"按用户明确的单位与范围计算",
            "basis":basis,
            "user_quote":quote,
            "unresolved_differences":unresolved
        })
    }

    fn adopted(
        basis: &str,
        quote: Option<&str>,
        unresolved: Vec<&str>,
        adoption: Option<&str>,
    ) -> Value {
        let mut value = decision(basis, quote, unresolved);
        value["adoption_message_id"] = match adoption {
            Some(id) => json!(id),
            None => Value::Null,
        };
        value
    }

    #[test]
    fn inherited_adoption_without_original_message_stays_unverified() {
        for declared in [
            decision("explicit_user", Some("按语音轮次数计算"), vec![]),
            adopted("explicit_user", Some("按语音轮次数计算"), vec![], None),
        ] {
            for user_supplied in [true, false] {
                assert_eq!(
                    draft_resolution(
                        None,
                        Some(&declared),
                        "查看上次结果",
                        user_supplied,
                        "later-message"
                    )
                    .unwrap_err()
                    .code,
                    "invalid_evidence"
                );
            }
        }
    }

    #[test]
    fn existing_calls_and_unambiguous_decisions_remain_available() {
        assert!(validate_resolution(None, "给出每月金额", true, "m1").is_ok());
        assert!(
            validate_resolution(
                Some(&decision("unambiguous", None, vec![])),
                "给出每月金额",
                true,
                "m1"
            )
            .is_ok()
        );
    }

    #[test]
    fn declared_open_choices_block_even_when_another_field_claims_adoption() {
        for basis in ["explicit_user", "unambiguous", "needs_clarification"] {
            assert_eq!(
                validate_resolution(
                    Some(&decision(
                        basis,
                        Some("按交易数计算"),
                        vec!["时间按创建还是完成归属"]
                    )),
                    "按交易数计算",
                    true,
                    "m1"
                )
                .unwrap_err()
                .code,
                "clarification_required"
            );
        }
        assert_eq!(
            validate_resolution(
                Some(&decision("needs_clarification", None, vec![])),
                "给出比率",
                true,
                "m1"
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
                Some(&adopted("explicit_user", Some(message), vec![], Some("m7"))),
                message,
                true,
                "m7"
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
                validate_resolution(
                    Some(&adopted("explicit_user", quote, vec![], Some("m7"))),
                    message,
                    true,
                    "m7"
                )
                .unwrap_err()
                .code,
                "invalid_evidence"
            );
        }
    }

    #[test]
    fn adoption_message_identity_is_host_bound_to_this_turn() {
        let message = "按交易数计算。";
        // 旧消息ID或空白值不是采纳证明；省略（null）是新采纳，由持久化路径回填本轮身份。
        for adoption in [Some("m1"), Some("")] {
            assert_eq!(
                validate_resolution(
                    Some(&adopted("explicit_user", Some(message), vec![], adoption)),
                    message,
                    true,
                    "m7"
                )
                .unwrap_err()
                .code,
                "invalid_evidence"
            );
        }
        let omitted = adopted("explicit_user", Some(message), vec![], None);
        assert!(validate_resolution(Some(&omitted), message, true, "m7").is_ok());
        // 持久化前回填本轮真实身份：模型不需要知道消息ID。
        let bound = draft_resolution(Some(&omitted), None, message, true, "m7")
            .unwrap()
            .expect("bound decision");
        assert_eq!(bound["adoption_message_id"], json!("m7"));
        assert!(validate_resolution(Some(&omitted), "模型自拟原话", true, "m7").is_err());
        assert!(
            validate_resolution(
                Some(&adopted("explicit_user", Some(message), vec![], Some("m7"))),
                message,
                true,
                "m7"
            )
            .is_ok()
        );
        // 无歧义决策不携带采纳身份；携带即拒绝，防止把系统推断冒充用户采纳。
        assert!(
            validate_resolution(
                Some(&decision("unambiguous", None, vec![])),
                message,
                true,
                "m7"
            )
            .is_ok()
        );
        assert_eq!(
            validate_resolution(
                Some(&adopted("unambiguous", None, vec![], Some("m7"))),
                message,
                true,
                "m7"
            )
            .unwrap_err()
            .code,
            "invalid_input"
        );
    }

    #[test]
    fn condition_layer_records_unresolved_and_gates_adoption_identity() {
        let message = "按交易数计算。";
        // 未决状态允许如实记录到条件：阻断发生在草稿保存，不在记录本身。
        for resolution in [
            decision("needs_clarification", None, vec![]),
            adopted("explicit_user", Some(message), vec!["币种未定"], Some("m7")),
        ] {
            assert!(validate_condition_resolution(&resolution, message, true, "m7", None).is_ok());
        }
        // 本轮真实消息亲自采纳：与草稿同一绑定纪律。
        let current = adopted("explicit_user", Some(message), vec![], Some("m7"));
        assert!(validate_condition_resolution(&current, message, true, "m7", None).is_ok());
        assert_eq!(
            validate_condition_resolution(&current, "换个说法", true, "m7", None)
                .unwrap_err()
                .code,
            "invalid_evidence"
        );
        // 旧消息ID：逐字复制当前条件已验证决策成立；改写内容或凭空引用不成立。
        let prior = adopted("explicit_user", Some(message), vec![], Some("m3"));
        let mut rewritten = prior.clone();
        rewritten["interpretation"] = json!("模型自拟的另一种解释");
        assert!(validate_condition_resolution(&prior, message, true, "m7", Some(&prior)).is_ok());
        assert_eq!(
            validate_condition_resolution(&rewritten, message, true, "m7", Some(&prior))
                .unwrap_err()
                .code,
            "invalid_evidence"
        );
        assert_eq!(
            validate_condition_resolution(&prior, message, true, "m7", None)
                .unwrap_err()
                .code,
            "invalid_evidence"
        );
        // unambiguous不得携带采纳身份。
        assert_eq!(
            validate_condition_resolution(
                &adopted("unambiguous", None, vec![], Some("m7")),
                message,
                true,
                "m7",
                None
            )
            .unwrap_err()
            .code,
            "invalid_input"
        );
    }

    #[test]
    fn draft_resolution_aligns_with_the_declared_condition_version() {
        let message = "按交易数计算。";
        let adopted_now = adopted("explicit_user", Some(message), vec![], Some("m7"));
        // 条件未声明：草稿自带决策按本轮绑定纪律独立成立，省略保持null。
        assert_eq!(
            draft_resolution(None, None, message, true, "m7").unwrap(),
            None
        );
        assert_eq!(
            draft_resolution(Some(&adopted_now), None, message, true, "m7").unwrap(),
            Some(adopted_now.clone())
        );
        assert_eq!(
            draft_resolution(Some(&adopted_now), None, message, true, "m8")
                .unwrap_err()
                .code,
            "invalid_evidence"
        );
        // 条件声明未决：阻断保存，省略也不能绕过（不能用省略变unambiguous）。
        let unresolved = decision("needs_clarification", None, vec!["归属时间未定"]);
        assert_eq!(
            draft_resolution(None, Some(&unresolved), message, true, "m7")
                .unwrap_err()
                .code,
            "clarification_required"
        );
        // 条件声明已决：省略继承该决策（含原采纳身份）；携带必须与之一致。
        let declared = adopted("explicit_user", Some(message), vec![], Some("m3"));
        assert_eq!(
            draft_resolution(None, Some(&declared), message, true, "m7").unwrap(),
            Some(declared.clone())
        );
        assert_eq!(
            draft_resolution(Some(&declared), Some(&declared), message, true, "m7").unwrap(),
            Some(declared.clone())
        );
        assert_eq!(
            draft_resolution(Some(&adopted_now), Some(&declared), message, true, "m7")
                .unwrap_err()
                .code,
            "invalid_input"
        );
        // 条件已由宿主回填本轮身份：草稿携带同一决策但省略身份（null）时先绑定再
        // 比较，必须成立而不是误判成与声明不一致。
        let mut omitted = adopted_now.clone();
        omitted["adoption_message_id"] = Value::Null;
        assert_eq!(
            draft_resolution(Some(&omitted), Some(&adopted_now), message, true, "m7").unwrap(),
            Some(adopted_now.clone())
        );
    }

    #[test]
    fn creating_a_task_is_not_a_user_adoption_basis() {
        assert_eq!(
            validate_resolution(
                Some(&decision("established_context", None, vec![])),
                "给出比率",
                true,
                "m1"
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
                    Some(&adopted(
                        "explicit_user",
                        Some("按订单数计算"),
                        vec![],
                        Some("m3")
                    )),
                    message,
                    true,
                    "m3"
                )
                .unwrap_err()
                .code,
                "invalid_evidence"
            );
        }
        let system_message = "查询结果已到达，请解释。";
        assert_eq!(
            validate_resolution(
                Some(&adopted(
                    "explicit_user",
                    Some(system_message),
                    vec![],
                    Some("m3")
                )),
                system_message,
                false,
                "m3"
            )
            .unwrap_err()
            .code,
            "invalid_evidence"
        );
    }
}
