// 模型容量推导（实现设计17.7）：C=总窗口，I=输入策略，O=输出策略。
// B=min(I,C-O)，H按B缩放；Pi原生触发线T=B-H由注册的contextWindow与reserveTokens相减得出。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapacityPlan {
    pub history_reserve: u64,   // R=C-B+H，Pi reserveTokens
    pub tool_reserve: u64,      // H，工具/临时资料/估算误差预留
    pub keep_recent: u64,       // K=min(65536,T/4)
    pub trigger: u64,           // T=B-H，原生压缩触发线
    pub summary_cap: u64,       // S1=O：1.4单次历史摘要的冻结输出上界
    pub split_summary_cap: u64, // S2=O：不包含沿用的旧摘要/文件附记
}

fn derive(
    context_window: u64,
    input_limit: u64,
    output_limit: u64,
) -> Result<CapacityPlan, &'static str> {
    if context_window < 1024 || input_limit < 1024 || output_limit == 0 || input_limit > 2_000_000 {
        return Err("invalid_field");
    }
    let body = input_limit.min(context_window.saturating_sub(output_limit));
    let scaled = context_window.div_ceil(50).clamp(16384, 65536); // ceil(0.02C)
    let tool_reserve = scaled.min((body / 8).max(1024));
    if body <= 2 * tool_reserve {
        return Err("reserve_exceeds_history");
    }
    let history_reserve = context_window - body + tool_reserve;
    let trigger = body - tool_reserve;
    let keep_recent = (trigger / 4).min(65536);
    // 两次新摘要的配置空间；旧摘要复用、附记与完整保留组由Node运行边界另核。
    let summary_cap = output_limit;
    let split_summary_cap = output_limit;
    if summary_cap + split_summary_cap + keep_recent >= trigger {
        return Err("summary_space_insufficient");
    }
    Ok(CapacityPlan {
        history_reserve,
        tool_reserve,
        keep_recent,
        trigger,
        summary_cap,
        split_summary_cap,
    })
}

// 保存与运行共用同一推导；失败原因对应UI字段说明，不重复实现公式。
pub fn plan(
    context_window: u64,
    input_limit: u64,
    output_limit: u64,
) -> Result<CapacityPlan, &'static str> {
    derive(context_window, input_limit, output_limit)
}

// 固定另外两个字段；实际SDK开销仅在Node派发边界核验。
pub fn ranges(context: u64, input: u64, output: u64) -> [Option<[u64; 2]>; 2] {
    let feasible = |i, o| o <= i && plan(context, i, o).is_ok();
    let input_max = context.saturating_sub(output).min(2_000_000);
    let input_range = if feasible(input_max, output) {
        let (mut low, mut high) = (1024.max(output), input_max);
        while low < high {
            let mid = (low + high) / 2;
            if feasible(mid, output) {
                high = mid;
            } else {
                low = mid + 1;
            }
        }
        Some([low, input_max])
    } else {
        None
    };
    let output_range = if feasible(input, 1) {
        let (mut low, mut high) = (1, 393216.min(input).min(context.saturating_sub(1)));
        while low < high {
            let mid = (low + high).div_ceil(2);
            if feasible(input, mid) {
                low = mid;
            } else {
                high = mid - 1;
            }
        }
        Some([1, low])
    } else {
        None
    };
    [input_range, output_range]
}

pub fn range_message(context: u64, input: u64, output: u64) -> String {
    let [input_range, output_range] = ranges(context, input, output);
    let describe = |range: Option<[u64; 2]>| match range {
        Some([low, high]) => format!("{low}–{high} tokens"),
        None => "无可行值".to_owned(),
    };
    format!(
        "总上下文保持 {context} tokens：保留当前输出时，可用输入范围 {}；保留当前输入时，输出范围 {}。范围仅校验容量，端点和思考档位另行校验。",
        describe(input_range),
        describe(output_range)
    )
}

#[cfg(test)]
mod shared_vectors {
    use super::*;
    use serde_json::{Value, json};

    #[test]
    fn capacity_plans_and_feasible_ranges_match_shared_contract_examples() {
        let vectors: Vec<Value> = serde_json::from_str(include_str!(
            "../../../../../../tests/contracts/capacity-vectors.json"
        ))
        .unwrap();
        for v in vectors {
            let (c, i, o) = (
                v["context"].as_u64().unwrap(),
                v["input"].as_u64().unwrap(),
                v["output"].as_u64().unwrap(),
            );
            let actual = match plan(c, i, o) {
                Ok(p) => json!([
                    p.history_reserve,
                    p.tool_reserve,
                    p.keep_recent,
                    p.trigger,
                    p.summary_cap,
                    p.split_summary_cap
                ]),
                Err(reason) => json!(reason),
            };
            assert_eq!(&actual, v.get("failure").unwrap_or(&v["plan"]));
            if let Some(expected) = v.get("ranges") {
                let [input, output] = ranges(c, i, o);
                assert_eq!(json!({"input":input,"output":output}), *expected);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deepseek_window_initial_values_match_the_contract() {
        // 已核对初值C=1000000、I=900000、O=65536（实现设计17.7）。
        let plan = plan(1_000_000, 900_000, 65_536).expect("feasible");
        assert_eq!(plan.history_reserve, 120_000);
        assert_eq!(plan.trigger, 880_000);
        assert_eq!(plan.keep_recent, 65_536);
        assert_eq!(plan.tool_reserve, 20_000);
        assert_eq!(plan.summary_cap, 65_536);
        assert_eq!(plan.split_summary_cap, 65_536);
    }

    #[test]
    fn long_output_variant_matches_the_contract() {
        let plan = plan(1_000_000, 900_000, 131_072).expect("feasible");
        assert_eq!(plan.trigger, 848_928);
        assert_eq!(plan.history_reserve, 151_072);
        assert_eq!(plan.keep_recent, 65_536);
    }

    #[test]
    fn equal_input_output_window_is_rejected_for_summary_space() {
        // 反例C=131072、I=O=65536：触发线内放不下两段摘要加近期保留。
        assert_eq!(
            plan(131_072, 65_536, 65_536),
            Err("summary_space_insufficient")
        );
    }

    #[test]
    fn tiny_body_rejects_before_summary_check() {
        // O吞掉几乎全部窗口时，预留比例超过正文一半，直接拒绝。
        assert_eq!(plan(65_536, 65_536, 65_536), Err("reserve_exceeds_history"));
    }
}
