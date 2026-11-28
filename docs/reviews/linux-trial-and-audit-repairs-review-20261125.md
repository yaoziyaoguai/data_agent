# Linux x86_64 适配、试用阻塞修复与过期门禁修齐独立审查记录（2026-11-25）

## 审查范围与方式

- 审查者：未参与本轮编码实现的独立只读审查子代理（对照 `AGENTS.md` 12 条工程规则、6 项每次交付检查重点、开发防漂移约定、`docs/semantic-retrieval-design.md` 及 `docs/CURRENT.md`）。
- 审查对象：本轮工作树全部未提交代码、契约、架构图册与测试脚本改动。
- 公开安全核查：全量 diff 检索个人机器绝对路径、API Key / 私钥、内部链接命中 0 处；`git diff --check` 通过。

## 首轮审查发现及闭环核实

1. **[P0 · 已修复复核通过] `apps/agent/provider/configured.ts` OpenAI Responses 工具 `strict` 标记**
   - 首轮发现：将 `openai-responses` 分支设为 `supportsStrictMode: false` 会省略工具序列化中的 `"strict": false` 字段，导致 `CONFIGURED-PROVIDER-DISPATCH`（`tests/runtime/configured-model-capabilities.mjs`）与 `OPENAI-MODEL-CONFIGURATION`（`tests/mvp/check-model-configuration.mjs`）断言失败。
   - 修复核实：`openai-responses` 分支恢复 `: compat ? { compat } : {}`，保留 `anthropic-messages` 的 `supportsStrictTools: false` 与 `openai-completions` 的 `supportsStrictMode: false`；`checkConfiguredCapabilities()` 与 `check-configured-provider.mjs` 实测通过。

2. **[P0/P1 · 已修复复核通过] `apps/web/src/features/knowledge/KnowledgePage.tsx` 权限变更全量替换与 `<React.StrictMode>` 纯度**
   - 首轮与复核发现：`replaceAll` 局部变量位于 `useEffect(..., [user, authorityRevision])` 内，在 `refreshAuthority()` 递增 `authorityRevision` 重挂载时被重置为 `false`；初步改为 `useRef` 后，还需保证在请求成功后再清零 `replaceAllRef.current` 并保持 `setObjects` 纯更新函数。
   - 修复核实：提升为组件级 `replaceAllRef`（切换 `user` 与 `refreshAuthority()` 置为 `true`），在三路核心请求成功后清零；在 `setObjects` 外部独立计算 `stillVisible`、重置已失权的 `current` 并切换 `relatedTarget`，保持活跃编辑器草稿不因 SSE 重连卸载且撤权对象立即从内存剔除。

3. **[P2 · 已修复复核通过] `apps/memory/providers.py` 中文字符准入与字节级 BPE 预算上界**
   - 首轮发现：直接以 Unicode 字符数作为 `input_tokens_upper` 在高密度 Emoji 或生僻多字节字符下可能低于真实字节级 BPE token 数，触发 `model_trials.state = 'breached'`。
   - 修复核实：准入按 Unicode 字符数放行（`<= 8192` / `<= 65536`），传给宿主的 `input_tokens_upper` 取 `min(上限, UTF-8字节数 + TOKEN_OVERHEAD_PER_TEXT)`，兼顾约 8,000 字中文记忆准入与严格预占上界。

4. **[P2 · 已修复复核通过] `apps/web/src/features/models/ModelConfigurationFields.tsx` 服务切换档位过滤**
   - 首轮发现：仅在切换「Anthropic 思考方式」时过滤 `xhigh`/`max`，从其他协议切入 `anthropic-messages` 服务（默认 `budget` 模式）时未过滤。
   - 修复核实：在「所属服务」切入 `anthropic-messages` 且非 `adaptive` 模式时同步过滤 `thinking_levels` 并回退 `default_thinking`。

## 分项核实结论

- **架构与模块边界**：`python3 scripts/check_architecture.py` 通过；各模块 `store.rs` 私有边界完整，无兄弟模块互导，无 `use_cases` 通用 SQL 入口，全部非生成源文件 ≤ 800 行；`python3 docs/architecture/check-implementation.py`（31 张图）通过。
- **P0 试用阻塞项（`B-01`..`B-06`）**：`apps/platform-mock/server.py` 扩展纯只读 SQLite 函数并补齐 `/status` 延迟执行的 `denied_tables` 拦截；`apps/agent/tools/data-tools.ts` 为 `update_analysis_task` 提供根级 `{ type: "object", properties, required: ["action"], allOf }`、拦截 `condition_patch` 非空字段传 `null` 并在前序 `context_reset` 时阻断同批后续工具；`crates/data-agent/src/use_cases/deliver_run.rs` 补齐 `refresh_context` 的 `result_notification`；模型配置默认请求体上限调至 `2 MiB`，修复 `MiB` 输入清空态与 `Workbench.tsx` 公开错误码展示。
- **P1 权限、回放、Mem0、传输与前端（`S-01`..`S-11`）**：`context_authority.rs`、`query_workflow.rs`、`personal_assets.rs`（`assert_read_skill_authority_in_tx` 含 `stale_source` 核验；运行内仅读未采用知识按 2026-11-24 已确认裁决保持当前 run 可继续、新一轮及恢复与输出快照读取重核）、`personal_memory.rs`、`ingestion/store.rs`、`knowledge/store.rs`、`proposals/store.rs`、`skill_drafts.rs`、`runtime/model_calls/store.rs`、`apps/api/src/{request.rs,routes.rs}` 的锁序、事务原子性与权限重核核实无误；`apps/agent/transport/{client.ts,server.ts}`、`deliver.ts`、`render.ts`、`packages/contracts/openapi.json` 及前端交互修复符合契约。
- **测试修改与剩余边界**：修改过的验收脚本均保持原业务意图并对齐已确认封板裁决，须在 `docs/CURRENT.md`「验收与要求变更」完整登记；未纳入本轮改动的子项（如部分非读取类工具幂等重放缓存、Mem0 `infer=False` 在 `unknown` 后写向量失败、部分未绑定的混合检索长电池旧脚本）已在 `docs/CURRENT.md` 如实保留为已知限制。

**最终结论：`passed`（代码层与工程门禁审查通过）。**
