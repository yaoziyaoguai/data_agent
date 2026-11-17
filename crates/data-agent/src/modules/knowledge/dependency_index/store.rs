use super::{
    DependencyRow, DependencySelection, ObjectDependencies, content_fingerprint, rows_for_object,
};
use crate::{
    persistence::AppTx,
    types::{AccessContext, Error, Result},
};
use serde_json::Value;
use sqlx::Row;
use std::collections::{HashMap, HashSet, VecDeque};

// 多列占位符逐元组自带括号，调用方统一 IN ({list}) 只包外层：单项若不带内层括号，
// (a,b) IN (?,?) 会被MySQL当作两标量列表，报"Operand should contain 2 column(s)"。
fn placeholders(items: usize, columns: usize) -> String {
    if columns == 1 {
        return vec!["?"; items].join(",");
    }
    std::iter::repeat_n(format!("({})", vec!["?"; columns].join(",")), items)
        .collect::<Vec<_>>()
        .join(",")
}

// 保存路径：同事务重建该(owner,version)的依赖行（DELETE+INSERT，历史版本行保留）。
// 目标相关内容指纹不在写入时填充——平台来源正文归ingestion，由组合层读取后经
// write_target_fingerprints_in_tx补记；未补记的行按指纹缺失的保守语义处理。
pub async fn persist_in_tx(tx: &mut AppTx<'_>, ctx: &AccessContext, object: &Value) -> Result<()> {
    let owner_id = object["id"].as_str().ok_or(Error::new("invalid_input"))?;
    let version = object["version"]
        .as_str()
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or(Error::new("invalid_input"))?;
    let indexed: ObjectDependencies = rows_for_object(object)?;
    sqlx::query("DELETE FROM knowledge_dependencies WHERE owner_id=? AND owner_version=?")
        .bind(owner_id)
        .bind(version)
        .execute(tx.connection())
        .await?;
    sqlx::query("DELETE FROM knowledge_dependency_states WHERE owner_id=? AND owner_version=?")
        .bind(owner_id)
        .bind(version)
        .execute(tx.connection())
        .await?;
    for row in indexed.rows {
        sqlx::query("INSERT IGNORE INTO knowledge_dependencies(owner_id,owner_version,space_id,entry_path,layer,purpose,role,effective,target_kind,target_id,target_revision,target_path,target_fingerprint) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
            .bind(&row.owner_id)
            .bind(row.owner_version)
            .bind(&ctx.space_id)
            .bind(&row.entry_path)
            .bind(&row.layer)
            .bind(&row.purpose)
            .bind(&row.role)
            .bind(row.effective)
            .bind(&row.target_kind)
            .bind(&row.target_id)
            .bind(row.target_revision)
            .bind(&row.target_path)
            .bind(&row.target_fingerprint)
            .execute(tx.connection())
            .await?;
    }
    sqlx::query("INSERT INTO knowledge_dependency_states(owner_id,owner_version,space_id,mapping_state) VALUES(?,?,?,?)")
        .bind(owner_id)
        .bind(version)
        .bind(&ctx.space_id)
        .bind(if indexed.complete {
            "complete"
        } else {
            "unknown"
        })
        .execute(tx.connection())
        .await?;
    Ok(())
}

// 补记目标相关内容指纹：平台正文由调用方按登记修订读入；文档/知识优先同版
// current，再精确回退旧档。读不到正文的对保留空指纹，读取侧保守失效，不猜空。
pub async fn write_target_fingerprints_in_tx(
    tx: &mut AppTx<'_>,
    rows: &[DependencyRow],
    platform_bodies: &HashMap<(String, u64), String>,
) -> Result<()> {
    let mut seen = HashSet::new();
    let mut object_pairs: Vec<(String, u64)> = Vec::new();
    for row in rows {
        if !seen.insert((
            row.target_kind.clone(),
            row.target_id.clone(),
            row.target_revision,
        )) {
            continue;
        }
        if row.target_kind != "platform" {
            object_pairs.push((row.target_id.clone(), row.target_revision));
        }
    }
    let mut object_contents: HashMap<(String, u64), Value> = HashMap::new();
    for chunk in object_pairs.chunks(200) {
        if chunk.is_empty() {
            continue;
        }
        let tuple_list = placeholders(chunk.len(), 2);
        let mut query = sqlx::query(sqlx::AssertSqlSafe(format!(
            "SELECT id AS object_id,version,body FROM knowledge_objects WHERE (id,version) IN ({tuple_list}) \
             UNION ALL SELECT v.object_id,v.version,v.body FROM knowledge_versions v \
             WHERE (v.object_id,v.version) IN ({tuple_list}) AND NOT EXISTS \
             (SELECT 1 FROM knowledge_objects k WHERE k.id=v.object_id AND k.version=v.version)"
        )));
        for _ in 0..2 {
            for (id, revision) in chunk {
                query = query.bind(id).bind(revision);
            }
        }
        for record in query.fetch_all(tx.connection()).await? {
            object_contents.insert(
                (
                    record.get::<String, _>("object_id"),
                    record.get::<u64, _>("version"),
                ),
                record.get::<sqlx::types::Json<Value>, _>("body").0,
            );
        }
    }
    for row in rows {
        let fingerprint = if row.target_kind == "platform" {
            platform_bodies
                .get(&(row.target_id.clone(), row.target_revision))
                .map(|body| {
                    content_fingerprint(
                        &row.target_kind,
                        &Value::String(body.clone()),
                        &row.target_path,
                    )
                })
        } else {
            object_contents
                .get(&(row.target_id.clone(), row.target_revision))
                .map(|body| content_fingerprint(&row.target_kind, body, &row.target_path))
        };
        let Some(fingerprint) = fingerprint else {
            continue;
        };
        sqlx::query(
            "UPDATE knowledge_dependencies SET target_fingerprint=? WHERE owner_id=? AND owner_version=? AND entry_path=? AND layer=? AND purpose=? AND role=? AND target_kind=? AND target_id=? AND target_revision=? AND target_path=?",
        )
        .bind(&fingerprint)
        .bind(&row.owner_id)
        .bind(row.owner_version)
        .bind(&row.entry_path)
        .bind(&row.layer)
        .bind(&row.purpose)
        .bind(&row.role)
        .bind(&row.target_kind)
        .bind(&row.target_id)
        .bind(row.target_revision)
        .bind(&row.target_path)
        .execute(tx.connection())
        .await?;
    }
    Ok(())
}

// 保存侧的存在性判定：按反向索引一次查询确认是否有有效依赖行指向该对象。
// 文档对象与知识对象的目标身份不同（document-前缀拆分），保存方据此登记扇出。
pub async fn has_dependents_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    kind: &str,
    object_id: &str,
) -> Result<bool> {
    let target_kind = if kind == "document" {
        "document"
    } else {
        "knowledge"
    };
    let row = sqlx::query(
        "SELECT 1 FROM knowledge_dependencies WHERE space_id=? AND target_kind=? AND target_id=? AND effective=1 LIMIT 1",
    )
    .bind(&ctx.space_id)
    .bind(target_kind)
    .bind(object_id)
    .fetch_optional(tx.connection())
    .await?;
    Ok(row.is_some())
}

// 反向依赖查询：按目标身份分页返回依赖者引用，不装配对象正文。
// limit 是每页(owner,version)对数上限：同一owner可有大量版本行，只按owner推进会跳过
// 其余版本；同一对又可有多行指向同一目标（不同entry_path/role），按行分页会把并列行
// 截断在页界后整组跳过。先按对取页、再整批取回页内对的全部行，两类丢失都结构性排除。
pub struct Dependent {
    pub owner_id: String,
    pub owner_version: u64,
    pub entry_path: String,
    pub layer: String,
    pub purpose: String,
    pub role: String,
    pub effective: bool,
}

pub async fn dependents_in_tx(
    tx: &mut AppTx<'_>,
    space: &str,
    kind: &str,
    id: &str,
    after: Option<(&str, u64)>,
    limit: u64,
) -> Result<Vec<Dependent>> {
    if !(1..=200).contains(&limit) {
        return Err(Error::new("invalid_input"));
    }
    let (cursor_owner, cursor_version, condition) = match after {
        Some((owner, version)) => (
            owner.to_owned(),
            version,
            "AND (owner_id,owner_version)>(?,?)",
        ),
        None => (String::new(), 0, ""),
    };
    let mut pair_query = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT DISTINCT owner_id,owner_version FROM knowledge_dependencies WHERE space_id=? AND target_kind=? AND target_id=? {condition} ORDER BY owner_id,owner_version LIMIT ?"
    )))
    .bind(space)
    .bind(kind)
    .bind(id);
    if after.is_some() {
        pair_query = pair_query.bind(&cursor_owner).bind(cursor_version);
    }
    let pairs: Vec<(String, u64)> = pair_query
        .bind(limit)
        .fetch_all(tx.connection())
        .await?
        .iter()
        .map(|row| {
            (
                row.get::<String, _>("owner_id"),
                row.get::<u64, _>("owner_version"),
            )
        })
        .collect();
    if pairs.is_empty() {
        return Ok(Vec::new());
    }
    // 对集合已按目标筛过，但同一对还会登记指向其他目标的行，取行时保留目标过滤。
    let tuple_list = placeholders(pairs.len(), 2);
    let mut row_query = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT owner_id,owner_version,entry_path,layer,purpose,role,effective FROM knowledge_dependencies WHERE space_id=? AND target_kind=? AND target_id=? AND (owner_id,owner_version) IN ({tuple_list}) ORDER BY owner_id,owner_version,entry_path,layer,purpose,role"
    )))
    .bind(space)
    .bind(kind)
    .bind(id);
    for (owner, version) in &pairs {
        row_query = row_query.bind(owner).bind(*version);
    }
    let rows = row_query.fetch_all(tx.connection()).await?;
    Ok(rows
        .iter()
        .map(|row| Dependent {
            owner_id: row.get("owner_id"),
            owner_version: row.get("owner_version"),
            entry_path: row.get("entry_path"),
            layer: row.get("layer"),
            purpose: row.get("purpose"),
            role: row.get("role"),
            effective: row.get("effective"),
        })
        .collect())
}

// 目标被依赖的全部空间：扇出作业不携带空间，依赖行自己登记了空间。
pub async fn dependent_spaces_in_tx(
    tx: &mut AppTx<'_>,
    kind: &str,
    id: &str,
) -> Result<Vec<String>> {
    let spaces: Vec<String> = sqlx::query(
        "SELECT DISTINCT space_id FROM knowledge_dependencies WHERE target_kind=? AND target_id=?",
    )
    .bind(kind)
    .bind(id)
    .fetch_all(tx.connection())
    .await?
    .iter()
    .map(|row| row.get("space_id"))
    .collect();
    Ok(spaces)
}

// 有效必要依赖：按(owner,version)批量读取，供传递核验立即发现依据变化。
// 游走会被持锁事务（交付前重核等）调用，这里保持单次往返，不逐owner展开。
pub async fn effective_required_in_tx(
    tx: &mut AppTx<'_>,
    owners: &[(String, u64)],
) -> Result<Vec<DependencyRow>> {
    effective_dependencies_in_tx(tx, owners, Some("required")).await
}

// 有效依赖批量读取；purpose为None时读全部用途（实际贡献根不能只取required）。
// 用途值是内部常量，不拼调用方输入。
pub(super) async fn effective_dependencies_in_tx(
    tx: &mut AppTx<'_>,
    owners: &[(String, u64)],
    purpose: Option<&str>,
) -> Result<Vec<DependencyRow>> {
    if owners.is_empty() {
        return Ok(Vec::new());
    }
    if owners.len() > 200 {
        return Err(Error::new("payload_limit"));
    }
    let tuple_list = placeholders(owners.len(), 2);
    let purpose_filter = purpose
        .map(|value| format!(" AND purpose='{value}'"))
        .unwrap_or_default();
    let mut query = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT owner_id,owner_version,entry_path,layer,purpose,role,target_kind,target_id,target_revision,target_path,target_fingerprint FROM knowledge_dependencies WHERE (owner_id,owner_version) IN ({tuple_list}) AND effective{purpose_filter}"
    )));
    for (owner, version) in owners {
        query = query.bind(owner).bind(version);
    }
    let fetched = query.fetch_all(tx.connection()).await?;
    Ok(fetched
        .iter()
        .map(|row| DependencyRow {
            owner_id: row.get("owner_id"),
            owner_version: row.get("owner_version"),
            entry_path: row.get("entry_path"),
            layer: row.get("layer"),
            purpose: row.get("purpose"),
            role: row.get("role"),
            effective: true,
            target_kind: row.get("target_kind"),
            target_id: row.get("target_id"),
            target_revision: row.get("target_revision"),
            target_path: row.get("target_path"),
            target_fingerprint: row
                .get::<Option<String>, _>("target_fingerprint")
                .unwrap_or_default(),
        })
        .collect())
}

// 旧引用允许entry_id；游走前按其登记修订解析为索引中的规范path。
pub async fn resolve_selection_in_tx(
    tx: &mut AppTx<'_>,
    selection: &DependencySelection,
) -> Result<Option<DependencySelection>> {
    if selection.path.is_empty() {
        return Ok(Some(selection.clone()));
    }
    let indexed = sqlx::query_scalar::<_,i64>("SELECT EXISTS(SELECT 1 FROM knowledge_dependencies WHERE owner_id=? AND owner_version=? AND entry_path=?)")
        .bind(&selection.object_id).bind(selection.version).bind(&selection.path).fetch_one(tx.connection()).await? != 0;
    if indexed {
        return Ok(Some(selection.clone()));
    }
    let paths = sqlx::query_scalar::<_,String>("SELECT DISTINCT JSON_UNQUOTE(JSON_EXTRACT(e,'$.path')) FROM (SELECT body FROM knowledge_objects WHERE id=? AND version=? UNION ALL SELECT body FROM knowledge_versions WHERE object_id=? AND version=?) o,JSON_TABLE(o.body,'$.entries[*]' COLUMNS(e JSON PATH '$')) j WHERE BINARY JSON_UNQUOTE(JSON_EXTRACT(e,'$.path'))=BINARY ? OR BINARY JSON_UNQUOTE(JSON_EXTRACT(e,'$.entry_id'))=BINARY ?")
        .bind(&selection.object_id).bind(selection.version).bind(&selection.object_id).bind(selection.version)
        .bind(&selection.path).bind(&selection.path).fetch_all(tx.connection()).await?;
    Ok(if paths.len() == 1 {
        Some(DependencySelection {
            path: paths[0].clone(),
            ..selection.clone()
        })
    } else {
        None
    })
}

// 选中范围保留在索引读取中，不能把同对象另一个条目的依赖带进来。
pub async fn selected_dependencies_in_tx(
    tx: &mut AppTx<'_>,
    selections: &[DependencySelection],
    purpose: Option<&str>,
) -> Result<Vec<DependencyRow>> {
    let owners: Vec<_> = selections
        .iter()
        .map(|s| (s.object_id.clone(), s.version))
        .collect();
    let rows = effective_dependencies_in_tx(tx, &owners, purpose).await?;
    Ok(rows
        .into_iter()
        .filter(|row| {
            selections.iter().any(|s| {
                s.object_id == row.owner_id
                    && s.version == row.owner_version
                    && (s.path.is_empty() || s.path == row.entry_path)
            })
        })
        .collect())
}

pub async fn complete_selections_in_tx(
    tx: &mut AppTx<'_>,
    selections: &[DependencySelection],
) -> Result<HashSet<DependencySelection>> {
    if selections.is_empty() {
        return Ok(HashSet::new());
    }
    let owners: Vec<_> = selections
        .iter()
        .map(|s| (s.object_id.clone(), s.version))
        .collect();
    let complete = complete_members_in_tx(tx, &owners).await?;
    Ok(selections
        .iter()
        .filter(|selection| complete.contains(&(selection.object_id.clone(), selection.version)))
        .cloned()
        .collect())
}

// 仅对触及的旧结构补记已证原DDL，不改条目正文、修订或原操作身份。
pub async fn register_table_binding_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &Value,
    entry: &Value,
    reference: &Value,
    fingerprint: &str,
) -> Result<()> {
    sqlx::query("INSERT INTO knowledge_dependencies(owner_id,owner_version,space_id,entry_path,layer,purpose,role,effective,target_kind,target_id,target_revision,target_path,target_fingerprint) SELECT o.id,o.version,o.space_id,JSON_UNQUOTE(JSON_EXTRACT(e,'$.path')),CASE WHEN JSON_TYPE(JSON_EXTRACT(e,'$.human_override'))='OBJECT' THEN 'human_override' WHEN JSON_TYPE(JSON_EXTRACT(e,'$.suggestion.value'))='STRING' THEN 'model_suggestion' ELSE 'source_fact' END,'required','table_binding',1,'knowledge',?,?,'ddl',? FROM knowledge_objects o,JSON_TABLE(o.body,'$.entries[*]' COLUMNS(e JSON PATH '$')) j WHERE o.id=? AND o.version=? AND o.space_id=? AND BINARY JSON_UNQUOTE(JSON_EXTRACT(e,'$.path'))=BINARY ? ON DUPLICATE KEY UPDATE target_fingerprint=IF(target_fingerprint='',VALUES(target_fingerprint),target_fingerprint)")
        .bind(reference["object_id"].as_str().unwrap_or(""))
        .bind(crate::types::epoch(reference["version"].as_str().unwrap_or(""))?).bind(fingerprint)
        .bind(object["id"].as_str().unwrap_or("")).bind(crate::types::epoch(object["version"].as_str().unwrap_or(""))?)
        .bind(&ctx.space_id).bind(entry["path"].as_str().unwrap_or(""))
        .execute(tx.connection()).await?;
    Ok(())
}

// 单个(owner,version)的映射是否完备；缺行或unknown都返回false，读取侧不得猜。
pub async fn mapping_complete_in_tx(tx: &mut AppTx<'_>, owner: &(String, u64)) -> Result<bool> {
    let state: Option<String> =
        sqlx::query("SELECT mapping_state FROM knowledge_dependency_states WHERE owner_id=? AND owner_version=?")
            .bind(&owner.0)
            .bind(owner.1)
            .fetch_optional(tx.connection())
            .await?
            .map(|row| row.get("mapping_state"));
    Ok(state.as_deref() == Some("complete"))
}

// 批量查映射状态，返回状态为complete的(owner,version)集合；缺行或unknown不在集合内。
// 占位符列表只拼"?"，成员身份全部走绑定参数。
pub async fn complete_members_in_tx(
    tx: &mut AppTx<'_>,
    chunk: &[(String, u64)],
) -> Result<HashSet<(String, u64)>> {
    let tuple_list = placeholders(chunk.len(), 2);
    let mut query = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT owner_id,owner_version,mapping_state FROM knowledge_dependency_states WHERE (owner_id,owner_version) IN ({tuple_list})"
    )));
    for (owner, version) in chunk {
        query = query.bind(owner).bind(version);
    }
    Ok(query
        .fetch_all(tx.connection())
        .await?
        .iter()
        .filter(|row| row.get::<String, _>("mapping_state") == "complete")
        .map(|row| {
            (
                row.get::<String, _>("owner_id"),
                row.get::<u64, _>("owner_version"),
            )
        })
        .collect())
}

// 实际贡献根：根对象有效内容实际依赖的来源身份闭包，供权限/模型端点/用户明确
// 来源限制核验（组合层构造允许集后由其判定）。与失效游走的差别：贡献是按登记
// 修订的历史事实——来源身份不因后来改版或扇出滞后消失，也不与当前修订核对；
// 文档派生陈述引用自身文档即以该文档为根（A原文以A为来源）；人工替换后的旧
// source标签在非有效层，不进入闭包。任何用途的有效行都计入，不能只取required。
pub struct ContributionRoots {
    pub owner_id: String,
    pub owner_version: u64,
    // (kind,id)去重升序，kind∈platform|document，与SourceKey身份一致。
    pub sources: Vec<(String, String)>,
    // 闭包经停的不可证明成员（无状态行或unknown）。非空时闭包不完整，sources只是
    // 已知部分，调用方必须按不通过处理，不得当空集合或已核验放行。
    pub unknown: Vec<(String, u64)>,
}

pub async fn contribution_roots_in_tx(
    tx: &mut AppTx<'_>,
    roots: &[(String, u64)],
) -> Result<Vec<ContributionRoots>> {
    let selections: Vec<_> = roots
        .iter()
        .cloned()
        .map(DependencySelection::from)
        .collect();
    selected_contribution_roots_in_tx(tx, &selections).await
}

pub async fn selected_contribution_roots_in_tx(
    tx: &mut AppTx<'_>,
    roots: &[DependencySelection],
) -> Result<Vec<ContributionRoots>> {
    if roots.is_empty() {
        return Ok(Vec::new());
    }
    if roots.len() > 200 {
        return Err(Error::new("payload_limit"));
    }
    // 先按(owner,version)节点批量展开整图：mapped节点带有效行，unknown节点无行可读。
    let mut sources_by_node: HashMap<DependencySelection, Vec<(String, String)>> = HashMap::new();
    let mut edges: HashMap<DependencySelection, Vec<DependencySelection>> = HashMap::new();
    let mut unknown_nodes = HashSet::new();
    let mut visited: HashSet<_> = roots.iter().cloned().collect();
    let mut frontier = roots.to_vec();
    while !frontier.is_empty() {
        let mut mapped = Vec::new();
        for chunk in frontier.chunks(200) {
            let complete = complete_selections_in_tx(tx, chunk).await?;
            for node in chunk {
                if complete.contains(node) {
                    mapped.push(node.clone());
                } else {
                    unknown_nodes.insert(node.clone());
                }
            }
        }
        let mut rows = Vec::new();
        for chunk in mapped.chunks(200) {
            rows.extend(selected_dependencies_in_tx(tx, chunk, None).await?);
        }
        let mut next = Vec::new();
        for row in rows {
            for node in mapped.iter().filter(|s| {
                s.object_id == row.owner_id
                    && s.version == row.owner_version
                    && (s.path.is_empty() || s.path == row.entry_path)
            }) {
                match row.target_kind.as_str() {
                    "knowledge" => {
                        let target = DependencySelection {
                            object_id: row.target_id.clone(),
                            version: row.target_revision,
                            path: row.target_path.clone(),
                        };
                        let target = match resolve_selection_in_tx(tx, &target).await? {
                            Some(target) => target,
                            None => {
                                unknown_nodes.insert(target.clone());
                                visited.insert(target.clone());
                                target
                            }
                        };
                        if target != *node {
                            edges.entry(node.clone()).or_default().push(target);
                        }
                    }
                    "platform" | "document" => {
                        sources_by_node
                            .entry(node.clone())
                            .or_default()
                            .push((row.target_kind.clone(), row.target_id.clone()));
                    }
                    _ => {}
                }
            }
        }
        for target in edges.values().flatten() {
            if visited.insert(target.clone()) {
                next.push(target.clone());
            }
        }
        next.sort();
        next.dedup();
        frontier = next;
    }
    // 逐根在内存图上取闭包，批量根一次查询摊平图展开；经停unknown即中断该路径并记录。
    let mut results = Vec::new();
    for root in roots {
        let (mut sources, mut unknown) = (HashSet::new(), Vec::new());
        let mut seen = HashSet::from([root.clone()]);
        let mut queue = VecDeque::from([root.clone()]);
        while let Some(node) = queue.pop_front() {
            if unknown_nodes.contains(&node) {
                unknown.push((node.object_id, node.version));
                continue;
            }
            for source in sources_by_node.get(&node).into_iter().flatten() {
                sources.insert(source.clone());
            }
            for target in edges.get(&node).into_iter().flatten() {
                if seen.insert(target.clone()) {
                    queue.push_back(target.clone());
                }
            }
        }
        unknown.sort();
        unknown.dedup();
        let mut list = sources.into_iter().collect::<Vec<_>>();
        list.sort();
        list.dedup();
        results.push(ContributionRoots {
            owner_id: root.object_id.clone(),
            owner_version: root.version,
            sources: list,
            unknown,
        });
    }
    Ok(results)
}
