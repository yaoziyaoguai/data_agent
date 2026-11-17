# 公共索引恢复修复独立审查（2026-10-28）

**结论：本轮三处有界恢复修复未发现阻断项。此结论不代表 05 完成，不是整包 passed 收据，也不能代替 `verify-increment`。** 当前增量状态仍以 [CURRENT](../CURRENT.md) 为准。

审查者：`audit_search_progress_and_deadline`。审查者没有实现下列恢复修复，只进行了源码比较、合同核对及日志复核；未修改产品代码、未重跑数据库检查、未调用付费模型。审查者实现的另一处来源投影修复不在本文审查范围内。

## 范围与依据

比较基线为 `.local/hybrid-resume-audit-20261028/before/`，不是 HEAD 的全部累计差异。仅审查：

- `crates/data-agent/src/modules/knowledge/store.rs` 的 `claim_source_index_in_tx` 耗尽收敛与领取资格顺序。
- `crates/data-agent/src/use_cases/knowledge_embeddings.rs` 的恢复资格读取、冻结配置授权与 trial 登记部分；查询检索调度及后续期限循环不在范围内。
- `crates/data-agent/tests/index_recovery.rs` 新增的三条恢复反例，以及原有两条恢复测试的完整运行结果。

要求来自 [混合检索执行包](../execution/semantic-runtime/hybrid-retrieval.md)：耗尽收敛不依赖发送资格；冻结后沿原配置及预算身份恢复；原成功/未知回执优先；普通存储与分段错误不得伪装成零工作。检查同时遵守 AGENTS 的单次边界校验、直接控制流与不新增恢复框架要求。

## 逐项结论

| 修复 | 核对结果 | 反例与回归 |
| --- | --- | --- |
| 耗尽收敛先于发送资格过滤 | `vector_attempts >= 3` 的原文目标在发送资格为空时仍收敛；仍限定原空间、原文目标、原有状态和已过期租约。没有增加次数或派发调用，后续领取仍用原资格清单。 | RED 保持 `sending, 3`；GREEN 变为 `failed, 3, vector_receipt_unknown`，派发数不变。 |
| 冻结后补齐原 trial 登记 | 恢复使用持久冻结 profile，经既有 `configure_embedding_trial` 幂等登记。底层 `ON DUPLICATE KEY UPDATE id=id` 不重置调用数、金额或期限；配置指纹仍须一致。RawIndex 在此之前查询原回执的顺序保留，未知回执不换身份重发。 | RED 停在 `unknown`；GREEN 正常索引、实际冻结指纹与派发数正确，再次消费不重复发送。原有配置缺失、同 trial 改值、新 trial 和混合队列测试保留并通过。 |
| 恢复读取错误直接传播 | 仅已定义的 `not_available/stale_knowledge/stale_source` 被视为不具备恢复资格；存储、分段和准备错误直接返回。未增加重试层、catch-all 或假成功分支。 | 隔离库移开版本表产生真实 `42S02`。RED 返回 `Ok(false)`；GREEN 返回 `unavailable`，目标仍为原 pending/次数，零新增派发。 |

上述触发来自已约定的普通中断恢复与实际存储失败，没有发生率测量，本文不编造概率。修复复用原领取、账本及消费者，没有增加表、调度器、配置资格缓存或通用恢复服务。

## 重复解码建议与最终复读

首次复核发现：授权函数已经为构造预算解码选中的 profile，却把原 `Value` 返回给调用方再次执行同一 Schema 解码；已冻结目标也会逐批走这条路径。

主实施者随后将 `authorize_in_tx` 的第三返回值改为 `Option<EmbeddingProfile>`，`embedding_budget` 直接接收已解码类型，trial 登记复用同一个值。审查者已复读该修改，确认重复解码已移除，没有新增 helper 或校验层。冻结提交后的下一事务仍调用原授权操作，保留租约、来源和状态重核；这是跨事务状态变化检查，不应作为重复输入校验删除。

该类型传递简化后的复核为静态检查。以下数据库红绿及 5 项回归日志生成于简化之前；本文不把它们冒称为简化后最终工作树的再次运行结果。最终相称检查由主实施者记录到 CURRENT。

## 运行证据

运行方式沿现有隔离 harness，使用真实 MySQL、专用真实 Milvus 集合及本地 Embedding 协议替身；不是付费模型质量或真实数据平台验收。新增测试调用正式 `process_index` 消费者，异常状态只用于构造约定中断点；断言保留原次数、配置及发送结果。未删除原测试或放宽断言。

完整日志位于本机忽略目录 `.local/hybrid-resume-audit-20261028/`。审查者核对日志的实际终态，而非仅复述实施者总结：

| 日志 | 结果 | SHA256 |
| --- | --- | --- |
| `index-recovery-exhausted-red.log` | 目标仍为 sending，反例失败 | `77333f7ee0d436394cb3d33ef8f5ac5fd2c84bade7f7251bdb9f25c2d5d49a40` |
| `index-recovery-exhausted-green.log` | 1 passed | `67c8fb298dffb821fda2fddbecaf1ed62baa52cb62f5c58d3daa2032245ef455` |
| `index-recovery-registration-red.log` | 恢复停在 unknown，反例失败 | `106b201b606913726fe92b6604ca5c8af6e82e98d572dd1827ca87c943b40f5d` |
| `index-recovery-registration-green.log` | 1 passed | `acbe2e9d423f0d40ab6a1babcf42eefbdb4f747cd40c6b8d17c29adb17bfbd2c` |
| `index-recovery-storage-red.log` | 存储错误被转换为 Ok(false)，反例失败 | `dfdc1b1ed6f352aca3adafa9028cbf9342aa9e483f37f3dab08a35dc8973fdeb` |
| `index-recovery-storage-green.log` | 1 passed | `b4ee79113d8bf1f64f142aec885828012307f5ed5a26b382b64a7d57920dba44` |
| `index-recovery-all.log` | 新增三条及原有两条，共 5 passed | `84ea51adcdb08b5d109e0cbf6050333c1f9f00430cc3d33be7b07505999eed2f` |

对应测试名称：

- `exhausted_source_index_converges_without_current_configuration`
- `frozen_source_index_resumes_before_trial_registration`
- `source_recovery_propagates_storage_failure_without_consuming_attempts`

全文件回归还覆盖 `frozen_targets_continue_on_frozen_profile_across_config_conditions` 和 `mixed_queue_skips_unconfigured_targets_and_recovers_frozen_and_ledger_backlogs`。原文/知识统一交付、检索内容粒度、共同分页与完整期限验收均不由这五条恢复测试证明。
