# 窄投影来源重核的独立审查（2026-10-28）

审查者：`repair_search_projection`。实施者：`audit_search_progress_and_deadline`。审查者没有实施下述来源修复；本轮另外参与的结构投影修复不在本报告的独立结论范围内。

**结论：此处有界修复通过审查，不代表05整包通过或可以关闭。**

## 范围与依据

对照本轮修改前快照，核对以下实际差异与调用路径：

- `crates/data-agent/src/use_cases/knowledge_sources.rs::requirements`：窄投影携带的完整 `required_sources` 优先于从已裁小 `entries` 重新推导来源；其他路径仍沿用原规则。
- `crates/data-agent/tests/knowledge_dependencies.rs::narrow_search_projection_rechecks_unshown_required_sources`：通过正式Rust检索组合及最终提交校验入口构造普通来源换版反例。
- 调用链：`retrieve_scoped_in_tx` → owner窄读取 → `ScopedSearchStage` → `assert_search_fresh_in_tx` → `assert_source_in_tx` → `knowledge_sources::assert_in_tx`。完整mapping分支仍使用既有依赖索引，新增分支只纠正legacy投影丢失校验依据的问题。

依据是 `docs/execution/semantic-runtime/hybrid-retrieval.md` 的内容投影与校验依据分开传递、锁外完成后重新核验来源修订要求，以及 `docs/architecture/implementation-design.md` 第17.3.2、17.5节。最终状态变化重核属于新的业务状态检查，不能作为重复Schema校验删去。

## 已核对的红绿证据

运行入口为隔离harness提供数据库与清理后的测试环境下执行：

```sh
cargo test --offline --locked -p data-agent --test knowledge_dependencies \
  narrow_search_projection_rechecks_unshown_required_sources -- --exact --test-threads=1
```

- RED：`.local/checks/narrow-source-freshness-red.log`。检索仅返回命中条目，另一未展示条目携带必要来源；来源通过正式保存改版后，旧实现的最终核验错误返回 `()`，反例失败。
- GREEN：`.local/checks/narrow-source-freshness-green.log`。同一反例通过，最终校验返回 `stale_knowledge`；改版前的检索和提交校验正控仍通过。

审查者读取了完整红绿日志并核对测试与实际代码，没有另行重复运行数据库检查。测试没有手工给回执补 `required_sources`，没有放宽失败断言，也没有把完整mapping降级成全文回读。

## 内容指纹

| 文件 | SHA256 |
| --- | --- |
| `crates/data-agent/src/use_cases/knowledge_sources.rs` | `6c9f33c4410fa7e2f76858709d2377dacba923b3147d1d4dbf8361d6ba87a320` |
| `crates/data-agent/tests/knowledge_dependencies.rs` | `85ab2f330a4373098bb71b058c9ba34b62858dab5358ed98628143cf8f9c1e36` |
| `.local/checks/narrow-source-freshness-red.log` | `b0319e9344ce08b543ad5f3f21beb7f411a6f1057545083a5517419fde21cb13` |
| `.local/checks/narrow-source-freshness-green.log` | `0536216ddb7cbdd24255a032df75f01b6c416f13af31eff97afccd0058582721` |

## 判断与限制

修改复用owner已产生的完整来源清单，没有新增权限框架、重复全文校验、吞错分支或无依据的并发保护。普通正文和完整mapping的处理没有被替换。失败路径仍保留原错误语义。

新增测试覆盖正式Rust组合与最终校验seam、真实隔离MySQL和合成材料；它不是HTTP登记到持久回执的全链验收，也不证明真实模型、真实平台、整个检索包或生产环境通过。`check-knowledge-reuse.mjs` 的旧案例读取合同冲突另有归因记录，不能用本报告掩盖该失败。05关闭仍须最终代码指纹的独立审查与绑定验收；本报告不能替代 `verify-increment` 收据。
