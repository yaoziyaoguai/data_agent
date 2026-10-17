use crate::{
    contracts,
    types::{Error, Result},
};
use serde_json::Value;
use sqlx::{MySql, QueryBuilder};

// 正式知识和可重建索引共用范围含义；范围不提供身份、来源或执行授权。
#[derive(Clone, Debug, Default)]
pub struct KnowledgeSearchScope {
    pub kinds: Vec<String>,
    pub anchor: Option<String>,
    pub domain: Option<String>,
}

impl KnowledgeSearchScope {
    pub fn from_input(input: &Value) -> Result<Self> {
        contracts::validate("SearchInput", input)?;
        let kinds = input["kinds"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|kind| kind.as_str().expect("已校验对象种类").to_owned())
            .collect();
        let anchor = input["related_object_id"].as_str().map(str::to_owned);
        let domain = input["business_domain"].as_str().map(str::to_owned);
        if domain
            .as_ref()
            .is_some_and(|domain| domain.trim().is_empty())
        {
            return Err(Error::new("invalid_input"));
        }
        Ok(Self {
            kinds,
            anchor,
            domain,
        })
    }

    pub fn is_unscoped(&self) -> bool {
        self.kinds.is_empty() && self.anchor.is_none() && self.domain.is_none()
    }

    pub fn matches(&self, object: &Value) -> bool {
        (self.kinds.is_empty()
            || object["kind"]
                .as_str()
                .is_some_and(|kind| self.kinds.iter().any(|wanted| wanted == kind)))
            && self
                .anchor
                .as_ref()
                .is_none_or(|anchor| matches_anchor(object, anchor))
            && self.domain.as_ref().is_none_or(|domain| {
                object["entries"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|entry| matches_domain(entry, domain))
            })
    }

    // SQL列参数只来自固定代码；范围值全部绑定并在LIMIT前过滤。
    // COUNT标量子查询避免MySQL将相关JSON_TABLE错误改排为先于外层的semijoin。
    pub fn push_constraints(
        &self,
        sql: &mut QueryBuilder<MySql>,
        id: &'static str,
        kind: &'static str,
        body: &'static str,
    ) {
        if !self.kinds.is_empty() {
            sql.push(" AND BINARY ").push(kind).push(" IN (");
            let mut kinds = sql.separated(",");
            for value in &self.kinds {
                kinds.push_bind(value.clone());
            }
            sql.push(")");
        }
        if let Some(anchor) = &self.anchor {
            sql.push(" AND (BINARY ").push(id).push("=BINARY ").push_bind(anchor.clone())
                .push(" OR JSON_CONTAINS(JSON_EXTRACT(").push(body).push(",'$.related_ids'),JSON_QUOTE(").push_bind(anchor.clone()).push(")) OR (SELECT COUNT(*) FROM JSON_TABLE(")
                .push(body).push(",'$.entries[*]' COLUMNS (entry JSON PATH '$')) AS scope_relation WHERE (JSON_UNQUOTE(JSON_EXTRACT(scope_relation.entry,'$.effective_structure.kind')) IN ('field','metric') AND JSON_CONTAINS(JSON_EXTRACT(scope_relation.entry,'$.effective_structure.table.object_id'),JSON_QUOTE(")
                .push_bind(anchor.clone()).push("))) OR (JSON_UNQUOTE(JSON_EXTRACT(scope_relation.entry,'$.effective_structure.kind'))='relationship' AND (JSON_CONTAINS(JSON_EXTRACT(scope_relation.entry,'$.effective_structure.left_table.object_id'),JSON_QUOTE(")
                .push_bind(anchor.clone()).push(")) OR JSON_CONTAINS(JSON_EXTRACT(scope_relation.entry,'$.effective_structure.right_table.object_id'),JSON_QUOTE(")
                .push_bind(anchor.clone()).push(")))) OR (JSON_UNQUOTE(JSON_EXTRACT(scope_relation.entry,'$.effective_structure.kind'))='query_example' AND (JSON_CONTAINS(JSON_EXTRACT(scope_relation.entry,'$.effective_structure.dependencies[*].object_id'),JSON_QUOTE(")
                .push_bind(anchor.clone()).push(")) OR JSON_CONTAINS(JSON_EXTRACT(scope_relation.entry,'$.effective_structure.verification.evidence_refs[*].object_id'),JSON_QUOTE(")
                .push_bind(anchor.clone()).push(")))))>0)");
        }
        if let Some(domain) = &self.domain {
            sql.push(" AND (SELECT COUNT(*) FROM JSON_TABLE(").push(body)
                .push(",'$.entries[*]' COLUMNS (entry JSON PATH '$')) AS scope_domain WHERE BINARY JSON_UNQUOTE(JSON_EXTRACT(scope_domain.entry,'$.path'))=BINARY 'business_domain' AND BINARY JSON_UNQUOTE(JSON_EXTRACT(scope_domain.entry,'$.effective_value'))=BINARY ")
                .push_bind(domain.clone()).push(" AND ((JSON_TYPE(JSON_EXTRACT(scope_domain.entry,'$.human_override'))='OBJECT' AND JSON_UNQUOTE(JSON_EXTRACT(scope_domain.entry,'$.review_state'))='confirmed' AND JSON_TYPE(JSON_EXTRACT(scope_domain.entry,'$.human_override.value'))='STRING' AND BINARY JSON_UNQUOTE(JSON_EXTRACT(scope_domain.entry,'$.human_override.value'))=BINARY ")
                .push_bind(domain.clone()).push(") OR ((JSON_TYPE(JSON_EXTRACT(scope_domain.entry,'$.human_override')) IS NULL OR JSON_TYPE(JSON_EXTRACT(scope_domain.entry,'$.human_override'))='NULL') AND COALESCE(JSON_TYPE(JSON_EXTRACT(scope_domain.entry,'$.suggestion.value'))='STRING' AND CHAR_LENGTH(JSON_UNQUOTE(JSON_EXTRACT(scope_domain.entry,'$.suggestion.value')))>0,FALSE)=FALSE AND JSON_UNQUOTE(JSON_EXTRACT(scope_domain.entry,'$.source_facts.complete'))='true' AND JSON_TYPE(JSON_EXTRACT(scope_domain.entry,'$.source_facts.source_id'))='STRING' AND CHAR_LENGTH(JSON_UNQUOTE(JSON_EXTRACT(scope_domain.entry,'$.source_facts.source_id')))>0 AND JSON_TYPE(JSON_EXTRACT(scope_domain.entry,'$.source_facts.version'))='STRING' AND JSON_UNQUOTE(JSON_EXTRACT(scope_domain.entry,'$.source_facts.version')) REGEXP '^(0|[1-9][0-9]{0,19})$' AND BINARY CAST(CAST(JSON_UNQUOTE(JSON_EXTRACT(scope_domain.entry,'$.source_facts.version')) AS UNSIGNED) AS CHAR)=BINARY JSON_UNQUOTE(JSON_EXTRACT(scope_domain.entry,'$.source_facts.version')) AND BINARY JSON_UNQUOTE(JSON_EXTRACT(scope_domain.entry,'$.source_facts.classification')) IN ('source_text','authored_definition') AND JSON_TYPE(JSON_EXTRACT(scope_domain.entry,'$.source_facts.value'))='STRING' AND BINARY JSON_UNQUOTE(JSON_EXTRACT(scope_domain.entry,'$.source_facts.value'))=BINARY ")
                .push_bind(domain.clone()).push(")))>0");
        }
    }
}

fn matches_anchor(object: &Value, anchor: &str) -> bool {
    object["id"] == anchor
        || object["related_ids"]
            .as_array()
            .is_some_and(|ids| ids.iter().any(|id| id == anchor))
        || object["entries"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|entry| {
                let structure = &entry["effective_structure"];
                match structure["kind"].as_str() {
                    Some("field" | "metric") => structure["table"]["object_id"] == anchor,
                    Some("relationship") => {
                        structure["left_table"]["object_id"] == anchor
                            || structure["right_table"]["object_id"] == anchor
                    }
                    Some("query_example") => [
                        &structure["dependencies"],
                        &structure["verification"]["evidence_refs"],
                    ]
                    .iter()
                    .any(|references| {
                        references.as_array().is_some_and(|items| {
                            items
                                .iter()
                                .any(|reference| reference["object_id"] == anchor)
                        })
                    }),
                    _ => false,
                }
            })
}

fn matches_domain(entry: &Value, domain: &str) -> bool {
    if entry["path"] != "business_domain" || entry["effective_value"] != domain {
        return false;
    }
    if entry["human_override"].is_object() {
        return entry["review_state"] == "confirmed" && entry["human_override"]["value"] == domain;
    }
    let facts = &entry["source_facts"];
    !entry["suggestion"]["value"]
        .as_str()
        .is_some_and(|value| !value.is_empty())
        && facts["value"] == domain
        && facts["complete"] == true
        && matches!(
            facts["classification"].as_str(),
            Some("source_text" | "authored_definition")
        )
        && facts["source_id"].as_str().is_some_and(|id| !id.is_empty())
        && facts["version"].as_str().is_some_and(|version| {
            version.parse::<u64>().is_ok()
                && version.bytes().all(|byte| byte.is_ascii_digit())
                && (version == "0" || !version.starts_with('0'))
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn object() -> Value {
        json!({"id":"metric-sales","kind":"metric","related_ids":["table-purchases"],"entries":[{
            "path":"business_domain","effective_value":"合成零售","review_state":"unverified","human_override":null,"suggestion":{},
            "source_facts":{"value":"合成零售","classification":"authored_definition","complete":true,"source_id":"guide","version":"1"}
        }]})
    }
    #[test]
    fn default_scope_keeps_old_calls_and_scopes_are_combined() {
        let source = object();
        assert!(KnowledgeSearchScope::default().matches(&source));
        let scope=KnowledgeSearchScope::from_input(&json!({"query":"收入","kinds":["metric"],"related_object_id":"table-purchases","business_domain":"合成零售"})).unwrap();
        assert!(scope.matches(&source));
        assert!(
            !KnowledgeSearchScope {
                kinds: vec!["document".into()],
                ..scope.clone()
            }
            .matches(&source)
        );
        assert!(
            !KnowledgeSearchScope {
                anchor: Some("other-table".into()),
                ..scope.clone()
            }
            .matches(&source)
        );
        assert!(
            !KnowledgeSearchScope {
                domain: Some("其他业务".into()),
                ..scope
            }
            .matches(&source)
        );
    }
    #[test]
    fn domain_comes_from_an_explicit_valid_layer() {
        let scope = KnowledgeSearchScope {
            domain: Some("合成零售".into()),
            ..Default::default()
        };
        let mut source = object();
        assert!(scope.matches(&source));
        source["entries"][0]["suggestion"]["value"] = json!("合成零售");
        assert!(!scope.matches(&source));
        source["entries"][0]["human_override"] = json!({"value":"合成零售"});
        source["entries"][0]["review_state"] = json!("confirmed");
        assert!(scope.matches(&source));
        source["entries"][0]["review_state"] = json!("needs_review");
        assert!(!scope.matches(&source));
    }
    #[test]
    fn domain_is_exact_and_never_guessed_from_name_or_free_text() {
        let mut source = object();
        source["entries"][0]["path"] = json!("description");
        source["name"] = json!("合成零售");
        let scope = KnowledgeSearchScope {
            domain: Some("合成零售".into()),
            ..Default::default()
        };
        assert!(!scope.matches(&source));
        source["entries"][0]["path"] = json!("business_domain");
        assert!(
            !KnowledgeSearchScope {
                domain: Some("合成零售 ".into()),
                ..Default::default()
            }
            .matches(&source)
        );
    }
    #[test]
    fn anchor_can_use_an_effective_structural_reference() {
        let mut source = object();
        source["related_ids"] = json!([]);
        source["entries"][0]["effective_structure"] =
            json!({"kind":"metric","table":{"object_id":"table-purchases","version":"1"}});
        let scope = KnowledgeSearchScope {
            anchor: Some("table-purchases".into()),
            ..Default::default()
        };
        assert!(scope.matches(&source));
        source["entries"][0]["effective_structure"] = Value::Null;
        assert!(!scope.matches(&source));
    }
    #[test]
    fn query_example_anchor_matches_complete_dependencies_and_verification() {
        let mut source = object();
        source["kind"] = json!("query_example");
        source["related_ids"] = json!([]);
        source["entries"][0]["effective_structure"] = json!({"kind":"query_example",
            "dependencies":[{"object_id":"metric-lines","version":"1","path":"body"}],
            "verification":{"note":"核对粒度","evidence_refs":[{"object_id":"guide-grain","version":"2","path":"limits"}]}});
        for anchor in ["metric-lines", "guide-grain"] {
            let scope = KnowledgeSearchScope {
                anchor: Some(anchor.into()),
                ..Default::default()
            };
            assert!(scope.matches(&source));
        }
        let scope = KnowledgeSearchScope {
            anchor: Some("absent".into()),
            ..Default::default()
        };
        assert!(!scope.matches(&source));
    }
    #[test]
    fn scope_values_are_bound_and_never_become_sql() {
        let scope = KnowledgeSearchScope {
            domain: Some("x' OR true --".into()),
            anchor: Some("table-purchases".into()),
            kinds: vec!["metric".into()],
        };
        let mut sql = QueryBuilder::<MySql>::new("SELECT id FROM knowledge_objects WHERE true");
        scope.push_constraints(&mut sql, "id", "kind", "body");
        let statement = sql.sql();
        let statement = statement.as_str();
        assert!(!statement.contains("x' OR true --"));
        assert!(!statement.contains("table-purchases"));
        assert!(statement.contains("JSON_TABLE"));
    }
}
