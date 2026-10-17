use data_agent::contracts::{self, generated::*};
use serde_json::Value;
use std::io::{self, Read};
fn main() {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).expect("input");
    let cases: Vec<Value> = serde_json::from_str(&input).expect("cases");
    let result: Vec<Value> = cases
        .iter()
        .map(|case| {
            let name = case["schema"].as_str().expect("schema");
            let value = case["value"].clone();
            let valid = contracts::validate(name, &value).is_ok();
            let roundtrip = if valid {
                match name {
                    "PrepareSkillDraftInput" => serde_json::to_value(contracts::decode::<PrepareSkillDraftInput>(name,value).expect("generated type")).expect("serialize"),
                    "SkillDraftRef" => serde_json::to_value(contracts::decode::<SkillDraftRef>(name,value).expect("generated type")).expect("serialize"),
                    "SkillDraft" => serde_json::to_value(contracts::decode::<SkillDraft>(name,value).expect("generated type")).expect("serialize"),
                    "SkillDraftList" => serde_json::to_value(contracts::decode::<SkillDraftList>(name,value).expect("generated type")).expect("serialize"),
                    "MaintenanceImpactQuery" => serde_json::to_value(contracts::decode::<MaintenanceImpactQuery>(name,value).expect("generated type")).expect("serialize"),
                    "MaintenanceImpact" => serde_json::to_value(contracts::decode::<MaintenanceImpact>(name,value).expect("generated type")).expect("serialize"),
                    "ReadAnalysisReportInput" => serde_json::to_value(contracts::decode::<ReadAnalysisReportInput>(name,value).expect("generated type")).expect("serialize"),
                    "AnalysisReportPage" => serde_json::to_value(contracts::decode::<AnalysisReportPage>(name,value).expect("generated type")).expect("serialize"),
                    "SaveAnalysisReportInput" => serde_json::to_value(contracts::decode::<SaveAnalysisReportInput>(name,value).expect("generated type")).expect("serialize"),
                    "SaveAnalysisReport" => serde_json::to_value(contracts::decode::<SaveAnalysisReport>(name,value).expect("generated type")).expect("serialize"),
                    "AnalysisReportRef" => serde_json::to_value(contracts::decode::<AnalysisReportRef>(name,value).expect("generated type")).expect("serialize"),
                    "AnalysisReportChart" => serde_json::to_value(contracts::decode::<AnalysisReportChart>(name,value).expect("generated type")).expect("serialize"),
                    "AnalysisEvidence" => serde_json::to_value(contracts::decode::<AnalysisEvidence>(name,value).expect("generated type")).expect("serialize"),
                    "AnalysisReport" => serde_json::to_value(contracts::decode::<AnalysisReport>(name,value).expect("generated type")).expect("serialize"),
                    "AnalysisReportView" => serde_json::to_value(contracts::decode::<AnalysisReportView>(name,value).expect("generated type")).expect("serialize"),
                    "SaveAnalysisEvidenceInput" => serde_json::to_value(contracts::decode::<SaveAnalysisEvidenceInput>(name,value).expect("generated type")).expect("serialize"),
                    "AnalysisFigure" => serde_json::to_value(contracts::decode::<AnalysisFigure>(name,value).expect("generated type")).expect("serialize"),
                    "AnalysisEvidenceRef" => serde_json::to_value(contracts::decode::<AnalysisEvidenceRef>(name,value).expect("generated type")).expect("serialize"),
                    "SearchInput" => serde_json::to_value(contracts::decode::<SearchInput>(name,value).expect("generated type")).expect("serialize"),
                    "SemanticStructure" => serde_json::to_value(contracts::decode::<SemanticStructure>(name,value).expect("generated type")).expect("serialize"),
                    "KnowledgeEdit" => serde_json::to_value(contracts::decode::<KnowledgeEdit>(name,value).expect("generated type")).expect("serialize"),
                    "SemanticCheckReport" => serde_json::to_value(contracts::decode::<SemanticCheckReport>(name,value).expect("generated type")).expect("serialize"),
                    "Checkpoint" => serde_json::to_value(contracts::decode::<Checkpoint>(name,value).expect("generated type")).expect("serialize"),
                    "ReadCheckpoint" => serde_json::to_value(contracts::decode::<ReadCheckpoint>(name,value).expect("generated type")).expect("serialize"),
                    "AnalysisUpdate" => serde_json::to_value(
                        contracts::decode::<AnalysisUpdate>(name, value).expect("generated type"),
                    )
                    .expect("serialize"),
                    "MessageInput" => serde_json::to_value(
                        contracts::decode::<MessageInput>(name, value).expect("generated type"),
                    )
                    .expect("serialize"),
                    "ToolInvocation" => serde_json::to_value(
                        contracts::decode::<ToolInvocation>(name, value).expect("generated type"),
                    )
                    .expect("serialize"),
                    "FinishRun" => serde_json::to_value(
                        contracts::decode::<FinishRun>(name, value).expect("generated type"),
                    )
                    .expect("serialize"),
                    "ToolOutcome" => serde_json::to_value(
                        contracts::decode::<ToolOutcome>(name, value).expect("generated type"),
                    )
                    .expect("serialize"),
                    "Event" => serde_json::to_value(
                        contracts::decode::<Event>(name, value).expect("generated type"),
                    )
                    .expect("serialize"),
                    "ConversationReceipt" => serde_json::to_value(
                        contracts::decode::<ConversationReceipt>(name, value)
                            .expect("generated type"),
                    )
                    .expect("serialize"),
                    "MessageReceipt" => serde_json::to_value(
                        contracts::decode::<MessageReceipt>(name, value).expect("generated type"),
                    )
                    .expect("serialize"),
                    "History" => serde_json::to_value(
                        contracts::decode::<History>(name, value).expect("generated type"),
                    )
                    .expect("serialize"),
                    "Identity" => serde_json::to_value(
                        contracts::decode::<Identity>(name, value).expect("generated type"),
                    )
                    .expect("serialize"),
                    "SessionReceipt" => serde_json::to_value(
                        contracts::decode::<SessionReceipt>(name, value).expect("generated type"),
                    )
                    .expect("serialize"),
                    "RunEnvelope" => serde_json::to_value(
                        contracts::decode::<RunEnvelope>(name, value).expect("generated type"),
                    )
                    .expect("serialize"),
                    "WorkspaceContext" => serde_json::to_value(
                        contracts::decode::<WorkspaceContext>(name, value).expect("generated type"),
                    )
                    .expect("serialize"),
                    "ModelProfile" => serde_json::to_value(
                        contracts::decode::<ModelProfile>(name, value).expect("generated type"),
                    )
                    .expect("serialize"),
                    "ReserveModelCall" => serde_json::to_value(
                        contracts::decode::<ReserveModelCall>(name, value).expect("generated type"),
                    )
                    .expect("serialize"),
                    "SendModelCall" => serde_json::to_value(
                        contracts::decode::<SendModelCall>(name, value).expect("generated type"),
                    )
                    .expect("serialize"),
                    "ModelUsage" => serde_json::to_value(
                        contracts::decode::<ModelUsage>(name, value).expect("generated type"),
                    )
                    .expect("serialize"),
                    "FinalizeModelCall" => serde_json::to_value(
                        contracts::decode::<FinalizeModelCall>(name, value)
                            .expect("generated type"),
                    )
                    .expect("serialize"),
                    "ModelCallReceipt" => serde_json::to_value(
                        contracts::decode::<ModelCallReceipt>(name, value).expect("generated type"),
                    )
                    .expect("serialize"),
                    "CancelRun" => serde_json::to_value(
                        contracts::decode::<CancelRun>(name, value).expect("generated type"),
                    )
                    .expect("serialize"),
                    "CancelReceipt" => serde_json::to_value(
                        contracts::decode::<CancelReceipt>(name, value).expect("generated type"),
                    )
                    .expect("serialize"),
                    "AnalysisPreferenceCommand" => serde_json::to_value(
                        contracts::decode::<AnalysisPreferenceCommand>(name, value)
                            .expect("generated type"),
                    )
                    .expect("serialize"),
                    "TableAnalysisPreference" => serde_json::to_value(
                        contracts::decode::<TableAnalysisPreference>(name, value)
                            .expect("generated type"),
                    )
                    .expect("serialize"),
                    _ => value,
                }
            } else {
                Value::Null
            };
            serde_json::json!({"valid":valid,"roundtrip_valid":valid && contracts::validate(name, &roundtrip).is_ok(),"roundtrip":roundtrip})
        })
        .collect();
    println!("{}", serde_json::to_string(&result).expect("serialize"));
}
