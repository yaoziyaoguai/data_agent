use data_agent::{
    contracts,
    modules::knowledge,
    persistence::{self, AppTx},
    types::AccessContext,
};
use serde_json::{Value, json};
use sqlx::{MySqlPool, Row};

// 必要支持可以独立指向来源，不要求同时出现在陈述citations中；否则完整映射
// 会漏掉支持来源，使来源范围及失效传播只看见citation与knowledge支持。
#[test]
fn source_supports_register_required_dependencies_on_the_effective_human_layer() {
    let text = "月弧订单按入账日统计。";
    let prerequisite = "仅统计已结算的月弧订单。";
    let exception = "试运行渠道不计入月弧订单。";
    let citation = |kind: &str, id: &str, revision: &str, content: &str| {
        json!({"source":{"kind":kind,"id":id},"revision":revision,
            "locator":{"offset":0,"length":content.chars().count()}})
    };
    let statement = json!({
        "statement_id":"moon-order-rule",
        "object_ref":{"object_id":"term-moon-orders","version":"7","path":"body"},
        "text":text,"scope_text":"","origin":"human",
        "citations":[citation("document", "moon-order-guide", "5", text)],
        "supports":[
            {"support_id":"moon-settlement-support","role":"prerequisite",
                "reference":{"kind":"source","citation":
                    citation("document", "moon-settlement-guide", "2", prerequisite)},
                "content":prerequisite,"embedded_in":null},
            {"support_id":"moon-channel-exception","role":"exception",
                "reference":{"kind":"source","citation":
                    citation("platform", "moon-channel-source", "3", exception)},
                "content":exception,"embedded_in":null},
            {"support_id":"moon-counting-support","role":"calculation_dependency",
                "reference":{"kind":"knowledge","ref":{
                    "object_id":"term-moon-counting","version":"4","path":"body"}},
                "content":"同一月弧订单只计一次。","embedded_in":null}
        ],
        "supports_complete":true
    });
    contracts::validate("SemanticStatement", &statement).unwrap();
    let object = json!({
        "id":"term-moon-orders","kind":"term","name":"合成月弧订单口径",
        "version":"7","state":"enabled","source_id":null,"source_version":"0",
        "related_ids":[],"updated_by":"alice",
        "entries":[{
            "entry_id":"body","path":"body","label":"正文",
            "source_facts":{"complete":false,"gap":"人工录入，尚无平台来源"},
            "suggestion":{},
            "human_override":{"value":text,"edited_by":"alice","statements":[statement]},
            "effective_value":text,"effective_structure":null,"review_state":"confirmed"
        }]
    });
    contracts::validate("KnowledgeObject", &object).unwrap();

    let indexed = knowledge::dependency_index::rows_for_object(&object).unwrap();
    assert!(indexed.complete, "已明确保存来源的人工陈述应有完整依赖映射");
    assert!(indexed.rows.iter().all(|row| {
        row.owner_id == "term-moon-orders" && row.owner_version == 7 && row.entry_path == "body"
    }));
    let mut rows = indexed
        .rows
        .iter()
        .map(|row| {
            (
                row.layer.as_str(),
                row.purpose.as_str(),
                row.role.as_str(),
                row.effective,
                row.target_kind.as_str(),
                row.target_id.as_str(),
                row.target_revision,
                row.target_path.as_str(),
            )
        })
        .collect::<Vec<_>>();
    rows.sort_unstable();
    assert_eq!(
        rows,
        vec![
            (
                "human_override",
                "required",
                "citation",
                true,
                "document",
                "moon-order-guide",
                5,
                ""
            ),
            (
                "human_override",
                "required",
                "support",
                true,
                "document",
                "moon-settlement-guide",
                2,
                ""
            ),
            (
                "human_override",
                "required",
                "support",
                true,
                "knowledge",
                "term-moon-counting",
                4,
                "body"
            ),
            (
                "human_override",
                "required",
                "support",
                true,
                "platform",
                "moon-channel-source",
                3,
                ""
            ),
        ],
        "文档与平台来源支持必须和citation、knowledge支持一起登记为有效必要依赖"
    );
}

// 合成库按串行使用（与mvp检查的--test-threads=1一致），互斥覆盖整个测试：
// 串行后每个测试在自己的runtime上建池，迁移只由先到者执行一次。
static SERIAL: std::sync::LazyLock<tokio::sync::Mutex<()>> =
    std::sync::LazyLock::new(|| tokio::sync::Mutex::new(()));

async fn harness_pool() -> MySqlPool {
    persistence::connect(
        &std::env::var("DATA_AGENT_DATABASE_URL").expect("isolated harness database"),
    )
    .await
    .unwrap()
}

// 生产保存组合：模块保存（或整理应用）＋保存后跨模块登记（指纹补记/扇出排队）
// 同事务执行。架构上跨模块登记归use_cases组合层，测试按同组合驱动，断言登记
// 语义（指纹列、扇出作业、保守失效）时不得只调模块函数。
async fn register_saved_in_tx(tx: &mut AppTx<'_>, ctx: &AccessContext, saved: &[Value]) {
    data_agent::use_cases::dependency_registration::after_content_saved_in_tx(tx, ctx, saved)
        .await
        .unwrap();
}

// 依赖索引登记：保存/整理同事务生成依赖行，有效层行参与语义有效性，
// 人工完全替换后旧层行保留但不再有效；反向查询按目标身份分页返回依赖者。
#[tokio::test]
async fn saving_layers_registers_dependencies_with_effective_flags_and_reverse_index() {
    let _guard = SERIAL.lock().await;
    let pool = harness_pool().await;
    let ctx = AccessContext {
        user_id: "alice".into(),
        space_id: "demo".into(),
        request_id: "synthetic-dependency-index".into(),
    };
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let object = knowledge::create_in_tx(
        &mut tx,
        &ctx,
        &json!({
            "operation_id":"create-dependency-term", "kind":"term", "name":"合成依赖词条",
            "body":"尚无来源解释", "related_ids":[], "source_url":null,
            "structured_value":null
        }),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let owner = object["id"].as_str().unwrap().to_owned();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let without_sources =
        knowledge::dependency_index::effective_required_in_tx(&mut tx, &[(owner.clone(), 1)])
            .await
            .unwrap();
    assert!(without_sources.is_empty(), "无来源内容不登记依赖行");
    tx.commit().await.unwrap();

    // 整理成果登记建议陈述：原文引用与知识支持进入有效必要依赖。
    let citation = json!({"source":{"kind":"document","id":"dependency-guide"},
        "revision":"1","locator":{"offset":12,"length":8}});
    let result = json!({"statements":[{
        "key":"guide-rule", "target":{"object_id":owner,"version":"1","path":"body"},
        "text":"合成依赖规则正文", "scope_text":"适用范围：依赖索引验收",
        "citations":[citation], "supports":[{"key":"precondition", "role":"prerequisite",
            "reference":{"kind":"knowledge","ref":{"object_id":"term-precondition","version":"4","path":"meaning"}},
            "content":"前置词条定义", "embedded_in":null}]
    }],"relations":[],"unresolved":[],"semantic_status":"ready"});
    let source = contracts::decode("SourceKey", citation["source"].clone()).unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let saved = knowledge::apply_preparation_in_tx(
        &mut tx,
        &ctx,
        "dependency-apply",
        &source,
        "1",
        &result,
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let prepared_version = saved[0]["version"]
        .as_str()
        .unwrap()
        .parse::<u64>()
        .unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let prepared = knowledge::dependency_index::effective_required_in_tx(
        &mut tx,
        &[(owner.clone(), prepared_version)],
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    assert!(
        prepared.is_empty(),
        "人工正文仍有效时，模型建议的引用不参与语义有效性"
    );

    // 反向索引按目标返回依赖者，不依赖对象装配。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let dependents = knowledge::dependency_index::dependents_in_tx(
        &mut tx,
        &ctx.space_id,
        "document",
        "dependency-guide",
        None,
        50,
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(dependents.len(), 1);
    assert_eq!(dependents[0].owner_id, owner);
    assert_eq!(dependents[0].owner_version, prepared_version);
    assert_eq!(dependents[0].role, "citation");
    assert!(!dependents[0].effective, "建议尚未采纳，登记但无效");

    // 人工清除覆盖即采纳模型建议：建议层成为有效层，引用与支持进入必要依赖。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let adopted = knowledge::save_edit_in_tx(
        &mut tx,
        &ctx,
        &owner,
        &json!({"operation_id":"adopt-dependency-suggestion","expected_version":prepared_version.to_string(),
            "entry_id":"body","clear_override":true}),
        None,
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let adopted_version = adopted["version"].as_str().unwrap().parse::<u64>().unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let effective = knowledge::dependency_index::effective_required_in_tx(
        &mut tx,
        &[(owner.clone(), adopted_version)],
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(
        effective
            .iter()
            .map(|row| (
                row.role.as_str(),
                row.target_kind.as_str(),
                row.target_id.as_str(),
                row.target_revision
            ))
            .collect::<Vec<_>>(),
        vec![
            ("citation", "document", "dependency-guide", 1),
            ("support", "knowledge", "term-precondition", 4),
        ],
        "采纳建议后原文引用与知识支持都成为有效必要依赖"
    );
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let adopted_dependents = knowledge::dependency_index::dependents_in_tx(
        &mut tx,
        &ctx.space_id,
        "document",
        "dependency-guide",
        None,
        50,
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    assert!(
        adopted_dependents
            .iter()
            .any(|row| row.owner_version == adopted_version && row.effective)
    );

    // 分页用(owner,version)复合游标：同一owner多个修订行按页推进不漏行。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let page_one = knowledge::dependency_index::dependents_in_tx(
        &mut tx,
        &ctx.space_id,
        "document",
        "dependency-guide",
        None,
        1,
    )
    .await
    .unwrap();
    let page_two = knowledge::dependency_index::dependents_in_tx(
        &mut tx,
        &ctx.space_id,
        "document",
        "dependency-guide",
        Some((page_one[0].owner_id.as_str(), page_one[0].owner_version)),
        1,
    )
    .await
    .unwrap();
    let page_three = knowledge::dependency_index::dependents_in_tx(
        &mut tx,
        &ctx.space_id,
        "document",
        "dependency-guide",
        page_two
            .last()
            .map(|row| (row.owner_id.as_str(), row.owner_version)),
        1,
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(page_one.len(), 1);
    assert_eq!(page_two.len(), 1);
    assert!(
        page_one[0].owner_id == page_two[0].owner_id
            && page_one[0].owner_version < page_two[0].owner_version,
        "同owner跨修订行靠版本游标推进"
    );
    assert!(page_three.is_empty(), "两行依赖恰好分两页取完");

    // 同(owner,version)指向同一目标的并列行（不同entry_path）必须整对同页返回；
    // 行级复合游标会把并列行截断在页界后整组跳过。直接补登一行构造并列验证。
    sqlx::query(
        "INSERT INTO knowledge_dependencies(owner_id,owner_version,space_id,entry_path,layer,purpose,role,effective,target_kind,target_id,target_revision,target_path) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(&owner)
    .bind(adopted_version)
    .bind(&ctx.space_id)
    .bind("meaning")
    .bind("model_suggestion")
    .bind("required")
    .bind("citation")
    .bind(false)
    .bind("document")
    .bind("dependency-guide")
    .bind(1)
    .bind("")
    .execute(&pool)
    .await
    .unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let tie_page_one = knowledge::dependency_index::dependents_in_tx(
        &mut tx,
        &ctx.space_id,
        "document",
        "dependency-guide",
        None,
        1,
    )
    .await
    .unwrap();
    let tie_page_two = knowledge::dependency_index::dependents_in_tx(
        &mut tx,
        &ctx.space_id,
        "document",
        "dependency-guide",
        Some((
            tie_page_one[0].owner_id.as_str(),
            tie_page_one[0].owner_version,
        )),
        1,
    )
    .await
    .unwrap();
    let tie_page_three = knowledge::dependency_index::dependents_in_tx(
        &mut tx,
        &ctx.space_id,
        "document",
        "dependency-guide",
        tie_page_two
            .last()
            .map(|row| (row.owner_id.as_str(), row.owner_version)),
        1,
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(tie_page_one.len(), 1, "limit按(owner,version)对计数");
    assert_eq!(tie_page_two.len(), 2, "并列行整对同页返回，不被页界截断");
    assert!(
        tie_page_two
            .iter()
            .all(|row| row.owner_version == adopted_version)
    );
    assert!(tie_page_two.iter().any(|row| row.entry_path == "meaning"));
    assert!(tie_page_three.is_empty(), "并列对取完即到末页");

    // 人工完全替换：旧层行保留为历史，但当前版本不再有有效必要依赖。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let replaced = knowledge::save_edit_in_tx(
        &mut tx,
        &ctx,
        &owner,
        &json!({"operation_id":"replace-dependency-term","expected_version":adopted_version.to_string(),
            "entry_id":"body","value":"人工完全替换的口径","structured_value":null}),
        None,
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let replaced_version = replaced["version"]
        .as_str()
        .unwrap()
        .parse::<u64>()
        .unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let after_replacement = knowledge::dependency_index::effective_required_in_tx(
        &mut tx,
        &[(owner.clone(), replaced_version)],
    )
    .await
    .unwrap();
    assert!(
        after_replacement.is_empty(),
        "人工完全替换后的当前版本没有仍有效的来源依据"
    );
    let adopted_history = knowledge::dependency_index::effective_required_in_tx(
        &mut tx,
        &[(owner.clone(), adopted_version)],
    )
    .await
    .unwrap();
    assert_eq!(adopted_history.len(), 2, "旧修订的依赖行按原版本保留");
    tx.commit().await.unwrap();
}

// 传递游走：A(support→B)→B(citation→文档D)。D改版后从A出发一次调用即报stale，
// 不等扇出作业更新B；互相引用的知识对象靠已见集合终止；采纳的陈述没有可映射
// 依据时链路成员报unknown，不当空链。
#[tokio::test]
async fn transitive_walk_finds_source_change_immediately_and_stops_cycles() {
    let _guard = SERIAL.lock().await;
    let pool = harness_pool().await;
    let ctx = AccessContext {
        user_id: "alice".into(),
        space_id: "demo".into(),
        request_id: "synthetic-dependency-walk".into(),
    };
    let prepare = |statement_target: &str, citation: Value, support: Value| {
        json!({"statements":[{
            "key":"walk-statement", "target":{"object_id":statement_target,"version":"1","path":"body"},
            "text":"传递游走合成陈述", "scope_text":"适用范围：传递游走验收",
            "citations":citation.as_array().cloned().unwrap_or_default(),
            "supports":support.as_array().cloned().unwrap_or_default()
        }],"relations":[],"unresolved":[],"semantic_status":"ready"})
    };
    let adopt = |operation: &str, version: u64| {
        json!({"operation_id":operation,"expected_version":version.to_string(),
            "entry_id":"body","clear_override":true})
    };

    // D：真实文档对象，B的陈述引用其首版；整理成果的出处必须绑定该来源。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let document = knowledge::create_in_tx(
        &mut tx,
        &ctx,
        &json!({
            "operation_id":"create-walk-guide", "kind":"document", "name":"传递游走口径指南",
            "body":"# 指南\n\n首版口径", "related_ids":[], "source_url":null,
            "structured_value":null
        }),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let guide = document["id"].as_str().unwrap().to_owned();
    // 锚点文档：作为其余整理成果的出处且永不改版，链路失配只可能来自指南D。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let anchor = knowledge::create_in_tx(
        &mut tx,
        &ctx,
        &json!({
            "operation_id":"create-walk-anchor", "kind":"document", "name":"传递游走锚点文档",
            "body":"# 锚点\n\n稳定口径", "related_ids":[], "source_url":null,
            "structured_value":null
        }),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let anchor_id = anchor["id"].as_str().unwrap().to_owned();
    let anchor_source = json!({"kind":"document","id":&anchor_id});
    let anchor_citation = json!([{"source":{"kind":"document","id":&anchor_id},
        "revision":"1","locator":{"offset":6,"length":4}}]);

    // B：整理成果引用文档D首版，采纳后进入有效必要依赖。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let citing = knowledge::create_in_tx(
        &mut tx,
        &ctx,
        &json!({
            "operation_id":"create-walk-citing", "kind":"term", "name":"引用指南的词条",
            "body":"待整理", "related_ids":[], "source_url":null, "structured_value":null
        }),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let citing_id = citing["id"].as_str().unwrap().to_owned();
    let citation = json!([{"source":{"kind":"document","id":&guide},
        "revision":"1","locator":{"offset":8,"length":4}}]);
    let mut tx = AppTx::begin(&pool).await.unwrap();
    knowledge::apply_preparation_in_tx(
        &mut tx,
        &ctx,
        "walk-apply-citing",
        &contracts::decode("SourceKey", json!({"kind":"document","id":&guide})).unwrap(),
        "1",
        &prepare(&citing_id, citation.clone(), json!([])),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let adopted_citing = knowledge::save_edit_in_tx(
        &mut tx,
        &ctx,
        &citing_id,
        &adopt("walk-adopt-citing", 2),
        None,
    )
    .await
    .unwrap();
    register_saved_in_tx(&mut tx, &ctx, std::slice::from_ref(&adopted_citing)).await;
    tx.commit().await.unwrap();
    let citing_version = adopted_citing["version"]
        .as_str()
        .unwrap()
        .parse::<u64>()
        .unwrap();
    assert_eq!(citing_version, 3);

    // A：采纳的陈述支持词条B并引用稳定的锚点文档，不直接依赖指南D。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let upstream = knowledge::create_in_tx(
        &mut tx,
        &ctx,
        &json!({
            "operation_id":"create-walk-upstream", "kind":"term", "name":"上游支持词条",
            "body":"待整理", "related_ids":[], "source_url":null, "structured_value":null
        }),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let upstream_id = upstream["id"].as_str().unwrap().to_owned();
    let support = json!([{"key":"citing-ref", "role":"prerequisite",
        "reference":{"kind":"knowledge","ref":{"object_id":&citing_id,
            "version":citing_version.to_string(),"path":"body"}},
        "content":"下游词条口径", "embedded_in":null}]);
    let mut tx = AppTx::begin(&pool).await.unwrap();
    knowledge::apply_preparation_in_tx(
        &mut tx,
        &ctx,
        "walk-apply-upstream",
        &contracts::decode("SourceKey", anchor_source.clone()).unwrap(),
        "1",
        &prepare(&upstream_id, anchor_citation.clone(), support),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let adopted_upstream = knowledge::save_edit_in_tx(
        &mut tx,
        &ctx,
        &upstream_id,
        &adopt("walk-adopt-upstream", 2),
        None,
    )
    .await
    .unwrap();
    register_saved_in_tx(&mut tx, &ctx, std::slice::from_ref(&adopted_upstream)).await;
    tx.commit().await.unwrap();
    let upstream_version = adopted_upstream["version"]
        .as_str()
        .unwrap()
        .parse::<u64>()
        .unwrap();
    assert_eq!(upstream_version, 3);

    // 链路当前一致：A→B→D(1) 全部匹配，无失效无未知。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let clean = data_agent::use_cases::dependency_validation::walk_required_in_tx(
        &mut tx,
        &ctx.space_id,
        &[(upstream_id.clone(), upstream_version)],
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    assert!(
        clean.stale.is_empty() && clean.unknown.is_empty(),
        "链路一致时游走干净 stale={:?} unknown={:?}",
        clean.stale,
        clean.unknown
    );

    // 中间对象仅同文确认升版，A仍须沿原B修订核其必要来源，不能因正文指纹相等停止游走。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let resaved_citing = knowledge::save_edit_in_tx(&mut tx, &ctx, &citing_id,
        &json!({"operation_id":"walk-resave-citing","expected_version":citing_version.to_string(),
            "entry_id":"body","value":adopted_citing["entries"][0]["effective_value"],"structured_value":null}),None).await.unwrap();
    register_saved_in_tx(&mut tx, &ctx, std::slice::from_ref(&resaved_citing)).await;
    tx.commit().await.unwrap();
    assert_eq!(
        resaved_citing["entries"][0]["effective_value"],
        adopted_citing["entries"][0]["effective_value"]
    );
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let unchanged = data_agent::use_cases::dependency_validation::walk_required_in_tx(
        &mut tx,
        &ctx.space_id,
        &[(upstream_id.clone(), upstream_version)],
    )
    .await
    .unwrap();
    assert!(unchanged.stale.is_empty() && unchanged.unknown.is_empty());
    tx.commit().await.unwrap();

    // D改版（编辑正文推进修订）：不等扇出作业，从A出发立即看到B的依据失效。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    knowledge::save_edit_in_tx(
        &mut tx,
        &ctx,
        &guide,
        &json!({"operation_id":"walk-edit-guide","expected_version":"1",
            "entry_id":"body","value":"# 指南\n\n改版后的口径","structured_value":null}),
        None,
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let stale = data_agent::use_cases::dependency_validation::walk_required_in_tx(
        &mut tx,
        &ctx.space_id,
        &[(upstream_id.clone(), upstream_version)],
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(
        stale
            .stale
            .iter()
            .map(|row| (
                row.owner_id.as_str(),
                row.target_kind.as_str(),
                row.target_id.as_str(),
                row.registered_revision,
                row.current_revision
            ))
            .collect::<Vec<_>>(),
        vec![(citing_id.as_str(), "document", guide.as_str(), 1, Some(2))],
        "D改版后A的下游B立即失效，登记修订1、当前修订2"
    );
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let self_clean = data_agent::use_cases::dependency_validation::walk_required_in_tx(
        &mut tx,
        &ctx.space_id,
        &[(guide.clone(), 2)],
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    assert!(
        self_clean.stale.is_empty() && self_clean.unknown.is_empty(),
        "文档自引陈述不参与游走：改版后从自身新版本出发必须干净，否则重整理读取死锁"
    );

    // 互相支持的知识对象：E1↔E2引用彼此最终版本，游走靠已见集合终止。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let first = knowledge::create_in_tx(
        &mut tx,
        &ctx,
        &json!({
            "operation_id":"create-walk-cycle-a", "kind":"term", "name":"环成员一",
            "body":"待整理", "related_ids":[], "source_url":null, "structured_value":null
        }),
    )
    .await
    .unwrap();
    let second = knowledge::create_in_tx(
        &mut tx,
        &ctx,
        &json!({
            "operation_id":"create-walk-cycle-b", "kind":"term", "name":"环成员二",
            "body":"待整理", "related_ids":[], "source_url":null, "structured_value":null
        }),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let cycle_ids = (
        first["id"].as_str().unwrap().to_owned(),
        second["id"].as_str().unwrap().to_owned(),
    );
    // 双方最终版本都是3（应用推进一次、采纳推进一次），引用按终版互指。
    for (operation, target, other) in [
        ("walk-apply-cycle-a", &cycle_ids.0, &cycle_ids.1),
        ("walk-apply-cycle-b", &cycle_ids.1, &cycle_ids.0),
    ] {
        let mutual = json!([{"key":"mutual", "role":"prerequisite",
            "reference":{"kind":"knowledge","ref":{"object_id":other,
                "version":"3","path":"body"}},
            "content":"环成员口径", "embedded_in":null}]);
        let mut tx = AppTx::begin(&pool).await.unwrap();
        knowledge::apply_preparation_in_tx(
            &mut tx,
            &ctx,
            operation,
            &contracts::decode("SourceKey", anchor_source.clone()).unwrap(),
            "1",
            &prepare(target, anchor_citation.clone(), mutual),
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();
    }
    for (operation, id) in [
        ("walk-adopt-cycle-a", &cycle_ids.0),
        ("walk-adopt-cycle-b", &cycle_ids.1),
    ] {
        let mut tx = AppTx::begin(&pool).await.unwrap();
        knowledge::save_edit_in_tx(&mut tx, &ctx, id, &adopt(operation, 2), None)
            .await
            .unwrap();
        tx.commit().await.unwrap();
    }
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let cycled = data_agent::use_cases::dependency_validation::walk_required_in_tx(
        &mut tx,
        &ctx.space_id,
        &[(cycle_ids.0.clone(), 3)],
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    assert!(
        cycled.stale.is_empty() && cycled.unknown.is_empty(),
        "环成员互指终版：游走终止且无失效"
    );

    // 迁移前的旧成果：采纳的自动陈述没有任何索引行（视为无映射），链路成员报
    // unknown，不得当作已知无依赖。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let unmapped = knowledge::create_in_tx(
        &mut tx,
        &ctx,
        &json!({
            "operation_id":"create-walk-unmapped", "kind":"term", "name":"无依据词条",
            "body":"待整理", "related_ids":[], "source_url":null, "structured_value":null
        }),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let unmapped_id = unmapped["id"].as_str().unwrap().to_owned();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    knowledge::apply_preparation_in_tx(
        &mut tx,
        &ctx,
        "walk-apply-unmapped",
        &contracts::decode("SourceKey", anchor_source.clone()).unwrap(),
        "1",
        &prepare(&unmapped_id, anchor_citation.clone(), json!([])),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    knowledge::save_edit_in_tx(
        &mut tx,
        &ctx,
        &unmapped_id,
        &adopt("walk-adopt-unmapped", 2),
        None,
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    // 模拟迁移前数据：清掉该对象的索引行与映射状态，读取侧必须按unknown处理。
    sqlx::query("DELETE FROM knowledge_dependencies WHERE owner_id=?")
        .bind(&unmapped_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM knowledge_dependency_states WHERE owner_id=?")
        .bind(&unmapped_id)
        .execute(&pool)
        .await
        .unwrap();

    let mut tx = AppTx::begin(&pool).await.unwrap();
    let referencing = knowledge::create_in_tx(
        &mut tx,
        &ctx,
        &json!({
            "operation_id":"create-walk-referencing", "kind":"term", "name":"引用无依据词条",
            "body":"待整理", "related_ids":[], "source_url":null, "structured_value":null
        }),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let referencing_id = referencing["id"].as_str().unwrap().to_owned();
    let unmapped_support = json!([{"key":"unmapped-ref", "role":"prerequisite",
        "reference":{"kind":"knowledge","ref":{"object_id":&unmapped_id,
            "version":"3","path":"body"}},
        "content":"无依据词条口径", "embedded_in":null}]);
    let mut tx = AppTx::begin(&pool).await.unwrap();
    knowledge::apply_preparation_in_tx(
        &mut tx,
        &ctx,
        "walk-apply-referencing",
        &contracts::decode("SourceKey", anchor_source.clone()).unwrap(),
        "1",
        &prepare(&referencing_id, anchor_citation.clone(), unmapped_support),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let adopted_referencing = knowledge::save_edit_in_tx(
        &mut tx,
        &ctx,
        &referencing_id,
        &adopt("walk-adopt-referencing", 2),
        None,
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let referencing_version = adopted_referencing["version"]
        .as_str()
        .unwrap()
        .parse::<u64>()
        .unwrap();

    let mut tx = AppTx::begin(&pool).await.unwrap();
    let unknown = data_agent::use_cases::dependency_validation::walk_required_in_tx(
        &mut tx,
        &ctx.space_id,
        &[(referencing_id, referencing_version)],
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    assert!(
        unknown.unknown.contains(&(unmapped_id.clone(), 3)),
        "支持指向无映射成果时，该链路成员报unknown而非空链"
    );
    assert!(unknown.stale.is_empty(), "无版本变化时unknown链不产生stale");
}

// 历史展示核验（04切片7关闭审查修复）：上游普通改版（仍有当前修订）不隐藏已存
// 引用，严格核验照旧失败；上游被停用（走查stale且无当前修订）按撤权拒绝，
// 历史展示不复活派生内容。
#[tokio::test]
async fn history_check_tolerates_upstream_revision_but_not_revocation() {
    let _guard = SERIAL.lock().await;
    let pool = harness_pool().await;
    let ctx = AccessContext {
        user_id: "alice".into(),
        space_id: "demo".into(),
        request_id: "synthetic-history-check".into(),
    };
    let prepare = |statement_target: &str, citation: Value| {
        json!({"statements":[{
            "key":"history-statement", "target":{"object_id":statement_target,"version":"1","path":"body"},
            "text":"历史核验合成陈述", "scope_text":"适用范围：历史核验验收",
            "citations":citation.as_array().cloned().unwrap_or_default(), "supports":[]
        }],"relations":[],"unresolved":[],"semantic_status":"ready"})
    };

    // D：被引用的正式文档；B：词条，采纳的陈述引用D首版并进入有效必要依赖。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let guide = knowledge::create_in_tx(
        &mut tx,
        &ctx,
        &json!({
            "operation_id":"create-history-guide", "kind":"document", "name":"历史核验口径指南",
            "body":"# 指南\n\n首版口径", "related_ids":[], "source_url":null,
            "structured_value":null
        }),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let guide_id = guide["id"].as_str().unwrap().to_owned();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let citing = knowledge::create_in_tx(
        &mut tx,
        &ctx,
        &json!({
            "operation_id":"create-history-citing", "kind":"term", "name":"历史核验词条",
            "body":"待整理", "related_ids":[], "source_url":null, "structured_value":null
        }),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let citing_id = citing["id"].as_str().unwrap().to_owned();
    let citation = json!([{"source":{"kind":"document","id":&guide_id},"revision":"1","locator":{"offset":8,"length":4}}]);
    let mut tx = AppTx::begin(&pool).await.unwrap();
    knowledge::apply_preparation_in_tx(
        &mut tx,
        &ctx,
        "history-apply-citing",
        &contracts::decode("SourceKey", json!({"kind":"document","id":&guide_id})).unwrap(),
        "1",
        &prepare(&citing_id, citation),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let adopted = knowledge::save_edit_in_tx(
        &mut tx,
        &ctx,
        &citing_id,
        &json!({"operation_id":"history-adopt-citing","expected_version":"2",
            "entry_id":"body","clear_override":true}),
        None,
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(adopted["version"], "3");
    let reference = json!([{"object_id": citing_id, "version": "3", "path": "body"}]);

    // 基线：链路一致，历史核验与严格核验都通过。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    data_agent::use_cases::knowledge::history_check_refs_in_tx(&mut tx, &ctx, &reference)
        .await
        .unwrap();
    data_agent::use_cases::knowledge::check_refs_in_tx(&mut tx, &ctx, &reference)
        .await
        .unwrap();
    tx.commit().await.unwrap();

    // D普通改版：严格核验按当前版本失败；历史核验容忍修订推进（上游仍有当前
    // 修订），已存引用不隐藏。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    knowledge::save_edit_in_tx(
        &mut tx,
        &ctx,
        &guide_id,
        &json!({"operation_id":"history-edit-guide","expected_version":"1",
            "entry_id":"body","value":"# 指南\n\n改版后的口径","structured_value":null}),
        None,
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let strict = data_agent::use_cases::knowledge::check_refs_in_tx(&mut tx, &ctx, &reference)
        .await
        .unwrap_err();
    tx.commit().await.unwrap();
    assert_eq!(strict.code, "stale_knowledge");
    let mut tx = AppTx::begin(&pool).await.unwrap();
    data_agent::use_cases::knowledge::history_check_refs_in_tx(&mut tx, &ctx, &reference)
        .await
        .unwrap();
    tx.commit().await.unwrap();

    // D停用：上游已无当前修订，历史核验按not_available拒绝——撤权不借历史复活。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    knowledge::change_state_in_tx(
        &mut tx,
        &ctx,
        &guide_id,
        &json!({"operation_id":"history-disable-guide","expected_version":"2"}),
        "disabled",
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let revoked =
        data_agent::use_cases::knowledge::history_check_refs_in_tx(&mut tx, &ctx, &reference)
            .await
            .unwrap_err();
    tx.commit().await.unwrap();
    assert_eq!(revoked.code, "not_available");

    // 独立人工内容的完整空来源索引足够核权，历史读取不额外依赖旧正文。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let independent = knowledge::create_in_tx(
        &mut tx,
        &ctx,
        &json!({"operation_id":"history-independent-create", "kind":"term",
            "name":"独立人工历史词条", "body":"人工独立写出的原口径", "related_ids":[],
            "source_url":null, "structured_value":null}),
    )
    .await
    .unwrap();
    let independent_id = independent["id"].as_str().unwrap();
    tx.commit().await.unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    knowledge::save_edit_in_tx(
        &mut tx,
        &ctx,
        independent_id,
        &json!({"operation_id":"history-independent-revise", "expected_version":"1",
            "entry_id":"body", "value":"人工独立写出的新口径", "structured_value":null}),
        None,
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    sqlx::query("DELETE FROM knowledge_versions WHERE object_id=?")
        .bind(independent_id)
        .execute(&pool)
        .await
        .unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    data_agent::use_cases::knowledge::history_check_refs_in_tx(
        &mut tx,
        &ctx,
        &json!([{"object_id":independent_id,"version":"1","path":"body"}]),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
}

// legacy回退（无依赖索引状态的迁移前存档，04关闭第三轮审查修复）：迁移前
// 存档没有可回填的索引行，传递撤权必须在回退内就地检出——A(支持B、引用
// 锚点)→B(引用指南D)：删除A的映射状态行后，D停用经B传递仍拒绝；D普通改版
// 不隐藏已存记录；B自身撤下同样拒绝。
#[tokio::test]
async fn legacy_fallback_without_index_rows_covers_transitive_revocation() {
    let _guard = SERIAL.lock().await;
    let pool = harness_pool().await;
    let ctx = AccessContext {
        user_id: "alice".into(),
        space_id: "demo".into(),
        request_id: "synthetic-legacy-fallback".into(),
    };
    let prepare = |statement_target: &str, citation: Value, support: Value| {
        json!({"statements":[{
            "key":"legacy-statement", "target":{"object_id":statement_target,"version":"1","path":"body"},
            "text":"legacy回退合成陈述", "scope_text":"适用范围：legacy回退验收",
            "citations":citation.as_array().cloned().unwrap_or_default(),
            "supports":support.as_array().cloned().unwrap_or_default()
        }],"relations":[],"unresolved":[],"semantic_status":"ready"})
    };
    let adopt = |operation: &str, version: u64| {
        json!({"operation_id":operation,"expected_version":version.to_string(),
            "entry_id":"body","clear_override":true})
    };
    let source_key =
        |id: &str| contracts::decode("SourceKey", json!({"kind":"document","id":id})).unwrap();
    let citation = |id: &str| {
        json!([{"source":{"kind":"document","id":id},
            "revision":"1","locator":{"offset":6,"length":4}}])
    };
    let create = |operation: &str, kind: &str, name: &str, body: &str| {
        json!({"operation_id":operation, "kind":kind, "name":name,
            "body":body, "related_ids":[], "source_url":null, "structured_value":null})
    };

    let mut tx = AppTx::begin(&pool).await.unwrap();
    let anchor = knowledge::create_in_tx(
        &mut tx,
        &ctx,
        &create(
            "create-legacy-anchor",
            "document",
            "legacy锚点文档",
            "# 锚点\n\n稳定口径",
        ),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let anchor_id = anchor["id"].as_str().unwrap().to_owned();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let guide = knowledge::create_in_tx(
        &mut tx,
        &ctx,
        &create(
            "create-legacy-guide",
            "document",
            "legacy指南文档",
            "# 指南\n\n首版口径",
        ),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let guide_id = guide["id"].as_str().unwrap().to_owned();

    // B：采纳的陈述引用指南D首版。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let citing = knowledge::create_in_tx(
        &mut tx,
        &ctx,
        &create("create-legacy-citing", "term", "legacy引用词条", "待整理"),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let citing_id = citing["id"].as_str().unwrap().to_owned();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    knowledge::apply_preparation_in_tx(
        &mut tx,
        &ctx,
        "legacy-apply-citing",
        &source_key(&guide_id),
        "1",
        &prepare(&citing_id, citation(&guide_id), json!([])),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let adopted_citing = knowledge::save_edit_in_tx(
        &mut tx,
        &ctx,
        &citing_id,
        &adopt("legacy-adopt-citing", 2),
        None,
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let citing_version = adopted_citing["version"]
        .as_str()
        .unwrap()
        .parse::<u64>()
        .unwrap();

    // A：采纳的陈述引用锚点并支持B，自身不直接引用指南。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let upstream = knowledge::create_in_tx(
        &mut tx,
        &ctx,
        &create("create-legacy-upstream", "term", "legacy上游词条", "待整理"),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let upstream_id = upstream["id"].as_str().unwrap().to_owned();
    let support = json!([{"key":"legacy-citing-ref", "role":"prerequisite",
        "reference":{"kind":"knowledge","ref":{"object_id":&citing_id,
            "version":citing_version.to_string(),"path":"body"}},
        "content":"下游词条口径", "embedded_in":null}]);
    let mut tx = AppTx::begin(&pool).await.unwrap();
    knowledge::apply_preparation_in_tx(
        &mut tx,
        &ctx,
        "legacy-apply-upstream",
        &source_key(&anchor_id),
        "1",
        &prepare(&upstream_id, citation(&anchor_id), support),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let adopted_upstream = knowledge::save_edit_in_tx(
        &mut tx,
        &ctx,
        &upstream_id,
        &adopt("legacy-adopt-upstream", 2),
        None,
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let upstream_version = adopted_upstream["version"]
        .as_str()
        .unwrap()
        .parse::<u64>()
        .unwrap();
    let reference = json!([{"object_id": &upstream_id, "version": upstream_version.to_string(), "path": "body"}]);

    // 基线：索引在位时历史核验通过。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    data_agent::use_cases::knowledge::history_check_refs_in_tx(&mut tx, &ctx, &reference)
        .await
        .unwrap();
    tx.commit().await.unwrap();

    // 删除A的映射状态行模拟迁移前存档（无索引可走），回退接管且链路完好时通过。
    sqlx::query("DELETE FROM knowledge_dependency_states WHERE owner_id=? AND owner_version=?")
        .bind(&upstream_id)
        .bind(upstream_version)
        .execute(&pool)
        .await
        .unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    data_agent::use_cases::knowledge::history_check_refs_in_tx(&mut tx, &ctx, &reference)
        .await
        .unwrap();
    tx.commit().await.unwrap();

    // D普通改版：回退只核当前头存在性，版本推进容忍——已存记录不隐藏。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let edited_guide = knowledge::save_edit_in_tx(
        &mut tx,
        &ctx,
        &guide_id,
        &json!({"operation_id":"legacy-edit-guide","expected_version":"1",
            "entry_id":"body","value":"# 指南\n\n改版后的口径","structured_value":null}),
        None,
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let guide_version = edited_guide["version"]
        .as_str()
        .unwrap()
        .parse::<u64>()
        .unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    data_agent::use_cases::knowledge::history_check_refs_in_tx(&mut tx, &ctx, &reference)
        .await
        .unwrap();
    tx.commit().await.unwrap();

    // D停用：撤权经B传递到A——legacy回退必须递归检出，不能只核直接引用层。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let disabled_guide = knowledge::change_state_in_tx(
        &mut tx,
        &ctx,
        &guide_id,
        &json!({"operation_id":"legacy-disable-guide",
            "expected_version":guide_version.to_string()}),
        "disabled",
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let transitive =
        data_agent::use_cases::knowledge::history_check_refs_in_tx(&mut tx, &ctx, &reference)
            .await
            .unwrap_err();
    tx.commit().await.unwrap();
    assert_eq!(transitive.code, "not_available");

    // 恢复D后B自身撤下：知识支持对象的撤下同样拒绝。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    knowledge::change_state_in_tx(
        &mut tx,
        &ctx,
        &guide_id,
        &json!({"operation_id":"legacy-enable-guide",
            "expected_version":disabled_guide["version"].as_str().unwrap()}),
        "enabled",
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    knowledge::change_state_in_tx(
        &mut tx,
        &ctx,
        &citing_id,
        &json!({"operation_id":"legacy-disable-citing",
            "expected_version":citing_version.to_string()}),
        "disabled",
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let support_revoked =
        data_agent::use_cases::knowledge::history_check_refs_in_tx(&mut tx, &ctx, &reference)
            .await
            .unwrap_err();
    tx.commit().await.unwrap();
    assert_eq!(support_revoked.code, "not_available");
}

// 实际贡献根：A(引用锚点+支持B)→B(引用指南D)的来源闭包包含锚点与D；related用途的
// 平台来源与文档自引同样计入（不能只取required）；人工完全替换后旧标签不进闭包、
// 根可证为空；链路成员无映射状态时按unknown报告（含根自身），不当空集合放行。
#[tokio::test]
async fn contribution_roots_close_over_effective_sources_and_flag_unproven_members() {
    let _guard = SERIAL.lock().await;
    let pool = harness_pool().await;
    let ctx = AccessContext {
        user_id: "alice".into(),
        space_id: "demo".into(),
        request_id: "synthetic-contribution-roots".into(),
    };
    let prepare = |statement_target: &str, citation: Value, support: Value| {
        json!({"statements":[{
            "key":"roots-statement", "target":{"object_id":statement_target,"version":"1","path":"body"},
            "text":"贡献根合成陈述", "scope_text":"适用范围：贡献根验收",
            "citations":citation.as_array().cloned().unwrap_or_default(),
            "supports":support.as_array().cloned().unwrap_or_default()
        }],"relations":[],"unresolved":[],"semantic_status":"ready"})
    };
    let adopt = |operation: &str, version: u64| {
        json!({"operation_id":operation,"expected_version":version.to_string(),
            "entry_id":"body","clear_override":true})
    };
    let source_key =
        |id: &str| contracts::decode("SourceKey", json!({"kind":"document","id":id})).unwrap();
    let citation = |id: &str| {
        json!([{"source":{"kind":"document","id":id},
            "revision":"1","locator":{"offset":6,"length":4}}])
    };

    // 锚点文档与指南文档：锚点永不被整理引用自身以外的内容，闭包断言只受指南影响。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let anchor = knowledge::create_in_tx(
        &mut tx,
        &ctx,
        &json!({
            "operation_id":"create-roots-anchor", "kind":"document", "name":"贡献根锚点文档",
            "body":"# 锚点\n\n稳定口径", "related_ids":[], "source_url":null,
            "structured_value":null
        }),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let anchor_id = anchor["id"].as_str().unwrap().to_owned();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let guide = knowledge::create_in_tx(
        &mut tx,
        &ctx,
        &json!({
            "operation_id":"create-roots-guide", "kind":"document", "name":"贡献根指南文档",
            "body":"# 指南\n\n首版口径", "related_ids":[], "source_url":null,
            "structured_value":null
        }),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let guide_id = guide["id"].as_str().unwrap().to_owned();

    // B：采纳的陈述引用指南D首版。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let citing = knowledge::create_in_tx(
        &mut tx,
        &ctx,
        &json!({
            "operation_id":"create-roots-citing", "kind":"term", "name":"贡献根引用词条",
            "body":"待整理", "related_ids":[], "source_url":null, "structured_value":null
        }),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let citing_id = citing["id"].as_str().unwrap().to_owned();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    knowledge::apply_preparation_in_tx(
        &mut tx,
        &ctx,
        "roots-apply-citing",
        &source_key(&guide_id),
        "1",
        &prepare(&citing_id, citation(&guide_id), json!([])),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let adopted_citing = knowledge::save_edit_in_tx(
        &mut tx,
        &ctx,
        &citing_id,
        &adopt("roots-adopt-citing", 2),
        None,
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let citing_version = adopted_citing["version"]
        .as_str()
        .unwrap()
        .parse::<u64>()
        .unwrap();

    // A：采纳的陈述引用锚点并支持B，自身不直接引用指南。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let upstream = knowledge::create_in_tx(
        &mut tx,
        &ctx,
        &json!({
            "operation_id":"create-roots-upstream", "kind":"term", "name":"贡献根上游词条",
            "body":"待整理", "related_ids":[], "source_url":null, "structured_value":null
        }),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let upstream_id = upstream["id"].as_str().unwrap().to_owned();
    let support = json!([{"key":"citing-ref", "role":"prerequisite",
        "reference":{"kind":"knowledge","ref":{"object_id":&citing_id,
            "version":citing_version.to_string(),"path":"body"}},
        "content":"下游词条口径", "embedded_in":null}]);
    let mut tx = AppTx::begin(&pool).await.unwrap();
    knowledge::apply_preparation_in_tx(
        &mut tx,
        &ctx,
        "roots-apply-upstream",
        &source_key(&anchor_id),
        "1",
        &prepare(&upstream_id, citation(&anchor_id), support),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let adopted_upstream = knowledge::save_edit_in_tx(
        &mut tx,
        &ctx,
        &upstream_id,
        &adopt("roots-adopt-upstream", 2),
        None,
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let upstream_version = adopted_upstream["version"]
        .as_str()
        .unwrap()
        .parse::<u64>()
        .unwrap();

    // 批量取根：A的闭包传递包含锚点与D；B只含其引用的D。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let roots = knowledge::dependency_index::contribution_roots_in_tx(
        &mut tx,
        &[
            (upstream_id.clone(), upstream_version),
            (citing_id.clone(), citing_version),
        ],
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(roots.len(), 2);
    let upstream_roots = roots
        .iter()
        .find(|result| result.owner_id == upstream_id)
        .unwrap();
    let citing_roots = roots
        .iter()
        .find(|result| result.owner_id == citing_id)
        .unwrap();
    let mut expected_upstream = vec![
        ("document".to_owned(), guide_id.clone()),
        ("document".to_owned(), anchor_id.clone()),
    ];
    expected_upstream.sort();
    assert_eq!(
        upstream_roots.sources, expected_upstream,
        "A经B传递取得指南D并保留自身锚点引用，闭包去重升序"
    );
    assert!(upstream_roots.unknown.is_empty());
    assert_eq!(
        citing_roots.sources,
        vec![("document".to_owned(), guide_id.clone())]
    );
    assert!(citing_roots.unknown.is_empty());

    // related用途的有效平台来源行同样计入闭包，不能只取required。
    sqlx::query(
        "INSERT INTO knowledge_dependencies(owner_id,owner_version,space_id,entry_path,layer,purpose,role,effective,target_kind,target_id,target_revision,target_path) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(&citing_id)
    .bind(citing_version)
    .bind(&ctx.space_id)
    .bind("body")
    .bind("model_suggestion")
    .bind("related")
    .bind("material")
    .bind(true)
    .bind("platform")
    .bind("platform-feed-7")
    .bind(2)
    .bind("")
    .execute(&pool)
    .await
    .unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let with_related = knowledge::dependency_index::contribution_roots_in_tx(
        &mut tx,
        &[(upstream_id.clone(), upstream_version)],
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let mut expected_with_related = vec![
        ("document".to_owned(), guide_id.clone()),
        ("document".to_owned(), anchor_id.clone()),
        ("platform".to_owned(), "platform-feed-7".to_owned()),
    ];
    expected_with_related.sort();
    assert_eq!(
        with_related[0].sources, expected_with_related,
        "related用途的有效来源行计入贡献根"
    );
    assert!(with_related[0].unknown.is_empty());

    // 推进B（人工完全替换）：贡献是按登记修订的历史事实，A的闭包不因B当前版本
    // 变化而缩小，也不下钻B的新版本。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let advanced = knowledge::save_edit_in_tx(
        &mut tx,
        &ctx,
        &citing_id,
        &json!({"operation_id":"roots-advance-citing",
            "expected_version":citing_version.to_string(),
            "entry_id":"body","value":"人工完全替换后的新口径","structured_value":null}),
        None,
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let advanced_version = advanced["version"]
        .as_str()
        .unwrap()
        .parse::<u64>()
        .unwrap();
    assert!(advanced_version > citing_version);
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let historical = knowledge::dependency_index::contribution_roots_in_tx(
        &mut tx,
        &[(upstream_id.clone(), upstream_version)],
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(
        historical[0].sources, expected_with_related,
        "B推进后A仍按登记修订闭包，不核对也不改钻B当前版本"
    );
    assert!(historical[0].unknown.is_empty());

    // 文档派生陈述引用自身文档：文档以自身为贡献根（A原文以A为来源）。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let self_prepared = knowledge::apply_preparation_in_tx(
        &mut tx,
        &ctx,
        "roots-apply-guide-self",
        &source_key(&guide_id),
        "1",
        &prepare(&guide_id, citation(&guide_id), json!([])),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let guide_version = self_prepared[0]["version"]
        .as_str()
        .unwrap()
        .parse::<u64>()
        .unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let guide_roots = knowledge::dependency_index::contribution_roots_in_tx(
        &mut tx,
        &[(guide_id.clone(), guide_version)],
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(
        guide_roots[0].sources,
        vec![("document".to_owned(), guide_id.clone())],
        "文档派生陈述以自身文档为贡献根且无其他来源"
    );
    assert!(guide_roots[0].unknown.is_empty());

    // 人工完全替换：旧source标签留在非有效层，不进闭包；新版本可证为空根。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let replaced = knowledge::save_edit_in_tx(
        &mut tx,
        &ctx,
        &upstream_id,
        &json!({"operation_id":"roots-replace-upstream",
            "expected_version":upstream_version.to_string(),
            "entry_id":"body","value":"人工完全替换的独立口径","structured_value":null}),
        None,
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let replaced_version = replaced["version"]
        .as_str()
        .unwrap()
        .parse::<u64>()
        .unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let replaced_roots = knowledge::dependency_index::contribution_roots_in_tx(
        &mut tx,
        &[(upstream_id.clone(), replaced_version)],
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    assert!(
        replaced_roots[0].sources.is_empty() && replaced_roots[0].unknown.is_empty(),
        "人工完全替换后来源闭包可证为空，旧标签不再计入"
    );

    // 把B的映射状态置unknown但保留其依赖行（部分映射对象的真实形态，区别于测试2的
    // 缺行形态）：B不可展开，其行不得计入任何闭包；A只余已知部分并如实报unknown成员；
    // B自身作为根同样不可证明，均不当空集合放行。
    sqlx::query("UPDATE knowledge_dependency_states SET mapping_state='unknown' WHERE owner_id=?")
        .bind(&citing_id)
        .execute(&pool)
        .await
        .unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let unproven = knowledge::dependency_index::contribution_roots_in_tx(
        &mut tx,
        &[
            (upstream_id.clone(), upstream_version),
            (citing_id.clone(), citing_version),
        ],
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(unproven.len(), 2);
    let unproven_upstream = unproven
        .iter()
        .find(|result| result.owner_id == upstream_id)
        .unwrap();
    let unproven_citing = unproven
        .iter()
        .find(|result| result.owner_id == citing_id)
        .unwrap();
    assert_eq!(
        unproven_upstream.sources,
        vec![("document".to_owned(), anchor_id.clone())],
        "B不可展开时A只保留自身已知来源，unknown成员的依赖行不计入闭包"
    );
    assert_eq!(
        unproven_upstream.unknown,
        vec![(citing_id.clone(), citing_version)],
        "不可展开成员如实进入unknown，闭包不完整"
    );
    assert!(unproven_citing.sources.is_empty());
    assert_eq!(
        unproven_citing.unknown,
        vec![(citing_id.clone(), citing_version)],
        "状态行为unknown时报unknown而非空根，不得按行存在与否猜"
    );

    // 互指支持成环：两个词条的采纳陈述互相支持对方终版（前者按预期终版引用），
    // 双根批量取闭包必须终止，各自只含锚点。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let first = knowledge::create_in_tx(
        &mut tx,
        &ctx,
        &json!({
            "operation_id":"create-roots-cycle-first", "kind":"term", "name":"贡献根环词条一",
            "body":"待整理", "related_ids":[], "source_url":null, "structured_value":null
        }),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let first_id = first["id"].as_str().unwrap().to_owned();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let second = knowledge::create_in_tx(
        &mut tx,
        &ctx,
        &json!({
            "operation_id":"create-roots-cycle-second", "kind":"term", "name":"贡献根环词条二",
            "body":"待整理", "related_ids":[], "source_url":null, "structured_value":null
        }),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let second_id = second["id"].as_str().unwrap().to_owned();
    let mutual = |other: &str| {
        json!([{"key":"cycle-ref", "role":"prerequisite",
            "reference":{"kind":"knowledge","ref":{"object_id":other,
                "version":"3","path":"body"}},
            "content":"互指词条口径", "embedded_in":null}])
    };
    let mut tx = AppTx::begin(&pool).await.unwrap();
    knowledge::apply_preparation_in_tx(
        &mut tx,
        &ctx,
        "roots-apply-cycle-first",
        &source_key(&anchor_id),
        "1",
        &prepare(&first_id, citation(&anchor_id), mutual(&second_id)),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let adopted_first = knowledge::save_edit_in_tx(
        &mut tx,
        &ctx,
        &first_id,
        &adopt("roots-adopt-cycle-first", 2),
        None,
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let first_version = adopted_first["version"]
        .as_str()
        .unwrap()
        .parse::<u64>()
        .unwrap();
    assert_eq!(first_version, 3);
    let mut tx = AppTx::begin(&pool).await.unwrap();
    knowledge::apply_preparation_in_tx(
        &mut tx,
        &ctx,
        "roots-apply-cycle-second",
        &source_key(&anchor_id),
        "1",
        &prepare(&second_id, citation(&anchor_id), mutual(&first_id)),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let adopted_second = knowledge::save_edit_in_tx(
        &mut tx,
        &ctx,
        &second_id,
        &adopt("roots-adopt-cycle-second", 2),
        None,
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let second_version = adopted_second["version"]
        .as_str()
        .unwrap()
        .parse::<u64>()
        .unwrap();
    assert_eq!(second_version, 3);
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let cyclic = knowledge::dependency_index::contribution_roots_in_tx(
        &mut tx,
        &[
            (first_id.clone(), first_version),
            (second_id.clone(), second_version),
        ],
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(cyclic.len(), 2);
    for result in &cyclic {
        assert_eq!(
            result.sources,
            vec![("document".to_owned(), anchor_id.clone())],
            "互指环终止，闭包只含共同锚点"
        );
        assert!(result.unknown.is_empty());
    }
}

// 人工编辑四类反例（执行包反例表）：真正替换的条目不被废弃建议阻断（assert对映射
// 完备对象只核有效层）；未替换条目与同文确认保留来源（来源变化仍失效，同文承载行
// 按人工层登记）；related用途的行不参与口径失效；同文确认前该反例在旧实现下会漏。
#[tokio::test]
async fn human_edit_kinds_separate_replacement_from_retained_sources() {
    let _guard = SERIAL.lock().await;
    let pool = harness_pool().await;
    let ctx = AccessContext {
        user_id: "alice".into(),
        space_id: "demo".into(),
        request_id: "synthetic-human-edit-kinds".into(),
    };
    let statement = |key: &str, path: &str, target: &str, version: &str, citation: Value| {
        json!({"key":key, "target":{"object_id":target,"version":version,"path":path},
            "text":if path=="body"{"正文口径的整理建议"}else{"零售域的口径"},
            "scope_text":"", "citations":citation.as_array().cloned().unwrap_or_default(),
            "supports":[]})
    };
    let prepare = |target: &str, version: &str, citation: Value| {
        json!({"statements":[
            statement("body-rule","body",target,version,citation.clone()),
            statement("domain-rule","business_domain",target,version,citation)
        ],"relations":[],"unresolved":[],"semantic_status":"ready"})
    };
    let source_key =
        |id: &str| contracts::decode("SourceKey", json!({"kind":"document","id":id})).unwrap();
    let citation = |id: &str| {
        json!([{"source":{"kind":"document","id":id},
            "revision":"1","locator":{"offset":6,"length":4}}])
    };

    // 指南文档：两个条目的建议都引用其首版，稍后改版制造来源变化。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let guide = knowledge::create_in_tx(
        &mut tx,
        &ctx,
        &json!({
            "operation_id":"create-kinds-guide", "kind":"document", "name":"编辑反例指南文档",
            "body":"# 指南\n\n首版口径", "related_ids":[], "source_url":null,
            "structured_value":null
        }),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let guide_id = guide["id"].as_str().unwrap().to_owned();

    // 词条：body人工初稿，business_domain槽位先填人工值再清除覆盖，使建议可生效。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let term = knowledge::create_in_tx(
        &mut tx,
        &ctx,
        &json!({
            "operation_id":"create-kinds-term", "kind":"term", "name":"编辑反例词条",
            "body":"人工初稿", "related_ids":[], "source_url":null, "structured_value":null
        }),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let term_id = term["id"].as_str().unwrap().to_owned();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    knowledge::save_edit_in_tx(
        &mut tx,
        &ctx,
        &term_id,
        &json!({"operation_id":"kinds-open-domain","expected_version":"1",
            "entry_id":"business_domain","value":"零售","structured_value":null}),
        None,
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    knowledge::apply_preparation_in_tx(
        &mut tx,
        &ctx,
        "kinds-apply",
        &source_key(&guide_id),
        "1",
        &prepare(&term_id, "2", citation(&guide_id)),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    for (operation, entry) in [
        ("kinds-clear-body", "body"),
        ("kinds-clear-domain", "business_domain"),
    ] {
        let mut tx = AppTx::begin(&pool).await.unwrap();
        let version = if entry == "body" { "3" } else { "4" };
        let saved = knowledge::save_edit_in_tx(
            &mut tx,
            &ctx,
            &term_id,
            &json!({"operation_id":operation,"expected_version":version,
                "entry_id":entry,"clear_override":true}),
            None,
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();
        assert_eq!(saved["entries"].as_array().unwrap().len(), 2);
    }

    // 完全替换body（真替换）：其建议引用行转为非有效。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let replaced_body = knowledge::save_edit_in_tx(
        &mut tx,
        &ctx,
        &term_id,
        &json!({"operation_id":"kinds-replace-body",
            "expected_version":"5",
            "entry_id":"body","value":"人工完全替换后的独立口径","structured_value":null}),
        None,
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let replaced_version = replaced_body["version"]
        .as_str()
        .unwrap()
        .parse::<u64>()
        .unwrap();

    // 指南改版：未替换的business_domain保留来源。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    knowledge::save_edit_in_tx(
        &mut tx,
        &ctx,
        &guide_id,
        &json!({"operation_id":"kinds-edit-guide","expected_version":"1",
            "entry_id":"body","value":"# 指南\n\n改版后的口径","structured_value":null}),
        None,
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();

    // 未替换部分保留来源：游走只报business_domain的建议行，真替换的body不阻断。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let after_replace = data_agent::use_cases::dependency_validation::walk_required_in_tx(
        &mut tx,
        &ctx.space_id,
        &[(term_id.clone(), replaced_version)],
    )
    .await
    .unwrap();
    let required = knowledge::dependency_index::effective_required_in_tx(
        &mut tx,
        &[(term_id.clone(), replaced_version)],
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(
        after_replace
            .stale
            .iter()
            .map(|row| (
                row.entry_path.as_str(),
                row.target_kind.as_str(),
                row.target_id.as_str()
            ))
            .collect::<Vec<_>>(),
        vec![("business_domain", "document", guide_id.as_str())],
        "来源变化只命中未替换条目，真替换的body不被废弃建议阻断"
    );
    assert_eq!(
        required
            .iter()
            .map(|row| (row.entry_path.as_str(), row.layer.as_str()))
            .collect::<Vec<_>>(),
        vec![("business_domain", "model_suggestion")]
    );

    // 同文确认business_domain（人工正文与建议逐字相同）：出处按人工层保留。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let current = knowledge::read_in_tx(&mut tx, &ctx, &term_id, None, true)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let domain_text = current["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["path"] == "business_domain")
        .unwrap()["suggestion"]["value"]
        .as_str()
        .unwrap()
        .to_owned();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let confirmed = knowledge::save_edit_in_tx(
        &mut tx,
        &ctx,
        &term_id,
        &json!({"operation_id":"kinds-confirm-domain",
            "expected_version":replaced_version.to_string(),
            "entry_id":"business_domain","value":domain_text,"structured_value":null}),
        None,
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let confirmed_version = confirmed["version"]
        .as_str()
        .unwrap()
        .parse::<u64>()
        .unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let confirmed_required = knowledge::dependency_index::effective_required_in_tx(
        &mut tx,
        &[(term_id.clone(), confirmed_version)],
    )
    .await
    .unwrap();
    let confirmed_walk = data_agent::use_cases::dependency_validation::walk_required_in_tx(
        &mut tx,
        &ctx.space_id,
        &[(term_id.clone(), confirmed_version)],
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(
        confirmed_required
            .iter()
            .map(|row| (
                row.entry_path.as_str(),
                row.layer.as_str(),
                row.target_id.as_str()
            ))
            .collect::<Vec<_>>(),
        vec![("business_domain", "human_override", guide_id.as_str())],
        "同文确认按人工层承载建议出处"
    );
    assert_eq!(
        confirmed_walk.stale.len(),
        1,
        "同文确认后来源变化仍然失效（保留来源）"
    );

    // 全部真替换后放行：assert只核有效层，旧建议引用不阻断。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let freed = knowledge::save_edit_in_tx(
        &mut tx,
        &ctx,
        &term_id,
        &json!({"operation_id":"kinds-replace-domain",
            "expected_version":confirmed_version.to_string(),
            "entry_id":"business_domain","value":"独立改写的业务域口径","structured_value":null}),
        None,
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let freed_version = freed["version"].as_str().unwrap().parse::<u64>().unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let freed_object = knowledge::read_in_tx(&mut tx, &ctx, &term_id, None, true)
        .await
        .unwrap();
    data_agent::use_cases::knowledge::assert_source_in_tx(&mut tx, &ctx, &freed_object)
        .await
        .unwrap();
    let freed_walk = data_agent::use_cases::dependency_validation::walk_required_in_tx(
        &mut tx,
        &ctx.space_id,
        &[(term_id.clone(), freed_version)],
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    assert!(
        freed_walk.stale.is_empty() && freed_walk.unknown.is_empty(),
        "全部真替换后无有效依赖，读取放行"
    );

    // related用途的有效行不参与口径失效：登记指向已改版指南的related行仍放行。
    sqlx::query(
        "INSERT INTO knowledge_dependencies(owner_id,owner_version,space_id,entry_path,layer,purpose,role,effective,target_kind,target_id,target_revision,target_path) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(&term_id)
    .bind(freed_version)
    .bind(&ctx.space_id)
    .bind("reference-list")
    .bind("human_override")
    .bind("related")
    .bind("citation")
    .bind(true)
    .bind("document")
    .bind(&guide_id)
    .bind(1)
    .bind("")
    .execute(&pool)
    .await
    .unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let related_object = knowledge::read_in_tx(&mut tx, &ctx, &term_id, None, true)
        .await
        .unwrap();
    data_agent::use_cases::knowledge::assert_source_in_tx(&mut tx, &ctx, &related_object)
        .await
        .unwrap();
    tx.commit().await.unwrap();
}

async fn search_stage(
    pool: &MySqlPool,
    ctx: &AccessContext,
    query: &str,
    limit: usize,
) -> data_agent::use_cases::knowledge::ScopedSearchStage {
    let checked = Default::default();
    data_agent::use_cases::knowledge::search_stage_outside_lock(
        pool,
        ctx,
        &mut data_agent::use_cases::knowledge::ScopedSearchRequest {
            query,
            limit,
            launch: None,
            vector: data_agent::modules::retrieval::vector::Candidates::lexical(),
            scope: &data_agent::search_scope::KnowledgeSearchScope::default(),
            allowed: None,
            asset_after: None,
            hints: None,
            cid: "",
            text_results: &checked,
            include_raw: false,
        },
    )
    .await
    .unwrap()
}

async fn search_object_ids(pool: &MySqlPool, ctx: &AccessContext, query: &str) -> Vec<String> {
    search_stage(pool, ctx, query, 10)
        .await
        .search
        .objects
        .iter()
        .filter_map(|object| object["id"].as_str().map(str::to_owned))
        .collect()
}

#[tokio::test]
async fn sql_search_stage_keeps_consumed_positions_separate_from_delivered_content() {
    let _guard = SERIAL.lock().await;
    let pool = harness_pool().await;
    let ctx = AccessContext {
        user_id: "alice".into(),
        space_id: "demo".into(),
        request_id: "synthetic-sql-scan-progress".into(),
    };
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let mut object = knowledge::create_in_tx(
        &mut tx,
        &ctx,
        &json!({"operation_id":"create-sql-progress", "kind":"term",
            "name":"合成扫描进度资料", "body":"sqlprogressneedle 独立原文。",
            "related_ids":[], "source_url":null, "structured_value":null}),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    object["entries"] =
        json!((0..61).map(|index| json!({
        "entry_id":format!("rule-{index:02}"),"path":format!("rule-{index:02}"),
        "label":"正文","effective_value":format!("sqlprogressneedle 合成规则第{index}条。"),
        "source_facts":{"complete":false,"gap":"独立合成扫描夹具"},
        "suggestion":{},"human_override":null,"review_state":"unverified"
    })).collect::<Vec<_>>());
    for statement in [
        "UPDATE knowledge_objects SET body=? WHERE id=?",
        "UPDATE knowledge_versions SET body=? WHERE object_id=? AND version=1",
    ] {
        sqlx::query(statement)
            .bind(sqlx::types::Json(&object))
            .bind(object["id"].as_str().unwrap())
            .execute(&pool)
            .await
            .unwrap();
    }
    let mut tx = AppTx::begin(&pool).await.unwrap();
    data_agent::modules::retrieval::index_in_tx(&mut tx, &ctx.space_id, &object)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let stage = search_stage(&pool, &ctx, "sqlprogressneedle", 1).await;
    assert_eq!(stage.search.hits.len(), 1);
    assert_eq!(
        stage.search.coverage["candidate_count"], 50,
        "两SQL owner的相同规范定位只计一次"
    );
    assert_eq!(
        stage.search.pending.len(),
        49,
        "已收但未交付的位置保留，不能按交付数推进扫描"
    );
    assert_eq!(stage.search.scan_progress["rounds"], 1);
    assert_eq!(stage.search.scan_progress["main_reads"], 1);
    let sql = stage.search.scan_progress["sql"].as_array().unwrap();
    assert_eq!(sql.len(), 2);
    for source in sql {
        assert_eq!(source["consumed"], 50, "扫描位置按各owner实际返回行数推进");
        assert_eq!(source["round"], 1);
        assert_eq!(source["succeeded"], true);
        assert_eq!(source["exhausted"], false, "达到交付limit不证明后端穷尽");
        assert_eq!(source["in_flight"], false);
    }
    let mut tx = AppTx::begin(&pool).await.unwrap();
    data_agent::use_cases::knowledge::assert_search_fresh_in_tx(&mut tx, &ctx, &stage)
        .await
        .unwrap();
    tx.commit().await.unwrap();
}

#[tokio::test]
async fn search_stage_keeps_explicit_domain_in_owner_candidates() {
    let _guard = SERIAL.lock().await;
    let pool = harness_pool().await;
    let ctx = AccessContext {
        user_id: "alice".into(),
        space_id: "demo".into(),
        request_id: "synthetic-sql-domain-scope".into(),
    };
    let scope = data_agent::search_scope::KnowledgeSearchScope {
        kinds: vec!["document".into()],
        domain: Some("合成范围🌏".into()),
        ..Default::default()
    };
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let object = knowledge::create_in_tx(
        &mut tx,
        &ctx,
        &json!({"operation_id":"create-sql-domain-scope", "kind":"document",
            "name":"sqlscopeneedle", "body":"独立合成范围内的正式正文。",
            "business_domain":"合成范围🌏", "related_ids":[], "source_url":null,
            "structured_value":null}),
    )
    .await
    .unwrap();
    data_agent::modules::retrieval::index_in_tx(&mut tx, &ctx.space_id, &object)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let id = object["id"].as_str().unwrap().to_owned();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let heads = knowledge::scoped_enabled_heads_in_tx(&mut tx, &ctx, &scope)
        .await
        .unwrap();
    assert_eq!(heads, vec![(id.clone(), 1)], "允许集须保留已确认业务域");
    let allowed = vec![id.clone()];
    let terms = vec!["sqlscopeneedle".to_owned()];
    let knowledge_rows = knowledge::matching_content_in_tx(
        &mut tx,
        &ctx,
        "sqlscopeneedle",
        &terms,
        &terms,
        &scope,
        Some(&allowed),
        50,
        0,
        false,
    )
    .await
    .unwrap();
    assert_eq!(
        knowledge_rows.len(),
        2,
        "知识owner须返回同域正文和域条目的规范位置"
    );
    let retrieval_rows = data_agent::modules::retrieval::content_candidates_scoped_in_tx(
        &mut tx,
        &ctx.space_id,
        "sqlscopeneedle",
        &terms,
        &terms,
        &scope,
        Some(&allowed),
        50,
        0,
        false,
    )
    .await
    .unwrap();
    assert_eq!(
        retrieval_rows.len(),
        2,
        "投影owner须沿相同硬范围返回规范位置"
    );
    let records = |rows: &[Value]| {
        rows.iter()
            .map(|row| row["record_id"].clone())
            .collect::<Vec<_>>()
    };
    assert_eq!(records(&knowledge_rows), records(&retrieval_rows));
    tx.commit().await.unwrap();
    let checked = Default::default();
    let stage = data_agent::use_cases::knowledge::search_stage_outside_lock(
        &pool,
        &ctx,
        &mut data_agent::use_cases::knowledge::ScopedSearchRequest {
            query: "sqlscopeneedle",
            limit: 10,
            launch: None,
            vector: data_agent::modules::retrieval::vector::Candidates::lexical(),
            scope: &scope,
            allowed: None,
            asset_after: None,
            hints: None,
            cid: "",
            text_results: &checked,
            include_raw: false,
        },
    )
    .await
    .unwrap();
    assert_eq!(stage.search.objects.len(), 1);
    assert_eq!(stage.search.objects[0]["id"], id);
    assert_eq!(stage.search.hits.len(), 2);
    assert_eq!(stage.search.coverage["candidate_count"], 2);
    assert_eq!(
        stage.search.objects[0]["retrieval"]["channel"], "lexical",
        "正式SQL定位须保留词法通道",
    );
}

#[tokio::test]
async fn search_stage_keeps_full_query_scores_in_sql_owners() {
    let _guard = SERIAL.lock().await;
    let pool = harness_pool().await;
    let ctx = AccessContext {
        user_id: "alice".into(),
        space_id: "demo".into(),
        request_id: "synthetic-full-query-scoring".into(),
    };
    let query = (0..48)
        .map(|index| format!("qtoken{index:02}"))
        .collect::<Vec<_>>()
        .join(" ");
    let selected = data_agent::modules::retrieval::candidate_terms(&query);
    let scoring_terms = data_agent::modules::retrieval::tokens(&query);
    assert!(!selected.complete);
    assert!(!selected.values.iter().any(|term| term == "qtoken45"));
    assert!(selected.values.iter().any(|term| term == "qtoken47"));
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let object = knowledge::create_in_tx(
        &mut tx,
        &ctx,
        &json!({"operation_id":"create-full-query-scoring", "kind":"term",
            "name":"qtoken45", "body":"qtoken47 独立合成正文。",
            "related_ids":[], "source_url":null, "structured_value":null}),
    )
    .await
    .unwrap();
    data_agent::modules::retrieval::index_in_tx(&mut tx, &ctx.space_id, &object)
        .await
        .unwrap();
    let excluded = knowledge::create_in_tx(
        &mut tx,
        &ctx,
        &json!({"operation_id":"create-unselected-query-term", "kind":"term",
            "name":"qtoken45", "body":"只含未选词的独立合成资料。",
            "related_ids":[], "source_url":null, "structured_value":null}),
    )
    .await
    .unwrap();
    data_agent::modules::retrieval::index_in_tx(&mut tx, &ctx.space_id, &excluded)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let allowed = vec![
        object["id"].as_str().unwrap().to_owned(),
        excluded["id"].as_str().unwrap().to_owned(),
    ];
    let scope = Default::default();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let current = knowledge::matching_content_in_tx(
        &mut tx,
        &ctx,
        &query,
        &selected.values,
        &scoring_terms,
        &scope,
        Some(&allowed),
        50,
        0,
        false,
    )
    .await
    .unwrap();
    let indexed = data_agent::modules::retrieval::content_candidates_scoped_in_tx(
        &mut tx,
        &ctx.space_id,
        &query,
        &selected.values,
        &scoring_terms,
        &scope,
        Some(&allowed),
        50,
        0,
        false,
    )
    .await
    .unwrap();
    for rows in [&current, &indexed] {
        assert_eq!(rows.len(), 1, "选定候选词qtoken47仍可召回同一规范正文");
        assert_eq!(
            rows[0]["name_term_hits"], 1,
            "未入24个候选词的qtoken45仍参与名称评分"
        );
        assert_eq!(
            rows[0]["term_hits"], 2,
            "完整问句的名称与正文词均参与同一owner评分"
        );
    }
    assert_eq!(current[0]["record_id"], indexed[0]["record_id"]);
    tx.commit().await.unwrap();
    let stage = search_stage(&pool, &ctx, &query, 1).await;
    assert_eq!(stage.search.hits.len(), 1);
    assert_eq!(stage.search.objects[0]["id"], object["id"]);
    assert_eq!(stage.search.coverage["candidate_count"], 1);
    assert_eq!(stage.search.coverage["query_terms_complete"], false);
    assert_eq!(stage.search.scan_progress["main_reads"], 1);
    let mut tx = AppTx::begin(&pool).await.unwrap();
    data_agent::use_cases::knowledge::assert_search_fresh_in_tx(&mut tx, &ctx, &stage)
        .await
        .unwrap();
    tx.commit().await.unwrap();
}

#[tokio::test]
async fn selected_content_rejects_record_window_drift_and_keeps_subranges() {
    let _guard = SERIAL.lock().await;
    let pool = harness_pool().await;
    let ctx = AccessContext {
        user_id: "alice".into(),
        space_id: "demo".into(),
        request_id: "synthetic-record-window-binding".into(),
    };
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let mut object = knowledge::create_in_tx(
        &mut tx,
        &ctx,
        &json!({"operation_id":"create-record-window-binding", "kind":"document",
            "name":"规范窗口绑定合成资料", "body":"初始化", "related_ids":[],
            "source_url":null,"structured_value":null}),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let text = format!(
        "{}{}{}",
        "甲🌏".repeat(140),
        "乙🧪".repeat(140),
        "丙".repeat(240)
    );
    object["entries"][0]["effective_value"] = json!(text);
    for statement in [
        "UPDATE knowledge_objects SET body=? WHERE id=?",
        "UPDATE knowledge_versions SET body=? WHERE object_id=? AND version=1",
    ] {
        sqlx::query(statement)
            .bind(sqlx::types::Json(&object))
            .bind(object["id"].as_str().unwrap())
            .execute(&pool)
            .await
            .unwrap();
    }
    let record = data_agent::types::fingerprint(&json!([
        "knowledge-statement-window-3",
        "demo",
        object["id"],
        "1",
        "body",
        "body",
        null,
        0
    ]));
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let mut relocated = json!({"entry_id":"body","path":"body","offset":560,"length":240,
        "content_hash":data_agent::types::fingerprint(&json!("丙".repeat(240)))});
    assert!(
        knowledge::read_entries_in_tx(
            &mut tx,
            &ctx,
            object["id"].as_str().unwrap(),
            1,
            &record,
            &mut relocated,
            &Default::default()
        )
        .await
        .unwrap()
        .is_none(),
        "另一合法窗口即使hash正确，也不能借原record身份交付"
    );
    let expected = "甲🌏".repeat(60);
    let mut subset = json!({"entry_id":"body","path":"body","offset":80,"length":120,
        "content_hash":data_agent::types::fingerprint(&json!(expected))});
    let read = knowledge::read_entries_in_tx(
        &mut tx,
        &ctx,
        object["id"].as_str().unwrap(),
        1,
        &record,
        &mut subset,
        &Default::default(),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(read["entries"][0]["effective_value"], expected);
    assert_eq!(read["entries"][0]["content_page"]["offset"], 80);
    assert_eq!(read["entries"][0]["content_page"]["total_chars"], 800);
    let mut unknown = subset.clone();
    assert!(
        knowledge::read_entries_in_tx(
            &mut tx,
            &ctx,
            object["id"].as_str().unwrap(),
            1,
            "unknown-current-record",
            &mut unknown,
            &Default::default()
        )
        .await
        .unwrap()
        .is_none()
    );
    tx.commit().await.unwrap();
}

#[tokio::test]
async fn selected_content_restores_statement_fields_and_keeps_dependencies() {
    let _guard = SERIAL.lock().await;
    let pool = harness_pool().await;
    let ctx = AccessContext {
        user_id: "alice".into(),
        space_id: "demo".into(),
        request_id: "synthetic-statement-locator".into(),
    };
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let support = knowledge::create_in_tx(
        &mut tx,
        &ctx,
        &json!({"operation_id":"create-statement-locator-support", "kind":"term",
            "name":"独立合成前提", "body":"设备已完成双人复核。", "related_ids":[],
            "source_url":null,"structured_value":null}),
    )
    .await
    .unwrap();
    let mut object = knowledge::create_in_tx(
        &mut tx,
        &ctx,
        &json!({"operation_id":"create-statement-locator", "kind":"metric",
            "name":"陈述定位合成资料", "body":"初始化", "related_ids":[],
            "source_url":null,"structured_value":null}),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let earlier = "背景🌏。".repeat(80);
    let text = "设备停用后不得继续计入有效设备数。";
    let scope_text = "仅适用已复核设备。";
    let selected = format!("{text}\n{scope_text}");
    let rendered = format!("{earlier}\n\n{selected}");
    let base = earlier.chars().count() + 2;
    let reference =
        json!({"object_id":support["id"],"version":"1","path":support["entries"][0]["path"]});
    let statements = json!([
        {"statement_id":"earlier-rule","object_ref":{"object_id":object["id"],"version":"1","path":"rules"},
            "text":earlier,"scope_text":"","origin":"model_inference","citations":[],"supports":[]},
        {"statement_id":"selected-rule","object_ref":{"object_id":object["id"],"version":"1","path":"rules"},
            "text":text,"scope_text":scope_text,"origin":"model_inference","citations":[],
            "supports":[{"support_id":"selected-prerequisite","role":"prerequisite",
                "reference":{"kind":"knowledge","ref":reference},"embedded_in":null}]}
    ]);
    object["entries"] = json!([{"entry_id":"rules","path":"rules","label":"规则",
        "effective_value":rendered,"source_facts":{},
        "suggestion":{"value":rendered,"statements":statements},
        "human_override":null,"review_state":"unverified"}]);
    for statement in [
        "UPDATE knowledge_objects SET body=? WHERE id=?",
        "UPDATE knowledge_versions SET body=? WHERE object_id=? AND version=1",
    ] {
        sqlx::query(statement)
            .bind(sqlx::types::Json(&object))
            .bind(object["id"].as_str().unwrap())
            .execute(&pool)
            .await
            .unwrap();
    }
    for statement in statements.as_array().unwrap() {
        sqlx::query("INSERT INTO knowledge_statements(object_id,version,statement_id,space_id,entry_path,layer,body) VALUES(?,1,?,'demo','rules','model_suggestion',?)")
            .bind(object["id"].as_str().unwrap()).bind(statement["statement_id"].as_str().unwrap())
            .bind(sqlx::types::Json(statement)).execute(&pool).await.unwrap();
    }
    let record = data_agent::types::fingerprint(&json!([
        "knowledge-statement-window-3",
        "demo",
        object["id"],
        "1",
        "rules",
        "rules",
        "selected-rule",
        base
    ]));
    let canonical = json!({"entry_id":"rules","path":"rules","statement_id":"selected-rule",
        "statement_offset":0,"offset":base,"length":selected.chars().count(),
        "content_hash":data_agent::types::fingerprint(&json!(selected))});
    let mut tx = AppTx::begin(&pool).await.unwrap();
    for fields in [
        vec!["statement_offset"],
        vec!["statement_id"],
        vec!["statement_id", "statement_offset"],
        vec![
            "entry_id",
            "path",
            "offset",
            "length",
            "statement_id",
            "statement_offset",
        ],
    ] {
        let mut location = canonical.clone();
        for field in fields {
            location.as_object_mut().unwrap().remove(field);
        }
        let read = knowledge::read_entries_in_tx(
            &mut tx,
            &ctx,
            object["id"].as_str().unwrap(),
            1,
            &record,
            &mut location,
            &Default::default(),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(location, canonical, "仅补缺字段，不能丢陈述身份或改变窗口");
        assert_eq!(read["entries"][0]["effective_value"], selected);
        assert_eq!(
            read["entries"][0]["statement_content"]["statement_id"],
            "selected-rule"
        );
        assert_eq!(read["entries"][0]["statement_content"]["text"], text);
        assert_eq!(
            read["entries"][0]["statement_content"]["scope_text"],
            scope_text
        );
        assert_eq!(read["statement_dependencies"], json!([reference]));
    }
    let mut conflict = canonical.clone();
    conflict["statement_id"] = json!("earlier-rule");
    assert!(
        knowledge::read_entries_in_tx(
            &mut tx,
            &ctx,
            object["id"].as_str().unwrap(),
            1,
            &record,
            &mut conflict,
            &Default::default()
        )
        .await
        .unwrap()
        .is_none()
    );
    tx.commit().await.unwrap();
}

#[tokio::test]
async fn search_stage_keeps_consumed_candidates_when_metadata_crosses_deadline() {
    let _guard = SERIAL.lock().await;
    let pool = harness_pool().await;
    let ctx = AccessContext {
        user_id: "alice".into(),
        space_id: "demo".into(),
        request_id: "synthetic-pending-metadata-deadline".into(),
    };
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let mut object = knowledge::create_in_tx(
        &mut tx,
        &ctx,
        &json!({"operation_id":"create-pending-metadata", "kind":"term",
            "name":"合成待核验定位资料", "body":"pendingmetadataneedle 独立原文。",
            "related_ids":[], "source_url":null, "structured_value":null}),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    object["entries"] = json!([
        {"entry_id":"rule-a","path":"rule-a","label":"规则A",
         "effective_value":"pendingmetadataneedle 合成规则甲。",
         "source_facts":{},"suggestion":{},"human_override":null,"review_state":"unverified"},
        {"entry_id":"rule-b","path":"rule-b","label":"规则B",
         "effective_value":"pendingmetadataneedle 合成规则乙。",
         "source_facts":{},"suggestion":{},"human_override":null,"review_state":"unverified"}
    ]);
    for statement in [
        "UPDATE knowledge_objects SET body=? WHERE id=?",
        "UPDATE knowledge_versions SET body=? WHERE object_id=? AND version=1",
    ] {
        sqlx::query(statement)
            .bind(sqlx::types::Json(&object))
            .bind(object["id"].as_str().unwrap())
            .execute(&pool)
            .await
            .unwrap();
    }
    let mut tx = AppTx::begin(&pool).await.unwrap();
    data_agent::modules::retrieval::index_in_tx(&mut tx, &ctx.space_id, &object)
        .await
        .unwrap();
    tx.commit().await.unwrap();

    // 真实候选SQL可返回，只有元信息后的依赖映射核验被表锁阻塞；不替换候选响应。
    let mut blocker = pool.acquire().await.unwrap();
    sqlx::raw_sql("LOCK TABLES knowledge_dependency_states WRITE")
        .execute(&mut *blocker)
        .await
        .unwrap();
    let checked = Default::default();
    let mut vector = data_agent::modules::retrieval::vector::Candidates::lexical();
    vector.deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(1);
    let started = tokio::time::Instant::now();
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        data_agent::use_cases::knowledge::search_stage_outside_lock(
            &pool,
            &ctx,
            &mut data_agent::use_cases::knowledge::ScopedSearchRequest {
                query: "pendingmetadataneedle",
                limit: 2,
                launch: None,
                vector,
                scope: &data_agent::search_scope::KnowledgeSearchScope::default(),
                allowed: None,
                asset_after: None,
                hints: None,
                cid: "",
                text_results: &checked,
                include_raw: false,
            },
        ),
    )
    .await;
    sqlx::raw_sql("UNLOCK TABLES")
        .execute(&mut *blocker)
        .await
        .unwrap();
    let stage = result.expect("元信息超期不能等待阻塞核验").unwrap();
    assert!(started.elapsed() >= std::time::Duration::from_millis(900));
    assert!(stage.search.hits.is_empty());
    assert_eq!(stage.search.coverage["state"], "bounded");
    assert_eq!(stage.search.coverage["candidate_count"], 2);
    assert_eq!(stage.search.scan_progress["main_reads"], 0);
    for source in stage.search.scan_progress["sql"].as_array().unwrap() {
        assert_eq!(source["consumed"], 2);
        assert_eq!(source["succeeded"], true);
        assert_eq!(source["in_flight"], false);
    }
    assert_eq!(
        stage.search.pending.len(),
        2,
        "已消费但未核验的定位不能丢失"
    );
    let mut actual = stage
        .search
        .pending
        .iter()
        .map(|candidate| {
            assert_eq!(candidate["id"], object["id"]);
            assert_eq!(candidate["version"], "1");
            assert!(candidate.get("entries").is_none(), "待核验引用不携带正文");
            let location = &candidate["matches"][0];
            assert_eq!(location["offset"], 0);
            assert_eq!(location["length"], 28);
            assert_eq!(location["path"], location["entry_id"]);
            (
                candidate["record_id"].as_str().unwrap().to_owned(),
                location["entry_id"].as_str().unwrap().to_owned(),
            )
        })
        .collect::<Vec<_>>();
    actual.sort();
    let mut expected = object["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| {
            (
                data_agent::types::knowledge_record_id(&ctx.space_id, &object, entry, 0),
                entry["entry_id"].as_str().unwrap().to_owned(),
            )
        })
        .collect::<Vec<_>>();
    expected.sort();
    assert_eq!(
        actual, expected,
        "原entry/path/窗口身份须在后续核验前完整保留"
    );
}

#[tokio::test]
async fn narrow_search_projection_rechecks_unshown_required_sources() {
    let _guard = SERIAL.lock().await;
    let pool = harness_pool().await;
    let ctx = AccessContext {
        user_id: "alice".into(),
        space_id: "demo".into(),
        request_id: "synthetic-narrow-source-freshness".into(),
    };
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let source = knowledge::create_in_tx(
        &mut tx,
        &ctx,
        &json!({"operation_id":"create-narrow-source", "kind":"document",
            "name":"合成计数说明", "body":"首次确认后计入统计。", "related_ids":[],
            "source_url":null, "structured_value":null}),
    )
    .await
    .unwrap();
    let mut object = knowledge::create_in_tx(
        &mut tx,
        &ctx,
        &json!({"operation_id":"create-narrow-dependent", "kind":"term",
            "name":"合成计数口径", "body":"projectionfreshneedle 检索命中正文。",
            "related_ids":[], "source_url":null, "structured_value":null}),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let source_id = source["id"].as_str().unwrap();
    let owner_id = object["id"].as_str().unwrap().to_owned();

    // 迁移前对象的另一条目携带必要来源，但不包含查询词，不进入正文投影。
    object["entries"].as_array_mut().unwrap().push(json!({
        "entry_id":"calculation-source", "path":"calculation-source", "label":"计数依据",
        "effective_value":"首次确认的计数依据来自说明文档。",
        "source_facts":{"source_id":format!("document-{source_id}"),"version":"1","complete":true},
        "suggestion":{}, "human_override":null, "review_state":"unverified"
    }));
    for statement in [
        "UPDATE knowledge_objects SET body=? WHERE id=?",
        "UPDATE knowledge_versions SET body=? WHERE object_id=? AND version=1",
        "UPDATE retrieval_documents SET body=? WHERE object_id=?",
    ] {
        sqlx::query(statement)
            .bind(sqlx::types::Json(&object))
            .bind(&owner_id)
            .execute(&pool)
            .await
            .unwrap();
    }
    sqlx::query("DELETE FROM knowledge_dependency_states WHERE owner_id=? AND owner_version=1")
        .bind(&owner_id)
        .execute(&pool)
        .await
        .unwrap();

    let stage = search_stage(&pool, &ctx, "projectionfreshneedle", 1).await;
    assert_eq!(stage.search.objects.len(), 1, "来源有效时正常交付命中正文");
    assert_eq!(stage.search.objects[0]["id"], owner_id);
    assert_eq!(
        stage.search.objects[0]["entries"].as_array().unwrap().len(),
        1
    );
    assert_eq!(stage.search.objects[0]["entries"][0]["entry_id"], "body");
    let mut tx = AppTx::begin(&pool).await.unwrap();
    data_agent::use_cases::knowledge::assert_search_fresh_in_tx(&mut tx, &ctx, &stage)
        .await
        .unwrap();
    tx.commit().await.unwrap();

    // 检索事务已经结束；正式保存改版来源，命中对象自身仍是同一版本。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let edited = knowledge::save_edit_in_tx(
        &mut tx,
        &ctx,
        source_id,
        &json!({"operation_id":"change-narrow-source", "expected_version":"1",
            "entry_id":"body", "value":"最终确认后计入统计。", "structured_value":null}),
        None,
    )
    .await
    .unwrap();
    register_saved_in_tx(&mut tx, &ctx, std::slice::from_ref(&edited)).await;
    tx.commit().await.unwrap();

    let mut tx = AppTx::begin(&pool).await.unwrap();
    let error = data_agent::use_cases::knowledge::assert_search_fresh_in_tx(&mut tx, &ctx, &stage)
        .await
        .expect_err("未展示条目的必要来源换版后，不能交付锁外取得的旧正文");
    assert_eq!(error.code, "stale_knowledge");
}

// 检索过滤走依赖索引：映射完备对象按有效层判定——人工真正替换后的平台事实引用
// 不再误滤（legacy正文判定会把对象整体滤掉），采纳的派生陈述引用随来源改版即时
// 剔除（legacy正文判定看不见陈述引用）。
#[tokio::test]
async fn search_filter_judges_effective_dependencies_not_legacy_refs() {
    let _guard = SERIAL.lock().await;
    let pool = harness_pool().await;
    let ctx = AccessContext {
        user_id: "alice".into(),
        space_id: "demo".into(),
        request_id: "synthetic-search-filter".into(),
    };

    // 平台来源首版：人工替换前的原始事实出处。
    sqlx::query("INSERT INTO source_heads(id,space_id,version,fingerprint) VALUES(?,?,1,?)")
        .bind("platform-feed-9")
        .bind(&ctx.space_id)
        .bind("synthetic-search-fingerprint")
        .execute(&pool)
        .await
        .unwrap();

    // R：条目携带平台结构事实后被人工完全替换，引用留在非有效层。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let replaced = knowledge::create_in_tx(
        &mut tx,
        &ctx,
        &json!({
            "operation_id":"create-search-replaced", "kind":"term", "name":"人工独立口径术语",
            "body":"初始正文", "related_ids":[], "source_url":null, "structured_value":null
        }),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let replaced_id = replaced["id"].as_str().unwrap().to_owned();
    // 按推送落库形态补写结构事实（refresh_facts的输出形状），再经公开保存路径
    // 重建该版本依赖行，避免手写索引行绕过rows_for_object。
    sqlx::query(
        r#"UPDATE knowledge_objects SET body=JSON_SET(body,'$.entries[0].source_facts',JSON_OBJECT('value','平台原始口径','source_id','platform-feed-9','version','1','location','body','quote','平台原始口径','classification','definition','complete',TRUE)) WHERE id=?"#,
    )
    .bind(&replaced_id)
    .execute(&pool)
    .await
    .unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let replaced_saved = knowledge::save_edit_in_tx(
        &mut tx,
        &ctx,
        &replaced_id,
        &json!({"operation_id":"replace-search-replaced","expected_version":"1",
            "entry_id":"body","value":"人工替换后的独立口径","structured_value":null}),
        None,
    )
    .await
    .unwrap();
    register_saved_in_tx(&mut tx, &ctx, std::slice::from_ref(&replaced_saved)).await;
    tx.commit().await.unwrap();
    let replaced_version = replaced_saved["version"]
        .as_str()
        .unwrap()
        .parse::<u64>()
        .unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    assert!(
        knowledge::dependency_index::mapping_complete_in_tx(
            &mut tx,
            &(replaced_id.clone(), replaced_version)
        )
        .await
        .unwrap(),
        "人工内容对象映射完备，检索走索引判定"
    );
    tx.commit().await.unwrap();

    // 锚点文档与D：采纳的派生陈述引用锚点首版。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let anchor = knowledge::create_in_tx(
        &mut tx,
        &ctx,
        &json!({
            "operation_id":"create-search-anchor", "kind":"document", "name":"检索过滤锚点文档",
            "body":"# 锚点\n\n稳定口径", "related_ids":[], "source_url":null,
            "structured_value":null
        }),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let anchor_id = anchor["id"].as_str().unwrap().to_owned();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let derived = knowledge::create_in_tx(
        &mut tx,
        &ctx,
        &json!({
            "operation_id":"create-search-derived", "kind":"term", "name":"采纳派生口径术语",
            "body":"待整理", "related_ids":[], "source_url":null, "structured_value":null
        }),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let derived_id = derived["id"].as_str().unwrap().to_owned();
    let citation = json!([{"source":{"kind":"document","id":&anchor_id},
        "revision":"1","locator":{"offset":6,"length":4}}]);
    let derived_result = json!({"statements":[{
        "key":"derived-rule", "target":{"object_id":&derived_id,"version":"1","path":"body"},
        "text":"采纳后的派生口径", "scope_text":"适用范围：检索过滤验收",
        "citations":citation, "supports":[]
    }],"relations":[],"unresolved":[],"semantic_status":"ready"});
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let prepared = knowledge::apply_preparation_in_tx(
        &mut tx,
        &ctx,
        "search-apply-derived",
        &contracts::decode("SourceKey", json!({"kind":"document","id":&anchor_id})).unwrap(),
        "1",
        &derived_result,
    )
    .await
    .unwrap();
    register_saved_in_tx(&mut tx, &ctx, &prepared).await;
    tx.commit().await.unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let adopted = knowledge::save_edit_in_tx(
        &mut tx,
        &ctx,
        &derived_id,
        &json!({"operation_id":"adopt-search-derived","expected_version":"2",
            "entry_id":"body","clear_override":true}),
        None,
    )
    .await
    .unwrap();
    register_saved_in_tx(&mut tx, &ctx, std::slice::from_ref(&adopted)).await;
    tx.commit().await.unwrap();
    let derived_version = adopted["version"].as_str().unwrap().parse::<u64>().unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    assert!(
        knowledge::dependency_index::mapping_complete_in_tx(
            &mut tx,
            &(derived_id.clone(), derived_version)
        )
        .await
        .unwrap(),
        "采纳整理成果的对象映射完备，检索走索引判定"
    );
    tx.commit().await.unwrap();

    // C：无来源稳定对象作正控。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let stable = knowledge::create_in_tx(
        &mut tx,
        &ctx,
        &json!({
            "operation_id":"create-search-stable", "kind":"term", "name":"稳定口径术语",
            "body":"稳定口径正文", "related_ids":[], "source_url":null,
            "structured_value":null
        }),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let stable_id = stable["id"].as_str().unwrap().to_owned();

    // 传递失效链：E只引用稳定的次级锚点并知识支持K，K引用的锚点改版后E应随链剔除，
    // 尽管stale条目的owner是中间成员K而不是E自身。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let secondary = knowledge::create_in_tx(
        &mut tx,
        &ctx,
        &json!({
            "operation_id":"create-search-secondary", "kind":"document", "name":"检索过滤次级锚点",
            "body":"# 次\n\n辅助口径", "related_ids":[], "source_url":null,
            "structured_value":null
        }),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let secondary_id = secondary["id"].as_str().unwrap().to_owned();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let middle = knowledge::create_in_tx(
        &mut tx,
        &ctx,
        &json!({
            "operation_id":"create-search-middle", "kind":"term", "name":"支持链中间词条",
            "body":"待整理", "related_ids":[], "source_url":null, "structured_value":null
        }),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let middle_id = middle["id"].as_str().unwrap().to_owned();
    let anchor_citation = json!([{"source":{"kind":"document","id":&anchor_id},
        "revision":"1","locator":{"offset":6,"length":4}}]);
    let middle_result = json!({"statements":[{
        "key":"middle-rule", "target":{"object_id":&middle_id,"version":"1","path":"body"},
        "text":"中间词条的派生口径", "scope_text":"适用范围：检索过滤验收",
        "citations":anchor_citation, "supports":[]
    }],"relations":[],"unresolved":[],"semantic_status":"ready"});
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let prepared = knowledge::apply_preparation_in_tx(
        &mut tx,
        &ctx,
        "search-apply-middle",
        &contracts::decode("SourceKey", json!({"kind":"document","id":&anchor_id})).unwrap(),
        "1",
        &middle_result,
    )
    .await
    .unwrap();
    register_saved_in_tx(&mut tx, &ctx, &prepared).await;
    tx.commit().await.unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let middle_adopted = knowledge::save_edit_in_tx(
        &mut tx,
        &ctx,
        &middle_id,
        &json!({"operation_id":"adopt-search-middle","expected_version":"2",
            "entry_id":"body","clear_override":true}),
        None,
    )
    .await
    .unwrap();
    register_saved_in_tx(&mut tx, &ctx, std::slice::from_ref(&middle_adopted)).await;
    tx.commit().await.unwrap();
    let middle_version = middle_adopted["version"]
        .as_str()
        .unwrap()
        .parse::<u64>()
        .unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let chained = knowledge::create_in_tx(
        &mut tx,
        &ctx,
        &json!({
            "operation_id":"create-search-chained", "kind":"term", "name":"传递支持口径术语",
            "body":"待整理", "related_ids":[], "source_url":null, "structured_value":null
        }),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let chained_id = chained["id"].as_str().unwrap().to_owned();
    let chained_result = json!({"statements":[{
        "key":"chained-rule", "target":{"object_id":&chained_id,"version":"1","path":"body"},
        "text":"传递支持链上的口径", "scope_text":"适用范围：检索过滤验收",
        "citations":[{"source":{"kind":"document","id":&secondary_id},
            "revision":"1","locator":{"offset":6,"length":4}}],
        "supports":[{"key":"middle-support", "role":"prerequisite",
            "reference":{"kind":"knowledge","ref":{"object_id":&middle_id,
                "version":middle_version.to_string(),"path":"body"}},
            "content":"中间词条的派生口径", "embedded_in":null}]
    }],"relations":[],"unresolved":[],"semantic_status":"ready"});
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let prepared = knowledge::apply_preparation_in_tx(
        &mut tx,
        &ctx,
        "search-apply-chained",
        &contracts::decode("SourceKey", json!({"kind":"document","id":&secondary_id})).unwrap(),
        "1",
        &chained_result,
    )
    .await
    .unwrap();
    register_saved_in_tx(&mut tx, &ctx, &prepared).await;
    tx.commit().await.unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let chained_adopted = knowledge::save_edit_in_tx(
        &mut tx,
        &ctx,
        &chained_id,
        &json!({"operation_id":"adopt-search-chained","expected_version":"2",
            "entry_id":"body","clear_override":true}),
        None,
    )
    .await
    .unwrap();
    register_saved_in_tx(&mut tx, &ctx, std::slice::from_ref(&chained_adopted)).await;
    tx.commit().await.unwrap();

    // 平台来源与锚点文档分别改版；人工替换对象和派生对象的登记修订都停在首版。
    sqlx::query("UPDATE source_heads SET version=2 WHERE id=? AND space_id=?")
        .bind("platform-feed-9")
        .bind(&ctx.space_id)
        .execute(&pool)
        .await
        .unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let anchor_advanced = knowledge::save_edit_in_tx(
        &mut tx,
        &ctx,
        &anchor_id,
        &json!({"operation_id":"advance-search-anchor","expected_version":"1",
            "entry_id":"body","value":"# 锚点\n\n改版口径","structured_value":null}),
        None,
    )
    .await
    .unwrap();
    register_saved_in_tx(&mut tx, &ctx, std::slice::from_ref(&anchor_advanced)).await;
    tx.commit().await.unwrap();

    let kept = search_object_ids(&pool, &ctx, "人工独立口径术语").await;
    assert!(
        kept.contains(&replaced_id),
        "人工真正替换后的对象不被废弃平台事实引用误滤"
    );
    let dropped = search_object_ids(&pool, &ctx, "采纳派生口径术语").await;
    assert!(
        !dropped.contains(&derived_id),
        "采纳的派生陈述引用改版来源即时从检索剔除"
    );
    let chained_dropped = search_object_ids(&pool, &ctx, "传递支持口径术语").await;
    assert!(
        !chained_dropped.contains(&chained_id),
        "知识支持链中间成员的改版引用把候选根一并剔除"
    );
    let middle_results = search_object_ids(&pool, &ctx, "支持链中间词条").await;
    assert!(
        !middle_results.contains(&middle_id),
        "中间成员自身也因直接引用改版锚点被剔除"
    );
    let stable_results = search_object_ids(&pool, &ctx, "稳定口径术语").await;
    assert!(
        stable_results.contains(&stable_id),
        "无失效对象不受过滤影响"
    );
}

// 内容指纹区分改版与仅修订推进：同文重存（纯观测推进）不使采纳依据失效，
// 真实改文才stale；登记时填不出的指纹按保守失效。
#[tokio::test]
async fn content_fingerprint_tolerates_revision_only_advance() {
    let _guard = SERIAL.lock().await;
    let pool = harness_pool().await;
    let ctx = AccessContext {
        user_id: "alice".into(),
        space_id: "demo".into(),
        request_id: "synthetic-content-fingerprint".into(),
    };

    // 平台来源首版快照：验证平台目标同样填充内容指纹。
    sqlx::query("INSERT INTO source_heads(id,space_id,version,fingerprint) VALUES(?,?,1,?)")
        .bind("platform-feed-10")
        .bind(&ctx.space_id)
        .bind("synthetic-fingerprint-source")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO source_snapshots(source_id,version,body,complete) VALUES(?,1,?,TRUE)")
        .bind("platform-feed-10")
        .bind("稳定平台正文")
        .execute(&pool)
        .await
        .unwrap();

    // S：被采纳引用的文档；W：经平台事实与文档引用双通道登记依赖的对象。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let source = knowledge::create_in_tx(
        &mut tx,
        &ctx,
        &json!({
            "operation_id":"create-fingerprint-source", "kind":"document", "name":"指纹观测口径指南",
            "body":"# 指南\n\n首版口径", "related_ids":[], "source_url":null,
            "structured_value":null
        }),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let source_id = source["id"].as_str().unwrap().to_owned();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let citing = knowledge::create_in_tx(
        &mut tx,
        &ctx,
        &json!({
            "operation_id":"create-fingerprint-citing", "kind":"term", "name":"指纹口径术语",
            "body":"待整理", "related_ids":[], "source_url":null, "structured_value":null
        }),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let citing_id = citing["id"].as_str().unwrap().to_owned();
    sqlx::query(
        r#"UPDATE knowledge_objects SET body=JSON_SET(body,'$.entries[0].source_facts',JSON_OBJECT('value','平台原始口径','source_id','platform-feed-10','version','1','location','body','quote','平台原始口径','classification','definition','complete',TRUE)) WHERE id=?"#,
    )
    .bind(&citing_id)
    .execute(&pool)
    .await
    .unwrap();
    let citation = json!([{"source":{"kind":"document","id":&source_id},
        "revision":"1","locator":{"offset":8,"length":4}}]);
    let result = json!({"statements":[{
        "key":"fingerprint-rule", "target":{"object_id":&citing_id,"version":"1","path":"body"},
        "text":"指纹口径的整理成果", "scope_text":"适用范围：内容指纹验收",
        "citations":citation, "supports":[]
    }],"relations":[],"unresolved":[],"semantic_status":"ready"});
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let prepared = knowledge::apply_preparation_in_tx(
        &mut tx,
        &ctx,
        "fingerprint-apply",
        &contracts::decode("SourceKey", json!({"kind":"document","id":&source_id})).unwrap(),
        "1",
        &result,
    )
    .await
    .unwrap();
    register_saved_in_tx(&mut tx, &ctx, &prepared).await;
    tx.commit().await.unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let adopted = knowledge::save_edit_in_tx(
        &mut tx,
        &ctx,
        &citing_id,
        &json!({"operation_id":"adopt-fingerprint-citing","expected_version":"2",
            "entry_id":"body","clear_override":true}),
        None,
    )
    .await
    .unwrap();
    register_saved_in_tx(&mut tx, &ctx, std::slice::from_ref(&adopted)).await;
    tx.commit().await.unwrap();
    let adopted_version = adopted["version"].as_str().unwrap().parse::<u64>().unwrap();

    // 文档与平台目标的登记行都带内容指纹。
    let filled: Vec<(String, String)> = sqlx::query_as(
        "SELECT target_kind,target_fingerprint FROM knowledge_dependencies WHERE owner_id=? AND owner_version=?",
    )
    .bind(&citing_id)
    .bind(adopted_version)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(filled.len(), 2, "平台事实与文档引用各登记一行");
    assert!(
        filled
            .iter()
            .all(|(_, fingerprint)| !fingerprint.is_empty()),
        "登记修订下的目标内容指纹全部填充"
    );

    // 同文重存：S按首版原文重存（仅确认式推进），W的依据不应失效。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    knowledge::save_edit_in_tx(
        &mut tx,
        &ctx,
        &source_id,
        &json!({"operation_id":"resave-fingerprint-source","expected_version":"1",
            "entry_id":"body","value":"# 指南\n\n首版口径","structured_value":null}),
        None,
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let unchanged = data_agent::use_cases::dependency_validation::walk_required_in_tx(
        &mut tx,
        ctx.space_id.as_str(),
        &[(citing_id.clone(), adopted_version)],
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    assert!(
        unchanged.stale.is_empty(),
        "同文重存是仅修订推进，相关内容未变不失效"
    );

    // 真实改文：指纹不同即stale，登记修订钉在首版。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    knowledge::save_edit_in_tx(
        &mut tx,
        &ctx,
        &source_id,
        &json!({"operation_id":"rewrite-fingerprint-source","expected_version":"2",
            "entry_id":"body","value":"# 指南\n\n改版口径","structured_value":null}),
        None,
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let changed = data_agent::use_cases::dependency_validation::walk_required_in_tx(
        &mut tx,
        ctx.space_id.as_str(),
        &[(citing_id.clone(), adopted_version)],
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(changed.stale.len(), 1, "真实改文使依据失效");
    assert_eq!(changed.stale[0].target_kind, "document");
    assert_eq!(changed.stale[0].target_id, source_id);
    assert_eq!(changed.stale[0].registered_revision, 1);
    assert_eq!(changed.stale[0].current_revision, Some(3));
}

// 人工局部编辑：逐字保留的陈述仍是未替换部分，出处按人工层保留为有效行并受来源
// 变化核验；被改写的陈述、只保留半句的陈述不携带旧出处，不因整条提交被误判为全部替换。
#[tokio::test]
async fn partial_edit_keeps_sources_only_for_verbatim_retained_statements() {
    let _guard = SERIAL.lock().await;
    let pool = harness_pool().await;
    let ctx = AccessContext {
        user_id: "alice".into(),
        space_id: "demo".into(),
        request_id: "synthetic-partial-edit".into(),
    };

    // 指南承载陈述甲的出处，补充说明承载陈述乙的出处。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let guide = knowledge::create_in_tx(
        &mut tx,
        &ctx,
        &json!({
            "operation_id":"create-partial-guide", "kind":"document", "name":"局部编辑指南",
            "body":"# 指南\n\n首版口径", "related_ids":[], "source_url":null,
            "structured_value":null
        }),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let guide_id = guide["id"].as_str().unwrap().to_owned();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let supplement = knowledge::create_in_tx(
        &mut tx,
        &ctx,
        &json!({
            "operation_id":"create-partial-supplement", "kind":"document", "name":"轮次补充说明",
            "body":"# 补充\n\n首版口径", "related_ids":[], "source_url":null,
            "structured_value":null
        }),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let supplement_id = supplement["id"].as_str().unwrap().to_owned();

    // 词条body先清除人工初稿，再经两次整理分别登记甲（引指南）与乙（引补充说明）。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let term = knowledge::create_in_tx(
        &mut tx,
        &ctx,
        &json!({
            "operation_id":"create-partial-term", "kind":"term", "name":"语音轮次口径",
            "body":"人工初稿", "related_ids":[], "source_url":null, "structured_value":null
        }),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let term_id = term["id"].as_str().unwrap().to_owned();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    knowledge::save_edit_in_tx(
        &mut tx,
        &ctx,
        &term_id,
        &json!({"operation_id":"partial-clear-body","expected_version":"1",
            "entry_id":"body","clear_override":true}),
        None,
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let statement = |key: &str, text: &str, source: &str| {
        json!({"key":key, "target":{"object_id":term_id,"version":"","path":"body"},
            "text":text, "scope_text":"",
            "citations":[{"source":{"kind":"document","id":source},
                "revision":"1","locator":{"offset":6,"length":4}}],
            "supports":[]})
    };
    for (index, (operation, source, key, text)) in [
        (
            "partial-apply-guide",
            guide_id.as_str(),
            "voice-rule",
            "计全部语音轮次",
        ),
        (
            "partial-apply-supplement",
            supplement_id.as_str(),
            "test-exclusion",
            "不含内部测试轮次",
        ),
    ]
    .into_iter()
    .enumerate()
    {
        let mut draft = statement(key, text, source);
        draft["target"]["version"] = json!((index + 2).to_string());
        let mut tx = AppTx::begin(&pool).await.unwrap();
        knowledge::apply_preparation_in_tx(
            &mut tx,
            &ctx,
            operation,
            &contracts::decode("SourceKey", json!({"kind":"document","id":source})).unwrap(),
            "1",
            &json!({"statements":[draft],"relations":[],"unresolved":[],"semantic_status":"ready"}),
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();
    }

    // 人工局部编辑：逐字保留陈述甲，改写陈述乙的表述。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let partial = knowledge::save_edit_in_tx(
        &mut tx,
        &ctx,
        &term_id,
        &json!({"operation_id":"partial-edit-body","expected_version":"4",
            "entry_id":"body","value":"计全部语音轮次，但排除监管要求的轮次","structured_value":null}),
        None,
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let partial_version = partial["version"].as_str().unwrap().parse::<u64>().unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let retained = knowledge::dependency_index::effective_required_in_tx(
        &mut tx,
        &[(term_id.clone(), partial_version)],
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(
        retained
            .iter()
            .map(|row| (
                row.entry_path.as_str(),
                row.layer.as_str(),
                row.target_id.as_str()
            ))
            .collect::<Vec<_>>(),
        vec![("body", "human_override", guide_id.as_str())],
        "逐字保留的陈述甲出处按人工层保留；被改写的陈述乙不携带旧出处"
    );

    // 未替换部分受来源变化核验：指南改版后局部保留的甲出处使对象失效。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    knowledge::save_edit_in_tx(
        &mut tx,
        &ctx,
        &guide_id,
        &json!({"operation_id":"partial-edit-guide","expected_version":"1",
            "entry_id":"body","value":"# 指南\n\n改版口径","structured_value":null}),
        None,
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let after_source_change = data_agent::use_cases::dependency_validation::walk_required_in_tx(
        &mut tx,
        &ctx.space_id,
        &[(term_id.clone(), partial_version)],
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(
        after_source_change
            .stale
            .iter()
            .map(|row| (row.entry_path.as_str(), row.target_id.as_str()))
            .collect::<Vec<_>>(),
        vec![("body", guide_id.as_str())],
        "局部保留的出处随来源变化失效，补充说明未变不误伤"
    );

    // 半句保留不算未替换：改写后仅剩陈述乙的前半句，两个出处都不再携带。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let rewritten = knowledge::save_edit_in_tx(
        &mut tx,
        &ctx,
        &term_id,
        &json!({"operation_id":"partial-rewrite-body","expected_version":
            partial_version.to_string(),
            "entry_id":"body","value":"口径重写：不含内部测试","structured_value":null}),
        None,
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let rewritten_version = rewritten["version"]
        .as_str()
        .unwrap()
        .parse::<u64>()
        .unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let no_retention = knowledge::dependency_index::effective_required_in_tx(
        &mut tx,
        &[(term_id.clone(), rewritten_version)],
    )
    .await
    .unwrap();
    let no_retention_walk = data_agent::use_cases::dependency_validation::walk_required_in_tx(
        &mut tx,
        &ctx.space_id,
        &[(term_id.clone(), rewritten_version)],
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    assert!(
        no_retention.is_empty() && no_retention_walk.stale.is_empty(),
        "半句保留不携带出处，改写后的独立口径不被已改版指南阻断"
    );
}

// query_example结构的知识引用统一进依赖索引：dependencies是所依赖资料，
// computed_metrics只声明实际输出；两类引用都绑定对象修订，被引对象改版后示例失效。
#[tokio::test]
async fn structure_dependencies_and_computed_metrics_register_knowledge_targets() {
    let _guard = SERIAL.lock().await;
    let pool = harness_pool().await;
    let ctx = AccessContext {
        user_id: "alice".into(),
        space_id: "demo".into(),
        request_id: "synthetic-structure-dependencies".into(),
    };

    // K：被示例依赖的表说明；M：示例实际输出的指标口径。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let table_note = knowledge::create_in_tx(
        &mut tx,
        &ctx,
        &json!({
            "operation_id":"create-structure-table-note", "kind":"term", "name":"订单明细表说明",
            "body":"目标口径说明", "related_ids":[], "source_url":null, "structured_value":null
        }),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let table_id = table_note["id"].as_str().unwrap().to_owned();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let metric = knowledge::create_in_tx(
        &mut tx,
        &ctx,
        &json!({
            "operation_id":"create-structure-metric", "kind":"term", "name":"退款金额指标",
            "body":"指标口径定义", "related_ids":[], "source_url":null, "structured_value":null
        }),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let metric_id = metric["id"].as_str().unwrap().to_owned();

    // 示例：结构依赖指向表说明，输出声明指向指标；过滤用指标只留在dependencies语义里。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let example = knowledge::create_in_tx(
        &mut tx,
        &ctx,
        &json!({
            "operation_id":"create-structure-example", "kind":"query_example", "name":"按门店汇总退款",
            "body":"按门店汇总退款金额的示例", "related_ids":[], "source_url":null,
            "structured_value":{
                "kind":"query_example", "applicable_question":"按门店汇总合成退款金额",
                "parameters":[],
                "sql":"SELECT store_id, SUM(refund_amount) AS refund_total FROM demo_refund_detail GROUP BY store_id",
                "grain":"每门店一行；退款金额汇总",
                "dependencies":[
                    {"object_id":table_id, "version":"1", "path":"body"},
                    {"object_id":metric_id, "version":"1", "path":"body"}
                ],
                "computed_metrics":[
                    {"metric_ref":{"object_id":metric_id, "version":"1", "path":"body"},
                     "output_name":"refund_total", "expression":"SUM(refund_amount) 按门店汇总"}
                ],
                "verification":null
            }
        }),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let example_id = example["id"].as_str().unwrap().to_owned();

    // 结构的知识引用按有效层登记为必要依赖。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let registered =
        knowledge::dependency_index::effective_required_in_tx(&mut tx, &[(example_id.clone(), 1)])
            .await
            .unwrap();
    tx.commit().await.unwrap();
    let mut roles: Vec<(String, String, String)> = registered
        .iter()
        .map(|row| {
            (
                row.role.clone(),
                row.target_kind.clone(),
                row.target_id.clone(),
            )
        })
        .collect();
    roles.sort();
    let mut expected = vec![
        (
            "output_metric".to_owned(),
            "knowledge".to_owned(),
            metric_id.clone(),
        ),
        (
            "structure".to_owned(),
            "knowledge".to_owned(),
            table_id.clone(),
        ),
        (
            "structure".to_owned(),
            "knowledge".to_owned(),
            metric_id.clone(),
        ),
    ];
    expected.sort();
    assert_eq!(
        roles, expected,
        "结构dependencies与computed_metrics分别按structure/output登记，绑定对象修订"
    );

    // 被引对象改版后示例立即失效：表说明与指标任一改版都命中。
    for (operation, target, expect_target) in [
        (
            "structure-edit-table-note",
            table_id.clone(),
            table_id.clone(),
        ),
        (
            "structure-edit-metric",
            metric_id.clone(),
            metric_id.clone(),
        ),
    ] {
        let mut tx = AppTx::begin(&pool).await.unwrap();
        let current = knowledge::read_in_tx(&mut tx, &ctx, &target, None, true)
            .await
            .unwrap();
        let version = current["version"].as_str().unwrap().to_owned();
        knowledge::save_edit_in_tx(
            &mut tx,
            &ctx,
            &target,
            &json!({"operation_id":operation,"expected_version":version,
                "entry_id":"body","value":"改版后的口径说明","structured_value":null}),
            None,
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();
        let mut tx = AppTx::begin(&pool).await.unwrap();
        let verdict = data_agent::use_cases::dependency_validation::walk_required_in_tx(
            &mut tx,
            &ctx.space_id,
            &[(example_id.clone(), 1)],
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();
        assert!(
            verdict
                .stale
                .iter()
                .any(|row| row.target_id == expect_target),
            "{expect_target} 改版后示例的结构依赖失效"
        );
    }
}

// 来源变更扇出：被其他对象有效依赖的知识对象改版时，保存事务只登记一个轻量
// 扇出作业（不遍历依赖者拉长事务）；无人依赖的改版不登记。
#[tokio::test]
async fn saving_a_depended_object_registers_a_lightweight_fanout_job() {
    let _guard = SERIAL.lock().await;
    let pool = harness_pool().await;
    let ctx = AccessContext {
        user_id: "alice".into(),
        space_id: "demo".into(),
        request_id: "synthetic-fanout-registration".into(),
    };
    let fanout_jobs = async |object: &str| {
        sqlx::query(
            "SELECT resource_id,resource_version,state FROM background_jobs WHERE kind='source_fanout' AND resource_id=?",
        )
        .bind(object)
        .fetch_all(&pool)
        .await
        .unwrap()
    };

    // 独立对象改版：无人依赖，不登记扇出。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let independent = knowledge::create_in_tx(
        &mut tx,
        &ctx,
        &json!({
            "operation_id":"create-fanout-independent", "kind":"term", "name":"独立口径",
            "body":"独立内容", "related_ids":[], "source_url":null, "structured_value":null
        }),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let independent_id = independent["id"].as_str().unwrap().to_owned();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let independent_edited = knowledge::save_edit_in_tx(
        &mut tx,
        &ctx,
        &independent_id,
        &json!({"operation_id":"fanout-independent-edit","expected_version":"1",
            "entry_id":"body","value":"独立改版","structured_value":null}),
        None,
    )
    .await
    .unwrap();
    register_saved_in_tx(&mut tx, &ctx, std::slice::from_ref(&independent_edited)).await;
    tx.commit().await.unwrap();
    assert!(
        fanout_jobs(&independent_id).await.is_empty(),
        "无人依赖的改版不登记扇出作业"
    );

    // B被C的知识支持引用：B改版在同一保存事务登记扇出待办，绑定B新版本。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let depended = knowledge::create_in_tx(
        &mut tx,
        &ctx,
        &json!({
            "operation_id":"create-fanout-depended", "kind":"term", "name":"被依赖口径",
            "body":"被依赖内容", "related_ids":[], "source_url":null, "structured_value":null
        }),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let depended_id = depended["id"].as_str().unwrap().to_owned();
    // C的建议陈述以知识支持引用B（v1）。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let citing = knowledge::create_in_tx(
        &mut tx,
        &ctx,
        &json!({
            "operation_id":"create-fanout-citing", "kind":"term", "name":"引用方口径",
            "body":"引用方初稿", "related_ids":[], "source_url":null, "structured_value":null
        }),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let citing_id = citing["id"].as_str().unwrap().to_owned();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let prepared = knowledge::apply_preparation_in_tx(
        &mut tx,
        &ctx,
        "fanout-apply-citing",
        &contracts::decode("SourceKey", json!({"kind":"platform","id":"fanout-origin-source"}))
            .unwrap(),
        "2",
        &json!({"statements":[{
            "key":"citing-rule",
            "target":{"object_id":citing_id,"version":"1","path":"body"},
            "text":"引用方陈述", "scope_text":"",
            "citations":[{"source":{"kind":"platform","id":"fanout-origin-source"},
                "revision":"2","locator":{"offset":0,"length":4}}],
            "supports":[{"key":"fanout-precondition","role":"prerequisite",
                "reference":{"kind":"knowledge","ref":{"object_id":depended_id,"version":"1","path":"body"}},
                "content":"被依赖口径是本陈述的前提", "embedded_in":null}]
        }],"relations":[],"unresolved":[],"semantic_status":"ready"}),
    )
    .await
    .unwrap();
    register_saved_in_tx(&mut tx, &ctx, &prepared).await;
    tx.commit().await.unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let citing_cleared = knowledge::save_edit_in_tx(
        &mut tx,
        &ctx,
        &citing_id,
        &json!({"operation_id":"fanout-clear-citing","expected_version":"2",
            "entry_id":"body","clear_override":true}),
        None,
    )
    .await
    .unwrap();
    register_saved_in_tx(&mut tx, &ctx, std::slice::from_ref(&citing_cleared)).await;
    tx.commit().await.unwrap();

    // B改版：同一事务留下扇出待办。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let edited = knowledge::save_edit_in_tx(
        &mut tx,
        &ctx,
        &depended_id,
        &json!({"operation_id":"fanout-edit-depended","expected_version":"1",
            "entry_id":"body","value":"被依赖口径已改版","structured_value":null}),
        None,
    )
    .await
    .unwrap();
    register_saved_in_tx(&mut tx, &ctx, std::slice::from_ref(&edited)).await;
    tx.commit().await.unwrap();
    let edited_version = edited["version"].as_str().unwrap().parse::<u64>().unwrap();
    let jobs = fanout_jobs(&depended_id).await;
    assert_eq!(jobs.len(), 1, "被依赖对象的改版在保存事务登记一个扇出待办");
    assert_eq!(
        jobs[0].get::<u64, _>("resource_version"),
        edited_version,
        "扇出待办绑定B的新版本"
    );
    assert_eq!(jobs[0].get::<String, _>("state"), "queued");
}

// 扇出消费：按页发现依赖者后只对真正失效的依赖者来源重开整理——已完成的
// prepare_source作业重新排队、ready准备复位pending；在途调用不抢、缺头来源
// 跳过、内容未变的链条不重开；扇出作业本身到达终态且不重复登记。
#[tokio::test]
async fn fanout_reopens_preparation_only_for_stale_dependents() {
    let _guard = SERIAL.lock().await;
    let pool = harness_pool().await;
    let ctx = AccessContext {
        user_id: "alice".into(),
        space_id: "demo".into(),
        request_id: "synthetic-fanout-consumer".into(),
    };
    let preparation_row = async |source: &str, revision: u64| {
        sqlx::query(
            "SELECT semantic_status,call_state,segment_cursor FROM source_preparations WHERE source_id=? AND revision=? AND method_version=?",
        )
        .bind(source)
        .bind(revision)
        .bind(data_agent::modules::ingestion::preparation::PREPARATION_METHOD)
        .fetch_optional(&pool)
        .await
        .unwrap()
    };
    let source_job = async |source: &str, revision: u64| {
        sqlx::query(
            "SELECT MAX(state) AS state,COUNT(*) AS n FROM background_jobs WHERE kind='prepare_source' AND resource_id=? AND resource_version=?",
        )
        .bind(source)
        .bind(revision)
        .fetch_one(&pool)
        .await
        .unwrap()
    };

    // 三个平台来源：可重开（整理已ready、作业已finished）、在途（分析调用持有
    // 有效租约）、缺头（已退休，不建source_heads）。只有第一个应被扇出重开。
    for (source, revision) in [
        ("fanout-reopen-material", 3u64),
        ("fanout-busy-material", 1u64),
    ] {
        sqlx::query("INSERT INTO source_heads(id,space_id,version,fingerprint) VALUES(?,?,?,?)")
            .bind(source)
            .bind(&ctx.space_id)
            .bind(revision)
            .bind("synthetic-fanout-head")
            .execute(&pool)
            .await
            .unwrap();
    }
    let mut tx = AppTx::begin(&pool).await.unwrap();
    data_agent::modules::jobs::enqueue_source_in_tx(
        &mut tx,
        "prepare_source",
        "fanout-reopen-material",
        3,
    )
    .await
    .unwrap();
    data_agent::modules::jobs::enqueue_source_in_tx(
        &mut tx,
        "prepare_source",
        "fanout-busy-material",
        1,
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    sqlx::query(
        "UPDATE background_jobs SET state='finished' WHERE kind='prepare_source' AND resource_id IN ('fanout-reopen-material','fanout-busy-material')",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO source_preparations(source_id,space_id,revision,method_version,input_fingerprint,dependency_fingerprint,unresolved,semantic_status) VALUES(?,?,?,?,?,?,CAST('[]' AS JSON),'ready')",
    )
    .bind("fanout-reopen-material")
    .bind(&ctx.space_id)
    .bind(3u64)
    .bind(data_agent::modules::ingestion::preparation::PREPARATION_METHOD)
    .bind("synthetic-reopen-input")
    .bind("synthetic-reopen-dependency")
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO source_preparations(source_id,space_id,revision,method_version,input_fingerprint,dependency_fingerprint,unresolved,semantic_status,call_state,issued_until) VALUES(?,?,?,?,?,?,CAST('[]' AS JSON),'pending','analysis',TIMESTAMPADD(HOUR,1,UTC_TIMESTAMP(3)))",
    )
    .bind("fanout-busy-material")
    .bind(&ctx.space_id)
    .bind(1u64)
    .bind(data_agent::modules::ingestion::preparation::PREPARATION_METHOD)
    .bind("synthetic-busy-input")
    .bind("synthetic-busy-dependency")
    .execute(&pool)
    .await
    .unwrap();

    // B被C支持引用；C的陈述同时引用三个平台来源作为整理材料。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let depended = knowledge::create_in_tx(
        &mut tx,
        &ctx,
        &json!({
            "operation_id":"create-fanout-consumer-depended", "kind":"term", "name":"被依赖口径",
            "body":"被依赖内容", "related_ids":[], "source_url":null, "structured_value":null
        }),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let depended_id = depended["id"].as_str().unwrap().to_owned();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let citing = knowledge::create_in_tx(
        &mut tx,
        &ctx,
        &json!({
            "operation_id":"create-fanout-consumer-citing", "kind":"term", "name":"引用方口径",
            "body":"引用方初稿", "related_ids":[], "source_url":null, "structured_value":null
        }),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let citing_id = citing["id"].as_str().unwrap().to_owned();
    // 整理成果的出处只绑定被整理来源：三条材料来源各自一次apply，支持引用随首批带入。
    let mut citing_version = 1u64;
    for (index, (source, revision)) in [
        ("fanout-reopen-material", "3"),
        ("fanout-busy-material", "1"),
        ("fanout-ghost-material", "9"),
    ]
    .into_iter()
    .enumerate()
    {
        let supports = if index == 0 {
            json!([{"key":"fanout-consumer-precondition",
                "role":"prerequisite",
                "reference":{"kind":"knowledge","ref":{"object_id":depended_id,"version":"1","path":"body"}},
                "content":"被依赖口径是本陈述的前提", "embedded_in":null}])
        } else {
            json!([])
        };
        let mut tx = AppTx::begin(&pool).await.unwrap();
        let prepared = knowledge::apply_preparation_in_tx(
            &mut tx,
            &ctx,
            &format!("fanout-consumer-apply-{index}"),
            &contracts::decode("SourceKey", json!({"kind":"platform","id":source})).unwrap(),
            revision,
            &json!({"statements":[{
                "key":format!("fanout-consumer-rule-{index}"),
                "target":{"object_id":citing_id,"version":citing_version.to_string(),"path":"body"},
                "text":"引用方陈述", "scope_text":"",
                "citations":[{"source":{"kind":"platform","id":source},
                    "revision":revision,"locator":{"offset":0,"length":6}}],
                "supports":supports
            }],"relations":[],"unresolved":[],"semantic_status":"ready"}),
        )
        .await
        .unwrap();
        register_saved_in_tx(&mut tx, &ctx, &prepared).await;
        tx.commit().await.unwrap();
        citing_version += 1;
    }
    // 创建正文占着human_override层；解除后整理陈述成为有效层，依赖行生效。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let citing_cleared = knowledge::save_edit_in_tx(
        &mut tx,
        &ctx,
        &citing_id,
        &json!({"operation_id":"fanout-consumer-clear","expected_version":citing_version.to_string(),
            "entry_id":"body","clear_override":true}),
        None,
    )
    .await
    .unwrap();
    register_saved_in_tx(&mut tx, &ctx, std::slice::from_ref(&citing_cleared)).await;
    tx.commit().await.unwrap();

    // B改版登记扇出；消费后只有可重开来源被复位，在途与缺头来源保持原状。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let depended_edited = knowledge::save_edit_in_tx(
        &mut tx,
        &ctx,
        &depended_id,
        &json!({"operation_id":"fanout-consumer-edit","expected_version":"1",
            "entry_id":"body","value":"被依赖口径已改版","structured_value":null}),
        None,
    )
    .await
    .unwrap();
    register_saved_in_tx(&mut tx, &ctx, std::slice::from_ref(&depended_edited)).await;
    tx.commit().await.unwrap();

    // 消费者与worker同节奏：一次调用只领取一个作业，先于本测试登记的其他扇出
    // 作业会被顺次处理；排空到无可领取等价于worker多轮循环后的稳定态。
    let mut worked = false;
    for _ in 0..16 {
        let claimed = data_agent::use_cases::source_fanout::process_due(&pool)
            .await
            .unwrap();
        if !claimed {
            break;
        }
        worked = true;
    }
    assert!(worked, "扇出作业被领取并处理");

    let fanout = sqlx::query(
        "SELECT state FROM background_jobs WHERE kind='source_fanout' AND resource_id=?",
    )
    .bind(&depended_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        fanout.get::<String, _>("state"),
        "finished",
        "扇出作业处理完到终态"
    );

    let reopened = preparation_row("fanout-reopen-material", 3).await.unwrap();
    assert_eq!(
        reopened.get::<String, _>("semantic_status"),
        "pending",
        "真正失效的依赖者来源被重开整理"
    );
    assert!(
        reopened
            .get::<Option<sqlx::types::Json<Value>>, _>("segment_cursor")
            .is_none(),
        "重开从头整理，不残留旧进度"
    );
    let job = source_job("fanout-reopen-material", 3).await;
    assert_eq!(
        job.get::<String, _>("state"),
        "queued",
        "已完成的整理作业重新排队"
    );
    assert_eq!(job.get::<i64, _>("n"), 1, "重开不重复登记作业");

    let busy = preparation_row("fanout-busy-material", 1).await.unwrap();
    assert_eq!(
        busy.get::<String, _>("call_state"),
        "analysis",
        "在途调用的准备不被扇出抢占"
    );
    let busy_job = source_job("fanout-busy-material", 1).await;
    assert_eq!(
        busy_job.get::<String, _>("state"),
        "finished",
        "在途来源的作业不被重新排队"
    );

    assert!(
        preparation_row("fanout-ghost-material", 9).await.is_none(),
        "缺头来源不产生整理记录"
    );
    assert!(
        sqlx::query(
            "SELECT 1 FROM background_jobs WHERE kind='prepare_source' AND resource_id='fanout-ghost-material'",
        )
        .fetch_optional(&pool)
        .await
        .unwrap()
        .is_none(),
        "缺头来源不登记整理作业"
    );

    let again = data_agent::use_cases::source_fanout::process_due(&pool)
        .await
        .unwrap();
    assert!(!again, "已终态的扇出不再被领取");
    let job = source_job("fanout-reopen-material", 3).await;
    assert_eq!(job.get::<i64, _>("n"), 1, "重复消费不产生重复作业");
}
