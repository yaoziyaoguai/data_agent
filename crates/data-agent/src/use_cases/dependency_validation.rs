use crate::{
    modules::{
        ingestion, knowledge,
        knowledge::dependency_index::{
            DependencyRow, DependencySelection, complete_selections_in_tx,
            selected_dependencies_in_tx,
        },
    },
    persistence::AppTx,
    types::{Error, Result},
};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

// 传递核验结论：stale=已变化的依据（登记修订与当前修订不符，来源消失时当前修订为空），
// unknown=无法证明的链路成员（无映射状态的对象版本，不得当作已知无依赖）。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct StaleDependency {
    pub owner_id: String,
    pub entry_path: String,
    pub target_kind: String,
    pub target_id: String,
    pub registered_revision: u64,
    pub current_revision: Option<u64>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DependencyVerdict {
    pub stale: Vec<StaleDependency>,
    pub unknown: Vec<(String, u64)>,
}

// 当前目标正文：平台来源读当前内容，对象目标读enabled当前版。只在修订不匹配且行
// 带指纹时按需读取并缓存，避免干净路径搬运大正文。
async fn current_body_in_tx(
    tx: &mut AppTx<'_>,
    space: &str,
    kind: &str,
    id: &str,
    cache: &mut HashMap<(String, String), Option<Value>>,
) -> Result<Option<Value>> {
    if let Some(cached) = cache.get(&(kind.to_owned(), id.to_owned())) {
        return Ok(cached.clone());
    }
    let body = if kind == "platform" {
        ingestion::current_source_body_in_tx(tx, space, id)
            .await?
            .map(Value::String)
    } else {
        knowledge::enabled_body_in_tx(tx, id).await?
    };
    cache.insert((kind.to_owned(), id.to_owned()), body.clone());
    Ok(body)
}

// 有效必要依赖的传递游走：从根对象出发逐层批量读索引；来源类目标（platform/document）
// 与当前修订核对即止，知识类目标核对当前版本后继续下钻。A→B→S中S变化在本次调用内
// 立即可见，不等扇出作业更新B；已见(owner,version)不重复展开，环不会无限递归。
// 模块边界：索引与对象当前版本/正文分属knowledge与ingestion，传递核验按跨模块组合
// 在此执行，模块内不做兄弟查询。
pub async fn walk_required_in_tx(
    tx: &mut AppTx<'_>,
    space: &str,
    roots: &[(String, u64)],
) -> Result<DependencyVerdict> {
    let selections: Vec<_> = roots
        .iter()
        .cloned()
        .map(DependencySelection::from)
        .collect();
    walk_selected_required_in_tx(tx, space, &selections).await
}

pub async fn walk_selected_required_in_tx(
    tx: &mut AppTx<'_>,
    space: &str,
    roots: &[DependencySelection],
) -> Result<DependencyVerdict> {
    if roots.len() > 200 {
        return Err(Error::new("payload_limit"));
    }
    let mut verdict = DependencyVerdict::default();
    let mut visited: HashSet<_> = roots.iter().cloned().collect();
    let mut bodies: HashMap<(String, String), Option<Value>> = HashMap::new();
    let mut frontier = roots.to_vec();
    while !frontier.is_empty() {
        let mut mapped = Vec::new();
        for chunk in frontier.chunks(200) {
            let known = complete_selections_in_tx(tx, chunk).await?;
            for owner in chunk {
                if known.contains(owner) {
                    mapped.push(owner.clone());
                } else {
                    // 无状态行或unknown：链路无法证明，不得当作已知无依赖。
                    verdict
                        .unknown
                        .push((owner.object_id.clone(), owner.version));
                }
            }
        }
        let mut rows: Vec<DependencyRow> = Vec::new();
        for chunk in mapped.chunks(200) {
            rows.extend(selected_dependencies_in_tx(tx, chunk, Some("required")).await?);
        }
        let mut platform_ids = Vec::new();
        let mut object_ids = Vec::new();
        for row in &rows {
            match row.target_kind.as_str() {
                "platform" => platform_ids.push(row.target_id.clone()),
                _ => object_ids.push(row.target_id.clone()),
            }
        }
        platform_ids.dedup();
        object_ids.dedup();
        let mut current: HashMap<(String, String), Option<u64>> = HashMap::new();
        for (id, version) in ingestion::source_versions_in_tx(tx, space, &platform_ids).await? {
            current.insert(("platform".to_owned(), id), Some(version));
        }
        for (id, version) in knowledge::enabled_versions_in_tx(tx, &object_ids).await? {
            current.insert(("object".to_owned(), id), Some(version));
        }
        let mut next = Vec::new();
        for row in rows {
            if row.target_id == row.owner_id && row.target_kind == "document" {
                // 文档派生陈述引用自身文档是常态；自引不构成外部依据，同对象
                // 新旧修订由修订读取规则处理，否则文档改版后的重整理读取会永久失效。
                continue;
            }
            let kind = if row.target_kind == "platform" {
                "platform"
            } else {
                "object"
            };
            let live = current
                .get(&(kind.to_owned(), row.target_id.clone()))
                .cloned()
                .flatten();
            let mut valid = live == Some(row.target_revision);
            if !valid
                && !row.target_fingerprint.is_empty()
                && let Some(body) =
                    current_body_in_tx(tx, space, kind, &row.target_id, &mut bodies).await?
            {
                valid = knowledge::dependency_index::content_fingerprint(
                    &row.target_kind,
                    &body,
                    &row.target_path,
                ) == row.target_fingerprint;
            }
            if !valid {
                verdict.stale.push(StaleDependency {
                    owner_id: row.owner_id,
                    entry_path: row.entry_path,
                    target_kind: row.target_kind,
                    target_id: row.target_id,
                    registered_revision: row.target_revision,
                    current_revision: live,
                });
            } else if row.target_kind == "knowledge" {
                // 相关正文相同只证明这条边可复用，继续沿登记修订和规范条目核必要依赖。
                let selected = DependencySelection {
                    object_id: row.target_id.clone(),
                    version: row.target_revision,
                    path: row.target_path,
                };
                if let Some(target) =
                    knowledge::dependency_index::resolve_selection_in_tx(tx, &selected).await?
                {
                    if visited.insert(target.clone()) {
                        next.push(target);
                    }
                } else {
                    verdict.unknown.push((selected.object_id, selected.version));
                }
            }
        }
        frontier = next;
    }
    Ok(verdict)
}
