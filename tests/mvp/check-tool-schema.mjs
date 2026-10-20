import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { Ajv2020 } from "ajv/dist/2020.js";
import { fullFormats } from "ajv-formats/dist/formats.js";
import { dataTools } from "../../apps/agent/tools/data-tools.ts";
import schema from "../../packages/contracts/schema.json" with { type: "json" };
import cases from "../contracts/cases.json" with { type: "json" };

const contracts = {
  read: "SkillReadInput",
  search_knowledge: "SearchInput",
  read_knowledge: "ReadKnowledgeInput",
  read_source: "ReadSourceInput",
  validate_sql: "SQLInput",
  request_query: "RequestQueryInput",
  execute_query: "ExecuteQueryInput",
  update_analysis_task: "AnalysisUpdate",
  get_query: "GetQueryInput",
  cancel_query: "ReadQueryInput",
  save_analysis_evidence: "SaveAnalysisEvidenceInput",
  save_analysis_report: "SaveAnalysisReportInput",
  read_analysis_report: "ReadAnalysisReportInput",
  manage_personal_asset: "AssetToolInput",
  prepare_skill_draft: "PrepareSkillDraftInput",
  propose_semantic_change: "ProposalInput",
  read_analysis_task: "ReadTaskInput",
  read_conversation: "ConversationReadInput",
};
const tools = dataTools({}, null, "").tools;
assert.deepEqual(tools.map((tool) => tool.name).sort(), Object.keys(contracts).sort());
const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addFormat("date-time", fullFormats["date-time"]);
const checks = [];
for (const tool of tools) {
  // 直接验证模型实际接收的展开后参数，不以原契约通过代替工具可用性。
  const validate = ajv.compile(tool.parameters);
  const fixtures = cases.filter((item) => item.schema === contracts[tool.name]);
  for (const fixture of fixtures) {
    assert.equal(validate(fixture.value), fixture.valid,
      `${tool.name}: ${fixture.name}: ${JSON.stringify(validate.errors)}`);
  }
  checks.push({ tool: tool.name, contract: contracts[tool.name], cases: fixtures.length });
}

const query = tools.find((tool) => tool.name === "request_query");
assert.ok(!query.parameters.required.includes("semantic_resolution"));
const validateResolution = ajv.compile(query.parameters.properties.semantic_resolution);
const resolutionCases = cases.filter((item) => item.schema === "QuerySemanticResolution");
for (const fixture of resolutionCases) {
  assert.equal(validateResolution(fixture.value), fixture.valid,
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
