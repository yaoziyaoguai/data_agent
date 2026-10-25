use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EntryContent {
    pub text: String,
    pub structure: Value,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContentLayer {
    SourceFact,
    ModelSuggestion,
    HumanOverride,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DependencyPurpose {
    Required,
    Related,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DirectDependency {
    pub target: Value,
    pub purpose: DependencyPurpose,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ContentSelector {
    // 文本偏移和长度按 Unicode 字符计数，与 UTF-8 字节及 UTF-16 码元无关。
    TextRange { offset: usize, length: usize },
    StructurePath { path: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContentContribution {
    pub selector: ContentSelector,
    pub layer: ContentLayer,
    pub dependencies: Vec<DirectDependency>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContentProvenance {
    pub complete: bool,
    pub contributions: Vec<ContentContribution>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LayerContent {
    pub content: EntryContent,
    #[serde(default)]
    pub provenance: ContentProvenance,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct EntryLayers {
    pub source_fact: Option<LayerContent>,
    pub model_suggestion: Option<LayerContent>,
    pub human_override: Option<LayerContent>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DependencyUse {
    pub selector: ContentSelector,
    pub layer: ContentLayer,
    pub target: Value,
    pub purpose: DependencyPurpose,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DependencyProjection {
    pub complete: bool,
    pub required: Vec<DependencyUse>,
    pub contributions: Vec<DependencyUse>,
}

pub fn project_effective(layers: &EntryLayers) -> Result<DependencyProjection, &'static str> {
    let selected = layers
        .human_override
        .as_ref()
        .or(layers.model_suggestion.as_ref())
        .or(layers.source_fact.as_ref())
        .ok_or("missing_effective_content")?;
    let contributions: Vec<_> = selected
        .provenance
        .contributions
        .iter()
        .flat_map(|part| {
            part.dependencies.iter().map(|dependency| DependencyUse {
                selector: part.selector.clone(),
                layer: part.layer,
                target: dependency.target.clone(),
                purpose: dependency.purpose,
            })
        })
        .collect();
    Ok(DependencyProjection {
        complete: selected.provenance.complete,
        required: contributions
            .iter()
            .filter(|value| value.purpose == DependencyPurpose::Required)
            .cloned()
            .collect(),
        contributions,
    })
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RetainedTextRange {
    // 旧、新偏移和长度都按 Unicode 字符计数；映射可信性由宿主核实。
    pub previous_offset: usize,
    pub offset: usize,
    pub length: usize,
}

// 同文自动保留来源；其他编辑由宿主提供全部保留范围，空映射表示完整替换。
// 本函数只验证范围及内容相等，不能据此证明映射唯一，也不会搜索相似片段猜继承。
pub fn inherit_human_edit(
    previous: &LayerContent,
    next: EntryContent,
    retained_text: &[RetainedTextRange],
) -> Result<LayerContent, &'static str> {
    if !retained_text.is_empty() {
        let previous_text: Vec<_> = previous.content.text.chars().collect();
        let next_text: Vec<_> = next.text.chars().collect();
        for retained in retained_text {
            let previous_end = retained
                .previous_offset
                .checked_add(retained.length)
                .ok_or("invalid_retained_text_range")?;
            let next_end = retained
                .offset
                .checked_add(retained.length)
                .ok_or("invalid_retained_text_range")?;
            let previous_part = previous_text
                .get(retained.previous_offset..previous_end)
                .filter(|part| !part.is_empty())
                .ok_or("invalid_retained_text_range")?;
            let next_part = next_text
                .get(retained.offset..next_end)
                .ok_or("invalid_retained_text_range")?;
            if previous_part != next_part {
                return Err("invalid_retained_text_range");
            }
        }
    }
    let provenance = if previous.content == next {
        previous.provenance.clone()
    } else {
        let mut contributions = Vec::new();
        for part in &previous.provenance.contributions {
            match &part.selector {
                ContentSelector::TextRange { .. } if previous.content.text == next.text => {
                    contributions.push(part.clone());
                }
                ContentSelector::TextRange { offset, length } => {
                    let end = offset.checked_add(*length).ok_or("invalid_content_range")?;
                    for retained in retained_text {
                        let retained_end = retained
                            .previous_offset
                            .checked_add(retained.length)
                            .ok_or("invalid_retained_text_range")?;
                        let start = (*offset).max(retained.previous_offset);
                        let end = end.min(retained_end);
                        if start < end {
                            let mut mapped = part.clone();
                            mapped.selector = ContentSelector::TextRange {
                                offset: retained
                                    .offset
                                    .checked_add(start - retained.previous_offset)
                                    .ok_or("invalid_retained_text_range")?,
                                length: end - start,
                            };
                            contributions.push(mapped);
                        }
                    }
                }
                ContentSelector::StructurePath { path }
                    if previous
                        .content
                        .structure
                        .pointer(path)
                        .is_some_and(|value| Some(value) == next.structure.pointer(path)) =>
                {
                    contributions.push(part.clone());
                }
                ContentSelector::StructurePath { .. } => {}
            }
        }
        let inherited_text = !previous.content.text.is_empty()
            && (previous.content.text == next.text || !retained_text.is_empty());
        // 顶层 null 表示条目确实没有结构，不算继承；结构一旦非空，
        // 深相等（含空集合与 null 成员值）或部分成员保留都算仍继承未知来源的结构。
        let inherited_structure = !previous.content.structure.is_null()
            && !next.structure.is_null()
            && retains_structure_content(&previous.content.structure, &next.structure);
        ContentProvenance {
            complete: previous.provenance.complete || !(inherited_text || inherited_structure),
            contributions,
        }
    };
    Ok(LayerContent {
        content: next,
        provenance,
    })
}

// 判断 next 结构是否保留 previous 结构中的内容：值深相等即保留，
// 空集合成员（如 {"excluded":[]}）和 null 成员值（字段声明保留）同样是内容；
// 对象和数组在整体不等时按成员/元素部分保留。进入本函数前调用方已排除顶层 null。
fn retains_structure_content(previous: &Value, next: &Value) -> bool {
    if previous == next {
        return true;
    }
    match (previous, next) {
        (Value::Object(before), Value::Object(after)) => before.iter().any(|(key, value)| {
            after
                .get(key)
                .is_some_and(|next_value| retains_structure_content(value, next_value))
        }),
        (Value::Array(before), Value::Array(after)) => before
            .iter()
            .zip(after)
            .any(|(value, next_value)| retains_structure_content(value, next_value)),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn explained(text: &str) -> LayerContent {
        LayerContent {
            content: EntryContent {
                text: text.into(),
                structure: Value::Null,
            },
            provenance: ContentProvenance {
                complete: true,
                contributions: vec![ContentContribution {
                    selector: ContentSelector::TextRange {
                        offset: 0,
                        length: text.chars().count(),
                    },
                    layer: ContentLayer::ModelSuggestion,
                    dependencies: vec![DirectDependency {
                        target: json!({"source":{"kind":"document","id":"voice-rule"},"revision":"3","content_fingerprint":"definition-a"}),
                        purpose: DependencyPurpose::Required,
                    }],
                }],
            },
        }
    }

    #[test]
    fn replacing_the_definition_removes_old_sources_but_saving_same_text_keeps_them() {
        let previous = explained("只计成功语音轮次");
        let same = inherit_human_edit(&previous, previous.content.clone(), &[]).unwrap();
        assert_eq!(same.provenance, previous.provenance);

        let changed = inherit_human_edit(
            &previous,
            EntryContent {
                text: "人工定义：计全部语音轮次".into(),
                structure: Value::Null,
            },
            &[],
        )
        .unwrap();
        assert!(changed.provenance.complete);
        assert!(changed.provenance.contributions.is_empty());
    }

    #[test]
    fn editing_text_and_one_structure_member_keeps_only_the_other_members_source() {
        let mut previous = explained("按旧口径解释");
        previous.content.structure = json!({"formula":"SUM(duration)","grain":"utterance"});
        for (path, id) in [("/formula", "formula-rule"), ("/grain", "grain-rule")] {
            previous.provenance.contributions.push(ContentContribution {
                selector: ContentSelector::StructurePath { path: path.into() },
                layer: ContentLayer::ModelSuggestion,
                dependencies: vec![DirectDependency {
                    target: json!({"source":{"kind":"document","id":id},"revision":"1"}),
                    purpose: DependencyPurpose::Required,
                }],
            });
        }
        let changed = inherit_human_edit(
            &previous,
            EntryContent {
                text: "人工解释：累计语音时长".into(),
                structure: json!({"formula":"SUM(duration)","grain":"session"}),
            },
            &[],
        )
        .unwrap();
        assert_eq!(
            changed.provenance.contributions,
            vec![previous.provenance.contributions[1].clone()]
        );
        let replaced = inherit_human_edit(
            &changed,
            EntryContent {
                text: changed.content.text.clone(),
                structure: json!({"formula":"MAX(duration)","grain":"session"}),
            },
            &[],
        )
        .unwrap();
        assert!(replaced.provenance.complete);
        assert!(replaced.provenance.contributions.is_empty());
    }

    #[test]
    fn effective_projection_separates_required_from_related_without_reviving_old_layers() {
        let mut active = explained("语音阶段与计算口径");
        active.provenance.contributions[0].dependencies.push(DirectDependency {
            target: json!({"source":{"kind":"document","id":"shared-stage-definition"},"revision":"1"}),
            purpose: DependencyPurpose::Related,
        });
        let layers = EntryLayers {
            source_fact: Some(explained("已废弃的来源解释")),
            model_suggestion: Some(active.clone()),
            human_override: None,
        };
        let projection = project_effective(&layers).unwrap();
        assert!(projection.complete);
        assert_eq!(projection.required.len(), 1);
        assert_eq!(projection.contributions.len(), 2);
        assert_eq!(
            projection.contributions[1].target["source"]["id"],
            "shared-stage-definition"
        );
        assert_eq!(
            projection.contributions[1].purpose,
            DependencyPurpose::Related
        );

        let human = inherit_human_edit(
            &active,
            EntryContent {
                text: "独立人工口径".into(),
                structure: Value::Null,
            },
            &[],
        )
        .unwrap();
        let projection = project_effective(&EntryLayers {
            human_override: Some(human),
            ..layers
        })
        .unwrap();
        assert!(projection.complete);
        assert!(projection.required.is_empty());
        assert!(projection.contributions.is_empty());
    }

    #[test]
    fn missing_legacy_mapping_stays_unknown_when_unchanged_content_is_confirmed() {
        let previous: LayerContent = serde_json::from_value(json!({
            "content":{"text":"旧自动解释，来源尚未映射","structure":{"unit":"ms"}}
        }))
        .unwrap();
        assert!(!previous.provenance.complete);
        let confirmed = inherit_human_edit(&previous, previous.content.clone(), &[]).unwrap();
        assert!(!confirmed.provenance.complete);
        let structure_edit = inherit_human_edit(
            &previous,
            EntryContent {
                text: previous.content.text.clone(),
                structure: json!({"unit":"seconds"}),
            },
            &[],
        )
        .unwrap();
        assert!(
            !structure_edit.provenance.complete,
            "改结构不能把仍沿用的旧自动文本来源变成已知为空"
        );
        let independent = inherit_human_edit(
            &previous,
            EntryContent {
                text: "从头编写的人工规则".into(),
                structure: Value::Null,
            },
            &[],
        )
        .unwrap();
        assert!(independent.provenance.complete);
        assert!(independent.provenance.contributions.is_empty());
    }

    #[test]
    fn partial_text_edit_moves_only_the_proven_contribution_by_unicode_character_offsets() {
        let previous = explained("规则：成功😀计数；重试不计。");
        let edited = inherit_human_edit(
            &previous,
            EntryContent {
                text: "口径调整：成功😀计数；重试也计。".into(),
                structure: Value::Null,
            },
            &[RetainedTextRange {
                previous_offset: 3,
                offset: 5,
                length: 5,
            }],
        )
        .unwrap();

        let mut retained = previous.provenance.contributions[0].clone();
        retained.selector = ContentSelector::TextRange {
            offset: 5,
            length: 5,
        };
        assert_eq!(edited.provenance.contributions, vec![retained]);
        assert!(edited.provenance.complete);
    }

    #[test]
    fn keeping_structure_with_empty_or_null_members_does_not_flip_unknown_to_complete() {
        // 旧自动成果缺来源映射（complete=false）。人工仅重写正文、原样保留
        // 含空集合成员或 null 成员的结构时，结构仍是未知来源内容，不能变成已知无依赖。
        for structure in [
            json!({"excluded": []}),
            json!({"note": null}),
            json!({"note": null, "x": 1}),
        ] {
            let previous: LayerContent = serde_json::from_value(json!({
                "content": {"text": "旧自动解释，来源尚未映射", "structure": structure}
            }))
            .unwrap();
            assert!(!previous.provenance.complete);
            let edited = inherit_human_edit(
                &previous,
                EntryContent {
                    text: "人工重写的正文".into(),
                    structure: previous.content.structure.clone(),
                },
                &[],
            )
            .unwrap();
            assert!(
                !edited.provenance.complete,
                "原样保留的结构 {structure} 仍来自未知来源，不能翻成已知无依赖"
            );
        }

        // 局部修改时保留下来的 null 成员同样不能丢：note 保持 null 而 x 改写，
        // 正文也重写，但 note 声明仍是继承的未知结构内容。
        let previous: LayerContent = serde_json::from_value(json!({
            "content": {"text": "旧自动解释", "structure": {"note": null, "x": 1}}
        }))
        .unwrap();
        let edited = inherit_human_edit(
            &previous,
            EntryContent {
                text: "人工重写的正文".into(),
                structure: json!({"note": null, "x": 2}),
            },
            &[],
        )
        .unwrap();
        assert!(
            !edited.provenance.complete,
            "保留的 null 成员仍让该条目带未知来源结构"
        );
    }

    #[test]
    fn rewriting_text_of_an_entry_without_structure_becomes_complete() {
        // 顶层 null 表示条目确实没有结构；人工重写唯一正文后没有继承任何未知内容。
        let previous: LayerContent = serde_json::from_value(json!({
            "content": {"text": "旧自动解释，来源尚未映射", "structure": null}
        }))
        .unwrap();
        assert!(!previous.provenance.complete);
        let edited = inherit_human_edit(
            &previous,
            EntryContent {
                text: "从头编写的人工规则".into(),
                structure: Value::Null,
            },
            &[],
        )
        .unwrap();
        assert!(edited.provenance.complete);
        assert!(edited.provenance.contributions.is_empty());
    }

    #[test]
    fn invalid_retained_ranges_cannot_assert_inherited_source_content() {
        let previous = explained("来源甲😀");
        let next = EntryContent {
            text: "新稿乙😀".into(),
            structure: Value::Null,
        };
        for retained in [
            RetainedTextRange {
                previous_offset: 0,
                offset: 0,
                length: 0,
            },
            RetainedTextRange {
                previous_offset: 4,
                offset: 3,
                length: 1,
            },
            RetainedTextRange {
                previous_offset: 3,
                offset: 4,
                length: 1,
            },
            RetainedTextRange {
                previous_offset: 0,
                offset: 0,
                length: 1,
            },
            RetainedTextRange {
                previous_offset: usize::MAX,
                offset: 0,
                length: 1,
            },
            RetainedTextRange {
                previous_offset: 3,
                offset: usize::MAX,
                length: 1,
            },
        ] {
            assert_eq!(
                inherit_human_edit(&previous, next.clone(), &[retained]),
                Err("invalid_retained_text_range")
            );
        }
    }
}
