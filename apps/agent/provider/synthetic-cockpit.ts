// 仅覆盖公开语音样例的少量固定演示；完整Dogfood必须使用真实模型自主调查。
import type { TranscriptContext } from "@earendil-works/pi-ai";
import type { Conditions, EvidenceRef, RunEnvelope } from "../../../packages/contracts/generated/boundary.ts";
import type { SyntheticAction } from "./synthetic-analysis.ts";
import { isRecoveryNotice } from "../session/checkpoint.ts";

type RecordValue = Record<string, any>;

export function cockpitAction(run: RunEnvelope, context: TranscriptContext): SyntheticAction {
  const input = run.text;
  const messages = context.messages.filter(message => !isRecoveryNotice(message));
  const lastInput = messages.findLastIndex(message => message.role === "user" &&
    (typeof message.content === "string" ? message.content : message.content.filter(part => part.type === "text").map(part => part.text).join("")) === input);
  const tools = messages.slice(lastInput + 1).filter(message => message.role === "toolResult").map(message => {
    const text = message.content.find(part => part.type === "text");
    try { return {name: message.toolName, data: JSON.parse(text?.type === "text" ? text.text : "{}")}; }
    catch { return {name: message.toolName, data: {error: "invalid_receipt"}}; }
  }).filter(tool => tool.data.error !== 'tool_response_capacity');
  const latest = (name: string): RecordValue | undefined => tools.findLast(tool => tool.name === name)?.data;
  const workspace = run.workspace_context!;
  const active = (workspace.tasks as RecordValue[]).findLast(task => task.lifecycle === "active");
  const route = (task = active): SyntheticAction => ({tool: "update_analysis_task", args: {
    action: "route", task_id: task?.id ?? null, expected_version: task?.condition_version ?? null, options: [],
  }});

  if (/^执行(?:上面这|这|刚才这)(?:一)?(?:条|份)(?:SQL|查询)?[。！!]?$/i.test(input)) {
    const drafts = workspace.query_observations.filter(query => query.execution_state === "not_submitted");
    if (!latest("update_analysis_task")) return route((workspace.tasks as RecordValue[]).find(task => task.id === drafts[0]?.task_id));
    if (drafts.length !== 1) return {text: "当前固定演示需要一份明确的待执行草稿。多任务和含糊指代请切换真实模型试用。"};
    if (!latest("get_query")) return {tool: "get_query", args: {query_id: drafts[0].id}};
    const read = latest("get_query")!;
    if (read.error || !read.query || read.query.text_unavailable) return {text: "当前查询草稿不可读取，没有提交查询。请核对来源后重试。"};
    const query = read.query;
    if (!latest("execute_query")) return {tool: "execute_query", args: {query_id: query.id, draft_version: query.draft_version,
      condition_version: query.condition_version, instruction_quote: input}};
    return {text: latest("execute_query")!.error ? "查询未提交，请查看实际错误。" : "已提交这份SQL，结果会回到当前对话。"};
  }

  const explanation = /怎样|如何|口径|定义|哪些表|有哪些/.test(input);
  const supported = input.includes("任务达成率");
  if (!explanation && !supported) {
    if (!latest("update_analysis_task")) return route();
    return {text: "当前本地模拟模型只演示语音任务达成率查询、ASR口径说明和链路目录。可以问“查2026年9月语音任务达成率”，也可按天或车型分组。完整语音链路Dogfood请切换已配置真实模型；不会用固定策略冒充自主分析。"};
  }
  const objectId = explanation
    ? /ASR/i.test(input) ? "document-cockpit-asr-candidates" : "document-cockpit-overview"
    : "metric-task_completion_rate";
  const path = explanation ? "body" : "definition";
  let reference: EvidenceRef | undefined;
  let unavailable = false;
  if (!latest("update_analysis_task")) return route();
  if (!latest("search_knowledge")) return {tool: "search_knowledge", args: {
    query: explanation ? /ASR/i.test(input) ? "端云识别与候选选择" : "合成范围与隐私来源" : "语音任务达成率",
    kinds: [explanation ? "document" : "metric"], limit: 10,
  }};
  const search = latest("search_knowledge")!;
  const hit = search.hits?.find((item: RecordValue) => item.record_kind === "knowledge_entry"
    && item.ref.object_id === objectId && item.ref.path === path);
  const raw = search.hits?.find((item: RecordValue) => item.record_kind === 'source_excerpt'
    && item.citation.source.kind === 'document' && item.citation.source.id === objectId);
  if (!hit && raw && !search.error) {
    const read = latest('read_source');
    unavailable = Boolean(read?.error) || Boolean(read && (read.source?.id !== raw.citation.source.id || read.revision !== raw.citation.revision));
    if (!unavailable && (!read || read.next_locator)) return {tool: 'read_source', args: {
      citation: {...raw.citation, locator: read?.next_locator ?? {offset: 0, length: raw.source_length}}, limit: 8000,
    }};
  } else if (search.error || !hit) unavailable = true;
  else {
    reference = hit.ref;
    // 容量触发的压缩只保留最近回执：可见页链内一致即可续读，续读点取
    // 最后一页next_offset，不要求从0开始的完整分页史可见。
    let resume: number | undefined;
    let total: number | undefined;
    let complete = false;
    for (const read of tools.filter(tool => tool.name === "read_knowledge")) {
      const item = read.data.items?.[0];
      if (read.data.error || item?.kind !== "knowledge" || item.state !== "ok"
        || item.ref.object_id !== reference!.object_id || item.ref.version !== reference!.version || item.ref.path !== reference!.path
        || (total !== undefined && item.content_page.total_chars !== total)) {
        unavailable = true;
        break;
      }
      const page = item.content_page;
      const advanced = page.offset + [...item.content].length;
      if ((resume !== undefined && page.offset !== resume)
        || page.next_offset !== (advanced === page.total_chars ? null : advanced)) {
        unavailable = true;
        break;
      }
      total = page.total_chars;
      resume = page.next_offset ?? undefined;
      complete = page.next_offset === null;
    }
    if (!unavailable && !complete) return {tool: "read_knowledge", args: {
      items: [{kind: "knowledge", ref: reference, offset: resume ?? 0, limit: 8000}],
    }};
  }
  if (unavailable) {
    if (!latest("update_analysis_task")) return route();
    return {text: "当前资料未能完整读取，请核对来源、版本与可用状态。没有生成或执行SQL，也未完成口径核对。"};
  }
  if (explanation) {
    if (!latest("update_analysis_task")) return route();
    return {text: /ASR/i.test(input)
      ? "ASR尝试用wall_ms记录单调时钟耗时，秒级时间戳不能精确还原它。先区分所有尝试、成功尝试或每轮最终尝试，再按原始非空样本计算平均与最近秩P95；重试不能当成新的用户轮次。任务达成、转写一致与意图一致是不同指标。当前是固定合成演示，完整调查请切换真实模型。"
      : "语音资料覆盖入口/唤醒、前端VAD、ASR尝试与候选、NLU与槽位、多轮对话、技能路由、动作提交与回执、TTS、播放和打断、反馈与网络错误。车型、构建、模型和策略是背景维度；三个日汇总分别用于体验、阶段和意图分析。没有原始音频。请在语义管理按表或文档查看具体粒度、字段与来源；完整自由提问需真实模型。"};
  }
  const period = input.match(/(?:(202\d)年)?(\d{1,2})月/);
  const year = Number(period?.[1] ?? 2026), month = Number(period?.[2] ?? 9);
  const start = `${year}-${String(month).padStart(2,"0")}-01`;
  const end = `${month === 12 ? year + 1 : year}-${String(month === 12 ? 1 : month + 1).padStart(2,"0")}-01`;
  const group = input.includes("按车型") ? "model" : input.includes("按天") ? "day" : "total";
  const refs = [reference!];
  const conditions: Conditions = {time_start:start+"T00:00:00Z",time_end:end+"T00:00:00Z",timezone:"UTC",metric:"task_completion_rate",
    channel:null,group_by:group === "total" ? [] : [group === "day" ? "activity_date" : "model_id"],filters:[],knowledge_refs:refs,
    source_limits:null,
    notes:"采用快照日汇总中的合格语音轮次与任务达成数，零分母返回NULL，百分比在SQL计算。",
    semantic_resolution: {interpretation:"使用已读取的task_completion_rate定义，日汇总同轮次分子分母相加后计算。",basis:"unambiguous",user_quote:null,evidence_refs:refs}};
  // route登记消息归属。首次定义完整统计任务后，才保存查询草稿。
  const created = tools.findLast(tool => tool.name === "update_analysis_task"
    && tool.data.task_id && !tool.data.routed)?.data
    ?? (active ? {task_id: active.id, condition_version: active.condition_version} : undefined);
  if (!created) return {tool:"update_analysis_task",args:{action:"create",goal:input,conditions,options:[]}};
  const task = created;
  if (!latest("request_query")) {
    const dimension = group === "day" ? "d.activity_date" : "m.model_name";
    const join = group === "model" ? "\nJOIN syn_vehicle v ON v.vehicle_id=d.vehicle_id\nJOIN syn_vehicle_model m ON m.model_id=v.model_id" : "";
    const sql = `SELECT ${group === "total" ? "" : dimension + ",\n       "}COALESCE(SUM(d.task_completed_count),0) AS completed_turns,\n       COALESCE(SUM(d.eligible_turn_count),0) AS eligible_turns,\n       ROUND(100.0*SUM(d.task_completed_count)/NULLIF(SUM(d.eligible_turn_count),0),2) AS completion_pct\nFROM syn_daily_voice_experience d${join}\nWHERE d.snapshot_exclusive=:snapshot AND d.activity_date>=:start AND d.activity_date<:end${group === "total" ? "" : "\nGROUP BY " + dimension + "\nORDER BY " + dimension}`;
    return {tool:"request_query",args:{task_id:task.task_id,condition_version:task.condition_version,sql,parameters:{start,end,snapshot:"2026-10-04T00:00:00Z"},target_id:"synthetic-sqlite",
      summary:`语音任务达成率：${start}至${end}，按已声明合格轮次口径；达成数、分母与百分比由SQL返回，零分母为NULL。`,
      knowledge_refs:refs,replaces_query_id:null}};
  }
  // 被拒草稿仍持久保存：回执带草稿身份与诊断，话术不得说未保存。
  // 拒绝原因不止编译检查（如message_pending归属未登记），按回执真实error码播报。
  const rejectedQuery = latest("request_query")!;
  if (rejectedQuery.error) return {text: `SQL保存请求被拒绝（${typeof rejectedQuery.error === "string" ? rejectedQuery.error : JSON.stringify(rejectedQuery.error)}）；草稿身份与诊断以回执为准，没有执行SQL。请按诊断处理后重新保存。`};
  return {text:"SQL已保存为草稿，尚未执行。请核对范围和口径，需要取数时说“执行这条”。当前仅为固定合成演示。"};
}
