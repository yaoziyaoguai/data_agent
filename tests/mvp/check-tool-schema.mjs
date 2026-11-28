import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { Ajv2020 } from "ajv/dist/2020.js";
import { fullFormats } from "ajv-formats/dist/formats.js";
import { dataTools } from "../../apps/agent/tools/data-tools.ts";
import schema from "../../packages/contracts/schema.json" with { type: "json" };
import cases from "../contracts/cases.json" with { type: "json" };

// 模型目录只有现行v2合同；legacy合同由Rust账本和契约用例继续校验。
const contracts = {
  read: "SkillReadInput",
  search_knowledge: "KnowledgeSearchInput",
  read_knowledge: "KnowledgeReadInput",
  read_source: "SourceReadInput",
  validate_sql: "SQLInput",
  request_query: "CurrentRequestQueryInput",
  execute_query: "ExecuteQueryInput",
  update_analysis_task: "CurrentAnalysisUpdate",
  get_query: "GetQueryInput",
  cancel_query: "ReadQueryInput",
  save_analysis_evidence: "SaveAnalysisEvidenceInput",
  prepare_analysis_answer: "PrepareAnalysisAnswerInput",
  save_analysis_report: "SaveAnalysisReportInput",
  read_analysis_report: "ReadAnalysisReportInput",
  manage_personal_asset: "AssetToolInput",
  prepare_skill_draft: "PrepareSkillDraftInput",
  propose_semantic_change: "ProposalInput",
  read_analysis_task: "ReadTaskInput",
  read_conversation: "ConversationReadInput",
};
// 当前决策合同沿原合同用例核实际接受行为。
const legacyContracts = { request_query: "RequestQueryInput", update_analysis_task: "AnalysisUpdate" };
const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addFormat("date-time", fullFormats["date-time"]);
const checks = [];
// 以同源合同为参考比较验证结构；注释精简不能删除同名业务字段或约束。
function validationSchema(value) {
  if (Array.isArray(value)) return value.map(validationSchema);
  if (!value || typeof value !== 'object') return value;
  if (value.$ref) return validationSchema(schema.$defs[value.$ref.slice(8)]);
  return Object.fromEntries(Object.entries(value)
    .filter(([key, item]) => !(['title', 'description'].includes(key) && typeof item === 'string'))
    .map(([key, item]) => [key, validationSchema(item)]));
}
const tools = dataTools({run: {tool_contract_version: 2}}, null, "").tools;
assert.deepEqual(tools.map((tool) => tool.name).sort(), Object.keys(contracts).sort());
// 模型只看到展开后的参数；引用位置上的动作/来源说明也是对外工具合同。
const taskParameters = tools.find(tool => tool.name === "update_analysis_task").parameters;
assert.equal(taskParameters.type, "object");
const taskFields = taskParameters.properties;
for (const field of ["conditions", "condition_patch"]) {
  assert.equal(taskFields[field].description, schema.$defs.AnalysisUpdateFields.properties[field].description,
    `${field} 的调用说明不能在展开引用时丢失`);
}
assert.equal(taskFields.condition_patch.properties.set.properties.source_limits.description,
  schema.$defs.ConditionSet.properties.source_limits.description,
  "设置与撤销来源限制的区别必须交给模型");
// 准入前只有任务工具开放，不能依赖尚未开放的read_source携带共享类型说明。
for (const name of ["update_analysis_task", "read_source"]) {
  const parameters = tools.find(tool => tool.name === name).parameters;
  assert.ok(JSON.stringify(parameters).includes(schema.$defs.SourceKey.description),
    `${name}: 独立开放时仍须说明来源身份，不能跨工具去重`);
}
for (const tool of tools) {
  const contract = contracts[tool.name];
  const expected = validationSchema(schema.$defs[contract]);
  const currentDecision = ["request_query", "update_analysis_task"].includes(tool.name);
  if (!currentDecision) assert.deepEqual(validationSchema(tool.parameters), expected,
    `${tool.name}: 模型参数必须保留原合同的全部验证结构`);
  // 当前合同以交集约束新说明，模型参数只暴露该分支；核实际接受行为，不克隆实现投影。
  const canonical = ajv.compile(expected);
  const validate = ajv.compile(tool.parameters);
  const fixtures = cases.filter((item) => item.schema === contract || item.schema === legacyContracts[tool.name]);
  for (const fixture of fixtures) {
    const accepted = currentDecision ? canonical(fixture.value) : fixture.valid;
    assert.equal(validate(fixture.value), accepted,
      `${tool.name}: ${fixture.name}: ${JSON.stringify(validate.errors)}`);
  }
  if (currentDecision) {
    const adoption = { interpretation: "采用已读的明确合成定义。", basis: "unambiguous", user_quote: null };
    const draft = { task_id: "synthetic-task", condition_version: "1", sql: "SELECT 1 AS value", parameters: {},
      target_id: "synthetic-sqlite", summary: "合成参数检查", knowledge_refs: [], replaces_query_id: null };
    const create = { action: "create", goal: "合成参数检查", options: [], conditions: { time_start: null, time_end: null,
      timezone: "UTC", metric: null, channel: null, group_by: [], filters: [], knowledge_refs: [], notes: "", source_limits: null, semantic_resolution: adoption } };
    const revise = { action: "revise", task_id: "synthetic-task", expected_version: "1", options: [], condition_patch: { set: { semantic_resolution: null }, unset: [] } };
    const baseConditions = { time_start: null, time_end: null, timezone: "UTC", metric: null,
      channel: null, group_by: [], filters: [], knowledge_refs: [], notes: "", source_limits: null };
    const samples = tool.name === "request_query" ? [
      { value: draft, valid: true }, { value: { ...draft, semantic_resolution: adoption }, valid: true },
      { value: { ...draft, semantic_resolution: { ...adoption, unresolved_differences: [] } }, valid: false },
    ] : [
      { value: create, valid: true },
      { value: { ...create, conditions: { ...create.conditions, semantic_resolution: { ...adoption, unresolved_differences: [] } } }, valid: false },
      { value: revise, valid: true },
      { value: { ...revise, legacy_resolution_migration: { from_condition_version: "1", links: [] } }, valid: true },
      { value: { action: "route", task_id: "synthetic-task", expected_version: "1", options: [], legacy_resolution_migration: { from_condition_version: "1", links: [] } }, valid: false },
      // v2无关动作不再要求options键：route/revise/create省略、开放问题无候选都合法；
      // route夹带条件或补丁仍按合同拒绝。
      { value: { action: "route", task_id: "synthetic-task", expected_version: "1", goal: "" }, valid: true },
      { value: { action: "revise", task_id: "synthetic-task", expected_version: "1", goal: "解释合成字段", condition_patch: { set: {}, unset: [] } }, valid: true },
      { value: { action: "create", goal: "合成参数检查", conditions: baseConditions }, valid: true },
      { value: { action: "create", goal: "合成参数检查", conditions: baseConditions, question: "请说明统计口径偏好" }, valid: true },
      { value: { action: "route", task_id: "synthetic-task", expected_version: "1", goal: "", condition_patch: { set: { channel: "app" }, unset: [] } }, valid: false },
    ];
    for (const sample of samples) {
      assert.equal(canonical(sample.value), sample.valid, `${tool.name}: 当前同源合同的明确样例`);
      assert.equal(validate(sample.value), sample.valid, `${tool.name}: 实际Pi参数必须接受相同新形状并拒绝旧写法`);
    }
  }
  checks.push({ tool: tool.name, contract, cases: fixtures.length });
}

const query = tools.find((tool) => tool.name === "request_query");
assert.ok(!query.parameters.required.includes("semantic_resolution"));
const validateResolution = ajv.compile(query.parameters.properties.semantic_resolution);
const resolutionCases = cases.filter((item) => ["QuerySemanticResolution", "AdoptedSemanticResolution"].includes(item.schema));
const validateAdoption = ajv.compile(validationSchema(schema.$defs.AdoptedSemanticResolution));
for (const fixture of resolutionCases) {
  assert.equal(validateResolution(fixture.value), validateAdoption(fixture.value),
    `request_query.semantic_resolution: ${fixture.name}: ${JSON.stringify(validateResolution.errors)}`);
}

const report = tools.find((tool) => tool.name === "save_analysis_report");
const validateReport = ajv.compile(report.parameters);
const input = {
  task_id: "synthetic-report-task",
  condition_version: "1",
  expected_version: null,
  title: "合成渠道分析",
  evidence_ids: ["synthetic-evidence"],
  charts: [{
    kind: "bar",
    title: "合成渠道净额",
    query_id: "synthetic-query",
    result_ref: "synthetic-result",
    dimension_column: "channel",
    measure_column: "net_amount",
  }],
};
assert.equal(validateReport(input), true, JSON.stringify(validateReport.errors));
assert.deepEqual(report.parameters.properties.title,
  schema.$defs.SaveAnalysisReportInput.properties.title);
assert.deepEqual(report.parameters.properties.charts.items.properties.title,
  schema.$defs.AnalysisReportChart.properties.title);
for (const target of ["report", "chart"]) {
  for (const invalid of [undefined, "", " ", 123]) {
    const value = structuredClone(input);
    const item = target === "report" ? value : value.charts[0];
    if (invalid === undefined) delete item.title;
    else item.title = invalid;
    assert.equal(validateReport(value), false, `${target} title must preserve its contract`);
  }
}
const unexpected = structuredClone(input);
unexpected.charts[0].arbitrary = "unsupported";
assert.equal(validateReport(unexpected), false, "不能通过放宽额外字段来使工具可调用");

const result = { passed: true, checks, reportTitleCases: 10,
  semanticResolutionCases: resolutionCases.length, officialRequests: 0 };
await mkdir(".local/checks", { recursive: true });
await writeFile(".local/checks/tool-schema.json", JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
