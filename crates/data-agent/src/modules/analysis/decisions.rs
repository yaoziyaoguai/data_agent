use crate::{
    contracts::{self, generated::LegacyResolutionMigration},
    types::{Error, Result},
};
use serde_json::{Value, json};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum DecisionStateVersion {
    Legacy,
    Clarifications,
}

impl DecisionStateVersion {
    pub fn number(self) -> u8 {
        match self {
            Self::Legacy => 1,
            Self::Clarifications => 2,
        }
    }
}

pub struct ConditionRevision {
    pub body: Value,
    pub field_authorities: Value,
    pub decision_state: DecisionStateVersion,
}

impl ConditionRevision {
    pub(super) fn from_stored(body: Value, fields: Value, version: u8) -> Result<Self> {
        let decision_state = match version {
            1 => DecisionStateVersion::Legacy,
            2 => DecisionStateVersion::Clarifications,
            _ => return Err(Error::new("invalid_evidence")),
        };
        if let Some(resolution) = body
            .get("semantic_resolution")
            .filter(|value| !value.is_null())
        {
            let schema = match decision_state {
                DecisionStateVersion::Legacy => "QuerySemanticResolution",
                DecisionStateVersion::Clarifications => "AdoptedSemanticResolution",
            };
            contracts::validate(schema, resolution).map_err(|_| Error::new("invalid_evidence"))?;
        }
        Ok(Self {
            body,
            field_authorities: fields,
            decision_state,
        })
    }

    pub fn legacy_pending(&self, condition_version: u64) -> Result<Option<Value>> {
        if self.decision_state != DecisionStateVersion::Legacy {
            return Ok(None);
        }
        let resolution = &self.body["semantic_resolution"];
        let mut items = Vec::new();
        if let Some(differences) = resolution["unresolved_differences"].as_array() {
            for (index, text) in differences.iter().enumerate() {
                let text = text.as_str().ok_or(Error::new("invalid_evidence"))?;
                items.push(json!({"index":index,"text":text}));
            }
        }
        if items.is_empty() && resolution["basis"] == "needs_clarification" {
            let text = resolution["interpretation"]
                .as_str()
                .ok_or(Error::new("invalid_evidence"))?;
            items.push(json!({"index":0,"text":text}));
        }
        Ok((!items.is_empty())
            .then(|| json!({"condition_version":condition_version.to_string(),"items":items})))
    }
}

pub fn legacy_resolution_pending(resolution: &Value) -> bool {
    resolution["basis"] == "needs_clarification"
        || resolution["unresolved_differences"]
            .as_array()
            .is_some_and(|items| !items.is_empty())
}

/// 只规范化已决的旧形状；未决不能经删键变成新采纳。
pub fn normalized_adoption(resolution: &Value) -> Result<Value> {
    if legacy_resolution_pending(resolution) {
        return Err(Error::new("clarification_required"));
    }
    let mut adopted = resolution.clone();
    if let Some(object) = adopted.as_object_mut() {
        object.remove("unresolved_differences");
        object.entry("evidence_refs").or_insert_with(|| json!([]));
        object.entry("adoption_message_id").or_insert(Value::Null);
    }
    Ok(adopted)
}

pub fn same_adoption(left: &Value, right: &Value) -> bool {
    matches!((normalized_adoption(left), normalized_adoption(right)), (Ok(left), Ok(right)) if left == right)
}

/// 由组合用例接回的真实成功条件回执；模型只能给版本和字段，不能提交这些事实。
pub struct LegacyResolutionProof {
    pub condition_version: u64,
    pub conditions: Value,
    pub user_supplied: bool,
    pub verified_adoption: Option<Value>,
}

pub struct LegacyDecisionMigration {
    pub request: LegacyResolutionMigration,
    pub proofs: Vec<LegacyResolutionProof>,
    pub current_message_id: String,
}
