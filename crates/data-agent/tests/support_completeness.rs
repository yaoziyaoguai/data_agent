use data_agent::{
    contracts,
    modules::knowledge,
    persistence::{self, AppTx},
    types::AccessContext,
};
use serde_json::{Value, json};
use sqlx::MySqlPool;

// 每个测试独占本次隔离库，并在自己的 runtime 中连接；迁移由 harness 的 API 完成。
static SERIAL: std::sync::LazyLock<tokio::sync::Mutex<()>> =
    std::sync::LazyLock::new(|| tokio::sync::Mutex::new(()));

async fn harness_pool() -> MySqlPool {
    persistence::connect(
        &std::env::var("DATA_AGENT_DATABASE_URL").expect("isolated harness database"),
    )
    .await
    .unwrap()
}

fn context(request_id: &str) -> AccessContext {
    AccessContext {
        user_id: "alice".into(),
        space_id: "demo".into(),
        request_id: request_id.into(),
        table_access: None,
    }
}

async fn create(pool: &MySqlPool, ctx: &AccessContext, operation: &str, kind: &str) -> Value {
    let mut tx = AppTx::begin(pool).await.unwrap();
    let object = knowledge::create_in_tx(
        &mut tx,
        ctx,
        &json!({"operation_id":operation,"kind":kind,"name":operation,
            "body":"合成资料：设备停用后不计入有效设备数。","related_ids":[],
            "source_url":null,"structured_value":null}),
    )
    .await
    .unwrap();
    data_agent::use_cases::dependency_registration::after_content_saved_in_tx(
        &mut tx,
        ctx,
        std::slice::from_ref(&object),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    object
}

#[tokio::test]
async fn preparation_declarations_survive_committed_reads_and_operation_replay() {
    let _guard = SERIAL.lock().await;
    let pool = harness_pool().await;
    let ctx = context("synthetic-preparation-support-completeness");
    let guide = create(&pool, &ctx, "create-completeness-guide", "document").await;
    let target = create(&pool, &ctx, "create-completeness-target", "term").await;
    let citation = json!({"source":{"kind":"document","id":guide["id"]},
        "revision":"1","locator":{"offset":0,"length":5}});
    let source = contracts::decode("SourceKey", citation["source"].clone()).unwrap();
    // 三态和旧格式的要求值独立给定；空支持、ready 和无错误均不能补出 true。
    let result = json!({"statements":[
        {"key":"complete","target":{"object_id":target["id"],"version":"1","path":"body"},
            "text":"已明确核对全部支持。","scope_text":"仅用于合成设备。",
            "citations":[citation],"supports":[],"supports_complete":true},
        {"key":"incomplete","target":{"object_id":target["id"],"version":"1","path":"body"},
            "text":"明确仍有未提取支持。","scope_text":"仅用于合成设备。",
            "citations":[citation],"supports":[],"supports_complete":false},
        {"key":"unknown","target":{"object_id":target["id"],"version":"1","path":"body"},
            "text":"支持范围尚未确认。","scope_text":"仅用于合成设备。",
            "citations":[citation],"supports":[],"supports_complete":null},
        {"key":"legacy","target":{"object_id":target["id"],"version":"1","path":"body"},
            "text":"旧格式没有覆盖声明。","scope_text":"仅用于合成设备。",
            "citations":[citation],"supports":[]}
    ],"relations":[],"unresolved":[],"semantic_status":"ready"});
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let saved = knowledge::apply_preparation_in_tx(
        &mut tx,
        &ctx,
        "apply-completeness-declarations",
        &source,
        "1",
        &result,
    )
    .await
    .unwrap();
    data_agent::use_cases::dependency_registration::after_content_saved_in_tx(
        &mut tx, &ctx, &saved,
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    pool.close().await;

    let pool = harness_pool().await;
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let replayed = knowledge::apply_preparation_in_tx(
        &mut tx,
        &ctx,
        "apply-completeness-declarations",
        &source,
        "1",
        &result,
    )
    .await
    .unwrap();
    let current = knowledge::read_in_tx(&mut tx, &ctx, target["id"].as_str().unwrap(), None, true)
        .await
        .unwrap();
    let pinned =
        knowledge::read_in_tx(&mut tx, &ctx, target["id"].as_str().unwrap(), Some(2), true)
            .await
            .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(saved[0]["version"], "2", "整理仅沿原规则推进一次版本");
    assert_eq!(replayed, saved, "相同 operation 接回原保存回执");
    assert_eq!(current["version"], "2", "重放不再次推进版本");
    for object in [&current, &pinned] {
        let statements = object["entries"][0]["suggestion"]["statements"]
            .as_array()
            .unwrap();
        assert_eq!(
            statements
                .iter()
                .map(|statement| statement["supports_complete"].clone())
                .collect::<Vec<_>>(),
            json!([true, false, null, null]).as_array().unwrap().clone(),
            "当前读取与钉住版本均保存明确声明，缺省不推断为 true"
        );
        for statement in statements {
            contracts::validate("SemanticStatement", statement).unwrap();
        }
        assert_eq!(
            statements[2].get("supports_complete"),
            Some(&Value::Null),
            "明确 null 也随原陈述保存"
        );
    }

    // 通过原人工采纳入口切到建议层后，owner 仍读取同一声明，不按有效状态补真。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let adopted = knowledge::save_edit_in_tx(
        &mut tx,
        &ctx,
        target["id"].as_str().unwrap(),
        &json!({"operation_id":"adopt-completeness-declarations","expected_version":"2",
            "entry_id":"body","clear_override":true}),
        None,
    )
    .await
    .unwrap();
    data_agent::use_cases::dependency_registration::after_content_saved_in_tx(
        &mut tx,
        &ctx,
        std::slice::from_ref(&adopted),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(adopted["version"], "3");
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let scope = Default::default();
    let terms = vec!["合成设备".to_owned()];
    let allowed = vec![target["id"].as_str().unwrap().to_owned()];
    let candidates = knowledge::matching_content_in_tx(
        &mut tx,
        &ctx,
        "合成设备",
        &terms,
        &terms,
        &scope,
        Some(&allowed),
        10,
        0,
        false,
    )
    .await
    .unwrap();
    assert_eq!(candidates.len(), 4);
    let mut observed = std::collections::BTreeMap::new();
    for candidate in candidates {
        let mut location = candidate["matches"][0].clone();
        let read = knowledge::read_entries_in_tx(
            &mut tx,
            &ctx,
            target["id"].as_str().unwrap(),
            3,
            candidate["record_id"].as_str().unwrap(),
            &mut location,
            &scope,
        )
        .await
        .unwrap()
        .unwrap();
        let content = &read["entries"][0]["statement_content"];
        observed.insert(
            content["text"].as_str().unwrap().to_owned(),
            content.get("supports_complete").cloned(),
        );
        assert!(content["supports"].as_array().unwrap().is_empty());
    }
    assert_eq!(
        observed,
        std::collections::BTreeMap::from([
            ("已明确核对全部支持。".to_owned(), Some(json!(true))),
            ("明确仍有未提取支持。".to_owned(), Some(json!(false))),
            ("支持范围尚未确认。".to_owned(), Some(Value::Null)),
            ("旧格式没有覆盖声明。".to_owned(), Some(Value::Null)),
        ]),
        "采纳后的窄读保留三态；支持为空及整理 ready 均不制造完整性"
    );
    tx.commit().await.unwrap();
    pool.close().await;
}

#[tokio::test]
async fn saved_human_declarations_survive_pinned_reads_and_owner_projection() {
    let _guard = SERIAL.lock().await;
    let pool = harness_pool().await;
    let ctx = context("synthetic-human-support-completeness");
    let support = create(&pool, &ctx, "create-completeness-prerequisite", "term").await;
    let mut fixture = create(&pool, &ctx, "create-completeness-seed-template", "term").await;
    fixture["id"] = json!("saved-human-completeness-fixture");
    let reference = json!({"object_id":support["id"],"version":"1","path":"body"});
    let mut entries = Vec::new();
    for (path, declaration) in [
        ("complete", Some(json!(true))),
        ("incomplete", Some(json!(false))),
        ("unknown", Some(Value::Null)),
        ("legacy", None),
    ] {
        let text = format!("ownersupportneedle 合成人工规则 {path}。");
        let mut statement = json!({"statement_id":format!("human-{path}"),
            "object_ref":{"object_id":fixture["id"],"version":"1","path":path},
            "text":text,"scope_text":"","origin":"human","citations":[],
            "supports":[{"support_id":format!("human-support-{path}"),"role":"prerequisite",
                "reference":{"kind":"knowledge","ref":reference},
                "content":"合成前提正文，不属于 owner 目录投影。".repeat(1000),"embedded_in":null}]});
        if let Some(value) = declaration {
            statement["supports_complete"] = value;
        }
        entries.push(json!({"entry_id":path,"path":path,"label":path,
            "source_facts":{},"suggestion":{},"human_override":{"value":text,
                "edited_by":"alice","statements":[statement]},
            "effective_value":text,"review_state":"confirmed"}));
    }
    fixture["entries"] = json!(entries);
    // 公开 seed seam 构造已保存的人工/历史格式，不直接写 owner 的私有表。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let saved = knowledge::seed_in_tx(&mut tx, &ctx, &json!({"objects":[fixture]}))
        .await
        .unwrap();
    data_agent::use_cases::dependency_registration::after_content_saved_in_tx(
        &mut tx, &ctx, &saved,
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    pool.close().await;

    let pool = harness_pool().await;
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let id = "saved-human-completeness-fixture";
    for version in [None, Some(1)] {
        let read = knowledge::read_in_tx(&mut tx, &ctx, id, version, true)
            .await
            .unwrap();
        assert_eq!(
            read["entries"]
                .as_array()
                .unwrap()
                .iter()
                .map(|entry| entry["human_override"]["statements"][0]
                    .get("supports_complete")
                    .cloned())
                .collect::<Vec<_>>(),
            vec![
                Some(json!(true)),
                Some(json!(false)),
                Some(Value::Null),
                None
            ],
            "已保存人工陈述在原当前/版本读取中保留明确三态和历史缺字段"
        );
    }
    let scope = Default::default();
    let terms = vec!["ownersupportneedle".to_owned()];
    let allowed = vec![id.to_owned()];
    let candidates = knowledge::matching_content_in_tx(
        &mut tx,
        &ctx,
        "ownersupportneedle",
        &terms,
        &terms,
        &scope,
        Some(&allowed),
        10,
        0,
        false,
    )
    .await
    .unwrap();
    assert_eq!(candidates.len(), 4, "四种声明均有独立正式陈述定位");
    let mut observed = std::collections::BTreeMap::new();
    for candidate in candidates {
        let mut location = candidate["matches"][0].clone();
        let read = knowledge::read_entries_in_tx(
            &mut tx,
            &ctx,
            id,
            1,
            candidate["record_id"].as_str().unwrap(),
            &mut location,
            &scope,
        )
        .await
        .unwrap()
        .unwrap();
        let content = &read["entries"][0]["statement_content"];
        let path = location["path"].as_str().unwrap();
        observed.insert(path.to_owned(), content.get("supports_complete").cloned());
        assert_eq!(content["statement_id"], format!("human-{path}"));
        assert_eq!(content["supports"][0]["reference"]["ref"], reference);
        assert!(
            content["supports"][0].get("content").is_none(),
            "owner 窄投影不得附带支持正文"
        );
        assert_eq!(
            read["statement_dependencies"],
            json!([reference]),
            "完整性声明不改变必要支持的版本依赖"
        );
    }
    assert_eq!(
        observed,
        std::collections::BTreeMap::from([
            ("complete".to_owned(), Some(json!(true))),
            ("incomplete".to_owned(), Some(json!(false))),
            ("legacy".to_owned(), Some(Value::Null)),
            ("unknown".to_owned(), Some(Value::Null)),
        ]),
        "owner 窄读回必须带保存值，历史缺省以 null 表示 unknown"
    );
    tx.commit().await.unwrap();
    pool.close().await;
}

#[tokio::test]
async fn human_edit_saves_explicit_declarations_without_trusting_origin_or_changing_replay() {
    let _guard = SERIAL.lock().await;
    let pool = harness_pool().await;
    let ctx = context("synthetic-new-human-declaration");
    let create_input = json!({"operation_id":"create-human-declaration-edit","kind":"term",
        "name":"人工声明合成规则","body":"尚未声明。","related_ids":[]});
    let mut object =
        data_agent::use_cases::knowledge::edit(&pool, &ctx, None, "create", create_input)
            .await
            .unwrap();
    let prerequisite = create(&pool, &ctx, "human-edit-prerequisite", "term").await;
    let reference = json!({"object_id":prerequisite["id"],"version":"1","path":"body"});
    let id = object["id"].as_str().unwrap().to_owned();
    let mut previous_id = None;
    for (index, declaration) in [
        Some(json!(true)),
        Some(json!(false)),
        Some(Value::Null),
        None,
    ]
    .into_iter()
    .enumerate()
    {
        let mut draft = json!({"key":"stable-human-rule",
            "target":{"object_id":id,"version":object["version"],"path":"body"},
            "text":"人工合成规则。","scope_text":"仅合成演练。","citations":[],
            "supports":[{"key":"prerequisite","role":"prerequisite","reference":{"kind":"knowledge","ref":reference},
                "content":"仅合成","embedded_in":{"field":"scope_text","locator":{"offset":0,"length":3}}}]});
        if let Some(value) = declaration.clone() {
            draft["supports_complete"] = value;
        }
        let input = json!({"operation_id":format!("save-human-declaration-{index}"),
            "expected_version":object["version"],"entry_id":"body",
            "value":"人工合成规则。\n仅合成演练。","statements":[draft]});
        object =
            data_agent::use_cases::knowledge::edit(&pool, &ctx, Some(&id), "edit", input.clone())
                .await
                .unwrap();
        let statement = &object["entries"][0]["human_override"]["statements"][0];
        assert_eq!(statement["origin"], "human", "人工身份由已授权保存入口绑定");
        assert_eq!(
            statement["object_ref"],
            json!({"object_id":id,"version":object["version"],"path":"body"})
        );
        assert_eq!(
            statement.get("supports_complete").cloned(),
            declaration,
            "true/false/null/历史缺字段不互相推导"
        );
        assert_eq!(statement["supports"][0]["reference"]["ref"], reference);
        let sid = statement["statement_id"].as_str().unwrap().to_owned();
        assert!(!sid.is_empty());
        if let Some(previous) = &previous_id {
            assert_eq!(&sid, previous, "同一人工陈述key在改版后保持原身份");
        }
        previous_id = Some(sid.clone());
        contracts::validate("SemanticStatement", statement).unwrap();
        let replay = data_agent::use_cases::knowledge::edit(&pool, &ctx, Some(&id), "edit", input)
            .await
            .unwrap();
        assert_eq!(replay, object, "原operation接回成功保存，不重写声明或版本");
        let mut tx = AppTx::begin(&pool).await.unwrap();
        let page = knowledge::read_entry_page_in_tx(
            &mut tx,
            &ctx,
            &contracts::decode(
                "EvidenceRef",
                json!({"object_id":id,"version":object["version"],"path":"body"}),
            )
            .unwrap(),
            Some(&sid),
            false,
            0,
            4096,
        )
        .await
        .unwrap();
        assert_eq!(page["content"], "人工合成规则。\n仅合成演练。");
        assert_eq!(
            page["supports_complete"],
            declaration.unwrap_or(Value::Null)
        );
        assert_eq!(page["supports_total"], 1);
        tx.commit().await.unwrap();
    }
    let valid_draft = json!({"key":"stable-human-rule",
        "target":{"object_id":id,"version":object["version"],"path":"body"},
        "text":"人工合成规则。","scope_text":"仅合成演练。","citations":[],"supports":[],"supports_complete":true});
    for (label, mut draft) in [
        ("different-body", valid_draft.clone()),
        ("different-target", valid_draft.clone()),
        ("invalid-support", valid_draft.clone()),
        ("invalid-embedding", valid_draft.clone()),
    ] {
        match label {
            "different-body" => draft["text"] = json!("正文未包含的声明。"),
            "different-target" => draft["target"]["object_id"] = prerequisite["id"].clone(),
            "invalid-support" => {
                draft["supports"] = json!([{"key":"invalid","role":"exception",
                "reference":{"kind":"knowledge","ref":{"object_id":"unavailable-human-support","version":"1","path":"body"}},
                "content":null,"embedded_in":null}])
            }
            "invalid-embedding" => {
                draft["supports"] = json!([{"key":"invalid","role":"exception",
                "reference":{"kind":"knowledge","ref":reference},"content":"不匹配",
                "embedded_in":{"field":"scope_text","locator":{"offset":0,"length":3}}}])
            }
            _ => unreachable!(),
        }
        let input = json!({"operation_id":format!("reject-human-{label}"),"expected_version":object["version"],
            "entry_id":"body","value":"人工合成规则。\n仅合成演练。","statements":[draft]});
        assert!(
            data_agent::use_cases::knowledge::edit(&pool, &ctx, Some(&id), "edit", input)
                .await
                .is_err(),
            "{label}不能生成有效人工声明"
        );
    }
    let batch = contracts::decode(
        "KnowledgeBatchEdit",
        json!({"operation_id":"human-batch-declaration","objects":[{"object_id":id,
            "expected_version":object["version"],"edits":[{"entry_id":"body",
                "value":"人工合成规则。\n仅合成演练。","statements":[valid_draft]}]}]}),
    )
    .unwrap();
    let receipt = data_agent::use_cases::knowledge::edit_batch(&pool, &ctx, batch)
        .await
        .unwrap();
    let edited = &receipt["objects"][0];
    let batch_statement = &edited["entries"][0]["human_override"]["statements"][0];
    assert_eq!(batch_statement["object_ref"]["version"], edited["version"]);
    object = edited.clone();
    let saved = data_agent::use_cases::knowledge::edit(
        &pool,
        &ctx,
        Some(&id),
        "edit",
        json!({"operation_id":"human-plain-replacement","expected_version":object["version"],
            "entry_id":"body","value":"完全替换的新人工规则。"}),
    )
    .await
    .unwrap();
    assert!(
        saved["entries"][0]["human_override"]
            .get("statements")
            .is_none(),
        "普通正文替换不继承旧的支持完整性声明"
    );
    pool.close().await;
}
