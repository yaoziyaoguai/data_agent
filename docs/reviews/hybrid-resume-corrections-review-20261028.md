# 混合检索续审：本轮纠偏的独立复核

本文件只记录下列限定范围的独立代码审查。05 仍以 `docs/CURRENT.md` 为准；本文件不是整包通过收据，也不替代当前指纹的绑定验收。

最终范围清单：`.local/hybrid-resume-audit-20261028/correction-scope.json`，基于接手时的 `before-manifest.json` 与 `HEAD=04d27d0`，记录本轮15份产品/测试/命令文件；`scope_sha256=78bd2fd9997d811be86c7f894c1a37ac3111007c2b61015c81003a194322ae0e`。审查者已逐文件重算SHA256，15份均与清单一致。本文件只对其中下列 `root-review` 和 `structure-review` 范围给独立结论；恢复实现由其他审查者负责，清单包含该文件不代表本审查者审查了自己的实现。05保持 `active`。

## root-review

- 审查者：`/root/audit_index_and_projection`。
- 实施者：父代理 `/root`；审查者未参与本节对应实现。
- 范围：`use_cases/knowledge.rs` 的检索推进与最终装配，`use_cases/knowledge_embeddings.rs` 的 `SearchLaunch` 及之后，`use_cases/data_tools.rs` 的首次范围准备与绝对期限，`modules/retrieval/vector.rs` 的共享在途候选名额，以及对应期限与名额测试。不包含本审查者编写的索引恢复修复；结构窄投影单列于下节。
- 比较依据：本轮开始前保存的 `.local/hybrid-resume-audit-20261028/before/`、当前代码、执行包既有期限/预算/范围合同和实际日志。
- 结论：本节限定范围内，已指出的两处跨期错误吞并已修正；复读后未发现新的阻断问题。下列未闭合主链仍须由后续05接续工作完成，不能据此关闭05。

核对结果：

1. 词法与稠密首批任一路就绪即可进入原组合用例的排名和正文预读；达到内容名额不再提前取消尚需结算的 Embedding。最终装配可以跳过未读项，继续交付已完成、已核验的后续项。
2. 退出路径接回受同一绝对期限保护的词法结果，保留实际分片和轮次，再等待已派发 Embedding 的原账本结算；普通工作错误经原 `Result` 返回，没有增加另一套 Agent、恢复器或后台结算器。词法任务错误先保存，不能跳过已派发 Embedding 的收尾。`budget_unavailable` 与原有可降级的嵌入失败明确归类，其他错误继续传播。
3. 首次范围准备超时传入空的 `AllowedRecords`，没有用缺省范围扩大检索。最终短事务继续核对租约、当前权限与版本；这些检查对应状态跨事务变化，不是对同一入口数据重复执行 Schema 校验。
4. 两处正文读取的超时匹配现在先处理 `Ok(Err(error))`，再处理跨期的成功内容。实际存储或业务错误不再仅因返回时已过期而变成正常 `bounded`。
5. 共享候选额度在发出请求前预留，在回执时释放预留并按实际唯一记录计数，修正两个并发请求分别拿到同一剩余额度的问题。没有为尚未证明需要的等待/唤醒情况增加通用协调框架。

已核对的证据：

| 证据 | 实际证明 | 限制 |
| --- | --- | --- |
| `.local/hybrid-resume-audit-20261028/deadline-closure.log`；`tests/mvp/check-retrieval-deadline-order.mjs` | 最终六个期限/顺序场景通过，完整命令154.1秒；包含慢词法、慢 Embedding、真实账本锁跨期限、已读子集及共享30名额。测试在工具返回后立即检查账本，没有轮询等待后台结果来掩盖提前返回 | 本地真实存储与本地受控 Embedding，不证明真实模型质量；官方模型请求数为0 |
| `.local/hybrid-resume-audit-20261028/budget-red.log`、`budget-green.log` | 已读900个候选时两个并发各申请100，旧实现错误分配200；修复后共享预留的四项单测通过 | 纯名额单测，不代表整条检索链已完成 |
| `.local/hybrid-resume-audit-20261028/retrieval-lib-closure.log`、`verify-code-closure.log`、`build-closure.log`、`closure-checks.json` | 最终检索单测42项通过；代码检查和API/Worker重建退出码均为0 | 相称本地回归，不证明整包验收或真实模型表现 |
| 两处 `timeout_at(...load_selected_in_tx...)` 当前代码 | 内层错误先于时间分支传播 | 本次最后这项是静态复读，未据此宣称新增真实故障注入已运行 |

仍有明确缺口：内容名额目前仍以对象/版本聚合；慢的后续深度页仍可能阻挡另一通道；SQL后备尚未完全并入同一推进过程。预留额度暂时被在途请求占满时，另一游标可能提前停在 `candidate_limit`，即使后续释放额度也不会重启；当前结果如实标有界，不为此另建等待框架。上述限制应继续在05执行包中说明，不能改验收文字视为完整交付。

最终电池补记：`deadline-progress-red.json` / `deadline-final.log` 暴露原退出分支直接中止词法任务，导致已经执行的分片事实丢失为0。修复改为接回 `LexicalScan`，未放宽原测试断言。已静态核对 `search_lexical_scoped` 的目标确认、每片请求均使用从入口传入的同一绝对期限；`run_lexical → milvus_at_deadline → timeout_at` 没有重置期限，底层HTTP另有8秒超时。因此该等待没有新增无限网络等待。最后一片本身到期的遗漏也已修正：接收回执后达到共同期限即设置 `stopped=deadline` 并结束本轮，测试保留原分片断言并新增停轮原因断言。最终 `deadline-closure.log` 完整六项通过，慢词法回执保留 `shards=2`、`rounds=1`、`uncovered=deadline`，期限前已读正文与原账本收尾断言均通过。此次新绿色结果覆盖该修复，先前失败日志保留。

## structure-review

- 审查者：`/root/audit_index_and_projection`。
- 实施者：`/root/repair_search_projection`；审查者未参与本节对应实现。
- 范围：`modules/knowledge/store.rs::read_structure_refs_in_tx` / `read_table_binding_in_tx`、`modules/knowledge/structure.rs::validate_current_bindings_in_tx`、`use_cases/knowledge.rs::checked_refs_in_tx` / `semantic_object_in_tx`，结构窄读与列绑定测试，以及有关写入和预填路径的定点核对。
- 当前结论：限定范围通过独立复核。首次审查指出的列绑定回归已由两条真实维护路径复现并修正；当前只投影必要DDL并复用原绑定规则，保留人工原值，没有恢复完整语义快照、关联字段全文或加工SQL读取。此结论不扩大为05通过。

### 已修复：正常重预填可以保留已失效的列绑定

可达入口是 `POST /knowledge/:id/reanalyze` 和自动预填写回。二者最终调用 `modules/knowledge/store.rs::reanalyze_in_tx`：未人工覆盖的 DDL 随新候选更新；人工说明及 `human_override.structured_value` 原样保留并标记 `needs_review`。`persist` 只检查结构形状和单结构数量，没有重新核对列绑定。自动预填的 `ingestion::prefill::validate_result` 也仅校验结果形状、依据、结构类型和大小，没有核对结构中的列是否存在。

最小反例：表的人工结构以 `line_id` 为唯一键之一；下一次平台DDL删除该列，重预填继续保留这份人工结构。表结构没有外部 `structure_dependencies`，新的 `semantic_object_in_tx` 因而直接标记 `structure_coverage=complete` 并交付原结构。`needs_review` 在当前回执中不是禁用结构的条件。旧 `semantic_snapshot_in_tx` 会通过 `validate_bindings` / `check_column` 发现列已不存在，清除本次交付的有效结构并标记缺口。

原审查建议检查实际写入边界。定点核对确认，重预填按合同必须保留人工规则，预填建议也只承诺格式与依据核对；本轮因此保留一次采用前的必要绑定检查，不扩大为写入状态改造或新持久化状态。`read_table_binding_in_tx` 只返回当前表的身份、名称、版本和DDL；`validate_current_bindings_in_tx` 按选中结构涉及的表复用原 `columns` / `validate_bindings`，不重跑Schema。DDL不能证明完整列集时，原 `check_column` 本就拒绝采用，因此未再读取无助于完整性核验的字段目录。

缺列、当前版本失效或无法支持的绑定只改变本次交付的有效结构与缺口；数据库中的人工原值、建议及复核状态不改。SQL读取错误经既有 `sqlx::Error → unavailable` 返回，调用者不把该错误归入语义缺口。有效的 `needs_review` 结构也不被一概禁用。本轮两个新增函数分别承担模块私有投影和业务绑定核验职责，没有新增通用框架、重复Schema层或异常吞并。

已核对的证据与范围：

- `structure-read-red.log`：旧结构装配读取1548238字节的关联表，命中与零命中的下行差为7794914字节，窄读断言失败。
- `structure-read-green.log`：同类合成夹具表大小1544966字节，零命中下行39147字节、命中55532字节；关联表绑定保留，结构窄读断言通过。证明读取量改善，不证明上述变更路径正确。
- `structure-semantic-rules.log`：既有10项语义规则通过。其重预填测试保留原DDL，没有覆盖列被删除的情况。
- `column-bindings-reanalysis-red.log`、`column-bindings-prefill-red.log`：通过真实维护重分析/两阶段预填写回分别复现DDL删除列、模型建议不存在列后仍交付有效结构。仅来源和模型响应为合成材料，没有直接修改待测知识对象来伪造维护结果。
- `column-bindings-green.log`：新增3项全部通过，覆盖合法待复核规则仍可用、来源删列后保留人工原值但不采用无效结构、正式预填的错误列建议留缺口。回环模型调用2次，官方模型调用0次。
- `column-bindings-semantic-rules.log`：最终方案的原10项语义规则全部通过。
- `column-bindings-entry-read.log`：最终方案保留DDL核验后，合成关联表1544966字节，零命中39147字节、命中57098字节，增量17951字节；结构绑定保持可用，未选中的大加工SQL仍不随检索下行。该最终数据替代此前尚未包含必要DDL核验的16385字节增量。
- `structure-knowledge-reuse.log`：在知识来源修订后，将旧公共案例作为当前语义读取时得到 `stale_knowledge`，原预期为200，未通过。`structure-attribution-reuse-before.log` 仅还原两个结构函数后在相同位置仍失败；这排除了这两个函数作为该失败的充分原因。恢复新结构函数后已重建，见 `structure-attribution-build-restored.log`。
- 随后的 `knowledge-reuse-final.log` 完整16项通过。测试预期按正式设计17.3/17.4纠正为409，并明确断言不返回旧正文和SQL；该操作是当前语义读取，不能套用历史分析展示豁免。这是对错误预期的有依据纠正，不是放宽来源失效检查；上述历史失败日志保留。

本节不对本审查者编写的索引恢复代码作独立结论，也不签发05通过JSON。原回归发现与红绿证据保留，供后续维护核对读取优化没有取消必要业务校验。
