// 仅覆盖公开语音样例的少量固定演示；完整Dogfood必须使用真实模型自主调查。
import type { TranscriptContext } from "@earendil-works/pi-ai";
import type { Conditions, RunEnvelope } from "../../../packages/contracts/generated/boundary.ts";
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
  });
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
    const query = latest("get_query")!.query;
    if (!latest("execute_query")) return {tool: "execute_query", args: {query_id: query.id, draft_version: query.draft_version,
      condition_version: query.condition_version, instruction_quote: input}};
    return {text: latest("execute_query")!.error ? "查询未提交，请查看实际错误。" : "已提交这份SQL，结果会回到当前对话。"};
  }

  const explanation = /怎样|如何|口径|定义|哪些表|有哪些/.test(input);
  const supported = input.includes("任务达成率");
  if (explanation) {
    if (!latest("read_knowledge")) return {tool: "read_knowledge", args: {object_id: /ASR/i.test(input) ? "document-cockpit-asr-candidates" : "document-cockpit-overview", entry_id: "body", limit: 8000}};
    if (!latest("update_analysis_task")) return route();
    return {text: /ASR/i.test(input)
      ? "ASR尝试用wall_ms记录单调时钟耗时，秒级时间戳不能精确还原它。先区分所有尝试、成功尝试或每轮最终尝试，再按原始非空样本计算平均与最近秩P95；重试不能当成新的用户轮次。任务达成、转写一致与意图一致是不同指标。当前是固定合成演示，完整调查请切换真实模型。"
      : "语音资料覆盖入口/唤醒、前端VAD、ASR尝试与候选、NLU与槽位、多轮对话、技能路由、动作提交与回执、TTS、播放和打断、反馈与网络错误。车型、构建、模型和策略是背景维度；三个日汇总分别用于体验、阶段和意图分析。没有原始音频。请在语义管理按表或文档查看具体粒度、字段与来源；完整自由提问需真实模型。"};
  }
  if (!supported) {
    if (!latest("update_analysis_task")) return route();
    return {text: "当前本地模拟模型只演示语音任务达成率查询、ASR口径说明和链路目录。可以问“查2026年9月语音任务达成率”，也可按天或车型分组。完整语音链路Dogfood请切换已配置真实模型；不会用固定策略冒充自主分析。"};
  }
  if (!latest("read_knowledge")) return {tool: "read_knowledge", args: {object_id: "metric-task_completion_rate", entry_id: "definition", limit: 6000}};
  const definition = latest("read_knowledge")!;
  if (definition.error) {
    if (!latest("update_analysis_task")) return route();
    return {text: "当前资料包未能读取语音任务达成率定义，请核对来源加载。没有生成或执行SQL。"};
  }
  const period = input.match(/(?:(202\d)年)?(\d{1,2})月/);
  const year = Number(period?.[1] ?? 2026), month = Number(period?.[2] ?? 9);
  const start = `${year}-${String(month).padStart(2,"0")}-01`;
  const end = `${month === 12 ? year + 1 : year}-${String(month === 12 ? 1 : month + 1).padStart(2,"0")}-01`;
  const group = input.includes("按车型") ? "model" : input.includes("按天") ? "day" : "total";
  const refs = [{object_id: definition.id ?? "metric-task_completion_rate", version: definition.version ?? "1", path: "definition"}];
  const conditions: Conditions = {time_start:start+"T00:00:00Z",time_end:end+"T00:00:00Z",timezone:"UTC",metric:"task_completion_rate",
    channel:null,group_by:group === "total" ? [] : [group === "day" ? "activity_date" : "model_id"],filters:[],knowledge_refs:refs,
    notes:"采用快照日汇总中的合格语音轮次与任务达成数，零分母返回NULL，百分比在SQL计算。"};
  if (!latest("update_analysis_task")) return {tool:"update_analysis_task",args:{action:"create",goal:input,conditions,options:[]}};
  const task = latest("update_analysis_task")!;
  if (!latest("request_query")) {
    const dimension = group === "day" ? "d.activity_date" : "m.model_name";
    const join = group === "model" ? "\nJOIN syn_vehicle v ON v.vehicle_id=d.vehicle_id\nJOIN syn_vehicle_model m ON m.model_id=v.model_id" : "";
    const sql = `SELECT ${group === "total" ? "" : dimension + ",\n       "}COALESCE(SUM(d.task_completed_count),0) AS completed_turns,\n       COALESCE(SUM(d.eligible_turn_count),0) AS eligible_turns,\n       ROUND(100.0*SUM(d.task_completed_count)/NULLIF(SUM(d.eligible_turn_count),0),2) AS completion_pct\nFROM syn_daily_voice_experience d${join}\nWHERE d.snapshot_exclusive=:snapshot AND d.activity_date>=:start AND d.activity_date<:end${group === "total" ? "" : "\nGROUP BY " + dimension + "\nORDER BY " + dimension}`;
    return {tool:"request_query",args:{task_id:task.task_id,condition_version:task.condition_version,sql,parameters:{start,end,snapshot:"2026-10-04T00:00:00Z"},target_id:"synthetic-sqlite",
      summary:`语音任务达成率：${start}至${end}，按已声明合格轮次口径；达成数、分母与百分比由SQL返回，零分母为NULL。`,
      knowledge_refs:refs,replaces_query_id:null,
      semantic_resolution:{interpretation:"使用已读取的task_completion_rate定义，日汇总同轮次分子分母相加后计算。",basis:"unambiguous",user_quote:null,unresolved_differences:[]}}};
  }
  return {text:"SQL已保存为草稿，尚未执行。请核对范围和口径，需要取数时说“执行这条”。当前仅为固定合成演示。"};
}
