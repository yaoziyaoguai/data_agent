use super::*;
use serde_json::json;

#[test]
fn candidate_terms_keep_all_distinct_terms_within_budget() {
    for query in ["", "_ ,", "退款率", "Revenue refund_rate"] {
        let selected = candidate_terms(query);
        let expected = tokens(query)
            .into_iter()
            .collect::<std::collections::HashSet<_>>();
        assert!(selected.complete);
        assert_eq!(
            selected
                .values
                .iter()
                .cloned()
                .collect::<std::collections::HashSet<_>>(),
            expected
        );
    }
    let repeated = candidate_terms(&format!("{}退款率", "unusedprefix ".repeat(30)));
    assert!(repeated.complete);
    assert_eq!(repeated.values, ["unusedprefix", "退款率", "退款", "款率"]);
    let boundary = (0..24).map(|n| format!("word{n}")).collect::<Vec<_>>();
    let selected = candidate_terms(&boundary.join(" "));
    assert!(selected.complete);
    assert_eq!(selected.values, boundary);
}

#[test]
fn candidate_terms_cover_long_queries_without_narrowing_score() {
    for query in [
        "退款率请先按照当前可见的业务资料帮我认真核对一下这张表在最近一个统计周期内的口径",
        "请先按照当前可见的业务资料退款率帮我认真核对一下这张表在最近一个统计周期内的口径",
        "请先按照当前可见的业务资料帮我认真核对一下这张表在最近一个统计周期内的退款率",
    ] {
        let selected = candidate_terms(query);
        assert!(!selected.complete);
        assert_eq!(selected.values.len(), 24);
        assert!(
            selected.values.iter().any(|term| "退款率".contains(term)),
            "{query}"
        );
    }
    let query = (0..48)
        .map(|n| format!("qtoken{n:02}"))
        .collect::<Vec<_>>()
        .join(" ");
    let selected = candidate_terms(&query);
    assert!(!selected.complete);
    assert_eq!(selected.values.len(), 24);
    assert_eq!(selected.values.first().unwrap(), "qtoken00");
    assert_eq!(selected.values.last().unwrap(), "qtoken47");
    assert!(!selected.values.iter().any(|term| term == "qtoken45"));
    // 候选词裁剪只影响召回，不裁完整问句的词面：qtoken45不在选定的24个候选
    // 词里，但完整问句token仍包含它（定位/展示计分用完整问句，不经候选词表）。
    assert!(!selected.values.iter().any(|term| term == "qtoken45"));
    assert!(tokens(&query).iter().any(|term| term == "qtoken45"));
}

#[test]
fn workspace_trims_old_candidates_before_current_task_and_keeps_authority_private() {
    let current = json!({"id":"current","goal":"合成当前目标","condition_version":"3","lifecycle":"active","phase":"waiting_clarification","conditions":{"notes":"当前条件".repeat(600)},"clarification":{"question":"当前问题？"}});
    let mut workspace = json!({"tasks":[current.clone(),{"id":"old","conditions":{"notes":"旧条件".repeat(1600)},"clarification":{"question":"旧问题？"}}],"input_task_ids":["current"],"memories":[],"selected_skills":[],"query_observations":[],"recent_messages":[],"authority_snapshot":{"private":"宿主校验".repeat(10000)}});
    let authority = workspace["authority_snapshot"].clone();
    bound_workspace(&mut workspace);
    assert_eq!(workspace["tasks"][0], current);
    assert_eq!(workspace["tasks"][1]["context_complete"], false);
    assert_eq!(workspace["tasks"][1]["conditions"], Value::Null);
    assert_eq!(workspace["authority_snapshot"], authority);
    workspace
        .as_object_mut()
        .unwrap()
        .remove("authority_snapshot");
    assert!(workspace.to_string().len() <= 16000);
}

#[test]
fn oversized_current_task_keeps_identity_and_an_explicit_read_hint() {
    let mut workspace = json!({"tasks":[{"id":"current","goal":"长目标".repeat(300),"condition_version":"3","lifecycle":"active","phase":"waiting_clarification","conditions":{"notes":"当前条件".repeat(3000)},"clarification":{"question":"当前问题？"}}],"input_task_ids":["current"],"memories":[{"id":"optional","body":"记忆".repeat(2000)}],"selected_skills":[],"query_observations":[],"recent_messages":[]});
    bound_workspace(&mut workspace);
    assert!(workspace.to_string().len() <= 16000);
    assert_eq!(workspace["input_task_ids"], json!(["current"]));
    assert_eq!(workspace["tasks"].as_array().unwrap().len(), 1);
    assert_eq!(
        workspace["tasks"][0],
        json!({"id":"current","condition_version":"3","lifecycle":"active","phase":"waiting_clarification","context_complete":false})
    );
    assert!(workspace["memories"].as_array().unwrap().is_empty());
}

#[test]
fn query_example_summary_keeps_questions_parameters_and_a_complete_read_hint() {
    let object = json!({"id":"example","kind":"query_example","entries":[{
        "entry_id":"body","path":"body","effective_value":"合成案例说明",
        "effective_structure":{"kind":"query_example","applicable_question":"需要按指定标签统计商品行数",
            "parameters":[{"name":"cohort","type":"string","description":"输出标签，不改变范围","required":true}],
            "sql":"SELECT COUNT(*) FROM purchases","grain":"单行汇总","dependencies":[],"verification":null}
    }]});
    let preview = search_preview(object.clone(), "商品行数");
    assert_eq!(
        preview["query_example_summary"]["applicable_question"],
        "需要按指定标签统计商品行数"
    );
    assert_eq!(
        preview["query_example_summary"]["parameters"][0]["description"],
        "输出标签，不改变范围"
    );
    assert_eq!(
        preview["query_example_summary"]["verification_recorded"],
        false
    );
    assert!(
        preview["query_example_summary"]["note"]
            .as_str()
            .unwrap()
            .contains("read_knowledge")
    );
    let index = query_example_index_text(&object["entries"][0]);
    assert!(index.contains("需要按指定标签统计商品行数") && index.contains("输出标签，不改变范围"));
}

#[test]
fn hybrid_ranking_keeps_relevant_fields_without_kind_quotas() {
    let fields = ["amount", "rate", "count", "net", "total", "tax"].map(|field| {
        json!({"id":field,"name":format!("sales refund {field}"),"kind":"field","version":"1"})
    });
    let mut objects = fields.to_vec();
    for kind in [
        "table",
        "metric",
        "query_example",
        "document",
        "relationship",
        "term",
    ] {
        objects
            .push(json!({"id":kind,"name":"unrelated","kind":kind,"version":"1","body":"refund"}));
    }
    // 后备词法路（SQL统一合并序，05接续）：名称含整句且名称双词命中的字段在
    // 先（按稳定ID），仅正文弱命中的六类对象在后；排名消费该输入序。
    let lexical = vec![
        json!({"id":"amount","name_hit":true,"name_term_hits":2,"term_hits":3}),
        json!({"id":"count","name_hit":true,"name_term_hits":2,"term_hits":3}),
        json!({"id":"net","name_hit":true,"name_term_hits":2,"term_hits":3}),
        json!({"id":"rate","name_hit":true,"name_term_hits":2,"term_hits":3}),
        json!({"id":"tax","name_hit":true,"name_term_hits":2,"term_hits":3}),
        json!({"id":"total","name_hit":true,"name_term_hits":2,"term_hits":3}),
        json!({"id":"document","name_hit":false,"name_term_hits":0,"term_hits":1}),
        json!({"id":"metric","name_hit":false,"name_term_hits":0,"term_hits":1}),
        json!({"id":"query_example","name_hit":false,"name_term_hits":0,"term_hits":1}),
        json!({"id":"relationship","name_hit":false,"name_term_hits":0,"term_hits":1}),
        json!({"id":"table","name_hit":false,"name_term_hits":0,"term_hits":1}),
        json!({"id":"term","name_hit":false,"name_term_hits":0,"term_hits":1}),
    ];
    let fields_sorted = {
        let mut sorted = fields.to_vec();
        sorted.sort_by_key(|object| object["id"].as_str().unwrap().to_owned());
        sorted
    };
    for limit in [0, 1, 2, 3, 4, 6, 10] {
        let ranked = rank_common(
            "sales refund",
            objects.clone(),
            &Channels::knowledge(&lexical, &[]),
            limit,
            false,
        )
        .objects;
        let protected = limit.min(fields_sorted.len());
        assert_eq!(
            &ranked[..protected],
            &fields_sorted[..protected],
            "limit={limit}"
        );
        assert!(ranked.len() <= limit);
    }
    objects.insert(0, fields[0].clone());
    assert_eq!(
        &rank_common(
            "sales refund",
            objects,
            &Channels::knowledge(&lexical, &[]),
            6,
            false
        )
        .objects[..6],
        &fields_sorted,
        "重复候选不能占位，也不能让弱类型挤掉高相关字段"
    );
}

#[test]
fn hybrid_ranking_keeps_exact_names_ties_versions_and_relevance() {
    let object =
        |id: &str, name: &str, kind: &str| json!({"id":id,"name":name,"kind":kind,"version":"2"});
    let objects = vec![
        object("table-b", "needle detail", "table"),
        object("table-a", "needle archive", "table"),
        object("field", "needle value", "field"),
        object("metric", "needle count", "metric"),
        object("document", "needle rules", "document"),
        object("relationship", "needle link", "relationship"),
        object("term", "needle term", "term"),
        object("exact", "NEEDLE", "document"),
        object("only-vector", "other domain", "table"),
        object("obsolete", "outdated unrelated", "table"),
    ];
    let vectors = vec![
        json!({"id":"only-vector","version":"2"}),
        json!({"id":"obsolete","version":"1"}),
    ];
    let ids = |items: Vec<Value>| {
        items
            .into_iter()
            .map(|v| v["id"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>()
    };
    // 后备词法路输入序（SQL统一合并序）：名称含整句的对象按稳定ID排，全部
    // 同分（name_hit=1,name_term_hits=1,term_hits=0）→ document,exact,field,
    // metric,relationship,table-a,table-b,term。dense命中only-vector(v2绑定)。
    let lexical = vec![
        json!({"id":"document","name_hit":true,"name_term_hits":1,"term_hits":0}),
        json!({"id":"exact","name_hit":true,"name_term_hits":1,"term_hits":0}),
        json!({"id":"field","name_hit":true,"name_term_hits":1,"term_hits":0}),
        json!({"id":"metric","name_hit":true,"name_term_hits":1,"term_hits":0}),
        json!({"id":"relationship","name_hit":true,"name_term_hits":1,"term_hits":0}),
        json!({"id":"table-a","name_hit":true,"name_term_hits":1,"term_hits":0}),
        json!({"id":"table-b","name_hit":true,"name_term_hits":1,"term_hits":0}),
        json!({"id":"term","name_hit":true,"name_term_hits":1,"term_hits":0}),
    ];
    // exact优先(100+1/61)；document词法第一1/60与only-vector dense第一1/60
    // 同分，按record键k:document<k:only-vector稳定；obsolete的dense命中版本
    // (v1)与对象版本(v2)不符，不得计票。
    assert_eq!(
        ids(rank_common(
            "needle",
            objects.clone(),
            &Channels::knowledge(&lexical, &vectors),
            3,
            false
        )
        .objects),
        ["exact", "document", "only-vector"]
    );
    assert_eq!(
        ids(rank_common(
            "needle",
            objects,
            &Channels::knowledge(&lexical, &vectors),
            6,
            false
        )
        .objects),
        [
            "exact",
            "document",
            "only-vector",
            "field",
            "metric",
            "relationship"
        ]
    );
    // 同分词法候选的名次来自SQL统一合并的稳定ID序，rank_common按输入序计票。
    let ties = vec![
        object("z", "needle", "metric"),
        object("a", "needle", "metric"),
    ];
    let ties_lexical = vec![
        json!({"id":"a","name_hit":true,"name_term_hits":1,"term_hits":0}),
        json!({"id":"z","name_hit":true,"name_term_hits":1,"term_hits":0}),
    ];
    assert_eq!(
        ids(rank_common(
            "needle",
            ties,
            &Channels::knowledge(&ties_lexical, &[]),
            2,
            false
        )
        .objects),
        ["a", "z"]
    );
}

#[test]
fn sql_lexical_merge_unifies_scores_and_identity_order() {
    // 两个SQL来源按记录身份合并：各维命中取最高、名称含整句按任一来源命中
    // 即保留；名次序=名称含整句、名称词命中、正文词命中降序、稳定ID；末尾
    // 多词强项不因来源不同或ID靠后被挤掉（05接续反例的合并层判定）。名称词
    // 命中优先于正文命中数：名称是更强的相关信号。
    let current = vec![
        json!({"id":"aa-weak","name_hit":false,"name_term_hits":0,"term_hits":1}),
        json!({"id":"zz-strong","name_hit":false,"name_term_hits":0,"term_hits":4}),
        json!({"id":"name-probe","name_hit":false,"name_term_hits":2,"term_hits":2}),
    ];
    let indexed = vec![
        json!({"id":"aa-weak","name_term_hits":0,"term_hits":1}),
        json!({"id":"mid-name","name_hit":true,"name_term_hits":1,"term_hits":2}),
        json!({"id":"zz-strong","name_term_hits":0,"term_hits":3}),
        json!({"id":"name-probe","name_term_hits":1,"term_hits":3}),
    ];
    let merged = merge_sql_lexical(current, indexed);
    let ids: Vec<_> = merged
        .iter()
        .map(|row| row["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["mid-name", "name-probe", "zz-strong", "aa-weak"]);
    assert_eq!(merged[2]["term_hits"], 4, "跨来源取最高命中");
    assert_eq!(merged[0]["name_hit"], true, "名称含整句按任一来源保留");
    assert_eq!(merged[1]["name_term_hits"], 2, "名称词命中跨来源取最高");
}

#[test]
fn sql_lexical_merge_preserves_content_records_and_highest_relevance() {
    let content = |record: &str, version: &str, entry: &str, offset: usize, hits: i64| {
        json!({"id":"shared-object","version":version,"record_id":record,
            "projection_version":crate::types::KNOWLEDGE_PROJECTION,
            "name_hit":false,"name_term_hits":0,"term_hits":hits,
            "matches":[{"fragment_id":record,"entry_id":entry,"path":"description",
                "offset":offset,"length":360,"content_hash":null,"score":hits}]})
    };
    let merged = merge_sql_lexical(
        vec![
            content("entry-a-0", "1", "a", 0, 1),
            content("entry-a-280", "1", "a", 280, 2),
            content("entry-b-0", "1", "b", 0, 3),
            content("entry-a-v2", "2", "a", 0, 4),
        ],
        vec![content("entry-a-0", "1", "a", 0, 5)],
    );
    assert_eq!(
        merged.iter().map(knowledge_record).collect::<Vec<_>>(),
        ["entry-a-0", "entry-a-v2", "entry-b-0", "entry-a-280"],
        "同一对象不同条目、窗口和修订各占身份；重复record取最高相关性",
    );
    assert_eq!(merged[0]["term_hits"], 5);
    assert_eq!(merged[0]["matches"][0]["score"].as_f64(), Some(5.0));
    assert_eq!(merged[0]["matches"][0]["entry_id"], "a");
    assert_eq!(merged[1]["version"], "2");
    assert_eq!(merged[2]["matches"][0]["entry_id"], "b");
    assert_eq!(merged[3]["matches"][0]["offset"], 280);
    assert_eq!(merged[3]["matches"][0]["length"], 360);
}

#[test]
fn bm25_channel_ranks_without_memory_scoring_and_rrf_uses_k60() {
    // BM25通道可用时：命中按外部顺序参与RRF，未命中对象不得再靠内存子串计分混入。
    let object =
        |id: &str, name: &str, kind: &str| json!({"id":id,"name":name,"kind":kind,"version":"1"});
    let objects = vec![
        object("bm-hit", "语义无关但BM25命中", "table"),
        object("substring", "needle 子串", "table"),
        object("both", "needle 双通道", "table"),
    ];
    let lexical_hits = vec![
        json!({"id":"bm-hit","version":"1"}),
        json!({"id":"both","version":"1"}),
    ];
    let dense = vec![json!({"id":"both","version":"1"})];
    // RRF k=60：both = 2/(60+1)，bm-hit = 1/(60+1)；substring无BM25命中被内存回退
    // 排除。精确名仍优先。
    let ranked = rank_common(
        "查询",
        objects,
        &Channels::knowledge(&lexical_hits, &dense),
        3,
        false,
    )
    .objects;
    let ids: Vec<_> = ranked
        .iter()
        .map(|v| v["id"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(ids, ["both", "bm-hit"]);
    let exact = rank_common(
        "needle",
        vec![
            object("needle", "别名正文", "table"),
            object("dense-only", "别名无关", "table"),
        ],
        &Channels::knowledge(&lexical_hits, &dense),
        2,
        false,
    )
    .objects;
    assert_eq!(exact[0]["id"], "needle");
}

#[test]
fn common_ranking_excludes_unlocatable_source_rows_before_limiting_results() {
    let raw = vec![
        json!({"source_kind":"document","distance":100}),
        json!({"source_kind":"document","source_id":"readable","revision":1,
            "offset":0,"length":20,"segmentation_version":"source-structure-1","distance":1}),
    ];
    let ranked = rank_common("规则", vec![], &Channels::all(&[], &[], &raw, &[]), 1, true);
    assert_eq!(ranked.raw.len(), 1);
    assert_eq!(ranked.raw[0]["source_id"], "readable");
    assert_eq!(ranked.sequence.len(), 1);
}

#[test]
fn common_ranking_keeps_every_selected_raw_location_for_owner_reads() {
    let rows = (0..31).map(|offset| {
        json!({"id":format!("raw-{offset}"),"source_kind":"document","source_id":"many-positions",
            "revision":1,"offset":offset * 100,"length":100,"segmentation_version":"source-structure-1","distance":100 - offset})
    }).collect::<Vec<_>>();
    let ranked = rank_common(
        "规则",
        vec![],
        &Channels::all(&[], &[], &rows, &[]),
        31,
        true,
    );
    assert_eq!(ranked.sequence.len(), 31);
    assert_eq!(
        ranked.raw.len(),
        31,
        "共同排序保留所有已选定位，30个owner读取名额由组合入口统一分配"
    );
    for (_, key) in ranked.sequence {
        assert!(
            ranked
                .raw
                .iter()
                .any(|row| key == format!("raw:{}", raw_record(row).unwrap()))
        );
    }
}

#[test]
fn common_ranking_keeps_distinct_source_positions_and_fused_scores() {
    let row = |id: &str, offset: u64, distance: f64| {
        json!({"id":id,"source_kind":"document","source_id":"policy","revision":1,
            "offset":offset,"length":100,"segmentation_version":"source-structure-1","content_hash":"h","distance":distance})
    };
    // 一般规则与后段例外均相关；BM25与COSINE数值不可跨通道比较。
    let bm25 = vec![row("general", 0, 18.), row("exception", 2000, 3.)];
    let dense = vec![row("exception", 2000, 0.95)];
    let ranked = rank_common(
        "退款除外",
        vec![],
        &Channels::all(&[], &[], &bm25, &dense),
        2,
        true,
    );
    assert_eq!(ranked.raw.len(), 2, "同文不同位置各占一项");
    assert_eq!(
        ranked.raw[0]["id"], "exception",
        "双通道例外段排在单通道规则段之前"
    );
    assert_eq!(ranked.raw[1]["id"], "general");
    assert!(ranked.raw[0]["score"].as_f64().unwrap() > ranked.raw[1]["score"].as_f64().unwrap());
}

#[test]
fn common_ranking_merges_raw_and_knowledge_in_one_rrf() {
    // 05切片4：raw与knowledge共同参与每个通道，两通道同权一次RRF。强raw
    // （双通道首位）不被弱知识挤掉；同一位置跨通道去重计票，不同位置独立；两个
    // 来源record与知识对象在名次表内按全局分数交错（跨文档高/低窗口不整篇
    // 分组），raw按同一序供回源。
    let row = |id: &str, source: &str, offset: u64, distance: f64| {
        json!({"id":id,"source_kind":"platform","source_id":source,"revision":3,
            "offset":offset,"length":120,"segmentation_version":"source-structure-1","content_hash":"h","distance":distance})
    };
    let object = |id: &str| json!({"id":id,"name":"弱相关知识","kind":"document","version":"1"});
    let objects = vec![object("weak-doc"), object("mid-doc")];
    let bm25 = vec![
        json!({"id":"weak-doc","version":"1","matches":[{"score":9.}]}),
        json!({"id":"mid-doc","version":"1","matches":[{"score":2.}]}),
    ];
    let dense = vec![json!({"id":"mid-doc","version":"1","matches":[{"score":0.5}]})];
    let raw_bm25 = vec![
        row("frag-a", "strong-src", 0, 8.),
        row("frag-b", "strong-src", 480, 7.),
        row("frag-d", "other-src", 240, 5.),
    ];
    let raw_dense = vec![
        row("frag-c", "strong-src", 0, 0.9),
        row("frag-e", "other-src", 240, 0.4),
    ];
    let mixed = rank_common(
        "退款时效",
        objects.clone(),
        &Channels::all(&bm25, &dense, &raw_bm25, &raw_dense),
        3,
        true,
    );
    // 同一名次表：strong-src(≈1/61+1/60)居首，双通道mid-doc(≈1/63+1/61)第
    // 二，other-src(≈2/62)第三——弱知识不挤高分raw，raw与知识交错分占名额。
    assert_eq!(
        mixed
            .objects
            .iter()
            .map(|v| v["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["mid-doc"],
        "内部混排：raw占两名额，知识对象按剩余名额交付"
    );
    assert_eq!(mixed.raw.len(), 2, "共同名额保留两个最高分位置");
    assert_eq!(
        mixed
            .raw
            .iter()
            .map(|v| v["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["frag-a", "frag-d"],
        "位置按全局RRF分数交错，跨通道保留一份定位"
    );
    // 统一次序（05接续）：sequence跨record_kind保留交错名次，raw与知识的
    // 相对位置不因类型视图拆分而丢失。
    let order: Vec<&str> = mixed
        .sequence
        .iter()
        .map(|(_, key)| {
            key.strip_prefix("raw:platform:strong-src")
                .map(|_| "strong-src")
                .or_else(|| {
                    key.strip_prefix("raw:platform:other-src")
                        .map(|_| "other-src")
                })
                .or_else(|| key.strip_prefix("k:").map(|_| "mid-doc"))
                .unwrap_or("?")
        })
        .collect();
    assert_eq!(order, ["strong-src", "mid-doc", "other-src"]);
    assert!(
        mixed.sequence[0].0 > mixed.sequence[1].0 && mixed.sequence[1].0 > mixed.sequence[2].0,
        "统一次序按融合分数单调"
    );
    // v1可交付范围：raw不参与排名不占名额，limit=1交付知识对象。
    let v1 = rank_common(
        "退款时效",
        objects,
        &Channels::knowledge(&bm25, &dense),
        1,
        false,
    );
    assert_eq!(v1.raw.len(), 0, "v1不交付raw");
    assert_eq!(v1.objects.len(), 1);
    assert_eq!(v1.objects[0]["id"], "mid-doc", "v1名额在raw前置过滤后计算");
}

#[test]
fn common_ranking_raw_first_at_limit_one_and_exact_not_a_third_vote() {
    // 必须覆盖：raw第一、knowledge第二、limit=1——内部双类型返回raw；v1在
    // 可交付范围内返回knowledge。exact是加分优先不是第三票：无通道命中的
    // exact对象仍排首，但不再叠加通道票。
    let row = |id: &str, source: &str, distance: f64| {
        json!({"id":id,"source_kind":"document","source_id":source,"revision":1,
            "offset":0,"length":200,"segmentation_version":"source-structure-1","content_hash":"h","distance":distance})
    };
    let objects = vec![
        json!({"id":"doc-strong","name":"非精确名","kind":"document","version":"1"}),
        json!({"id":"exact-id","name":"别名","kind":"document","version":"1"}),
    ];
    let bm25 = vec![json!({"id":"doc-strong","version":"1","matches":[{"score":10.}]})];
    let raw_bm25 = vec![row("rf", "src-a", 9.)];
    let raw_dense = vec![row("rf2", "src-a", 0.95)];
    let internal = rank_common(
        "query",
        objects.clone(),
        &Channels::all(&bm25, &[], &raw_bm25, &raw_dense),
        1,
        true,
    );
    // 内部双类型：raw双通道票(≈1/61+1/60)高于知识单通道票(1/60)，limit=1
    // 的唯一名额给raw，知识对象为空。
    assert_eq!(internal.raw.len(), 1);
    assert_eq!(
        internal.raw[0]["id"], "rf",
        "同一位置只保留一份定位，不比较跨通道原始分数"
    );
    assert!(
        internal.objects.is_empty(),
        "limit=1名额被raw占据（内部语义）"
    );
    // exact优先：exact-id无通道命中仍以加分优先返回。
    let exact = rank_common(
        "exact-id",
        objects,
        &Channels::knowledge(&[], &[]),
        2,
        false,
    );
    assert_eq!(exact.objects[0]["id"], "exact-id");
}

#[test]
fn exact_name_keeps_channel_ranks_between_content_records() {
    let content = |record: &str| json!({"id":"shared-object","name":"exactneedle","version":"1","record_id":record});
    let channels = vec![content("z-body"), content("a-domain")];
    let ranked = rank_common(
        "exactneedle",
        vec![content("a-domain"), content("z-body")],
        &Channels::knowledge(&channels, &[]),
        2,
        false,
    );
    assert_eq!(
        ranked
            .objects
            .iter()
            .map(knowledge_record)
            .collect::<Vec<_>>(),
        ["z-body", "a-domain"],
        "精确名称只决定优先级，同对象内容仍按原通道名次排序",
    );
}

#[test]
fn asset_search_keeps_exact_name_ahead_of_prefix_matches() {
    for (query, name) in [("合成方法1", "合成方法1"), ("REPORT", "report")] {
        let asset = |id: String, name: String| {
            json!({"id":id,"kind":"memory","name":name,"version":"1",
                "body":"合成正文".repeat(60),"scope":"合成范围".repeat(60),
                "verified":false,"selected":false})
        };
        let mut items: Vec<Value> = (0..20)
            .map(|i| asset(format!("prefix-{i:02}"), format!("{name}{i}")))
            .collect();
        items.push(asset("target".into(), name.into()));
        let page = asset_directory(items, query, None, 30).unwrap();
        // 长摘要触发字节分页时，完整名称仍应留在首页，不能被同前缀条目挤掉。
        assert_eq!(page["memories"][0]["id"], "target");
        assert!(!page["next_asset_after"].is_null());
        assert_eq!(page["total"], 21);
    }
}

#[test]
fn memory_source_can_be_read_without_losing_trailing_exceptions() {
    let source = format!(
        "以后默认按渠道展示。{}但仅限订单分析，退款分析仍按当次要求。",
        "补充范围🙂".repeat(170)
    );
    let asset = json!({"id":"memory","kind":"memory","body":"按渠道展示",
        "scope":"订单分析","source_text":source,"version":"2"});
    let preview = model_page(asset.clone(), 0, 600, None);
    assert_eq!(preview["source_text"], "");
    assert_eq!(
        preview["source_page"]["total_chars"],
        source.chars().count()
    );
    assert_eq!(preview["source_page"]["complete"], false);
    assert_eq!(preview["source_page"]["next_offset"], 0);
    let mut joined = String::new();
    let mut offset = 0;
    loop {
        let page = model_page(asset.clone(), offset, 101, Some("source_text"));
        assert_eq!(page["body"], "");
        assert_eq!(page["version"], "2");
        joined.push_str(page["source_text"].as_str().unwrap());
        match page["source_page"]["next_offset"].as_u64() {
            Some(next) => {
                assert!(next as usize > offset);
                offset = next as usize;
            }
            None => break,
        }
    }
    assert_eq!(joined, source);
    let empty = model_page(json!({"body":"正文","source_text":""}), 0, 600, None);
    assert_eq!(empty["source_page"]["complete"], true);
    assert!(empty["source_page"]["next_offset"].is_null());
}

#[test]
fn model_can_read_all_analysis_gaps_and_evidence_across_pages() {
    let details = json!({"gaps":["税费规则未提供", "上游验证范围待补充".repeat(60)],
        "evidence":[{"source_id":"upstream","version":"2","location":"L1","quote":"上游计算规则"},
            {"source_id":"business-guide","version":"3","location":"L9","quote":"业务范围"}],
        "validated":"引用已核对，业务含义待确认"});
    let object = json!({"entries":[{"entry_id":"meaning","effective_value":"当前定义", "source_facts":{},
        "suggestion":details,"human_override":null}]});
    let mut joined = String::new();
    let mut offset = 0;
    loop {
        let page = model_page(object.clone(), offset, 100, Some("meaning"));
        let suggestion = &page["entries"][0]["suggestion"];
        assert_eq!(suggestion["application"], "effective");
        joined.push_str(suggestion["details"].as_str().unwrap());
        match suggestion["content_page"]["next_offset"].as_u64() {
            Some(next) => {
                assert!(next as usize > offset);
                offset = next as usize;
            }
            None => break,
        }
    }
    assert_eq!(serde_json::from_str::<Value>(&joined).unwrap(), details);
}

#[test]
fn human_definition_and_unadopted_analysis_stay_distinct() {
    let object = json!({"entries":[{"entry_id":"meaning","effective_value":"人工定义",
        "source_facts":{},"suggestion":{"value":"新分析","gaps":["未确定范围"],"evidence":[]},
        "human_override":{"edited_by":"alice"}}]});
    let directory = preview(object.clone());
    assert_eq!(
        directory["entries"][0]["suggestion"]["details_available"],
        true
    );
    let page = model_page(object, 0, 4096, Some("meaning"));
    assert_eq!(page["entries"][0]["effective_value"], "人工定义");
    assert_eq!(
        page["entries"][0]["suggestion"]["application"],
        "pending_review"
    );
    assert_eq!(page["entries"][0]["human_override"]["has_override"], true);
    let details: Value = serde_json::from_str(
        page["entries"][0]["suggestion"]["details"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(details["value"], "新分析");
    assert!(
        page["entries"][0]["suggestion"]["details"]
            .as_str()
            .unwrap()
            .contains("未确定范围")
    );
}
