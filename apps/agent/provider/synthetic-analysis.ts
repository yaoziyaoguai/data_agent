// 合成模型的固定演示策略，仅用于可重复的本地协议/产品验证；真实provider由Pi自主规划。
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { isRecoveryNotice } from "../session/checkpoint.ts";
import { cockpitAction } from "./synthetic-cockpit.ts";
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
  if (process.env.DATA_AGENT_DEMO_PROFILE === "cockpit_voice" && !run.text.startsWith("[已确认查询结果事件]"))
    return cockpitAction(run, context);
  const messages = context.messages.filter(message => !isRecoveryNotice(message));
  // 宿主参考会被Pi投影为user；合成模型按真实输入定位工具组，不能把参考当新问题。
  // v2首窗（来源未裁决）的宿主投影内必须照常route；只有范围重置后的投影窗口
  // （已有控制记录、pending刷新未应用）不能继续发工具调用：turn必须自然结束，
  // turn_end应用投影刷新后继续，否则工具循环令turn永不结束、耗尽预算。
  // 两个前缀与session/task-projection.ts的投影字面量保持一致。
  const textOf = (message: (typeof messages)[number]) =>
    typeof message.content === "string" ? message.content : message.content
      .filter(part => part.type === "text").map(part => part.text).join("");
  const projected = messages.filter(message => message.role === "user");
  if (run.tool_contract_version === 2
    && projected.some(message => textOf(message).startsWith("当前宿主事实："))
    && projected.some(message => textOf(message).startsWith('{"sdk_tool_call_id"')))
    return { text: "任务或资料范围已更新，本条输入按更新后的范围处理。" };
  const input = run.text;
  const lastUser = messages.findLastIndex((message) => message.role === "user" &&
    (typeof message.content === "string" ? message.content : message.content
      .filter(part => part.type === "text").map(part => part.text).join("")) === input);
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
    }).filter(tool => tool.data.error !== 'tool_response_capacity');
  const has = (name: string) => tools.find((t) => t.name === name);
  const latest = (name: string) => tools.findLast((t) => t.name === name)?.data;
  const workspace = run.workspace_context!;
  const tasks = workspace.tasks as RecordValue[];
  // 只为确定性界面验收识别几句固定样例；真实意图仍由 Pi 中的模型判断。
  const executeOnly = /^执行(?:上面这|上面那|这|刚才这|刚才那)(?:一)?(?:条|份)(?:SQL|查询)?[。！!]?$/i.test(input)
    || /^\[task:[^\]]+\] 请执行刚才的SQL，时间及其他条件保持不变；完成后直接解释这次查询的原始结果。$/.test(input);
  const executeAfterRevision = /(?:再|然后)执行/.test(input) && !/(不要|别|不必)执行/.test(input);
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
  if (executeOnly) {
    const query = workspace.query_observations.find(q => q.execution_state === "not_submitted");
    previous = tasks.find(t => t.id === query?.task_id) ?? previous;
  }
  if (input.startsWith("[已确认查询结果事件]")) {
    const qid = input.match(/query_id=([^，\s]+)/)?.[1];
    const query = workspace.query_observations.find(q => q.id === qid);
    previous = tasks.find(t => t.id === query?.task_id) ?? tasks.findLast(t => t.lifecycle === "active") ?? previous;
  }
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
    // v2任务条件必须显式声明范围；缺字段的任务范围未知，证据工具在归属门后全部被拒。
    ...(run.tool_contract_version === 2 ? { source_limits: null } : {}),
  };
  if (previous && !previous.conditions && !has("read_analysis_task")) return { tool:"read_analysis_task", args:{task_id:previous.id} };
  const old = latest("read_analysis_task")?.conditions ?? previous?.conditions;
  const conditions: Conditions = { ...empty, ...(old ?? {}) };
  const openClarifications: RecordValue[] = latest("read_analysis_task")?.open_clarifications
    ?? (previous?.clarification ? [previous.clarification] : []);
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
      // 模拟策略只解决已明确选定分母的原问题，普通条件修订不能关闭其他澄清。
      ...(action === "revise" && old?.metric === "refund_ambiguous"
        && ["refund_rate", "refund_amount_rate", "refund_customer_rate"].includes(conditions.metric ?? "")
        ? { resolved_clarification_ids: openClarifications
            .filter(item => item.question === "退款率希望按什么分母计算？" && typeof item.id === "string")
            .map(item => item.id) }
        : {}),
      question,
      options,
    },
  });
  const route = (): SyntheticAction => update("route");
  // v2证据工具在归属裁决前会被拒：本条输入先route登记，再检索/执行/解释。
  if (run.tool_contract_version === 2 && !has("update_analysis_task")) return route();
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
    if (run.tool_contract_version !== 2 && has("present_analysis_answer")) return {text: "结果已按实际来源交付。"};
    const columns = r.columns.slice(0, 10) as RecordValue[];
    const values: RecordValue[] = [];
    const rows = (r.rows as unknown[][]).slice(0, 5).map((_row, rowIndex) =>
      columns.map((column, columnIndex) => {
        const index = rowIndex * columns.length + columnIndex;
        const name = "cell_" + String.fromCharCode(97 + Math.floor(index / 26)) + String.fromCharCode(97 + index % 26);
        values.push({name, kind: "cell", query_id: qid, column: column.name, row_index: rowIndex});
        return "{{" + name + "}}";
      }).join(" / "));
    const template = "查询已完成。以下为实际结果预览，字段顺序及单位见查询卡片：\n\n" +
      (rows.map(row => "- " + row).join("\n") || "没有符合条件的行。") +
      "\n\n这里只展示部分预览；完整范围和下载以查询卡片为准。当前是固定合成演示，不代表真实模型的自主分析能力。";
    if (run.tool_contract_version === 2) {
      // v2两步：先prepare取得已核bindings，下一条正文以{{name}}引用，由宿主流式渲染交付。
      if (has("prepare_analysis_answer")) return {text: template};
      return {tool: "prepare_analysis_answer", args: {
        sources: [{query_id: qid, result_ref: r.result_ref, columns: columns.map(column => column.name)}], values,
      }};
    }
    return {tool: "present_analysis_answer", args: {
      sources: [{query_id: qid, result_ref: r.result_ref, columns: columns.map(column => column.name)}], values,
      template,
    }};
  }
  if (
    /(你好|谢谢|早上好|hi\b)/i.test(input) &&
    !/(查|收入|客户|分析)/.test(input)
  ) {
    if (!has("update_analysis_task")) return route();
    return { text: "可以继续在这个对话提问、修改已有任务，或开始新的分析。" };
  }
  if (executeOnly) {
    if (!has("update_analysis_task")) return route();
    const observation = workspace.query_observations.find(q => q.task_id === previous?.id);
    if (!observation) return {text: "请说明要执行哪份 SQL。"};
    if (!has("get_query")) return {tool: "get_query", args: {query_id: observation.id}};
    const query = latest("get_query").query;
    if (!has("execute_query")) return {tool: "execute_query", args: {query_id: query.id, draft_version: query.draft_version, condition_version: query.condition_version, instruction_quote: run.text}};
    return {text: latest("execute_query").error ? "这份查询暂未执行，请核对条件后再试。" : "已提交这份 SQL，结果会显示在对话中。"};
  }
  const inheritedRef = run.tool_contract_version === 2 && previous
    ? conditions.knowledge_refs.find(ref => ref.object_id === 'metric-' + conditions.metric && ref.path === 'sql')
    : undefined;
  if (inheritedRef && !has('read_knowledge')) return {tool: 'read_knowledge', args: {
    items: [{kind: 'knowledge', ref: inheritedRef, offset: 0, limit: 4096}],
  }};
  if (!inheritedRef && !has("search_knowledge"))
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
              : /月底|收入|净收/.test(input)
                ? "支付归属净收入 paid_at"
                : /客户|UV|uv/.test(input)
                  ? "月支付客户数 customer_id"
                  : /件数/.test(input)
                    ? "quantity 退货件数"
                    : /地区/.test(input)
                      ? "region 地区"
                      : input,
        limit: run.tool_contract_version === 2 ? 5 : 20,
        ...(run.tool_contract_version === 2 ? {kinds: ['metric']} : {}),
      },
    };
  const knowledge = latest("search_knowledge") ?? {};
  const objects: RecordValue[] = run.tool_contract_version === 2 ? [] : knowledge.objects ?? [];
  if (run.tool_contract_version === 2) {
    for (const receipt of tools.filter(tool => tool.name === 'search_knowledge')) {
      for (const hit of receipt.data.hits ?? []) {
        if (hit.record_kind !== 'knowledge_entry') continue;
        let object = objects.find(object => object.id === hit.ref.object_id && object.version === hit.ref.version);
        if (!object) {
          object = {id: hit.ref.object_id, version: hit.ref.version, name: hit.name, ref: hit.ref, entries: []};
          objects.push(object);
        }
        if (!object.entries.some((entry: RecordValue) => entry.path === hit.ref.path))
          object.entries.push({entry_id: hit.ref.path, path: hit.ref.path, ref: hit.ref, effective_value: hit.definition,
            content_page: {complete: hit.content_state === 'complete'}});
      }
    }
  }
  if (inheritedRef && !objects.some(object => object.id === inheritedRef.object_id)) {
    const item = latest('read_knowledge')?.items?.[0];
    objects.push({id: inheritedRef.object_id, version: inheritedRef.version, name: inheritedRef.object_id,
      entries: [{entry_id: 'sql', path: 'sql', ref: inheritedRef, effective_value: item?.state === 'ok' ? item.content : '',
        content_page: item?.state === 'ok' ? item.content_page : {complete: false}}]});
  }
  if (knowledge.error) {
    if (!has('update_analysis_task')) return route();
    return {text: '当前资料检索失败，尚未完成口径核对，没有生成或执行查询。'};
  }
  if (/净售出|净件数/.test(input)) {
    if (!has("update_analysis_task")) return route();
    return {
      text: "现有资料只有下单件数 quantity，没有退货件数，无法计算净售出件数。不能从退款金额推算数量；可以改查下单件数，或补充退货数量资料。依据：业务说明第4节。",
    };
  }
  const zeroPayment = /paid_amount_cents/.test(input) && /零|为0|为 0/.test(input);
  if (zeroPayment || (/月底|含义|什么意思|解释|为什么|表结构/.test(input) && !revision)) {
    const sourceId = zeroPayment ? 'etl' : 'business-guide';
    let unavailable = false;
    if (run.tool_contract_version === 2) {
      const hits = tools.filter(tool => tool.name === 'search_knowledge').flatMap(tool => tool.data.hits ?? []);
      const raw = hits.find((hit: RecordValue) => hit.record_kind === 'source_excerpt' && hit.citation.source.id === sourceId);
      const citation = raw?.citation ?? hits.flatMap((hit: RecordValue) => hit.citations ?? [])
        .find((citation: RecordValue) => citation.source.kind === 'platform' && citation.source.id === sourceId);
      if (!citation) {
        const entry = hits.find((hit: RecordValue) => hit.record_kind === 'knowledge_entry'
          && hit.kind === 'document' && hit.ref.path === 'body');
        if (!entry && tools.filter(tool => tool.name === 'search_knowledge').length === 1)
          return {tool: 'search_knowledge', args: {query: zeroPayment ? '上游与加工 没有成功付款' : '收入 paid_at 下单日期', kinds: ['document'], limit: 5}};
        let offset = 0;
        let total: number | undefined;
        unavailable = !entry;
        for (const receipt of tools.filter(tool => tool.name === 'read_knowledge')) {
          const item = receipt.data.items?.[0];
          if (receipt.data.error || item?.kind !== 'knowledge' || item.state !== 'ok'
            || item.ref.object_id !== entry?.ref.object_id || item.ref.version !== entry?.ref.version || item.ref.path !== entry?.ref.path
            || item.content_page.offset !== offset || (total !== undefined && total !== item.content_page.total_chars)) {
            unavailable = true; break;
          }
          total = item.content_page.total_chars;
          offset += [...item.content].length;
          if (item.content_page.next_offset !== (offset === total ? null : offset)) {unavailable = true; break;}
        }
        if (!unavailable && (total === undefined || offset < total)) return {tool: 'read_knowledge', args: {
          items: [{kind: 'knowledge', ref: entry.ref, offset, limit: 8000}],
        }};
      } else {
        const read = latest('read_source');
        unavailable = Boolean(read?.error) || Boolean(read && (read.source?.id !== citation.source.id || read.revision !== citation.revision));
        if (!unavailable && (!read || read.next_locator)) return {tool: 'read_source', args: {
          citation: {...citation, locator: read?.next_locator ?? (raw ? {offset: 0, length: raw.source_length} : citation.locator)}, limit: 8000,
        }};
      }
    } else {
      if (!has('read_source')) return {tool: 'read_source', args: {source_id: sourceId, version: '1'}};
      unavailable = Boolean(latest('read_source')?.error);
    }
    if (!has('update_analysis_task')) return route();
    if (unavailable) return {text: '原文资料不可读取，尚未完成口径核对，没有生成或执行查询。'};
    return {
      text: zeroPayment
        ? run.tool_contract_version === 2
          ? 'paid_amount_cents是当前订单行的成功付款累计金额。成功付款记录缺失时，金额按现有加工约定填为0、paid_at为NULL；因此0可能表示没有成功付款记录，不能据此断言是零元成交，仍需核对成功付款事件和原订单。依据：已读取的加工或业务说明，当前为固定合成演示。'
          : 'paid_amount_cents由成功charge事件按订单行汇总，LEFT JOIN没有匹配付款时使用COALESCE(p.paid, 0)。因此0可能表示没有成功付款记录，不能据此断言是零元成交；需要进一步查看成功付款事件和原订单。依据：etl v1的line_payments与COALESCE，以及业务说明3.1、4节。'
        : /月底/.test(input)
          ? '收入默认按 paid_at（当前行首笔成功付款时刻）归属，order_date 是下单日期。月底下单而次月支付的订单可能不属于1月支付收入；这里没有提供订单号和明细，不能断言某笔订单的支付时间或原因。依据：业务说明3.1、3.2、5.1。'
          : `已找到相关定义：${objects.slice(0, 3).map(o => o.name + '：' + o.entries.map((e: RecordValue) => e.effective_value).join('\n')).join('\n\n')}。可在语义管理查看相应版本与来源。`,
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
    .map((o) => run.tool_contract_version === 2
      ? o!.entries.find((entry: RecordValue) => entry.path === 'sql')?.ref ?? o!.ref
      : {object_id: o!.id, version: o!.version, path: ''});
  // route回执只登记归属不带条件；create/revise/clarify回执才携带task_id+conditions。
  const taskRegistration = tools.find(tool => tool.name === "update_analysis_task"
    && tool.data.task_id && tool.data.conditions !== undefined);
  if (!taskRegistration) {
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
    const previewSql = metric?.entries.find((entry: RecordValue) => entry.path === "sql");
    let metricSql = previewSql?.effective_value;
    const sqlReads = tools.filter(tool => tool.name === "read_knowledge");
    // 搜索只保证命中片段；固定演示也必须同版补读完整SQL，不能把省略当成没有定义。
    if (metric && (sqlReads.length || !previewSql || previewSql.content_page?.complete === false)) {
      let offset = 0;
      let total: number | undefined;
      metricSql = "";
      for (const read of sqlReads) {
        const item = run.tool_contract_version === 2 ? read.data.items?.[0] : undefined;
        const entry = run.tool_contract_version === 2
          ? item?.kind === 'knowledge' && item.state === 'ok' && item.ref.path === 'sql'
            ? {effective_value: item.content, content_page: item.content_page} : undefined
          : read.data.entries?.find((item: RecordValue) => item.path === "sql");
        const page = entry?.content_page;
        if ((run.tool_contract_version === 2 ? item?.ref?.object_id : read.data.id) !== metric.id
          || (run.tool_contract_version === 2 ? item?.ref?.version : read.data.version) !== metric.version
          || typeof entry?.effective_value !== "string" || page?.offset !== offset
          || (total !== undefined && page.total_chars !== total)) {
          return {text: "指标SQL补读未能取得同一版本的完整正文，保留调查缺口，没有生成查询。"};
        }
        total = page.total_chars;
        metricSql += entry.effective_value;
        offset += [...entry.effective_value].length;
        if (page.next_offset !== (offset === total ? null : offset)) {
          return {text: "指标SQL分页不连续，保留调查缺口，没有生成查询。"};
        }
      }
      if (total === undefined || offset < total) {
        if (run.tool_contract_version === 2 && !previewSql?.ref) {
          const query = metric.name + ' sql';
          const prior = tools.filter(tool => tool.name === 'search_knowledge');
          if (prior.length === 1) return {tool: 'search_knowledge', args: {query, kinds: ['metric'], limit: 10}};
          return {text: '指标SQL的引用未能检索到，保留调查缺口，没有生成查询。'};
        }
        return {tool: "read_knowledge", args: run.tool_contract_version === 2
          ? {items: [{kind: 'knowledge', ref: previewSql!.ref, offset, limit: 4096}]}
          : {object_id: metric.id, version: metric.version, entry_id: previewSql?.entry_id ?? "sql", offset, limit: 4096}};
      }
    }
    let expression = metricSql?.match(/SELECT ([\s\S]*?)\nFROM/)?.[1];
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
        replaces_query_id: previous ? workspace.query_observations.find(q => q.task_id === previous.id)?.id ?? null : null,
        summary: `${conditions.time_start} 至 ${conditions.time_end}，UTC，截止不含。${conditions.channel ? "渠道 " + conditions.channel : "全部渠道"}；排除测试、只统计成功付款行。${conditions.notes} 指标：${conditions.metric}。`,
        knowledge_refs: conditions.knowledge_refs,
      },
    };
  }
  const query = latest("request_query");
  if (executeAfterRevision && query.check_state === "passed" && !has("execute_query")) return {tool: "execute_query", args: {query_id: query.id, draft_version: query.draft_version, condition_version: query.condition_version, instruction_quote: run.text}};
  return {
      text: `${has("execute_query") ? "已按修改后的条件提交查询，结果会显示在对话中。" : query.check_state === "passed" ? "SQL已准备好，可以继续补充条件，或说“执行这条”。" : "检查未通过，请补充或修改。"}${latest("manage_personal_asset")?.id ? "已保存你的个人默认渠道偏好，本次明确条件仍优先。" : latest("manage_personal_asset")?.error ? "长期偏好未保存成功，本次仍采用明确条件。" : ""}`,
  };
}
