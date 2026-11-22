mod store;

pub use store::{
    complete_members_in_tx, complete_selections_in_tx, dependent_spaces_in_tx, dependents_in_tx,
    effective_required_in_tx, has_dependents_in_tx, mapping_complete_in_tx, persist_in_tx,
    register_table_binding_in_tx, resolve_selection_in_tx, selected_contribution_roots_in_tx,
    selected_dependencies_in_tx, write_target_fingerprints_in_tx,
};

use crate::types::{Error, Result};
use serde_json::Value;
use std::collections::HashSet;

// 依赖索引与知识保存同事务：保存时从各层实际内容生成依赖行，读取按索引
// 批量/分页进行，不逐条装配完整对象。旧内容没有可映射来源时不生成行，
// 由读取侧按unknown处理，不得猜无依赖。
//
// 跨模块数据不在此处查询：目标内容指纹按登记修订的历史正文计算，平台来源
// 正文由组合层经ingestion公开读取后传入write_target_fingerprints_in_tx；
// 当前头与当前正文的传递核验（walk）同样由use_cases组合执行。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DependencyRow {
    pub owner_id: String,
    pub owner_version: u64,
    pub entry_path: String,
    pub layer: String,
    pub purpose: String,
    pub role: String,
    pub effective: bool,
    pub target_kind: String,
    pub target_id: String,
    pub target_revision: u64,
    pub target_path: String,
    pub target_fingerprint: String,
}

// 空path表示全对象；非空path由知识owner解析为规范条目路径后沿依赖链传递。
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct DependencySelection {
    pub object_id: String,
    pub version: u64,
    pub path: String,
}

impl From<(String, u64)> for DependencySelection {
    fn from((object_id, version): (String, u64)) -> Self {
        Self {
            object_id,
            version,
            path: String::new(),
        }
    }
}

// 目标相关内容：知识目标取登记路径的有效值（路径为空取全部有效条目），文档取
// 全部有效条目正文，平台来源取正文原文。粒度是整份相关内容；引用片段级指纹
// 属出处重绑定，无法可靠细分时按整份保守比较。
fn relevant_content(kind: &str, body: &Value, path: &str) -> String {
    let entries = body["entries"].as_array();
    match kind {
        "knowledge" if !path.is_empty() => entries
            .into_iter()
            .flatten()
            .find(|entry| {
                entry["path"].as_str() == Some(path) || entry["entry_id"].as_str() == Some(path)
            })
            .and_then(|entry| entry["effective_value"].as_str())
            .unwrap_or("")
            .to_owned(),
        "document" | "knowledge" => entries
            .into_iter()
            .flatten()
            .filter_map(|entry| entry["effective_value"].as_str())
            .collect::<Vec<_>>()
            .join("\n\n"),
        _ => body.as_str().unwrap_or("").to_owned(),
    }
}

// 目标相关内容指纹：指纹缺失（快照读不到或未填充）在读取侧按保守失效处理。
pub(crate) fn content_fingerprint(kind: &str, body: &Value, path: &str) -> String {
    crate::types::fingerprint(&serde_json::json!(relevant_content(kind, body, path)))
}

// 条目有效层沿用语义投影的优先级：人工确认优先，其次模型建议，最后来源事实。
fn effective_layer(entry: &Value, document: bool) -> &'static str {
    if document {
        "model_suggestion"
    } else if entry["human_override"].is_object() {
        "human_override"
    } else if entry["suggestion"]["value"].is_string() {
        "model_suggestion"
    } else {
        "source_fact"
    }
}

#[derive(Hash, PartialEq, Eq)]
struct DependencyKey {
    entry_path: String,
    layer: String,
    purpose: String,
    role: String,
    target_kind: String,
    target_id: String,
    target_revision: u64,
    target_path: String,
}

struct SourceTarget<'a> {
    kind: &'static str,
    id: &'a str,
    revision: u64,
}

struct DependencyCollector {
    owner_id: String,
    owner_version: u64,
    rows: Vec<DependencyRow>,
    seen: HashSet<DependencyKey>,
}

impl DependencyCollector {
    fn new(owner_id: String, owner_version: u64) -> Self {
        Self {
            owner_id,
            owner_version,
            rows: Vec::new(),
            seen: HashSet::new(),
        }
    }

    fn push(&mut self, mut row: DependencyRow) {
        row.owner_id = self.owner_id.clone();
        row.owner_version = self.owner_version;
        if self.seen.insert(DependencyKey {
            entry_path: row.entry_path.clone(),
            layer: row.layer.clone(),
            purpose: row.purpose.clone(),
            role: row.role.clone(),
            target_kind: row.target_kind.clone(),
            target_id: row.target_id.clone(),
            target_revision: row.target_revision,
            target_path: row.target_path.clone(),
        }) {
            self.rows.push(row);
        }
    }

    fn push_source(
        &mut self,
        entry_path: &str,
        layer: &str,
        effective: bool,
        role: &str,
        source: SourceTarget<'_>,
    ) {
        self.push(DependencyRow {
            owner_id: String::new(),
            owner_version: 0,
            entry_path: entry_path.to_owned(),
            layer: layer.to_owned(),
            purpose: "required".to_owned(),
            role: role.to_owned(),
            effective,
            target_kind: source.kind.to_owned(),
            target_id: source.id.to_owned(),
            target_revision: source.revision,
            target_path: String::new(),
            target_fingerprint: String::new(),
        });
    }

    // 必要知识引用按对象引用登记，目标修订即被引用对象版本；role区分支持、
    // 结构依赖与示例输出声明，它们都绑定知识对象修订并随改版受检。
    fn push_knowledge_reference(
        &mut self,
        entry_path: &str,
        layer: &str,
        effective: bool,
        role: &str,
        object_ref: &Value,
    ) {
        let Some(target) = object_ref["object_id"].as_str() else {
            return;
        };
        let Some(revision) = object_ref["version"]
            .as_str()
            .and_then(|value| value.parse::<u64>().ok())
        else {
            return;
        };
        self.push(DependencyRow {
            owner_id: String::new(),
            owner_version: 0,
            entry_path: entry_path.to_owned(),
            layer: layer.to_owned(),
            purpose: "required".to_owned(),
            role: role.to_owned(),
            effective,
            target_kind: "knowledge".to_owned(),
            target_id: target.to_owned(),
            target_revision: revision,
            target_path: object_ref["path"].as_str().unwrap_or("").to_owned(),
            target_fingerprint: String::new(),
        });
    }
}

// 从对象当前正文生成依赖行：来源事实的原始出处与结构化证据、模型建议的证据/
// 资料引用、各层陈述的原文引用与必要支持。引用按其所在层登记，
// 只有有效层行参与语义有效性；人工完全替换后的旧层行保留但不再有效；
// 同文确认（人工正文与自动层逐字相同）按人工层承载该层出处，来源保留。
// 同时给出整对象映射状态：有效层存在无映射来源的自动内容时为unknown，
// 人工内容与已映射内容都算complete；读取侧不得把unknown猜成已知无依赖。
pub struct ObjectDependencies {
    pub rows: Vec<DependencyRow>,
    pub complete: bool,
}

// 单条陈述的出处登记：citation与source支持绑定来源修订，knowledge支持绑定对象版本。
fn collect_statement_sources(
    collector: &mut DependencyCollector,
    entry_path: &str,
    row_layer: &str,
    effective: bool,
    statement: &Value,
) -> Result<()> {
    for citation in statement["citations"].as_array().into_iter().flatten() {
        collector.push_source(
            entry_path,
            row_layer,
            effective,
            "citation",
            citation_target(citation)?,
        );
    }
    for support in statement["supports"].as_array().into_iter().flatten() {
        let reference = &support["reference"];
        match reference["kind"].as_str() {
            Some("source") => {
                collector.push_source(
                    entry_path,
                    row_layer,
                    effective,
                    "support",
                    citation_target(&reference["citation"])?,
                );
            }
            Some("knowledge") => collector.push_knowledge_reference(
                entry_path,
                row_layer,
                effective,
                "support",
                &reference["ref"],
            ),
            _ => {}
        }
    }
    Ok(())
}

// 陈述完整文本（text＋scope_text，与建议层value拼接形态一致）逐字留在人工值中
// 才算未替换部分；只保留半句、改写或删掉都不携带旧出处。
fn statement_retained_verbatim(statement: &Value, human_text: &str) -> bool {
    let text = statement["text"].as_str().unwrap_or("");
    let scope = statement["scope_text"].as_str().unwrap_or("");
    let full = if scope.is_empty() {
        text.to_owned()
    } else {
        format!("{text}\n{scope}")
    };
    let trimmed = full.trim();
    !trimmed.is_empty() && human_text.contains(trimmed)
}

// 登记source_layer在正文里的来源引用，写入行的层为row_layer：常规登记两者相同，
// 同文确认时以自动层的引用集合按人工层登记为有效行。
fn collect_layer_sources(
    collector: &mut DependencyCollector,
    entry: &Value,
    entry_path: &str,
    row_layer: &str,
    source_layer: &str,
    effective: bool,
) -> Result<()> {
    match source_layer {
        "source_fact" => {
            if let Some(source) = legacy_source_target(&entry["source_facts"]) {
                collector.push_source(entry_path, row_layer, effective, "origin", source);
            }
            for reference in entry["source_facts"]["structured_evidence"]
                .as_array()
                .into_iter()
                .flatten()
            {
                if let Some(source) = legacy_source_target(reference) {
                    collector.push_source(entry_path, row_layer, effective, "evidence", source);
                }
            }
        }
        "model_suggestion" => {
            for (field, role) in [("material_refs", "material"), ("evidence", "evidence")] {
                for reference in entry["suggestion"][field].as_array().into_iter().flatten() {
                    if let Some(source) = legacy_source_target(reference) {
                        collector.push_source(entry_path, row_layer, effective, role, source);
                    }
                }
            }
        }
        _ => {}
    }
    for statement in entry[layer_field(source_layer)]["statements"]
        .as_array()
        .into_iter()
        .flatten()
    {
        collect_statement_sources(collector, entry_path, row_layer, effective, statement)?;
    }
    Ok(())
}

pub fn rows_for_object(object: &Value) -> Result<ObjectDependencies> {
    let owner_id = object["id"]
        .as_str()
        .ok_or(Error::new("invalid_input"))?
        .to_owned();
    let owner_version = object["version"]
        .as_str()
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or(Error::new("invalid_input"))?;
    let document = object["kind"] == "document";
    let mut collector = DependencyCollector::new(owner_id, owner_version);
    let mut complete = true;
    for entry in object["entries"].as_array().into_iter().flatten() {
        let entry_path = entry["path"].as_str().unwrap_or("").to_owned();
        let effective = effective_layer(entry, document);
        for layer in ["source_fact", "model_suggestion", "human_override"] {
            collect_layer_sources(
                &mut collector,
                entry,
                &entry_path,
                layer,
                layer,
                effective == layer,
            )?;
        }
        // 同文确认：人工正文与自动层逐字相同，出处仍是该层来源，按人工层登记为
        // 有效行（同文重存/仅确认保留来源）。局部替换：与整层文本不同，但逐字
        // 保留的陈述仍是未替换部分，其出处同样按人工层登记为有效行；整条提交
        // 不把局部修改误判为全部替换。
        if effective == "human_override" {
            let human_text = entry["human_override"]["value"]
                .as_str()
                .map(str::trim)
                .unwrap_or("");
            if !human_text.is_empty() {
                for (layer, field) in [
                    ("model_suggestion", "suggestion"),
                    ("source_fact", "source_facts"),
                ] {
                    if entry[field]["value"].as_str().map(str::trim) == Some(human_text) {
                        collect_layer_sources(
                            &mut collector,
                            entry,
                            &entry_path,
                            "human_override",
                            layer,
                            true,
                        )?;
                    } else {
                        for statement in entry[field]["statements"].as_array().into_iter().flatten()
                        {
                            if statement_retained_verbatim(statement, human_text) {
                                collect_statement_sources(
                                    &mut collector,
                                    &entry_path,
                                    "human_override",
                                    true,
                                    statement,
                                )?;
                            }
                        }
                    }
                }
            }
        }
        // 结构的知识引用与正文同层登记：query_example结构的dependencies是所依赖
        // 资料，computed_metrics只声明实际输出（过滤用指标不冒充输出）；两类引用
        // 都绑定知识对象修订，被引对象改版后随有效层行受检。人工层承载的结构
        // 同样登记，结构与正文必须同层，不借用底层结构。
        let structure = &entry["effective_structure"];
        for mut reference in super::structure::table_dependencies(structure) {
            reference["path"] = Value::String("ddl".to_owned());
            collector.push_knowledge_reference(
                &entry_path,
                effective,
                true,
                "table_binding",
                &reference,
            );
        }
        if structure["kind"] == "query_example" {
            for reference in structure["dependencies"]
                .as_array()
                .into_iter()
                .flatten()
                .chain(
                    structure["verification"]["evidence_refs"]
                        .as_array()
                        .into_iter()
                        .flatten(),
                )
            {
                collector.push_knowledge_reference(
                    &entry_path,
                    effective,
                    true,
                    "structure",
                    reference,
                );
            }
            for metric in structure["computed_metrics"]
                .as_array()
                .into_iter()
                .flatten()
            {
                collector.push_knowledge_reference(
                    &entry_path,
                    effective,
                    true,
                    "output_metric",
                    &metric["metric_ref"],
                );
            }
        }
        if effective != "human_override" {
            let effective_field = layer_field(effective);
            let has_content = entry[effective_field]["value"]
                .as_str()
                .is_some_and(|value| !value.trim().is_empty())
                || entry[effective_field]["statements"]
                    .as_array()
                    .is_some_and(|statements| !statements.is_empty());
            let mapped = collector
                .rows
                .iter()
                .any(|row| row.entry_path == entry_path && row.effective);
            // 有效层有自动内容却提取不到任何来源映射：如实记unknown，不猜无依赖。
            if has_content && !mapped {
                complete = false;
            }
        }
    }
    Ok(ObjectDependencies {
        rows: collector.rows,
        complete,
    })
}

fn layer_field(layer: &str) -> &str {
    match layer {
        "source_fact" => "source_facts",
        "model_suggestion" => "suggestion",
        _ => "human_override",
    }
}

fn citation_target(citation: &Value) -> Result<SourceTarget<'_>> {
    let source = &citation["source"];
    let id = source["id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or(Error::new("invalid_evidence"))?;
    let kind = match source["kind"].as_str() {
        Some("document") => "document",
        Some("platform") => "platform",
        _ => return Err(Error::new("invalid_evidence")),
    };
    let revision = citation["revision"]
        .as_str()
        .ok_or(Error::new("invalid_evidence"))?;
    Ok(SourceTarget {
        kind,
        id,
        revision: crate::types::epoch(revision)?,
    })
}

fn legacy_source_target(reference: &Value) -> Option<SourceTarget<'_>> {
    let id = reference["source_id"].as_str()?;
    let revision = reference["version"].as_str()?.parse().ok()?;
    let (kind, id) = match id.strip_prefix("document-") {
        Some(id) => ("document", id),
        None => ("platform", id),
    };
    (!id.is_empty()).then_some(SourceTarget { kind, id, revision })
}
