mod store;

pub use store::apply_preparation_in_tx;
pub(super) use store::persist_in_tx;

use serde_json::{Value, json};

// 陈述随有效层交付；自动整理文档只附加解释，不改写文档原文。
pub(super) fn project_object(object: &mut Value) {
    let object_id = object["id"].clone();
    let version = object["version"].clone();
    let document = object["kind"] == "document";
    // get_mut 不为proposal等外来形状补写entries:null；缺失键保持缺失。
    for entry in object
        .get_mut("entries")
        .and_then(Value::as_array_mut)
        .into_iter()
        .flatten()
    {
        let path = entry["path"].clone();
        for layer in ["source_facts", "suggestion", "human_override"] {
            for statement in entry
                .get_mut(layer)
                .and_then(|content| content.get_mut("statements"))
                .and_then(Value::as_array_mut)
                .into_iter()
                .flatten()
            {
                statement["object_ref"] =
                    json!({"object_id":object_id,"version":version,"path":path});
            }
        }
        let layer = if document {
            "suggestion"
        } else if entry["human_override"].is_object() {
            "human_override"
        } else if entry["suggestion"]["value"].is_string() {
            "suggestion"
        } else {
            "source_facts"
        };
        // 旧记录没有陈述时不补造来源或断言已整理。
        if entry["suggestion"].get("statements").is_some()
            || entry[layer].get("statements").is_some()
        {
            entry["statements"] = entry[layer]
                .get("statements")
                .cloned()
                .unwrap_or_else(|| json!([]));
        }
    }
    for relation in object
        .get_mut("semantic_relations")
        .and_then(Value::as_array_mut)
        .into_iter()
        .flatten()
    {
        relation["subject"]["version"] = version.clone();
    }
}
