# Data Agent UX 改版实施与分析报告阅读路径独立审计报告（2026-11-26）

## 一、审计范围、依据与最终结论

- **审计身份**：未参与本次前端与测试实现的独立只读审计子代理（UX & Frontend Independent Auditor）。
- **对照基准**：
  - 项目规范：`AGENTS.md`（12 条工程规则、6 项交付检查重点、开发防漂移约定、相对路径与脱敏红线）、`docs/CURRENT.md`（`goal_revision: 267`）。
  - 合议与实机复测基准：双方确认的六项取舍与四项复杂度减法（会话三态加载与原位返回、确认前 SQL 直读与执行后结果先行、单关闭入口与 `1280px` / `48%` 停靠、会话内原位选用分析方法、普通用户「数据字典」角色对齐与共用样式收敛，以及主控真人实机复测指出的 `390px` 输入区点击重叠/裁切、空方法面板重复入口、跨页返回焦点与多级面板返回路径收尾）。
- **核验方式**：
  1. 静态审查 `apps/web/src/` 下全部 31 个新增/修改源码与样式文件、`tests/mvp/` 测试变更及 `docs/CURRENT.md`「验收与要求变更」登记；运行 `npm run check:types`（`tsc --noEmit`）、`python3 scripts/check_architecture.py`、`make verify-delivery` 与 `git diff --check`。
  2. 对常驻打包预览 `http://127.0.0.1:4173/`（最终构建 `483b7217293d595d`）执行严格只读的 Playwright Chromium 多视口（`1440×900`、`1280×720`、`1279×900`、`390×844`）几何测量、真实指针点击与直接键盘 `Escape` 焦点追踪及真实画面目视核验（拦截一切非会话/快照写请求，零新增聊天发送、零付费模型调用）。
- **最终审计结论**：**`approved`（首轮独立审计检出的 3 项 Blocking、4 项 Non-blocking、3 项 Note，以及主控终审复测指出的停靠切层直接 `Escape` 与多级面板真实返回目的地名称均已在源码、测试、`docs/CURRENT.md` 与 `:4173` 常驻预览中完整闭环并通过独立复验）**。

---

## 二、最终在线产物与核心场景独立实测结果

### 1. 常驻打包预览（`http://127.0.0.1:4173/`）一致性与工作台实测

| 核验项 | 实测证据与数据 | 结论 |
| --- | --- | --- |
| 产物与服务字节一致性 | `:4173/` 在线返回 HTML 与本地打包产物 `index.html` 逐字节一致（`SHA-256: 483b7217293d595d7431b4e021eb9f45d86b54562b3f7dd248f643bbbd7d8635`）；`assets/index-CYxZfkBi.js`（`b1c664e3121991bb4b82227b147e343bee534b1f2d164405c5a88256c6477a3b`）与 `assets/index-BbKU-ZuJ.css`（`fc9670ec2080191c4fb2ad4e7e0a860fdd69ce44c994ae8a4a39922b4ab82e90`）磁盘与 HTTP 响应完全一致，且与 `docs/CURRENT.md` 第 1356–1358 行登记哈希一致。 | **通过** |
| 手机 `390×844` 点击区域与文字可读性（对照实机原图） | 登录已配置模型的 `bob` 打开《现在有几张表》：窄屏（`<= 700px`）采用双行网格。首行（`top: 728, bottom: 768`）：`模型` 选择框 `[23, 214]`（`191×40`）、`思考` 标签 `[220, 244]`（`getClientRects().length === 1`，单行未折断）、`思考强度` 选择框 `[249, 325]`（`76×40`）、`模型设置说明` `[331, 367]`（`36×40`）；次行（`top: 781, bottom: 823`）：`＋ 选用分析方法` `[23, 110]`（`87×42`）、`发送 ↑` `[323, 367]`（`44×42`）。5 个交互控件两两矩形相交数为 **`0`**（彻底消除原图横向重叠 `10px` 问题）；`DeepSeek Flash` 字宽 `88.72px` ≤ 可用宽 `159px`（完整无裁切），`轻度` 完整无裁切，全页横向溢出 `0px`。 | **通过** |
| 跨页查「数据字典」→ 搜字段 → 返回刚才的分析（位置与键盘焦点） | 普通用户 `bob` 刷新与切页全过程 `MutationObserver` 实测 `{ sawSemanticMgmtLabel: false, sawLogin: false, sawWelcome: false }`，主导航、面包屑与 `H1` 全程统一为 **「数据字典」**（`alice` 超级维护者为「语义管理」）。在 `1280×720` 与 `1440×900` 下切入 `字段语义` 搜索 `argument_unit`（`16 -> 1` 项）后点击「← 返回刚才的分析」：原最新提问 `y` 坐标保持 `93.86px -> 93.86px`（`yDelta = 0`），`document.activeElement` 落在 `TEXTAREA#question`（不再落回 `BODY`），按 `Tab` 直接进入 `BUTTON[aria-label="＋ 选用分析方法"]`。 | **通过** |
| 无可选方法时的空面板入口去重与 `Escape` 归还 | 在 `bob` 无已启用 Skill 状态下点击 `＋ 选用分析方法`：管理入口唯一保留 `去我的积累管理`（`count === 1`，原重复按钮已移除）；按 `Escape` 后未发草稿完整保留，焦点归还触发按钮 `BUTTON[aria-label="＋ 选用分析方法"]`。 | **通过** |
| 桌面双栏阅读、长表名折行、`显示技术标识` 与刷新零闪屏 | `1440×900` 与 `1280×720` 下首次打开多轮长回答会话自动定位于最新提问顶部，同屏可读最新提问与首段结论；Markdown 多张长技术表名自然折行且零横向溢出；`显示技术标识` 恢复紧凑文字按钮（宽 `76px`）；已登录刷新零帧闪现登录框或新对话欢迎屏。 | **通过** |

### 2. 分析报告阅读与多级面板返回路径四视口终审实测（真实点击 → 直接键盘 `Escape`）

在 `:4173` 已存真实长报告会话（`dfd761b8`）上，严格按「真实指针点击报告内口径引用按钮 `await kBtn.click()` → **不预先 `.click()` 或 `.focus()` 证据面板、直接按键盘 `Escape`**」以及「点击返回按钮」两条路径对四个断点视口逐项实测：

| 视口 | 容器形态与条形图溢出 | 单层报告返回按钮（可见文字 / `aria-label`） | 打开 `口径依据` 后焦点与返回按钮（可见文字 / `aria-label`） | 直接按 `Escape` 返回报告核验 | 再回原对话核验 |
| --- | --- | --- | --- | --- | --- |
| `1440×900` | 右栏停靠 `48%`（`584px`），条形图 `overflow = 0px`，滚底返回按钮可见 | `← 返回对话` / `返回对话` | `evidenceFocus = true`（聚焦证据顶栏返回按钮），`← 返回分析报告` / `返回分析报告` | `escapeWorked = true`，同一滚动容器，`scrollTop: 446 -> 446`，展开态保留，`openerFocused = true`，额外 `/report` 请求 `0` | 聚焦 `查看分析报告` |
| `1280×720` | 右栏停靠 `48%`（`507px`），条形图 `overflow = 0px`，滚底返回按钮可见 | `← 返回对话` / `返回对话` | `evidenceFocus = true`，`← 返回分析报告` / `返回分析报告` | `escapeWorked = true`，同一滚动容器，`scrollTop: 629 -> 629`，展开态保留，`openerFocused = true`，额外 `/report` 请求 `0` | 聚焦 `查看分析报告` |
| `1279×900` | 模态 `<dialog>`（`1000px`），条形图 `overflow = 0px`，滚底返回按钮可见 | `← 返回对话` / `返回对话` | `evidenceFocus = true`（仅顶层 `dialog[open]` 为 `1`），`← 返回分析报告` / `返回分析报告` | `escapeWorked = true`，同一滚动容器，`scrollTop: 380 -> 380`，展开态保留，`openerFocused = true`，额外 `/report` 请求 `0` | 聚焦 `查看分析报告` |
| `390×844` | 整页 `<dialog>`（`390×844`），条形图 `overflow = 0px`，滚底返回按钮可见 | `← 返回对话` / `返回对话` | `evidenceFocus = true`（仅顶层 `dialog[open]` 为 `1`），`← 返回分析报告` / `返回分析报告` | `escapeWorked = true`，同一滚动容器，`scrollTop: 567 -> 567`，展开态保留，`openerFocused = true`，额外 `/report` 请求 `0` | 聚焦 `查看分析报告` |

- **补充组合边界实测**：
  - 在 `1440×900` 打开 `分析报告`（`scrollTop = 220`）后再从左栏查询卡点击 `查看完整表格`：右栏 `查询结果` 面板返回按钮可见文字为 `← 返回分析报告`、`aria-label` 为 `返回分析报告`，按 `Enter` 返回 `分析报告` 后报告 `scrollTop` 保持 `220` 且焦点归还 `查看完整表格`。
  - 在 `1440×900` 打开 `[分析报告, 口径依据]` 后动态缩窄至 `390×844`：仅 `口径依据` 处于 `dialog[open]`（`count === 1`，无双模态冲突），按钮显示 `← 返回分析报告`，按 `Escape` 平滑切回模态 `分析报告`，再拉回 `1440×900` 点击 `← 返回对话` 正常关闭。
  - 从报告点击 `查看计算查询 1` 在四视口下均精确定位并聚焦目标查询卡（`>= 1280px` 保留右栏报告，`< 1280px` 自动收起模态报告后定位）。

---

## 三、首轮审计发现项（10 项）闭环复验台账

### Blocking（3 项 — 全部闭环）

1. **[B-01] `docs/CURRENT.md` 同步与「验收与要求变更」登记 — 已解决**
   - **复验依据**：`docs/CURRENT.md`（`goal_revision: 267`，第 1299–1364 行）已完整补入本次联合 UX 改版范围、构建 SHA-256 标识、分层证据，并在「验收与要求变更」逐条登记 5 组浏览器测试（`tests/mvp/check-conversation-experience-browser.mjs`、`tests/mvp/check-asset-experience-browser.mjs`、`tests/mvp/check-new-conversation-draft.mjs`、`tests/mvp/check-knowledge-experience-browser.mjs`、`tests/mvp/check-semantic-governance-browser.mjs`、`tests/mvp/check-creator-ownership-browser.mjs`、`tests/mvp/check-report-reading-position-browser.mjs`、`tests/mvp/check-browser.mjs`、`tests/mvp/check-management-buttons.mjs`、`tests/mvp/check-analysis-reports-browser.mjs`）的原值、新值、合议/设计依据与影响范围。`make verify-delivery` 通过，公开文档零个人机器绝对路径。

2. **[B-02] `分析报告 ↔ 口径依据` 双模式状态保留与直接 `Escape` 焦点接力 — 已解决**
   - **复验依据**：`apps/web/src/shared/Modal.tsx:16-61, 88-96` 与 `apps/web/src/features/workbench/Workbench.tsx:135-195, 716-745` 保持栈内下层视图挂载并通过 `active` 同步管理 `<dialog>` `showModal()`/`close()` 与滚动位置记忆，同时在 `openPanel` 标记停靠区内部切层（`focusMovedWithinDock`）并在 `useLayoutEffect` 直接聚焦当前激活面板返回按钮。经 `:4173` 四视口实测，真实点击口径引用后不点证据面板直接按 `Escape` 100% 关闭顶层回到原报告，同一滚动节点、原 `scrollTop`、展开态与原引用按钮焦点全部保留，额外 `/report` 请求数为 `0`。

3. **[B-03] `tests/mvp/check-report-reading-position-browser.mjs` 默认报告分支对齐 A-02 受控唤醒 — 已解决**
   - **复验依据**：`tests/mvp/check-report-reading-position-browser.mjs:236-246` 已对齐同脚本 `--query-results` 分支，先验证空闲 `2.4s` 零定时轮询，再派发两次受控 `focus` 事件验证报告滚动位置、展开依据、焦点与未发草稿保留，并已登记于 `docs/CURRENT.md:1340-1344`。

### Non-blocking（4 项 — 全部闭环）

1. **[NB-01] `48%` 停靠宽度下报告条形图 `.report-bars` 横向截断 — 已解决**
   - **复验依据**：`apps/web/src/features/workbench/analysis-report.css:34-36` 将 `.report-bars` 改为 `min-width: 0` 并收敛 `.report-bar-row` 列宽；`:4173` 四视口实测 `.report-chart-scroll` 横向溢出均为 `0px`（`534/534`、`457/457`、`948/948`、`356/356`），右侧比率数值完整可见。
2. **[NB-02] `ConversationHistoryModal` 首屏 `150ms` 假空态闪现 — 已解决**
   - **复验依据**：`apps/web/src/features/workbench/ConversationHistoryModal.tsx:58, 99-127` 将 `historyBusy` 初始置为 `true` 且在空搜索词时立即发起请求；`:4173` 实测打开历史记录弹窗 `sawEmptyConvText === false`（注：首次点击切换至 `查询记录` 页签时因 `queryHistoryBusy` 初值为 `false`，在 `useEffect` 同步置 `true` 前仍有单帧空态渲染但已无 `150ms` 防抖延迟，不影响交付）。
3. **[NB-03] 普通用户导航默认名称极性与治理测试同步 — 已解决**
   - **复验依据**：`apps/web/src/main.tsx` 提升 `WorkspaceRoleProvider`，`apps/web/src/shared/WorkspaceShell.tsx:22` 统一为 `role === "maintainer" || role === "super_maintainer" ? "语义管理" : "数据字典"`；`:4173` 普通用户 `bob` 刷新全过程 `sawSemanticMgmtLabel === false`；`tests/mvp/check-semantic-governance-browser.mjs` 与 `tests/mvp/check-creator-ownership-browser.mjs` 已同步校验升权前 `数据字典`、升权后 `语义管理`。
4. **[NB-04] `ConversationSkillPicker` 移除方法幂等 `operation_id` 缓存 — 已解决**
   - **复验依据**：`apps/web/src/features/workbench/ConversationSkillPicker.tsx:31, 100-116` 已按 `selection_id` 缓存复用待完成移除操作的 `operation_id`，失败保留以便重试幂等、成功后清理。

### Note（3 项 — 全部闭环）

1. **[N-01] 模型配置容量摘要同源判定 — 已解决**：`apps/web/src/features/models/ModelConfigurationFields.tsx:404-420` 已直接复用 `capacityProblem(draft)`。
2. **[N-02] 关闭方法面板冗余 `focus` 清理 — 已解决**：`apps/web/src/features/workbench/Workbench.tsx:751` 已移除冗余 `textarea.current?.focus`，统一由 `Modal` 归还触发按钮焦点。
3. **[N-03] 多级面板栈返回按钮真实目的地文案与无障碍名 — 已解决**：`apps/web/src/features/workbench/Workbench.tsx:718-733` 按下层视图动态生成 `closeLabel`（如 `返回分析报告` vs `返回对话`），可见文字与 `aria-label` 完全一致，并与 `tests/mvp/check-analysis-reports-browser.mjs:268-286` 断言对齐。

---

## 四、工程门禁与合规核查结论

- **类型、架构与交付门禁**：`npm run check:types`、`python3 scripts/check_architecture.py`、`make verify-delivery`（含 16 项单测）与 `git diff --check` 全部零错误通过。
- **可访问性、契约校验与权限边界**：`apps/web/src/styles/tokens.css` 对比度实测 `5.64:1–14.63:1`（满足 WCAG AA），可见字号 `>= 12px`；`apps/web/src/shared/api.ts` 在生产构建中保持前后端运行时契约校验；服务端权限、只读检查、确认绑定与幂等负例零删减。
- **公开卫生与只读审计纪律**：公开源码与文档零硬编码凭据、零个人机器绝对路径；独立审计全程未修改业务源码、测试或 `docs/CURRENT.md`，对 `:4173` 零写状态变更、零计费模型调用。
