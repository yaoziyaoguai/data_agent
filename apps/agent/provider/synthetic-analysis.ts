// 合成模型的固定演示策略，仅用于可重复的本地协议/产品验证；真实provider由Pi自主规划。
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { isRecoveryNotice } from "../session/checkpoint.ts";
import type {
  Conditions,
  RunEnvelope,
} from "../../../packages/contracts/generated/boundary.ts";
type RecordValue = Record<string, any>;
export type SyntheticAction =
  { tool: string; args: RecordValue } | { text: string };
export function syntheticAction(
  run: RunEnvelope,
  context: TranscriptContext,
): SyntheticAction {
  const messages = context.messages.filter(message => !isRecoveryNotice(message));
  const lastUser = messages.findLastIndex((v) => v.role === "user");
  const user = messages[lastUser];
  const input =
    typeof user?.content === "string"
      ? user.content
      : (user?.content?.find((v) => v.type === "text")?.text ?? run.text);
  const tools = messages
    .slice(lastUser + 1)
    .filter((m) => m.role === "toolResult")
    .map((m) => {
      const text = m.content.find((v) => v.type === "text");
      return {
        name: m.toolName,
        data:
          text?.type === "text"
            ? (() => {
                try {
                  return JSON.parse(text.text);
                } catch {
                  return { error: text.text };
                }
              })()
            : {},
      };
    });
  const has = (name: string) => tools.find((t) => t.name === name);
  const latest = (name: string) => tools.findLast((t) => t.name === name)?.data;
  const workspace = run.workspace_context!;
  const tasks = workspace.tasks as RecordValue[];
  const targetId = input.match(/\[task:([^\]]+)\]/)?.[1];
  let previous = targetId
    ? tasks.find((t) => t.id === targetId)
    : tasks.findLast(
        (t) => t.phase === "waiting_clarification" && t.lifecycle === "active",
      );
  const revision =
    !!previous ||
    /(改成|改为|仅看|只看|按渠道|按地区|时间改|刚才|继续|按订单|按金额|全部渠道)/.test(
      input,
    );
  if (!previous && revision)
    previous = tasks.findLast((t) => t.lifecycle === "active");
  const empty: Conditions = {
    time_start: null,
    time_end: null,
    timezone: "UTC",
    metric: null,
    channel: null,
    group_by: [],
    filters: ["is_test = 0", "paid_amount_cents > 0"],
    knowledge_refs: [],
    notes: "",
  };
  if (previous && !previous.conditions && !has("read_analysis_task")) return { tool:"read_analysis_task", args:{task_id:previous.id} };
  const old = latest("read_analysis_task")?.conditions ?? previous?.conditions;
  const conditions: Conditions = { ...empty, ...(old ?? {}) };
  const update = (
    action: string,
    question: string | null = null,
    options: string[] = [],
  ): SyntheticAction => ({
    tool: "update_analysis_task",
    args: {
      action,
      task_id: previous?.id ?? null,
      expected_version: previous?.condition_version ?? null,
      goal: previous?.goal ?? input,
      ...(action !== "route" ? { conditions } : {}),
      ...(previous && action !== "route" ? { condition_patch: {
        set: Object.fromEntries(Object.entries(conditions).filter(([key, value]) => value !== null && JSON.stringify(value) !== JSON.stringify(old?.[key]))),
        unset: Object.entries(conditions).filter(([key, value]) => value === null && old?.[key] != null).map(([key]) => key),
      }} : {}),
      question,
      options,
    },
  });
  const route = (): SyntheticAction => update("route");
  if (input.startsWith("[已确认查询结果事件]")) {
    const qid = input.match(/query_id=([^，\s]+)/)?.[1];
    if (!has("get_query"))
      return { tool: "get_query", args: { query_id: qid } };
    if (!has("update_analysis_task")) return route();
    const result = latest("get_query");
    if (result.results?.error)
      return {
        text: `查询结果目前不可读取：${result.results.error}。保留原查询记录，如需重新查询请生成新SQL并确认。`,
      };
    const r = result.results;
    if (!r)
      return {
        text: `查询状态为 ${result.query.execution_state}，尚无可解释的结果。`,
      };
    return {
      text: `原任务 ${result.query.task_id}（条件版本 ${result.query.condition_version}）的查询已完成。${r.columns.map((c: RecordValue) => c.name).join("、")}：${r.rows.map((row: unknown[]) => row.map((v) => v ?? "NULL").join(" / ")).join("；") || "无符合条件的行"}。来源为可执行合成数据；${r.result_complete ? "本页已取完整查询结果" : "当前为部分结果，不能代表全量"}。金额字段单位为分，退款归属以本次SQL和业务口径为准。分组差异不能直接证明原因。`,
    };
  }
  if (
    /(你好|谢谢|早上好|hi\b)/i.test(input) &&
    !/(查|收入|客户|分析)/.test(input)
  ) {
    if (!has("update_analysis_task")) return route();
    return { text: "可以继续在这个对话提问、修改已有任务，或开始新的分析。" };
  }
  if (!has("search_knowledge"))
    return {
      tool: "search_knowledge",
      args: {
        query:
          revision && conditions.metric
            ? ({
                net_revenue: "支付归属净收入 paid_at",
                paying_customers: "月支付客户数 customer_id",
              }[conditions.metric] ?? "退款率 退款")
            : /退款/.test(input)
              ? "退款率 退款"
              : /客户|UV|uv/.test(input)
                ? "月支付客户数 customer_id"
                : /件数/.test(input)
                  ? "quantity 退货件数"
                  : /地区/.test(input)
                    ? "region 地区"
                    : /月底|收入|净收/.test(input)
                      ? "支付归属净收入 paid_at"
                      : input,
        limit: 20,
      },
    };
  const knowledge = latest("search_knowledge");
  const objects: RecordValue[] = knowledge.objects ?? [];
  if (/净售出|净件数/.test(input)) {
    if (!has("update_analysis_task")) return route();
    return {
      text: "现有资料只有下单件数 quantity，没有退货件数，无法计算净售出件数。不能从退款金额推算数量；可以改查下单件数，或补充退货数量资料。依据：业务说明第4节。",
    };
  }
  if (/paid_amount_cents/.test(input) && /零|为0|为 0/.test(input)) {
    if (!has("read_source")) return {tool:"read_source",args:{source_id:"etl",version:"1"}};
    if (!has("update_analysis_task")) return route();
    return {text:"paid_amount_cents由成功charge事件按订单行汇总，LEFT JOIN没有匹配付款时使用COALESCE(p.paid, 0)。因此0可能表示没有成功付款记录，不能据此断言是零元成交；需要进一步查看成功付款事件和原订单。依据：etl v1的line_payments与COALESCE，以及业务说明3.1、4节。"};
  }
  if (/月底|含义|什么意思|解释|为什么|表结构/.test(input) && !revision) {
    if (!has("read_source"))
      return {
        tool: "read_source",
        args: { source_id: "business-guide", version: "1" },
      };
    if (!has("update_analysis_task")) return route();
    return {
      text: /月底/.test(input)
        ? "收入默认按 paid_at（当前行首笔成功付款时刻）归属，order_date 是下单日期。月底下单而次月支付的订单可能不属于1月支付收入；这里没有提供订单号和明细，不能断言某笔订单的支付时间或原因。依据：业务说明3.1、3.2、5.1。"
        : `已找到相关定义：${objects
            .slice(0, 3)
            .map(
              (o) =>
                o.name +
                "：" +
                o.entries.map((e: RecordValue) => e.effective_value).join("\n"),
            )
            .join("\n\n")}。可在语义管理查看相应版本与来源。`,
    };
  }
  const memoryRequest =
    !/(仅本次|仅这次|不要记住|不要保存)/.test(input) && /(以后|记住|默认)/.test(input) && /(web|app|store)/.test(input);
  const forgetMemory = /忘掉|忘记|停用.*记忆/.test(input);
  if ((memoryRequest || forgetMemory) && !has("manage_personal_asset")) {
    const active = [...(knowledge.personal_memories ?? []), ...workspace.memories].find((m:RecordValue) => /默认渠道=/.test(m.body));
    if (forgetMemory && !memoryRequest && active) return {tool:"manage_personal_asset", args:{action:"disable_memory",asset_id:active.id,expected_version:active.version}};
    if (memoryRequest) {
      const channel = input.match(/(?:改成|改为|只看|默认|看)\s*(web|app|store)/)?.[1] ?? "web";
      return {tool:"manage_personal_asset",args:{action:active ? "update_memory":"save_memory",...(active ? {asset_id:active.id,expected_version:active.version}:{}),instruction_quote:input,name:"默认分析渠道",body:`默认渠道=${channel}`,scope:"未指定渠道的订单分析；本次明确条件优先",verified:false,dependencies:[]}};
    }
  }
  if (/支付客户|客户数|UV|uv/.test(input))
    conditions.metric = "paying_customers";
  else if (/退款/.test(input) || conditions.metric?.includes("refund"))
    conditions.metric = /按金额|金额退款/.test(input)
      ? "refund_amount_rate"
      : /按客户|客户退款/.test(input)
        ? "refund_customer_rate"
        : /按订单|订单退款/.test(input)
          ? "refund_rate"
          : (conditions.metric ?? "refund_ambiguous");
  else if (/收入|净收/.test(input)) conditions.metric = "net_revenue";
  const month = input.match(/(?:(202\d)\s*年\s*)?(\d{1,2})\s*月/);
  if (month) {
    const year = month[1] ?? "2026";
    const m = Number(month[2]);
    if (m >= 1 && m <= 12) {
      conditions.time_start = `${year}-${String(m).padStart(2, "0")}-01T00:00:00Z`;
      conditions.time_end = `${m === 12 ? Number(year) + 1 : year}-${String(m === 12 ? 1 : m + 1).padStart(2, "0")}-01T00:00:00Z`;
    }
  }
  const explicitChannel = input.match(
    /(?:只看|仅看|渠道(?:改成|为|是)?|看)\s*(web|app|store)/,
  )?.[1];
  if (/全部渠道|所有渠道/.test(input)) conditions.channel = null;
  else if (explicitChannel)
    conditions.channel = explicitChannel as Conditions["channel"];
  else if (!previous) {
    const memories = [
      ...(knowledge.personal_memories ?? []),
      ...workspace.memories,
    ].filter((memory, index, items) =>
      items.findIndex((item) => item.id === memory.id) === index,
    );
    const saved = latest("manage_personal_asset");
    const value = saved?.state === "enabled" ? saved : memories.find((m: RecordValue) => /默认渠道=/.test(m.body));
    const channel = value?.body.match(/默认渠道=(web|app|store)/)?.[1];
    if (channel) {
      conditions.channel = channel;
      conditions.notes = "采用本人默认渠道偏好；当前明确要求优先。";
    }
  }
  if (/标签/.test(input) && /vip|newsletter/.test(input)) {
    const tagFilter="EXISTS (SELECT 1 FROM customer_tags t WHERE t.customer_id=demo_order_detail.customer_id AND t.tag IN ('vip','newsletter'))";
    if(!conditions.filters.includes(tagFilter)) conditions.filters.push(tagFilter);
  }
  if (/按渠道/.test(input)) conditions.group_by = ["channel"];
  if (/按地区/.test(input)) conditions.group_by = ["region"];
  if (/按天|趋势/.test(input)) conditions.group_by = ["date(paid_at)"];
  const metric = objects.find((o) => o.id === "metric-" + conditions.metric);
  const table = objects.find((o) => o.id === "table-demo_order_detail");
  conditions.knowledge_refs = [metric, table]
    .filter(Boolean)
    .map((o) => ({ object_id: o!.id, version: o!.version, path: "" }));
  if (!has("update_analysis_task")) {
    if (/购买时.*地区/.test(input))
      return update(
        "clarify",
        "现有客户维表只有当前地区，没有购买时的地区历史。是否改用当前快照地区分析？",
        ["用当前地区", "补充历史地区资料"],
      );
    if (conditions.metric === "refund_ambiguous")
      return update("clarify", "退款率希望按什么分母计算？", [
        "订单退款率",
        "退款金额占支付金额",
        "退款客户占支付客户",
      ]);
    if (!conditions.time_start || !conditions.time_end)
      return update(
        "clarify",
        "希望统计哪个时间范围？样例包含2026年1月，可填写具体起止日期。",
        ["2026年1月", "补充其他日期"],
      );
    if (!conditions.metric) return route();
    return update(previous ? "revise" : "create");
  }
  const task = latest("update_analysis_task");
  if (task.question)
    return { text: task.question + "\n" + task.options.join(" / ") };
  if (!task.task_id && latest("manage_personal_asset")?.id) return {text: latest("manage_personal_asset").state === "disabled" ? "已停用这条默认渠道记忆，后续分析不再采用。" : "已保存你的个人默认渠道偏好，本次明确条件仍优先。"};
  if (!task.task_id)
    return {
      text: "本地模拟模型仅支持合成零售的净收入、支付客户数、退款率及字段解释。可换用已配置真实模型处理更广的问题；工具和用户确认规则保持一致。",
    };
  if (!has("request_query")) {
    let expression = metric?.entries
      .find((e: RecordValue) => e.path === "sql")
      ?.effective_value?.match(/SELECT ([\s\S]*?)\nFROM/)?.[1];
    if (conditions.metric === "refund_amount_rate")
      expression =
        "SUM(refunded_amount_cents) * 1.0 / NULLIF(SUM(paid_amount_cents), 0) AS refund_amount_rate";
    if (conditions.metric === "refund_customer_rate")
      expression =
        "COUNT(DISTINCT CASE WHEN refunded_amount_cents > 0 THEN customer_id END) * 1.0 / NULLIF(COUNT(DISTINCT customer_id), 0) AS refund_customer_rate";
    if (!expression)
      return {
        text: "当前检索没有可用指标SQL，保留调查缺口。请补充指标定义或检查语义是否启用。",
      };
    const group = conditions.group_by;
    const aliases = group.map((g, i) => `${g} AS dimension_${i}`);
    let sql = `SELECT ${[...aliases, expression].join(", ")}\nFROM demo_order_detail\nWHERE ${conditions.filters.join(" AND ")}\n AND paid_at >= :start AND paid_at < :end`;
    const parameters: RecordValue = {
      start: conditions.time_start,
      end: conditions.time_end,
    };
    if (conditions.channel) {
      sql += "\n AND channel = :channel";
      parameters.channel = conditions.channel;
    }
    if (group.length)
      sql += `\nGROUP BY ${group.join(", ")}\nORDER BY ${group.join(", ")}`;
    return {
      tool: "request_query",
      args: {
        task_id: task.task_id,
        condition_version: task.condition_version,
        sql,
        parameters,
        target_id: "synthetic-sqlite",
        replaces_query_id: null,
        summary: `${conditions.time_start} 至 ${conditions.time_end}，UTC，截止不含。${conditions.channel ? "渠道 " + conditions.channel : "全部渠道"}；排除测试、只统计成功付款行。${conditions.notes} 指标：${conditions.metric}。`,
        knowledge_refs: conditions.knowledge_refs,
      },
    };
  }
  const query = latest("request_query");
  return {
      text: `SQL已保存，草稿版本 ${query.draft_version}，${query.check_state === "passed" ? "只读检查通过，请查看后点击“执行查询”。" : "检查未通过，请补充或修改。"}执行前可继续修改任何业务条件。${latest("manage_personal_asset")?.id ? "已保存你的个人默认渠道偏好，本次明确条件仍优先。" : latest("manage_personal_asset")?.error ? "长期偏好未保存成功，本次仍采用明确条件。" : ""}`,
  };
}
