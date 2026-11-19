use crate::{
    contracts,
    modules::{
        analysis, assets, conversations, ingestion, knowledge,
        knowledge::dependency_index::{ContributionRoots, contribution_roots_in_tx},
        queries,
    },
    persistence::AppTx,
    types::{AccessContext, Error, Result, epoch},
};
use serde_json::{Value, json};

// 本轮消息绑定任务声明的来源允许集。None表示本轮未声明限制：不设门，
// 共享定义与无限制浏览行为不变（限制是独立于检索范围的来源允许层，
// 不进KnowledgeSearchScope——scope描述去哪找，gate裁决能不能作为依据交付）。
#[derive(Clone)]
pub(super) struct SourceGate {
    allowed: Vec<(String, String)>,
    limits: Value,
}

impl SourceGate {
    fn member(&self, kind: &str, id: &str) -> bool {
        self.allowed.iter().any(|(k, i)| k == kind && i == id)
    }

    // 范围的集合含义视图：仅按(kind,id)集合比较，顺序与origin_message_ids不参与。
    // 正式写入允许重复项，等价集合不能因重复被当成不同范围。
    pub fn allowed_keys(&self) -> Vec<(String, String)> {
        let mut keys = self.allowed.clone();
        keys.sort();
        keys.dedup();
        keys
    }

    // read_source参数用稳定来源身份：document-前缀或平台source_id。
    pub fn allows_source_arg(&self, source_id: &str) -> bool {
        match source_id.strip_prefix("document-") {
            Some(id) => self.member("document", id),
            None => self.member("platform", source_id),
        }
    }

    pub fn assert_source_arg(&self, source_id: &str) -> Result<()> {
        if self.allows_source_arg(source_id) {
            Ok(())
        } else {
            Err(Error::new("source_not_allowed"))
        }
    }

    // 文档是允许来源时整体可读：限制跟稳定来源身份走，用户允许的是该文档
    // 当前修订的全部内容；其余对象按贡献根闭包判定。
    fn object_allowed(&self, object: &Value, roots: Option<&ContributionRoots>) -> bool {
        if object["kind"] == "document"
            && object["id"]
                .as_str()
                .is_some_and(|id| self.member("document", id))
        {
            return true;
        }
        // 空根是独立人工内容，不因“空集是任意集合子集”放行；unknown非空
        // 按闭包不完整拒绝；可核验且完整时须全部落在允许集内。
        roots.is_some_and(|roots| {
            roots.unknown.is_empty()
                && !roots.sources.is_empty()
                && roots.sources.iter().all(|(kind, id)| self.member(kind, id))
        })
    }

    fn roots_of(object: &Value) -> Option<(String, u64)> {
        Some((
            object["id"].as_str()?.to_owned(),
            epoch(object["version"].as_str()?).ok()?,
        ))
    }

    pub async fn allows_object_in_tx(&self, tx: &mut AppTx<'_>, object: &Value) -> Result<bool> {
        let Some(root) = Self::roots_of(object) else {
            return Ok(false);
        };
        let roots = contribution_roots_in_tx(tx, &[root]).await?;
        Ok(self.object_allowed(object, roots.first()))
    }

    pub async fn assert_selection_in_tx(
        &self,
        tx: &mut AppTx<'_>,
        object: &Value,
        path: &str,
    ) -> Result<()> {
        let (object_id, version) =
            Self::roots_of(object).ok_or(Error::new("source_not_allowed"))?;
        let selection = knowledge::dependency_index::DependencySelection {
            object_id,
            version,
            path: path.to_owned(),
        };
        let roots =
            knowledge::dependency_index::selected_contribution_roots_in_tx(tx, &[selection])
                .await?;
        if self.object_allowed(object, roots.first()) {
            Ok(())
        } else {
            Err(Error::new("source_not_allowed"))
        }
    }

    // 检索候选批量判定：一次闭包查询摊平全部候选的贡献根，返回保留的下标
    // 与被过滤数量。身份或版本读不出的候选按不可判据处理。
    pub async fn filter_objects_in_tx(
        &self,
        tx: &mut AppTx<'_>,
        objects: &[Value],
    ) -> Result<(Vec<usize>, usize)> {
        let roots = objects
            .iter()
            .filter_map(Self::roots_of)
            .collect::<Vec<_>>();
        let resolved = if roots.is_empty() {
            Vec::new()
        } else {
            contribution_roots_in_tx(tx, &roots).await?
        };
        let mut kept = Vec::new();
        let mut filtered = 0usize;
        for (index, object) in objects.iter().enumerate() {
            let own = Self::roots_of(object)
                .and_then(|(id, _)| resolved.iter().find(|roots| roots.owner_id == id));
            if self.object_allowed(object, own) {
                kept.push(index);
            } else {
                filtered += 1;
            }
        }
        Ok((kept, filtered))
    }

    pub fn receipt(&self, filtered_candidates: usize) -> Value {
        json!({
            "allowed_sources": self.limits["allowed_sources"],
            "filtered_candidates": filtered_candidates,
        })
    }
}

// 解析本轮受限读取实际生效的来源门。门跟会话持久活动任务走：缺task_ref的读取
// 继承真正活动任务，不绕过限制；不同来源限制的任务不取并集，一次只按活动任务
// 的当前条件判定。迁移前无活动绑定的旧消息回退到消息绑定集保守判定。
pub(super) async fn resolve_in_tx(
    tx: &mut AppTx<'_>,
    locked: &conversations::LockedConversation,
    message_id: &str,
) -> Result<Option<SourceGate>> {
    if let Some((task, _)) = conversations::active_task_ref_in_tx(tx, locked).await? {
        return resolve_for_task_in_tx(tx, &locked.id, &task).await;
    }
    let tasks = conversations::message_task_ids_in_tx(tx, locked, message_id).await?;
    let mut declared: Vec<Value> = Vec::new();
    for task in &tasks {
        if let Some(gate) = resolve_for_task_in_tx(tx, &locked.id, task).await? {
            declared.push(gate.limits);
        }
    }
    match (declared.len(), tasks.len()) {
        (0, 0) if !analysis::active_task_sources_unrestricted_in_tx(tx, &locked.id).await? => {
            Err(Error::new("task_context_required"))
        }
        (0, _) => Ok(None),
        (1, 1) => Ok(Some(gate_of(&declared[0])?)),
        _ => Err(Error::new("task_context_required")),
    }
}

// 活动任务投影：会话持久active_task_ref与其当前条件声明的允许集。gate为None
// 表示当前活动任务未声明来源限制（或尚无活动任务）。
pub(super) struct ActiveProjection {
    pub task: Option<(String, u64)>,
    pub gate: Option<SourceGate>,
    pub scope_known: bool,
}

pub(super) async fn active_projection_in_tx(
    tx: &mut AppTx<'_>,
    locked: &conversations::LockedConversation,
) -> Result<ActiveProjection> {
    let task = conversations::active_task_ref_in_tx(tx, locked).await?;
    let resolved = match &task {
        Some((task, _)) => resolve_for_task_in_tx(tx, &locked.id, task).await,
        None if analysis::active_task_sources_unrestricted_in_tx(tx, &locked.id).await? => Ok(None),
        None => Err(Error::new("task_context_required")),
    };
    match resolved {
        Ok(gate) => Ok(ActiveProjection {
            task,
            gate,
            scope_known: true,
        }),
        Err(error) if error.code == "task_context_required" => Ok(ActiveProjection {
            task,
            gate: None,
            scope_known: false,
        }),
        Err(error) => Err(error),
    }
}

// 解释既有准入判定；不增加持久状态，也不从当前修订缺字段推断继承范围。
pub(super) fn source_context_blocker(
    input_routed: bool,
    scope_known: bool,
    refresh_pending: bool,
) -> Option<contracts::generated::SourceContextBlocker> {
    use contracts::generated::SourceContextBlocker;
    if refresh_pending {
        Some(SourceContextBlocker::ContextRefreshPending)
    } else if !input_routed {
        Some(SourceContextBlocker::InputNotRouted)
    } else if !scope_known {
        Some(SourceContextBlocker::SourceScopeUnknown)
    } else {
        None
    }
}

// 来源裁决复用本消息的归属状态，不从自然语言关键词猜测限制。
pub(super) async fn input_context_blocker_in_tx(
    tx: &mut AppTx<'_>,
    locked: &conversations::LockedConversation,
    message_id: &str,
) -> Result<Option<contracts::generated::SourceContextBlocker>> {
    let message = conversations::read_message_in_tx(tx, locked, message_id).await?;
    let routed = message.routing_state == "routed";
    let scope_known = routed && active_projection_in_tx(tx, locked).await?.scope_known;
    Ok(source_context_blocker(routed, scope_known, false))
}

// 派发基线进入run授权快照：键存在即表示该运行受轮内重投影纪律约束。
pub(super) fn projection_baseline(projection: &ActiveProjection) -> Value {
    match &projection.task {
        Some((task, version)) => json!({"task_id":task,"condition_version":version.to_string()}),
        None => json!({"task_id":null,"condition_version":null}),
    }
}

// 会话投影内的证据读取清单（authority.evidence_reads）：read_knowledge/read_source/
// search_knowledge成功回执实际交付的来源与对象身份。条件引用与启动目录预览不进
// 此桶，不与实际读取的正文混淆；桶随检查点/运行授权快照传播，重投影后从空开始。
pub(super) fn evidence_reads_of(receipts: &[Value]) -> Vec<Value> {
    fn version_of(value: &Value) -> Option<String> {
        value
            .as_str()
            .map(str::to_owned)
            .or_else(|| value.as_u64().map(|v| v.to_string()))
    }
    fn object_of(value: &Value) -> Option<Value> {
        let asset = value["kind"]
            .as_str()
            .is_some_and(|kind| kind == "memory" || kind == "skill");
        let mut read = json!({
            "category": "object",
            "object_kind": if asset { "asset" } else { "knowledge" },
            "id": value["id"].as_str()?,
            "version": version_of(&value["version"]).unwrap_or_else(|| "1".into()),
        });
        if !asset
            && value["entries"]
                .as_array()
                .is_some_and(|entries| entries.len() == 1)
            && value["entries"][0]["path"].is_string()
        {
            read["path"] = value["entries"][0]["path"].clone();
        }
        Some(read)
    }
    let mut reads = Vec::new();
    let mut push = |read: Value| {
        if !reads.contains(&read) {
            reads.push(read);
        }
    };
    // 知识引用（{object_id,version}形状）折算为对象读取；缺版本按"1"登记，
    // 不因形状缺字段而漏记（fail-closed）。
    fn push_reference(push: &mut impl FnMut(Value), reference: &Value) {
        if let Some(id) = reference["object_id"].as_str() {
            push(json!({
                "category": "object",
                "object_kind": "knowledge",
                "id": id,
                "version": version_of(&reference["version"]).unwrap_or_else(|| "1".into()),
                "path":reference["path"].as_str().unwrap_or(""),
            }));
        }
    }
    // 交付查询结果（get_query的results/execute_query确认执行）时，结果行与
    // 统计来自查询的平台目标：按target_id折算source读取，target不在允许集
    // 即判拒——门的平台成员与allows_source_arg同一判据（04关闭审查修复）。
    fn push_query_delivery(push: &mut impl FnMut(Value), query: &Value, with_target: bool) {
        for reference in query["knowledge_refs"].as_array().into_iter().flatten() {
            push_reference(push, reference);
        }
        if with_target && let Some(target) = query["target_id"].as_str() {
            push(json!({"category":"source","source_kind":"platform","id":target}));
        }
    }
    for receipt in receipts {
        let data = &receipt["data"];
        match receipt["tool_name"].as_str().unwrap_or("") {
            "read_source" => {
                if let Some(source) = data["source_id"].as_str() {
                    match source.strip_prefix("document-") {
                        Some(id) => {
                            push(json!({"category":"source","source_kind":"document","id":id}))
                        }
                        None => {
                            push(json!({"category":"source","source_kind":"platform","id":source}))
                        }
                    }
                } else if data["source"]["id"].is_string() && data["text"].is_string() {
                    push(
                        json!({"category":"source","source_kind":data["source"]["kind"],"id":data["source"]["id"]}),
                    );
                }
            }
            "read_knowledge" => {
                if let Some(read) = object_of(data) {
                    push(read);
                }
                for item in data["items"].as_array().into_iter().flatten() {
                    if item["state"] == "ok" {
                        if item["kind"] == "knowledge" {
                            push_reference(&mut push, &item["ref"]);
                        } else if let Some(read) = object_of(&item["asset"]) {
                            push(read);
                        }
                    }
                }
            }
            "search_knowledge" => {
                for object in data["objects"].as_array().into_iter().flatten() {
                    if let Some(read) = object_of(object) {
                        push(read);
                    }
                }
                for hit in data["hits"].as_array().into_iter().flatten() {
                    if hit["record_kind"] == "knowledge_entry" {
                        push_reference(&mut push, &hit["ref"]);
                    } else if hit["record_kind"] == "source_excerpt" {
                        let source = &hit["citation"]["source"];
                        if source["id"].is_string() {
                            push(
                                json!({"category":"source","source_kind":source["kind"],"id":source["id"]}),
                            );
                        }
                    }
                }
            }
            // 旧查询正文（get_query）与报告全文（read_analysis_report）也是已交付
            // 的派生内容：其知识引用进入证据读取清单，轮内收紧后随派发重核
            // （04切片6"旧工具正文、个人资产、历史投影、派生摘要均在内"）。
            // get_query回执data["query"]承载查询正文，交付结果（results非空且非
            // 失败回执——错误对象{"error":...}没有交付任何数据，按未交付登记，
            // 不产生无数据交付的误报stale）时连同平台目标一并折算；
            // read_analysis_report回执data是页面本身，来源信封（含读取点折算的
            // result_targets平台目标）由工具臂单独登记（04关闭第三轮审查修复）。
            "get_query" => {
                let delivered = !data["results"].is_null() && data["results"]["error"].is_null();
                push_query_delivery(&mut push, &data["query"], delivered);
            }
            "execute_query" => {
                // 确认执行的旧查询正文与其平台目标：批形状与单形状都收。
                for query in data["queries"].as_array().into_iter().flatten() {
                    push_query_delivery(&mut push, query, true);
                }
                if data["id"].is_string() {
                    push_query_delivery(&mut push, data, true);
                }
            }
            "request_query" | "validate_sql" => {
                // 草稿查询正文引用与semantic_checks派生摘要（checks[].evidence_refs）
                // 都是已交付内容：引用进入证据读取，收紧后重核（04切片6）。
                if receipt["tool_name"] == "request_query" {
                    push_query_delivery(&mut push, data, false);
                }
                for check in data["semantic_checks"]["checks"]
                    .as_array()
                    .into_iter()
                    .flatten()
                {
                    for reference in check["evidence_refs"].as_array().into_iter().flatten() {
                        push_reference(&mut push, reference);
                    }
                }
            }
            "read_analysis_report" => {
                for reference in data["sources"]["knowledge_refs"]
                    .as_array()
                    .into_iter()
                    .flatten()
                {
                    push_reference(&mut push, reference);
                }
                // 报告结论数字来自result_dependencies查询的平台目标：读取点
                // 已折算为result_targets，此处与知识引用同入证据读取——查询
                // 目标经报告全文交付不再对来源门不可见（04关闭第三轮审查修复）。
                for target in data["result_targets"].as_array().into_iter().flatten() {
                    if let Some(id) = target.as_str() {
                        push(json!({"category":"source","source_kind":"platform","id":id}));
                    }
                }
            }
            _ => (),
        }
    }
    reads
}

// 投影内证据读取是否全部落在允许集内：来源按身份成员；对象（含个人资产，其贡献
// 根不可核验时fail-closed）按完整贡献根闭包判定，与读取门同判据。
async fn evidence_reads_within(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    gate: &SourceGate,
    authority: &Value,
) -> Result<bool> {
    let reads = authority["evidence_reads"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    for read in &reads {
        // 个人资产预览按其真实来源核验：同源资产是合法线索；停用、改版、
        // 未知或越界来源仍拒，不因预览进入过工作区而整轮重置。
        if read["object_kind"] == "asset" {
            let Some(id) = read["id"].as_str() else {
                return Ok(false);
            };
            let Ok(asset) = assets::read_in_tx(tx, ctx, id, true).await else {
                return Ok(false);
            };
            if asset["version"].as_str() != read["version"].as_str() {
                return Ok(false);
            }
            if !asset_within_in_tx(tx, ctx, gate, &asset).await? {
                return Ok(false);
            }
            continue;
        }
        if read["category"] == "source"
            && !read["id"]
                .as_str()
                .is_some_and(|id| gate.member(read["source_kind"].as_str().unwrap_or(""), id))
        {
            return Ok(false);
        }
    }
    // 资产读取已在上方按自身来源核验，不能再次按知识贡献根判定。
    let objects: Vec<_> = reads
        .iter()
        .filter(|read| read["category"] == "object" && read["object_kind"] != "asset")
        .filter_map(|read| {
            Some(knowledge::dependency_index::DependencySelection {
                object_id: read["id"].as_str()?.to_owned(),
                version: epoch(read["version"].as_str()?).ok()?,
                path: read["path"].as_str().unwrap_or("").to_owned(),
            })
        })
        .collect();
    adopted_objects_within(tx, gate, &objects).await
}

// 已交付对象是否全部可交付：允许文档按稳定来源身份直通（两种id形状都认），
// 其余按贡献根闭包判定——空根不放行、unknown fail-closed、传递根须全符合。
async fn adopted_objects_within(
    tx: &mut AppTx<'_>,
    gate: &SourceGate,
    objects: &[knowledge::dependency_index::DependencySelection],
) -> Result<bool> {
    let mut selections = Vec::new();
    for selection in objects {
        let Some(selected) =
            knowledge::dependency_index::resolve_selection_in_tx(tx, selection).await?
        else {
            return Ok(false);
        };
        selections.push(selected);
    }
    let roots =
        knowledge::dependency_index::selected_contribution_roots_in_tx(tx, &selections).await?;
    Ok(selections.iter().zip(roots).all(|(selection, own)| {
        gate.member("document", &selection.object_id)
            || selection
                .object_id
                .strip_prefix("document-")
                .is_some_and(|id| gate.member("document", id))
            || own.unknown.is_empty()
                && !own.sources.is_empty()
                && own.sources.iter().all(|(kind, id)| gate.member(kind, id))
    }))
}

/// 派生正文仍受全部实际来源限制。资产的独立人工内容没有公共来源根，
/// 不能把空集合视为允许；直接用户输入的空authority不属于资产证据。
pub(super) async fn authority_within_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    gate: &SourceGate,
    authority: &Value,
) -> Result<bool> {
    let mut pending = vec![authority.clone()];
    let mut visited_assets = std::collections::HashSet::new();
    while let Some(authority) = pending.pop() {
        let mut checked = super::context_authority::empty();
        super::context_authority::merge(&mut checked, &authority)?;
        let references = super::context_authority::knowledge_selections(&checked)?;
        if !adopted_objects_within(tx, gate, &references).await? {
            return Ok(false);
        }
        for pair in checked["sources"].as_array().expect("complete") {
            if !gate.allows_source_arg(pair[0].as_str().expect("id")) {
                return Ok(false);
            }
        }
        for kind in ["query_results", "source_query_results"] {
            for pair in checked[kind].as_array().expect("complete") {
                let query = queries::read_in_tx(tx, ctx, pair[0].as_str().expect("id")).await?;
                if !gate.member("platform", query["target_id"].as_str().unwrap_or("")) {
                    return Ok(false);
                }
            }
        }
        for kind in ["memories", "skills", "source_skills"] {
            for pair in checked[kind].as_array().expect("complete") {
                let id = pair[0].as_str().expect("id");
                if !visited_assets.insert((id.to_owned(), pair[1].clone())) {
                    continue;
                }
                let asset = assets::read_in_tx(tx, ctx, id, true).await?;
                let mut sources = super::context_authority::empty();
                super::context_authority::observe(&mut sources, &asset["dependencies"]);
                for fields in super::personal_assets::authorities_in_tx(tx, ctx, &asset).await? {
                    super::context_authority::merge(&mut sources, &fields)?;
                }
                if [
                    "knowledge",
                    "sources",
                    "query_results",
                    "source_query_results",
                    "historical_analyses",
                ]
                .iter()
                .all(|key| sources[*key].as_array().is_none_or(Vec::is_empty))
                {
                    return Ok(false);
                }
                pending.push(sources);
            }
        }
        for entry in checked["historical_analyses"].as_array().expect("complete") {
            pending.push(entry["actual_sources"]["authority"].clone());
        }
    }
    Ok(true)
}

// 资产不是知识对象：真实来源在自身dependencies与字段authority里，不能拿资产ID
// 去查贡献根。以资产真实身份进入authority闭包核来源；空来源是独立人工内容，
// 不因空集合放行。
pub(super) async fn asset_within_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    gate: &SourceGate,
    asset: &Value,
) -> Result<bool> {
    let mut authority = super::context_authority::empty();
    super::context_authority::observe(
        &mut authority,
        &json!({"kind": asset["kind"], "id": asset["id"], "version": asset["version"]}),
    );
    authority_within_in_tx(tx, ctx, gate, &authority).await
}

pub(super) async fn assert_asset_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    gate: &SourceGate,
    asset: &Value,
) -> Result<()> {
    if asset_within_in_tx(tx, ctx, gate, asset).await? {
        Ok(())
    } else {
        Err(Error::new("source_not_allowed"))
    }
}

// 实际交付与派生出处都要核对；前者另含不可直接注入的个人资产预览。
async fn authority_projection_within(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    gate: &SourceGate,
    authority: &Value,
) -> Result<bool> {
    if !evidence_reads_within(tx, ctx, gate, authority).await? {
        return Ok(false);
    }
    authority_within_in_tx(tx, ctx, gate, authority).await
}

// 轮内范围变化在Pi应用新投影前阻止普通与摘要派发。
// 成功工具回执通知Node使用Pi原生边界接口；确认新检查点后沿原运行继续。
pub(super) async fn assert_dispatch_projection_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    locked: &conversations::LockedConversation,
    run_authority: Option<&Value>,
) -> Result<()> {
    if let Some(authority) = run_authority
        && active_reset_required_in_tx(tx, ctx, locked, authority).await?
    {
        return Err(Error::new("stale_context"));
    }
    Ok(())
}

// 跨轮重投影：检查点携带的已交付内容（证据读取/旧正文引用/个人资产/历史引用）
// 违反当前活动任务限制时重建投影，不能把上一任务的受限正文经Pi恢复重新注入
// 新输入。
pub(super) async fn active_reset_required_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    locked: &conversations::LockedConversation,
    checkpoint_authority: &Value,
) -> Result<bool> {
    let projection = active_projection_in_tx(tx, locked).await?;
    let previous = &checkpoint_authority["active_task"];
    let current = projection_baseline(&projection);
    if previous.is_null() && projection.task.is_some() {
        // 旧快照缺活动范围证明，不能用目标任务无限制推断旧正文属于同一范围。
        return Ok(true);
    }
    if let Some(task) = previous["task_id"].as_str() {
        let task_changed = previous["task_id"] != current["task_id"];
        if task_changed || previous["condition_version"] != current["condition_version"] {
            let version = epoch(previous["condition_version"].as_str().unwrap_or(""))?;
            let prior =
                analysis::source_limits_at_version_in_tx(tx, &locked.id, task, version).await?;
            let same_scope = match (prior.as_ref(), projection.gate.as_ref()) {
                (Some(Value::Null), None) => true,
                (Some(limits), Some(gate)) if !limits.is_null() => {
                    gate_of(limits)?.allowed_keys() == gate.allowed_keys()
                }
                _ => false,
            };
            // 只比较许可集合；顺序、重复项和声明消息身份不改变可见范围。
            if !projection.scope_known || !same_scope || (task_changed && projection.gate.is_some())
            {
                return Ok(true);
            }
        }
    }
    if !projection.scope_known {
        return Ok(!super::context_authority::has_no_sources(
            checkpoint_authority,
        ));
    }
    match &projection.gate {
        None => Ok(false),
        Some(gate) => Ok(!authority_projection_within(tx, ctx, gate, checkpoint_authority).await?),
    }
}

// 正式草稿的门跟草稿所属任务走：request_query显式携带task_id且版本已核对当前，
// 限制按该任务当前条件解析，不按消息绑定集（消息绑定的可能是另一个无限制任务）。
pub(super) async fn resolve_for_task_in_tx(
    tx: &mut AppTx<'_>,
    cid: &str,
    task_id: &str,
) -> Result<Option<SourceGate>> {
    match analysis::declared_source_limits_in_tx(tx, cid, task_id).await? {
        Some(Value::Null) => Ok(None),
        Some(limits) => Ok(Some(gate_of(&limits)?)),
        None => Err(Error::new("task_context_required")),
    }
}

// 门换算为每路召回前的允许记录集（05切片3；05接续并入空间、启停与v1硬范围，
// 无来源限制时也前置）。判据与交付门同源：允许文档按稳定来源身份整体直通；
// 其余对象按当前代的实际贡献根闭包——空根不放行、unknown fail-closed、全部
// 来源落在允许集内才可召回。原文通道直接按SourceKey身份过滤。不装配对象正文，
// 只用元信息与贡献根批量核验；对象更新换代由提交事务重解析护栏兜底，这里按
// 当前代预过滤。
pub(super) async fn allowed_records_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    gate: Option<&SourceGate>,
    scope: &crate::search_scope::KnowledgeSearchScope,
) -> Result<crate::modules::retrieval::vector::AllowedRecords> {
    // 范围∩启停头清单是各分支的共同起点：v1硬范围（kinds/anchor/domain）与
    // 对象启停在库内判定，向量/词法各路以同一允许记录集表达。
    let heads = knowledge::scoped_enabled_heads_in_tx(tx, ctx, scope).await?;
    let readable = ingestion::readable_source_heads_in_tx(tx, &ctx.space_id).await?;
    let platform_ids: std::collections::HashSet<_> =
        readable.iter().map(|(id, _)| id.as_str()).collect();
    let mut sources = Vec::new();
    if scope.is_unscoped() {
        sources.extend(
            readable
                .iter()
                .map(|(id, _)| ("platform".to_owned(), id.clone())),
        );
    }
    for chunk in heads.chunks(50) {
        let ids = chunk.iter().map(|(id, _)| id.clone()).collect::<Vec<_>>();
        for meta in knowledge::candidate_meta_in_tx(tx, ctx, &ids, None).await? {
            if meta["kind"] == "document" {
                // 同步派生文档由知识窗口召回；只有独立文档拥有document原文索引。
                if meta["source_id"].is_null()
                    && let Some(id) = meta["id"].as_str()
                {
                    sources.push(("document".into(), id.to_owned()));
                }
            } else if meta["kind"] == "table"
                && !scope.is_unscoped()
                && let Some(source) = meta["source_id"]
                    .as_str()
                    .filter(|source| platform_ids.contains(source))
            {
                sources.push(("platform".into(), source.to_owned()));
            }
        }
    }
    if let Some(gate) = gate {
        sources.retain(|(kind, id)| gate.member(kind, id));
    }
    sources.sort();
    sources.dedup();
    let Some(gate) = gate else {
        return Ok(crate::modules::retrieval::vector::AllowedRecords {
            knowledge_ids: heads.into_iter().map(|(id, _)| id).collect(),
            sources,
        });
    };
    let mut knowledge_ids = Vec::new();
    let mut rest = Vec::new();
    for (id, version) in heads {
        if gate.member("document", id.as_str())
            || id
                .strip_prefix("document-")
                .is_some_and(|bare| gate.member("document", bare))
        {
            knowledge_ids.push(id);
        } else {
            rest.push((id, version));
        }
    }
    let mut seen = knowledge_ids
        .iter()
        .cloned()
        .collect::<std::collections::HashSet<_>>();
    for chunk in rest.chunks(200) {
        for roots in contribution_roots_in_tx(tx, chunk).await? {
            if roots.unknown.is_empty()
                && !roots.sources.is_empty()
                && roots.sources.iter().all(|(kind, id)| gate.member(kind, id))
                && seen.insert(roots.owner_id.clone())
            {
                knowledge_ids.push(roots.owner_id);
            }
        }
    }
    knowledge_ids.sort();
    Ok(crate::modules::retrieval::vector::AllowedRecords {
        knowledge_ids,
        sources,
    })
}

/// 限制声明由本次真实消息绑定；继承原限制时保留原身份。
pub(super) async fn bind_update_in_tx(
    tx: &mut AppTx<'_>,
    cid: &str,
    message_id: &str,
    user_supplied: bool,
    input: &mut Value,
    tool_contract_version: u8,
) -> Result<()> {
    if input["action"] == "route" {
        return Ok(());
    }
    let prior = if let Some(task) = input["task_id"].as_str() {
        analysis::declared_source_limits_in_tx(tx, cid, task).await?
    } else {
        None
    };
    let full =
        input["action"] == "create" || input["action"] == "split" || input["task_id"].is_null();
    if input["action"] == "split" && input["conditions"]["source_limits"].is_null() {
        // 拆分继承原范围；完整条件中的null不是用户显式unset。
        input["conditions"]["source_limits"] =
            prior.clone().ok_or(Error::new("task_context_required"))?;
    } else if full
        && input["conditions"].get("source_limits").is_none()
        && tool_contract_version == 1
    {
        // 新v2声明保留未知，不能将尚未解析来源的缺字段自动当作无限制。
        input["conditions"]["source_limits"] = Value::Null;
    }
    if input["condition_patch"]["unset"]
        .as_array()
        .is_some_and(|keys| keys.contains(&json!("source_limits")))
        && !user_supplied
    {
        return Err(Error::new("invalid_evidence"));
    }
    let next = if full {
        input["conditions"].get_mut("source_limits")
    } else {
        input["condition_patch"]["set"].get_mut("source_limits")
    };
    if let Some(next) = next.filter(|value| value.is_object()) {
        if prior
            .as_ref()
            .is_some_and(|prior| prior["allowed_sources"] == next["allowed_sources"])
        {
            *next = prior.expect("matched prior");
        } else {
            if !user_supplied {
                return Err(Error::new("invalid_evidence"));
            }
            next["origin_message_ids"] = json!([message_id]);
        }
    }
    Ok(())
}

// 合同SourceLimits值构造门（06交付层与门控集成测试共用；消息内解析仍走
// resolve_in_tx）。
pub(super) fn gate_from_contract(limits: &Value) -> Result<SourceGate> {
    gate_of(limits)
}

fn gate_of(limits: &Value) -> Result<SourceGate> {
    contracts::validate("SourceLimits", limits)?;
    let allowed = limits["allowed_sources"]
        .as_array()
        .expect("validated limits")
        .iter()
        .filter_map(|key| {
            Some((
                key["kind"].as_str()?.to_owned(),
                key["id"].as_str()?.to_owned(),
            ))
        })
        .collect::<Vec<_>>();
    Ok(SourceGate {
        allowed,
        limits: limits.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::knowledge::dependency_index::ContributionRoots;
    use serde_json::json;

    fn gate(kinds: &[(&str, &str)]) -> SourceGate {
        let limits = json!({"allowed_sources": kinds
            .iter()
            .map(|(kind, id)| json!({"kind": kind, "id": id}))
            .collect::<Vec<_>>(),
            "origin_message_ids": ["m1"]});
        gate_of(&limits).expect("valid limits")
    }

    fn roots(sources: &[(&str, &str)], unknown: &[(&str, u64)]) -> ContributionRoots {
        ContributionRoots {
            owner_id: "obj".into(),
            owner_version: 1,
            sources: sources
                .iter()
                .map(|(k, i)| (k.to_string(), i.to_string()))
                .collect(),
            unknown: unknown.iter().map(|(k, v)| (k.to_string(), *v)).collect(),
        }
    }

    fn object(kind: &str, id: &str) -> Value {
        json!({"id": id, "kind": kind, "version": "1"})
    }

    #[test]
    fn judgment_matrix_over_document_shortcut_empty_partial_and_unknown() {
        let gate = gate(&[("document", "a"), ("platform", "p")]);
        // 文档按稳定身份整体放行：限制跟来源身份走，不逐条目判根。
        assert!(gate.object_allowed(&object("document", "a"), None));
        assert!(!gate.object_allowed(&object("document", "b"), None));
        // 完整可核验且全在允许集内才放行。
        assert!(gate.object_allowed(
            &object("metric", "m"),
            Some(&roots(&[("platform", "p")], &[]))
        ));
        // 传递根部分在允许集外：不因主根在允许集而放行。
        assert!(!gate.object_allowed(
            &object("metric", "m"),
            Some(&roots(&[("platform", "p"), ("platform", "q")], &[]))
        ));
        // 空根是独立人工内容，不能当任意集合的子集放行。
        assert!(!gate.object_allowed(&object("metric", "m"), Some(&roots(&[], &[]))));
        // unknown非空按闭包不完整拒绝，即使已知部分全在允许集内。
        assert!(!gate.object_allowed(
            &object("metric", "m"),
            Some(&roots(&[("platform", "p")], &[("unmapped", 2)]))
        ));
        // 无根可查（读不出身份或不在结果集）同样不放行。
        assert!(!gate.object_allowed(&object("metric", "m"), None));
    }

    #[tokio::test]
    async fn synchronized_document_recalls_its_own_windows_without_upstream_access() {
        let Ok(url) = std::env::var("DATA_AGENT_DATABASE_URL") else {
            return;
        };
        assert!(url.contains("/data_agent_test_"));
        let pool = crate::persistence::connect(&url).await.unwrap();
        let ctx = AccessContext {
            user_id: "alice".into(),
            space_id: "demo".into(),
            request_id: "synchronized-document-recall".into(),
        };
        let source = "synchronized-document-upstream";
        let id = "synchronized-document";
        let query = "synchronizeddocumentneedle";
        let body = format!(
            "{} {query}：复核完成后才可计入。{}",
            "无关背景。".repeat(300),
            "未选附录。".repeat(300)
        );
        let mut tx = AppTx::begin(&pool).await.unwrap();
        knowledge::seed_in_tx(&mut tx, &ctx, &json!({"objects":[{
            "id":id,"kind":"document","name":"合成同步文档","version":"1","state":"enabled",
            "source_id":source,"source_version":"1","related_ids":[],
            "entries":[{"entry_id":"body","path":"body","label":"正文","effective_value":body,
                "source_facts":{"source_id":source,"version":"1","value":body},"suggestion":{},"human_override":null}]
        }]})).await.unwrap();
        tx.commit().await.unwrap();
        super::super::knowledge::rebuild_index(
            &pool,
            &ctx,
            &json!({"operation_id":"index-synchronized-document"}),
        )
        .await
        .unwrap();
        while super::super::knowledge::process_index(&pool).await.unwrap() {}
        let scope = crate::search_scope::KnowledgeSearchScope::default();
        let gate = gate(&[("document", id)]);
        let mut tx = AppTx::begin(&pool).await.unwrap();
        let allowed = allowed_records_in_tx(&mut tx, &ctx, Some(&gate), &scope)
            .await
            .unwrap();
        // 两个词法owner也必须保留这类文档；它不走独立文档的raw索引。
        let terms = vec![query.to_owned()];
        let current = knowledge::matching_content_in_tx(
            &mut tx,
            &ctx,
            query,
            &terms,
            &terms,
            &scope,
            Some(&allowed.knowledge_ids),
            10,
            0,
            true,
        )
        .await
        .unwrap();
        let indexed = crate::modules::retrieval::content_candidates_scoped_in_tx(
            &mut tx,
            &ctx.space_id,
            query,
            &terms,
            &terms,
            &scope,
            Some(&allowed.knowledge_ids),
            10,
            0,
            true,
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();
        // 用已建索引的真实dense通道核对同一允许集；向量只测试可达性，不冒充语义质量。
        let dense = crate::modules::retrieval::vector::search_scoped(
            crate::modules::retrieval::vector::ScopedQuery {
                space: &ctx.space_id,
                query,
                vector: Some(vec![
                    0.01;
                    crate::modules::retrieval::embedding::SPEC.dimension
                ]),
                scope: &scope,
                limit: 10,
                allowed: Some(&allowed),
                include_raw: true,
                deadline: crate::modules::retrieval::vector::retrieval_deadline(),
            },
        )
        .await;
        assert_eq!(dense.dense_state, "available");
        assert!(
            !dense.values.is_empty(),
            "真实dense过滤也须保留同步文档正文"
        );
        assert!(dense.values.iter().all(|hit| hit["id"] == id));
        let stage = super::super::knowledge::search_stage_outside_lock(
            &pool,
            &ctx,
            &mut super::super::knowledge::ScopedSearchRequest {
                query,
                limit: 10,
                launch: None,
                vector: crate::modules::retrieval::vector::Candidates::lexical(),
                scope: &scope,
                allowed: Some(&allowed),
                asset_after: None,
                hints: None,
                cid: "",
                text_results: &Default::default(),
                include_raw: true,
            },
        )
        .await
        .unwrap();
        assert!(
            !current.is_empty() && !indexed.is_empty() && !stage.search.hits.is_empty(),
            "同步文档正文须可由现有窗口召回：current={}, projection={}, hybrid={}",
            current.len(),
            indexed.len(),
            stage.search.hits.len()
        );
        assert!(
            allowed.sources.is_empty(),
            "许可文档不授权整个上游，也不虚报不存在的独立文档raw索引"
        );
        assert_eq!(stage.search.coverage["index_state"], "current");
        for hit in stage.search.hits {
            let super::super::knowledge::SearchHit::Knowledge { content, .. } = hit else {
                panic!("不得借上游原文交付");
            };
            assert_eq!(content["id"], id);
            let text = content["entries"][0]["effective_value"].as_str().unwrap();
            assert!(text.contains(query));
            assert!(text.chars().count() <= crate::types::KNOWLEDGE_WINDOW);
        }
        pool.close().await;
    }

    #[tokio::test]
    async fn raw_allowed_records_include_readable_heads_without_task_gate() {
        let Ok(url) = std::env::var("DATA_AGENT_DATABASE_URL") else {
            return;
        };
        assert!(url.contains("/data_agent_test_"));
        let pool = crate::persistence::connect(&url).await.unwrap();
        let ctx = AccessContext {
            user_id: "alice".into(),
            space_id: "raw-allowed-scope".into(),
            request_id: "raw-allowed-records".into(),
        };
        let mut tx = AppTx::begin(&pool).await.unwrap();
        knowledge::seed_in_tx(
            &mut tx,
            &ctx,
            &json!({"objects":[
                {"id":"raw-allowed-document","kind":"document","name":"合成范围文档",
                 "version":"1","state":"enabled","source_id":null,"source_version":"0",
                 "related_ids":[],"entries":[]},
                {"id":"raw-allowed-disabled","kind":"document","name":"合成停用文档",
                 "version":"1","state":"disabled","source_id":null,"source_version":"0",
                 "related_ids":[],"entries":[]},
                {"id":"raw-allowed-table","kind":"table","name":"合成范围平台表",
                 "version":"1","state":"enabled","source_id":"raw-allowed-current",
                 "source_version":"3","related_ids":[],"entries":[]},
                {"id":"raw-allowed-field","kind":"field","name":"合成范围字段",
                 "version":"1","state":"enabled","source_id":"raw-allowed-current",
                 "source_version":"3","related_ids":[],"entries":[]}
            ]}),
        )
        .await
        .unwrap();
        let unscoped = crate::search_scope::KnowledgeSearchScope::default();
        let allowed = allowed_records_in_tx(&mut tx, &ctx, None, &unscoped)
            .await
            .unwrap();
        assert_eq!(
            allowed.knowledge_ids,
            [
                "raw-allowed-document",
                "raw-allowed-field",
                "raw-allowed-table"
            ]
        );
        assert_eq!(
            allowed.sources,
            [
                ("document".into(), "raw-allowed-document".into()),
                ("platform".into(), "raw-allowed-current".into()),
                ("platform".into(), "raw-allowed-legacy".into()),
                ("platform".into(), "raw-allowed-old-current".into()),
            ],
            "无任务来源门仍须使用owner当前可读集合；不能漏current-only或借legacy放行当前incomplete"
        );
        let document_scope = crate::search_scope::KnowledgeSearchScope {
            kinds: vec!["document".into()],
            ..Default::default()
        };
        let documents = allowed_records_in_tx(&mut tx, &ctx, None, &document_scope)
            .await
            .unwrap();
        assert_eq!(
            documents.sources,
            [("document".into(), "raw-allowed-document".into())]
        );
        let table_scope = crate::search_scope::KnowledgeSearchScope {
            anchor: Some("raw-allowed-table".into()),
            ..Default::default()
        };
        let tables = allowed_records_in_tx(&mut tx, &ctx, None, &table_scope)
            .await
            .unwrap();
        assert_eq!(
            tables.sources,
            [("platform".into(), "raw-allowed-current".into())]
        );
        let field_scope = crate::search_scope::KnowledgeSearchScope {
            kinds: vec!["field".into()],
            ..Default::default()
        };
        let fields = allowed_records_in_tx(&mut tx, &ctx, None, &field_scope)
            .await
            .unwrap();
        assert_eq!(fields.knowledge_ids, ["raw-allowed-field"]);
        assert!(
            fields.sources.is_empty(),
            "整篇平台原文不能仅凭字段引用变成该字段的原文"
        );
        let restricted = gate(&[
            ("platform", "raw-allowed-current"),
            ("platform", "raw-allowed-legacy"),
            ("platform", "raw-allowed-retired"),
            ("document", "raw-allowed-document"),
            ("document", "raw-allowed-disabled"),
        ]);
        let gated_documents =
            allowed_records_in_tx(&mut tx, &ctx, Some(&restricted), &document_scope)
                .await
                .unwrap();
        assert_eq!(
            gated_documents.sources,
            [("document".into(), "raw-allowed-document".into())],
            "显式来源门还须与硬范围和当前启停相交"
        );
        let gated = allowed_records_in_tx(&mut tx, &ctx, Some(&restricted), &unscoped)
            .await
            .unwrap();
        assert_eq!(
            gated.sources,
            [
                ("document".into(), "raw-allowed-document".into()),
                ("platform".into(), "raw-allowed-current".into()),
                ("platform".into(), "raw-allowed-legacy".into()),
            ]
        );
        tx.commit().await.unwrap();
        pool.close().await;
    }

    #[test]
    fn source_arg_membership_strips_document_prefix() {
        let gate = gate(&[("document", "a"), ("platform", "business-guide")]);
        assert!(gate.allows_source_arg("document-a"));
        assert!(gate.allows_source_arg("business-guide"));
        assert!(!gate.allows_source_arg("document-b"));
        assert!(!gate.allows_source_arg("other"));
    }

    // R08：资产按自身dependencies/字段authority核来源，不拿资产ID查知识贡献根。
    // 同源已选能力保留；混合依赖、仅范围外来源与无来源人工内容仍拒。
    #[tokio::test]
    async fn asset_gate_judges_real_asset_sources() {
        let Ok(url) = std::env::var("DATA_AGENT_DATABASE_URL") else {
            return;
        };
        assert!(url.contains("/data_agent_test_"));
        let pool = crate::persistence::connect(&url).await.unwrap();
        let ctx = AccessContext {
            user_id: "alice".into(),
            space_id: "asset-gate-scope".into(),
            request_id: "asset-gate-sources".into(),
        };
        let mut tx = AppTx::begin(&pool).await.unwrap();
        knowledge::seed_in_tx(
            &mut tx,
            &ctx,
            &json!({"objects":[
                {"id":"asset-gate-d","kind":"document","name":"合成允许文档",
                 "version":"1","state":"enabled","source_id":null,"source_version":"0",
                 "related_ids":[],"entries":[{"path":"body","effective_value":"允许文档正文"}]},
                {"id":"asset-gate-e","kind":"document","name":"合成范围外文档",
                 "version":"1","state":"enabled","source_id":null,"source_version":"0",
                 "related_ids":[],"entries":[{"path":"body","effective_value":"范围外文档正文"}]}
            ]}),
        )
        .await
        .unwrap();
        let input = |name: &str, dependencies: Value| {
            json!({"operation_id": format!("asset-gate-{name}"), "id": null,
                "expected_version": null, "kind": "skill", "name": name,
                "body": "合成方法正文。", "scope": "合成范围。", "source_text": "本人录入",
                "dependencies": dependencies, "verified": false})
        };
        let reference = |id: &str| json!({"object_id": id, "version": "1", "path": "body"});
        async fn save_asset(
            tx: &mut AppTx<'_>,
            ctx: &AccessContext,
            input: &Value,
        ) -> crate::types::Result<Value> {
            knowledge::check_refs_in_tx(tx, ctx, &input["dependencies"]).await?;
            assets::save_authorized_in_tx(tx, ctx, input, false).await
        }
        let same_source = save_asset(
            &mut tx,
            &ctx,
            &input("同源合成方法", json!([reference("asset-gate-d")])),
        )
        .await
        .unwrap();
        let mixed = save_asset(
            &mut tx,
            &ctx,
            &input(
                "混合依赖合成方法",
                json!([reference("asset-gate-d"), reference("asset-gate-e")]),
            ),
        )
        .await
        .unwrap();
        let manual = save_asset(&mut tx, &ctx, &input("无来源人工方法", json!([])))
            .await
            .unwrap();
        let only_d = gate(&[("document", "asset-gate-d")]);
        assert!(
            asset_within_in_tx(&mut tx, &ctx, &only_d, &same_source)
                .await
                .unwrap(),
            "只依赖允许文档的已选能力不得整类禁用"
        );
        assert!(
            !asset_within_in_tx(&mut tx, &ctx, &only_d, &mixed)
                .await
                .unwrap(),
            "混合依赖含范围外来源时整体拒绝"
        );
        assert!(
            !asset_within_in_tx(&mut tx, &ctx, &only_d, &manual)
                .await
                .unwrap(),
            "无来源人工内容不能借空集合放行"
        );
        let only_e = gate(&[("document", "asset-gate-e")]);
        assert!(
            !asset_within_in_tx(&mut tx, &ctx, &only_e, &same_source)
                .await
                .unwrap(),
            "来源不在允许集时拒绝"
        );
        tx.commit().await.unwrap();
        pool.close().await;
    }
}
