# Dogfood 四项问题与 Pi Skill 审计

日期：2026-10-07。源码基线：`cdf4b0cd783afc0b3a5461d8944ba09ce0c95986`，分支 `codex/semantic-role-boundaries`。本轮只审计、做局部探针并准备执行包，没有修改产品代码。

原始问题见 [实际试用记录](../research/semantic-governance-dogfood-20261007.md)，后续实现见 [修复执行包](../dogfood-repair-execution.md)。当前授权、状态及下一步以 [CURRENT](../CURRENT.md) 为准。

## 结论

| 问题 | 本机审计与 Oracle 共同结论 | 本轮后的状态 |
| --- | --- | --- |
| DF-01 完整服务启动失败 | P1 试用阻塞成立，启动诊断不足也成立；具体阻塞根因尚未确认 | 待定位，不能靠延长超时或改用模拟模式关闭 |
| DF-02 同名表难区分 | P2 展示缺陷成立；种子与平台对象有不同的稳定身份，不能仅凭同名合并 | 待修复来源与对象身份展示 |
| DF-03 同步只显示 `version_conflict` | P2 提示缺陷成立；该次后端拒绝是正确行为，前端丢失了结构化错误信息 | 待修复提示与诊断编号关联 |
| DF-04 选用 Skill 后工作台没有反馈 | P2 展示缺陷成立；选择已经保存，缺少会话级读取与持续展示 | 待补选择版本和当前可用状态 |

**Skill 的准确说法：Agent 循环、会话、压缩等复用 Pi SDK；个人 Skill 的存储、授权、版本和正文供给由应用适配。当前没有接入 Pi 原生 Skill 装载器。** 这是系统设计第 12.3 节明确记录的 MVP 取舍，不是本轮才发现的另一套 Agent 循环。

## DF-01：启动阻塞与根因分开处理

上一轮默认启动两次在 Mem0 25 秒健康等待后失败；诊断脚本延长至 120 秒仍未就绪，显式 builtin/lexical 隔离尝试中的 Pi Bridge 也未就绪。该轮模型账本的调用、费用和未知预留均为 0。

本轮重新做了两个独立进程探针：

| 探针 | 实际结果 | 能证明什么 |
| --- | --- | --- |
| 导入 Mem0、OpenAI、pandas、pymilvus | 8.764 秒，退出 0 | 本次这些模块可以导入 |
| 导入 `apps/agent/session/deliver.ts` | 16.604 秒，退出 0 | 本次 Pi 交付模块及其依赖可以导入 |

探针没有执行完整服务构造、连接检查、启动流程或模型请求。不能据此推翻原始失败，也不能据此宣布恢复。原栈从 Python 导入推进到 `Memory.from_config`、OpenAI embedder 和 pandas/native 模块加载，证据不足以认定某个依赖永久卡死。

可直接确认的诊断缺陷：

- [启动器](../../scripts/development.py) 的 `wait_health` 固定等待 25 秒，超时信息没有指出具体服务、阶段和耗时；部分退出提示固定指向默认目录，使用独立 `--runtime-dir` 时会误导。
- [Mem0 服务](../../apps/memory/server.py) 在 `MemoryService` 构造完成后才监听，外部健康探测无法区分依赖加载、SDK 构造或连接初始化。
- [Pi 入口](../../apps/agent/server.ts) 静态导入完整交付模块后才监听，只有最终就绪日志，缺少导入前后的证据。

最小处理是记录服务启动及关键初始化阶段，保留原成功条件，再按实际卡点修复。不预先更换模型、记忆算法或依赖，不用提前返回健康成功掩盖未就绪。单独诊断改进通过，不等于 DF-01 已关闭。

## DF-02：同名不等于同一对象

[平台目录映射](../../crates/data-agent/src/modules/ingestion/catalog.rs) 用空间、命名空间、表及字段生成对象 ID；内置种子沿用独立 ID，例如 `table-demo_order_detail`。`synthetic_alias` 只对明确的五张合成表提供兼容映射，不能推广为按名称合并知识或权限。

[默认目录](../../apps/web/src/features/knowledge/KnowledgePage.tsx) 与 [管理目录](../../apps/web/src/features/knowledge/KnowledgeDirectory.tsx) 主要显示名称、类型、版本和启停状态。同名对象缺少可见身份，因此用户容易进入另一份对象。

修复应覆盖默认目录、管理目录和当前对象详情：先复用已有 `source_id` 与对象 ID 展示可辨识信息；来源类别只能从已确认的来源映射得出，未知来源如实显示。短标识用于扫描，完整标识用于准确核对。名称、ID、版本、引用和权限均保持原业务含义，不做名称去重、主键迁移或知识融合。

## DF-03：错误信息在前端丢失，编号也没有关联日志

[AppError 契约](../../packages/contracts/schema.json) 已有 `code`、`message`、`request_id`、`retryable`。[Web API 客户端](../../apps/web/src/shared/api.ts) 解码后却只用 `code` 构造普通 `Error`。

同时，[HTTP 错误入口](../../apps/api/src/routes.rs) 当前用错误码填充 `message`，返回时生成 `request_id`，拒绝日志却只记 `code`。因此，仅把现有编号展示出来还不能声称它可用于关联拒绝日志。

最小修复：保留现有错误四字段和机器码；在“同步来源”操作处给中文说明和下一步；同一个返回编号写入脱敏拒绝日志。无须新增错误信封或 `diagnostic_id`。

提示必须描述已经知道的事实，例如“来源同步发生版本冲突。请刷新查看当前状态，核对来源版本后重试”。不能将所有版本冲突都解释为 mock 未递增版本，也不能宣称所有资料均未应用：来源和知识沿用逐表导入，负责人快照才在整批成功后统一提交。已有按 `Error.message` 分支的页面必须保留兼容，或一并改为显式读取 `code`；不顺带重做全站错误系统。

## DF-04：把“选择记录”和“实际使用”分开

[应用入口](../../apps/web/src/main.tsx) 的 `useSkill` 已执行选择 POST，然后切到工作台。[资产页](../../apps/web/src/features/assets/AssetsPage.tsx) 的成功提示在页面切换后不可见。[工作台](../../apps/web/src/features/workbench/Workbench.tsx) 没有读取选择列表，当前 Snapshot 契约也不包含该列表。

[资产存储](../../crates/data-agent/src/modules/assets/store.rs) 保存了 `asset_id + asset_version`；`selected_in_tx` 只返回本人、当前空间、启用且版本仍匹配的对象。直接将这个有效列表作为展示列表，会把已改版、停用或删除的选择隐藏掉。

应增加会话级只读选择摘要。界面区分：

1. **已选择**：用户保存了哪个 Skill 的哪个版本。
2. **当前可用**：该版本现在仍启用，且引用依据仍可用；下一次运行仍须重新校验。
3. **本轮实际加载或采用**：需要具体运行证据。本次修复不新增此状态，也不把“已选择”显示成“已执行成功”。

接口继续校验会话归属和用户/空间；已删除或不可见对象只给中性不可用摘要，不返回其旧正文。改版和重新启用均不得自动升级选择。服务检查失败要报失败，不能伪装成空列表或正常可用。

## Pi Skill 复用核对

锁定版本为 `@earendil-works/pi-coding-agent@1.0.0`。

| 层次 | 当前实现 | 裁决 |
| --- | --- | --- |
| Agent 运行 | `createAgentSession`、SDK 会话管理、工具循环、事件、取消与压缩 | 已复用 Pi |
| 私人 Skill 真源 | MySQL 中的归属、版本、选择和状态 | 应用业务责任，Pi 不替代多用户授权 |
| Skill 内容供给 | Rust 校验已选版本及依赖后交付有界正文；知识工具继续分页读取 | 已实现的 MVP 适配 |
| Pi 原生资源 | `resources.ts` 的 `getSkills()` 返回空数组 | 未接入原生 Skill 装载器 |
| 原生自动发现与显式命令 | 未开放默认 `read`/`bash`，未提供原生 Skill 文件 | 不能声称已支持 Pi 原生 Skill 调用链 |

设计依据：[系统设计第 12.3 节](../semantic-retrieval-design.md#123-rust-如何接-pi) 明确说明原生 `/skill:name` 直接读取文件，MVP 由应用验证选中 Skill 后加载正文。当前不需要为修复 DF-04 改变这项决定。

本轮检查 SDK 源码与无模型小样，确认：

- 包的公开入口确实导出 `loadSkills`、`loadSkillsFromDir`、`formatSkillsForPrompt`，不必深导入 SDK 私有文件。
- 原生目录要求 Skill 非空，且工具集合含名为 `read` 或 `bash` 的工具。已注册 Skill 但只有现有数据工具时，目录不会出现；加上名为 `read` 的工具后会出现。`disableModelInvocation` 会排除自动目录项。
- 原生 `/skill:name` 使用真实 `filePath` 和同步文件读取；不能以虚拟路径冒充 MySQL 正文读取，也不能复制私有 `_expandSkillCommand`。
- 小样只验证 SDK 提示格式行为，没有验证真实模型按需调用、文件安全或完整原生 Skill 集成。
- 当前初始上下文最多装入 20 个 Skill 首段，另有 `asset_counts` 和工具分页；20 不是产品允许选择的总数上限。该数字不能直接固化成新业务限制。
- [上下文授权](../../crates/data-agent/src/use_cases/context_authority.rs) 会核对已交付 Skill 的版本、选择、状态和依赖；[交付用例](../../crates/data-agent/src/use_cases/deliver_run.rs) 对新输入重建失效上下文，对同输入恢复返回 `stale_context`，避免更换原操作身份。此处是源码核对，本轮未重跑完整撤权恢复验收。

后续若要原生化，候选方向是“受授权的已选 Skill → Pi 资源目录 → 受限正文读取”。仍保留 Rust/MySQL 真源，禁用默认目录扫描和通用文件工具。文件快照生命周期、实时撤权、分页及恢复须先做最小验证；这属于单独的接入变更，不作为四项问题的自动附加修复。

## Oracle 咨询与本机裁决

用户明确要求 Oracle 审计。本次用 `oracle-web` 0.17.3 wrapper，在独立临时 Chrome 会话提交原 dogfood 报告与脱敏源码证据；只请求单次有界分析。会话 `dogfood-skills-audit-20261007-180411`，已捕获完整回答并退出 0。

- 实际思考档位证据：`Power, item 4 of 5 (slider ARIA)`，提交前验证成功；不以 CLI 请求模型名冒充网页实际模型。
- 已核对提交后会话记录及答案；确切 Chrome PID 已退出，临时 Profile 已删除。
- 原始 prompt、证据、回答、探针和完成核验仅保存在 Git 忽略目录 `.local/oracle-dogfood-audit/`，没有公开浏览器资料或私人会话地址。

| Oracle 建议 | 最终处理 |
| --- | --- |
| DF-01 先补启动阶段证据；DF-02 不按名称合并；DF-03 复用 AppError；DF-04 增加选择摘要 | 采纳，并落实到执行包 |
| DF-03 显示现有 `request_id` | 补上同号拒绝日志，才能声称可关联；保留既有错误码分支 |
| 冲突时提示“本次同步未应用” | 收紧措辞，不承诺逐表资料全部回滚 |
| 修复后直接实施 Pi 原生 Skill 薄适配 | 不纳入这四项；第 12.3 节已有明确 MVP 取舍，用户本轮请求审计与执行包，未要求迁移 |
| 把 20 项作为现有 Skill 上限 | 纠正为初始上下文装载边界，保留现有总量提示与分页能力 |
| SDK public exports、Skill 恢复失效需补查 | 已补查公开导出与源码控制流；未把源码核对宣称为运行验收 |

Oracle 输入未包含后来补读的第 12.3 节完整正文。上面的接入范围裁决以原设计和实际代码为准，外部建议不自动改变授权或产品决定。

## 验证范围

本轮做了只读源码审计、两个独立导入探针和三组 SDK 目录格式小样；没有业务模型调用、完整真实栈启动或修复后 dogfood。四项问题均保持未关闭。执行包交付只证明修复边界、接口建议、验收和交接条件已整理，不能代替实现或真实模型成功率结论。
