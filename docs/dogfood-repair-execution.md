# Dogfood 修复与 Pi 原生 Skill 执行包

日期：2026-10-07。当前状态与授权只在 [CURRENT](CURRENT.md) 维护。本包覆盖四项试用修复、Pi 原生 Skill、个人和当前空间公共 Skill。用户已同意下述推荐权限，并授权补齐资料后实施和自测。原生接入证据归属 I2-NATIVE-SKILLS；后续最终审计、试用及提交推送以 CURRENT 的最新授权与 I2-SKILL-CLOSEOUT 记录为准。

## 全部待办与依赖

| 工作 | 当前认知 | 完成所需证据 |
| --- | --- | --- |
| DF-01 完整服务启动 | 真实试用阻塞，根因尚未定位 | 分段启动证据、针对性修复、原真实模式成功启动 |
| DF-02 同名表区分 | 来源与对象身份展示不足 | 默认/管理/搜索目录能区分，原 ID、权限和引用保持 |
| DF-03 同步错误提示 | 后端拒绝正确，错误字段丢失且诊断编号未关联日志 | 中文说明、恢复步骤、机器码和同号脱敏日志 |
| DF-04 Skill 工作台反馈 | 已选版本已保存，缺少读取展示 | 刷新、会话切换、改版、停用和失效状态准确；公共接入后同时区分来源 |
| Pi 原生 Skill 接入 | 用户已选择该方向，替代此前“后续候选” | 官方资源目录与正文加载真实工作，多 Skill、长文、授权及恢复通过 |
| 个人/公共 Skill | 权限已确认，详见第 10 节 | 权限矩阵、明确发布、版本/启停、可见范围、服务端反例与页面通过 |
| 文档与整体验收 | 随上面六项同步 | 设计、接口、存储迁移、必要架构说明一致；实际浏览器与真实模型试用分别留证 |

建议顺序：先固定接口和原生接入的小样设计；并行关系只表示工作依赖，不要求派子代理。DF-01–03 可独立推进；DF-04 的公共字段与展示在公共契约定下后一起完成。最后做相关回归与完整试用。

## 1. 基线与交付目标

- 源码基线：`cdf4b0cd783afc0b3a5461d8944ba09ce0c95986`，分支 `codex/semantic-role-boundaries`。开工时重核分支、工作区与最新 CURRENT，保留其他人的改动。
- 输入：[原 dogfood 四项问题](research/semantic-governance-dogfood-20261007.md)、[本机与 Oracle 综合审计](reviews/dogfood-and-pi-skills-audit-20261007.md)、[系统设计](semantic-retrieval-design.md)、[模块契约](architecture/implementation-design.md)。
- 目标：完成原四项修复，接入 Pi 原生 Skill，并交付个人/当前空间公共 Skill 的完整流程。
- 已获实施授权，按 CURRENT 推进；公共权限不需重复确认。
- `I2-ROLE-BOUNDARIES` 保留已完成事实和原收据。本轮登记新增量 `I2-NATIVE-SKILLS`，不能给旧增量换验收来覆盖新工作。

### 不变量

表负责人仍来自平台，独立指标/文档仍由首位人工创建者负责，引用不传递维护权；Data Agent 语义权限与 Datasight 查询权限分开。SQL 仍确认具体版本后才能执行。个人记忆和个人 Skill 按本人/空间隔离，Skill 不授予额外权限；公共 Skill 的可见范围不代表其引用数据的查询权。Pi 仍为唯一 Agent 循环，Mem0、Flash、百炼向量及 Milvus 的既定接入保持。预算、原操作身份、并发和恢复约束保持。

### 本包不包含

自动选用、Skill 市场、任意脚本执行、Git/npm 技能安装、取消选用新功能、无关角色重设计、记忆算法比较、SQL 准确率优化、微服务拆分、知识主键迁移、全站错误框架或监控平台。公共 Skill 不扩展为公共个人记忆，也不自动公开私人聊天、查询结果或私人材料。若根因落在已允许范围之外，先写清证据和影响，再按当前授权判断，不擅自扩大。

## 2. 顺序、责任和允许范围

下表是原四项修复的实施边界。新增两项 Skill 能力的设计边界见第 9–10 节；权限和具体契约以下述方案为准。

| 顺序 | 任务 | 业务归属与可改文件 | 接口/数据变化 |
| --- | --- | --- | --- |
| 1 | DF-01 启动诊断及有证据的修复 | `scripts/development.py`、`scripts/test_development.py`；必要时 `apps/memory/server.py`、`apps/memory/service.py`、`apps/agent/server.ts` 及直接初始化入口 | 初始仅日志和诊断，不改业务协议或健康成功含义 |
| 2 | DF-03 同步错误提示 | `apps/web/src/shared/api.ts`、`features/knowledge/KnowledgePage.tsx`、现有错误码分支调用点；`apps/api/src/routes.rs` 的拒绝日志 | 复用 AppError，无新错误 Schema |
| 3 | DF-02 来源身份展示 | M02/M03 既有对象身份；`features/knowledge/KnowledgePage.tsx`、`KnowledgeDirectory.tsx`，必要的本 feature 展示组件及样式 | 优先使用已有 source_id/id，不改稳定身份、引用或来源导入 |
| 4 | DF-04 选择摘要与工作台反馈 | M05 会话读取授权、M09 资产；`modules/assets/{mod,store}.rs`、`use_cases/personal_assets.rs`；API `data_routes.rs`、`main.rs`；Web `main.tsx`、`features/workbench`、必要的 `features/assets` 提示 | 新增一个 GET 读接口，现有 POST 和持久化结构保持 |
| 5 | 相关回归与真实试用 | `tests/mvp` 下相关用例、`tests/contracts/cases.json`、`packages/contracts` 同源契约与生成物、必要文档 | 验收及接口文档随行为同步 |

表内 Web 路径前缀为 `apps/web/src/`，Rust 模块/用例前缀为 `crates/data-agent/src/`。`docs/CURRENT.md`、本执行包、审查和试用证据可随交付更新；系统设计与模块接口文档只改受影响部分。没有容器或进程边界变化，无须重画整套架构图。

先取得 DF-01 的分段证据。若是尚未解决的本机环境问题，记录具体卡点后可继续独立的三个界面修复；DF-01 保持未关闭，不用它阻止无依赖工作，也不把三个界面通过称为整包完成。

## 3. DF-01：先定位，再改对应原因

### 3.1 最小实现

1. 启动器为实际拉起的每个服务记录服务名、spawn、开始等待、ready、exit/timeout、单调时钟耗时和实际 runtime 日志位置。错误只打印脱敏摘要，不输出环境变量、凭据、完整连接串或请求正文。
2. 保留有限等待与失败返回。进程已退出和健康等待超时分别表达；超时指出哪一个服务未 ready，并给本次日志路径。使用非默认 `--runtime-dir` 也必须准确。
3. Mem0 记录第三方导入、`Memory.from_config`、监听完成这些边界。Pi 区分交付模块加载和 HTTP 监听。ESM 静态 import 会先于入口正文执行，不能在静态导入之后放一条日志就称为“导入前”；如需动态 import，只调整现有启动入口，不改 Agent 循环。
4. 用原 DeepSeek Flash + Mem0 + hybrid 配置做隔离启动，沿用既有本地受保护配置和原预算账本；先验证就绪，后开始业务请求。不得用诊断重建预算。若启动已有待办产生调用，单独记录来源，不能假定启动必然零调用。
5. 只有分段证据支持时才修改对应原因：稳定的冷启动耗时、依赖导入、SDK 构造、连接初始化或进程退出分别处理。调大等待可以是有依据的结果，不能是唯一证据。无法定位时保留原失败、最新阶段和复现条件。

### 3.2 验收

| 编号 | 要求 | 可观察结果 |
| --- | --- | --- |
| START01 | D07、C07 | 非默认 runtime 目录下，延迟就绪、提前退出、始终不就绪三种情况分别给出正确服务、耗时和日志位置；未 ready 不报成功 |
| START02 | D07、D11、C01 | 有完整真实模式成功启动与停止自己进程的证据；至少再做一次同配置正常停止后的启动，区分第一次与重复启动，不声称等同 OS 冷缓存 |
| START03 | C05、C07 | 无凭据泄漏、无遗留本次进程，不重启常驻实例；账本变化逐次核对，失败不改为 mock 成功 |

复用 `scripts/test_development.py`、`tests/mvp/check-model-startup.mjs`；后者的回环模型仅证明协议接线。`make verify-startup` 通过也不能代替 START02 的真实模式证据。

## 4. DF-03：保留结构化错误，给出准确下一步

### 4.1 最小实现

- `api.ts` 用轻量 `ApiError` 保留现有 `code/message/request_id/retryable`，不改 HTTP Schema。`message` 不负责机器分支；若保留旧 `Error.message=code` 兼容，服务端 message 单独保留。若改其含义，必须同步全部直接相关的机器码判断。
- 只在来源同步处增加操作级说明。建议：“来源同步发生版本冲突。请刷新查看当前状态，核对来源版本后重试。”另展示错误码及可复制的诊断编号。
- 同步错误不能被描述为“所有修改均已回滚”；不能把权限错误、临时服务错误和版本冲突混为一类；不能盲目自动重试版本冲突。
- Rust `failure()` 只生成一次返回编号，该编号同时写入 `request_rejected` 脱敏日志。无须建立新的跨进程 tracing 服务。
- 核对 `SemanticMaintainer`、`semantic-commands`、工作台撤回提示和索引重建中的现有错误码分支，保留原来有用的中文提示。

### 4.2 验收

| 编号 | 要求 | 可观察结果 |
| --- | --- | --- |
| ERROR01 | D01、D13、C07 | 修改 mock 维护人但不递增来源版本，仍拒绝且不改变负责人快照；页面显示同步冲突说明、下一步、原码及可关联拒绝日志的同号 request_id |
| ERROR02 | D13、C07 | 文档保存版本冲突不会被解释为平台来源版本问题；现有无权、失效成员、索引未配置及工作台已应用输入等分支保持原义 |

该复现包含一个刻意错误的合成来源版本，测试后递增版本验证正常同步，不通过放宽后端版本校验消除提示。

## 5. DF-02：让来源身份可见

### 5.1 最小实现

- 默认表目录、管理目录及搜索结果显示来源信息和稳定对象短标识，详情能查看完整对象 ID、source_id 和知识版本。
- 第一版使用已有 `source_id`/`id` 即可。只有已从真实来源映射确认的对象才标“内置样例”或“平台同步”；未知来源显示原来源标识或“来源未标注”，不得按表名、最后修改人推断。短标识若碰撞，增加可见长度；点击始终使用完整 ID。
- 不新增按行拉取来源正文的 N+1 请求。如果现有字段无法准确表达来源类别，先用准确标识交付，不为标签新建来源数据库。
- 沿用知识版本/负责人版本分别合并的现有规则，显示信息不参与授权。

### 5.2 验收

| 编号 | 要求 | 可观察结果 |
| --- | --- | --- |
| ORIGIN01 | D01、D13、C08 | 内置与导入的同名表同时可见，用户可从列表区分，分别点击进入正确 ID；刷新、分页、重复同步后仍能区分 |
| ORIGIN02 | D01、C02、A07 | 同名不同命名空间不会被合并；原知识 ID、引用和负责人保持，人工语义未因展示修复改变；390px 和键盘操作可用 |

## 6. DF-04：会话选择读接口与工作台状态

个人与公共 Skill 共用选择摘要；同时返回 visibility 和 owner_id，缺失或不可见项均为 null。原 POST 的用户、会话及版本绑定保持。

### 6.1 接口

新增 `GET /conversations/{id}/skill-selections`。选择 POST 的字段、版本校验、幂等和返回值保持。

响应 Schema 命名 `ConversationSkillSelections`；条目命名 `ConversationSkillSelection`，避免与现有 POST 的 `SkillSelection` 输入混淆。示意：

```json
{
  "conversation_id": "conversation-example",
  "selections": [
    {
      "asset_id": "skill-example",
      "name": "月度渠道分析",
      "selected_version": "1",
      "current_version": "2",
      "availability": "version_changed"
    }
  ],
  "next_after_id": null
}
```

正式定义写入 `packages/contracts/schema.json` 与 `openapi.json`，同源生成 Rust/TypeScript 类型并做运行时校验。

- 采用项目已有 `after_id` 分页习惯，按稳定 `asset_id` 排序，每页有界，不把运行初始 20 项作为读取上限。
- `selected_version` 始终来自选择记录。`current_version` 为当前可见资产版本；`name` 为当前可见名称。界面明确显示“已选 v1 / 当前 v2”，不冒称 v1 的历史名称就是当前名称。
- `availability` 固定为 `available | version_changed | disabled | dependency_unavailable | unavailable`。同一状态的业务判定由服务端完成，前端只展示。
- 判定顺序：不存在/删除/不可见 → `unavailable`；停用 → `disabled`；版本不匹配 → `version_changed`；依赖失效/不可读 → `dependency_unavailable`；全部通过 → `available`。已删除项的名称和当前版本为 null，不返回旧正文；不为 tombstone 新造存储模型。
- “依赖不可用”只能表示已确认的业务失效。数据库/平台暂时失败应保留失败码，不能被 `.is_ok()` 或空列表吞掉；可复用 `knowledge::check_refs_in_tx` 的业务校验并区分错误类别，不复制其规则。

### 6.2 模块与权限

`personal_assets` 用例先通过 M05 现有只读接口核对当前用户和空间的会话归属，再调用 M09 私有存储读取选择摘要，按需要组合既有知识引用校验。跨模块 SQL 不进入 route 或 use case。列表读取不触发模型、不改选择版本、不重建记忆索引。

M09 的新摘要查询可读取持久选择与当前资产状态，但不能直接替换运行使用的 `selected_in_tx`。当前运行只接收启用且 exact-version 的选择，继续沿用其依赖校验。展示摘要即使刚返回 `available`，正式交付仍重新授权。

### 6.3 工作台交互

- 选用成功后返回工作台，在输入框附近显示“本会话已选 Skill”，列出名称、所选版本及当前状态；刷新后从服务端恢复。
- 首次读取时显示加载状态；失败时显示读取失败和重试，不能显示“未选 Skill”。空列表才显示未选。
- 会话、身份切换和组件卸载使旧请求结果失效；晚到的 A 会话响应不能覆盖 B 会话。沿用现有请求代次/清理模式。
- 进入会话、从个人积累返回、页面重新获得焦点时更新；同页资产状态变化沿用现有工作台刷新节奏，不另建事件总线或轮询框架。分页可加载更多。
- 改版提示“已选版本过期，请到我的积累重新选用”；停用、删除、依赖不可用分别表达。重新启用产生新版本，仍要求明确重选；不自动恢复旧版本选择。
- 本次不显示“Agent 已使用成功”。选择状态和实际运行证据分开，不增加执行徽标或采用率统计。

### 6.4 验收

| 编号 | 要求 | 可观察结果 |
| --- | --- | --- |
| SKILL01 | D12、D13、C08 | v1 选用后工作台可见；刷新和返回可恢复，未发送消息也可见；长列表分页不静默截断 |
| SKILL02 | D12、C02 | 资产变 v2、停用、重新启用、删除、依赖改版/撤权分别显示准确状态；旧选择不自动升级，失效项不进入模型上下文 |
| SKILL03 | D03、D12、C02 | 切换会话、延迟乱序返回不串状态；跨用户/跨空间/已删除会话读取被拒绝，不泄露资产名称和正文 |
| SKILL04 | D12、C07 | 服务异常不会显示空列表或可用；重传原选择操作保持幂等；多 Skill 可显示且普通未选会话仍能提问 |

## 7. 验证命令与证据

### 已存在的命令

按本次实际改动选择并绑定，不把所有历史全量验收机械重跑：

```bash
python3 -m unittest discover -s scripts -p 'test_development.py'
make verify-startup
make verify-contracts
npm run check:types
make verify-code
python3 scripts/check_architecture.py
node tests/mvp/check-knowledge-workflow.mjs
node tests/mvp/check-asset-directory.mjs
node tests/mvp/check-context-dependencies.mjs
node tests/mvp/check-semantic-role-boundaries.mjs --case sync
node tests/mvp/check-semantic-role-boundaries-browser.mjs
make verify-materials verify-delivery
git diff --check
```

`make verify-code` 覆盖静态工程检查；已有角色浏览器用例覆盖负责人旧数据不能回退。现有 Skill 用例不足以证明新增 GET 和工作台状态，必须补以下针对性证据。

### 待补的用例

界面与选择用例放在两个按业务命名的文件，复用 `harness.mjs` 和现有浏览器工具；这两个文件属于本增量：

- `tests/mvp/check-conversation-skill-selections.mjs`：SKILL01–04 的接口、分页、用户/空间、状态、失败与运行输入边界；直接 Node 运行。
- `tests/mvp/check-workspace-feedback-browser.mjs`：ERROR01–02、ORIGIN01–02 和工作台 Skill 可见状态、切换/刷新/乱序/窄屏；直接 Node 运行。可复用既有浏览器用例中的相关流程，不复制整套业务夹具。

START01 在现有启动器单测补反例。START02–03 与最终真实试用使用独立运行目录，记录实际命令、配置模式、源码 SHA、服务阶段、账本变化和退出结果；不在本包写假定存在的 profile 文件路径或复制凭据。

### 真实试用的最小闭环

完整栈 ready 后，使用全合成材料验证：登录 → 选择一个 Skill → 询问表或指标含义 → 生成 SQL → 补充或纠正条件 → 展示新 SQL → 确认具体版本 → mock 平台执行并解释；另做一次明确保存个人偏好并在新会话召回。核对真实 Flash/Pi、Mem0 提取与召回、Qwen/Milvus 检索的实际调用证据。

管理页面的 capture/no-worker 结果、回环模型和真实 Flash 分别报告；平台仍是 mock，不能写成 Datasight 真实接入通过。本包不要求重新追求模型 100% 准确率，也不为某次回答失败无限重跑。若出现业务质量问题，保留问题和范围，依证据判断是否由本轮改动造成。

## 8. 开工登记与关闭条件

实施开始时，把上述验收绑定到 CURRENT 的新 `delivery.increment`：

- requirements 至少按验收覆盖 `D01/D03/D07/D11/D12/D13/C01/C02/C05/C07/C08/A07`；模块按实际涉及的 M02/M03/M05/M08/M09/M11/M12 和身份读取依赖登记，保留全局需求映射。
- allowed_paths 固定为本包第 2 节的实际路径、对应契约/测试/必要文档；具体启动根因需要其他路径时记录证据，不先铺整个仓库。
- 开工状态 `active`，`review.status=pending`、`review.record=null`、`evidence=null`；每条验收填真实可执行命令，待补测试实现后方可作为通过证据。
- 保留旧 `I2-ROLE-BOUNDARIES` 的审查和原始收据引用，不修改旧成功证据内容，也不把 Oracle 本次设计审计充当未来实现的独立审查。

实现后依项目要求，由未负责相应实现的审查者核对原要求、diff、断言和实际结果，特别看版本/授权、错误分支、Skill 仍复用 Pi 的既有运行能力。准备阶段不默认开启多代理流水线。

审查与证据绑定后运行 `make verify-increment`；全部声明验收有效才能关闭新修复增量。若 DF-01 根因或真实栈仍未验证，明确保留未完成项。`make verify-delivery` 只检查记录，不能作为修复通过证明。

## 9. Pi 原生 Skill 接入契约

锁定 `@earendil-works/pi-coding-agent@1.0.0`。复用公开的 `loadSkills`、`ResourceLoader.getSkills`、`createReadToolDefinition` 和 Pi 会话/压缩；不复制发现器、读取分页或 Agent 循环。

1. Rust 返回已选有效 Skill 的名称、说明、稳定 ID/版本和受控资源路径；初始最多 20 项是上下文页大小，完整目录可分页补查。正文不再自动注入，也不通过 `read_knowledge` 返回另一份 Skill 正文。
2. Node 为原生解析器生成短暂的名称/说明文件，禁用默认与全局发现；解析结果映射为 `/skills/{asset_id}/{version}/SKILL.md`。派生文件只含元信息，用完清理，MySQL 仍是真源。同名 Skill 用稳定 ID 作为原生命令名。
3. SDK 原生 `read` 的文件操作接缝调用 Rust 同名受控工具。`path/offset/limit` 沿用原生参数，正文由 Rust 返回，分页、截断和格式由 SDK 处理。允许 SKILL.md 和同版本 `references/`、`assets/` 下的 UTF-8 文本；拒绝绝对外部路径、遍历、隐藏文件、脚本和任意主机 IO。
4. 每次正文/附件读取重新校验空间、可见性、会话已选版本、启用状态和知识依赖，并记录采用依据。读取经过原工具账本，恢复保持 SDK tool_call_id / operation_id；恢复结果重新使用同一个原生 read 包装，不能把原始 JSON 当工具文本。
5. `session.prompt(..., {expandPromptTemplates:false})` 禁止 SDK 直接文件读取的 `/skill:` 命令展开；网页明确选择仍为入口。默认文件工具、bash、扩展、用户目录扫描均不开启。新轮失效重建上下文，同输入失效拒绝恢复，沿用原预算与操作身份。
6. 两个合成 Skill 验证同名、多选、长文续读、附件、路径拒绝、未选拒绝、改版停用及恢复。原生解析/格式单测、API 权限用例、真实 Flash 运行分别留证。

## 10. 个人与公共 Skill 的权限与数据契约

### 10.1 已确认权限

| 操作 | 个人 Skill / 记忆 | 当前空间公共 Skill |
| --- | --- | --- |
| 查看 | 仅本人；超级维护者也不能读他人私人资产 | 当前空间成员 |
| 创建/发布 | 本人创建个人资产 | 成员明确发布自己的 Skill，发布人成为负责人 |
| 修订/启停/删除 | 仅本人 | 负责人或本系统超级维护者 |
| 选择使用 | 本人明确选择启用的 Skill | 当前成员明确选择启用版本 |
| 修改建议 | 不扩展 | 当前成员提交，负责人/超级维护者处理；不自动改正文 |

公共不跨空间，不赋予 Datasight 读取/执行权；公共 Skill 引用知识仍按使用者权限核验。建议向当前空间内能看到该 Skill 的成员公开，页面明确提示不要粘贴私人聊天或结果。首版不新增负责人转交流程。

### 10.2 发布、附件与迁移

- `personal_assets` 保留已有主键及版本，新增 `visibility`，旧行默认 `personal`；只有 `skill` 可为 `space`。`owner_id` 表示负责人，超级维护者编辑不改变归属。响应增加可信的 `visibility/owner_id/can_edit/files`；业务适用范围继续用 `scope`。
- `files` 是 `{path,content}` 的受控文本列表（最多 12 份，每份最多 40000 字符，总内容最多 160000 字符）；路径限 `references/`、`assets/` 下的 `.md/.txt/.csv/.json`，无脚本。附件随主正文共同版本化。旧行没有附件时读为 `[]`。
- Pi 原生 read 的单行上限是 50 KiB（UTF-8 字节）。正文、生成后的 SKILL.md 和附件均校验此上限，超限返回 `skill_line_too_long`，提示分行后保存；不截掉内容或另建行内分页器。存量超限内容读取/选用同样明确拒绝，用户仍可在编辑页分行修订。多行长文继续使用原生 offset/limit。
- 发布要求 `operation_id/expected_version/share_confirmed=true`。页面预览正文、范围、附件和知识引用；服务端只复制预览对应的精确版本，`source_text` 留空，不拷贝聊天、记忆或查询结果。公共副本独立 ID、v1 和版本线，新增 `skill_publications` 保存私人来源到公共副本映射。
- 相同操作同参返回原回执；同参异版本或同 ID 异参按现有冲突规则拒绝。来源已经发布后，新的发布操作返回 `skill_already_published`，后续从公共入口修订；私人编辑不会暗中改公共副本。
- `skill_suggestions` 保存公共 Skill ID、提出者、起点 Skill 版本、建议内容、状态、修订号及处理说明。状态 `pending/handled/rejected`；处理只更新建议，正文须另行保存。每个写入沿用资产操作账本，账本主键增加 space_id；现有身份只属于 demo，迁移保持旧回执归于 demo。

### 10.3 HTTP 与模块

| 接口 | 契约及职责 |
| --- | --- |
| `GET /assets` | 返回本人资产和本空间公共 Skill，带可信权限投影；前端按 visibility 分类 |
| `POST /assets` | 沿用 AssetSave；新增可选 files，服务端从已有对象保持 owner/visibility；新建只允许 personal |
| `POST /assets/{id}/publish` | PublishSkill → Asset；本人 Skill 的独立公共副本，版本和明确发布校验 |
| `GET/POST /assets/{id}/suggestions` | SkillSuggestionList / SuggestSkill；公共对象可见性及版本校验 |
| `POST /assets/{id}/suggestions/{suggestion_id}/review` | ReviewSkillSuggestion → SkillSuggestion；负责人/超级维护者处理，竞争修订号 |
| `GET /conversations/{id}/skill-selections?after_id=` | ConversationSkillSelections；每页 50，当前可见性、选择版本和可用状态，失效记录仍可展示 |
| 内部工具 `read` | SkillReadInput；受控路径读取及原工具账本，不开放新的公开下载服务 |

M09 独占资产、发布映射、建议及选择；M05 校验会话；M01 提供可信超级维护者身份；知识依赖由现有用例校验。`use_cases/personal_assets` 组合事务，SQL 留在 M09 私有 store；Node 只转换 Pi 资源及工具结果。契约以 packages/contracts 为真源，生成物同步。

### 10.4 页面与验收

沿用“我的积累”入口，页内区分个人/空间公共。公共显示负责人、版本和状态；维护控件只给有权用户，其他成员可选用或提建议。发布前显示实际将公开的文本与附件，并明确确认；工作台显示个人/公共来源、已选版本及失效原因。

新增 SHARED 和 NATIVE 用例，加上第 6 节选择、原资产目录、SQL 确认回归。覆盖个人互不可读、公共同空间可用但不能越权改、跨空间不可见、发布不带私人原话、幂等与并发、公共改版不升级旧选择、附件同授权、停用/依赖撤权/恢复拒绝。独立审查必须覆盖本轮代码、断言和实测结果；旧 Oracle 仅为输入审计。

## 11. 资产维护补充修复

2026-10-08 对已提交版本 `665e519` 补充审计，范围是资产编辑、发布回执和知识引用维护。当前进度及实际证据以 CURRENT 的 `I2-ASSET-MAINTENANCE` 为准，问题对照见[补充审计记录](research/asset-maintenance-audit-20261008.md)。沿用 C02/C05/C07/C08/D12/D13；不调整 Pi、Mem0、平台权限或 SQL 确认。

### 11.1 窗口与提交回执

- 编辑开始时固定记忆或 Skill 种类。切换分类、关闭后打开其他窗口、迟到的发布回执都不能改变新草稿的种类和内容。
- 保存和发布分别绑定发起窗口。回执只能结束原窗口，不能把另一窗口的确认、错误、忙碌状态或分类覆盖掉。同参保存重试仍使用原 `operation_id`。
- 原窗口已关闭而页面仍有效时，成功回执仍同步列表；离开页面或退出身份后不由旧回执发起新读取。刷新成功、失败均按列表请求代次保护，旧结果不能覆盖新结果。
- 启用、停用、删除也遵守同一页面归属；退出后的回执不在新身份下发起列表读取，旧状态操作失败不写入后来打开的编辑框。
- 写入成功与列表刷新分别反馈。成功记录不因刷新失败被表示为保存失败；提供单独重载列表的入口，不要求重复提交。
- 窗口关闭后才收到写入失败或无法确认的结果，在页面显示原资产名称和操作；不写入新窗口，也不把未收到成功回执描述为未写入。核对按钮只重读列表。同一仍打开窗口的同参重试继续沿用原操作身份。
- 提交开始不使已有列表请求失效；成功回执后的刷新才取代旧请求。提交失败时，尚在途的有效列表仍可正常显示。

### 11.2 依赖维护

- 编辑页展示已有引用的对象、路径、草稿版本、当前版本和对应当前正文。使用现有 `GET /knowledge/{id}` 读取，未读到时明确区分读取失败与已读取的停用状态。
- 对仍存在的引用位置，维护者核对当前正文与适用范围后，可明确更新到读到的版本；不自动升级，也不把不存在的路径替换成另一个位置。
- 对停用、删除、不可读或已不适用的依赖，维护者可核对方法后明确移除；同时检查方法正文与附件。修改只在编辑草稿中，取消不保存。
- 保存沿用 `AssetSave.dependencies`，Rust 继续校验权限、版本和路径。知识在核对后再次变化，保存仍拒绝；重新读取并核对后才可重试。
- 私人修改不影响独立公共副本；公共修订仍由负责人或超级维护者完成。保存形成新资产版本，已有会话不自动升级，使用者仍需明确重选。
- 名称、正文、范围、附件或依赖发生修改时，撤销对旧内容的“已核对”标记；用户可核对后重新勾选。仍允许保存未核对资产，不增加所有保存必须勾选的规则。移除引用时明确说明其不再参与失效检查，需核对正文、范围和附件已不再依赖它。

### 11.3 验证

| 验证 | 关键行为 |
| --- | --- |
| `check-asset-mutation-browser.mjs` | 迟到发布不关闭另一预览或改变新记忆；关闭编辑仍刷新列表；保存/发布/启停/删除旧回执不越过页面身份，旧错误不污染新编辑；关闭后失败有具名反馈；失败写入保留有效列表；写入成功但刷新失败可单独恢复 |
| `check-asset-dependencies-browser.mjs` | 旧引用拒绝、核对后更新、取消不保存、修改撤销旧确认、私人/公共副本独立、再次改版拒绝、停用/删除后明确移除、旧选择不升级、负责人和超级维护者边界、390px 页面可用 |
| 原编辑、共享和选择回归 | 原断言保留，继续检查同参重试、隔离、版本竞争和显式重选 |

这些用例使用 Chromium、Rust API、隔离 MySQL 和合成平台，不调用外部模型；其通过不代表真实 Datasight 或模型准确率已重新验证。
