---
{
  "workflow": "development",
  "schema": 1,
  "phase": "release_closeout",
  "goal_revision": 76,
  "environment": "阶段试用版收尾：业务与架构文档已分批推送，本地服务已更新，六篇工程文章已发表并核对公开页面。模型配置已验收；真实模型语义缺口继续保留。",
  "verification": {
    "level": "increment",
    "reason": "保留原失败；新增通用业务、协议及浏览器回归，并独立核对修复与边界。",
    "freshness": "content",
    "checks": [],
    "inputs": [
      "apps/agent",
      "apps/api",
      "apps/web/src",
      "crates/data-agent",
      "packages/contracts",
      "tests",
      "migrations",
      "scripts",
      "package.json",
      "package-lock.json",
      "Cargo.lock",
      "docs/architecture/implementation-design.md",
      "docs/development.md"
    ]
  },
  "delivery": {
    "schema": 1,
    "registry": "docs/semantic-retrieval-design.md",
    "increment": {
      "id": "I2-MODEL-CONFIGURATION",
      "phase": "I2",
      "status": "complete",
      "goal": "超级管理员通过页面持久配置模型服务、凭据和具体模型；Pi原生多协议接入，普通用户只选已启用模型。",
      "requirements": [
        "C01",
        "C03",
        "C05",
        "C08"
      ],
      "modules": [
        "M01",
        "M05",
        "M08",
        "M10",
        "M11",
        "M12"
      ],
      "allowed_paths": [
        "apps/agent",
        "apps/api",
        "apps/web",
        "crates/data-agent",
        "packages/contracts",
        "tests",
        "migrations",
        "scripts",
        "package.json",
        "package-lock.json",
        "Cargo.lock",
        "docs/CURRENT.md",
        "docs/architecture",
        "docs/semantic-retrieval-design.md",
        "docs/reviews",
        "README.md",
        "docs/development.md"
      ],
      "non_goals": [
        "不提交推送或更新常驻服务；不新增付费调用。",
        "不另建Agent循环、自动模型路由、预填/embedding供应商管理或修改未解决的真实语义问题。"
      ],
      "invariants": [
        "每条消息24次和连续临时失败3次；恢复、摘要及结果唤醒沿原消息模型配置与预算。",
        "仅当前空间超级管理员读写服务及模型配置；凭据加密保存，不进入公开目录、日志、检查点或消息。",
        "Pi负责三种原生协议的请求、流式与工具解析；同批宿主工具顺序执行保持。",
        "配置修订只影响新消息；停用阻止新发送，不自动换模型，不重做未知副作用。"
      ],
      "verification_inputs": [
        "apps/agent",
        "apps/api",
        "apps/web/src",
        "crates/data-agent",
        "packages/contracts",
        "tests",
        "migrations",
        "scripts",
        "package.json",
        "package-lock.json",
        "Cargo.lock",
        "docs/architecture/implementation-design.md",
        "docs/development.md"
      ],
      "acceptance": [
        {
          "id": "MODEL-CONFIG-CONTRACT",
          "requirements": [
            "C01",
            "C03",
            "C05",
            "C08"
          ],
          "expected": "同源契约、类型、Rust和架构边界通过。",
          "evidence_kind": "contract",
          "command": [
            "make",
            "verify-contracts",
            "verify-code",
            "verify-architecture"
          ],
          "timeout_seconds": 1200
        },
        {
          "id": "MODEL-CONFIG-BEHAVIOR",
          "requirements": [
            "C01",
            "C03",
            "C05",
            "C08"
          ],
          "expected": "超级管理员创建编辑接入，普通用户拒绝；密钥保密、版本冲突、停用、冻结配置、不同协议真实Pi工具回合及浏览器流程通过。",
          "evidence_kind": "runtime",
          "command": [
            "node",
            "tests/mvp/check-model-configuration.mjs"
          ],
          "timeout_seconds": 1200
        },
        {
          "id": "MODEL-CONFIG-COMPATIBILITY",
          "requirements": [
            "C01",
            "C03"
          ],
          "expected": "原Flash/Pro选择、恢复及后台结果沿原模型与预算。",
          "evidence_kind": "runtime",
          "command": [
            "node",
            "tests/mvp/check-model-selection.mjs"
          ],
          "timeout_seconds": 900
        },
        {
          "id": "MODEL-CONFIG-PROTOCOL",
          "requirements": [
            "C01",
            "C03",
            "C05"
          ],
          "expected": "三种Pi原生协议可靠用量/缺失用量/临时失败与受控端点负例通过，SDK不隐式重发。",
          "evidence_kind": "runtime",
          "command": [
            "node",
            "tests/runtime/check-configured-provider.mjs"
          ],
          "timeout_seconds": 120
        }
      ],
      "review": {
        "status": "passed",
        "record": "docs/reviews/model-configuration-review.json"
      },
      "evidence": ".local/delivery/I2-MODEL-CONFIGURATION-result.json"
    }
  }
}
---

# Data Agent 当前记录

## README 配图更新（2026-10-20）

用户指出 README 多张图仍为早期版本，要求更新并推送。本轮在 `codex/readme-current-figures` 核对四张功能说明图及实际界面截图：共享语义归属与纠错、多来源分析报告、持久正文的来源失效、个人方法草稿和显式选用。范围仅 README、图片及来源说明、必要的本地截图脚本和本记录；既有架构与业务实现不变，不新增付费模型试验。封面作为产品标识单独核对，不把图像生成或模拟流程当成模型能力证据。

截图使用当前应用和隔离合成资料，避免使用实际试用聊天；图片正文、README 页面效果与移动端分别检查。完成后先合入现有默认分支 `codex/semantic-maintenance-prototype`，再推送并核对远端图片内容，保留原工作台服务。

配图已完成：四张功能说明图全部重绘，原四张页面截图全部替换，新增一张分析报告截图；README 共展示 11 张图。产品封面核对后保留，架构总览沿用当天已更新的版本。图片文件、替代文本、图注及 `docs/images/README.md` 的来源清单和实际生成提示词同步更新。

五张页面截图来自隔离测试库和当前正式 React / Rust / 合成 SQLite 平台。受控工具调用完成聊天授权、查询、依据与报告保存；月度净收入原值与独立预期 102000、113000、134000 分一致；方法草稿通过页面确认保存为个人 Skill。模型管理图使用明确标注的示例配置。没有付费模型调用，未读取日常试用聊天，截图流程不构成真实模型质量验收。过程与结果在 `.local/readme-current-figures/capture.mjs` 和 `capture-result.json`。

验证：本地 Markdown 渲染在 1440px 与 390px 宽度下，11 张图均加载成功，页面与图片没有横向溢出；逐图核对文字、箭头与界面内容。`make verify-delivery verify-materials` 通过，含 16 项交付检查器测试、377 项材料静态检查与 215 个文档链接；`git diff --check` 通过。原本地 API、Agent Bridge、平台、Mem0 与 Web 均返回 200。渲染、检查与服务健康收据保存在同一忽略目录；合并及远端逐文件校验结果另存 `git-delivery.json`。本轮只改文档和图片，沿用已完成的业务验收，不重复全量或付费试验。

## 收尾完成：阶段试用版与工程文章（2026-10-20）

用户接受阶段试用版定位，要求同步仓库文档和架构图、分批提交推送、更新本地服务，并润色、配图和发表系列文章。此授权取代上一节模型配置增量中“不提交推送或更新常驻服务”的本轮操作限制；不增加产品功能，不把原可靠性验收改为通过，不追加模型质量抽样。

收尾范围：README、当前架构总览及模块图源/导出、第二版讲解与历史页面版本提示，保持已完成业务代码及契约；需求关联沿模型配置 C01/C03/C05/C08，以及既有可靠性修复的对应要求。四组模型配置正式验收和原工程回归继续按各自版本引用。文档检查、图片渲染、服务启动和文章公开读取分别取证，不代替真实模型或真实 Datasight 验收。

本版保留三类已知质量缺口：独立澄清仍可能合并并过早关闭；回答可能补写没有受控计算来源的数字或无依据解释；生成 SQL 的零总变化/空数据比例边界仍可能错误。普通答复暴露内部标识为较低优先级问题。用户可继续 dogfood，重要口径、SQL 和结论仍需核对。I2-AGENT-RELIABILITY 保持未关闭，详见原独立审查；I2-MODEL-CONFIGURATION 的 complete 仅对应模型配置增量。

发布文稿以生成内容的来源追踪、Pi 多模型配置与恢复一致性为主题，按用户最新决定直接更新旧四篇正文、源码和配图，不追加版本说明；历史验证仅作为标明时点的证据。公开材料只用合成例子和已审阅代码，不发布私有日志、凭据、实际对话或本机路径。文章稿与发布回执沿既有忽略目录保存，仓库保存通用架构文档及图源。

可观察收尾结果：当前图与已实现边界一致；Git 提交推送后工作树干净；原本地工作台的数据、身份和模型设置保持，服务健康并能打开模型配置；网站两篇新文图像可见、源码链接固定且系列顺序正确。执行进度与证据在本节追加。

文档与图已完成：README 补齐模型管理入口和阶段边界，C4 图源/导出、31 张实现图、第二版讲解与历史页面提示同步。`make build`、`make verify-delivery verify-materials`、架构文档检查通过；375 项准备材料检查、213 个文档链接通过，图册无页面异常或移动端溢出。独立审查 `.local/release-closeout-20261020/documentation-review.json` 通过，两处过度保证措辞已修正。代码与对应契约、测试、迁移及实施文档已提交为 `a166e95`。

本地更新先备份原业务库，沿原运行目录、身份、模型 profile 和 `docs/sources/analysis` 合成快照启动。初次遗漏原来源目录触发平台一致性拒绝，核对原启动记录和来源指纹后已恢复，未重建业务库或更换身份。健康与浏览器结果在收尾目录分别记录，不发送新增付费试用消息。

交付结果：业务提交 `a166e95` 和文档/图提交 `3b6df0b` 已推送到 `origin/codex/analysis-capabilities`。本地工作台 `http://127.0.0.1:27173/` 已运行最新业务代码，API、Pi 桥、合成平台、Mem0 和 Web 均返回健康状态 200；管理员模型配置接口 200、普通用户 403，桌面与 390px 窄屏检查通过，原登录身份指纹保持。收据为 `.local/release-closeout-20261020/service-health.json`、`service-final-health.json`，完整库备份仅保留本机。最后一批文档补入模型管理实际截图、图片来源及系列入口，不改变运行代码。

六篇[工程实践系列](https://wangjinkun333.me/blog/series/data-agent-engineering)已公开：旧四篇直接更新正文、代码引用与相关机制图，保留原 slug 与发布日期，没有追加版本说明；新增[生成内容的来源追踪与失效处理](https://wangjinkun333.me/blog/data-agent-engineering-content-authority)和[基于 Pi SDK 的多模型接入与恢复一致性](https://wangjinkun333.me/blog/data-agent-engineering-model-runtime)。源码固定到公开提交 `3b6df0b`；新增或替换 11 张技术图及 1 张实际管理截图。独立事实审查通过，纠正了候选截断先后顺序、排序数量保护与字节裁剪混同等过度表述。正文明确大范围检索仍可能因候选上限遗漏相关对象，不能由前三项保护推断全文完整交付。

发布后的公开 API 与页面均已核对：文章 ID 27–32 按 1–6 排序，合集更新未改变文章正文；六篇共 26 处正文图片在桌面与 390px 手机视口均成功加载，无页面异常或横向溢出。104 个正文源码链接均使用固定提交；图像、页面及系列已目视复核。私有稿件、审查、发布回执和截图在 `.local/release-closeout-20261020/articles/`，主要证据为 `legacy-factual-review.json`、`series-update-receipt.json`、`public-browser-check.json`。这些发布与工程检查不关闭上方列出的真实模型语义缺口。

最后文档批次的 `make verify-delivery verify-materials` 通过：16 项交付检查器测试、376 项材料静态检查、214 个文档链接；`git diff --check` 通过。结果保存在 `.local/release-closeout-20261020/final-document-check.log`。本批只更新 README、图片及当前记录，沿已完成业务构建与增量验收，不重复付费模型试验。

主分支归并：用户要求合并后再推送。已核对 GitHub 默认分支为 `codex/semantic-maintenance-prototype`，仓库没有 `main` 或 `master`；以该现有默认分支接收 `codex/analysis-capabilities`。本地从 `6801df7` 快进到 `c340954`，完整保留 19 个提交，无冲突，合并后的文件树与已验收版本相同。本次主分支交付仅在其上追加这段记录，不改变业务代码；原本地服务继续运行相同代码。推送与远端一致性收据保存在 `.local/release-closeout-20261020/default-branch-merge.json`。

## 已完成：超级管理员模型配置（2026-10-20）

用户确认实现根本的模型接入配置，不仅管理已接入模型的可选列表。沿用dev_co；当前分支`codex/analysis-capabilities`，保留全部既有未提交工作。上一增量I2-AGENT-RELIABILITY仍有真实模型语义缺口，保持未完成；原验收与证据见下方历史记录和`docs/reviews/dogfood-reliability-review.json`，本轮不将它算作通过。

本轮按当前空间隔离，现有可信超级维护者身份显式获得模型配置管理操作；普通用户仅获取启用模型的公开展示信息。管理页支持服务名称/供应商/协议/地址/API Key及模型ID/展示名/思考档位/上下文和输出限制/计价信息/启停/默认。首批协议为Pi1.3原生OpenAI Chat Completions、OpenAI Responses、Anthropic Messages；兼容端点可配置非内置Model ID。密钥由后端加密，读取只返已设置状态；配置版本与消息模型快照分开，旧消息沿原版本，停用阻断以后发送但不撤销已在途请求。固定模型协议才需要代码适配，不接受浏览器任意代码/请求头或Agent自行改模型。

契约调整：内部ReserveModelCall原固定输出枚举（例如32769被拒绝）改为与管理员可配置范围一致的有界整数；宿主仍要求与本消息冻结上限完全相等。旧非法32769契约用例改为超出131072的131073负例，并新增配置档位/24次约束/密钥不出管理响应的用例。ModelSelection中的未知逻辑ID/Pro-low形状不再由JSON Schema写死，实际目录和旧profile继续在宿主业务边界拒绝不支持的选择，原对应契约正反例已调整；此变更服务于用户已确认的多模型能力配置，不放宽旧ModelProfile分支或消息许可校验。

实际Responses工具回合暴露旧边界假设：Pi原生工具ID是`call_id|item_id`，原64字符字母数字Schema拒绝，导致工具未落账、交付message_pending。将内部工具ID单独作为最长512字符的无空白不透明标识保存，工具账本扩容并使用区分大小写的排序；保留完整SDK身份而不截断/重编码，既有operation_id与重放规则不变。新增复合ID契约、原生协议工具回合和恢复验收。

成功标准：页面创建一个非DeepSeek模型后可立即选用，在真实Pi会话经本地协议服务完成工具回合；跨用户拒绝、密钥不泄露、并发编辑不覆盖、停用不回落mock/另一模型、恢复仍保留原模型和预算。使用合成端点及隔离数据库，无付费调用。以ring现有锁定版本提供凭据加密、undici现有锁定版本提供受控DNS连接（提升为直接依赖），不复制密码算法或模型流解析器。

工程检查：当前531条同源契约、Rust fmt/clippy、TypeScript、Web构建和架构/锁序检查通过（`.local/checks/model-configuration-required.log`）；新管理配置完整流程通过，包含实际三协议Pi工具回合、权限/密钥/版本边界和浏览器操作，共13次本地请求、0官方请求（`.local/checks/model-configuration-runtime.log`）。独立审查确认并修复种子Flash/Pro配置与密钥未冻结、legacy改绑后检查错服务、off与推理能力混淆、跨账户签名复用、Anthropic档位降级、SDK扩大输出cap等问题。独立审查与四组正式验收已通过，完成收据见本节收尾记录。

审查修复进展：上述边界已实现，模型配置显式保存reasoning_supported，Anthropic显式区分budget/adaptive；Pi目录中的Claude原生隐式工具占位和fallback同时关闭，保留受控业务工具与冻结模型身份。目录模型off/high、未知模型adaptive档位、跨服务/密钥修订签名隔离和实际输出cap已通过零网络载荷验证；三协议缓存usage、缺失usage和503分类共9次本地请求通过。Rust跨空间与seed密钥轮换/逻辑模型改绑/原服务停用测试通过；完整管理页面流程通过。目视截图发现本页继承全局header固定高度导致窄屏重叠，局部重置后已修复；下拉框补明确可访问名称。Responses原生复合工具ID的取消恢复专项通过，原消息、预算、密钥、模型和operation身份均保持。独立审查已确认Pi ModelRuntime注册表按实例隔离，同服务并发会话不共享运行许可闭包。

验收装配说明：capture夹具改为先启动合成协议服务，再把同一合成端点与凭据传给API，避免新密钥封存边界仍依赖测试主进程环境；启动夹具共用自身隔离主密钥。界面模型标签从旧Flash/Pro简称改为完整的管理员展示名，启动断言对应改为DeepSeek Flash/Pro。恢复夹具固定“工具回执→取消→恢复→回答”脚本，避免把宿主恢复提示误作另一个新问题；原严格operation不变断言保留，并追加原function_call_output实际交付校验。原浏览器标签与测试装配失败分别保留在`.local/checks/model-configuration/browser-label-before.json`、`model-configuration/recovery-environment-before.json`和`model-configuration-recovery-fixture-before.log`，不能以这些失败推断产品幂等失效。上述装配修改后的完整回归和最终验收均已通过。


错误边界收尾：已复现管理接口实际返回的四个错误码被Web的AppError验证拒绝（`invalid_model_endpoint`、`model_credential_required`、`model_secret_unavailable`、`model_unavailable`），原失败保留为`.local/checks/model-configuration/app-error-before.json`。同源Schema补齐错误码及Rust/TypeScript往返验证，完整管理流程新增实际拒绝的契约检查及浏览器地址/缺密钥提示、草稿保留和价格换算断言。实际输出cap拒绝保留`model_output_limit`安全码到交付日志，不改变发送拒绝或补正规则。 新建表单的HTML必填校验本来会拦下空Key，初版新增浏览器断言错误地等待服务端拒绝；失败保留于`.local/checks/model-configuration/browser-required-before.log`及`.txt`。改用真实“编辑服务地址但未重新提供Key”流程验证后端拒绝与具体提示；新建缺Key的直接API负例仍保留，未移除页面必填约束。

兼容回归中，原澄清夹具在第九轮之前遇到无工具请求并失败；原报告/日志保留为`.local/checks/model-configuration/clarification-before.json`与`clarification-before.log`。夹具原先把每个模型请求都当作业务工具回合，未覆盖Pi原生摘要。新增只接受SDK摘要标识及conversation封装的独立响应分支，保留原业务脚本和全部断言，摘要计入原账本且不消费业务步骤；不关闭压缩或扩大请求上限。随后实际请求证实Pi还使用`generateTurnPrefixSummary`的`# Conversation`格式；按锁定SDK源码支持普通摘要和轮次前缀摘要两种封装，system标识仍必需。中间失败保留为`.local/checks/model-configuration/clarification-split-prefix-before.log`，未更改业务预期。完整澄清回归已通过：13组、9轮、35次本地调用（含2次Pi原生摘要），最大请求80673B，原消息账本结清；0官方请求。证据为`.local/checks/model-configuration-clarification.log`及`clarification-summary-requests.json`，独立审查已核对夹具未放宽业务标准。

本轮回归完成：原模型选择36次本地请求、原生压缩29次请求/15次摘要/最大65188B、正式启动6次、旧provider13次、最终回答12次均通过；对应`.local/checks/model-configuration-{selection,compaction,startup,legacy-provider,final-answer}.log`。新三协议能力与用量守卫9次本地请求、Pi桥接/检查点40轮、10项启动器单测，以及16项增量检查器和373项材料检查也通过。桌面/窄屏页面及编辑弹窗已目视核对。以上均为合成协议/平台验证，本轮没有官方模型调用；真实供应商和模型质量不在此证据范围。独立审查记录`docs/reviews/model-configuration-review.json`结论passed；随后`make verify-increment`实际执行四组验收全部exit0，前后范围指纹相同，收据为`.local/delivery/I2-MODEL-CONFIGURATION-result.json`。I2-MODEL-CONFIGURATION关闭；旧I2-AGENT-RELIABILITY及真实模型语义缺口仍保持未完成。本轮未提交推送，也未更新27173常驻服务。

更新：2026-10-20。唯一活动项目目录：`~/work_space/data_agent`。

## 当前修复：一般性根因与完整闭环（2026-10-20）

最新用户要求重新独立核对全部问题并完成修复，已取代前一轮只读/不修产品的范围。沿用dev_co；基线`c9d0ced`、分支`codex/analysis-capabilities`，原README/试用包/CURRENT改动保留。当前修复范围以上方增量为准，原160项结果不反写。

2026-10-20最新更正：用户明确测试不设累计调用次数和累计费用上限，每次用户交互仍按原设置。本轮剩余真实模型验收采用既有`budget_mode=request`，每消息24次、连续临时失败3次停止；摘要、重试、恢复及查询结果唤醒共用对应原消息额度。省略累计trial次数/费用字段，沿既有正常模式不设累计到期；无需修改产品预算实现，也不放宽单请求/权限/版本/幂等规则。继续使用Flash/high及合成资料，完成独立问题/部分回答与原完整趋势→贡献→正式解释两条流程，先保存实际请求和失败，再据证据修复；不为取得成功无限重复同一失败。旧有限trial及失败账本保留，新验证使用独立正常模式账本，不给旧查询转移预算。该决定取代此前48/128次及费用上限的建议，不包含提交推送、更新常驻服务或修改默认模型。

历史授权（已用完）：用户曾同意一次DeepSeek Flash/high定向对照，合计最多24次实际模型调用、500000微美元，使用同一持久trial，保留预留及失败，不换trial补额、不改默认模型。先核对未定义规则、独立目标与逆序部分回答，有余量时再跑贡献草稿→明确执行→精确query_id结果唤醒短链；短链不能冒称原完整趋势到贡献流程复验。隔离合成环境保存实际provider请求及有序工具参数，排除凭据；该授权替代下文历史“等待费用答复”的状态。工程源码保持已验证版本，试验后按实际证据继续处理语义缺口。

高档对照已到上限停止：24次实际调用（含Pi原生摘要）、账本175317微美元、预留0；实际载荷确认`thinking=enabled/reasoning_effort=high`。未定义规则样本保留未知，贡献草稿含差额/合计/比例；独立目标仍混合分母和分子提问，部分回答后关闭复合题再新增分子题，未丢未决事项且未写SQL，但问题记录不符合独立可答契约。贡献执行已排队，整次trial上限耗尽，未完成平台结果/自动解释，不能把SQL改善视作ISS-12通过。原始报告`.local/checks/reliability-flash-high-comparison/report.json`及请求保留；默认模型和原服务不变，不追加付费抽样。

新证实的一般性编排缺口：`execute_query`已明确指向同一本人的具体查询、版本和完整本轮原话，却仍要求单独`route`重复声明同一目标，真实high执行为此经历拒绝→route→重试。实施范围仅在本消息尚无任务关联时，将该目标关联与确认放同一事务；已有归属必须包含目标，多目标先分别登记，保留route到A后不能直接执行B的负例，复用现有业务规则；任一拒绝不能残留新增关联，其他pending/failed消息、澄清、来源、版本、原预算和unknown身份保持。系统设计第15/19.5/19.6节及Node工具说明同步；不是从自然语言自动猜测目标，也不增加执行授权。此处替代旧测试对“仅因本条未route而拒绝”的期待，新增直接执行与失败回滚/其他消息阻塞负例；原否定、外部资料、系统输入、版本、未知和并发边界保留。后续仅本地工程验证与独立审查，不重跑已用满trial。

第二处契约缺口：实际high的已有任务revise因省略goal被参数校验拒绝，补传原目标后才成功。analysis存储本已支持省略/空目标时保留原目标和authority；当前将同源Schema改为仅新建任务分支强制goal，已有任务可省略，补创建缺失拒绝、修订/澄清/归属保留目标与来源的验证，不改变条件补丁、版本和问题ID规则。旧必填拒绝和原始high请求保留，不把这项易用性修复等同于复合问题语义已解决。 恢复夹具同步：原check-clarification以本消息未route触发message_pending，新契约下该输入应成功；改用过期草稿版本触发version_conflict，仍经真实Pi接收完整拒绝回执、get_query读取当前版本后执行同一查询，不删恢复流程或放宽授权。静态载荷透传样本同步错误类型。

本轮追加修复的工程验证已完成：514条Rust/TypeScript同源契约、fmt/clippy/types/Web构建、18工具Schema、发送前体积守卫及锁序检查通过；澄清专项13组/9轮/33次本地协议请求、聊天执行专项12组完整exit0。独立审查亲自注入最终回执落账失败，确认授权、任务阶段、事件及归属整笔回滚；已确认unknown重复调用保留原身份/预算/尝试，不重新执行。证据分别为`.local/checks/reliability-analysis-update-goal-verification.json`、`execution-auto-route-evidence.json`、`execution-association-independent-review.json`及`execution-association-atomicity-review.json`，均0官方模型请求。新夹具的空库计数顺序和未消费结果回合造成的失败已保留并修正测试生命周期，原安全预期不变。

64KiB补测曾真实失败：新增重复说明令固定请求增加766B，Pi已识别overflow并完成原生摘要，但仅剩摘要和当前工具组时，含固定工具/规则/启动事实的请求仍达65634B。原失败和逐请求诊断为`.local/checks/reliability-followup-native-compaction-before.log`与`compaction-payload-trace.jsonl`。将执行归属详则保留在工具说明、授权原则保留在系统提示，删除重复goal描述，固定开销减少529B；没有改Schema约束、64KiB、用户输入、工具结果、压缩实现或次数限制。原完整fixture复跑通过：29次本地调用、15次Pi原生摘要、最大65185B，七条消息各保持原12次上限且账本全结算；不是摘要效率提升，也不保证任意固定输入都能放进64KiB。独立记录为`.local/checks/reliability-static-context-review.json`，日志为`.local/checks/reliability-followup-native-compaction.log`。后续代码/契约/载荷/锁序检查均在这次去重后完成。

当前真实验证已补齐：`.local/checks/reliability-flash-high-remaining/report.json`及`reliability-flash-high-contribution-continuation/report.json`保存相同当前源码、同一正常模式trial下的独立问题两轮、原趋势→贡献五轮和原B07普通歧义一轮。41次实际调用全部结算、302471微美元、预留0；8个真人消息scope最高7/24，结果唤醒共用原执行scope，累计调用/费用/到期上限实际均为NULL。新构建、声明及16条检查器测试通过；默认模型和27173常驻服务未变。汇总为`.local/checks/reliability-request-budget-verification.json`。

当前剩余：本次普通歧义题自主澄清且没有SQL；部分回答也未丢未决决定或新增授权。但复购首轮仍将可独立组合的分子/分母合为一题，次轮仅答分母便将旧复合ID标resolved再建分子题，不符合独立可答与完整回答才关闭的约定。原完整贡献链实际金额/比例和SQL输出一致，没有自行补算缺失环比；原生成SQL合计占比却固定100.0，零总增量与空数据的SQLite内存反例均错误。正式解释还混淆已计入快照的退款与未来快照变化，并无依据判断“不是单一渠道异常拉动”；普通答复仍暴露内部ID/版本。实际provider请求和工具回执已保存，不能归因于本次规则漏给、累计预算中止或结果未交付；也不据此声称已排除全部接入/模型因素。独立审读为`.local/checks/reliability-high-clarification-semantic-review.json`及`reliability-flash-high-remaining/trend-contribution-review.json`。增量保持active、整体审查changes_required、完成证据null。

验收包装器修正：原观察“部分回答后开放问题数减一”失败，实质是关闭复合题后另建未答分子题；原问题状态不准确仍作为缺陷，但数量不能证明丢条件。贡献第3轮自主保存未执行的环比补算稿，第4轮后有两份待执行稿，原“全会话唯一草稿、总查询数为2”的机械假设阻断第5条。产品允许额外调查及独立草稿；保留该失败，按第4轮与第3轮查询差集定位唯一新贡献稿，在原数据库、trial、会话和平台目录续发尚未发送的第5条，并等待精确query_id结果唤醒；原补算稿仍未执行。没有重跑前四轮或修改原SQL来取巧通过。生成SQL的零分母反例另存`contribution-boundary-probe.json`，0模型/0MySQL。

本次Pro对照授权（执行已完成）：用户明确允许DeepSeek Pro/high同题对照，使用已准备并审查的`.local/checks/run-reliability-pro-high-comparison.mjs`，仅含原独立澄清2句与趋势贡献5句。对照使用独立数据库和正常request账本，保留原输入、资料、工具及每消息24次/连续临时失败3次规则，不设测试累计调用/费用门槛，不改默认模型或常驻服务；这份明确授权替代此前等待Pro选择的状态。完整保存实际请求与失败，独立审读澄清、SQL边界和正式解释；不盲目重复抽样。原48次/0.50美元与128次/5美元建议已被用户更正取代；未提交推送。

Pro/high原两条流程7句已完成：累计35次实际调用、1177848微美元、预留0。主报告保留编译拒绝稿导致包装器误判“新草稿不唯一”的失败；沿原数据库、trial、会话和平台目录仅续发未发送第5句，以编译通过且待确认的新稿定位，未重抽样。两轮独立澄清本次保持独立ID、只关闭已回答分母，未回答问题原样开放；原趋势与贡献正式答复仍出现SQL/宿主统计未返回的差值、比例和单位换算，以及无依据的快照解释，不能据此宣布全部模型质量修复。原报告及续跑分别为`.local/checks/reliability-pro-high-comparison/report.json`和`reliability-pro-high-continuation/report.json`；完整独立审读为该目录的clarification-review.json（仅两轮样本通过）和trend-contribution-review.json（changes_required）；实际关键主请求均保留数字来源与依据限制，未发生结果删列。

新确认接入缺口与本次范围：Pro结果唤醒同一响应同时读取同一query的rows与statistics，前者成功扩展共享run的query_results，后者持有先前快照并被严格核验为stale_context；正常Worker收尾，非暂停测试伪象。实际回执和源码自冲突路径一致，日志未保存精确事务交错；本地真实Pi customTools受控边界回归已确定复现并发重叠。仅给宿主工具声明Pi1.3原生executionMode=sequential并修正“Pi可能并行”的说明，不加调度器、不改变assert_snapshot或操作/预算身份。基础建任务工具统一相同边界约定，不宣称在其路径复现同一错误。允许同一模型响应合批，工具耗时由并发最大值变求和；不新增模型轮次，不限制不同会话或后台查询。验收绑定REL-TOOL-SERIALIZATION/REL-RESULT-READING，原失败和真实语义缺口保持；付费同题对照已完成，本次修复只做本地工程验证。

新增顺序执行修复验证完成：旧定义下4项真实Pi SDK回归均失败，新定义下4项通过且独立重跑一致；同批rows/statistics、读写混批、基础任务写入、取消后不启动后续工具均覆盖。真实Rust/MySQL结果读取7项、上下文依赖5项、任务宿主来源6组、TypeScript、18工具实际Schema、请求体守卫、Pi兼容回归均完整exit0。原64KiB压缩专项仍为29次本地调用/15次原生摘要，最大65188B，撤权负例保持，0官方模型请求。限定审查为`.local/checks/reliability-tool-serialization-review.json`；完整分项日志和源码指纹由`.local/checks/reliability-sequential-verification.json`汇总。受控SDK执行接缝与真实Rust边界分别证明，不冒称完整MySQL并发重放；取消只保证未开始的后续工具不进入，不宣称当前HTTP立即停止或已提交业务回滚。

当前准确结论与下一步：已证实接入/事务修复的上述分项通过；Pro澄清仅本次两轮样本改善，数字来源、生成SQL零分母/空结果及解释忠实性仍是未关闭的真实质量问题。关键正式请求已经交付完整系统限制及实际结果，当前没有第二个可证实的小范围接入根因。不得把更贵模型、手工改个例SQL、删掉样例资料或增加提示文字当成已解决；应在具体可验证的回答来源方案下继续处理，涉及收紧自由回答输出方式时明确产品取舍。现有聊天正文不具备逐数字结构化校验，figures保护不能扩称整段回答保证；整体仍active/changes_required/evidence=null。`make verify-increment`本次exit2，因未有整体通过审查而未执行统一验收，日志`reliability-sequential-increment.log`保留。声明/16条检查器测试/369项资料检查通过；没有提交、推送或更新默认服务。

执行与澄清：分开真实版本冲突、等待澄清及非活动任务；提供已鉴权的状态/恢复回执，明确拒绝允许修正后续做，unknown保持原身份。独立目标分别建任务，同一目标内独立问题有各自ID；只解决实际已回答项。模型答复不能反向授予执行权。

依据与报告：核对原文支持范围、实际计算列与执行状态；不以重复提示文字代替行为验证。历史依据可显式读取并保存原task/condition_version快照，报告容器可组合同一本人会话的多来源；每份来源仍独立校验原条件、查询和依赖，任一来源失效整份隐藏。该能力补齐由本轮“全部修复”的授权覆盖，不删除原版本守卫。

知识与界面：手工创建/编辑显式业务域，所有对象和文档片段可维护；不继承关联域。资料选择器提供后页、去重、错误重试及异步回执隔离。另核实Z05阅读位置疑点。工程版本推进和脆弱提示短语断言同步修正，保留真实冲突负例与正式答复持久化验证。

验收与要求变更：历史依据原测试“旧来源不能保存到新容器”拆为“旧容器版本仍拒绝；显式原来源版本在权限/依赖有效时允许”；依据为组合报告的用户目标，原来源身份和失效政策不变。负责人同步fixture从固定2/3改为各来源实际版本+1/+2，仍验证同版本改内容冲突；最终答复测试取消无关措辞精确匹配，以原正式内容/刷新行为为准。澄清测试三处正确版本但等待问题从version_conflict改为waiting_clarification，重复解决从version_conflict改为clarification_not_open；拒绝行为保持，依据为实际状态而非模型措辞。原失败记录保留，新增工程检查与真实模型质量分别报告。

新增根因复核：get_query的query嵌套回执没有撤下工作区旧查询快照，现按真实结构更新并给明确状态释义。拒绝回执完整recovery透传至模型。历史读取混入当前问题，以及当前条件移除引用后旧问题正文失去校验，均已建立独立反例；已按问题创建条件版本和目标来源版本覆盖启动、读取、目录及工具成功/重放回执。新goal只在实际文本改变时重绑，legacy NULL来源保守核验全部旧依赖；重新调查后实际改写可建立精确来源。模型实际工具schema注释裁剪曾误删业务title字段，已修正并新增实际投影契约测试。

真实Flash/off首个有效定向样本仍自动采用歧义口径，失败证据`.local/checks/reliability-flash-samples/report.json`保留，不算修复通过。补充可选semantic_resolution作为向后兼容的口径决策：模型说明解释、依据和未决差异；宿主拒绝已声明未决或伪造本轮用户引用，并在任何旧稿失效前拒绝。此字段不授予执行权，旧调用可省略；真实引用不证明语义充分，仍需真实样本验证，不新增第二模型循环。

验收变更补记：原native-compaction协议fixture的trial_call_limit=24覆盖7条用户消息，原每消息request_call_limit=12；此前恰好24调用已用满，新增工具契约导致累计摘要请求耗尽，不能推断单消息违反产品24次。经独立审查，将仅此模拟试验累计上限改48，逐request新增issued_calls<=12、合计与provider调用/试验账本一致且预留0的断言。64KiB、完整工具、24轮初始历史、6轮续接、280条短历史和撤权负例不变；正式配置与原试用账本不变。实际调用/摘要增量如实报告，不声称原24次效率保持。

真实模型追查补记：`reliability-flash-semantic/report.json`确认双SQL直接分别授权提交、未定义公式留缺口、指定资料未找到保持范围，但歧义问题仍只文字提问而未登记；原失败保留。把持久澄清规则归拢到交付前核对后，`reliability-flash-clarification/report.json`的原问题→解释不采用→明确采用存稿三轮，以及独立目标/逆序仅答分母两个回合的控制行为均通过（20次、121185微美元、预留0）。逐句审读仍发现未调查即过度澄清、候选下单/付款含义漂移，以及从未定义状态关系推禁止性结论，不能把控制状态通过说成全部语义质量通过。`reliability-real-sample-audit.json`保存追加审读，后续仍按一般规则修复，不针对样例编答案。

贡献计算原五条消息复跑实际SQL已含总差额与贡献比例，执行结果为app 11000/52.38%、web 6000/28.57%、store 4000/19.05%，来源为合成平台实际查询。首个探针提前清理了尚未启动完成的结果唤醒，`reliability-flash-contribution/report.json`的passed标志只能说明前五次观察，不能证明最终解释完整；审读记录已明确降级为partial并计入未结算预留。探针需等待明确对应query_id的结果唤醒及dispatch结束，不扩充产品等待或预算。

新增兼容根因：HEAD依赖格式原已为4，新任务正文来源校验不能继续接纳旧4检查点；正在升为5并验证新消息重建、同一未完成输入安全拒绝，保持原操作和预算，不换身份重做unknown。Worker对该拒绝误记retry_exhausted也同步核对准确错误分类。

验收夹具修正：`check-request-context`保留原0/100/900/950四档，增加由旧估算公式及原61440提前压缩阈值推导的最大历史边界。新工具体积使原900档已被旧检查判超限，原固定档跳过低估窗口；新样本旧估算61429B、真实Pi请求69737B、新估算77451B，仍证明64KiB真实守卫在发送与预算前拒绝，网络/宿主调用0。未用新估算器或实际输出反写通过预期。

追加独立反例：`.local/checks/reliability-task-text-unattributed-source-before.json`证明当前正文保护还依赖模型填写condition refs，遗漏时知识和记忆内容可在撤权重建后的第二轮再次出现。用户输入不含来源标记，逐字用户目标是合法对照。修复采用既有schema5 authority格式，在任务目标/问题写入时由宿主自动绑定已观察完整依赖，覆盖知识/来源/记忆/Skill/查询结果；仅真人完整本条输入的逐字目标可免无关来源；旧无完整来源正文持续隐藏，原数据/状态/操作保留，实际合法改写可恢复。该修复正在实现，并同步覆盖condition_patch中notes/metric/filters等固定字段及报告带出的历史条件，不能换字段洗掉来源；独立审查已改changes_required，旧passed记录不能关闭本增量。

再次独立复核确认同一来源遗漏延伸到依据正文、报告标题、SQL说明/参数，以及builtin记忆与Skill草稿：资料先被宿主记录为已读，模型却可把正文保存到refs为空或只列另一有效资料的对象；原来源停用后，另轮/新会话再读取仍会回流。新反例为`.local/checks/reliability-{evidence-authority-finding,query-source,memory-source}-before.json`；第一份memory探针误用了不合法参数，修正探针后才实证，原失败保留。正在统一以私有持久来源字段保存宿主完整依赖，并分别覆盖读取、列表、重放、确认、派生和复制；查询失效只投影控制状态，取消/unknown查证保留。直接Skill选用与派生正文的来源Skill分开核验，后者不强迫接收会话再次选用原Skill；来源查询按本人及原结果身份鉴权，不能因跨会话复用放宽权限。schema5尚未发布到用户常驻服务，本轮统一完善并重新验收。

口径引用护栏补查：新增的semantic_resolution曾只验证user_quote是本轮用户文本的子串，可能把“不要按订单数计算”裁成“按订单数计算”。改为与宿主绑定的真实用户完整消息一致，保留否定、前提和例外；结果唤醒不属于真人选择。对应正例由短分句改为完整原话，新增短分句/否定截取/系统输入负例；旧无此可选字段的调用继续兼容，且完整引用仍不证明模型对语义的理解正确。

真实质量未关闭：六段提示合并后未定义正向规则的反例改善，但独立问题仍有过度澄清、复合候选/重复新题、未保存的额外提问及默认采用说法；完整贡献链29次Flash/off、178600微美元、预留0，已正确等待原query_id的结果唤醒，SQL差额与合计正确，但SQL缺占比、文字仍说“约一半”，趋势阶段仍自行补环比与合计。`.local/checks/reliability-flash-{grounding,independent-questions,contribution-complete}/report.json`保留这些真实失败，不能因工程回归或脚本流程passed而称语义修复完。已停止重复off抽样；后续一次Flash/high的24调用/0.50美元对照已获准并完成，结果及剩余缺口以上方最新记录为准，默认配置未改。

重新交叉审查补充：跨会话查询来源必须核对原会话空间/删除状态及其私有来源闭包；request_query外部编译和旧稿失效前先核完整来源；当前会话仍有效时，旧对象正文失效属于可收尾的明确拒绝，不能遗留prepared工具。当前HTTP任务快照同步隐藏失效目标，记忆控制事件只发送标识和状态；系统结果消息不能授权保存、修改或停用记忆。资产索引检查另发现删除/停用控制被正文校验阻断的回归，正在修复并验证索引清除，无新增付费调用。

根因总览见 [本轮独立复核](reviews/dogfood-root-causes-20261020.md)，逐项保留原发现、共用原因及真实模型未关闭项。统一构建、488条Rust/TypeScript同源契约、fmt/clippy/types/Web构建已通过；首次clippy暴露的新增超参通过具名写入身份和已核验来源结构收敛，没有关闭lint。

浏览器补证：查询正文失效后撤下SQL/参数/已载和迟到结果，停止失败可见并能重试，停止/刷新/窄屏通过；生成Skill失效后隐藏、可管理、空表单完整重写再启用/刷新通过，均为真实Rust与浏览器加合成平台、0官方模型请求。资产浏览器首两次失败来自驱动盲点：复用同一记录时details仍已展开，脚本再次点击反而折叠；已复用现有expandAsset检查实际状态，原失败日志保留，未放宽业务断言。

架构回查发现旧资产来源判别曾从assets/store直接JOIN runtime私有tool_calls，检查器正确拒绝；已改为personal_assets用例组合两个模块的公开接口，按精确资产版本只补NULL来源元数据，不改检查器或扩大表访问白名单。统一构建、架构检查与7条架构测试通过；资产7组、Skill3组、Mem0清理1组、查询8组、宿主任务6组、结果任务2组及任务正文9组专项均完整通过。资产新增“读v1再改v2不自依赖且保留上游”及删除后的同操作HTTP回执重放验证；真实模型质量仍单独保持未关闭。

重新审读真实失败轨迹又发现多题启动快照只交首题、却未标明还有未答题。新增二题续接断言在修前binary以has_more_clarifications缺失精确失败；现复用首题预览加省略标记，正式读取沿既有8题分页，更新回执同步注明首题不是全集，不增加问卷流程或自动关闭问题。最终新构建的实际Pi九题补读及剩余工程回归已完整通过；资料来源失效的context_complete标记仍由后续保护设置。NULL分组反例及残余语义证据限制见`.local/checks/reliability-semantic-root-audit.json`。

最终工程回归完成：`.local/checks/reliability-remaining-1792429638045055000/report.json`的17组命令全部exit0、无超时，运行前后范围指纹一致；覆盖澄清、聊天执行、报告UI、业务域、资料分页、正式答复、provider、Pi原生压缩、口径守卫、阅读位置、重启恢复、负责人同步/成员/目录、架构锁序、上下文依赖及完整库测试。正式隔离fixture入口`check-agent-library.mjs`的128项Rust测试全部通过；此前直接cargo test因缺DB/seed而失败的5项在此入口得到完整验证，原失败日志保留。488条同源契约、最终fmt/clippy/types/Web构建、18工具Schema及请求体发送前守卫通过；64KiB压力场景28次本地协议调用/14次Pi原生摘要，最大65373B，各请求预算不变，不声称摘要效率与早期夹具相同。以上工程回归0官方模型请求，不代表真实模型正确率。

[公开交叉审查](reviews/dogfood-reliability-review.json)逐项列非实施审查者及运行证据，工程分项通过、整体仍为changes_required；真实模型的ISS-01/02/10/12及其因果区分保留未关闭。后续Flash/high对照已在获准的24次上限停止，实际请求和有序工具参数已保留。旧off运行缺完整请求、新high也只有有限样本，不能声称残余失败唯一来自模型能力或思考档位。

最终声明与材料检查在追加修复后通过（369项材料检查、16条声明检查器测试）；最新`make verify-increment`仍实际返回“缺少已通过的审查记录”，因为整体审查待真实语义闭环，没有把分项工程通过改写成整体passed。最新门禁日志为`.local/checks/reliability-followup-increment.log`，此前日志保留，增量active、review pending、正式完成证据null。

已证实工程根因修复及工程回归完成，真实语义验收尚未完成；没有提交推送、服务更新或整体通过结论。已证实根因入口为`.local/dogfood-runs/flash-r1/INDEPENDENT_TRIAGE.md`，其“只读/待讨论”描述是此前时点，以上方最新决定为准。

## 历史复核：flash-r1发现及修复必要性（2026-10-19）

用户本轮要求确认试用发现、区分哪些需要修复，尚未启动修复增量。复核报告、相关原始工具轨迹、持久状态、源码与设计；独立重算160项为138 pass/14 fail/5 partial/1环境阻塞/2授权阻塞，未重跑全套或把计数当模型准确率。结论与证据入口为`.local/dogfood-runs/flash-r1/INDEPENDENT_TRIAGE.md`，不改原results/attempts或失败状态。

优先修执行回执真实性（ISS-06）、明确拒绝后的恢复及错误分类（ISS-03/04/07）、多目标与澄清归属（ISS-02）；口径/未定义规则/SQL计算忠实性（ISS-01/10/12）、指定资料定位与手工对象显式业务域闭环（ISS-11）、KnowledgePicker后页入口（E11）也保留在修复清单。Z02所传版本正确，实际waiting_clarification被统一报version_conflict；Z16目标没有自身业务域，按当前显式域规则被过滤，不能据此判精确名称排序有错。原始轨迹还更正R13的get_query发生轮次与Z02拒绝次数。

ISS-08/09是合理组合报告需求与现有单任务/当前条件契约的能力差距，守卫拒绝正确；推荐显式保留每组task/条件/查询身份的多来源报告，需另定契约和来源失效政策，不能删版本/权限检查。ISS-05属于工程夹具版本及提示短语断言漂移，需修测试再补行为证据。Pro/向量阻塞、Z09缺图分支、依赖改版后旧报告隐藏不直接算代码缺陷。本轮未修改产品或测试、未新增付费请求、未提交推送、未操作服务，仅保存复核记录与本入口。

## 当前执行：flash-r1 全功能 Dogfood（已完成本轮执行与结论收尾，保留缺陷）

用户再次要求继续试用，本轮按原授权持续补测并完成结论收尾。最终账本为138 pass、14 fail、5 partial、1 blocked_environment、2 blocked_authorization、0 not_run、0 inconclusive；以`.local/dogfood-runs/flash-r1/results.json`为准。Z08/Z10、原四项待定、登录重登、记忆跨会话召回、字段/指标/关联结构、旧建议同ID修订保存、running状态刷新恢复、窄屏与迟到回执等已实测补齐；六组浏览器及索引并发/千表混合检索共八组原专项完整exit0。报告为本轮`REPORT.md`，覆盖矩阵`COVERAGE.md`，逐项审计`evidence/final-ledger-audit.json`；43主题均有证据不等于所有子分支通过。

问题记录已核对实际工具参数与源码：ISS-08实际为跨任务依据组合被报告守卫拒绝；ISS-09实际为条件版本1/2结果被合并保存，不能归因为未读rows视图；更正页为`issues/ISS-08-AUDIT.md`及`ISS-09-AUDIT.md`。Z01不完整双图报告由pass更正fail。新增ISS-10（长文补写未定义分子，Z12整体fail）、ISS-11（原句读错指定文档，明确ID变体防护另计）、ISS-12（贡献SQL未算比例而回复补算）；B35完整前置链重跑发现比例仍缺，保留失败不反复试到通过。

恢复会话的操作失误已记录：case-z13-retry 保存案例时空结构表单覆盖丢失版本4结构条目，Z13R2 模型按正文+DDL 重写不受影响，C20 已重建结构（版本5）。前序误停原 27173 服务的恢复证据保持 `evidence/live-restoration.json`；本轮未再触碰原服务，五健康入口 200。

E19原千表专项完整通过（1593.19秒；1204表/2408对象，首次索引561.45秒、两次丢collection重建；各阶段900秒不变），与当前同轮双空间scope专项分开支撑工程pass；协议hash向量、真实MySQL/Milvus，不是千表真实中文模型质量。五个partial具体为B18非off/Pro发送未授权、E11同一多选选择器跨页保留缺直接证据且控件无续页入口、E12/R18原工程夹具/提示短语漂移本轮不改测试、Z09原报告无图分支。A05当前UI词法环境vector_unconfigured仍blocked；R20/Z15真实Pro未授权仍blocked。没有产品/测试代码修复、Git提交或推送。

收尾补证：Z13已恢复marker参数结构与当前依赖后完整跑原五消息，原39行执行因message_pending未恢复，过滤38行及私人报告成功；报告如实记原案无数值，Carol读取Bob报告404，案例改版后report.status=sources_unavailable且旧正文清空。执行回执另存`evidence/final-execution-recovery-traces.json`。运行快照2026-10-19T11:15Z：六健康200、合成源SHA一致、active_run=0、unknown/unsettled模型调用=0、预留0、原请求最大21/24且无超限；本轮隔离trial累计约7.0048美元（不含原27173或历史库），权限恢复、原unknown不清理重放。`make verify-delivery`声明及16条检查器测试通过，未运行null业务命令，delivery保持active/review pending，不能把评测已收尾等同业务通过。

独立只读审查`evidence/independent-review.json`指出Z12、C20、E11、Z10四处过度判分：Z12整体改fail，E11改partial；C20同一案例取消后回读不变已补，Z10同一副本selected1/current2过期提示与重新选用、撤回平台权后真实forbidden已补，均保留具体直接证据。只读审查不冒称不可篡改验收；本轮失败不会靠改预期或移除用例变通过。后续应另立修复增量优先处理执行回执真实性、多任务归属、拒绝后恢复与跨任务/版本报告。

独立复核已确认上述四项处理及最终160项计数一致，无仍需纠正的具体发现；复核范围不包含重新审查E19或全部160项，记录已保存。本轮执行与报告已收尾，服务保留供继续试用；业务delivery保持active表示失败/缺口未修复，不表示仍有试用脚本在后台运行。


## 已完成资料准备：新版全功能Dogfood包（2026-10-19）

用户要求制作新试用包交给其他Coding Agent，覆盖全部现有功能、Agent能力及复杂问题。本轮是资料准备，不是开发评测系统或执行评测；未修改产品、启动/停止既有服务、发起真实模型调用或提交推送。开工分支`codex/analysis-capabilities`、代码基线`c9d0ced`，工作区干净。

资料入口为[新版试用包](dogfood/2026-10-19/README.md)及[可复制执行Prompt](dogfood/2026-10-19/AGENT_PROMPT.md)。共160项：旧120项、R01–R24定向回归、Z01–Z16复杂连续任务；43个覆盖主题见coverage。原120项冻结副本及SHA保留，只将DF1014命名前缀规范为run_prefix，原操作/SQL/日期/数值/expect逐字段核对不变。新增场景补充长结果分页/统计/单元格和依赖、开放澄清、相关性前三/候选上限、预填补读、最终答复、SDK1.3旧检查点/思考隔离/参数完整性、24/3及混合任务恢复。

包内提供START、环境/角色与隔离说明、逐项JSON/Markdown、独立评分和18条参考SQL、合成输入fixture、160项全not_run结果模板、问题与HANDOFF模板；HTML可筛选、按run记笔记和导出。当前执行状态只在本记录；包内manifest是资料版本，模板不是已执行成绩。使用build.py按ID/分组读本批可降低其他Agent上下文，不必一次加载全书。

准备证据：[资料校验](dogfood/2026-10-19/PREPARATION.md)。160唯一ID和43覆盖主题、依赖/脚本路径、原120项保留、6源指纹、18独立内存SQL及生成物一致性均通过；Playwright1440/390、筛选、命名笔记重开和160项导出通过，已查看两张截图，最终控制台0错误/警告。原始日志、截图、导出和无秘密本机环境引用保留`.local/dogfood-package-20261019/`，总核对记录为该目录`verification.json`；传递包为`DataAgent-Dogfood-20261019.zip`。ZIP只装材料和合成源，不含凭据、有效配置正文、原对话或业务数据库。

本机快照仍为`http://127.0.0.1:27173/`、Flash/off、Mem0、词法；五个健康端点只读核对200。只有Alice/Bob启动证据，不能预设Carol角色/归属、Pro费用、混合向量、千表或第二空间已经准备。完整维护/角色/故障试用转本轮获准的隔离环境，保留当前用户服务。执行Prompt明确已有正常请求规则、权限和有限trial区别；文件本身不授权当前Agent花费，只有用户在执行会话明确采用后才按其范围执行。

历史缺口B14第二查询、C19原39行执行、C22补录回读分别由R06/R07/R08加强，原案例不改写；M18旧unknown不重做。真实模型文字一致性、当前SDK实际语言质量和未接入能力仍未证明。下一动作由用户将执行Prompt交给其他Agent，先代表样本再按依赖分批；逐项保留pass/fail/partial/blocked/inconclusive/not_run，真实模型与工程证据分开。交付增量planned表示试用待执行，不表示本轮资料还没做好；null命令尚不具备自动业务关闭条件。

## 历史交付：提交推送与本地真实试用恢复（2026-10-19）

用户本轮明确授权提交、推送和更新本地服务，替代此前实施阶段“不提交推送或重启”的范围限制；没有需要先讨论才能修复的阻塞项。沿用分支`codex/analysis-capabilities`。`0958b69`提交Dogfood范围/口径/单位、执行反馈和输入框修复及文档，`8b8f01a`提交Pi稳定1.3.0及配套兼容，两批均已推送`origin`。本轮不修改上述产品代码。

实现证据保留：SDK的14组全部退出0、无超时、前后输入一致，收据`.local/delivery/I2-PI-SDK-UPGRADE-result.json`绑定`8b8f01a`中的冻结CURRENT；该完整记录另存`.local/local-dogfood-delivery-20261019/sdk-complete-CURRENT.md`。新交付元数据不冒称旧收据仍绑定修改后的CURRENT。Dogfood原6组收据及真实定向证据保持。新运行检查只证明本次本地就绪与SDK兼容。

本地更新：项目专用Colima实例、MySQL/Milvus及原卷恢复健康，`make build verify-startup`完整退出0，10项启动器单测、默认工作台启动、正式SDK本机协议聊天/初次再次预填与人工保护通过。恢复的是最近其他Agent已使用的真实Flash/off、Mem0、词法检索环境，沿用原profile、数据库、身份、runtime、合成分析资料和端口；工作台为`http://127.0.0.1:27173/`，与默认模拟工作台端口5173区分。登录沿原试用环境的Alice/Bob，凭据只保存在其忽略目录。

首次恢复漏带`DATA_AGENT_SYNTHETIC_SOURCE_DIRECTORY`，平台按原规则拒绝来源冲突；不是业务库损坏。独立只读核对确认原manifest、冻结来源、实际业务库和平台版本均匹配`docs/sources/analysis`，仅补回这个既有环境配置后启动成功，没有重建业务库或改写查询账本。第一次失败日志及核对记录均保留。Web/API/Pi/平台/Mem0五个实际端点均HTTP200，Worker持续运行，原两个账号检查通过；profile、身份与原Mem0配置内容SHA不变。记录为`.local/local-dogfood-delivery-20261019/local-services.json`及同目录日志，均不进入Git。

本次就绪检查未自动发送新的真实模型问题。用户后续手工dogfood沿原正常请求账本，保持每消息24次及连续临时失败3次停止；没有通过重启增加旧额度或重做unknown。尚缺B14第二条查询、C19原39行案例执行、C22补录后回读，以及模型文字一致性和新版真实模型质量；这些是后续试用覆盖/质量缺口，不因本地就绪被标为通过。真实Datasight、生产身份和容量仍未接入验证。

## 历史增量：Pi SDK稳定版升级（2026-10-19）

用户要求核对版本，采用较高稳定版并保持现有能力。开工仍在`codex/analysis-capabilities`、HEAD `5fe5260`，上一Dogfood修复已完整验收但未提交，本轮保留其全部改动。沿用dev_co与本记录，提交推送、常驻服务重启和新增付费执行不在本轮范围。

官方npm registry核对三个直接包`pi-ai`、`pi-agent-core`、`pi-coding-agent`均从当前1.0.0到稳定latest 1.3.0（2026-10-15），Node要求>=22.19.0与本机兼容。官方包完整性已校验，发布说明与升级前依赖快照保留本机`.local/pi-sdk-upgrade-20261019/`。选择三个包同版精确锁定，核对间接Pi依赖同版；不启用额外工具或默认资源发现。

预期采用的原生改进：损坏的完整工具参数不再执行部分解析结果；切换模型丢弃其他模型的思考块且保留正文/工具；摘要不再包含思考块以降低不必要上下文。先用旧版固定反例，旧SDK生成的合成检查点验证升级恢复，再执行上方绑定回归。1.2启动事件联合类型变化、忙状态及取消语义和1.3工具恢复变化逐项核对本项目实际接入，不照搬CLI新功能。

兼容性配套：类型与桥接检查实测发现Checkpoint Schema将sdk_version写死1.0.0，会拒绝新检查点；同源契约明确接受旧1.0.0和新1.3.0，继续拒绝未知版本，重新生成两端类型并保留原负例。

实现已完成：三个直接包与间接Pi包统一1.3.0，完整npm ci成功，其他直接依赖不变。新检查点从公开VERSION取得版本并核对受支持版本；运行/协议/真实试用脚本的新报告使用实际SDK版本，不改写旧报告。原生压缩仍无公开canCompact，原有薄接入和唯一Pi循环保持；无需新增Agent框架。

对照证据：本机`before/`保存升级前依赖/代码与CURRENT，`sdk-before.json`为修正测试装配后的旧版反例（同版/旧检查点通过，三项上游修复行为失败），`sdk-after.json`五项全部通过。`tests/runtime/fixtures/pi-session-1.0.0.json`由实际旧SDK生成，续接保留原session/leaf/tool身份、摘要、草稿未执行和宿主未确认分支；不是拿新版本输出反写预期。首轮检查发现版本Schema拒绝后才配套更新契约，原失败日志保留。

专项证据：448条同源契约及构建/类型/格式/Clippy/架构通过，桥接40轮10摘要、627748B日志恢复通过；原64KiB压力24调用/10摘要/最大65337B，与升级前完整载荷序列相同。C4和图册已从来源重建，29图/12模块、无页面错误和手机溢出；版本从package.json生成，源码与图来源检查随后纳入统一验收。最终14组与独立审查以当前delivery.increment及实际收据为准，专项不代替统一验收。

验收与要求变更：仅Checkpoint版本契约由只接受1.0.0扩为明确接受1.0.0/1.3.0，新版本正例及未验证1.2.0负例新增，原445例和2.0.0负例保持。没有放宽业务预期、24次/连续临时失败3次、128KiB常规或原64KiB压力。1.2的before_agent_start联合类型变更不触及宿主context扩展；已有sendCustomMessage的triggerTurn路径仍须由最终provider/会话回归验证，取消由SDK沿用，不另造处理层。

文档门禁修正：旧check-implementation.py要求总设计中所有说明图都有编号，且只认V01–V03的28图；HEAD 5fe5260已含无编号的第13节说明图与正式V04，独立来源证据保留diagram-check-baseline.json。检查器与原渲染器三个来源对齐，预期集合保留原28图并增加原已存在V04为29图；四份文档的链接/空白检查、12模块覆盖、图来源指纹与依赖无环检查仍保持。图册说明同步，不删除图或放宽产品验收。

验收声明修正：第一次verify-increment在执行任何验收前拒绝PI-DOCS，原因是项目检查器明确禁止将图册/材料检查作为业务完成验收。原15组中只将PI-DOCS移出业务收据，改为已实际执行并经独立复核的文档专项；14组工程与Agent行为命令、超时和全部断言保持。依据为scripts/check_delivery.py现有MATERIAL_COMMANDS规则，不改检查器或包装绕过；图册仍须实际检查通过，不能用它替代SDK业务行为证据。

恢复回归定位：首次统一执行的前四组通过，会话组按原断言失败（期望接回原update后request_query，实际重新search/update）。在本机隔离baseline-replay用原package-lock完整安装1.0.0、恢复升级前checkpoint/deliver/契约并运行同一未改测试，复现完全相同失败；不是已证实的1.3.0回归。诊断轨迹显示合成模型将Pi投影为user的“个人记忆参考”当作输入。修复仅限既有固定合成模型：以宿主run.text定位本轮真实输入与其后工具组，摘要移走原文时沿保留工具组继续；不新增真实模型规划规则、关键词授权或修改原会话断言。原失败收据与前版/诊断日志留在本机SDK审计目录（unified-first-runtime.json、session-before.log、session-before-diagnostic.log）。修复后1.0.0和1.3.0运行同一未改check-session.mjs均完整退出0，原两组断言保持（session-comparison.json）；类型通过，完整14组须重新执行并重新核对独立审查。

模型切换验收调整：第二次统一执行前5组通过，第6组旧断言要求跨Flash/Pro请求的assistant正文包含Synthetic reasoning；1.3.0按官方#10995修复会丢弃其他模型的思考块，与本轮已明确采用的优势一致。原值为断言旧思考转正文存在，新值为新请求中不出现旧思考，且新增公开回答、原工具调用/回执与持久原生思考历史仍保留的断言。独立依据为官方1.3.0变更说明及同一新旧SDK行为对照，不以当前输出反写业务答案；同模型工具续调reasoning_content、7档HTTP参数、会话身份、权限和预算断言保持。原失败收据/日志另存unified-second-runtime.json/.log；调整后模型选择6组、36次本机协议完整通过，公开回答/工具、原生历史、7档、浏览器及恢复均保持（model-selection-final.log、model-selection-after.json）。其余上下文/依赖、真实bridge取消和后台浏览器专项也通过；独立审查后仍须完整14组，不拼接单项结果关闭增量。

限制与交付：不新增付费调用，不把新版协议成功说成真实DeepSeek质量验证。原B14/C19/C22/M18和文字一致性缺口继续保留；未重启用户主服务，也未提交推送。依赖回退快照仅供诊断，任何回退须与旧API/Worker及契约配套，不能只改版本字符串或重写已有1.3.0检查点。

## 历史增量：Dogfood证据审计与修复（2026-10-19）

基线`5fe5260`，分支`codex/analysis-capabilities`，开工工作树干净。用户要求本地及最高档oracle-web核对后修复并同步文档；提交、推送与用户常驻服务升级不在本轮新授权中。沿用此前获准Flash做少量定向试用，同一trial与数据库不重置。

裁决与实现见[试用交叉审计](reviews/dogfood-20261019.md)：B24是用户调查范围被扩大，权限过滤本身没有失效证据；B07以唯一命名指标替用户选择分母；B10是单位/精度歧义和输出不符，70元不等于金额算错100倍；B20从原Pi轨迹确认漏引粘贴SQL；B22复现43.19px位移并定位为输入框下方同步提示在API恢复后消失。

- 系统与工具指引统一用户范围、实际`search_scope`及每次`business_domain`参数；未限定的定位过滤仍可自主调整，用户同意后可扩大。模糊别名或唯一命名不是用户采用，已有明确口径直接沿用；金额单位与精度分开，本次明确条件优先。
- Rust完整消息/版本/权限/幂等/预算校验保持。执行`invalid_evidence`回执给出专用修正指引；只修已明确拒绝的漏引原话，先核对同一草稿状态，以新工具身份修正。旧调用参数不可改，已提交接回状态、unknown沿原身份查证。Node不自动代填引用或重发。
- Workbench临时反馈进入对话滚动区；同步失败/恢复、发送失败及查询完成的4组位置采样均852.421875→852.421875，草稿、焦点、历史位置、通知与单查询身份保留。原<3px断言未放宽。

证据：本机`.local/dogfood-audit-20261019/`保存旧码位移反例、首版提示失败、原/新工具轨迹、完整检查日志与Oracle证据；公开审计不含凭据/原始对话。Oracle实际`Power, item 5 of 5 (slider ARIA)`、提交及回答均核对，所拥有Chrome PID已退出、临时Profile已清理。建议按本地来源/轨迹交叉验证，没有把外部意见当作实现验收。

专项通过：后台浏览器7组、对话授权9组（含实际Node工具收到新提示）、检索范围11组、provider本机协议16调用、原64KiB压力24调用/10摘要/最大65337B，445条契约及构建/静态/架构通过。提示首版导致原压力夹具预算耗尽，精简等价重复表述后通过；失败日志保留，没有提高调用/载荷上限。最终6组统一验收完整通过，原审查通过；历史收据为本机`.local/delivery/I2-DOGFOOD-REPAIRS-result.json`，对应升级前冻结输入，不替代后续SDK验收。

Flash定向证据：原B24三次检索保留航空域，随后用户明确允许的检索只用合成零售域；B07先保存澄清而不生成默认SQL，自由回答后沿原任务修订，未执行；B10原句按分生成，授权后实际7000分，元显示变体保持未执行且不改长期偏好；B20粘贴变体完整引用原话，平台仅一次提交，三渠道51000/39000/23000分。B20变体不含旧三轮前史，且该样本没有触发新hint，不能作为真实模型同轮错误自修证明。新增52次结算约0.32美元；原4条unknown身份/预留保持，无新增unknown，无在途运行。

E19同规模、同断言的诊断副本完整退出0，首次建索引及两次丢库重建和其余8组通过；首次745.45秒，后续两段各自仍在900秒内。旧驱动在整条命令900.11秒强杀，未留下阶段日志，原结果仍保留为未完成；没有改检索排序、扩大阶段超时或缩小表数。当前证明协议索引/恢复，不能代表千表真实模型语义质量或生产低延迟。

覆盖与质量缺口：B14双查询第二项、C19原39行案例执行、C22补录后回读仍未补齐；M18原unknown不重做。真实元显示变体SQL正确，但文字一处把`is_test=0`误称测试订单，作为模型文字一致性缺口保留，不能计整段业务解释通过。单个样本成功不代表稳定遵循率；本轮不增加模型复核层或关键词补丁。

文档同步：README更新最新证据入口及分析成果能力；开发指南补复测、原账本与长专项规则；系统设计与模块契约明确范围/歧义/单位/执行修正和反馈布局，修正旧文档“普通修订关闭问题”的过期描述。本机120项手册沿原HTML版式更新环境/角色核对说明，原案例/独立答案/本地记录键保持；1440/390宽度、120项筛选及无横向溢出通过，STE零警告。历史手册验证收据不改写。

验收与要求变更：没有修改业务预期或独立答案；B22保留<3px，增加同步失败/恢复及发送失败反例；B20保留`invalid_evidence`码和拒绝边界，增验提示、Node实际回执、原身份异参冲突与新调用正常授权。E19诊断只增加进度记录，原900秒阶段上限保持。上述未覆盖项不因本轮完成而被宣称全部完成。

## 历史增量：Agent效果边界修复（2026-10-18）

用户在最高档Oracle与本地交叉审计后授权四项一起修复。基线b62d8ef，开工工作树干净。范围与验收见上方I2-AGENT-EFFECTIVENESS；审计事实区分源码/契约/离线反例与未验证的真实模型效果。已有前三名排序、上下文分离、Pi压缩恢复及24次/连续失败3次政策保持。

实现与边界：

- M06普通修订保留未答问题，revise/clarify仅用真实resolved_clarification_ids解决指定项。任务目录仍给最早问题；read_analysis_task按8条分页公开全部未决问题ID，update回执给opened_clarification。当前版本、同任务/会话、开放状态、失败回滚及原幂等保护保留。
- M07在原已授权保存结果上提供按字节行页、独立统计及绝对行列单元格读取；超长内容按原JSON和Unicode位置续读。每个results投影不超过23KiB，原HTTP/证据路径和512KiB平台页上限保持。校验平台绝对起点、后页连续性及完整标记。所有新视图和JSON片段登记到原context_authority依赖并集，结果失效后旧正文/压缩摘要不能继续外发。
- M04先去重，24项以内全保留，超过时按含首尾的均匀位置取24项；M02/M04共用同一选择，完整问句仍参与评分。query_terms_complete=false明确bounded；不承诺任意长句全部词召回，不扩大1000候选上限。
- M03在现有分析与复核之间同版补读连续后续范围，同时保留草稿引文上下文。每阶段正文总预算仍24576字节，非相邻片段不拼接。visible与seen分别表达本轮/累计覆盖；最终逐字引文校验使用review_input并持久保存。默认大目录的外发草稿重复引文作无损索引化，完整原稿保持；未加第三次模型调用。

验证证据：旧澄清正式入口仅改日期即关闭问题的反例已红（`.local/checks/clarification-before-fix.log`）；检索首中尾反例在旧binary尾词漏召回（`.local/copilot-review/retrieval-candidates-red.json`）。当前澄清10组含同会话重启续答/反序答题/9题分页通过（`.local/checks/clarification.json`），检索8组含独立索引召回/完整问句评分/原前三与1200候选边界通过（`.local/checks/retrieval-ranking.json`）。结果读取初次集成将152053B平台页分为15行页，超长Unicode/转义JSON重组、NULL和用户隔离通过；最大完整工具回执20221B，SQL/result_ref/原提交次数不变（`.local/checks/query-result-reading.json`）。最终7组结果验收完整通过：首次统计/单元格/片段分别登记run与Pi检查点依赖，有效时许可预留成功，结果过期后同run下一许可返回stale_context且不新增预留；最终同名JSON及`query-result-reading-authority-green.log`取代早期五组。

预填14单测与11组正式入口通过（`.local/checks/prefill-unit-run.log`、`mvp-prefill-materials.json`）：固定两次调用读取新尾部、保留首部引文、未同时可见中段仍为incomplete；最终新引用和review_input持久保存、人工值保护保持。默认目录第二阶段实际54555B；相同请求展开重复草稿引文为68100B，原payload_limit失败保留在`prefill-materials-before-dedup.log`。同源原生工具Schema缺少三个传递定义的既有问题通过HEAD核实并在本次补齐；不是用mock跳过Schema校验。

验收与要求变更：原“revise自动结束旧问题”违反C03，回答调用改为显式真实问题ID；独立审查发现只给首个问题ID妨碍回答后问，已补公开分页，测试不从SQL偷取调用ID。预填旧测试按全局请求序号误比较不同对象，改为同target匹配两阶段；改版后旧run预期读取新知识违反已有C02/C05，现先精确断言stale_context，再取消旧run并以有效新run读取。问题仍需开放、版本冲突、人工值和隔离断言未放宽。

独立审查另发现新结果投影需要核对平台游标，已复用saved_result_next_cursor并补错误起点/断页/假完整反例；主代理追踪压缩恢复时发现新视图缺少rows导致结果依赖漏登记，已在原context_authority补符合契约的新视图识别，保留“未读取的依据目录不能新增结果依赖”断言。授权边界是同一结果读取目标的一部分，允许范围增加该组合层文件，不改业务权限规则。

新增参数和说明使原64KiB压力多一次以上摘要并耗尽24次trial，失败记录保留在`.local/checks/effectiveness-compaction-first.log`、`effectiveness-compaction-trimmed.log`、`effectiveness-compaction-trimmed2.log`。只精简工具说明/参数描述中与系统规则重复部分；执行授权、完整答案、个人资产和报告边界保持。原压力最终通过24调用/10摘要、最大65209B（`effectiveness-compaction-final.log`），原64KiB、24总trial、12次单请求、24轮历史和近16KB工作区均未放宽。预填同样通过无损引文去重保留64KiB门槛。

全库单测首次直接cargo运行有112项通过、5项因缺少显式隔离MySQL/已完成运行夹具而失败（`effectiveness-all-unit.log`）；验收命令改为复用原harness与builtin Pi生成已完成种子运行的`check-agent-library.mjs`，再执行原全部cargo --lib测试，不跳过任何测试或改变预期。修正后117项全部通过（`effectiveness-all-unit-isolated.log`）；445项同源契约、静态/构建、架构锁检查、原结果统计及provider16次本机调用也通过。结果过期检查沿既有合成profile/capture模式只预留许可，无send及外部模型请求，避免将默认mock的空profile当成有效provider许可。

独立审查记录：`docs/reviews/agent-effectiveness-review.json`。实现者交叉核对非本人部分，发现闭环和指纹由记录列明。最终九组完整验收以`.local/delivery/I2-AGENT-EFFECTIVENESS-result.json`为准；增量status仅在当前指纹全部通过后置complete，不能拼接早期专项结果代替。仅本机Pi/平台/模型协议替身和合成资料，真实/付费模型调用0；未证明真实模型遵循率或任意大库质量。本轮未提交推送或更新常驻本地服务。

## 最近完成增量：检索优先级与最终回答（2026-10-18）

用户授权先独立核实 Copilot 的三项建议，再优化。基线为 `a53d859`，开工工作区干净。本轮只改变已证实的排序补位与最终回复规范，验证候选上限现有保护；不启动新的模型质量评测或付费请求。

已确认：`rank_hybrid` 原先仅保留首名，再优先覆盖类型；组合层还会为最多两个关联对象截掉尾部。改为保留融合前三，类型和关联共用剩余位置。`deliver` 的最后助手消息与 Web 提交替换语义属既有正式输出契约；完整正文若位于保存工具之前，后面只有“已保存”确实会丢失。保留正式输出契约，明确工具调用完成后最后回复须自成完整答案；仅凭本地协议不能宣称真实模型必然遵守。

第三项部分已有保护：M02 当前候选先名称匹配、后正文匹配，两组内部为ID序；M04索引候选仍为ID序。超过1000项会返回 `candidate_limit`，工具解释覆盖不足且空结果不证明不存在。保留有限回源与明确覆盖状态，增加1200对象反例，不冒称全量相关性排序或任意大库召回完成。

专项证据：旧源码新增排序单测失败于limit=6，日志`.local/checks/retrieval-ranking-before-unit.log`；旧API首次工具回执前三为一个强字段和两个弱类型，日志`retrieval-ranking-before-api-fixed.log`。测试初稿误向HTTP固定30条检索传limit=3而返回400，已按工具契约改为通过真实search_knowledge控制limit，预期来自独立三字段夹具，不从旧输出推导答案。修复后25项M04单测通过；冻结前保留原去重语义并补重复候选不占前三位置的断言，随统一验收再测；前三/limit4/稀疏补满/1200项未索引名称召回专项通过，后补宽查询覆盖反例待统一验收。

最终回复专项已完成12次本机协议调用，真实工具保存、数据库正式文本、工作台刷新和同Pi会话续接通过；显式保留不遵循提示时短确认仍覆盖前文的反例，没有宣称这类输出已被程序强制修复。日志`.local/checks/final-answer-first.log`形成于最后一轮规则压缩之前，最终以冻结统一收据为准。

原64KiB压力专项发现新增规则引发更多压缩，共24次调用中11次摘要，旧夹具总trial预算耗尽；日志`.local/checks/retrieval-delivery-compaction.log`和`retrieval-delivery-compaction-before-trim.json`保留。未改原64KiB、24次总trial/12次单请求、24轮历史、近16KB合法工作区或续接场景。将新的最终回复规则与已有表达原则合并、去掉重复的SQL展示说明（原查询卡片/执行规则仍在），当前资源较基线仅多10字节；原边界专项完整通过，24调用/10摘要、最大65478字节，日志`.local/checks/retrieval-delivery-compaction-trimmed.log`。不将仅剩58字节余量的合成样本外推为任意长任务均能完成。

首轮统一验收第1–3组通过，第4组在已有范围测试停用已读leftDoc后同run继续search时返回409/stale_context，未将部分通过当成完成。旧收据/审查归档为`.local/checks/retrieval-delivery-before-scope-fix.json`与`retrieval-delivery-review-before-scope-fix.json`，命令日志见旧收据。第3组宽查询确实未召回位于上限之外的高分对象，但工具明确candidate_limit；具体名称经正式正文通道召回，既有候选上限不是全库排名保证。

验收与要求变更：范围测试原在同run读到leftDoc、正式停用后仍要求search返回200且过滤该对象；按既有C02/C05、`context_authority::observe/extend_run_in_tx/assert_run_in_tx`以及前面的实际回执，旧上下文应失效。新断言精确验证旧run的409/stale_context，再经原withdraw与新轮入口核对停用过滤、跨空间锚点404及个人隔离；原成功/拒绝场景均保留，未改产品guard或放宽权限。此为测试流程修正，不因这次失败自动宣称旧版本也已实跑复现。 独立审查逐字核对context_authority、data_tools和knowledge/store与`a53d859`一致；修后专项11组完整通过，最大工具JSON23603B，日志`.local/checks/retrieval-delivery-scope-fixed.log`。最终仍须完整9组冻结复验。

可观察验收与范围见 frontmatter。原有类型排序单测在limit=6时要求第3名让位给第7类型，本轮按用户授权的相关性优先改为保留前三；精确命中、向量版本及同分规则不变。旧请求策略/上下文增量及其冻结证据保持历史完成事实；真实模型遵循率留作明确未验证项。

完成证据：北京时间2026-10-18 01:20:21–01:23:03，第二轮`make verify-increment`的9组全部exit0、无超时；60份验收输入及审查记录前后指纹一致。收据为`.local/delivery/I2-RETRIEVAL-DELIVERY-result.json`，完整日志目录`.local/delivery/I2-RETRIEVAL-DELIVERY-1792257621482255000/`。包含436条跨语言契约、25项检索单测、5项新排序/1200候选检查、11项范围隔离、覆盖与命中片段、12次本机协议的正式回答/浏览器刷新/同Pi会话续接、原provider及64KiB压力回归。范围回执本轮最大23600B；压缩场景24调用/10摘要、最大65478B，原预算与断言未放宽。以上专项和首轮记录中的待复验状态由本次完整收据取代。冻结审查记录保存复验前状态，最终结果以该收据为准；独立审查者已在执行后只读核对九份日志及当前指纹，确认可以关闭声明增量。交付声明16项单测与准备材料353项静态核对通过。

本轮仅使用合成数据、本机协议和浏览器，官方/付费模型请求0。排序优先级已程序修复；末条完整回答规则属于提示预防，模型不遵循时仍可能只保存短确认；1200对象验证名称优先及覆盖不足表达，不证明全库召回或真实模型质量。实现与验证已完成，下面记录实际交付结果。

交付结果：检索修复`7d6df05`与最终回复规则/验收`9503942`已串行推送到`origin/codex/analysis-capabilities`。原启动器经命令核对后正常停止，仅其应用进程被更新；使用当前构建、原`mock/builtin/lexical`模式、原开发数据库和运行目录重启。工作台`http://127.0.0.1:5173/`、API、Pi bridge及合成平台健康端点均HTTP200，Worker与另外四个子进程运行，三个既有开发身份检查通过。原数据库、卷、Pi会话及身份文件保留，身份文件大小和修改时间一致；未启动真实模型。服务核验为`.local/retrieval-delivery/local-services.json`，启动日志及旧日志归档同目录；最终本地/远端/工作树核验保存为`git-delivery.json`。本段交付记录单独提交。

## 已完成增量：每消息调用与临时故障重试（2026-10-17）

用户确认：正常消息最多24次模型调用，首次失败加最多2次原生重试，连续失败3次停止；保留单次超时和用户取消，不默认叠加单消息费用/总时长限制。新正常配置解除历史trial的一小时/累计调用/费用门槛，旧有限试验明确保留；每次重试、摘要、恢复与查询结果唤醒仍消耗原请求预算，未知预留不释放。该决定替代上一增量“不扩大限额/不提交推送/不更新服务”的实施边界，不改变其已完成修复及历史验证。

当前基线：上下文增量17组已通过，收据与代码指纹已复验一致，作为独立提交`b98a48f`保存；当前仅此新增量活动。现有服务为mock/builtin/lexical模式，使用原开发数据库及端口，更新后继续该模式。付费模型调用0。新实现采用Pi1.0.0原生retry（普通与摘要均支持），底层SDK HTTP重试保持关闭，Rust为每次真实请求许可、计数并持久保存连续失败。默认模拟消息12次调整为24次；历史显式profile保持原配置。

验收与要求变更：原“所有模型错误均不重试”仅对历史I0小样保留；data模式明确临时HTTP429（排除quota/billing）及500/502/503/504允许最多2次原生重试，模型连接失败/单次超时同样允许新attempt；拒绝认证、缺失/无效用量、取消及未知宿主许可/结算重试。每个失败尝试仍保留未知费用和调用次数。旧64KiB测试不放宽；正常profile示例使用已有128KiB档。

本增量修复、独立审查、12组统一验收、两批实现推送及原本地服务更新均已完成；本次交付记录单独提交，最终Git核验保存在本地交付证据中。

专项发现与修正：新错误码最初遗漏AppError枚举，已补同源契约；独立审查指出transient_error与unknown费用不能捆绑，已允许原outcome收到可靠usage后幂等结算，且不清失败计数。最初80ms超时夹具只观察到两次fetch，未仅据计数断言根因；改为500ms排除宿主许可往返占用，以验证provider不响应，生产90秒未改，三次失败预期保持。原失败日志保留在`.local/checks/request-policy-{first,second}.log`。独立审查另外确认并修正：HTTP200后的SSE断流通过SDK原生分类识别为临时网络错误；失败状态按实际调用序号重算最近有效outcome，晚到旧失败补计，晚到旧成功不能清新失败，未有outcome的预留不能重置计数。reserve/send均检查持久失败上限。

验收夹具修正：新增摘要重试测试首次使用64KiB/24轮历史时在触发目标摘要重试前就被真实载荷守卫拒绝，记录为`request-policy-third.log`。该专项改用已有正常128KiB档与16轮历史，先完成普通tool+answer，再用既有测试hook执行Pi原生compact并注入两次503，验证总共5次请求均计原scope。原独立64KiB/24轮历史压力测试保持，继续绑定POLICY-COMPACTION，没有用新夹具替换。新增旧schema迁移夹具第一次因USE语句与SQL开头注释之间缺少换行失败，记录为`request-policy-fourth.log`；仅补换行，迁移保留原额度/已用/预留/到期/指纹的断言不变。启动器纯配置测试由已有`make verify-startup`执行。

专项第五次14项完整通过，日志`.local/checks/request-policy-fifth.log`，共60次本机协议请求、官方模型0。启动器10条Python单测通过。审查补充了正式回答精确匹配及重复结算后累计账本完全相等断言；回答断言初稿误用content字段导致失败，已按既有SnapshotMessage契约改为text，未改变正文预期，失败日志为`request-policy-final.log`。当前冻结版的完整结论待12组统一收据，不拼接旧专项宣布通过。


首轮统一验收前3组通过（含436条契约及加强后的14项策略检查），第4组停在历史provider浏览器测试的`.badge`定位超时。完整失败收据与原审查归档为`.local/checks/request-policy-before-browser-fix.json`和`request-policy-review-before-browser-fix.json`，没有算作完整通过。

验收与要求变更：`git show HEAD`和历史提交`5ca7c2d`、`aaeeba5`确认，工作台在本轮之前已移除顶栏badge并采用空间/用户会话键；旧键仍有迁移兼容，不能据本次超时宣称它失效。历史I0 profile不提供模型目录，故provider测试保持原task profile、2048B、6次及关闭重试的边界，通过Identity核对DeepSeek Flash，并等待原用户消息与停止按钮验证真实会话取消；新键只用于确定当前测试会话。data启动测试通过真实模型下拉框检查选中ID与Flash/Pro标签。旧预填测试的VERSION标题和成功提示也已被既有界面移除，现核对同一正式HTTP版本增长与succeeded，再在“变更记录”确认该版本已渲染；通过“查看依据与修改记录”核对Alice人工覆盖。取消提示由旧“已保存的任务”按既有界面改为“已保存的消息”，仍要求取消后与刷新后精确显示，首次定位修正后的失败保留在`request-policy-legacy-provider.log`。原1500ms取消、幂等、后台身份、预填调用数/费用及人工保护预期保持，不修改产品界面或服务实现。修正后provider专项完整通过（13次回环请求，取消123ms、断开连接66ms），正式启动专项也通过（2次聊天+4次预填，已用624微美元、预留0；仅本地合成计费）。日志分别为`.local/checks/request-policy-legacy-provider-fixed.log`和`request-policy-startup-fixed.log`。冻结版12组须完整重跑。

第二轮统一验收前9组通过，第10组原有模型切换恢复测试发现本轮实现回归：模拟进程交接的AbortSignal被记录为permanent_error，使原scope提前达到失败阈值，恢复后遭model_retry_exhausted。保持原恢复预期与测试不变；provider取消现在只返回aborted并保留unknown预留，不写模型outcome，因此不增加或清零原失败计数。实际用户取消仍由Rust运行状态阻止发送。新增窄断言覆盖两次503后取消发送中请求，计数仍2、outcome为空且不自动重试。失败收据/审查归档为`.local/checks/request-policy-before-cancel-fix.json`与`request-policy-review-before-cancel-fix.json`，不能把前9组旧通过拼接到本次修正。修后14项策略专项与原模型切换/恢复专项完整exit0，日志为`request-policy-cancel-policy.log`及`request-policy-selection-recovery.log`；bridge类型检查通过。独立无DB探针确认run/options取消均aborted且无outcome，真实timeout仍为transient_error且由Pi重试。当前产品源码再冻结，重新执行12组统一验收。

第三轮统一验收前11组全部通过，最后POLICY-STARTUP在页面就绪后的首个身份检查超时；失败收据与审查归档为`.local/checks/request-policy-before-startup-timeout.json`、`request-policy-review-before-startup-timeout.json`。独立重现仍在原2秒限制超时；仅诊断性延长观测窗口测出首次/session耗时2.499秒、第二次0.009秒，日志为`request-policy-startup-diagnostic.log`与`request-policy-startup-timing.log`。源码确认API健康端点先于首次业务请求触发全量LazyLock契约编译。窄修复将原校验器初始化移到API监听前，不改变校验规则、原2秒请求/25秒健康等待或启动断言；新增审查范围仅API入口、共用契约初始化及对应架构说明。诊断延长窗口不计验收通过。修后原`make verify-startup`完整exit0（10项Python、原2秒身份检查、正式浏览器聊天与6次本机模型协议/预填、人工值保护），日志`.local/checks/request-policy-startup-ready-fixed.log`；独立审查认可在监听前强制原LazyLock初始化，不新增校验缓存、网络或改变规则。实现再次冻结，等待更新审查范围后完整12组复验。

完成证据：北京时间2026-10-17 23:22:15–23:31:58，第四轮`make verify-increment`的12组全部exit0、无超时，前后内容指纹完全一致；收据为`.local/delivery/I2-REQUEST-POLICY-result.json`，原始日志目录`.local/delivery/I2-REQUEST-POLICY-1792250535840342000/`。包括436条跨语言契约、14项请求策略、旧trial兼容、Pi/进程恢复、原64KiB压缩、大工具组、真实SDK序列化、模型切换、聊天执行授权和正式启动。独立审查记录`docs/reviews/request-policy-review.json`在最终复验前形成，其统一验收pending仅表示审查时状态；最终执行由本收据证明。材料静态检查353项通过。本轮仅合成数据、本机协议和浏览器，官方/付费模型请求0，真实模型质量、缓存收益与真实平台接入未验收。

交付结果：上下文修复`b98a48f`与请求策略/重试及启动修复`a7ca197`已串行推送到`origin/codex/analysis-capabilities`。原启动器经核对后正常停止，使用当前构建和原`mock/builtin/lexical`模式重启；工作台`http://127.0.0.1:5173/`以及API、Pi bridge、合成平台健康端点均HTTP200，Worker持续运行，三个既有开发身份检查通过。原数据库、卷、Pi会话和身份文件保留，身份文件大小/修改时间未变；没有启用真实模型或新增付费请求。服务记录及日志为`.local/request-policy-delivery/local-services.{json,log}`，原服务日志归档在同目录`previous-logs/`；最终提交/远端/工作树核验记录为`git-delivery.json`。新正常模型配置示例为`infra/model-profile.example.json`，其128KiB与24次设置未替换本地模拟模式或历史trial配置。

## Agent 上下文优化：七项修复与验证（2026-10-17）

- 上一增量 `I2-AGENT-CONTEXT / complete`，七项均已落地，独立审查与17组冻结版本统一验收通过，历史收据为 `.local/delivery/I2-AGENT-CONTEXT-result.json`。当前frontmatter描述新的请求策略增量，知识复用增量的完成事实与收据保留在下文。
- 原五条外部审查意见与本地/Oracle新增发现统一保留。优先保障回答依据、多轮任务连续性和实现清晰度；用量仪表盘、p50/p95、缓存收益统计不是实施前置条件。动态上下文与稳定规则分离、压缩后依据保留均已纳入本轮实现与验收；真实缓存与质量收益仍未测量。
- 审计基线为 `e951ff58`。本地离线请求序列化与 SDK 错误识别探针、一次隔离的 provider 协议复验均完成；Oracle完成一次4/5强度独立咨询。工程协议证据不代表真实模型质量或生产缓存收益。

| 来源与问题 | 实施结果 | 对应验证与结论边界 |
| --- | --- | --- |
| 原1：易变工作区进入系统提示，可能影响跨轮前缀 | 固定规则保留在system；时钟、任务、查询及记忆改由Pi原生context临时投影到历史之后、当前输入之前。成功回执撤下旧候选，同版route保留完整条件。 | `check-request-context`用真实SDK序列化证明跨轮时钟变化不改system；`check-memory-context`覆盖普通续聊、旧system检查点、同轮修订和半轮恢复。参考不写Pi树，不重复积累；真实provider缓存命中和费用收益未测。 |
| 原2：资源提示与工具说明重复澄清/归属规则 | 通用原则集中到resources，工具保留action、参数、ID/版本及前置依赖；记忆参考头去掉系统已包含的优先级/补读叙述。 | 澄清、消息归属及聊天执行回归绑定统一验收。自由回答、选项解释、换题、含糊归属与否定授权原则仍保留；本地协议不证明自然模型理解效果。 |
| 原3：长任务超限、压缩后丢依据或反复补读 | 原错误识别假设被反证；实际修复了固定尾部目标在小剩余容量下无法进一步压缩的问题。用Pi公开设置按容量约束保留目标，继续使用原生压缩及有限重试，完整工具组不裁剪。 | 原64KiB/24次trial/12次单请求预算下，24轮中文历史+6轮续聊+280条短历史通过，24次实际调用含10次摘要、最大65,467B。大工具组逐字保留，原操作不重复；最小组超128KiB时有限失败、无正式答案。不能承诺任意历史均可压缩、旧依据全保留或真实模型不再补读。 |
| 原4：recent_messages与Pi恢复历史重复 | 额外短副本不再注入，兼容字段为空；历史由Pi恢复，完整原话仍可read_conversation分页补读。 | 同文的两条真实消息都保留；27任务长会话核对完整原文、遗漏任务补读、当前目标优先和中断恢复。权限失效仍重建或拒绝，不用无依赖短副本重新引入旧内容。 |
| 原5：登记任务带来额外模型往返 | 明确登记与不依赖其回执的检索可在同一响应合批；新ID、版本或授权依赖必须等待。没有增加调度器或代替模型登记。 | `check-large-tool-context`实际同批登记+多个read_knowledge，验证工具配对、任务唯一及原身份。协议能力已证，真实模型是否减少往返未测。 |
| 新增：提交前容量预检漏算 | `request-size.ts`计入真实systemPrompt、完整历史、工具、临时资料、当前输入和二次JSON转义余量，预检仅决定是否提前调用原生compact。 | `check-request-context`仍复现旧估算低于阈值但实际超过64KiB的反例，修后预检能覆盖；最终实际载荷守卫原已存在，继续在网络和预算预留前拒绝超限。无抬高上限或另造序列化/压缩器。 |
| 新增：任务候选及裁剪未保护当前目标 | 当前已知input_task_ids优先，其余按未撤回消息的实际event_seq排序；从低优先级端裁剪，必要时保留当前ID/版本/状态和不完整标记。 | 超24任务按最近真实交互选择；旧任务重新修订并恢复时优先保全；Rust测试验证16KB裁剪与私有authority不挤占模型预算。完整存储和补读不变，不猜测新消息归属。 |

实施决定：实际SDK序列化后的字节检查已在provider预留/发送前运行。只靠轮内overflow会让长历史的摘要请求本身触顶，故保留提交前Pi原生compact入口。固定2048/256尾部在接近上限的合法工作区中会导致无合法切点；现通过公开SettingsManager按剩余容量限制到128至原目标，只有摘要自身也可能过大时初始compact仍保留较多历史尾部。除SDK明确Already compacted/Nothing to compact外的失败继续传播。此启发式不代替实际payload守卫，完整工具组、依赖、原SDK/操作及预算身份不变。

专项证据：`.local/checks/context-native-reference.log`记录上述完整压力场景；`context-large-final.log`记录两份8192字正文逐字保留及六份正文超限有限失败；`context-provider-final.log`记录15普通+1原生摘要的受控provider链路。`context-long-recovery.log`、`context-unit.log`及`context-engineering-final.log`分别覆盖27任务/恢复、8条语义上下文单测、427跨语言契约和工程检查。记忆参考头最终精简后的专项为`context-projection-final.log`及`context-request-final.log`；冻结版本已执行frontmatter绑定的17组统一验收，最终证据为`.local/delivery/I2-AGENT-CONTEXT-result.json`。本轮官方模型/付费请求0，不以先前专项拼接冒充统一通过。

失败证据保留：`context-native-current.log`为合法工作区下固定尾部导致的失败；`context-native-retention.log`与`context-native-budget.log`为初版容量设置虽完成六轮、但追加短历史续答耗尽24次预算。SDK离线切点核对表明，短工具组不可任意再切；重复参考说明使route后仅约105字节越界。精简已有系统原则的重复表述后，原场景在原预算内通过，不缩减输入、工具正文或提高限制。

首次17组统一验收前16组通过、最后资产目录失败，输入指纹未变；原收据与审查归档为`.local/checks/context-increment-before-asset-fix.json`和`context-review-before-asset-fix.json`。诊断`context-asset-diagnostic.log`显示测试称为unused的资产已被完整目录返回，停用后实际为409/stale_context。独立审查确认这符合既有依赖校验；没有据此修改产品保护。旧system检查点测试还补充了最终SDK载荷中的旧marker缺失断言，避免仅种夹具而没有验证，专项通过且网络0。架构标题改名造成的系统设计旧锚点也已同步。

验收与要求变更：旧 `check-native-compaction` 声明近16KB工作区，却直接覆盖为18KB单个goal，绕过Rust的16,000字节预算与goal最多240字投影；独立依据为原`bound_workspace`及本次真实序列化诊断。改为15,500–16,000字节合法启动条件，原24轮历史、6轮续接、280条短历史、完整账本/撤权/64KiB限制不变。原失败保留`context-native-{first,preflight,diagnostic,dedup}.log`及`context-debug.json`。长会话原夹具随机取遗漏任务，可能取同一消息的非主目标再要求其出现在单一task_id字段；改为有主归属的早期目标验证历史定位，非主目标仍独立通过完整任务目录/补读验证。无产品行为或验收边界放宽。新增修订测试初稿漏必需goal，按现行AnalysisUpdate契约补空goal；未改契约或业务预期。

资产目录夹具原将“启动候选之外”当成“从未观察”，在完整search目录后仍期望停用读取404，后续已读记忆改版又期望对象级stale_knowledge。依据系统设计第13.4/18.4节、`context_authority::observe/assert_run_in_tx`及工具回执的`extend_run_in_tx`，实际交付的目录也形成版本依赖，整个run校验先于对象读取。修正为：目录之后新建未观察资产，核对不在实际authority/已返回ID中，停用后精确404/not_available；已读原资产改版后，同run正文与来源均精确409/stale_context；再通过正常新会话启动有效上下文，保留正文分页与来源的409/stale_knowledge断言。跨用户拒绝、全文/Unicode来源重建、分页无重漏、未选Skill隔离等原场景不变，没有删除authority或把错误放宽为任意失败。专项证据为`.local/checks/context-asset-final.log`，冻结版已随17组统一复验通过。

完成证据：北京时间2026-10-17 21:07:33–21:13:58，`make verify-increment`的17组命令全部exit0、无超时，前后内容指纹一致；包括427条跨语言契约、8条语义上下文单测、Pi/provider、压缩/工具组、多任务、澄清/恢复、权限/记忆/Skill、时钟/执行及资产目录。独立审查记录为`docs/reviews/agent-context-review.json`，形成于最终统一验收之前；最终执行状态由上述收据证明。声明检查与16条检查器自测通过。官方模型、Copilot及其他付费调用0；真实模型质量、缓存命中和费用收益未测。压力样本最大65,467B，距64KiB仅69B且用满24次预算，只证明该合成场景；最小完整上下文超限仍按原约定有限失败。本次未提交、推送或重启常驻服务。

本地审计证据：`.local/oracle-review/local-audit.md`、`oracle-answer.md`、`offline-probe-result.json`、`provider-protocol.log`，均在同目录；源码摘录和指纹为`source-evidence.md`与`manifest.json`。provider复验为15次普通请求+1次原生摘要、真实DeepSeek请求0；没有再次调用Copilot。后续当前推进状态只更新本文件，不维护另一套活动计划。

## 本次 Git 交付与本地启动（2026-10-17）

- 用户明确授权分析未提交内容、分批提交并推送、保持 Git 工作区干净，然后启动本地服务；本次授权替代上一轮实施阶段“不提交推送或更新常驻服务”的限制。目标分支为 `codex/analysis-capabilities`，沿用当前工作副本。
- 原有 142 个变更文件按依赖分为合成来源/分析样例 21 个、Agent/后端与业务测试 84 个、前端与浏览器测试 21 个、设计/审查/交付文档 16 个。前三批已分别提交为 `c209277`、`1d509ec`、`f28c017`；源码、契约和测试内容与本轮开始快照一致。
- 材料检查 353 项、交付检查器 16 项、原样例 29 项、多月份分析样例 16 项、平台来源 19 项及目录生成 9 项均通过。原知识复用增量收据及独立审查与当前内容一致；本次首次复验前 11 组通过，最后一组因当前 shell 的 PATH 缺少 Cargo 而无法启动，未当作通过。失败原件保留在 `.local/code-commit-20261017/verify-increment-before-path-fix.json`，仅补齐本次进程 PATH，未修改验收命令或预期。
- 原 12 组统一复验于北京时间 16:17:37–16:20:28 完整通过，所有命令 exit0、无超时、前后内容指纹一致；包括 427 条跨语言契约、API/浏览器、原生/公共 Skill、记忆修订、完整治理、Pi/provider、上下文和语义结构检查。收据仍为 `.local/delivery/I2-KNOWLEDGE-REUSE-result.json`，本次归档为 `.local/code-commit-20261017/verified-increment-result.json`。本轮只整理 Git 交付与本地运行，没有修改产品源码或测试。
- 项目专用 Colima 实例已恢复，MySQL/Milvus 及其依赖健康，沿用原卷和本地配置。React、Rust API/Worker、Pi bridge 和合成平台已按 README 默认的模拟模型、词法检索和 builtin 记忆模式启动；工作台 `http://127.0.0.1:5173/` 与 API/bridge/platform 健康端点均为 HTTP 200，启动器完成三个既有开发身份检查。启动日志和 PID/健康记录在 `.local/code-commit-20261017/local-services.{log,json}`。
- Git 交付目标为 `origin/codex/analysis-capabilities`，四批提交构成同一交付序列；实际提交号、远端一致性和最终工作区状态见 `.local/code-commit-20261017/git-result.json`。初始内容快照及分批清单保留在同目录。以上仍是合成平台与本地协议证据，新增官方模型调用为 0；历史真实模型测量及待验证范围保持原结论。

## 本轮完成：第二版能力本地实施（2026-10-13 至 14 日）

- 七项本地实现与各自验收已完成：SOURCE-TRUST 12组、SEMANTIC-RULES 10组、CONTEXT-RETRIEVAL 8组、CLARIFICATION 9组、ANALYSIS-EVIDENCE 12组、ANALYSIS-REPORTS 10组、KNOWLEDGE-REUSE最终12组。各项统一收据保留在`.local/delivery/I2-<对应增量>-result.json`；这些是合成平台/本地协议证据，不代表真实模型准确率或真实Datasight接入。
- 第七项最终统一验收于2026-10-13 17:21:27–17:24:51 UTC（北京时间10月14日）完整完成：12条命令全部exit0、无超时、前后指纹一致。覆盖API14、浏览器8、原生/公共Skill、Mem0修订、完整治理5组、provider、工程/契约/架构、上下文5、语义结构10与建议投影反例。收据`.local/delivery/I2-KNOWLEDGE-REUSE-result.json`；独立审查`docs/reviews/knowledge-reuse-review.json`绑定99文件/12组，scope `908dcbfc03b74676ad14357c93ac0f261a822a476a3e3263cec3630dba326de2`。
- Pi协议本次实际15条普通模型调用加1次SDK原生turn_prefix摘要=16次，原账本完整计数/预留0，原输出与体积限额保持；没有新建Agent循环或压缩器。正式语义、私人方法、记忆、报告仍按原模块和权限规则维护。
- 本轮耗时来自七项实施及集成回归修复：撤下规则后的补查/传递依赖、非知识建议被结构投影污染，以及测试遗漏SDK原生摘要请求。原失败收据和诊断全部保留；没有删除原验收、放宽正式采用/权限保护或按固定mock题修改产品策略。
- 本轮代码在`codex/analysis-capabilities`，保持未提交；没有推送、部署或更新用户常驻服务。官方DeepSeek、embedding、Mem0服务请求0次。真实模型预填、自然澄清、自主分析与方法提取效果仍待执行包§10.3规定的独立小样授权；千表真实召回、真实Datasight及真实权限一致性仍在本轮边界之外。下一动作先确认小样的模型、合成情境和调用上限，不恢复旧无限调用授权。

### 本轮实施与失败修复记录


- 已完成 **I2-ANALYSIS-REPORTS / complete**：最后排序修复后10组统一验收完整exit0、无超时、前后指纹一致；收据`.local/delivery/I2-ANALYSIS-REPORTS-result.json`及独立审查`docs/reviews/analysis-reports-review.json`。旧9组收据仅作历史。
- 已完成 **I2-KNOWLEDGE-REUSE / complete**：执行包§9；公共查询案例复用M02、私人待确认方法草稿归M09，明确保存后继续原生Pi Skill；M02/M09分别查询直接显式引用并组合维护提示。共享Schema单一worker所有，根代理维护综合测试、架构检查、CURRENT，独立审查者不参与实现。
- 本轮范围核对未发现已证实的产品/架构漂移。预填中合成表DDL/ETL读取分支为基线遗留，目录合成身份映射用于资料关联；新增分析不按固定题输出答案。不能宣称任意表预填或真实Datasight已完成；前六项均是本地合成/协议证据，官方模型调用0。
- 第七项实现已落：案例沿M02正式结构与完整path依赖；方法草稿M09待确认并沿原AssetSave/原生Skill；维护反查仅直接引用。专项API13组已完整exit0（`.local/checks/knowledge-reuse.json`、`reuse-workflow-expanded.log`），包含真实并发确认、origin/operation持久绑定、实际结果唤醒拒绝、有效pending删除、条件变更与51可见+51隐藏Skill分页；浏览器与统一验收尚待完成，不能关闭增量。
- 第七项工程检查`make verify-code verify-contracts verify-architecture`完整exit0，427份同源Rust/TS契约、7项架构反例及隔离锁检查通过，日志`reuse-code.log`。浏览器首稿对select可访问标签、正文显示label与案例结构直接checkbox入口有错误定位；按源码/实际页面修定位，独立SQL与保存/权限预期未改，原失败留在`.local/checks/knowledge-reuse-browser/`。
- 第七项浏览器8组完整exit0（`knowledge-reuse-browser/result.json`、`knowledge-reuse-browser-run.log`），errors及routeErrors为空；真实50+2分页、建议接受/编辑/保存、新版本绑定、390px和原用户迟到响应隔离通过，桌面/mobile截图已查看。源码、API测试、浏览器和文档现已冻结，独立最终审查及9组统一验收待完成。旧版本409未当成功：应用后测试明确等实际新版本GET再读维护影响。
- 统一9组首次未通过：前6组完整passed，第7治理完整失败，收据输入前后稳定；旧收据/审查保留`reuse-before-context-fix-{result,review}.json`。GOV02单独运行完整通过，停Worker窄反例确认是既有语义结构投影与上下文校验不一致，非模型错或第七案例特殊分支。表1→2后旧metric结构撤下，实际manifest只有metric1/table2，下一合法补读table2仍被raw旧结构的table1检查拦住。证据`invalid-rule-context-reproduction.json`。
- 修复范围补充C02：校验实际交付依赖，正式查询/任务/依据check_refs保持；允许context_authority及原context-dependencies回归，验收增加第10组。API追加通用反例证明可补读、过期规则仍拒绝采用、实际采用后再改版仍失效。没有删除场景、放宽权限/版本预期或切换成功替身。修复及新指纹独立审查完成前不能关闭。
- 独立修复设计审查发现案例→指标→表的传递依赖原投影仅交直接引用，不能只删raw复查。沿原150条有界队列返回核验后的完整依赖，再按实际交付清单复查；依赖格式3→4，旧格式继续原SDK新输入重建/同输入拒绝。追加传递依赖撤回反例与原语义结构回归，第七项最终验收11组。`check-context-dependencies`现行格式3→4，`check-semantic-rules`此前格式2→4，独立依据是主程序格式迁移；保留原业务/数字断言和旧格式拒绝，不降低标准。
- 本次续接核对：最新构建完整exit0；增量7仍active/review=pending，旧9组失败不作完成证据。上下文修复沿现有M08依赖清单与Pi恢复入口，已补模块归属M08/C02；未另造Agent循环。已撤下结构的条目现在明确给出structure_gap，旧规则仍不能正式采用。专项及最终11组验收待最新源码完整运行。
- 当前稳定源码窄验证完整通过：建议投影1条Rust反例、最新API14/上下文5/语义结构10组、完整治理GOV01–GOV05，以及build/code/427契约/7架构反例和隔离锁。证据reuse-proposal-{projection,final-build-code}.log、reuse-context-final-{api,dependencies,rules}.log、reuse-governance-projection-fixed.log。现冻结全部验收输入，独立审查重新绑定后再执行12组统一检查；不将专项通过提前视作增量完成。
- 冻结12组统一检查本次仍未完成：前7组完整exit0，第8REUSE-PROVIDER在本地模型替身body.tools.map失败（一次无工具列表请求）；输入前后稳定。旧收据及审查已保留reuse-before-provider-fix-{result,review}.json，review重新pending。先核对Pi实际压缩请求，不关闭原生压缩或改变产品策略，不以7组代12组。
- 验收与要求变更：provider实际第6个HTTP为Pi1.0.0原生split-turn摘要，system逐字匹配SDK SUMMARIZATION_SYSTEM_PROMPT，2消息且含Conversation/Instructions模板，2048输出与12372字节均在原限制内。旧替身把全部请求当带工具Agent请求，原tools.map失败保留mvp-data-provider-no-tools.json/reuse-provider-diagnostic.log。测试将15条普通Agent策略/6–9–12–15业务断言保持，单独严格识别摘要并将两类实际请求总和核对原持久账本；原24总调用、12请求调用、费用和65536字节限制不变。未关闭Pi压缩，也未改产品或预算。
- provider修后专项完整exit0：原15条普通Agent调用加1次真实Pi turn_prefix摘要，共16次本地HTTP；持久ledger.calls16/spent960/reserved0，最大65532B≤原65536，摘要12372B/2048/disabled thinking，实际checkpoint存在原生compaction。证据reuse-provider-compaction-fixed.log、mvp-data-provider.json；旧失败/诊断保持。最新全部源码与测试现冻结，独立审查补绑定后重跑原12组，不追加产品能力。
- 最新窄验证API14组、上下文5组、原语义结构10组完整exit0，证据reuse-context-final-{api,dependencies,rules}.log。完整治理fixture修正后GOV01–04通过，GOV05在GET私人建议列表400失败（不是POST创建）：通用store读取的新增结构投影用可变JSON索引给建议插入entries:null，违反原Proposal响应契约。窄修只读取已存在entries，补建议投影契约反例，原共享/私人隔离断言不变；旧完整失败日志reuse-governance-fixture-fixed.log保留，最新工程/治理待验证。
- 建议投影修复新增1条窄Rust回归已完整passed，正式增量绑定REUSE-PROJECTION；最终统一验收由11组补为12组。只证明非知识建议的返回字段不被结构投影污染，没有改变任何业务或权限标准。
- 验收与要求变更：完整治理首次在GOV02前缺有效指标，GOV01已改版/同步表而旧指标仍引用表v1。独立审查确认GOV02原目标是系统角色与平台执行ACL独立，前提需有效口径。测试预备改为Alice经正式GET/PATCH按独立business-guide重新核对指标并绑定当前表版本；原权限、确认、查询与数字断言保持，通用API继续要求旧指标采用返回409 stale_knowledge。原失败、isolated成功和修后完整运行分别保留，不以isolated通过代替完整通过。




- 验收与要求变更：无产品预期变更。首API脚本误用不存在的`POST /conversations/{id}/delete`，按既有OpenAPI改回`DELETE /conversations/{id}`；新增结果唤醒等待误依赖未声明的`source_kind`传输字段，按现有M05持久`client_key=server:query-result:<id>`核对实际来源。原失败日志/结果保留于`.local/checks/reuse-before-delete-route-*`与`reuse-before-notice-binding.*`，没有放宽来源保护、并发或数字预期。


- 用户已认可五项方向：语义参与计算、有针对性的检索、深入分析、可继续使用的成果、经验复用；主动澄清贯穿其中。最新要求先保证预填和mock资料足够正确，优先公开合成环境，验证保持轻量。推进以五项通用能力逐项交付，不按一个演示题写特殊逻辑。
- 用户已于2026-10-13授权从I2-SOURCE-TRUST实施并依次推进全部增量，常规可逆选择自行处理。静态规格、增量顺序、接口归属和验收见 [语义、澄清与分析能力执行包](analysis-capabilities-execution.md)。本节与frontmatter是唯一当前状态，执行包不另记进度。
- 接手源码基线：`6801df79f3b09d51552df51dc20a44a916773447`，当前分支 `codex/semantic-maintenance-prototype`，规划前工作区干净。已建立本地工作分支`codex/analysis-capabilities`并保留规划文档，开始源码实施。
- 首增量已完成 **I2-SOURCE-TRUST / complete**：修正现有五表样例的来源版本、目录血缘、派生语义分类和预填输入。已核实目录漏`dim_customers`上游；旧SQLite可能配新磁盘ETL，Rust内置来源又绑定编译时文本；目录生成器混合原文与人工推导；平台对象的关联文档需实际核对。先建反例，再修对应原因。
- 后续依次推进：语义结构 → 有针对性的检索 → 主动澄清 → 深入分析 → 分析报告 → 经验复用。连续月份样例在深入分析时扩充，复用首增量的一致性检查；当前固定小样和独立参考保留。
- 本包采用的实施默认：沿用Pi/Mem0；每个任务聚焦一个当前澄清；新SQL仍逐次聊天授权；报告首版归本人/空间并绑定任务；公共查询案例归M02、个人方法归原生Skill；详细接口为待实现设计，不修改当前OpenAPI。
- 当前增量先做离线与本地协议验证；真实模型调用尚无本轮新增授权，提交推送或发布另按当时用户指令。历史Git交付与付费试验授权已用于原任务，不扩大到第二版；执行阶段真实小样先依据当时授权确定范围，未知回执和原预算保持。
- 本轮规划材料检查与交付映射检查通过，交付检查器16项测试通过。独立审查发现首增量缺少界面/启动代码指纹与浏览器测试允许路径，现已补齐；记录 `.local/planning/analysis-capabilities/review.json`，最终文档检查及指纹见同目录 `verification.json`。这些证据只覆盖规划，真实模型效果、迁移与新增交互均待实施。
- 首增量验收命令已绑定；实现与浏览器证据、独立审查及统一增量检查全部通过后才能关闭。`check-semantic-status.mjs`的部分响应替身只证明标签展示，编辑后重预填与同版出处需新窄测试`check-semantic-source-browser.mjs`及API证据；实际浏览器测试已完成并通过。
- 实现已修正目录漏血缘、混版风险、事实分类与平台文档关联；目录撤项保留人工内容并撤下非人工旧值。独立审查发现来源身份优先级错误，已修正并补组合反例。当前资料29项、来源14项、目录8项检查通过，预填21组、材料10组、浏览器3组及执行授权9组通过；12组统一增量关闭检查通过，收据`.local/delivery/I2-SOURCE-TRUST-result.json`；独立审查`docs/reviews/semantic-source-trust-review.json`通过，未调用真实模型。
- 旧`I2-MEMORY-CONTEXT`保持历史完成事实和原收据；本次替换活动增量，不把其测试记录改成第二版验证。后续每个增量更新本文件的目标、范围、接口变化、证据与下一步。

- 已完成 **I2-SEMANTIC-RULES / complete**（实施完成，10组统一验收通过）：沿用知识JSON和现有版本存储，结构与正文同层保存。SQL解析采用成熟Rust库薄适配；只给有界非阻断诊断，不把语法通过当口径通过。旧对象可读，缺结构明确。

- 结构增量当前证据：API10、浏览器4（含390px键盘及真实100项分页）、聊天执行9、上下文4和大型检查点5组均通过；Rust/TS/Web、290契约与模块/锁边界通过，纯55项检查已最后落盘通过。M03越界调用已撤回，新的结构依赖有效性与原生Pi检查点规则保持。真实模型调用0，统一收据`.local/delivery/I2-SEMANTIC-RULES-result.json`与独立审查`docs/reviews/semantic-rules-review.json`通过；尚不宣称真实澄清/分析效果。

- 已完成 **I2-CONTEXT-RETRIEVAL / complete**：复用词法/向量融合，范围在候选上限之前过滤，24KiB完整回执限制。业务域复用明确`business_domain`知识条目，只有当前来源事实或人工确认值可作为过滤依据；合成规范显式声明域，不能按表名猜。范围过滤不影响本人资产分页。

- 检索独立审查确认三项边界并修正：范围判断前撤下过期结构关联；回执保留完整合法业务域；Mem0候选补充目录时保留游标前全页资产。目录limit仍控制目录页，首屏可额外交付去重的有界Mem0候选；总体回执继续24KiB，身份和补读入口先保全。71项纯测试已通过，实际数据库与统一验收待最后稳定版本。已用独立MySQL反例确认相关JSON_TABLE的EXISTS被错误semijoin重排，过滤实现改为显式外层别名和标量COUNT子查询；同反例已命中，完整场景待新二进制。旧HTTP搜索回归发现SearchCoverage漏声明scope_applied，已补同源布尔契约，307例跨语言契约、类型/clippy/Web、模块检查与隔离锁检查通过；纯71项通过，来源29项/静态材料342项通过。scope API11组与excerpt5组已完成（仅本地Mem0/向量协议，不代表真实召回质量），完整回执最大23603字节，个人目录每页保全、同版补读与结构依赖改版stale_context均有反例验证；旧覆盖2组及Pi大上下文2组也通过，独立审查`docs/reviews/context-retrieval-review.json`通过，8组统一增量验收完整通过，收据`.local/delivery/I2-CONTEXT-RETRIEVAL-result.json`，前后指纹一致。大回执继续沿Pi原生压缩，超限有限失败、原操作身份不变；真实模型/embedding/Mem0服务调用0。

- 已完成 **I2-CLARIFICATION / complete**：代码核对确认已有patch合并、route保留澄清和恢复规则。实际缺口是clarify允许没有question，及Pi说明/贯穿验证不足；已补同源Schema和M06前置guard，Pi说明保留自主判断。旧生命周期6、阶段6、聊天执行9、Pi协议15次本地调用与恢复9、浏览器聊天4均通过，314跨语言契约及工程/锁检查通过；新增长期会话7组通过，25次Pi本地协议调用全部结算、预留0，最大请求70353字节；API/Worker重启同Pi会话、自由回答merge与执行隔离有实际证据`.local/checks/clarification.json`。独立审查`docs/reviews/clarification-review.json`与9组统一验收完整通过，收据`.local/delivery/I2-CLARIFICATION-result.json`前后指纹一致，不宣称真实自主澄清准确率。

- 已完成 **I2-ANALYSIS-EVIDENCE / complete**：独立连续月份数据集保留旧五表参考；新增受控结论保存与结果分页/覆盖，数字引用按平台数据核对。查询结果依赖进入原上下文有效性机制，避免过期数字从工具历史复用；不另建分析Agent。

- 本项实现及专项验证已完成：M06轻量依据及仅引用回执、M07连续保存页与窄结果授权、Pi受控工具，结果和知识依赖在新轮/恢复与模型边界查证。来源16/原29与平台快照19项、85纯单元、336跨语言契约通过；结果依据8组，真实Pi本地协议4组、13轮/47调用、最大108660字节/131072上限通过。旧provider15工具/15调用、聊天执行9、上下文4与统计4组保持；最终12组统一增量验收全部exit0、无超时、前后指纹一致，收据`.local/delivery/I2-ANALYSIS-EVIDENCE-result.json`；独立审查`docs/reviews/analysis-evidence-review.json`通过。报告和查询案例/Skill草稿仍留后两项，未提交推送或更新常驻服务，官方调用0。

- 当前增量 **I2-ANALYSIS-REPORTS / active**：按执行包第8节开始本人任务报告。保存输入引用1–5个既有evidence_ids，避免重复提交结论；条件变化后完成新分析再保存修订。图表只表达已保存的有界聚合结果，失效不回放正文；不新增顶层导航或公共分享。

- 报告独立审查发现来源汇总漏掉不可变依据中的`conditions.knowledge_refs`：即便结论/查询未重复引用，报告正文仍包含这些条件。已并入原有正式知识核验，停用/改版时只返回失效状态；新增反例验证，不改权限或查询授权。

- 报告审查核实SQLite按已返回行推断列类型，空结果及精确小数文本可能声明为`text`。绘图现允许已保存规范十进制单元格，保留原字符串；空/全NULL只显示暂无数据，不转浮点或改掉精度/空结果验收。

- 报告首次夹具误把`get_query`第一页100行当成205行完整结果，在报告API触达前失败。按既有`next_cursor/fetched_offset`逐页补读，205行、1000截断与原精确数值预期不变；不改SQL或数字，旧失败会话7188及服务日志保留。

- 报告键盘验收原值“一次Tab后焦点必在dialog”与原生Chromium行为不符：独立无产品代码的双按钮showModal基线，末按钮Tab会短暂到浏览器工具栏（BODY、hasFocus=false、:modal=true），再Tab回首按钮。新值禁止背景控件获焦，工具栏中转必须仍modal且失去文档焦点，再次同向Tab须回dialog；Escape返回原入口保持。独立基线`.local/checks/analysis-reports-native-dialog.json`与旧失败原件保留，不给产品加自制焦点框架。

- 报告审查确认Pi在压缩/重建或HTTP修订后只知report_ref，无法可靠保留原标题、选中依据和图表。补薄受控`read_analysis_report`，复用报告同一身份/来源核验，按同修订有界读取JSON正文，完整工具回执≤24KiB；实际读出的资料才登记原上下文清单。不新增Agent框架、启动全文或权限。新增空SDK检查点读当前修订、仅改标题保留旧来源/图表、分页及失效反例。

- 报告当前专项：406跨语言契约、最新API12组、浏览器6组、精确坐标5组与有界正文页1项通过；空检查点读取续改、最近5项之外的选中依据保全、真实并发和同修订分页均有实际证据。原9组统一关闭检查已通过（223579ms、前后指纹一致），后续排序误判修复需要重新绑定审查与新增第10组验收。全部为隔离合成环境，官方调用0。

- 原统一9组通过后，根代理与独立审查者用纯内存SQLite确认跨表同名排序误判：选择`a.month`而按`b.month`排序，仅比末尾名称会错误确认维度顺序。现复合名必须AST等于对应投影；有星号展开不猜列位置，输出别名/序号继续支持。旧passed收据/审查保留`.local/checks/report-before-ordering-{result,review}.json`，本项不提前关闭；纯反例和第10组统一验收重新绑定。这是现有检查的具体错误，不建语义编译器。

### 本轮验收与要求变更

- 增量5空检查点预期按SDK实际契约修正：host封套回源后可含SessionManager必需session头，但无消息/工具/压缩摘要、leaf和旧storage；query_results为空。本人安全user历史沿既有规则保留，旧助手及结果正文仍排除，查询观察仅四个控制字段。旧严格null/无任何历史误把封套和上下文混同；SDK checkpoint接口及既有context-dependencies是独立依据。

- 增量5跨表协议测试把relationship-tags来源路径误写description；按真实目录/指南entry_id=join修正，原SQL及独立核算数字不变。

- 增量5独立审查发现知识-only依据保存未登记所引用知识，已补同事务采用，并沿既有有界check_refs核结构依赖。独立新文档在无Pi补读、任务refs为空时保存，停用后模型发送/恢复拒绝、同CID新输入排除旧结论；未修改查询授权或增加记忆编排。

- 增量5贯穿真实Pi协议发现保存事件已入库但Event.type枚举漏analysis_evidence_saved，导致Snapshot回读400。补同源枚举/生成类型及事件、Snapshot正反例，保留回读200的验收；没有删除保存事件或放宽未知事件校验。

- 增量5真实Pi协议发现provider把data工具数写死14，新增已登记工具后15个导致所有data模型请求在发送前失败。允许范围补provider边界，按同源DataToolInvocation工具枚举核对合法且不重复的工具集合，保留请求体/输入输出/预算与SDK重试限制。旧协议测试固定14预期改为完整同源集合（当前15），不减少工具或放宽调用/费用约束。

- 增量5同聊续接测试被capture替身阻塞：正式取消已生效，但替身dispatch忽略原接口AbortSignal，另一结果run占用bridge后令新消息反复409。按真实Pi deliver的取消接口补替身abort/release结束等待并清监听，保留同CID继续聊的断言；未修改Worker、增加重试或改用新会话。失败日志保留在`.local/checks/mvp-52059aed5aeb64c1/service-logs.json`。

- 增量5平台快照元信息补冻结时兼容旧三文件协议：仅原协议固定日期、同core哈希/冻结文本/平台版本、独立重建的完整业务指纹和血缘全部相符时补元信息；业务库、账本和原结果逐字节保持。日期未知/更改或原库损坏继续拒绝，不清库。19项平台源反例通过，含标准旧目录安全升级与新日期不能认领旧来源。

- 增量5新恢复测试曾查询不存在的background_jobs.error_code。依据jobs私有store与Worker实际拒绝分支，改为任务failed状态、同一消息/Job的delivery_rejected stale_context日志和没有新dispatch，并保持原输入恢复不得重建副作用的预期；失败原件保留`.local/checks/analysis-evidence-first-failure.log`。这属于测试字段错误，不增产品状态或放宽恢复标准。

- 增量5独立审查发现新April4样例结果仍写死旧Feb4快照，允许范围补平台来源测试和规范manifest。复用两份已有snapshot_exclusive，纳入来源冻结并按该值生成原格式结果标签；不从表名、题面或运行时日期猜快照。旧样例标签保持，资料来源改变仍使用新运行目录。

- 增量5上下文清单由格式2升3，补实际交付查询结果的query_id/result_ref依赖。旧格式不能证明数字覆盖，沿原缺清单规则重建，原上下文测试对应格式预期2改3；知识/个人资产、消息与副作用身份、预算和恢复标准不变。任务目录中的依据引用摘要只用于定位，不自动当作已采用结果，避免过期结果在重建后反复污染新上下文。

- 增量4新测试把未执行草稿的budget_scope_id错误当作null；原设计在草稿阶段已绑定请求预算，现按既有执行契约核对confirmation_message_id/confirmation_key均null与not_submitted状态。新测试又误把ExecuteQuery回执字段当query_id，已按现有QueryRequest.id修正；不改变任何执行授权、版本或模型判断要求。

- 新结构分页反例误用has_more，按已定structure_page契约改为complete=false/next_offset=0；省略结构/补读的业务要求不变。新Mem0分页反例先停用了已采用文档导致合法stale_context，现通过正式新输入运行验证资产页，仍独立保留旧运行拒绝。

- 增量3独立夹具最初只更新正式知识/版本而未更新同版词法索引，已补完整夹具保存；额外保留删除索引后的正式知识fallback反例，不能靠补索引掩盖产品漏查。新Unicode纯测试前言长度680导致合法offset恰为600，夹具长度改800，保留原offset>600断言；SQLhelper纯测试不再借不支持MySQL BINARY前缀的sqlparser断言，实际动态SQL由真实MySQL反例和API验证。

- 增量3新增当前正文的词法定位：损坏向量位置仍拒绝，但正文真实匹配时可以通过lexical通道独立定位；旧工具场景不再一概unlocated，保留损坏索引反例与真实偏移断言，并明确通道。


- 工程边界检查发现M03直接调用M02投影/规则函数，已撤回：M03只生成候选并检查模型输出形状；M02在正式持久保存时统一投影。预填纯测试现在核对候选保留来源/建议结构但不保留旧正式投影，按既定M02/M03职责修正，未改变正式知识验收。


- 新API反例修正GET/PATCH装饰字段比较方式：对失败编辑前后两次GET完整结果比较，仍要求内容与版本完全不变；产品预期未放宽。直接cargo全lib的5项数据库测试缺显式隔离URL，不能记为通过；统一验收将55项纯测试与既有locking/大型checkpoint隔离入口分别绑定。


- 新结构引用需进入原有采用/上下文有效性边界。独立审查发现仅诊断核验不足，故增量2增加M08/C02与现有context_authority、knowledge_sources组合入口；不创建新Agent机制。依赖清单格式从1升2，旧清单不能证明覆盖结构引用，按既有缺清单规则重建；原上下文测试唯一对应版本预期1改2，消息身份、预算、恢复要求不变。


- 默认mock平台修订由1升为2，依据是补齐血缘及绑定实际来源快照；既有十进制单调版本契约不变，指纹不替代公开版本。同步测试默认平台版本预期相应变为2，内置来源数由3变为4（新增semantic-catalog持久版本），其他业务数值不变。
- 来源修订暴露查询存储/提交写死目标版本1；本轮增加M07直接入口修复，使草稿和提交绑定平台检查回执的版本。相关路径与C04验收已登记。
- 内置资料改版测试通过显式platformSourceDirectory使用独立平台来源，仍验证内置源修订；平台同源漂移另由真实SQLite/HTTP反例验证，不能用该测试seam绕过产品检查。

## 已完成交付：代码合入主分支（2026-10-13）

- 用户明确要求除博客外的工程内容提交、合入默认分支并推送，最终工作区保持干净。目标为 `origin/codex/semantic-maintenance-prototype`；代码、契约、测试、架构说明与必要验收报告一起交付，替代此前本阶段“不提交推送”的限制。
- 博客正文及配图已完整移到仓库外的同级 `data_agent_articles/`，14个文件逐一核对SHA-256一致；`docs/articles/` 不纳入Git，新增忽略规则防止误加入。文章发布过程的历史记录随稿件保留；代码仓库只保留实现与验证信息。
- 本次不再修改产品行为。已有记忆增量11组收据仍与当前代码一致；前序时间契约、旧调用恢复和两处验收器修正补做独立提交审查与必要本地回归，不恢复付费评测或把历史16题未通过项改成通过。
- 提交前检查已通过：独立审查见 [prior-code-review-20261013.json](reviews/prior-code-review-20261013.json)，15份前序输入指纹相符，273条契约、SQL核算器和12项Node恢复分支通过。主线随后完成生命周期6项、请求时钟2项、聊天执行9项及全部16场景的本地协议检查，均exit0、无超时、官方调用0；收据 `.local/code-commit-20261013/checks.json` 的执行前后源码指纹一致，补齐审查记录中待主线执行的检查。
- `make verify-materials verify-delivery` 通过，材料与链接检查、交付检查器16项测试通过；记忆增量11组完成收据仍匹配。提交内容中未发现凭据、本机个人绝对路径或博客文件。当前实现、架构和测试继续沿用已确认的18项决定及36项需求映射；本次Git交付的提交号、远端核对与工作区状态另存 `.local/code-commit-20261013/git-result.json`，以实际结果为准。

## 已完成验证：记忆接入真实模型小样（2026-10-12）

- 用户在本轮修复完成后授权真实模型小样，只验证两处修复，不扩大范围；下方实现增量及其指纹收据保持已完成，本节单列后续实测，不把原来的0官方调用记录改成新测量。
- 沿用DeepSeek Flash/high，真实Pi、Rust/MySQL和既有builtin资产目录，预置从零构造的合成记忆。两条消息各首次运行一次：模型自行停用旧渠道记忆后，核对下一次普通请求不再含该ID候选且回答不沿用旧默认；对摘要遗漏尾部例外的记忆，核对模型自行补读同版来源原话并正确解释适用范围。
- 总上限16次模型调用/US$0.50，每消息8次，输入65,536/output8,192 tokens、请求体131,072字节。新建专用合成trial和数据库，不占用或修改历史未知账本；配置、题面与期望先保存在 `.local/memory-context-sample/plan.json`。调用/账本未知、超预算或源文件变动时停止，不重发已开始场景；普通行为失败保留。
- 采集已因认证阻塞停止：首个官方请求返回HTTP401，应用报 `model_auth_failed`，没有模型回答或成功工具回执；停用行为未验证，来源补读场景未运行。只使用当前进程已有环境凭据，没有读取凭据文件，不能推断项目其它凭据均失效。
- 本次实际发出1次请求，账本 `unknown/usage=null`、已结算估算0、保留预留29,492微美元（US$0.029492）；它不是实际收费。按固定停止条件不重试、不清预留、不换试验补额，测试进程已停止、专用合成数据库保留。直接透传记录了官方请求正文和HTTP状态，没有记录认证头、改产品提示词或模型输出。
- 离线 `audit.mjs` 核对请求/回执与源码指纹通过，`accounting_complete=false`；原件 `.local/memory-context-sample/result.json` SHA-256 `0ecef1cccc2af75651b636f3bd006bd3955c30fff33a6af2f24fed8f8d707a29`。首个实际请求确认user临时参考与system分离，但不能代称两处真实行为通过；原实现完成收据仍与当前输入一致。报告见 [memory-context-sample-20261012.md](reviews/memory-context-sample-20261012.md)。
- 用户随后明确提供新的DeepSeek密钥用于替换失效认证，授权继续。仅在续跑测试进程中使用，不落项目配置或证据；原401原件及unknown预留保持，沿同一trial/数据库/原消息恢复，剩余最多15调用，总16调用/US$0.50不变。续跑结果另存 `.local/memory-context-sample/continuation-result.json`；原停用消息未有任何模型输出或业务副作用，不重发消息、不改题面。原“未知即停止”仅对这一已知401保留预留后续行，任何新的未知再次停止。
- 续跑已完成：原停用消息沿同一message/recovery_chain/budget_scope恢复，新认证后3次成功调用；成功disable回执后实际普通请求不再含旧ID候选，最终答复不沿用web默认。来源场景5次成功调用，模型主动补读5851字符原话；先因裸UUID被拒绝，再自行修正asset-前缀、同version1以limit8192一页读全，正确回答订单收入按渠道、退款按原因、缺字段先说明缺口。两条均正式完成，没有生成/执行SQL或改写来源记忆；不把一页成功称为多页续读。
- 共9次官方请求（首401＋续8次settled），结算估算US$0.035841，旧unknown预留US$0.029492，总占用US$0.065333，低于16调用/US$0.50。原401未清零，`accounting_complete=false`；测试进程已停止，合成库保留。续件SHA-256 `645ebb3ef1e2863e8c4b606ec90319035f8f63ff313fee521fab677f588dd5b4`，`continuation-audit.json` 已与真实数据库账本、请求/回执及源码指纹核对通过。独立内容审查已完成，两场景均通过，记录 `.local/memory-context-sample/quality-review.json`；逐请求及正式答案核对，不将8次成功调用当作8个场景。新密钥未写入项目配置、脚本、证据或服务日志；材料337项检查通过，原实现完成收据仍有效。
- 此次不测试真实update/Mem0提取/向量召回，不运行16题、不执行查询、不提交发布；不能据两条小样推断总体准确率。

## 已完成增量：记忆来源与 Pi 上下文（2026-10-12）

- 用户同意按 dev_co 更新相关设计/架构图并修复，要求不扩大、不漂移；暂停核对 SDK 后再次明确使用 Pi 官方接口继续。沿现有 Rust/MySQL/Mem0/Pi 分工，只处理有源码与反例支持的边界。
- 已确认两处缺口：`model_page` 对所有资产读取清空 `source_text`，模型无法通过现有工具回看提取前原话；同轮修订/停用后 Rust 已更新授权快照，但启动 system 仍重复旧记忆正文。先补可失败的确定性回归，再实现。
- 接法：记忆由 Pi 原生 `context` handler 每次请求投影为当前参考，不持久写入会话。成功记忆变更撤下启动快照中的对应旧条目，新内容由工具回执提供；失败保留原候选。不删历史工具消息，不另写摘要器；Rust reserve/send 继续执行权限和预算检查。
- 来源：沿现有 `read_knowledge(entry_id=source_text, version, offset, limit)` 读取本人当前有效记忆的原话；缺省只交来源分页元信息，正文/范围/来源分别标注完整性。原话供核对范围和例外，不把提取或原话自动升格为公共定义。
- 提取方式保持已有比较后的决定：Mem0对完整消息和宿主核验引用执行infer=True，人工正文索引infer=False；自动body/scope同源，name只取前缀。9类合成情境两次对比的16/18是历史证据，不证明任意语义保真。尚未复现的大记忆池默认召回覆盖不进入本轮实现。
- 验证只用确定性测试、真实Pi SDK、Rust/MySQL及本地模型/侧车替身；新增官方调用预算为0。来源分页5项、来源访问4组、Pi上下文3组及 `make verify-code` 已完整通过；原生压缩18次本地调用、4次摘要，最大请求64,880字节，预算预留归零。日志保存在 `.local/memory-context-repair/{source-after,source-access,context-after,code,compaction}.log`；先失败反例保留为 `source-before.log` 与 `context-before.log`。
- 架构图文已同步，复用既有11组件、19关系；5个导出视图的文字/边界/遮挡检查均无问题，已打开实际记忆PNG确认。材料静态检查335项通过。
- 独立审查已通过，记录见 [memory-context-review.json](reviews/memory-context-review.json)，范围指纹为 `93fd221c4966be1023725f90228dc365a91d78b02106d3e43aa62475717622a9`。审查者独立运行Pi上下文测试及内存边界检查，核对源码、设计与已有日志，未代称运行数据库或真实模型验收。
- `make verify-increment` 于2026-10-12 15:04:37–15:07:25 UTC完整执行本轮11组声明：全部exit0、无超时、前后指纹一致，收据 `.local/delivery/I2-MEMORY-CONTEXT-result.json`。包括273条跨语言契约、5项来源分页、4组来源访问、3组Pi上下文、12项Python及9组记忆provider、2项来源分句及4组修订、5组authority、原生压缩、9组恢复和8组Skill；Rust fmt/clippy、TypeScript和API/Worker/Web构建通过。相关官方请求为0；新增预算0未使用。
- 本轮 `I2-MEMORY-CONTEXT` 已完成，保留Mem0提取策略与Rust正式资产职责。后续如需判断真实模型能否主动核对来源或保留全部限定，须另定实测范围和预算；本轮不自动进入真实质量复测、旧增量收尾或文章发布。未提交、推送或部署。
- 本次实际运行环境为Node22.23.1/npm10.9.8、Rust1.99.0，Mem0测试虚拟环境为Python3.12.10；没有据历史环境字段声称使用Node26。构建保留Vite输出目录与chunk大小提示。本轮未重测真实模型语义保真、召回或16题质量，不能推断真实准确率提高。
- 实施前相关文件快照保存在 `.local/memory-context-repair/before/`，用于区分上一轮未提交修改与本轮增量。

### 验收与要求变更

- 新增来源可读与Pi上下文更新的回归，原有提取/隔离/修订/压缩/恢复期望保留。没有降低模型内容判分，也没有把真实质量评测换成mock通过率；本轮验证的是接入和状态边界。
- 新增压缩断言最初只识别HTTP消息的字符串content，实测custom经Pi转换为文本块数组，误判无参考；按SDK `convertToLlm` 与OpenAI消息转换实现同时读取两种文本表示。仍严格断言普通请求一份参考、摘要请求零份，未降低行为期望。原失败日志保留为 `.local/memory-context-repair/compaction-before-check-fix.log`。
- 上一时间契约/文章增量已按用户“先停下来”暂停：修复与16题采集/公开首篇已完成相应记录，最终完整审计、范围绑定及 `make verify-increment` 未完成，不能标记交付验收complete。旧frontmatter原样保存在上述before目录；旧测量只代表其冻结版本，P03的US$0.049152未知预留保留，本轮不接续旧付费预算或重跑题目。

## 上一增量：时间条件修复与完整质量重测（2026-10-12，已暂停）

- 最新用户要求：不能停在S03失败和13题未运行的报告，应修复后完成质量测量，并继续更新首篇。此前“只测量、不修产品”的范围已被本次要求替代；仍停留在第一篇，不提交或推送。
- 已复现：原共享Schema接受 `time_start=2026-01-01`、`time_end=2026-01-31`，Node/Rust没有格式约束；设计要求时间带时区，原S03要求UTC月区间。新增契约反例在旧实现上失败，日志 `.local/article-publication/time-contract-before.log`。
- 修复范围：`Conditions` 与 `ConditionSet` 明确UTC完整时间戳及左闭右开语义，Node/Rust共用 `date-time` 与格式校验；合法null及业务时区独立保存。拒绝不完整日期，不从日期字符串猜测结束日或自动迁移历史记录。保留原S03断言和runner停止机制，避免失败后的个人记忆/共享知识残留污染余题。
- 已完成验证：旧实现新增日期反例失败；修复后271条Node/Rust契约用例、TypeScript、Rust fmt/clippy及Web构建通过，生命周期6项、请求时钟2项、聊天执行9项及原16题协议检查通过。Web构建保留既有chunk大小提示。实际命令使用Node22.23.1/npm10.9.8、Rust1.99.0、Python3.12.2，未据项目记录假称本次在锁定Node26.8.1上执行。
- 真实S03独立小样已完整通过：UTC月边界、条件保留、旧稿确认409、新稿执行、1600分与5数据变体及结果解释；10调用、估算US$0.052410，全部结算、预留0。原件 `.local/quality-20261012-repaired/smoke-result.json`，SHA-256 `43ce9f78a59723e03ae88a79010bde46672a25c4cd6369469d6b8d04bd0c0a78`。小样不计正式成绩。
- 修复后首次完整轮通过S01–S05/B04的机器检查，在B05告知措辞断言处中止：已保存web记忆并说“记为你的长期偏好”，但 `/保存|记住/` 不接受该等价表达。58调用、估算US$0.368563、全部结算，9题未运行。原件 `.local/quality-20261012-repaired/formal-result.json`，SHA-256 `30a018413c20ae1ee68b10e53ad3cfd3ec48edc975be28129f0eaae504196712`，默认历史证据已恢复，B05后续步骤不算通过。
- 独立审查确认时间契约收紧还影响升级恢复：旧版已提交但缺toolResult的日期参数会在接回原回执前被拒绝，误告知“未执行”。当前修复范围增加既有Pi恢复、受控工具及Rust回执入口；只允许原身份/参数指纹匹配的持久回执接回，新执行仍严格校验，不改历史日期。补旧历史恢复与新非法调用回归，沿用Pi和已有接口。
- 修复后累计已用68调用、估算US$0.420973；沿用本次修复预算总计224调用/US$5.50，后续独立完整轮最多156调用/US$5.079027，不重置既有账本。真实Flash/high、合成SQLite、词法检索与内置记忆范围保持。此前两次中断原件都保留，不将不同轮的成功题拼接。
- 恢复补丁已完成：旧成功/拒绝回执按当前身份、租约与原指纹接回，未登记的新非法参数给可修正工具结果，已登记无回执保持 `outcome_unknown`。新增旧历史最小回归先失败后通过；最终9项恢复检查、类型、Rust构建/fmt/clippy通过，真实模型调用0。独立审查12项纯内存分支通过、无新增阻断；`.local/checks/mvp-recovery-continuation.json` 保存数据库回归结果。
- 恢复修复后的第三轮在S02中止，11调用、US$0.060963，预留0。证据 `.local/quality-20261012-complete/formal-result.json`，SHA-256 `5d86186425ad186f45c5116fbfcd539a72c17e46f2cae726b4327e8b41e9491a`。独立核实SQL数值与7变体正确，验收器漏识别明确存在标志列名 `unknown_boundary_present`，不是人数计算错误；新映射及1正4反测试通过。
- 连续fail-fast无法完成余题且共享fixture可能污染，因此最新测量预先固定原16题，每题独立干净fixture，各执行一次；失败保留并继续，未知账本/费用/原件异常仍停止。新套件目录 `.local/quality-20261012-isolated/`，最终采集与有界续采结果见下文。模型、原题面、业务期望和产品代码在这套采集期间固定，不能挑选旧轮成功结果，也不对单题补抽。每题完成均核对同一源码指纹、原件SHA及账本，默认历史证据恢复。
- 修复阶段前三次采集共79调用、US$0.481936；隔离套件扣除后最多145调用、US$5.018064，仍受224调用/US$5.50总上限。隔离脚本离线验证各题一次、普通失败继续、未知停止、损坏原件保留、默认恢复和重复运行拒绝；独立代码复核通过。新报告 `docs/reviews/mvp-accuracy-20261012-repaired.md`，独立内容判分输出 `mvp-business-quality-20261012-isolated.json`；完整含义为16题均尝试并有原件，机器失败整题计false，不要求100%通过才完成测量。
- 隔离套件在P03的内部复核调用遇到 `model_unknown` 后依协议停止：原始13题已入套件，P03失败原件另已归档，P04/P05尚未尝试。只读数据库确认P03共2调用，其中1份已结算27955微美元、1份issued且usage=null、预留49152微美元；采集进程和测试Worker均已停止。P03原件SHA-256为 `11ff4b7ff993ece3824533c0869eaa2882d68cc2768450eb8b28aeb931afe048`，不改原件、DB、调用ID或未知状态。
- 用户要求Try again后采用有界后续采集：只首次运行P04/P05，不重试P03；保留原停止manifest/suite，新写continuation与complete-suite结果。已分配204调用、已结算1334624微美元、未知预留49152微美元，因此剩20调用/4116224微美元。预留全额占用原224调用/US$5.50上限；下一题按上一题实际结算递减，新增未知或原件问题再次停止。产品233份输入指纹、模型与题面不变。独立审查认可这种明确标注的方法修订；最终只可说全部场景已尝试，不能声称原协议正常跑完或全部费用已结算。
- 最终16题均已首次尝试：机器流程13/16，独立完整场景10/16（62.5%）；问答SQL6/8、记忆多任务3/3、预填1/5。未通过为S02验收器覆盖不足、B07跳过澄清、P02错误推论、P03调用未知、P04/P05必需事实遗漏。P04/P05均首次4调用，原先not_run已被真实结果替代；不修改原中断记录。聚合 `.local/quality-20261012-isolated/complete-suite-result.json` SHA-256 `c2f2225f686c44215279ffb7f1fae5884f4935f472213d0b51d1777ae755ca9d`。
- 最终133调用中132settled、1issued未知，已结算估算US$1.009282，预留US$0.049152；修复阶段212调用、US$1.491218已结算，同笔预留仍占用，总占用US$1.540370，在224调用/US$5.50内。当日含修复前测量共239调用、已结算估算US$1.699926，加US$0.049152预留。费用并未完全结清，不能把费用核对报告的证据完整等同accounting_complete。
- 原因依据：`docs/architecture/implementation-design.md` 第4.1节、`docs/semantic-retrieval-design.md` 第19.6/20.1节及独立业务资料的UTC月区间。验收期望未放宽，新增对非法格式/日历值及合法null/UTC/业务时区的回归。完成前需独立审查与 `make verify-increment`，真实测量及内容复核另存新报告。

### 本轮验收与要求变更

- B05原告知检查为 `/保存|记住/`，改为 `/保存|记住|记为(?:你|您)的长期偏好/u`。独立审查核对原B05要求和设计第11.3节，以及成功资产回执、`memory_saved`事件和最终答复，确认“记为你的长期偏好”符合原成功告知含义。保留持久资产、渠道独立核算、跨会话复用、修订停用及失败分支断言；没有降低业务标准或改变模型提示。确定性原句在旧检查失败、新检查通过；另3个等价正例与3个无保存告知的反例通过，证据 `.local/quality-20261012-repaired/b05-acknowledgement-check.json`。原失败轮保持失败，后续新轮重新执行完整场景。

- Q02存在标志原先仅支持 `has_`/`any_`/`exists_` 前缀，现在将明确的 `unknown_boundary_present` 映射到相同角色。独立依据为业务指南5.2、Q02参考SQL和原种子及7变体核算，值、列序、去重与匿名粒度标准不变。新增1正例、常数/错误粒度/不去重/重复角色4反例，核算器整体通过。S02旧中断后未执行的确认与解释仍未验证，不改旧成绩。
- 测量调度由一次共享fixture的fail-fast轮改为预声明16个独立fixture，各题只运行一次；内部完整场景与机器断言保留，失败原件保留后继续下一题。减少题间记忆/知识污染，不改变任何题的通过条件。只读套件审计明确区别全部采集完成、机器通过数与独立内容通过数，所有16题都保留在分母；未能执行完整内部步骤的失败场景计false，说明未验证范围。历史中断轮不拼入这套结果。
- P03未知费用触发原套件停止后，独立只读查证其预留、确认采集进程已退出，再首次采集原清单中的P04/P05。原BUSINESS-MEASUREMENT审计要求每份回执全部settled；新验收改为保留且唯一核对P03 issued/null及49152微美元预留，后续cap扣除spent+reserved，最终明确 `accounting_complete=false`。这放宽的是“采集必须等全部结算”的操作条件，没有降低任何场景内容/流程标准，不能宣传为费用结清。原审计和停止manifest不变，另建只读完整证据审计，原件不改、题目不重抽；新增未知再次停止。

## 本地角色试用准备（2026-10-12）

- 用户要求部署最新版本，并按角色提供案例，由用户继续 dogfood。本轮为本地运行与试用材料准备，不新增产品能力；上轮交付收据保持原范围。
- 已从主分支 `f482a51` 重新构建并启动 Web、Rust API、Pi、平台 mock 和 Mem0，五项健康检查均为200。保留已有数据库、三类账号、会话和资产；沿用真实 DeepSeek Flash、Mem0 与 Qwen 向量配置。
- 角色接口已核对：Bob为普通用户；Carol为语义维护者，负责 `demo_order_detail`；Alice为超级维护者。登录凭证仍在被忽略的 `.local/development/identities.json`，不写入文档或试用手册。
- 本次模拟平台查询等待设为20秒，便于试用后台查询、继续聊天和手动停止；不据此衡量查询性能。工作台仍为 `http://127.0.0.1:5173/`。
- 试用手册为 `.local/dogfood-20261012/guide.html`，本地入口 `http://127.0.0.1:8874/guide.html`，仅对该材料目录提供回环访问。68项案例覆盖聊天查询、个人记忆与Skill、语义维护、超级维护、跨用户协作和边界；可复制提问、筛选、记录结果与备注。浏览器核对了展开、复制、筛选、记录刷新保留和排版，交付时全部恢复为未测试。导出按钮已点击，未单独核对浏览器下载文件。
- 当前合成SQLite与13道独立参考逐项一致；真实Flash已走通共享语义检索、SQL展示、聊天授权执行和结果解释。1月按渠道净收入为app 1600、store 800、web 10000分，合计12400分。仅验证这一代表流程，不将68项清单标为全部通过。
- 证据：`.local/dogfood-20261012/readiness.json`、`reference-results.json`、`real-query.json`及页面截图；构建日志 `.local/development/dogfood-build-20261012.log`。保留原未发送草稿并恢复模型思考设置。本轮未接入真实Datasight、未验证生产容量，未修改业务代码或提交推送；下一步由用户按手册试用并反馈。


## 当前增量：README 视觉重做（2026-10-11 至 12 日，已完成）

- 用户认为原封面普通、配图不足，授权重做并提交推送。限定 README、图片来源与交付记录，不改产品行为、接口或模型方案。
- 方向为深色封面与配套信息插画；用内置 GPT Image 重做封面，增加语义构建、对话查询、知识召回、Skill 复用四张图，原真实页面截图与正式架构保留。README 共展示9张图。
- 图片只使用公开技术名称与项目合成场景；模型生成图用来解释概念，实际界面仍用截图，准确调用关系以现有架构图为准。
- 封面和四张说明图已完成。浏览器中9张图片全部加载，918px正文宽度下的标题、标签与箭头可读，无整页横向溢出；五张排版截图保存在 `.local/readme-visuals/`。查询图额外出现的“历史示例”已修正为“文档”。
- [独立图文审查](reviews/readme-illustrations-review.json)通过，无剩余确定性问题；检查原图、实际排版及语义/查询/召回/Skill边界，保留本轮范围指纹。
- `make verify-increment` 通过，收据 `.local/delivery/I2-README-ILLUSTRATIONS-result.json`；Markdown、GFM表格、启动链接、本地引用与9张图片格式均通过，19份输入前后指纹一致。材料检查332项和交付检查器16项测试通过。业务代码保持原验收版本，本轮未重跑业务测试或真实模型。
- Git交付：图文提交 `4b4308c` 已快进合并到默认主分支 `codex/semantic-maintenance-prototype`；主分支与 `codex/readme-visuals` 均推送成功。当前检出主分支，本条收尾记录单独提交。

## 上一增量：README 图文更新与合并（2026-10-11，已完成）

- 用户要求更新 README、使用 GPT Image 配图并整理文案，完成后合并分支、提交和推送。只改文档和配图，不调整产品范围。
- 以 `0a6f5bf` 为业务基线；原 `I2-LOCAL-DOGFOOD` 的五组收据与独立审查保留，绑定原版本。README 改写单列为本次文档交付，不把旧收据视为对新文档的检查。
- 封面使用内置 GPT Image 生成；工作台与语义页重新截取正式页面，Skill 使用已有浏览器验证截图，全部采用合成资料。生成提示词和来源见[图片说明](images/README.md)。
- 内容围绕用户操作、语义维护、个人记忆和 Skill；明确 Mem0、Pi、Qwen 与存储分工，保留历史测试题数和适用范围。新表自动发现和增量同步继续后置。
- 图文验收已完成：Markdown/GFM 表格和启动链接解析、5 张图片格式、本地引用与业务基线不变检查通过；浏览器确认图片全加载、无整页横向溢出，折叠内容可展开。材料检查 327 项通过。文案清理保留技术名词、历史数字及限制条件。
- [独立文档审查](reviews/readme-presentation-review.json)通过，无剩余发现；`make verify-increment` 文档验收通过，收据 `.local/delivery/I2-README-PRESENTATION-result.json`。只验证本次呈现与基线一致性，未重跑业务测试或真实模型。
- Git 交付：图文提交 `2196a82` 连同六个既有提交已快进合并至默认主分支 `codex/semantic-maintenance-prototype`；主分支与 `codex/conversation-experience` 一并推送成功。当前检出主分支；本次收尾记录单独提交，保留分批交付历史。

## 上一增量：全功能本地试用与修复（2026-10-11，已完成）

- 用户要求实际使用全部点击、编辑和现有能力，记录、审计后修复，修后本地复测。沿用dev_co；不增加新功能，不针对mock资料特判。
- 保留所有既有未提交工作；基线备份 `.local/local-dogfood/before/`。日常路径在当前页面试用，批量维护、破坏性操作和故障注入在隔离本地数据中验证；实际模型沿现有配置，仅用合成资料。
- 覆盖表与问题证据见[本轮试用记录](reviews/local-dogfood-20261011.md)。先核对工作台/历史/SQL结果、记忆/Skill、语义/纠错/负责人三组操作，再按发现补充有界修复及独立审查。未验证项不得标通过。
- 该轮代码与文档已分为 `2034d5f`、`aaeeba5`、`0a6f5bf` 三批提交并推送功能分支；同步方案和同步缓冲能力继续暂停。
- 本轮四项通用修复完成：新对话模型设置丢失、选Skill后未发草稿丢失、回执未知时误迁草稿、空会话首问后模型版本未刷新。按用户/空间/会话保存与迁移临时输入，保留服务端版本、原提交身份和后来编辑；均有修前复现及修后浏览器断言。[独立审查](reviews/local-dogfood-review.json)通过，无剩余确定性发现。
- 最终 `make verify-increment` 五组全部退出0、无超时，237份输入（含独立审查记录）前后指纹一致；收据 `.local/delivery/I2-LOCAL-DOGFOOD-result.json`，总日志 `.local/local-dogfood/final-verification.log`。覆盖28个冻结运行专项及契约、类型、Web构建、Rust格式/静态检查和模块依赖检查；连同前面已通过的预填、索引并发、分析偏好，共31类专项。query-stop的后台立即可发送、手机抽屉正确角色等待，均在最终严格版本通过。
- 真实Flash、Mem0与现有向量配置完成代表性合成试用：Pi原生读取Skill及附件，召回本人的记忆；同会话SQL先展示再聊天执行，14行结果与独立SQLite参考一致，预览10行并实际下载；停用记忆后该对话不再采用，随后恢复启用。17次已结算真实模型调用包含工具往返与结果解释，不作为17个问题或整体准确率；自动化检查官方模型调用为0，手工记忆/语义操作使用现有embedding配置。
- 主页面跨用户协作闭环完成：Bob提文档纠错，Carol接受后另行核对并保存；公共Skill建议标记处理后附件保持原文，负责人独立编辑、保存、重新核对后才生效。浏览器证据与SHA见 `.local/local-dogfood/collaboration-evidence.json`。三个主入口、三类角色的操作、保存回读、隔离与可信失败场景覆盖见本轮试用记录。
- 本地Web/API/Pi/平台mock/Mem0健康检查均为200，Vite使用最新前端；浏览器回到Carol已完成查询的结果，未遗留编辑弹窗。保留原账号、历史及本轮合成试用对象。提交记录见上文。
- 保留的边界：真实Datasight和生产容量未验证；真实模型仅代表性流程，未穷举任意输入及并发组合。构建仍有既有单包超过500KB提示，本轮未扩展打包优化、同步缓冲或模型/记忆选型。

### 验收后的仓库交付（2026-10-11）

- 用户在本轮本地验收通过后，追加授权将全部已验证改动分批提交并推送。前文及冻结记录中的“未提交推送”描述的是验收结束时状态，本次交付沿用新的明确授权。
- 交付目标为既有 `codex/conversation-experience` 分支，远端为 [GitHub 仓库](https://github.com/yaoziyaoguai/data_agent)。按后端/Agent与契约、界面交互与回归、设计及试用记录分成三批；保持当前分支。
- 本轮84个待提交文件已逐一归组，未发现凭据、个人绝对路径或本地试用产物混入。现行完成收据与代码指纹仍一致，交付只整理提交与记录，沿用已完成验证。
- 代码批次已提交为 `2034d5f`（查询依据与Agent运行可靠性）和 `aaeeba5`（草稿保护、语义界面与回归）；第三批包含设计、README、试用审查和本记录。远端推送结果另由Git回执核对。

### 本轮验收与要求变更

- 四项既有测试按当前交互修正：query-stop只在登录首条前等待模型ready，后台查询时立即可发送断言不变；history按会话行搜索（不把删除按钮当另一个会话），60000字文档通过已确定的整篇编辑器与按名称关联入口编辑，长度/版本/关联顺序断言保留；手机角色先打开导航抽屉并等待正确角色；Skill外部改版通过既有focus事件触发刷新，避免旧30秒超时与已确定30秒空闲周期相撞。不改权限、分页、查询或保存预期。
- 新草稿专项使用本地已配置模型目录、暂停Worker，仅验证设置与消息持久化，不调用官方模型；初版未配置目录导致控件不可操作的试验已纠正。回执重试等待以待确认记录确实清除和两次同身份请求为准，不能把按钮暂时改成发送中当作完成。

## 前一增量：产品审计通用修复（2026-10-11，已完成）

- 用户已授权实施，强调通用性；沿用 dev_co。基线备份 `.local/product-repairs/before/`，保留全部既有改动。
- 先完成六项确定问题：发送重试身份、空闲请求、语义状态、会话Skill移除、命中片段、流式输出。复用现有模块与Pi，不改业务样例、不增同步范围。
- 验收使用跨领域合成资料、网络回执丢失、隐藏页面及状态变化；相关既有回归保持。未复现的记忆误用和新参考/结果标签保留为候选，不用猜测扩大本轮。
- 六项通用修复完成，[独立审查](reviews/product-repairs-review.json)通过，审查发现的删除目标发送死路、终态失败锁住Skill两项均已修复。最终 `make verify-increment` 六组完整成功、无超时，验收前后227份输入（含独立审查记录）指纹一致；收据 `.local/delivery/I2-PRODUCT-RELIABILITY-result.json`。包括8组会话、7组Skill移除及既有Pi原生Skill回归、检索10项单测及跨领域集成、流式与Pi恢复、语义状态、原页面/后台查询回归，以及262项同源契约、类型、构建、格式、静态与模块边界检查。
- 全部本轮自动化验证使用本地协议替身和合成平台，官方模型与embedding调用为0；不能据此宣布真实模型整体准确率或生产容量已验证。性能短样本与测试边界见[本轮验证记录](reviews/product-repairs-verification.md)。首次统一失败及诊断证据保留，下方说明测试租约修正依据。
- 本地服务已沿原数据库、模型、Mem0及向量配置重启到最新实现，Web/API/Pi/平台mock/Mem0健康均为200；原账号和数据保留。已查看语义整篇文档状态及查询结果/取消截图。构建仍提示既有单包超过500KB，保留为后续按测量决定的优化。本轮未提交推送；同步、记忆选型及真实准确率评测未扩大。

### 本轮验收与要求变更

- Identity/SessionReceipt新增服务端空间后，启动器登录自检也核对空间；只更新原精确相等断言，保留上一轮Carol账号补齐改动。
- 独立审查补齐待确认消息目标被删除的边界：服务端明确不可访问后解除对应本地待确认身份，原草稿保留为只读查看，不覆盖新草稿或自动重投执行意图。当前页与后台删除均先复现失败，再通过完整8组会话专项。
- Skill变更只应被仍待处理输入和有效运行权阻止。真实交付耗尽会将输入与工作置为终态failed；已应用输入此时不能撤回，继续按历史failed阻止会永久锁住选用/移除。修正该检查，保持通用pending_ids含义；M05新增只读待处理判断，允许路径和验收输入相应包含conversations模块。原failed+queued夹具不代表真实终态，补验实际失败处理、有效租约与可恢复pending边界，不放宽SQL授权、预算或恢复身份。
- 首次统一验收的会话组通过，Skill专项失败：测试将运行租约设为1500毫秒，第二次恢复进入预算检查前已过期，实际返回lease_lost，严格4次budget_exhausted断言只得到3次。诊断记录确认原运行身份未被接管，租约已过期223毫秒。测试改用Worker默认15000毫秒并按其调整等待上限，保留4次耗尽、pending阻止、终态放行、原任务/工具/预算不变断言；不改产品租约或容忍错误类型。失败收据保留 `.local/product-repairs/unified-first-failure.json`。

- 消息存储新增空间隔离后，13处既有MVP测试从旧 `data-agent.conversation.alice` 改读 `data-agent.conversation.["demo","alice"]`；这是测试观察路径变化，会话/消息/权限/执行预期不变。旧真实会话仅授权回查通过后迁移，不能为通过测试硬编码demo兼容。
- 额外运行的旧 `check-runtime.mjs` 在刷新后寻找“已保存的任务”和原始任务ID而失败；开工前备份及现行页面均已没有该展示。按早已确认的聊天界面要求，改核对原问题和新问题刷新后仍可见，并继续独立断言数据库有2任务/2工具/2正式输出。新建会话ID观察也改为用户+空间键。原失败日志保留 `.local/product-repairs/runtime-regression.log`，修正后7组通过；未修改产品行为或降低持久化/恢复断言。
- 检索、Skill和发送新增测试使用独立库/集合/端口；仅在隔离测试内注入回执丢失、状态与来源边界，不修改产品mock业务资料。

## 产品视角审计（2026-10-11，实施前评估）

- 用户要求全面审计性能、准确度和可用性并给出优先建议。本轮只读代码、历史证据与实际页面；没有开启实施增量，没有修改产品代码、配置或业务数据，没有新增模型调用。下方已完成增量和原收据保持。
- 报告：[产品、准确度与性能审计](reviews/product-audit-20261011.md)。当前确认的主要问题包括：检索命中片段位置丢失、语义来源状态不够可见、空闲高频轮询、流式输出重复读库、回执未知重试更换身份，以及会话Skill只能选用不能移除。性能热点与记忆误用风险分别注明实测、代码依据和未验证部分。
- 当前单个空闲工作台31.875秒共139次API请求，约261.65次/分钟；证据 `.local/product-audit-20261011/idle-request-sample.json`。这是短时单页测量，不代表生产容量。当前没有统一的现行端到端准确率，旧12/16、记忆对比和最新单场景试用不能合并。
- 建议先处理明确的可靠性与交互问题，再集中改善依据交付和高频口径，随后用小批当前版本内容验证决定记忆与性能投入。该评估后的实施已由用户授权，范围见上方当前增量；同步缓冲区及同步更新继续暂停，未提交推送。

## 前一增量：试用问题修复（2026-10-11，已完成）

- 用户要求修复上轮发现的全部非同步问题，并再次强调语义管理过于零散。范围为：结果统计、结果过期提示、语义目录组织、重复 SQL/结果、长历史标题、纠错全文重复。同步缓冲区与同步更新暂不讨论、不实现。
- 沿用 dev_co，保留既有账号配置与试用记录；基线备份 `.local/dogfood-repairs/before/`。本轮授权本地修复与验证，没有提交推送授权。
- M07 在现有结果读取中补充有明确范围的确定性列统计，Pi 沿用现有工具解释结果；不增加 Agent 循环或通用计算系统。M02/M12 的目录按表与独立业务资料组织，字段在表内维护；同名来源继续可辨识，不做数据合并。
- 验证以六项实际问题为依据，绑定针对性接口/浏览器测试与相关既有回归；最后独立审查和真实 Flash 代表性试用。不以本次验证声称模型达到100%正确。
- 六项修复已完成。语义管理默认按表、指标、整篇文档、术语组织目录，字段、加工 SQL 与血缘从表内进入；纠错默认突出改动部分。SQL/明细重复、长历史标题、结果过期与结果计数也已修复，原编辑、权限及执行规则保留。
- 最终 `make verify-increment` 四组验收均完整退出0、无超时，验收前后160份输入指纹一致。包含结果统计4组接口与3项单测、界面专项5组、既有体验/语义协作/后台查询/Markdown回归，以及252项同源契约、类型、构建、Rust格式和静态检查。收据 `.local/delivery/I2-DOGFOOD-READABILITY-result.json`，详细日志由收据引用；这些自动化检查使用合成平台与本地模型替身，官方模型请求为0。
- [独立审查](reviews/dogfood-readability-review.json)通过。审查发现的两项问题已修复：新增查询时保持历史渲染节点；仅按两端空白清理后的完整SQL匹配，保留字面量内空白。回归验证历史展开、横向滚动和焦点保持，以及跨100项目录分页和后页地址恢复。审查时待跑的最终统一验收现已通过，审查原记录保持。
- 真实 Flash/off 配合可执行合成数据，在同一会话完成5条用户消息：先给SQL、补充后执行、继续核对原结果。最终正确得到14行、12单、12行正支付、2行零支付，O1001/O1013各2行；14行CSV与独立SQLite参考逐字段一致。最后一回合也已验证自然语言回复不暴露统计接口字段名。原错误回合保留，不将这一个场景推导为整体准确率。证据 `.local/dogfood-repairs/real-flash-verification.json`、`real-flash-final.png` 与 `real-independent-reference.json`。
- 本地服务已更新并保持运行，Web/API/Pi/平台mock/Mem0健康检查均返回200。已查看最终目录、字段编辑、纠错差异及真实回复截图；完整说明见[修复与验证记录](reviews/dogfood-readability-verification.md)。浏览器下载控制工具超时的限制保留，实际CSV通过导出接口核对。本轮没有提交推送；同步缓冲区与同步更新继续暂停。

### 本轮验收与要求变更

- 既有产品要求、业务预期与权限断言不变。浏览器专项增加一份明确生成但未执行的SQL，因此过期场景从断言“只有1份查询”改为“总计2份、其中1份未提交”；仍验证过期不自动重跑。SQL字面量差异用浏览器响应夹具验证，不改变数据库或执行实际SQL。
- 结果统计首次接口专项将租约设为180000毫秒，超出既有120000毫秒上限，Worker拒绝启动；修正测试配置，未放宽产品限制。初次日志 `.local/dogfood-repairs/result-statistics-initial.log`。
- 新增分页测试首次在同页fragment跳转、目录尚未刷新时检查选中项。改为从工作台打开目标地址并等待目录载入，再单独核对刷新恢复；没有改变产品导航行为。初次日志 `.local/dogfood-repairs/readability-pagination-initial.log`。
- 真实Flash试用首次正确读出14/12/12/2，但两轮列举重复订单时仍漏O1001。原统计中补充本页出现超过一次的非空值及次数，保持原工具、授权与分页范围；接口专项增加O1001与O1013各2行的独立预期，不修改合成数据或降低标准。初次原回复保存在 `.local/dogfood-repairs/real-flash-result.txt` 与 `real-flash-followup-before-repeat-statistics.txt`。
- 在历史节点稳定性复查中一并消除工作台两个同级组件的重复key，仍按原用户与会话范围重置。界面专项开始捕获重复key控制台错误。
- 2026-10-10记录中的同步讨论下一步已被本轮暂停决定替代。

## 前轮：实际试用与来源同步讨论（2026-10-10）

- 用户要求先自行 dogfood，再讨论 Datasight 新表和变化表如何同步；同步方案暂不实现。本轮是试用与分析，不开启新的开发增量，不改写下方已完成增量的验收结论。
- 试用记录：[本地角色与对话试用](reviews/dogfood-20261010.md)。真实 Flash/off 的一个三轮对话，配合本地合成平台；走通文档草稿保护、Bob 提建议与 Carol 核对保存、SQL 修订后执行、10 行预览与 14 行 CSV 下载、个人 Skill 选用和公共副本发布。下载内容与独立 SQLite 参考一致。
- 当时发现：模型将 12 个订单总结为 13 个，追问后仍未改对；历史结果过期因 `AppError.code` 缺少 `result_expired`，被前端解码成技术报错。另记录负责对象目录平铺、SQL/结果重复、长对话标题和纠错全文重复的体验问题。上述问题已由2026-10-11当前增量修复，原试用证据保留。
- 来源同步只读核对：已有快照、指纹、并发基线和预填任务，但表级变化判断偏粗；仅改负责人也可能进入表及所有字段的重分析路径。尚未发现自动定时或事件接入，真实 Datasight 能力未验证。候选方向为先比较来源变化，再按影响范围处理；不引入新数据库或服务，不把候选意见写成已定方案。
- 本轮保留合成文档纠错、Carol 的试用对话及个人/公共 Skill。证据在 `.local/dogfood-20261010/`；浏览器回到 Alice 工作台，未点击来源同步或重建索引。未覆盖慢查询取消、并行查询、真实平台同步和记忆召回，未提交或推送。
- 当时的同步讨论计划已由用户2026-10-11的暂停决定替代；后续是否恢复讨论由用户决定。当前完成状态以上方增量为准。

## 本地试用账号补齐（2026-10-10，已完成）

- 用户要求提供可实际使用的语义维护者账号。启动器支持读取身份文件中的额外开发账号，保留原有凭据；`internal` 不注册为用户，重复凭据拒绝启动。
- 本地增加 Carol，由 Datasight mock 的 `maintainer_id` 将合成表 `demo_order_detail` 指定给她，并通过 `/source-syncs` 正式同步。Alice 仍为超级维护者，Bob 仍为普通用户；未改变业务权限规则或平台查询权限。
- 新建合成文档“订单明细说明（维护练习）”，Carol 为首次创建者和负责人，供用户练习编辑。身份、平台目录覆盖及验证回执均放在被 Git 忽略的 `.local/development/`，不记录凭据正文。
- 验证：启动器单测9项通过；本地五个HTTP服务健康；三账号登录与角色符合预期；Carol 创建、编辑文档后回读一致；Bob 修改该文档和 Carol 修改其他负责人表均被服务端拒绝（403），对象版本保持。证据：`.local/development/maintainer-setup/verification.json`。本轮是本地账号配置及接口验证，不替代完整产品验收。

## 前一增量：正式页面体验优化（已完成）

`goal_revision=40`，增量 `I2-EXPERIENCE-OPTIMIZATION`。用户批准 `prototype/experience-preview/preview.html`，要求按此优化正式页面，完成本地交互与 dogfood，修复问题后提交推送。

### 决定与范围

- 沿用 dev_co 和已确认原型；保留 `codex/conversation-experience` 上的全部既有改动。开工前端与测试快照在 `.local/experience-optimization/before/`。
- 复用 React、现有 Modal/Markdown 与接口，不引入 UI 框架。原型中的固定回复、数据、取消计时器不进入正式产品。
- M12 负责布局、结果展示、编辑保护、地址状态、精简依据、列表与表单。已有权限、版本、查询执行与取消事实继续由 Rust 和平台边界决定。
- 按当前可靠表标识核对重复来源；没有一致实体证据的同名表保留，并用来源/库名区分，不能按名称合并或删资料。
- 同一套本地截图复用于视觉复核。确定性合成平台和模型回归证明交互与状态，真实模型仅在需要时做代表性试用，不推导准确率。

### 验收与要求变更

- 原型确认新增离开编辑保护、固定编辑底栏、地址恢复与浏览器后退、紧凑列表/模板、结果优先与显式图表维度。原业务断言与独立数值参考保留；旧测试的页面路径和可访问名称随已确认交互调整，逐项记录。
- 测试入口更新：公共Skill通过“从我的 Skill 发布”进入个人分类；个人记忆替代原“记忆与纠错”；资产次要操作先展开详情；原直接Esc关窗场景改为明确放弃。异步回执、权限、数值、幂等断言保留，新测试另验继续编辑与取消离开。
- 旧回归中“离开语义管理后重置默认表”改为显式选择目标，依据为已确认地址恢复要求；手机退出改从导航抽屉进入；字段heading改为紧凑行summary。资产检索成功的技术提示已隐藏，测试改为核对真实接口 `memory_index_state=indexed`，仍要求索引完成。
- 原金额结果绘图断言改为无分类时禁止绘图，依据为已确认“不能把两个金额列互作分类”要求；图表正例保留在含文本分类的明细查询，新增负数和超大整数验证。横向滚动验证改到确有溢出的390px视口，原滚动经轮询保持、完整CSV与精度断言不减。
- 前一增量中的“不提交推送”仅约束当时工作；本轮用户明确授权本地验收后提交推送。

- 历史接口仅补可选的真实 `created_at` 字段，前端注明创建时间帮助区分同名会话；没有现成更新时间，不能伪造“最近更新”。不改变原排序、分页和访问权限，无数据库迁移。

### 当前进度

正式页面已落地：结果优先、精简依据、紧凑输入区/资产列表、文档目录与预览、统一未保存保护、地址状态、移动导航；历史使用真实创建时间。短屏发送、保存中离页保护、目录筛选绕过保护、同页后退窗口残留、相同地址重新选择和文档旧回执覆盖新编辑均已修正。提交前复验发现的新建对象被旧筛选切走问题也已修复；独立补审及当前版本的五组统一验收全部通过，本轮本地优化与 dogfood 完成。

- 文档保存的编辑实例单独标识，用户明确放弃后旧回执不关闭新草稿；服务端已提交内容由正常轮询读取。保存失败仍保留输入，离开前不提前清除未保存状态。
- 平台当前文本列类型为 `text`，图表候选遗漏此类型会错误禁用绘图，已补兼容；双金额结果没有分类仍不绘图，超大整数不转浮点，原表格/下载保持原值。
- 视觉复核指出手机目录字号与当前对象定位问题，已修正；桌面截图改为等待实际内容加载完成。删掉重复空态创建按钮、归属说明和工作台重复标语。
- 旧测试观察器修正：页面登录后先等待工作区挂载再判断手机导航；建议提交仅统计已保存的建议行，不能把仍在输入框中的文字算作第二条成功；新对话使用实际按钮角色。修改的是观察时机与入口，不改变保存/权限标准。
- 模型选择定向回归6组通过：38次本地HTTP替身请求，官方请求0；Flash/Pro七种受支持档位、同一Pi会话、设置保存失败、并发和旧请求恢复均保持。证据 `.local/experience-optimization/model-current.log`。
- 本轮定向证据：`.local/experience-optimization/experience-current.log`、`report.json`、`background.log`、`types-current.log`。合成平台/本地模型替身；官方模型请求0。

- 首次统一验收的关联资料脚本在业务操作前发生Pi桥启动超时：诊断仅到 `imports_started`，API已健康，60秒内未完成导入。当时8核机器的1分钟负载35.32；后续同入口的管理与聊天脚本正常通过。源代码、测试断言和超时均保持，按同一冻结版本复验；首次失败日志保留在 `.local/delivery/I2-EXPERIENCE-OPTIMIZATION-1791623712607311000/`，启动诊断在 `.local/checks/mvp-a0ff8bfd96758449/startup-failure.json`，不把该轮记为通过。

- 提交前清理新增文档组件的一处行尾空格，补审发现同时误删的JSX闭合符，已恢复；精确字节核对确认最终仅删除空格。原成功收据保留在 `.local/experience-optimization/before-whitespace-cleanup-result.json`。随后复验的14个脚本有12个通过：语义角色脚本暴露新建对象受旧筛选影响的问题，工作台脚本在Pi导入时超时。失败日志 `.local/delivery/I2-EXPERIENCE-OPTIMIZATION-1791625382191891000/`；启动诊断 `.local/checks/mvp-f4b922a251725a9d/startup-failure.json`。
- 新建对象问题：原名称/状态筛选在保存后继续刷新目录，可能把刚创建的指标切回旧文档。补充断言先稳定失败，见 `.local/experience-optimization/creation-filter-before-fix/reproduction.log`。修复限定在创建成功时重置目录筛选并定位新对象；从按表浏览进入我负责的对象，其他范围保留。普通停用/启用仍保留筛选，不修改服务端角色与权限。新断言补充原有“创建后显示新对象”要求，原权限、停用恢复和布局断言不减。
- 修后角色定向回归6组通过，见 `.local/experience-optimization/creation-filter-fixed.log`。Pi依赖独立导入10,497ms成功；随后复用Node自带编译缓存减少重复冷导入，工作台9组定向检查完整退出0，见 `pi-import-timing.json`、`pi-import-cache-warmup.json`、`browser-startup-recheck.log`（同目录）。没有修改服务启动60秒阈值、业务断言或Pi实现，新增官方调用0。最终统一验收也沿用该本地编译缓存环境；缓存不纳入Git。

### 最终验收与交付

- 最终 `make verify-increment` 于2026-10-10完整退出0，五条命令全部通过、无超时，执行前后契约、输入和审查指纹一致。当前成功收据 `.local/delivery/I2-EXPERIENCE-OPTIMIZATION-result.json`；完整日志 `.local/delivery/I2-EXPERIENCE-OPTIMIZATION-1791626338862498000/command-01.log` 至 `command-05.log`。之前的成功与失败记录均按上文路径保留，没有改写历史结果。
- 当前版本的新体验专项7组、14个既有UI业务脚本、后台多查询7组、模型选择6组全部通过。覆盖编辑保护与旧回执、新建对象清除旧筛选、桌面/手机导航与短屏输入、权限与协作、10行预览/完整保存结果下载/精度、滚动位置、后台续聊与单独停止，以及Flash/Pro选择和Pi会话保持。
- 同源契约245个正反例、TypeScript类型、Web生产构建和Rust Clippy均通过。Vite报告主脚本701.29kB（gzip 201.20kB）的分块大小提示，构建成功；打包拆分不属于本轮交互范围。
- 独立代码审查见 `docs/reviews/experience-optimization-review.json`，范围SHA256为 `e8c41c9a2d391c4dfd704612e25a53399b79e738ecd5959c7f3347f51b17e638`，8项发现均已关闭。审查记录中的待统一验收是审查时状态，现由上述最终收据补齐。视觉复核和正式服务手动试用见 `docs/reviews/experience-optimization-visual.md`，README截图已更新。
- 正式本地页面 `http://127.0.0.1:5173/` 保留，可刷新继续试用；未替换现有身份、会话、Mem0或向量配置。本轮新增官方模型与向量调用均为0，最终模型选择回归使用38次本地HTTP协议替身请求。
- 本轮证据使用合成资料、隔离MySQL、平台/模型替身及正式React/API，覆盖已列流程；不代表真实Datasight、真实模型内容质量、Safari/Firefox或屏幕阅读器验收。已修复所发现的阻塞问题，不声称覆盖所有可能场景。
- Git交付分三批：`2a6c941` 为后端、迁移与同源契约，`5ca7c2d` 为正式界面及行为回归，本记录所在提交为设计、README、原型、截图与审查证据。交付分支为 `codex/conversation-experience`，推送目标为 `origin`；包含此前已完成的相关增量。

## 前一增量：对话模型与思考选择（已完成）

`goal_revision=39`，增量 `I2-CONVERSATION-MODEL`。用户确认在输入框右上角选择DeepSeek Flash或Pro以及该模型支持的思考强度，要求实现并本地验证。

### 决定与范围

- 独立审查定位Pro配置经过辅助调用预算转换时被旧Flash限定拒绝，会影响语义向量与Mem0。修复仅允许两种已验证的聊天配置共享原预算引用；辅助调用仍使用原Flash/百炼配置和计价，补预算转换边界检查，不改变记忆或检索产品规则。

- 沿用dev_co；保留原工作树，开工快照 `.local/model-selection/before/`。同一Pi会话继续，多模型使用同一已配置DeepSeek凭据；不读出或展示密钥。
- M05保存本人对话选择及版本；M08从可信默认配置生成可选档位和运行配置。客户端不提交端点、密钥、价格或预算。消息接受时冻结配置到现有budget_scopes，重放/恢复/查询结果解释继续沿原记录。
- 用户选择立刻保存到已存在对话；新对话随首次消息保存。并发设置按版本核对，保存中暂停发送但不影响后台SQL；每条消息显式携带当时选择，避免设置变化影响已发送请求。
- 当前锁定Pi 1.0.0模型目录支持Flash的off/low/high/max及Pro的off/high/max；官方思考文档与SDK均支持max。页面中文为关闭/轻度/深度/最高，只展示各模型支持项。模型切换时原档位不支持则回到关闭并清楚显示；默认仍沿启动配置。
- 验证先使用现有隔离MySQL、实际Pi SDK和本地HTTP协议替身；最后用合成内容做有界真实Flash/Pro切换试用，逐项记录，不能用协议测试代替真实服务结论。

### 本轮验证记录

- 首次协议集成测试停在 `message_pending`：新HTTP替身只检索后直接回复，遗漏真实Agent契约要求的消息归属。修正替身补 `update_analysis_task route`，普通消息与查询通知均完成归属；原产品断言和验收标准不变。失败报告、日志、截图和测试源归档 `.local/model-selection/fixture-routing-before-fix/`。

- 第二次检查已完成两轮Pi交付，但新断言误要求跨模型仍使用 `reasoning_content` 字段。锁定Pi 1.0.0的 `api/transform-messages.js` 明确将跨模型非加密思考转换为文本；修正为验证历史保留，并在同模型工具续调逐次验证 `reasoning_content`，继续复用SDK。原错误断言及失败证据归档 `.local/model-selection/cross-model-reasoning-before-fix/`；不修改产品实现或降低历史保留要求。

- 新测试检查Pi会话ID时使用了不存在的检查点表列。按既有migration及后台查询测试，通过 `agent_runs.recovery_chain_id` 查检查点，要求两轮均有非空相同session ID；断言更明确，产品代码不变。原观察SQL和失败日志归档 `.local/model-selection/checkpoint-observer-before-fix/`。

- 第13轮模型参数测试的合成历史超过请求体门槛：替身每条无关聊天都重复取回约3KB净收入资料，且固定虚构usage无法模拟真实压缩时机。移除与模型选择无关的重复检索，仅保留每轮真实 `route` 工具续调；七档、同会话、并发、后台SQL、恢复与所有原断言不减。完整检索仍由原DATA-PROVIDER验收负责，不把本用例当长上下文压缩验收。失败证据归档 `.local/model-selection/fixture-size-before-fix/`。

- 减少无关检索后原生压缩仍触发。进一步定位替身缺少无工具摘要分支，错误地给Pi压缩请求返回工具调用；补纯文本合成摘要，产品与历史保留断言不改，归档 `.local/model-selection/compaction-fixture-before-fix/`。
- 按独立审查纠正模型设置GET的额外行锁：M05用单条只读查询校验用户、空间和未删除状态；保存和接受消息继续同会话写锁。

- 定向模型选择检查已通过，6组行为、38次本地协议请求、官方请求0；恢复保留原模型、消息、链与预算，浏览器桌面/窄屏及失败回读通过。稳定证据 `.local/model-selection/verified/`；同源契约243例、类型检查和Web构建通过。新增绑定既有原生压缩回归，不用协议摘要替身声称真实长对话质量。

- 既有原生压缩回归通过：24轮中文历史后继续6轮，同Pi会话、4次压缩、18次本地协议调用，原预算与撤权拒绝保持，官方调用0；证据 `.local/model-selection/compaction.log`。
- 用户常驻服务已按原参数重启，保留原数据库、身份、试验、Mem0和百炼/Milvus配置。真实浏览器以Flash/off → Pro/high → Flash/low完成同一会话三轮，三次都正确复述合成标记，未提交SQL，刷新保持Flash/low。实际10次官方调用（7次Agent生成、3次个人记忆召回向量）均结算，保守账本金额US$0.056890（不是服务商折扣账单）；证据 `.local/model-selection/real-report.json`、`real-desktop.png`。真实验证仅这三种组合，其余档位有SDK协议验证。
- README、系统设计、HTTP契约、M05/M08/M11/M12边界和开发说明已同步。独立审查与五项统一验收均已通过；原模型供应商、记忆/向量配置和已运行查询规则保持，本轮未提交推送。

- 首次统一验收的MODEL-SELECTION和DATA-PROVIDER通过；后台回归在首次登录后立即断言发送可用时失败。新增模型目录读取完成前，页面按既定规则暂停发送；该观察器未等待首次配置加载。仅首条消息增加明确就绪等待，其后所有“SQL运行中可立即发送”的原断言保持，也不改产品。原测试、截图、审查和失败统一收据归档 `.local/model-selection/initial-ready-before-fix/`，重审此窄改动后按原五项验收重跑。

### 交付结论

- `make verify-increment` 五项全部退出0：模型选择、原14工具提供者协议、后台多查询浏览器、Pi原生压缩、同源契约/类型/Web构建/Rust检查。契约正反例243条通过，辅助预算单测通过；有效收据 `.local/delivery/I2-CONVERSATION-MODEL-result.json` 与独立审查 `docs/reviews/model-selection-review.json` 对应当前输入。
- 本地工作台 `http://127.0.0.1:5173/` 已更新，可以继续试用；模型与思考选择随本人对话保存，从下一条消息生效。后台SQL及原请求恢复沿原配置；旧对话默认使用现有服务配置。
- 真实服务只验证Flash/off、Pro/high、Flash/low三种代表组合；其余档位通过Pi SDK实际HTTP协议测试。查询使用合成SQLite，Datasight仍为mock，本轮没有新增真实平台或完整Mem0写入验收。没有待定产品决策，后续按用户试用反馈处理。

## 上轮交付：手动停止SQL的反馈（已完成）

`goal_revision=38`，增量 `I2-QUERY-STOP-FEEDBACK`。按用户要求实际dogfood运行中的SQL手动停止。现有停止按钮可用：在隔离实例通过真实浏览器聊天启动两条查询，停止收入查询后客户数查询仍运行，草稿与续聊保持。随后暂停本次合成平台，确认停止请求未完成时错误显示`outcome_unknown`及“提交结果待查证”；恢复平台后查询正常取消。

### 验收与要求变更

- 沿用dev_co的局部修复与验证约定。只修M12停止等待的展示，不变更既定取消规则、状态契约或平台适配器。用户停止具体SQL的入口继续保留。
- 已复现证据 `.local/dogfood-query-stop/first-stop-observation.json`、`first-stop-server-state.json`、`pending-before.json`、`pending-before.jpg`、`pending-server-state.json`；实际使用隔离MySQL、可执行合成SQLite和Pi SDK合成模型，无官方调用。合成模型回复中的技术状态词不作为真实DeepSeek输出质量证据。
- 新检查覆盖平台短暂不可用时的等待反馈、刷新、恢复及唯一通知；原后台浏览器检查不修改。既有业务要求不变，只新增失败边界的观察断言。
- 开工快照 `.local/dogfood-query-stop/before/` 保存前一增量输入及记录。原工作树及已完成审查保留；前一增量已完成结果只作历史。
- QueryCard已优先展示取消待确认状态，未知回执使用中文说明；服务端状态、终态优先和停止请求规则保持。正式浏览器三组检查通过，原始报告和截图归档 `.local/dogfood-query-stop/verified-before-unified/`，不被统一验收覆盖。
- 修复后在Codex浏览器再次从聊天启动第三条查询、真实点击停止，重复平台中断/刷新/恢复。`.local/dogfood-query-stop/report.json`、`pending-after.json`、`final-observation.json`及同目录截图记录结果；服务端和合成平台均确认三条查询取消完成，各一条通知、三条平台提交记录，草稿保留。临时实例和试用页已关闭，现有用户试用实例未停止。
- 独立审查 `docs/reviews/query-stop-feedback-review.json` 已保存并通过范围核对，额外验证10种组件状态，确认真实终态优先。页面等待修正后的三组定向检查通过，稳定证据 `.local/dogfood-query-stop/verified-ui-ready/`；冻结范围的三项统一验收已全部通过。新增模型官方调用0，不将合成平台取消推广为真实Datasight数据库引擎取消能力。
- 首次统一验收在新测试的两个停止按钮计数处失败：服务端已running，但截图中第二条查询仍显示上一次轮询的SQL草稿。新观察器遗漏等待第二个目标按钮出现，不能以服务端已更新代替页面已刷新。补目标按钮和通知可见等待，原“两个按钮”“两条唯一通知”等断言保持不变；产品源码未改。失败收据、截图、旧测试及当时审查归档 `.local/dogfood-query-stop/ui-observer-before-fix/`，按原三项重新验收。


### 交付结果与验证边界

- 三项统一验收全部完整退出0、无超时，验收前后指纹一致：手动停止三组、原后台查询七组、TypeScript与Web构建。收据 `.local/delivery/I2-QUERY-STOP-FEEDBACK-result.json`，完整日志由收据引用；最终报告及截图归档 `.local/dogfood-query-stop/final-acceptance/`。首次观察器失败的收据与截图单独保留，不被通过证据覆盖。
- 独立审查 `docs/reviews/query-stop-feedback-review.json` 已通过，无剩余确定性问题，额外核对10种渲染状态，包括停止请求与成功/失败竞争时优先展示平台真实终态。仅修QueryCard提示、新增定向验收与开发说明；Agent、后端、取消权限及状态机保持既定实现。
- 停止入口位于每条排队或运行SQL卡片右上角；只停止选中查询，其他查询、输入草稿及续聊保持。平台未确认时显示“正在停止查询”，禁用重复点击；平台恢复并确认后才显示已取消、写入唯一通知。该入口与输入框的“停止生成”分别作用于SQL和Agent回复。
- 本地 `http://127.0.0.1:5173/` 已提供新版QueryCard，证据 `.local/dogfood-query-stop/local-ui-update.json`。没有重启用户后端或更改用户试用数据。手动dogfood和统一验收均使用Pi SDK、合成模型、隔离MySQL及可执行合成SQLite，官方模型调用0；真实Datasight数据库引擎的取消接口未验证。
- 本轮增量完成；用户可继续试用。没有提交、推送或扩大产品范围，原工作树修改完整保留。

## 上轮交付：查看依据后返回对话（已完成）

`goal_revision=37`，增量 `I2-EVIDENCE-RETURN`，沿用 `codex/conversation-experience`。用户反馈SQL口径依据会跳走，缺少返回原对话阅读位置的入口。根因是App切换页面时卸载Workbench，滚动、展开及结果视图被重建。局部改为在原对话上打开资料窗口，固定“返回对话”按钮，关闭后恢复原触发入口焦点；原工作台持续挂载，复用现有语义读取与维护权限。

### 验收与要求变更

- 本轮仅M12导航与资料查看窗口；继续沿用dev_co核心约定、现有Modal及KnowledgePage，不增加后端接口或改Agent。直接进入语义管理保持独立页面。
- 验证指标/文档打开和返回、Escape、桌面/窄屏、草稿/SQL展开/表格位置保留，以及窗口打开时后台查询继续。使用合成资料与模型，不追加真实模型测量。
- 开工快照 `.local/evidence-return/before/` 记录此前文件，保留原工作树全部修改。旧后台查询验收与审查作为上一增量历史保留。
- 首次浏览器验收在返回焦点断言失败，原证据归档 `.local/evidence-return/failed-focus-before-repair/`。独立审查同时复现嵌套编辑Escape关闭两层窗口：卸载时ref已清空、未关闭原dialog节点，且React的cancel事件冒泡。局部修复捕获原dialog节点用于清理，并阻止cancel冒泡；保留原焦点、位置和嵌套行为断言，正在复验。
- 返回路径修复后首轮四组断言通过，但看图发现截图早于资料加载完成。将等待条件从通用容器加强为指定指标/文档标题可见，并补内层关闭后的焦点断言；原要求和断言不变，继续验证实际内容显示及返回。
- 补强后的正式浏览器四组全部通过，`.local/checks/evidence-return/report.json` 与 `.local/evidence-return/browser-content-ready.log` 保存完整结果；已查看桌面实际文档、窄屏滚动后资料及返回截图。图册29图生成与溢出检查通过。本地Vite已提供新版App/Modal（`.local/evidence-return/local-ui-update.json`）；未重启后端或修改试用库。待独立审查最终保存后运行三项统一验收。
- 独立审查 `docs/reviews/evidence-return-review.json` 已完整保存并通过范围核对，未发现剩余确定性问题；额外以实际Modal/CSS验证桌面、手机与短视口。三项统一验收已在冻结实现上启动，日志 `.local/evidence-return/increment.log`；材料静态核对314项通过。增量仍active，等待完整收据。

### 交付结果与验证边界

- 三项统一验收全部完整退出0、无超时，前后范围指纹一致：新增依据返回四组、原后台查询七组、TypeScript与Web构建。收据 `.local/delivery/I2-EVIDENCE-RETURN-result.json`，逐项完整日志保存在收据引用的目录。
- 本轮只修改App资料窗口、共用Modal的关闭行为及局部CSS；原工作台和KnowledgePage继续复用。桌面、窄屏、短视口和嵌套编辑返回均有实际Chromium证据；没有更改Agent、后端、数据权限或查询规则。
- 最终统一验收重生成的页面截图与报告归档 `.local/evidence-return/final-acceptance/`；独立审查记录中的截图SHA是审查时的上一轮产物，不混作最终运行截图。原失败与加载中截图另行保留。
- 本地 `http://127.0.0.1:5173/` 已提供新版前端；原试用数据与后端进程保持。本轮使用隔离MySQL、可执行合成SQLite与模型测试替身，新增官方模型调用0；未验证Safari/Firefox、屏幕阅读器或真实平台。
- 本轮增量关闭，继续等待用户试用反馈。没有提交、推送或扩大产品范围。

## 上轮交付：查询后台运行与结果预览（已完成）

`goal_revision=36`，增量 `I2-BACKGROUND-QUERIES`，沿用 `codex/conversation-experience`。用户明确要求SQL执行不锁聊天，同一会话可发起多条查询，查询在独立小组件中运行，完成后在对话通知；结果预览10行并可下载。按 dev_co 复用已有Pi串行会话和Rust后台查询，不新增Agent框架。

### 验收与要求变更

- 完成记录会在最终验收后更新，因此不把CURRENT全文列为冻结的实现输入；交付契约、需求绑定、18项已确认决定仍由检查器独立计算指纹，产品、测试、设计与审查记录保持冻结。验收命令和行为断言不变。
- 后台浏览器的API重启后截图暴露自动读取错误残留。对话轮询单独保存可重试读取状态，恢复后只清这项提示，不清发送/取消等操作错误；补读取失败与发送失败并存的浏览器验证。正式截图在刷新恢复结果后拍摄。
- 独立审查补出两项本轮展示边界：旧SQL折叠时通知无法定位，已选方法较多时固定布局挤没消息区。分别修为定位前展开目标旧稿、已选方法区限制高度并可滚动。未改变Skill选择规则。通知回归首次选择器同时匹配两条取消通知，失败保留在 `.local/background-queries/notice-test-observer/`；改为按测试预先命名的目标查询定位，不放宽展开/焦点断言。

- 修复前独立宿主试验证明未提交和排队查询取消都缺少通知。HTTP/Pi取消改为共用现有终态记录与幂等，尚未提交的本地取消不启动模型解释；后续实测两种取消均只有一条通知。原报告 `.local/background-queries/query-state-before-fix/` 保留。
- 四项长查询第一次偶然全部进入running，第二次实测前三项运行、第四项10秒后仍排队，失败保留在 `.local/background-queries/query-fairness-before-fix/`。原因是按创建时间领取使旧查询反复先被轮询；改为按租约到期时间、创建时间和ID排序，未领取的请求优先，保留租约、代次和行锁规则。修复后须重新验证，不以第一次通过覆盖复现失败。
- 事件按页读取：若查询确认事件位于尚未加载的历史页，组件暂置顶部，加载该页后恢复到真实位置。已加载的确认事件位置稳定；更早消息补页需保持阅读锚点，不宣称未加载历史也能精确定位。

- 独立审查确认待提交查询本地取消后没有持久终态事件，Worker不再领取该终态，因而不会通知；补入同一业务用例的终态记录。另补更早页阅读锚点、短高度可滚达发送按钮及四项长查询领取公平性验证。均为当前后台查询流程的边界，不新增调度器或Agent循环。

- 可控慢查询已证明A运行期间续聊、启动B和服务重启保持身份；第二次实测复现B完成后展开结果挤走输入区。修复范围补工作台独立消息滚动与固定输入区，不改其他页面布局。失败产物 `.local/background-queries/composer-displacement/` 保留。

- 首次后台浏览器检查前两组通过，第三组观察器把支付客户数误写为4，独立参考 `docs/sources/evaluation/cases.json` Q02 明确为5；产品实际为5。测试改为读取原有独立参考，不依据产品输出生成预期。失败产物保留 `.local/background-queries/first-observer-failure/`；未放宽结果归属/金额断言。

- 原页面展示100行并可“加载下一页”；新页面只预览前10行，图表采用同一预览范围。原结果接口分页、SQL本身、CSV同查询结果下载均保持，平台超过1000行的截断须明确显示；不能把SQL改成LIMIT 10，也不声称完整下载超出平台保存范围的数据。
- 原查询跟随最新状态事件移动；新查询在确认后固定在对话位置，终态事件单独显示可回到原查询的通知。页面刷新和重叠事件不重复通知，查询完成不抢输入焦点或清掉草稿。
- 验证先使用可控慢查询和合成模型/平台，证明同会话A运行时可续聊、可提交B、B先结束，SQL/参数/结果和取消相互隔离；随后核对常驻服务。原真实模型意图小样只作历史，本轮不声称重测模型准确率。
- 开工快照 `.local/background-queries/before/`；之前全部未提交修改保留。上一增量的审查/收据仍为历史，不用于宣称本轮完成。

### 本轮定向验证

- 后台浏览器7组通过：同一Pi会话内A/B/C三项查询运行、续聊、反序完成、单独停止、API/Worker重启与刷新恢复；原SQL/参数/结果保持，草稿/焦点/阅读位置保持，短视口与读取失败恢复通过。`.local/checks/background-queries/report.json`，使用Pi SDK、合成模型、MySQL和真实执行SQL的合成SQLite，官方模型调用0。
- 查询状态3组通过：四项长查询全部进入running，未提交和排队取消各写唯一终态通知且不提交平台。`.local/checks/background-query-state/report.json`。查询边界10组通过，涵盖10行预览、25/5/0/1000行CSV、失败/截断、精确数值、横向滚动、折叠旧稿通知定位及1101事件补页阅读位置；`.local/checks/mvp-query-boundaries.json`。
- 独立审查者另验平台已成功但应用仍运行时点击停止：最终保持成功、唯一结果事件/解释输入，SQL结果正确。`.local/background-queries-review/host-state/report.json`。多项Skill选择的消息区挤压和旧稿定位均已独立复验修复；未改Skill业务规则。
- Rust格式/Clippy、TypeScript、Web构建及225项同源契约通过；29张架构图渲染检查通过。README替换为实际SQL、下载与固定输入区的正式浏览器截图；设计、模块边界和开发说明已同步。常驻服务已加载新的Rust实现：`.local/background-queries/local-service-update.json`记录五个服务均健康，41个对话、26条查询及身份/模型/记忆/向量配置保持；继续使用DeepSeek Flash、Mem0和百炼混合检索。

### 最终验收与交付

- 独立审查 `docs/reviews/background-queries-review.json` 通过，无剩余确定性阻断，scope `2020863059593331c00596e16e36c62d2239704e610e73328a98e6eae8e3549a`。审查者未参与本轮产品实现，独立复验取消/成功竞争、四查询领取、消息阅读锚点、短视口、方法长列表与旧稿定位。
- `make verify-increment` 七项绑定验收全部完整退出0，无超时，代码、契约、测试、设计及审查记录的前后指纹一致。收据 `.local/delivery/I2-BACKGROUND-QUERIES-result.json`，逐命令日志在 `.local/delivery/I2-BACKGROUND-QUERIES-1791540277961891000/`。覆盖本轮后台查询、状态边界、时间线、原聊天执行、结果/下载、工作台与代码契约；不是全部真实业务或任意并发负载的验收。
- 314项材料、模块依赖/SQL归属、锁序和29张架构图检查通过。README、系统设计、模块/交互图及开发指南已同步。本轮使用合成模型与可执行合成SQLite，官方模型调用0；没有重新测量真实模型准确率，真实Datasight仍未接入。
- 本地服务 `http://127.0.0.1:5173/` 已更新，五个服务健康，41个对话、26条查询及原身份/Flash/Mem0/检索配置保持。查询后台独立执行，Pi继续串行推进同一会话；表格/图表预览10行，CSV下载已保存结果（合成平台最多1000行）。历史确认事件未加载时的暂时定位限制保留在设计中。
- 本增量完成，用户可继续本地试用。本轮未提交或推送，此前工作树修改完整保留。

## 上轮交付：通过聊天执行 SQL（已完成）

`goal_revision=35`，增量 `I2-CONVERSATIONAL-QUERY`，沿用 `codex/conversation-experience`。用户明确批准执行意图来自聊天：先展示SQL；“执行上面这条”执行，“改成二月再执行”修订后执行，单纯补充条件只修订，含糊才澄清。SQL代码框右上复制，默认去掉补充/执行/取消按钮排；运行中保留停止；完成后直接展示结果和最终实际执行SQL。使用 dev_co 核心约定，先核对现有事务与Pi工具、再完成实现和针对性验收。

### 本轮验收与要求变更

- 用户2026-10-09明确决定替代原第15节“只能点按钮确认具体SQL”的规则。聊天中的明确执行意图可授权本次具体查询；“修改后执行”授权应用同条消息中的修改后再执行，无需追加按钮确认。权限、只读、版本绑定、并发暂停及幂等保留。
- Pi负责意图和指代判断；Rust核对真实源消息、会话/任务/当前版本、明确工具交付及查询有效性。完整原话匹配只证明依据来源，不声称程序能完全证明自然语言理解正确。模型意图样本与宿主确定性控制分别报告。
- 原浏览器点击“执行查询”“补充或纠正”的验收改为实际发送聊天并验证最终SQL与结果；参数、金额、身份和版本预期保留。原确认API仍供显式客户端请求使用，前端不再展示其按钮。
- 本轮只使用从零构造的样例。真实Flash小样沿用已授权端点/模型，先做代表性样本；无模型比较或费用上限扩展。开工快照 `.local/conversational-query/before/`，保留此前全部未提交改动。

实现、独立审查及8项统一验收已完成。审查发现的两项容量问题及重复结果交付均已修复并独立复验；常驻服务已更新，保留原会话、身份及模型/记忆/向量配置。

- `execute_query`复用现有M07确认事务，首次执行绑定真实消息与其预算，原消息同事务标为已应用；稳定SDK调用先接回持久回执。输入只接受查询ID、草稿/条件版本和完整当前原话。普通补充只修订、明确执行才提交；已有确认重复调用不改变授权或预算。
- Web移除SQL动作按钮排和任务引用，代码框右上复制SQL及JSON注释参数，查询成功自动读结果并显示实际SQL；运行中可停止。查询按最新确认/结果事件定位，稳定组件key保留表格分页和滚动。
- 消息与完整执行引用上限从8,000改为32,000字符，并同步RunEnvelope/ChatMessage，支持现有24,000字符SQL加常规参数的粘贴。DeepSeek工具数限制从13改为14，原因是本轮新增`execute_query`，原协议测试相应核对该工具；不是放宽工具权限。
- 设计、API、AGENTS、开发指南、README与模块/时序图已同步。图册原先新增的文档图没有编号，导致渲染器拒绝；将该图标为V04并移到独立视图后，复用原渲染器通过29图检查，没有修改渲染规则。生成图中部分ID变化来自图册再生成。
- 本轮后台测试故障注入中，曾在Worker写入运行后、送达测试捕获器前将它关闭，造成等待捕获超时；已按该故障证据修正测试的等待点，保留全部断言，未更改产品租约或恢复规则。
- 独立审查复现32,000字符上限与旧MySQL `TEXT`字节容量不匹配：21,846个中文字符通过契约却保存失败（证据`.local/conversational-query-review/message-capacity.json`）。增加后续迁移将消息正文升为`MEDIUMTEXT`，保留已应用迁移，补最大中文消息保存、运行、重启回读和超限拒绝验收；产品上限不变，原断言不放宽。修复后8组宿主检查完整退出0，日志`.local/conversational-query/message-capacity-fix.log`。新增嵌入迁移在本机增量构建中未被自动检测，已触发迁移加载源码重新编译（内容不变）后实测；长消息测试补足原有必需的任务归属后完成回读，未绕过业务校验。

- 独立审查进一步复现已允许的24,000字符SQL与旧`query_requests.sql_text TEXT`容量不匹配：含中文的只读SQL检查通过却保存失败（证据`.local/conversational-query-review/additional-boundaries.json`）。后续迁移将该列升为`MEDIUMTEXT`，在同组验收中补满长度SQL的检查、保存及重启回读。两项容量修复后的8组宿主检查完整退出0（`.local/conversational-query/sql-capacity-fix.log`），未提高输入上限或改变执行规则。

- 本地真实普通提问→执行试用得到1600分，但执行轮主动读取终态结果、Worker又交付结果通知，造成两段完整解释。第三项修复复用已有`confirmation_message_id`：`get_query`在外部读取前及最终事务识别确认来源消息，保留真实状态但暂不交付结果；同消息新run恢复仍适用。结果事件和后续追问正常读取。Pi完成本消息所需的全部提交后结束本轮，不新增调度器或去重状态。9组宿主验证完整通过（`.local/conversational-query/result-delivery-fix.log`）；旧重复及一次退款时间说明矛盾保留在`.local/conversational-query-review/duplicate-result-before-fix.json`，不把数值通过等同于文字完全正确。

定向证据：`.local/checks/conversational-query.json`的9组宿主边界、`.local/checks/conversation-experience/report.json`的4组浏览器流程、原查询边界7组、工作台9组、管理操作6组均通过。真实Pi协议携带14个工具的15次回环调用通过；Rust格式/Clippy、TypeScript、Web构建、225项同源契约及313项材料检查通过。以上使用隔离MySQL与可执行合成SQLite，确定性测试没有真实模型调用。

前一冻结版本的真实DeepSeek Flash试用：`.local/conversational-query/real-2026-10-09T08-28-05-852Z/report.json`，7组通过，41次调用，费用US$0.211132。覆盖普通取数只给SQL、否定与引用不执行、只修改不执行、自然指代执行的1600分独立参考、粘贴参数SQL并修改后执行、多候选澄清、续答只执行所选查询。真实模型与合成平台分别标识，7组小样不证明任意自然语言100%正确；没有使用Mem0/向量来替代执行意图判断。报告保存对应源码哈希，真实试用不加入普通验证命令自动重跑。 随后的结果交付修复修改了提示词、工具说明和get_query边界；原7组是修复前的意图小样，保留原产物与判分，不声称与最终代码完全同版。修复后快查询在常驻Flash/Mem0/hybrid服务另做针对性真实复验。


修复后常驻真实试用：`.local/conversational-query/local-smoke.json`记录不带“不要执行”限定的普通提问先产生待执行SQL，再说“执行上面这条”取得1600分及16元；SQL/参数与原稿一致，只有结果交付轮解释一次，退款时间说明与SQL口径相符。临时观察器最初误限单列，失败原报告保存在`local-smoke-observer-failure.json`；独立审查确认额外元列是同一SUM显式除以100，改按列名核对独立数值后只读回收同一会话，没有重发模型请求。此观察器修正没有改变用户要求或正式验收脚本。新报告绑定7份源码SHA；旧7组意图测量仍按前一版本保留。

常驻服务证据：`.local/conversational-query/local-service-update.json`，API/Pi/Web/平台/Mem0均健康；三个新迁移生效。重启保留当时已有40个对话、25条查询以及4份身份/模型/记忆/向量配置SHA，继续使用Flash、Mem0及百炼混合检索；新增真实试用单独创建合成对话。


### 最终验收与交付

- 独立审查：`docs/reviews/conversational-query-execution-review.json`为passed，冻结scope `2ad17eb7ae652106088fb392eb2608a32b1aaa20125739cbf49fbc9a008e4021`。三项确定问题均已修复，审查复核了容量上下界、停用依据拒绝、结果交付与同消息恢复；没有剩余确定性阻断。
- `make verify-increment`的8项绑定验收全部完整退出0、无超时，执行前后指纹一致。收据`.local/delivery/I2-CONVERSATIONAL-QUERY-result.json`，逐项日志在`.local/delivery/I2-CONVERSATIONAL-QUERY-1791537004625396000/`；9组宿主边界、4组聊天界面流程、原查询与管理回归、225项同源契约、代码构建和14工具Pi协议均通过。此轮统一验收无真实模型调用。
- 29张架构图检查、313项材料检查、模块依赖/SQL归属检查及差异空白检查通过。README截图、系统设计、API、模块边界、时序图和开发说明已同步。普通取数、明确执行和单次结果解释的最终真实Flash样本见上方，旧7组按原测量版本保留；不据小样声称自然语言全部正确。
- 本地工作台`http://127.0.0.1:5173/`已运行最终实现，可刷新后继续试用。真实Datasight与正式身份接入仍待后续验证。本轮未提交或推送，原先未提交改动完整保留。

## 上轮交付：账号区显示最高角色（已完成）

`goal_revision=34`，增量 `I2-WORKSPACE-ROLE`，沿用 `codex/conversation-experience`。截图中的用户名旁增加当前空间最高语义角色。按现有身份和归属展示普通用户、语义维护者、超级维护者；维护者包括表和独立指标/文档负责人。三类是界面摘要，不能代替对象权限或 Datasight 数据权限。

本轮将扩展既有 `GET /semantic-access` 的只读响应，前端不根据用户名或创建资格猜角色。失去表归属但仍负责独立对象时仍显示语义维护者；创建资格继续按原规则校验。范围限 M01 只读权限摘要、M12 账号标识、同源契约、对应验证与说明。开始前快照为 `.local/workspace-role/before/`；前两轮改动完整保留。

### 本轮验收与要求变更

- 按本轮用户要求新增最高角色展示，不调整现有权限规则。`SemanticAccess` 增加必填 `highest_role`；原精确响应断言仅补这一字段，原创建/归属/隔离断言保留。
- 新浏览器场景使用隔离 MySQL、合成平台和登录身份，核对三类、角色变化、独立对象归属、换用户和读取失败；不调用真实模型、不改常驻试用数据。

实现已完成：服务端从当前空间可信超级角色和根对象归属生成 `highest_role`；共享侧栏用户名旁显示中文角色，导航、窗口返回和30秒可见轮询刷新；按登录用户/页面隔离，旧请求不能覆盖新读取，读取失败显示暂不可用。原授权操作、Pi及模型均未修改。

定向验证已通过：`.local/checks/workspace-role/report.json` 的6组浏览器场景、`.local/checks/creator-ownership.json` 的6组原归属回归，Rust格式/Clippy、TypeScript、Web构建和219项同源契约检查。312项准备材料与模块依赖/SQL归属检查通过。桌面与390px截图已查看。独立复核 `docs/reviews/workspace-role-review.json` 通过，范围指纹 `cf1d2e83709f7d5923b62eb5ac5d8b82009120340ababbdb497e35472c76c2cb`。`make verify-increment` 的 ROLE-DISPLAY、OWNERSHIP、CONTRACT-CODE 三组完整退出0，无超时，冻结范围前后指纹一致；收据 `.local/delivery/I2-WORKSPACE-ROLE-result.json`。角色相关体验与既有归属权限通过本轮声明验收，真实平台身份仍未接入。未提交或推送。

常驻服务已按原配置重启；五个服务返回200，身份、Flash/Mem0/向量配置哈希一致，证据 `.local/workspace-role/live-check.json`。当前本地Alice显示超级维护者，Bob未有本空间负责对象，服务端返回普通用户；没有改变归属。已在现有浏览器页面读到Alice的“超级维护者”标识。

## 上轮交付：自然续聊与分析方法入口（已完成）

`goal_revision=33`，增量`I2-CONVERSATION-ENTRY`，继续使用`codex/conversation-experience`。用户补充要求：日常聊天不展示“本次对话中的问题”和继续/停止问题按钮；“选用分析方法”直接进入我的Skill，可切换公共Skill。本轮只调整前端入口、对应验证和说明，复用现有Pi归属与澄清，不修改任务服务或SQL执行边界。

### 本轮验收与要求变更

- 原要求：问题列表折叠展示，可手动继续/停止内部任务。新要求：移除这块列表和动作，普通追问直接发送；后台任务记录和取消API仍保留。依据为用户此次明确反馈。原浏览器点击继续/停止的断言改为列表/按钮不存在，并实际发送无任务标记的追问验证SQL修订；具体查询取消及后台取消断言保留。
- SQL卡片的“补充或纠正”保留为明确引用，取消引用只移除引用，不停止后台任务。原引用草稿刷新/保留检查改从该入口进入。
- 原分析方法入口只打开我的积累，默认显示记忆。新入口明确定位我的Skill，同时可切换公共Skill；用户明确选用后回到原对话，普通我的积累入口仍能管理记忆。选择、权限和发布规则不变。
- 复用三份现有浏览器检查，补入口、自然追问和草稿断言；不改独立金额参考、不改模型或后台测试替身，不放宽确认/隔离判断。前一增量收据与审查保留为历史，本轮只验证上述修改。开工快照在`.local/conversation-entry/before/`，不维护第二份当前计划。

完成记录：移除工作台问题列表、继续/停止问题按钮及已无调用的前端取消函数/样式；普通追问直接发送，SQL引用取消只清引用且保留草稿。分析方法入口明确定位我的Skill，公共Skill仍可切换，选用后回原对话并恢复输入。前后端任务、Pi、模型、SQL确认和权限规则保持。

独立审查`docs/reviews/conversation-entry-review.json`通过，范围指纹`65dc7f449d341fcd85f5049b214805dd562d30de52b1e5a00af18ef005440bf0`。`make verify-increment`5组完整退出0、无超时，执行前后指纹相同，收据`.local/delivery/I2-CONVERSATION-ENTRY-result.json`。验证了直接补充条件修订同一问题、1600分独立参考结果、SQL引用/草稿恢复、私人/公共Skill明确选用、管理/取消查询/删除会话和身份隔离；TypeScript和Web构建通过。这些确定性流程使用合成平台和模拟模型，不推导真实模型任意长对话的归属准确率。

常驻服务已热更新；只读检查确认问题列表消失、分析方法直达我的Skill、公共Skill可切换，1440/390画面已查看，无页面横向溢出。证据在`.local/conversation-entry/live-navigation.json`和同目录`live-my-skills-loaded-1440.png`、`live-public-skills-390.png`。未新增真实模型调用、未修改现有资产或会话内容，未提交或推送。

## 上轮交付：用户试用后的交互修复（已完成，尚未提交）

`goal_revision=32`，增量 `I2-USER-EXPERIENCE`，工作分支 `codex/conversation-experience`。本轮用户要求从用户与产品视角调整三个主入口：工作台以对话为主，技术标识按需查看；语义管理先呈现业务含义和待处理问题；文档按整篇阅读/编辑；Skill有可直接修改的模板示例。SQL确认、权限、历史及真实状态保持。

已核实并修复：试用中的 `demo_order_detail` 负责人仍是 Alice；Bob 的负责目录为空时，旧界面保留 Alice 的详情。现在目录范围和详情联动，晚到的跨范围搜索也不能恢复旧对象。真正由 Bob 负责的表通过隔离平台 mock 验证，不修改用户现有负责人或试用数据。

Markdown 表格的组件定义原先随每次轮询重建，导致滚动回跳；现使用稳定渲染组件。桌面和 390px 的针对性检查已通过；默认版本号和内部 task 标记已收起，SQL按事件顺序归入对话，执行仍绑定服务端的具体 SQL/条件版本。

业务文档改为整篇 Markdown 读写：序言、标题和章节均可修改。内置资料原先有8个引用对象，后台仍保留这些身份和权限，以可选 `document_order` 记录全文拼接顺序；首次全文保存将排序与正文同版本写入。正文和全部片段版本一次提交，同事务授权/保存；空片段保留人工覆盖，重新预填不能恢复已删正文。已有手工完整文档继续使用原对象。没有新增数据库表、迁移、Agent能力或新的检索框架。

可执行平台目前有 **5张合成表**；语义目录同时含样例材料与平台同步记录，目录条数不等于实际表数。本轮保留真实来源身份，没有按同名合并或为增加数量导入不可查询的表。

### 本轮验收与要求调整

- 首次统一验收的Markdown/工作台/文档/Skill四组通过；角色组因调用未带必需`--case`而在参数校验退出，尚未运行角色业务断言。将原无参命令改成既有`sync`、`members`、`directory`三个明确场景（独立依据：Makefile原命令和该脚本支持的参数），测试与权限预期不变。原失败收据留在`.local/conversation-experience/receipt-missing-role-case.json`，最终验收扩为9组；这是调用修正，不放宽验收。

- 用户明确要求默认不展示数字版本与内部标识：原C04“展示条件版本”调整为展示当前SQL/参数/目标与条件；数字版本保留在按需详情和确认请求中，后台版本绑定和旧版拒绝行为不变。
- 旧浏览器验收的数字版本、task标记、文件路径、关联ID输入及文档分段入口改为业务名称/目标、附件名称、资料选择与全文编辑。资产迟到回执、权限、并发、确认、共享副本和真实持久化断言保持。版本数字的页面断言由“需要重新选用”状态及服务端 `selected_version/current_version` 断言替代；这来自用户本轮要求，不以当前输出反写业务答案。
- 初版组合编辑仍不能修改序言和标题，独立审查指出缺口；已改为完整Markdown。测试原“未改章节版本不变”仅适用于旧初版：首次全文保存要增加后台拼接顺序，因此全体片段必须改版；后续无内容修改不新增版本。新增全文逐字往返、插入/删除章节、空片段和来源重分析保护测试。
- 首轮页面测试遇到开发热重载离开当前页；服务日志记录了对应 Vite reload。后续冻结前端再运行。首个对话测试错误使用 capture（捕获并暂停Agent），已改成原有本地模拟模型；无真实模型调用。测试的场景和判断标准保持。
- 独立审查已复核跨范围晚到搜索、非首段更新后的全文刷新、读取失败时草稿保留及文档名称刷新；发现的问题均已修复。审查记录为`docs/reviews/conversation-experience-review.json`，最终验收另有完整收据。

补充审查确认：合法存量章节合并后可超过10万字符，全文读取契约不再套用单次编辑上限；全文单次保存仍限10万字符，超限时明确提示并保留正文与草稿。完整阅读不截断。独立审查还发现模拟回答仍输出任务ID/数字版本，本轮只调整模拟展示文字和Pi现有提示的用户表达要求，工具参数、归属、原生循环均保持。

回归补充：清空名称搜索时保留仍在表目录中的当前对象，防止后续编辑跳错表。原按钮回归已改为等待正文回读/资料名称加载，避免把尚未完成保存的输入或加载态当成持久化结果；非负责人文档的断言先确认整篇文档可见，再检查无编辑入口及可提出纠错，避免空容器的假通过。旧Skill录入回归使用可修改示例填入正文，因新版新建表单不再暗填演示正文；原持久化/选用要求保持。

移动端复核发现旧样式统一隐藏`.quiet`，会连同来源链接、正文缺口和操作说明一起隐藏。现保留辅助说明，只按既有规则隐藏导航装饰；390px实际验证只有链接的文档仍可打开来源。血缘中的上游表数组以名称列表展示，原值与编辑格式保持。

最终统一验收：`make verify-increment`完整退出0，9组全部通过且没有超时，执行前后输入和审查记录指纹一致。包括Markdown、工作台、文档、Skill、3项角色边界、工程/214项同源契约，以及包含11项既有流程的回归组。收据为`.local/delivery/I2-USER-EXPERIENCE-result.json`，逐项日志由收据引用；早期失败单独保留。模块依赖/SQL归属检查已通过。实际查看1440/390的工作台、Skill示例、语义目录和文档画面，并操作保存、刷新、修订、确认与导出。确定性验收使用隔离MySQL、合成平台和模拟模型，不代表真实Datasight、千表或真实模型业务准确率。

本地应用已按原Flash/Mem0/百炼向量配置重启，身份与持久数据库沿用。首个真实Flash小样正常生成待确认SQL、未执行，但模型回答仍展示查询缩写和条件版本；失败保存在`.local/conversation-experience/local-dogfood.json`，不计为真实表达通过。定位到SQL提示仍要求用户“确认具体版本”，现将用户动作明确为对应卡片的“执行查询”，版本绑定仍由宿主执行，并补充业务目标表达示例。仅修现有Pi提示，无输出清洗或新Agent逻辑。

修订后的真实Flash样本已完成：最终提交的回答无内部ID或数字版本，唯一SQL仍为`not_submitted`，没有执行；证据为`.local/conversation-experience/local-dogfood-after-prompt.json`及`local-dogfood-final-state.json`。后一记录核对最终`finished`和已提交回答，而非只看生成中的页面；保留同一会话中断后恢复的运行记录。原登录身份、模型/Mem0/向量配置哈希和全部既有会话仍在，本轮只新增烟测会话。样本仍重复展示SQL，因此只作为一条合成需求的表达与确认状态验证，不推导普遍表达遵从率或业务准确率。独立复审已通过，审查范围指纹为`2a146ba6bca362a96f30df4e9beec848323b11a6021e22b900955671c9133924`，统一验收已完成。本地服务已加载本轮代码，用户可继续试用；本轮没有清库、改派现有负责人或改模型/记忆配置。已同步设计、文档接口与开发说明。本增量关闭，改动保留在当前工作分支，未提交、推送或部署。

收尾检查：312项材料核对、16项交付检查器测试及`git diff --check`通过，完成收据与最终输入一致（`.local/conversation-experience/final-materials.log`）。Web/API/Pi/平台mock/Mem0健康检查均返回200，配置哈希、Alice/Bob全部既有会话与Flash身份显示保持（`final-service-health.json`）。本地入口为`http://127.0.0.1:5173/`。

## 上轮交付：资产维护补充审计与修复（已完成并推送）

`goal_revision=31`，增量 `I2-ASSET-MAINTENANCE` 的修复与文档同步均已完成，并已分批提交推送。2026-10-08 用户要求使用 `oracle-web` 第五档再审计，与本地复现对照后修复。审计基线 `665e519`；开发分支已合入仓库默认主分支，当前位于 `codex/semantic-maintenance-prototype`。

### 文档与 Git 交付

2026-10-08 用户明确授权补齐 README 和相关文档，并分批提交、推送 GitHub。目标为 `origin/codex/semantic-role-boundaries`，沿用当前分支。本次授权替代审计阶段“不提交、推送”的限制；产品范围、代码和验收命令保持，新增四份文档已纳入允许路径及验收输入。

本次补充 `README.md`、`docs/development.md`、`docs/semantic-retrieval-design.md`、`docs/architecture/implementation-views.md` 中的依赖维护、核对标记及回执恢复说明，README增加维护流程图和最新证据入口。这些是已完成行为的文档同步，未新增接口或改变架构。本次按两批提交：实现与回归测试；文档与审计记录。系统设计文档属于验收指纹，文档定稿后已重新通过独立复核及同7组验收；旧审查与收据分别保留在 `.local/asset-maintenance/review-before-documentation.json` 和 `.local/asset-maintenance/verified-before-documentation.json`。31份实现、测试、契约及Makefile与前次通过记录保持同哈希，需求和测试标准未变。实现与两份回归测试已提交为 `c82978a35308f226503dfd92e84709f1be5f4394`（`fix: guard asset mutations and repair stale dependencies`）。第二批 README、设计、使用指南、执行包及审计记录已提交为 `1e86013b031339c5176d7a2d1b7a9a26ff6d590e`（`docs: document asset maintenance and audit results`）。两批已成功推送到 `origin/codex/semantic-role-boundaries`，远端读取与本地提交号一致。上述为开发分支交付时的记录；主分支整合以本节下方为准，未部署。

交付前检查：309项材料检查、16项交付检查器测试通过；完整收据与当前输入一致，`git diff --check`通过。公开463份文本按凭据格式、个人绝对路径和原业务标识检查未检出问题，扫描结果保存在 `.local/asset-maintenance/publication-check.json`。

### 主分支合并与推送

2026-10-08 用户随后明确授权合并到主分支并推送，替代前述交付声明中“不合并默认分支”的限制。GitHub 默认主分支为 `codex/semantic-maintenance-prototype`；仓库没有 `main` 或 `master`，沿用既有默认分支名称。

已将 `codex/semantic-role-boundaries` 的 `90b736f5e18539dfd6f1d3d10c99806b692c0242` 以 fast-forward 合入默认主分支，从 `0db0bb8` 前进7个提交，无冲突，并成功推送到 `origin/codex/semantic-maintenance-prototype`。远端默认分支已返回相同提交号。合并时两分支文件树完全一致，既有审查和7组验收收据继续匹配；本次仅追加合并记录，不改变产品代码、契约或验收标准。本节作为默认主分支上的后续交付记录保存。

### 已确认并修复

- AM-01–04：迟到发布回执影响另一窗口及新资产种类；失效依赖缺少网页修复入口；保存中关窗导致列表漏刷新；写入成功与刷新失败反馈混在一起。
- AM-05：启停、删除的旧回执缺少页面身份检查，退出换用户后会额外读取新身份列表。独立复现实测从额外1次GET降为0次，未发现跨用户资产泄露。
- AM-06–08：失败提交提前作废有效的初始列表；修改内容或依赖仍沿用旧“已核对”；关窗后才收到保存/发布失败时缺少具名反馈。现已保留有效列表、撤销旧确认，并提供只读列表的核对入口。
- 依赖维护展示当前内容，人工核对后才更新同一引用的版本或明确移除；保存沿用服务端权限和版本校验，修订后会话仍需明确重选。修改仅涉及资产维护前端、相应测试和文档；未改后端、API Schema、Pi、Mem0、SQL确认及平台权限。

### Oracle与独立审查

Oracle第五档咨询 `asset-maintenance-max-retry-20261008-093039` 已完成。网页实际验证 `Power, item 5 of 5 (slider ARIA)`，有提交和完整回答证据，临时浏览器及Profile已清理。原第四档已中止、首次第五档未提交，均不作为有效结论。Oracle与本地一致的AM-01–04及补充边界已逐项核对；未证实的风险与未采用的实现建议另有说明，见[补充审计](research/asset-maintenance-audit-20261008.md)。

[独立审查](reviews/asset-maintenance-review.json)通过，审查者未参与本次实现。补充复审7组独立反例全部通过，包括真实写入后丢回执、只GET核对、身份切换和同窗幂等重试；四份补充文档由同一审查者核对后重绑，当前审查指纹 `f66d231bae97da58ba623ffbb93b8ce06ffadea6c94db5148544c33139a1b503`。审查记录保留正式验收前时点，最终执行结果如下。

### 最终验收

2026-10-08 10:48:11–10:49:40 UTC（北京时间18:48:11–18:49:40），`make verify-increment`完整退出0。MUTATIONS、DEPENDENCIES、EDITOR、SHARED、SELECTION、WORKSPACE、ENGINEERING共7组全部通过，无超时，执行前后指纹与当前输入一致。

- 浏览器验收覆盖窗口归属、列表乱序及失败、依赖修复、原编辑流程、个人/公共权限、明确选用和工作台反馈；Rust fmt/Clippy、TypeScript/Web构建及206项同源契约案例通过。
- 正式收据：`.local/delivery/I2-ASSET-MAINTENANCE-result.json`；独立保存副本：`.local/asset-maintenance/verified-documentation-result.json`；执行日志：`.local/asset-maintenance/verification-documentation.log`。分组日志位于 `.local/delivery/I2-ASSET-MAINTENANCE-1791456491558585000/`。
- 独立补充反例：`.local/asset-maintenance-review/oracle-followup-report.json`。补充前8组独立反例和7组正式验收仅作为历史保留，旧收据为 `.local/asset-maintenance/verified-before-oracle-followups.json`，未拼接为本轮通过。文档同步前10:11 UTC的7组收据另保留在 `.local/asset-maintenance/verified-before-documentation.json`。
- 使用真实Rust API、隔离MySQL及Chromium，平台、数据、身份均为合成mock，应用模型请求为0。实际查看1440px、390px依赖维护界面，无横向溢出。本轮未重跑千表、真实模型或真实平台验收；Oracle咨询不代替应用模型验收。

### 验收与要求边界

沿用原要求及已有断言，新增本轮反例和从失效到修复的维护流程，没有删减或放宽原验收。关闭保存的用例安排在创建记忆前，防止记忆同步轮询掩盖漏刷新；断言保持。前一增量的完成事实及证据保留。

同一打开窗口的同参重试保留原`operation_id`；关闭后的未知结果具名提示且只提供GET核对，没有自动重做写入。页面没有跨窗口继续原操作的入口；“新增”仍明确创建新资产。本轮范围内无剩余已确认阻断项。

## 上次交付：Pi 原生 Skill 与空间共享收尾（已完成并推送）

`goal_revision=30`，增量 `I2-SKILL-CLOSEOUT` 已完成。六项复现的产品问题已修复，独立审查通过，第十四次统一验收13组全部成功。用户已授权完整验收后提交并推送当前分支 `codex/semantic-role-boundaries`；实现及配套材料已提交并推送该分支，未合并默认分支或部署。

### 本次交付内容

- Pi SDK 原生 Skill 目录与 `read` 按需读取正文、说明和文本模板；个人/当前空间公共 Skill，明确发布独立副本，按负责人或超级维护者维护。
- 对话明确选用固定版本；改版、停用、撤权及依赖失效后重新核验。SQL 保持先展示、补充修订、再按具体版本确认执行。
- 六项产品修复：公共分类中新建个人 Skill 后不可见；迟到保存回执影响新草稿；依赖故障时 read 接回旧成功正文；重新预填重放遗漏维护权限视图；Mem0 短文本向量预留遗漏模板开销；精确名称搜索被同前缀对象挤出首页。
- 接口、迁移、React 页面、设计、架构图及 README 已同步。详细复现、修复与测试前提调整见[最终试用记录](research/skill-closeout-dogfood-20261007.md)，独立审查见[收尾审查](reviews/skill-closeout-review.json)。本轮没有新增 Agent 循环或记忆算法。

### 最终验收结果

2026-10-08 15:12:16–16:03:26 北京时间（07:12:16–08:03:26 UTC），`make verify-increment` 完整退出0。START01、START02、FEEDBACK、SHARED、SELECTION、NATIVE、QUERY、CONTRACT、ASSETS、PROVIDER、LIFECYCLE、GOVERNANCE、REGRESSION共13组均无超时；执行前后指纹与当前文件一致。

| 验证 | 结果与范围 |
| --- | --- |
| 真实服务试用 | DeepSeek Flash、Mem0、百炼向量6条输入通过：Skill正文及附件、SQL生成与渠道修订、确认执行、结果解释、保存个人记忆与新会话召回同ID/版本；平台和业务数据为合成mock |
| 功能与边界 | 工作台、SQL确认、个人/公共Skill权限、语义负责人和建议处理、长会话/原生压缩/恢复、记忆修订、预填保护、未知回执与取消、历史分页及管理按钮通过 |
| 契约与工程 | 206项契约案例、Rust fmt/Clippy、TypeScript/Web构建、12项Memory测试、完整验收时292项、完成记录更新后294项材料检查及16个业务协议场景通过；模拟协议场景不作为真实模型准确率 |
| 千表检索与恢复 | 1204张合成表、2408个新增对象，8项检查通过；首次索引529.53秒，集合丢失自动恢复、受控重建、丢回执查证、旧版过滤、私人记忆隔离和降级均通过；临时测试库/集合已清理 |
| 公开内容 | 458份公开文本扫描未检出凭据、个人绝对路径或原业务表名，未跟踪`.env`；最终提交前继续核对CURRENT与暂存差异 |

正式收据：`.local/delivery/I2-SKILL-CLOSEOUT-result.json`；独立保存副本：`.local/skill-release/final-attempt-14-result.json`。完整分组日志在 `.local/delivery/I2-SKILL-CLOSEOUT-1791443536446150000/`，执行日志为 `.local/skill-release/final-verification-14.log`。

真实试用报告：`.local/skill-delivery/real-e240a2cc-2bea-4b78-a713-7bf81c7dfc2f/report.json`。千表结果副本：`.local/skill-release/hybrid-completed-14.json`。汇总：`.local/skill-release/final-success-summary-20261008.json`。公开扫描：`.local/skill-release/publication-reboot-20261008.json`。这些私有运行产物不提交Git。

独立审查范围仍为 `b26792a5f244dd0e9f4e1b89ea431839cb4ae21010668e387095fe5767b40013`，无剩余已确认产品代码阻断。冻结审查记录保留验收前时点；本节及上述统一收据给出最终完成状态。前13次失败或中断证据全部保留，不拼接为本次成功。

### 验收与要求边界

- 原需求、业务断言和产品时限保持。测试造数、定位器、恢复租约前提和启动等待的修正依据均已记入试用记录并通过独立复核；本次重启后未再修改产品或测试。
- 真实 Datasight、生产身份认证和真实业务正确率未验证；千表使用协议向量证明工程行为，不代表千表中文语义召回率，也不承诺所有输入100%正确。
- 用户恢复后继续原费用/次数授权；本次只按原范围完成验收，没有重构产品预算系统。

### Git交付状态

实现及全部配套材料已提交为 `c3a12e8857d4d81eaba838a4e2ab66b06cd0ed57`（`feat: adopt native Pi skills with personal and shared ownership`），并成功推送到 `origin/codex/semantic-role-boundaries`。本条作为同一分支的后续完成记录单独提交；没有合并默认分支或部署。

本次交付114项路径中，113项属于当前增量允许范围，另1项是前序已授权、此前未提交的历史审计文档 `docs/reviews/dogfood-and-pi-skills-audit-20261007.md`。独立审查补核对确认该文档属于原审计授权，保留原审计时点及CURRENT入口；随本次交付保存，不修改本增量冻结范围。

完成记录更新后，`make verify-materials verify-delivery` 完整退出0：294项材料检查、16项交付检查器测试通过；完整收据仍与当前范围一致，`git diff --check` 通过。独立最终证据为 `.local/skill-release/final-evidence-review-20261008.json`，复核13组最终日志、真实6条、千表8项和当前指纹，无阻断项。

<details>
<summary>本轮过程记录与历史失败（以本节上方最终结果为准）</summary>

## 当前任务：最终审计、试用与提交推送

`goal_revision=30`，增量`I2-SKILL-CLOSEOUT`。用户明确授权最后审计、发现问题就修复、覆盖已约定流程和关键异常场景dogfood、记录后提交推送。此授权替代上一轮“不提交推送”；目标为当前分支`codex/semantic-role-boundaries`，不合并默认分支或部署。原`I2-NATIVE-SKILLS`的声明和完整收据分别保存在`.local/skill-release/native-skills-delivery.json`及`.local/delivery/I2-NATIVE-SKILLS-result.json`，不修改旧成功证据。

范围：复核本次99项未提交文件，独立审查服务端/Pi边界，主任务检查界面并复用现有全流程场景；保留原权限、版本、预算、模型和Pi复用规则。不能穷尽所有输入、网络与调度组合，具体覆盖和剩余边界见[最终试用记录](research/skill-closeout-dogfood-20261007.md)。不把一次模拟或真实小样称为100%准确率。

### 重新开机后继续

2026-10-08 用户已明确恢复本任务，暂停撤销。重新核对：仍为原分支、原HEAD及114项未提交路径；当前验收输入与第十三次前后指纹完全一致，独立审查指纹 `b26792a5f244dd0e9f4e1b89ea431839cb4ae21010668e387095fe5767b40013` 继续有效。先恢复本项目基础服务，处理已核实的上次隔离测试资源，再按现有完整命令取得最终收据。没有修改产品、测试、验收断言或费用授权；完成后沿用原授权提交推送当前分支。

第十三次因用户关机主动中断的收据和日志保留，不修改成通过；以下暂停说明已由本次恢复决定取代。

基础服务已恢复且健康；仅清理已核实的第十三次隔离测试库与集合，证据`.local/skill-release/resume-interrupted-resources-20261008.json`。第十四次正式验收已启动，日志`.local/skill-release/final-verification-14.log`。重启后shell默认Node22/Python3.12，本次命令显式使用原Homebrew Node26.8.1/npm11.19.0/Python3.14.7并为本机回环地址绕过代理；不修改全局默认、产品配置和测试源码。冻结范围与审查保持，尚未提交推送。

### 用户暂停：准备关闭机器

2026-10-08 14:20 北京时间，用户明确要求先停止以便关机。已停止第十三次验收进程组及其API、Pi、Worker子进程，未提交、推送或合并；代码及历史证据保留。`make vm-stop` 已于14:21:55北京时间完整退出0，本项目MySQL、Milvus等容器及独立虚拟机均已停止，数据卷和本地配置保留。

第十三次执行于05:25:29–06:21:12 UTC运行，前12组全部通过，包含真实Flash/Mem0/向量服务6条输入及GOVERNANCE。最后REGRESSION的其他8个目标已通过；千表首次索引和删除集合后的自动恢复完成，最终受控重建途中按用户要求发送SIGTERM。REGRESSION退出-15，统一收据按原检查器记failed；这是用户主动中断，不能计为完整通过，也没有据此确认新产品缺陷。执行前后指纹一致，独立审查仍有效，增量保持active且evidence=null，工作流状态为paused。

- 停止证据：`.local/skill-release/user-pause-20261008.json`、`user-pause-20261008-progress.log`。
- 原始统一收据及保留副本：`.local/delivery/I2-SKILL-CLOSEOUT-result.json`、`.local/skill-release/final-attempt-13-result.json`。
- 真实6条报告：`.local/skill-delivery/real-b5b10ad8-31fe-4453-aeb1-82699ba20519/report.json`。
- 正式日志：`.local/skill-release/final-verification-13.log`；分组日志：`.local/delivery/I2-SKILL-CLOSEOUT-1791437129891075000/`。
- 恢复前先确认基础服务、Git状态及遗留隔离测试库/向量集合；本次中断未执行测试finally清理，不能把旧完成数当成新运行结果。仅处理本次已核实的临时资源，不改常驻数据。
- 恢复后沿用既定产品范围与当前授权，按冻结声明取得完整成功收据，再核验、提交并推送当前分支。此前费用、次数授权保持；不自动增加功能或继续运行。

以下“进行中”及旧失败描述均为暂停前历史，以本节为准。

### 最新授权与执行状态

2026-10-08 用户选择 A：完整验收通过后提交推送；本次真实试用费用、调用次数和旧期限不限，不再询问这些授权。继续使用原主试验和向量维护试验，保留历史用量、操作身份及未知回执；现有字段使用足够大的可表示上限和最远有效期，未重构产品预算系统。调整前后证据：`.local/skill-release/authorized-trial-resume-20261008.json`。

六项产品修复和独立审查已完成；恢复测试前提与顺序调整经限定复核后，当前范围指纹为 `b26792a5f244dd0e9f4e1b89ea431839cb4ae21010668e387095fe5767b40013`。当前缺口是同一冻结范围的统一13组成功收据及Git交付。START02前移并按下述实测依据调整测试包装等待；其余命令、业务断言和超时保持。不以分次结果拼接完整通过。

### 本次最终验收进展

暂停前：第十三次正式执行前12组全部通过（含真实6条与GOVERNANCE），REGRESSION最终千表阶段被用户主动中断。真实报告`.local/skill-delivery/real-b5b10ad8-31fe-4453-aeb1-82699ba20519/report.json`；正式日志`.local/skill-release/final-verification-13.log`。完整收据成功前保持active，未提交推送。下述第11、12次为保留的失败历史。

第十二次完整验收于05:18 UTC失败。前12组含真实6条及GOVERNANCE全部通过，REGRESSION中的模型协议、会话主流程、3个恢复用例、原生压缩/续接、Mem0协议、Memory单测和共享向量通过；查询测试在公共harness的Pi导入阶段超过20秒，尚未提交业务请求。同期负载60.98、15GB内存已用。收据`.local/skill-release/final-attempt-12-result.json`、启动证据`query-startup-failure-12.json`保留，前后指纹一致。

限定调整公共测试入口`tests/mvp/harness.mjs`的默认健康等待20→60秒，原`startupTimeout`显式覆盖、有限失败、普通until等待、产品启动器、模型/查询超时和全部业务断言保持。第7及12次均有Pi停在imports_started的对应证据，不修改产品SDK或扩大功能。查询8项正对照通过；独立审查6个边界通过，包括实际startupTimeout=1时的失败留证与临时资源清理。当前审查记录已定稿，继续第十三次同范围完整执行，日志`.local/skill-release/final-verification-13.log`；完成前保持active、未提交推送。

接续时先执行最小启动诊断。首次Mem0在5.34秒就绪、Pi导入超过25秒；单独导入随后为2.24秒，表明启动延迟仍有明显波动。随后b、c两次完整真实配置启动、页面和开发身份检查均通过，日志为`.local/skill-release/readiness-20261008-b.log`及`readiness-20261008-c.log`。MySQL健康、约648MiB，当前无本项目应用常驻进程；未关闭用户应用或调整数据库内存、永久电源设置、产品代码及测试上限。

第十一次验收于04:46 UTC失败结束，前11组全部通过。千表8项全部通过，首轮索引622.60秒，临时资源已清理；随后模型协议、会话主流程和前两个故障恢复用例通过，第三次Pi启动停在imports_started，超过原20秒健康等待，尚未进入该故障的行为断言。失败收据`.local/skill-release/final-attempt-11-result.json`、启动日志`.local/skill-release/runtime-startup-failure-11.json`及完整千表快照`.local/skill-release/hybrid-completed-11.json`保留。真实6条报告为`.local/skill-delivery/real-9688d0e2-b5f7-4b43-8d37-bf6094bb47cd/report.json`。执行前后指纹一致，没有新增已确认产品缺陷。

下一轮仅调整验收顺序：GOVERNANCE移到REGRESSION前；REGRESSION先执行原8个其余目标，verify-hybrid-retrieval最后执行。原因是第十一次昂贵千表完成后才遇后续短启动超时；让需频繁启动的检查先失败退出，避免再次重复已验证的长时步骤。13组、全部原命令、业务断言、数据量和有限时限保持，未改产品或测试源码；不拼接旧结果，不删除失败收据。该顺序调整须经独立审查核对后，再完整执行。 隔离复跑在原1500ms短租约下出现3次运行而预期2次；API明确记录第二次运行tool_committed后lease_lost。失败报告`.local/skill-release/runtime-startup-probe-11.json`及日志`runtime-recovery-isolated-11.log`保留，正由独立审查核对测试前提，独立审查确认测试租约前提失效；仅将恢复Worker设为产品原默认15000ms，故障Worker仍1500ms，增加恢复前1次运行/领取断言。健康等待20→60秒并检查提前退出；产品及其余行为时限不变，全部原业务断言保留。依据和影响见最终试用记录“会话恢复测试的调度前提修正”。主任务3例恢复正对照通过；独立审查另运行3例恢复与4项健康边界均通过，见`docs/reviews/skill-closeout-review.json`。第十二次正式验收据此开始，日志`.local/skill-release/final-verification-12.log`；完成前仍保持active，不提交推送。


此前环境失败保留，不计为通过：

| 尝试 | 实际结果与原因 | 保留证据 |
| --- | --- | --- |
| 5 | 前11组含真实6轮通过；千表检查遇合盖休眠985秒，未取得完整结果 | `.local/skill-release/final-attempt-5-result.json`、`host-sleep-20261008.json` |
| 6 | 真实输入中4次有效模型调用累计169.277秒，原180秒等待不足；未知回执保留 | `.local/skill-release/final-attempt-6-result.json`、`real-provider-latency-20261008.json` |
| 7 | 前11组通过；Pi导入超过20秒，同期负载82.34、内存不足 | `.local/skill-release/final-attempt-7-result.json`、`host-pressure-20261008.json` |
| 8 | 前11组通过；MySQL达到1GiB容器限制并OOM自动重启，连接中断；已清理本次隔离库和集合 | `.local/skill-release/final-attempt-8-result.json`、`mysql-oom-cleanup-20261008.json` |
| 9 | 前11组、千表首轮777.237秒及丢库自动恢复通过；主动重建900秒到期时未完成，负载182.71、CPU空闲0.6% | `.local/skill-release/final-attempt-9-result.json`、`host-pressure-final-20261008.json` |
| 10 | Mem0初始化超过25秒，尚未调用官方服务；主调用数前后254，指纹未变 | `.local/skill-release/final-attempt-10-result.json`、`.local/skill-delivery/real-8c7c474c-cc73-483d-b231-2432622569c8/report.json` |

已通过的真实小样包括本次Skill正文及附件读取、SQL按web渠道修订、用户确认后合成平台执行、结果解释、新记忆入Mem0与新会话召回同一ID/版本。第五次完整报告为`.local/skill-delivery/real-b73f1924-f1e7-432d-9442-78bb0bbcc035/report.json`。这些只证明各自小样，最终结论仍以本轮统一收据为准。

以下早期费用等待与未完成说明属于当时记录，已被上述用户授权和当前执行状态取代。

### 上次完整执行：12组本地通过，真实组被旧期限拦截

- 六项已确认产品问题全部修复，独立审查通过，暂无剩余已确认代码问题。包括个人Skill分类、迟到保存回执、依赖故障时read旧回执、重新预填维护视图、Mem0短文本向量预留及个人资产完整名称排序。修复与旧测试造数前提的调整分别记录在最终试用记录中。
- 第四次正式执行于2026-10-07 16:24:55–17:15:05 UTC完成（北京时间10月8日00:24–01:15）。START01、FEEDBACK、SHARED、SELECTION、NATIVE、QUERY、CONTRACT、ASSETS、PROVIDER、LIFECYCLE、REGRESSION、GOVERNANCE共12组全部退出0、无超时；执行前后指纹一致。完整执行收据在 `.local/delivery/I2-SKILL-CLOSEOUT-result.json`，保留的本次完整快照另存 `.local/skill-release/final-attempt-4-result.json`。收据整体仍为failed，因为最后的START02被过期账本拦下，不能把12组本地成功称作13组全部完成。
- 完整REGRESSION耗时2805秒，其中1204张合成表、2408个新对象完成首次索引、同名集合丢失后的自动恢复、受控完整重建，以及丢回执查证、旧版过滤、私人记忆隔离和向量故障降级8组检查；首次索引用时约572秒，临时集合已清理。独立快照 `.local/skill-release/hybrid-completed.json`。协议向量与精确召回通过不代表中文向量语义准确率已验证。
- 核心会话、Pi原生压缩/恢复、12项Memory测试、共享向量、查询、完整知识流程、历史与管理浏览器、16个业务协议场景、语义负责人/创建者/建议流程均在本次正式命令中完整通过。Datasight、身份和业务数据仍使用合成mock；官方模型、Mem0真实调用的最终小样另列START02，真实平台权限及生产部署未验证。
- 最终独立审查记录为 `docs/reviews/skill-closeout-review.json`，范围指纹 `a61f018b68926c2246d0b07c4e9a904a3bb695b2fa07ef367046aef7786aaa4e`；审查者未参与实现，并独立验证预算、排序分页及回执反例。前三次失败收据与修复前日志全部保留。
- 收尾再次核对审查与执行收据，指纹仍与当前文件一致；292项材料检查、16项检查器测试及 `git diff --check` 通过。扫描458个公开文本文件未发现凭据、个人绝对路径或受跟踪的 `.env`，结果在 `.local/skill-release/publication-final-check.json`。这些静态检查不替代尚未通过的真实组。
- START02在启动真实服务及请求模型之前拒绝，主账本前后均为79次、US$0.278053、预留0，状态breached且已过期；第四次执行新增官方调用0。证据 `.local/skill-delivery/real-648431a1-f94c-4fce-afcb-2f3ae1a88d4e/report.json`。该次运行未恢复或改期；现在按上节新授权继续。
- 增量保持active，未提交、推送、合并或部署。当前分支仍为 `codex/semantic-role-boundaries`。下一步完成已获授权的真实验收及要求的最终收据核验，再提交推送；不重开产品范围，也不以旧真实成功替代本次要求。

已复现：公共分类中新增私人Skill后仍留在公共列表，新建对象不可见；前一次保存回执延迟期间关闭弹窗并开始下一份编辑，旧回执会关闭新弹窗并丢弃未保存草稿。证据`.local/skill-release/assets-probe-before.json`。修复只涉及资产页的保存结果归属及对应浏览器回归，不调整后端契约或公共权限。管理按钮旧测试仍按原私人标签定位，后续按实际回归结果核对。

两项UI修复及四组浏览器反例通过。独立审查的read回执候选也已隔离复现：依赖存储故障时返回旧正文；限定原已提交操作的回执回放分类，新增故障/恢复与写回执保持回归。管理回归另有旧关联标题定位器不含既有“打开详情”按钮，按完整可访问标题修正，字段翻页/种类/权限断言均保留；失败日志和独立依据见最终试用记录。当前继续完整场景和修复后复核。主模型账本沿用原120次/US$5及已用70次，不扩额或重置；新的官方调用必须在剩余额度和有效期内。

### 最终真实验收发现的阻断

第一次正式13组验收在START02失败，原收据另存 `.local/skill-release/final-attempt-1-result.json`，原审查快照另存 `.local/skill-release/review-before-embedding-fix.json`。本次9次调用后主账本从70到79、已结算US$0.278053、预留0，状态变为breached。根因已核实：Mem0向量适配只按输入UTF-8字节预留，一条短查询预留9 tokens，百炼实际usage18 tokens；触发正确的超预留保护。共享语义向量适配已有每条64 tokens开销预留，Mem0侧漏了同一问题。真实调用已停止，不能将本次试用计为通过；将限定修复Mem0适配及回归，并在用户授权前保持账本封锁和原历史。

已完成该限定修复及12项Mem0测试；新增短文本/批量、输入上限及超预留后停止重试三个反例，修复前失败、修复后通过，证据见最终试用记录。独立审查重新核对新增改动，旧审查指纹不再用于关闭本增量。最终验收只调整执行顺序：先执行其余12组本地验收，START02置后；所有命令、断言、预算和超时保持，真实组未通过仍不能关闭增量。原账本于15:31:22 UTC到期；已请求用户批准恢复同一账本并从恢复时延长2小时，保留79次历史、实际费用和原120次/US$5总上限，尚未收到答复。

第二次正式验收前7组通过，ASSETS原有精确名称搜索断言失败，原收据保存在 `.local/skill-release/final-attempt-2-result.json`。根因是名称包含与完全相等并列，随机ID排序下长摘要分页可排除首页中的等名对象；新增确定性反例在修复前失败。修复保留名称包含优先级和分页边界，先排名称完全相等，未改原ASSETS断言。审查再次设为pending，最终状态须由修复后完整执行证明。

第三次正式验收前10组通过，REGRESSION中的核心会话、模型协议、记忆、查询及完整知识流程全部通过，浏览器主流程和时间线也通过。历史浏览器测试直接造数的230表缺少维护归属，目录API返回404；新增前提断言已复现，限定补齐本批测试数据，所有原分页与长文断言保持。失败收据另存 `.local/skill-release/final-attempt-3-result.json`；产品修复仍为6项，完整增量未完成，千表检索及最终真实组仍待执行。历史浏览器及管理按钮完整复跑通过；仅将REGRESSION内部千表检查置首，优先取得此前缺少的完整结果，其余命令、断言和4200秒组合上限保持。

### 真实试用等待时间调整

第六次验收在START02的首条输入等待180秒后退出。已完成的官方模型调用分别耗时51.097、8.887、21.280、88.013秒，四次原生read和任务更新已成功，最后一次模型回执在停止时未知，按原规则保留预留。不是业务断言失败，也不把未知回执计为成功。失败收据`.local/skill-release/final-attempt-6-result.json`及调用对照`.local/skill-release/real-provider-latency-20261008.json`保留。

原值：真实测试每条输入等待180秒，START02整组600秒。新值：每条输入360秒，整组1200秒。依据是上述多次有效官方调用的累计耗时和此前完整真实成功，等待上限用于容纳当前provider延迟；产品模型请求超时、输入/输出限制、运行状态和所有业务断言保持。该调整仅影响验收包装器，不改变已确认的产品行为或加入隐式重试。独立审查已通过该限定改动，当前范围指纹为 `e620b750315d1851a13792bd5e93426cd9405e2a3a3b01eb3b0d4d9255982b0d`，按新等待范围重新冻结执行。

### 本轮验收与要求变更

本轮未改变产品要求。扩大回归发现三个测试维护问题，均先保留失败再修正：旧“新增Skill”定位改为“新增个人 Skill”；关联造数补齐正式语义归属，不放宽105字段、四类内容及权限断言；捕获式记忆测试用公开撤回结束旧输入，防止假的未完成输入重领挡住后续消息。三项独立复跑均通过，原失败、修正依据和日志见最终试用记录。独立对照确认多目标取消测试在取消前已被1500ms短租约触发换代；改用现有默认15000ms并新增取消前基线，保留全部次数、状态、预算及Bridge 409断言。完整语义流程已通过取消及全部预填反例，后段发现重新预填重放缺少maintenance字段；已修复早返回分支并通过原严格回执测试。

最终审计已修复四项产品问题：私人Skill新建后的分类、编辑会话迟到回执、依赖故障时读取旧回执，以及重新预填重复回执缺少维护信息。尾部检索覆盖测试也补齐了直接造数缺失的系统归属关系，保持其候选数量、过期来源及精确命中的原断言。

业务协议fixture单独同步已确认的128KiB请求体配置，完整业务回归通过；官方profile与硬限制不变。原生Skill捕获测试补失败查询结果唤醒的收尾，不改生产行为。千表预跑外层900秒超时，未取得完整结果；正式REGRESSION组合等待由2400改为4200秒，以容纳三段千表建库/重建及其他回归，数据规模和所有断言保留。各项原失败均保留，详细依据见最终试用记录。


</details>

## 上次交付：四项修复、Pi 原生 Skill 与空间公共方法（已完成）

`goal_revision=29`，增量 `I2-NATIVE-SKILLS` 已完成。设计、契约、迁移、实现、架构图、README、独立审查及完整冻结验收已同步。沿用 `codex/semantic-role-boundaries`，本轮改动保留本地未提交状态。

确认规则：公共 Skill 仅当前空间；任意当前成员可以明确发布自己的 Skill，发布人成为负责人，负责人和本系统超级维护者可修订/停用。其他成员可以选用和提修改建议。个人 Skill/记忆仍私人；公共方法不授予 Datasight 读取或执行权。首次发布创建独立公共副本，后续从公共入口修订，不自动同步私人改动；发布只包含页面预览的方法、附件及知识引用，不携带私人来源原话。

实施细节采用最小方案：M09沿用资产ID/版本/操作账本，新增可见范围、受控文本附件、公共发布映射和建议记录；旧数据默认personal。建议以待处理/已处理/已驳回表达，处理不自动修改正文。Pi复用公开loadSkills、ResourceLoader及createReadTool，数据库正文通过受控读取交付，关闭SDK直接文件命令；模型仍只接触用户明确选定的有效版本。

原 `I2-ROLE-BOUNDARIES` 完成记录见提交 `cdf4b0c` 中的 CURRENT，原审查/收据不修改，本地声明快照在 `.local/skill-delivery/previous-delivery.json`。本轮已生成自己的完整执行收据，旧收据继续保留其原有范围。

按设计与同源契约完成启动诊断、资料/错误反馈、资产共享与选择、Pi接入、界面和测试。下节保留各阶段发现与修正，最终完成状态以“最终验收与边界”为准。

### 本轮进展与验收调整

- 新增共享资产、明确发布、建议、选择摘要和 Pi 原生 read 接入已进入实现。共享权限/并发接口测试通过，完整验收与独立审查待完成。
- 启动阶段日志下，原 Flash/Mem0/hybrid 配置首轮成功：Mem0 13.05 秒、Pi 14.79 秒，保留原 25 秒等待。无法据此归因上次偶发超时，重复启动与真实调用待验。
- 新选择测试原先假定“停掉 mock 平台会让已同步知识依赖不可用”；实际来源版本由已提交快照校验，平台断连并不删除来源，200 符合现有契约。改为在独立测试库短暂重命名 source_heads，验证真实存储故障返回失败并恢复表名。成功状态的断言未放宽，也不把业务无效与服务故障混同。
- 重复启动确实发现并修复一个端口预检问题：服务退出后 TCP TIME_WAIT 被未设置 SO_REUSEADDR 的探测器误判为端口占用。独立回环实验复现 errno 48，设置后可绑定；启动器新增“关闭连接可重启”和“活跃监听仍拒绝”回归，9项通过。该原因解释本轮重复启动失败，不能直接证明上次 Mem0/Pi 健康超时也是同一原因。
- 契约206项、Rust格式/Clippy、TypeScript、Web构建通过。SQL边界、资产目录、上下文依赖和Pi恢复回归通过。视觉检查发现移动端原有 quiet 样式遮住新公共方法负责人，已限定修正并补可见性断言；完整冻结验收待完成。


- 独立审查发现并修复：中文单行可超过 Pi 原生 50 KiB 上限、资产跨编辑会话及成功建议提交错误复用操作身份。新增服务端中文长行正反例、网页同内容跨种类/同种类新建与重复建议、原生字面命令、公共方法同输入失效和平台执行拒绝反例。
- 新增 read 后受控工具集合为13项，旧provider门槛为12导致全部拒绝；本地真实OpenAI协议先复现失败，修正后15次协议调用通过（0官方请求），新增PROVIDER冻结验收。旧“tools=12”预期按新增已确认read契约改为13，原预算、请求体、业务断言保持。
- 当前7组原生Skill行为、7组公共权限/附件、3组选择摘要、6组浏览器流程均通过；契约206项与verify-code再次通过。实际查看桌面/390px截图，公共负责人提示可见，新增按钮使用现有样式。架构5视图及28张模块图生成检查通过，图义保持。
- 真实栈已连续正常启动；真正模型调用被原持久账本期限拒绝。只读核查为120次/US$5额度、已用0/US$0/预留0，expires_at已过期。已向用户请求同一账本延长2小时，未改期限、身份、额度或重置记录。真实Skill/Mem0闭环尚未通过，不能用本地结果替代。
- 真实验收进一步限定本次manage_personal_asset回执的ID/版本、唯一合成范围、索引状态与跨会话召回目标，同时核对SQL修订的web条件。避免借持久试用库中的旧记忆误报成功。该脚本尚待有效预算执行。


### 最终验收与边界

- **完整十组冻结验收通过，增量已关闭。** `make verify-increment` 于2026-10-07 13:49:20–13:57:03 UTC完整执行 START01、START02、FEEDBACK、SHARED、SELECTION、NATIVE、QUERY、CONTRACT、ASSETS、PROVIDER；全部退出0、无超时、前后指纹一致。正式收据：`.local/delivery/I2-NATIVE-SKILLS-result.json`。
- [独立审查](reviews/native-skills-review.json)通过当前实现和验收脚本，范围指纹为`47c96fa17e982be37b415d43e4cac4ec7bc181c80ac965f6c37195bad972818c`。审查者未参与实现，复核了需求、契约、失败修复、真实证据及用量；其定稿先于最终十组执行，最终完成证据由上述收据提供。
- 两轮真实Flash/Mem0/hybrid合成试用均通过，每轮6条输入：原生Skill及附件读取，SQL生成、渠道修订、用户确认后查询、结果解释，以及本次新建私人记忆索引和新会话同ID/版本召回。第一次报告在`.local/skill-delivery/real-990dce60-9796-4c92-9272-5a29cde333ca/report.json`；冻结验收报告在`.local/skill-delivery/real-dd56a4ab-6f23-4a55-8e1e-36aa0a5b8740/report.json`。
- 主试验账本累计70次调用，全部已结算且ID唯一：Agent 45、知识向量6、记忆向量17、记忆抽取2；实际费用265999微美元（US$0.265999），预留0。明细求和与总账一致，仍在原120次/US$5上限内。未重置、补额或创建新试验绕过预算。
- 原独立向量维护账本历史30次/498微美元/预留0，已于13:17:38 UTC到期，本轮未改其期限或额度；只读快照见首次成功目录的`embedding-ledger.json`。本次查询向量、记忆抽取/索引/召回已在有效主账本内完成；未据此宣称独立维护试验仍可继续运行。
- Rust workspace构建、verify-code、架构边界、Pi恢复额外回归、291项材料检查和16项验收检查器自测通过；冻结CONTRACT执行206项同源契约案例。实际查看本轮桌面和390px页面截图，已选版本、公共负责人及操作入口可见。证据分别在`.local/checks/workspace-feedback/`、`.local/checks/native-skills.json`及`.local/checks/shared-skills.json`。架构5视图及28张模块图已同步并通过生成检查。
- 验证边界：模型、Mem0及向量服务为真实接入；Datasight、身份和业务数据使用合成mock，尚未证明真实平台ACL或生产部署。原历史Mem0/Pi偶发健康超时具体原因仍未证实；本轮连续启动正常，有证据的修复为TIME_WAIT端口误判及分阶段诊断。两轮小样不代表总体准确率。
- 自测观察：真实回答较长，包含任务ID等技术信息；记录为后续表达优化，不增加本轮实现范围。没有剩余代码发现或冻结验收缺口；未提交、推送、部署或重启用户常驻实例。

### 验收过程与脚本修正

- `.local/checks/native-local-validation.json`保留此前9组本地验收的partial收据；完整十组已另行生成正式收据，未覆盖该历史证据。
- START02原先尝试读取TaskSnapshot中不存在的conditions；依照服务端契约，改从同任务及同条件版本的update_analysis_task正式回执核对web渠道，并保留SQL或参数含web的断言。修正经独立审查和两轮真实执行验证。
- 用户选择A授权同一主试验账本延长2小时，保持120次/US$5总上限及全部历史。数据库时间2026-10-07 13:31:22 UTC执行，新的到期时间为15:31:22 UTC；前后只有expires_at改变，当时调用/费用/预留均为0。证据：`.local/skill-delivery/budget-extension-a68a7923-444e-4065-a4a1-d063248cb248.json`。
- 延期后首次脚本在调用前失败：MySQL JSON_OBJECT返回布尔true，原断言错误要求数字1。修正为严格要求true，仍拒绝false；失败记录在`.local/skill-delivery/real-543704cc-c501-4f69-a2ae-e537609e2393/report.json`。未改变期限、额度或产品预期，未消耗模型调用。
- 首次真实成功后核对报告明细，发现原查询只按model_call_attempts.trial_id取记录，遗漏通过budget_scopes.model_profile关联的主模型调用；总账正确。报告补LEFT JOIN及COALESCE关联，未改业务或验收断言。首次成功目录的`usage-reconciliation.json`核对当时29次/134013微美元；冻结验收使用修正后的查询，70次明细与总账完全一致。原失败及成功报告保留。

## 上次讨论：原生 Skill 与个人/公共范围补充

`goal_revision=28`。用户已选择采用 Pi 原生 Skill，并提出个人与公共分类，要求总结全部待办及执行包缺口。本轮继续范围讨论、权限选择与交接材料补充；不修改产品代码、不提交推送。

### 已确定方向与全部待办

- Pi 原生 Skill 从“后续候选”调整为本次需要设计接入的方向。继续复用 Pi SDK，Rust/MySQL 保留正式记录、业务授权、版本与选择；尚未接入完成。
- 全部工作为四项 dogfood 修复（启动、同名来源、错误提示、Skill 工作台反馈），两项 Skill 增强（原生接入、个人/公共），加相关设计/API/存储/架构文档更新与整体验收。[执行包](dogfood-repair-execution.md) 已按此更新范围，保留原四项细节。
- 原执行包不足以覆盖新增范围。公共 Skill 的权限、发布边界、存储迁移、接口和验收还需补齐，不能用此前“准备完成”的结论开始全部编码。
- 原四项问题仍未修复；当前源码仍为 `cdf4b0cd783afc0b3a5461d8944ba09ce0c95986`。原生接入及公共分类尚无实现验收，上一轮 Oracle 仅审计当时材料，不覆盖新增公共方案。

### 待确认权限与推荐方案

已向用户提出两个选择题，答案尚未返回：

1. 公共可见范围：推荐仅当前业务空间；另一选项为全系统跨空间。
2. 发布与维护：推荐空间内任意成员明确发布自己的 Skill，发布人成为负责人，由负责人和本系统超级维护者修改/停用；另可选择仅语义维护成员发布，或经超级维护者审核发布。

以上推荐不是已确认决定。公共方法可用不授予 Datasight 数据读取或 SQL 执行权；个人记忆继续私人，个人 Skill 也不因新增公共区而自动公开。发布前预览、私人/公共版本的关系及建议处理方式，须在权限答案后细化。

### 验证、范围与下一步

本轮只更新 CURRENT 与既有执行包，不修改旧 `delivery.increment=I2-ROLE-BOUNDARIES` 的冻结声明、审查或收据，也不放宽旧验收。新增完整范围尚未达到可开工状态；收到权限选择后补齐其接口、迁移和行为验收，再登记相应增量。四项中无依赖的诊断和修复可在后续实施授权内独立推进。 本轮 `make verify-materials verify-delivery` 通过（286 项材料检查、16 项检查器自测，原收据仍有效），执行包链接与 `git diff --check` 通过；这些检查不代表新能力已实现或权限已确定。

## 上次完成：四项问题审计与修复执行包

`goal_revision=27`。用户要求本机复核、Oracle 外部审计四项 dogfood 问题，核对 Skill 是否复用 Pi，再整理执行包。当前授权是审计与交接准备，本轮不修改产品代码，不提交推送。源码基线 `cdf4b0cd783afc0b3a5461d8944ba09ce0c95986`，沿用 `codex/semantic-role-boundaries`。

### 审计结论与交接

- [综合审计](reviews/dogfood-and-pi-skills-audit-20261007.md)：DF-01 启动阻塞及诊断不足成立，具体根因仍未知；DF-02 来源身份不易区分、DF-03 错误信息丢失、DF-04 会话 Skill 选择不可见均成立。四项保持未关闭。
- [修复执行包](dogfood-repair-execution.md)：固定允许路径、顺序、现有 AppError 复用、来源展示、一个会话级 Skill 选择 GET 接口、验收与关闭标准。真正开工再登记新修复增量，现有 `delivery.increment=I2-ROLE-BOUNDARIES` 继续保存上次开发完成事实和收据。
- Skill 当前复用了 Pi 的 Agent 运行能力，个人 Skill 由应用校验后供给正文，`getSkills()` 仍为空。系统设计第 12.3 节已明确这是 MVP 取舍；原生 Skill 装载器迁移单列候选，不自动加入四项修复。
- Oracle 单次咨询 `dogfood-skills-audit-20261007-180411` 已完成并退出 0；档位 `Power, item 4 of 5 (slider ARIA)` 经核验，答案已捕获，本次 Chrome PID 与临时 Profile 已清理。已逐条核对建议，纠正“20 项是产品上限”、同步全部回滚的提示和直接并入 Skill 迁移的范围。
- 本机补充探针：Mem0 等依赖导入 8.764 秒、Pi 交付模块导入 16.604 秒；三组 SDK 目录格式小样符合源码。无业务模型请求，不代表完整服务或真实模型通过。脱敏原始证据在 `.local/oracle-dogfood-audit/`。

### 验收与要求变更

本轮不改变产品要求、旧断言、旧收据或角色增量冻结契约。审计补充了需要修复的证据和待实施验收；完整栈恢复、四项修复及真实试用均未由本次文档任务完成。`make verify-materials verify-delivery` 已通过（285 项材料检查、16 项检查器自测，原增量收据仍与输入一致）；另核对新文档 24 个内部链接、敏感信息模式及 `git diff --check`。这些只证明文档交付，源码未改，未重跑整体 MVP。

下一步：按用户后续实施指令领取执行包，先诊断 DF-01，再完成三个有明确原因的修复；未解决的真实启动问题不能由模拟通过覆盖。

## 上次完成：提交推送与实际试用记录

`goal_revision=26`。用户已授权提交推送当前修复，再实际使用系统并记录结果；此授权替代上一开发轮不提交/推送的操作限制。沿用 `codex/semantic-role-boundaries` 分支，先提交并推送已验收代码，再进行合成数据试用并提交试用记录。不合并其他分支、不部署或覆盖现有常驻实例，不因试用发现问题自动增加功能。

试用重点为工作台、语义维护、创建者归属、跨用户纠错、负责人转交、停用对象找回及个人积累。使用现有启动和测试工具创建独立环境；模型模式与实际覆盖在报告中逐项说明，不把模拟流程计作真实模型准确率。问题记录复现步骤、预期/实际、影响和状态，源码不在本轮自行扩修。上一个增量的冻结契约与完成收据保留。

### 本轮交付与试用结果

- 修复提交 `a6ee376` 已推送 `origin/codex/semantic-role-boundaries`，远端 SHA 已核对；没有合并默认分支。
- 通过真实浏览器操作验证三类合成用户的语义维护、私人草稿与共享纠错、接受后另行保存、驳回、创建者归属、停用找回、负责人转交及旧页面权限、个人资产隔离和工作台草稿/历史入口。390px 页面无横向溢出，无页面脚本错误。
- [完整 dogfood 记录](research/semantic-governance-dogfood-20261007.md) 保存操作、截图和 DF-01–DF-04。真实模型环境启动被 Mem0/Pi 就绪超时阻塞，账本调用、费用及预留均为 0；后续管理页面使用 capture 宿主、无 Worker，不能代表真实 Agent 或 Mem0 通过。
- 待处理：DF-01 本机服务启动阻塞；DF-02 同名样例目录难以区分；DF-03 同步冲突只显示错误码；DF-04 Skill 已选用但工作台缺少反馈。本轮只记录，没有扩修产品代码。试用记录任务完成不等于这四项已修复，下一步由后续授权决定。
- 本轮原始证据在 `.local/dogfood-20261007/`；原增量 `I2-ROLE-BOUNDARIES` 的冻结契约、十组收据和独立审查保持。文档提交后另核对 Git 推送及工作区状态。

## 上次完成：修复角色与维护边界（已验收）

`goal_revision=25`，增量 `I2-ROLE-BOUNDARIES`。保留此前三项修复；用户授权仅收尾复审发现的两处显示读取问题。基线 `0db0bb8`，本地分支 `codex/semantic-role-boundaries`。

- 负责人同步：读取并校验各表时收集负责人，完整分页完成后与同步成功回执在同一事务内提交；沿用现有授权 → 来源 → 知识锁序与版本校验，失败保留原角色快照。来源元数据仍采用现有逐表提交。
- 转交校验：复用当前可信登录身份目录，限定当前空间有效成员；当前 mock 身份，未来接入不在本轮。超级维护者的选择列表和服务端校验使用同一目录，空值仍表示撤销。
- 管理目录：补“全部对象 / 我负责的”与状态、名称、分页查找，允许独立对象和关联对象进入详情；Agent检索继续排除停用项。
- 角色本身不改：表/字段来源于Datasight；独立对象创建者负责；引用不传递维护权；超级维护者不获得平台查询权或他人个人资产。
- 本次复审收尾：页面分别比较知识与负责人版本，旧目录不覆盖新负责人；创建资格展示读取已提交快照，实际创建继续锁定当前授权。

### 验收与要求变更

审计在隔离环境复现同步失败却授予权限、无效用户转交成功和停用文档不可发现。证据 `.local/checks/role-audit-20261007.json`，仅作为修复前证据。新增 ROLE01–ROLE05，保留直接相关治理与归属原断言；最终增量收据见下文，旧收据不覆盖本轮变更。

ROLE01 初跑在故障夹具创建时遇到 MySQL 客户端分隔符错误；给复合触发器补 `DELIMITER`，保持最终提交失败、原归属不变及重试断言。此前执行不计为通过。

ROLE03 初跑错误地要求语义搜索结果总数为零；原检索按中文二字词与关键词召回，允许返回其他相关启用对象（系统设计第 1、15 节及既有 retrieval::tokens / knowledge::matching_in_tx）。改为检查停用对象 ID 不在结果中、所有结果均启用，并增加停用前能找到该对象的正向对照。管理目录、越权启用和分页预期保持；不改产品搜索规则，首次失败不计为通过。

ROLE04 初跑在关联详情场景按表显示名定位时，命中内置资料与平台导入两个同名样例。改为从工作台重新进入默认的内置样例表，再打开其关联文档；创建、停用离页找回、启用及成员转交均保持真实页面操作和原断言。

验收绑定检查发现 D10/C04 未绑定当前八组命令。补入既有 GOV02（平台执行权与语义维护权分离）和 GOV05（私人资产隔离），共十组；保留全部需求映射，不增加产品能力。

独立审查定向复现目录展示与本次批量改派之间的反序死锁（`.local/checks/semantic-role-lock-reproduction.json`）。仅对知识与建议列表/详情展示采用已提交权限快照，编辑、提交、审核和应用建议继续在事务中加共享锁重验当前权限；ROLE03 增加未提交改派期间的真实接口读取，以及等待改派提交后拒绝旧负责人的保存/审核。此修复属于负责人统一提交的并发边界，不改变角色或产品范围。

### 此前修复后验证（本次复审前）

- ROLE01/ROLE02 预跑通过；最新 ROLE03 的目录、103 条分页、停用排除和并发权限快照两组行为完整通过，证据 `.local/checks/semantic-role-{sync,members,directory}.json`。ROLE05 当前空间成员单测通过。
- ROLE04 浏览器 5 项流程完整通过，实际完成无关联文档/指标停用后离页找回与启用、成员下拉转交、关联条目详情；已查看 1440px 和 390px 截图，筛选、名称、状态、负责人和操作均可见，无横向溢出或页面脚本错误。证据 `.local/checks/semantic-role-browser/result.json` 及同目录截图。
- 最新实现已通过 Rust fmt/clippy、TypeScript 和 Web 正式构建。194 条同源契约、281 项材料检查、16 条交付检查器测试、7 条架构反例与 28 张图册检查通过。构建保留 bundle 大小提示；本轮不扩展构建优化。图册用既有渲染器刷新来源校验，未变图形保持原文件，部署拓扑没有改变。
- 独立审查已通过（`docs/reviews/semantic-role-boundaries-review.json`）；本轮验证环境为隔离 MySQL、合成 Datasight、开发身份与真实浏览器，没有付费模型调用，也不代表真实平台或正式身份接入通过。

### 此前完成证据与边界（本次更新前）

`make verify-increment` 完整退出 0：ROLE01–ROLE05、GOV01、GOV02、GOV04、GOV05、OWNER01 十组全部通过，均未超时，执行前后指纹一致。最终收据 `.local/delivery/I2-ROLE-BOUNDARIES-result.json`，各组完整日志由收据引用；独立审查：[角色边界修复审查](reviews/semantic-role-boundaries-review.json)，无剩余阻断项。既有 `make verify-architecture` 的事务锁回归亦通过。

本轮仅完成上述三项修复及其同步/展示并发边界，角色规则、Pi SDK、Mem0、Agent 检索和 SQL 权限设计保持。系统设计、API、开发说明与模块资料已同步，图册来源校验有效。正式 Datasight 和正式身份接入仍属原有后续范围；无新付费模型调用，未重测模型准确率。本轮改动保存在 `codex/semantic-role-boundaries`，未提交、推送、部署或重启常驻实例。

### 本次复审收尾（已完成）

复审已确认两个场景：负责人由 Bob 转交 Carol 且详情已更新后，旧目录条目仍可把负责人及编辑/停用按钮短暂恢复为 Bob；`GET /semantic-access` 展示读取仍等待 Datasight 改派事务的写锁。修复前证据为 `.local/checks/role-reaudit-result.json` 和 `.local/checks/semantic-access-reaudit-result.json`，旧负责人实际写入返回 403，未发现越权。

本次仅修改 `KnowledgePage.tsx` 的独立版本合并、access 创建资格读取与 `semantic_governance::read_access`，扩充 ROLE03/ROLE04 对应两份测试并更新当前/审查记录。不改角色规则、页面布局、外部契约、SQL 执行、Pi、Mem0、数据库结构或依赖。来源负责人完整提交、成员转交和停用对象找回的既有未提交修改继续保留。

验收增补来自上述复现和既定 C02/D01/D13：ROLE04 不允许已更新的权限被旧目录覆盖；ROLE03 增加创建资格展示不等锁，以及正式创建等待改派后拒绝失去资格的用户。保留此前全部十组命令及原断言，不放宽超时或状态预期。变更前源码/测试/当前记录及审查记录保存于 `.local/role-display-repair/before/`；旧最终收据保存在 `.local/role-display-repair/previous-increment-result.json`，不用于关闭本次修复。

本次实现已限制在上述六个产品/测试文件：页面按各自版本合并内容、负责人和分析偏好；M01 的创建资格展示与写入入口共用同一查询条件，展示读取已提交快照，正式创建仍保留当前读共享锁。外部接口及角色规则均未改变。

- 修复前新增 ROLE03 完整失败于 `/semantic-access` 等待未提交改派锁，记录 `.local/role-display-repair/before-api.log`。修复前 ROLE04 组合执行在原有第二次“录入指标”按钮等待处超时，尚未到新增断言，不计为目标缺陷证据；明确的旧目录回退依据仍是前述独立定向浏览器复现。没有放宽超时、按钮条件或原有断言。
- 修复后 API/Worker 编译及 Rust 格式检查通过；ROLE03 两组全部通过，包含六个展示入口以及三类正式写入等待撤权后拒绝。ROLE04 六项完整通过，包含旧目录不得恢复 Bob 负责人及编辑/停用按钮、旧负责人写入 403，以及原有五项流程；1440/390 页面无横向溢出或脚本错误。
- TypeScript 与 Web 构建通过，保留既有 bundle 大小提示；模块边界检查、7 条架构反例、282 项材料检查和 16 个交付检查器单测通过。

Rust clippy 与独立审查已完整通过。最终联合验收首轮前六组通过，GOV02 在隔离 Agent 监听端口前健康检查超时，未进入业务断言；失败收据保存在 `.local/role-display-repair/first-final-result.json`，不计为完成。未修改 Agent、测试条件或超时：独立加载同一 Pi 入口成功（约 10.9 秒），随后单独 GOV02 完整退出 0。随后在相同冻结输入上重新执行十组联合验收，ROLE01–ROLE05、GOV01、GOV02、GOV04、GOV05、OWNER01 全部完整退出 0、无超时，执行前后指纹一致。预跑证据仍在 `.local/checks/semantic-role-directory.json`、`.local/checks/semantic-role-browser/result.json`；本次最终收据为 `.local/delivery/I2-ROLE-BOUNDARIES-result.json`，完整日志目录由收据各组引用；旧收据只作历史。独立审查记录 `docs/reviews/semantic-role-boundaries-review.json` 绑定 goal_revision=25，scope 为 `609c836d462b7b551b3293de121c9e78bfdd517e4a22b75e1763fdd6f8b7bc62`，无剩余阻断项。28 张图册的既有覆盖、链接及来源检查也通过。

本次仅新增这两处局部修复及回归，实际验证为隔离 MySQL、合成 Datasight、开发身份和真实浏览器；正式平台与身份接入仍未验证。未改 Agent、模型、超时、外部接口、迁移或依赖。改动留在现有分支，未提交、推送、部署、重启常驻实例或调用付费模型。

## 上次交付：创建者自动负责共享知识（已完成并推送）

`goal_revision=23`。用户于 2026-10-07 澄清并授权修正文档与实现、验收后提交推送。开发分支为 `codex/semantic-creator-ownership`，基线为主分支提交 `f253c19`；已快进合入默认分支 `codex/semantic-maintenance-prototype`。

- 当前空间最近一次成功同步的 Datasight 表维护人并集，构成共享知识创建人员；超级维护者也可创建。创建资格实时读取本系统同步快照，不另建成员管理。
- 表和字段由 Datasight 维护人负责。指标、文档、术语和关系等独立人工对象首次正式保存时，由可信登录者自动负责；其他维护者可创建自己的对象，对已有他人对象提出建议。
- 超级维护者保留调整独立对象负责人的能力；已调整或撤销的归属不被创建重试和升级覆盖。表交接只改变对应表权限和创建资格，已创建独立对象不随表交接转移。
- 升级只补齐有可信首次人工录入记录、原归属尚未设置的独立对象；系统导入和模型预填不冒认人类创建者。平台查询权、私人资产和建议接受后编辑保存的规则保持。
- 本轮同步 AGENTS、系统设计、模块/API、开发指南、README、架构图和 HTML 讲解。验收覆盖创建、归属、越权、幂等、迁移及浏览器，再回归原协作流程。使用隔离 MySQL 与合成平台，无需付费模型。

### 验收与要求变更

- 新增 OWNER01 初稿错误地把数据库故障写为 HTTP 500；按既有 `types/mod.rs`、`routes.rs` 及 GOV04 的独立契约，修正为 HTTP 503 并新增 `unavailable` 错误码断言，完整回滚与重试断言保留。首次失败不计为通过。
- OWNER02 实测窄屏全局 `.quiet` 隐藏负责人；在现有样式中仅恢复语义负责人及创建归属说明可见，纳入新增量路径和指纹，保留窄屏可见断言。测试目录维护人变化时递增平台版本，保留原来源版本冲突规则。

旧规则要求超级维护者创建和指定共享对象负责人，新规则允许平台表维护人创建并自动负责；依据是用户本轮明确澄清。GOV01 原“新文档负责人为 null”改为可信创建者，其他越权和转交断言保留；新增 OWNER01/OWNER02。旧六组收据仅证明旧版本，不用于关闭此次修正；待新独立审查与冻结验收通过后再完成。

新增创建者权限、接口、页面和升级已实现。预跑 OWNER01 的 6 组接口/迁移行为及 OWNER02 的 6 项浏览器行为均完整退出 0；1440px/390px 无页面错误和横向溢出。证据：`.local/checks/creator-ownership.json`、`.local/checks/creator-ownership-browser/result.json`。Rust fmt/clippy、TypeScript、正式 Web 构建、187 条同源契约通过；7 条架构反例、28 张图册、16 条交付检查器测试和 280 项材料检查通过。

最终联合验收已通过：`make verify-increment` 完整退出 0，GOV01–GOV06、OWNER01、OWNER02 共 8 组均无超时，执行前后指纹一致。完成收据：`.local/delivery/I2-CREATOR-OWNERSHIP-result.json`；独立审查：[创建者归属审查](reviews/creator-ownership-review.json)，无剩余阻断项。已人工查看更新后的架构图与 390px 页面，负责人和录入/修改人均可见。

真实平台与正式身份仍待接入验证；本轮不调用付费模型，原有 Pi 相关回归使用 SDK 与模拟模型。独立审查者另行只读核对最终 8 组命令和退出结果、252 个绑定文件及 before/after/current 指纹，一致且无阻断项。

### Git 交付

修正提交 [14c38a3](https://github.com/yaoziyaoguai/data_agent/commit/14c38a3e3e950295821253e4dedf23f97673b841) 已快进合入 `codex/semantic-maintenance-prototype` 并成功推送；随后通过 `git ls-remote` 核对远端完整提交一致。本节完成记录另作同分支文档提交。本轮未重启既有常驻实例，新行为在隔离测试实例完成验证。

## 上次交付：合入主分支并推送 GitHub（已完成）

`goal_revision=22`。用户已授权提交本轮代码、合入主分支并推送 GitHub。该授权替代上一开发轮“不提交、推送”的限制；冻结的业务验收契约保留。本次只完成 Git 交付，不新增产品行为或部署。

- GitHub 当前默认分支为 `codex/semantic-maintenance-prototype`，沿用此分支；来源分支为 `codex/semantic-governance`。目标仓库为 `yaoziyaoguai/data_agent`，已公开。
- 功能提交 [f89dd4b](https://github.com/yaoziyaoguai/data_agent/commit/f89dd4b1ae267e0964b4facb37e9c71a23f0b991) 已从 `codex/semantic-governance` 快进合入默认分支。基线为 `cd8266702b1482178e0abac6acc7de366d067dc5`，合并无冲突。
- `git push origin codex/semantic-maintenance-prototype` 成功；随后通过 `git ls-remote` 确认 GitHub 主分支为同一个完整提交，工作区无未提交改动。本节交付记录随文档提交同步至同一分支。
- `make verify-delivery verify-materials` 通过：已完成收据与当前契约及 246 个绑定文件一致，16 项检查器测试、280 项材料检查通过。GOV01–GOV06 原冻结验收全部退出 0，无超时；本轮源码未变，复用该证据。
- `git diff --check` 通过；待提交的 63 个文本文件未检出疑似 API Key、GitHub Token、私钥或个人绝对路径。本地凭据、运行收据与截图仍留在被忽略的目录中。

此次功能及其设计、接口、测试、架构图和独立审查已一并交付；真实平台接入边界继续见下节。

## 已完成增量：语义维护权限与跨用户纠错

`goal_revision=21`，用户授权按 AGENTS.md 和 dev_co 实现 MVP 后的第一个增量；替代上一轮仅更新文档的限制。开发验收阶段未提交、推送或部署；后续 Git 交付见上节。

- 表负责人必须来自 Datasight 维护人，当前使用平台 mock，在来源同步时更新本地授权快照。页面显示来源；每次正式变更在事务内锁定并重核当前授权。未同步的平台变化不能宣称实时生效。
- 指标、业务文档等共用对象独立指定负责人，由本系统超级维护者配置；引用的表不传播维护权。超级维护者由可信启动配置指定，不从浏览器、模型或录入人推导。
- 保留私人提案表，新增独立的共享提交记录。普通用户可提交明确整理的内容；只有提出者、目标负责人和超级维护者能读。接受/驳回不改正式知识；核对编辑保存后才创建版本和索引待办。
- 本系统语义维护权限与平台查询/执行权限独立；聊天、Mem0 记忆和 Skill 仍按本人隔离。

### 实施与验证

实现已接入现有语义管理页面。GOV01–GOV05 分别覆盖逐对象权限、两套权限独立、跨用户协作、事务与幂等、共享内容和个人隐私边界；GOV06 使用真实浏览器验证完整操作。六组最终验收已在冻结版本上完整退出 0，无超时；执行前后指纹一致。`make verify-increment` 通过，增量已置 complete，证据为 `.local/delivery/I2-SEMANTIC-GOVERNANCE-result.json`。受影响回归与静态检查也已完成。

- 后端复用 M01/M02 的私有存储及具名用例；同源契约新增共享建议与授权响应。旧私人提案保留本人范围，录入人/修改人/负责人分开记录。Pi 仅更新既有工具说明，继续使用 SDK 的会话与工具循环。
- GOV04 已补充并通过目录移除与改派/新增表同时发生的三个并发场景。旧首次来源同步回归修复后通过；来源当前读、缺失集合重核和授权锁顺序均经独立复核。
- 浏览器七项检查通过，含私人草稿、共享确认、修订重审、接受不生效、负责人编辑保存、驳回理由和响应丢失重试；1440px/390px 无横向溢出或脚本错误，已人工查看截图。证据：`.local/checks/semantic-governance-browser/result.json`。
- 受影响回归已通过：旧工具/提案边界 7 项、长文/分页/记忆 4 项、管理按钮 6 组。证据：`.local/checks/mvp-boundaries.json`、`mvp-completion-gaps.json`、`management-buttons.json`。最后锁序修复后的目录导入 12 项和来源/知识工作流 12 项也已复验通过；后者使用真实 Pi SDK 与模拟模型。证据：`.local/checks/mvp-catalog-import.json`、`mvp-knowledge.json`。
- 183 条同源契约、Rust/TypeScript 构建、7 条架构反例及启动配置 4 项通过；最后代码静态检查与锁序检查也已完整退出 0。公开材料、交付记录静态检查、HTML 讲解及 28 张图册已通过。

独立审查见 [语义协作审查记录](reviews/semantic-governance-review.json)。审查者未参与实现，确认已修问题与测试边界、无剩余阻断项；记录批准最终验收，实际六组执行结果以本轮收据为准。开发验收时分支为 `codex/semantic-governance`，尚未提交、推送或部署；既有常驻工作台进程未重启，新代码在隔离测试进程中验证。

### 接入边界

本轮使用隔离 MySQL、可实际执行 SQL 的合成平台及 Pi 模拟模型，官方模型调用为 0。表维护人以最近一次成功同步为准；真实 Datasight 资料 ACL、正式认证和维护人变更时效仍需实际接入。本系统超级维护者不获得他人的聊天/记忆/Skill，也不获得平台查询权限。现有 MVP 模型准确率和 Mem0 比较结论不由本轮测试重估。

### 验收与要求变更

- 本轮执行指纹不再包含 CURRENT 全文，避免写完成记录使刚完成的验收失效。检查器仍自动绑定完整 delivery 契约和已确认 18 项决定，AGENTS、系统设计、源码、测试和接口继续纳入指纹；验收命令与预期不变。此调整经独立审查确认。顶层阶段/状态和工作日志不受该业务收据保护；新产品决定必须同步契约或系统设计并重新验收，不能借修改日志沿用旧证据。一般材料验证仍读取 CURRENT。

- 原并发首次来源同步回归发现新增授权登记提前固定 RR 快照，导致第二个同步返回 404。空授权登记改为前置独立幂等事务，来源/正式知识/索引保持原事务，原 200/409 断言不变。独立复核另发现权威目录移除的授权/来源锁倒序；统一先撤授权再查来源基线，退休读取采用当前行锁，并在取得来源锁后重核缺失集合；GOV04 增加移除与改派/新增表的并发回归。必要修改范围补入 M03 私有 store，不改变对外权限或产品要求。

- 旧按钮测试直接采用私人提案，新页面改为“整理提交→接受→编辑保存”；旧私人记录保留，新增共享记录独立。更新原按钮脚本为这一已确认流程，并保留其他文档、查询和退出断言。
- 5100 字段分页测试仍直接构造隔离数据，补充新授权表的夹具关系，不删字段、不缩小检索或分页断言。
- Pi SDK 冷导入单独测得 41.508 秒。新增验收及受影响的知识工作流回归把启动就绪上限从原 20 秒设为 60 秒；纯授权场景复用已有 capture 接收端，SQL 场景仍使用真实 Pi SDK + 模拟模型。最初 20/60 秒启动超时保留诊断，不计为业务通过。
- 目录导入回归 `check-catalog-import.mjs` 在 20/60 秒均未等到 Pi bridge 启动（API 已就绪、bridge 无输出）。该组没有发送聊天或消费模型队列，原脚本也立即暂停 Worker；改用既有 capture 接收端并不启动 Worker，只验证真实 API/MySQL 与合成平台目录。全部原目录/快照/删除断言保留，不把该组当 Pi 证据。GOV02/GOV03 与知识工作流仍使用真实 Pi SDK + 模拟模型。

- 最新用户选择：表负责人沿用 Datasight（B）；跨表共用对象独立指定负责人（A）。新能力允许跨用户明确提交，不开放历史私人草稿。
- 原 MVP 私人提案采用端点作为兼容入口保留，补齐逐对象授权；共享建议必须经过接受与编辑保存两个动作。既有测试和评分保留，新测试来自上述已确认规则。



# 上一轮记录：设计文档

更新：2026-10-06。唯一活动项目目录：`~/work_space/data_agent`。本文件是当前决定、真实进度和下一步的唯一入口。


## 当前任务：语义维护权限与跨用户纠错设计更新

2026-10-06，goal_revision=20。用户只授权更新文档、资料和架构图；本轮不改产品程序。下面是已确认规则，`delivery.increment=I2-SEMANTIC-GOVERNANCE` 登记为 `planned`，表示后续实现待启动。本轮允许路径仅覆盖文档与图源；验收命令留空，实现前再绑定实际源码范围、契约、迁移和行为测试。

### 已确认的有效规则

- 表维护者就是该表的语义负责人。普通用户能对有权对象提建议，不能直接改正式语义；超级维护者可以维护本系统全部表的共享语义。
- 这是 Data Agent 内部权限。Datasight 的资料读取、查询、取数与 SQL 执行权限独立；任一侧的权限都不自动授予另一侧，系统超级维护者也不获得他人聊天、记忆或 Skill 的访问权。
- A 是纠错提出者，B 是表负责人。A 的本次问题先调查、修订 SQL 并重新确认；共享错误另形成可提交给 B 的建议。B 可驳回并记录理由，或接受后自己核对、编辑并明确保存；仅接受不改变正式语义。
- 建议提交只共享明确整理的修改和依据，原聊天/记忆/结果仍受原归属限制。正式保存创建新版本并原子登记索引/依赖待办，待处理和已接受建议不进入共享召回。
- 录入人、修改人、提出者和负责人分别记录。权限、基版本、建议修订、依据范围、重复操作和保存失败由 Rust 校验；Pi 与 Mem0 继续按已有职责运行。

### 当前实现差距

源码只以 `demo/alice` 作为演示维护者。`semantic_change_proposals` 的读取和采用按 `owner_id + space_id` 限定本人，没有逐表负责人、超级维护者或跨用户提交/接受/驳回流程。新增规则尚未实现；不能通过移除私人记录过滤来完成转交，也不能把旧 apply 接口当作“只接受、不生效”。

规则入口：[系统设计第 6.1 节](semantic-retrieval-design.md#61-语义维护权限与平台数据权限)、[第 11.7 节](semantic-retrieval-design.md#117-跨用户纠错与共享语义维护)。模块与数据入口：[知识模块第 2、3 节](architecture/knowledge-modules.md)；接口缺口：[实现设计第 4.2.1 节](architecture/implementation-design.md#421-语义协作接口)。架构图与讲解：[架构说明](architecture/README.md)、[语义与记忆讲解](visualizations/data-agent-knowledge-and-memory.html)。

### 验收与要求变更

- 原限制：建议仅本人可读、由本人获得维护权后采用，不提供跨用户转交。新要求：独立提交可共享建议，目标负责人/超级维护者接受或驳回，接受后编辑保存才生效。依据是本轮用户确认；D01、C02、A08 映射补充后续验收，原测试与历史评分保持。
- 既有 MVP 和共享向量增量在提交 `cd8266702b1482178e0abac6acc7de366d067dc5` 的完成结论保留。[当时 CURRENT](https://github.com/yaoziyaoguai/data_agent/blob/cd8266702b1482178e0abac6acc7de366d067dc5/docs/CURRENT.md)、原 `.local/delivery/I2-SHARED-EMBEDDING-result.json` 与独立审查保留为历史。本文和架构设计已变化，不能再用旧指纹证明新增协作已通过。
- 本轮只验证文档内容、材料链接、图源与显示，不重跑模型、数据库或整个 MVP。未来 GOV01–GOV05 尚无执行证据，planned 通过材料检查不代表业务完成。

### 文档交付与下一步

本轮文档更新已完成，状态 `done` 仅指本次设计交付；`delivery.increment.status=planned` 继续表示新增业务待实现。

- 已同步系统设计、M01/M02 模块与数据职责、当前接口/待补操作说明、README、开发指南、AGENTS.md、架构图及语义/记忆讲解。明确替代旧“仅本人采用”限制，保留旧行为说明和验收证据。
- `make verify-materials verify-delivery` 通过：281 项材料检查及 16 项交付检查器测试；planned 只证明声明和需求覆盖有效。`git diff --check` 通过。
- C4 总览及详图重新导出，11 个组件和 19 条关系方向与修改前一致，5 个视图未检出文字或标签遮挡。模块图册 28 张图、12 个模块重新生成，图源/链接检查通过；无脚本错误或窄屏横向溢出。未变图源的 SVG 保留原导出，避免无关的随机 ID 变化。
- HTML 讲解仍为 8 节，写作检查 0 警告。1440px / 390px 的目录、明暗与主题切换均通过；无页面横向溢出、缺图或脚本错误。更新后的纠错图宽 250px，可在窄屏完整显示。人工查看了纠错图和 F02 导出；189 个本地文件/标题链接核对通过。
- 未负责编辑的审查者只读核对权限、隐私、状态、源码差距及旧验收边界。发现并修正“提交建议也似乎要求维护权”的歧义，复核后无剩余阻断项；仅针对文档，不充当新增业务验收。
- 本地检查与截图保存在 `.local/semantic-governance-docs/`，包括 `structure-checks.json`、`browser-checks.json`、`document-review.json`。产品源码、可执行契约、迁移及业务测试未变；未调用模型或数据库，未提交、推送。

实现前需细化表负责人初始化/变更来源、跨表公共对象归属及跨空间角色配置，然后收敛源码范围并补接口、迁移和 GOV01–GOV05 行为验证。本轮没有启动产品实现。

## 上一开发增量：共享语义向量统一百炼（已完成）

本轮 goal_revision=19，`delivery.increment=I2-SHARED-EMBEDDING`。用户授权实际替换共享语义 E5 并提交、推送。范围限 Rust 向量适配、原预算复用、新集合迁移、启动配置、相关回归及文档。旧 MVP 收尾证据保留，新的源码不再沿用旧指纹宣称通过。

- 百炼 `qwen3.7-text-embedding`、1024 维，使用独立共享集合；复用已有本地凭据，私钥不输出或提交。
- 复用现有持久模型调用许可/结算；稳定请求身份和已成功向量回执用于恢复，未知调用保持预留。聊天查询沿用原请求预算，索引及页面检索使用明确维护配置。
- 默认模拟启动无外部付费；真实模式启用百炼。删除不再使用的 E5 依赖和下载步骤，正式语义与个人索引保留。
- 验证按上方四组进行；先协议和有限真实样本，再核对迁移/回源/预算及独立审查。

### 完成与验证

- Rust API/Worker构建通过；共享向量9项协议与集成边界通过，包括原预算、未知回执、拒绝工具、长文续租与集合恢复。两项向量单测、四项启动配置测试通过。
- 183条跨语言契约用例、Rust clippy、TypeScript检查及Web构建通过。架构总览/详图仍为11个组件、19条关系，5个导出视图无文字或标签遮挡；28张模块/流程图册重生成，无脚本错误或窄屏溢出。
- 百炼真实合成小样已通过：修正后56次调用、6,317输入token、原四个中文问题全部在前6候选命中，usage全部结算且未知预留为0。按¥0.5/百万token估算约¥0.00316；记录为 `docs/sources/evaluation/qwen-shared-trial.json`，保留数据库和回执供无付费审计。Mem0九项Python测试及九组接入/预算场景通过（41次回环调用、0官方调用）。
- 千表最终复验通过：1204张合成表、2408个新增对象，首次建索引和两次集合丢失后的完整恢复均成功；8项检查覆盖未知写入回执查证、旧版本、停用、个人隔离与明确降级。首次建索引606.4秒，整组1683.0秒；首轮360秒等待超时仍保留为历史失败，不宣称低延迟或千表真实模型召回率。证据为 `.local/checks/mvp-hybrid-retrieval.json`，该组使用协议向量、0次官方模型调用。
- 本机工作台共享索引迁移已通过：31个对象均在1024维新集合，`search_coverage`为complete/current/available，正式知识与个人资产版本正文摘要不变，原集合均保留。31份旧成功回执加模板余量后的最大上界2708≤8192，证明本次实际存量分批兼容；新维护trial仅收到1个短问句调用（18 tokens，2 micros预估费用，未知预留0），未给旧索引补额。证据为 `.local/checks/shared-embedding-migration.json`，工作台继续使用原Flash/Mem0配置与同一数据库。
- 独立审查见 `docs/reviews/shared-embedding-review.json`。随后 `make verify-increment` 完整运行 EMBED01–EMBED04，四组退出0、无超时，执行前后指纹一致；收据为 `.local/delivery/I2-SHARED-EMBEDDING-result.json`。最终真实小样审计复用既有回执，新增官方调用0次。独立审查者再次只读核对四组完整日志、收据及175份冻结输入，确认当前审查与执行证据有效，没有阻断提交、推送的问题。
- 共享语义运行时已移除E5及其下载依赖；README、设计、契约与架构图均按Qwen和Mem0的现行分工更新。本次替换没有剩余阻断项；真实平台、正式认证和同事试用仍沿用既定后续接入范围。

### 验收与要求变更

- 实际工作台短问句“净收入”9 UTF-8字节返回18 input_tokens，原仅按字节估算会误触发熔断。现改为每条字节数加64 tokens模板余量，固定分批总上界仍为8192；保留实际用量核验。旧32次维护账本（31个对象索引+1短问句）保留breached，费用未丢失，原成功向量保留。新的有限维护配置仅用于新请求/尚未绑定的新对象版本，旧作业不补额。原56次四题真实小样保存在 `docs/sources/evaluation/qwen-shared-trial-byte-estimate.json`；修正后重新用短问句与原四题核验，通过当前 `qwen-shared-trial.json`，不改旧评分。

- 千表初次新协议回归在原360秒索引期限超时，未通过；新增逐对象调用账本和1024维结果增加了网络/持久化工作。保留全部2408个新增对象与三次建索引覆盖，单次等待上限改为900秒、整组3000秒，并记录实际耗时；这不放宽任何业务命中或恢复断言，也不宣称低延迟。移除每对象重复集合核验，并取消有工作时的固定等待，避免不必要开销。

- 原千表回归使用本地 E5 并同时断言四个中文问法。替换后，`check-hybrid-retrieval.mjs` 使用通用字符 hash 协议向量验证 1204 张合成表、索引恢复、版本、权限、精确名称与降级；不把协议向量称为语义模型。四个原中文问法和前六候选命中要求保持不变，移至真实百炼小样，额外混入六类合成干扰对象。该小样不证明千表下的真实模型召回率；千表规模与中文语义质量分别报告。
- 云向量每个知识对象有多个付费批次。索引 Worker 改为一次领取一个对象，在各批外发前对尚有效的同代租约续期；完成后立即处理下一对象，空队列或错误仍等待。此为替换云调用必需的租约处理，沿用原 Worker 与索引作业，不增加调度系统。
- 独立审查发现并修正：集合变化保留该知识版本原维护预算；拒绝工具不新增向量调用。对应恢复与预算测试纳入 EMBED01。

## 上一轮：按定稿纠正架构图（文档已完成）

2026-10-06，用户指出架构首图未显示 Mem0、仍显示 E5，要求按最后定稿展示。本轮继续修正文档和图源，沿用上一轮提交、推送授权，不改业务代码或重建向量索引。

- 定稿表达为 React、Rust、Pi SDK、Mem0、DeepSeek Flash、百炼 `qwen3.7-text-embedding`、MySQL 与 Milvus；共享知识和个人记忆分别建索引。
- 核查发现实现差异：`apps/memory/service.py` 已接入 Mem0 + 百炼 Qwen 1024 维；`crates/data-agent/src/modules/retrieval/vector.rs` 仍使用本地 E5 384 维，`scripts/development.py` 和 `infra/embedding-model.json` 也仍对应 E5。共享语义链路尚待对齐，改图不代表完成了模型替换。
- README 首图改为包含全部 11 个组件的总览；保留三张详图及完整 19 条关系，提供 SVG、PNG、四页 draw.io。同名节点始终代表同一组件。
- 两个旧 HTML 入口默认展示定稿总览，历史草图折叠并标为已过时；README 和架构说明列出实现差异。
- 只修改 README、架构图源和产物、旧可视化入口及本记录。下方 `I2-MVP-CLOSEOUT` 的验收契约和历史评分保持原样；旧完成收据证明当时实现，不能证明共享向量已统一为 Qwen。
- 本轮验证通过：5 个 SVG 与四页 draw.io 均可解析，图形检查无文字溢出或标签遮挡；与重画前逐项比较，11 个组件和 19 条关系方向一致。README、架构说明及两个旧 HTML 的桌面 1280px / 窄屏 390px 共 8 次预览无横向溢出、图片缺失或脚本错误；历史展开与切换可用，74 个本地文件链接有效。浏览器核验保存在 `.local/publication/architecture-correction-checks.json`，图形检查见 `docs/architecture/diagram-checks.json`。
- `make verify-materials verify-delivery` 通过（262 项材料检查、16 项记录检查单测）；冻结的 MVP 独立审查和收据仍有效。`git diff --check` 通过。本轮没有重新调用模型或执行业务回归，这些结果仅证明文档修正和旧收据未失效。
- 剩余差异是共享语义向量接入与集合重建。本轮交付范围为文档纠正，不能据此将该实现差异标为已解决。

## 上一轮：公开文档与GitHub交付（已完成）

2026-10-06，用户确认当前MVP收尾，并授权分批提交、推送到已有GitHub远端，随后补充要求更新README图文和架构图，保持原有架构意义。本轮只做公开文档与Git交付，不启动新的业务开发增量；下方I2-MVP-CLOSEOUT的完成契约和原验收保持冻结。此前“不提交推送”的范围限制仅适用于上一开发轮，已被本次明确授权替代；部署不在本轮范围。

- README更新为项目入口：正式工作台合成截图、功能说明、启动方式、技术职责、独立验证结果与后续接入项。
- 架构图按会话运行、共享语义与查询、个人记忆分成三个视图；保留原有11个组件和19条调用方向，输出SVG、PNG及三页draw.io，新增架构阅读入口。未改变业务接口、存储归属或部署方案。
- 同步开发文档，标明旧交互架构为历史草图；公开截图逐张确认仅含合成数据，不发布密钥、私有会话或原始试用日志。
- 远端为`yaoziyaoguai/data_agent`（public），原空仓库已收到下列六批内容；沿用`codex/semantic-maintenance-prototype`，GitHub将首个推送分支设为默认分支。本地已设置upstream，未创建Release或部署服务。
- 发布前验证：`make verify-materials verify-delivery`通过（260项材料检查、16项记录检查单测）；独立审查及最终MVP收据仍与当前实现输入一致。新文档入口66条链接有效；README桌面1280px和窄屏390px离线预览图片加载正常、无横向溢出；三张详图和合集的文字/标签检查通过。11个组件、19条关系与重画前定义逐项一致。原始运行证据仍保存在被忽略的本机目录。
- 公开树共446个文件，约13.6MB；定向检查未发现已知密钥格式、个人绝对路径、公司表标识或私有目录。原型截图与本次正式工作台截图均为合成资料；`.env`、`.local`、`.private`、依赖和构建缓存由Git忽略。既有生成文件的末尾空行及历史Markdown显式换行保留，未为提交改写冻结源码或旧证据。
- 远端查证：六批内容的HEAD为`15142b855b80d903522d0a7e2f6f98125d76b7ba`，`git ls-remote`与本地一致；GitHub README对象为`2979184483b26e3ca259b097ce7a62cc158c32fd`，与本地文件对象一致。本节作为后续交付记录提交，业务实现及MVP完成契约保持不变。

| 提交 | 内容 |
| --- | --- |
| `3eb4e9e` | 固定工具链、依赖与本地基础设施 |
| `4684083` | Rust业务模块、同源契约、迁移与合成资料 |
| `85125a7` | Pi会话、受控工具与Mem0个人记忆 |
| `3a0400c` | React工作台、语义管理与个人积累 |
| `ba9b912` | 契约、恢复、业务回归与记忆比较实验 |
| `15142b8` | README图文、架构视图、设计、公开证据与原型 |

当时未安排继续开发事项。后续核对发现的共享语义向量实现差异见本文件最前面的当前任务；真实平台、正式认证和同事试用仍保留为后续接入范围。

## 最近开发增量：MVP两项修复与收尾（已完成）

本轮 goal_revision=18，`delivery.increment=I2-MVP-CLOSEOUT`。用户授权依次修复QUALITY-01与UI-03，验证通过后将当前MVP做到这里，不扩展功能。

- 自动记忆采用同一份最终正文：Mem0结果作为正文与适用范围，名称只作原文前缀标签，避免主Agent独立概括引入新指标；显式builtin按相同保存规则。人工维护仍保留用户填写的范围与名称。
- 先验证新建/修订、保存后回源、跨会话、人工维护与幂等，再处理助手Markdown渲染。
- 新增固定真实Flash/Mem0回归单列证据，历史5/6及失败原样保留；预算与运行目录独立。
- 按本增量四组验收及独立审查收尾；真实Datasight、正式认证和同事试用仍属于后续接入，不能冒称已验证。
- 两项实现和针对性验证已完成：记忆新建/修订/跨会话/人工维护回归通过；Markdown三组浏览器检查及桌面/390px截图通过。代码质量、178项同源契约、模块边界、Pi续接与原生压缩通过。
- 新的真实Flash/Mem0回归4条消息独立审查通过，两条SQL/14次变体通过；26次调用全部结算，估算US$0.073220、预留0。结果与独立审查在`.local/mvp-closeout/trial/`，原5/6不改判。
- 最终独立审查通过，收据`docs/reviews/mvp-closeout-review.json`绑定当前源码；随后`make verify-increment`实际运行CLOSE01–CLOSE04，四组退出0、无超时，执行前后指纹一致。正式执行收据为`.local/delivery/I2-MVP-CLOSEOUT-result.json`。
- 收尾决定：按用户要求，当前合成平台MVP在此结束，不再自动追加开发或评测。QUALITY-01与UI-03已修复；新回归不覆盖历史5/6及旧失败记录。真实Datasight、正式认证及同事试用的边界仍保留，未提交、推送或部署。

### 验收与要求变更

- 自动scope旧值来自主Agent参数，新值直接采用最终正文，自动名称截取该正文前40个Unicode字符。依据是用户授权修复范围扩写及正式Mem0正文正确的原始失败证据；不引入业务指标特例。人工API与旧存量版本不自动改写。
- 未删除既有测试、未放宽历史评分；新增样本不并入旧分母。

## 上一轮：Mem0 正式接入与整体验用（已完成，历史证据）

本轮 goal_revision=17，`delivery.increment=I2-MEMORY-ADOPTION`。用户要求按成功率选用方案并实施，同步设计和接口，增加真实试用案例，检查各接口/按钮并记录问题。完整场景两组均88.9%；以记忆管理94.4%对88.9%、SQL100%对91.7%作为持平时选择依据，采用Mem0，不宣称统计上已胜出。此决定替代此前“仅保留实验接缝”的建议。

- 接入范围：聊天原始消息由Mem0提取；MySQL仍是正式记忆真源，Milvus保存派生检索，Pi负责会话和工具循环。页面手动编辑、启停和删除复用正式资产规则及索引同步。
- 按顺序完成：固定模块/接口边界 → 接入及失败回归 → 同步设计/API/本地运行文档 → 代表性真实小样后追加固定新案例 → 检查现有接口和按钮 → 独立审查及增量验收。
- 真实调用继续沿用用户已授权的Flash与百炼embedding，全部材料合成；新试用使用独立持久预算，历史账本不重置。普通模拟回归不调用付费模型。
- 试用发现的问题统一写入本轮试用报告，标明复现、修复/剩余状态和证据；当前进度只维护本文件。
- 已实现正式Mem0侧车、原始消息预提取、MySQL事务保存和索引待办、人工编辑直建索引、M08逐调用预算，以及初始上下文/工具检索回源。新增索引目标隔离、存量自动回填与从正式正文重建，已通过当前增量验证。
- 已通过9项Python侧车测试（含真实SDK未知embedding回执停止重发）、8组Rust/MySQL/Worker联动检查、178项Rust/TS契约，以及代码质量、构建和28张图渲染。证据在`.local/memory-adoption/`和`.local/checks/memory-provider.json`。
- 正式Mem0/Flash/百炼/MySQL/Milvus与可执行合成平台试用已完成：6场景、10条消息、7条SQL。独立内容复核完整场景5/6（83.3%）、SQL7/7；纠错范围从月支付客户数扩写为月活，保留失败不补跑。39次数据变体是SQL辅助验证，不计入场景分母。账本累计87次、估算US$0.328441，均已结算、未知预留0，含调试失败成本。
- 首轮新会话带记忆被Pi契约拒绝，已修复WorkspaceContext字段及ModelAssetPreview投影；初次失败单独保留。已修复候选索引目标隔离、旧资产回填、索引外发前再授权、SDK未知后隐式重试、首提取回执丢失接回、记忆先检索再裁剪及轮询回退。当前正式试用证据为`.local/memory-adoption/trial/verified-result.json`。
- 目录缺项已用120个前置目录对象和105个字段复现并修复：现有列表增加related_id独立分页，四类关联页签通过浏览器验证。索引重建无配置的错误码曾不符合AppError契约，已补齐并显示明确提示。查询下一页和失败输入撤回按钮、退出刷新换Bob、非空本人建议读取与明确应用均已通过实际页面检查。成功重建另由集成检查证明，按钮503反馈不计成功重建。
- 设计、模块/架构图、OpenAPI/Schema、开发文档和README已更新；旧HTML标记历史接法。新增[真实试用与问题报告](research/memory-adoption-trial.md)统一记录分母、费用、接口/按钮覆盖与QUALITY-01未修内容问题。最终独立审查及五组增量验收均已完成。`make verify-increment`实际运行MEM01–MEM05，全部退出0、无超时、执行前后指纹一致；收据为`.local/delivery/I2-MEMORY-ADOPTION-result.json`，独立审查为`docs/reviews/memory-adoption-review.json`。证据检查只离线复核既有样本，本轮收尾没有追加官方调用。

### 本轮交付与剩余问题

- Mem0已成为正式DeepSeek模式的个人记忆提取/检索方案；显式本地mock继续使用无网络替身。正式资产在MySQL，Milvus可重建，Pi仍负责唯一Agent会话和工具循环。
- 五组验收覆盖：9项Python/8组记忆集成；代码与同源契约、架构、Pi会话/恢复/原生压缩；查询和知识/Skill流程；现有页面及6组管理按钮、关联目录分页；固定真实试用证据、7条SQL/39次变体及账本。未将替身调用计入模型成功率。
- 32个公开路由模式/38个方法组合已建立到集成/页面检查的对应表；不是所有参数与故障排列的穷举。实际页面重开真实查询结果并检查桌面/390px布局，无横向溢出。
- QUALITY-01：纠错scope和确认答复把月支付客户数扩写成月活，保留完整场景失败，未为100%追加重测。UI-03：长回答仍显示Markdown原始标记，作为后续体验问题记录。
- 真实Datasight、正式认证、同事实际使用反馈、大规模个人记忆和长期成本/延迟仍未验证；本轮完成的是正式接入、合成真实模型试用及现有接口/页面回归，没有改变I3要求或宣称整个项目没有问题。未提交、推送或部署。

### 上一轮：记忆修复与原始消息对比（已完成，历史证据）

本轮 goal_revision=16，`delivery.increment=I2-MEMORY-EXTRACTION`。已修复产品完整句/换行来源误拒，改成 Mem0 保存前直接提取原始消息，并完成固定12场景×2组×2轮测量和独立内容复核。最终报告：[原始消息提取对比](research/mem0-extraction-comparison-results.md)。

- 正常9类每组18次：完整成功均16/18（88.9%）；原方案/Mem0记忆管理16/18、17/18；SQL22/24、24/24。两组各2次成对领先，样本不足以证明稳定优势或自研更强。当时决定生产MVP仍用原方案、Mem0保持实验接缝；已被本页最上方的正式接入决定替代。
- 48组合全部尝试，108必要消息中107尝试、106完整；B保存故障场景1条模型请求失败、下一条未启动，原样计入。适用故障真正触达并完整处理：原方案保存1/2；Mem0提取2/2、保存1/2、索引1/2；其余未到达注入点或输出缺失，不能算故障处理通过。
- 正式证据目录 `.local/mem0-agent-comparison/20261005T141435351Z_0b6e2c3e/`。原result SHA `fd1bc196ac109e077663f92575cecd900dd51a023aa090fc4577a98dd3a0f503`；独立内容审查SHA `2032b653d912e620fd2d8d246cc186b4ac1b864a67c4bae6e3512a0838a6b6b1`。原机器评分保留，日志修正另存scoring-log-corrected.json；测量后3份证据采集/评分代码差异由独立measurement-source-review.json精确绑定，未改变模型、输入、业务或提取逻辑，没有补跑。
- 512次Agent请求，已结算估算US$2.400917、未知预留US$0.049152；Mem0额外40次提取/US$0.097539、186次embedding/¥0.0031075。未知预留保留，未补额。费用来自固定价表与usage，不是账户账单。
- 正常失败的主要后续改进点：三个保存失败共24次调用均裁去“请记住：”的引用前缀，反复改scope而没有修正引用。原生Pi journal及SHA已独立核对；后续可改善错误反馈，本轮不再扩展产品或追求100%。另有一次B解释退款快照错误，记忆与SQL本身正确。
- 产品仅 `crates/data-agent/src/modules/assets/mod.rs` 改变了旧MVP冻结输入。旧I2-MVP收据仅证明历史版本；本轮2项Rust来源、11项实验提交边界、10项评分、既有知识工作流12项与代码质量已通过，当前增量独立审查及六条实际验收均通过。方案、源码、输入均有明确范围；不提交、推送或部署。

### 上一轮结果（goal_revision=15，历史接法）

用户要求比较“原有方案与接入 Mem0 后的 Agent 正确率”。此前执行包和实施误缩为离线检索召回，据此作出的接入建议已撤回。上一轮按固定输入完成两组成对实测，结果见[完整对比报告](research/mem0-agent-comparison-results.md)。两组沿用真实 Pi SDK / DeepSeek Flash（原生 high）/ Rust / MySQL；B 增加真实 Mem0 OSS 2.2.1 的 `infer=True` 整理和检索，embedding 为已授权的百炼 `qwen3.7-text-embedding` 1024 维。只有正式保存成功的资产进入 Mem0，采用正文仍回源，权限、版本、停用和 SQL 确认继续由应用校验。

- 固定 11 场景、每组 25 条消息、14 个 SQL 探针；A/B 顺序交替，各组合一次，不抽换失败或修改提示。完整场景经独立逐题复核为 A 7/11（63.6%）、B 4/11（36.4%）；SQL 独立种子及 5 个数据变体核算为 10/14 与 9/14。B 有 2 题改善、5 题退步、4 题持平。旧 MVP 的 75% 与旧检索召回均不代替本轮结果。
- 正式目录 `.local/mem0-agent-comparison/20261005T111708793Z_5ccd2fe6/`。22 个组合全部已尝试，49 条消息尝试、46 条完整输出；A 有一条后续消息未开始，3 条模型请求未完成，固定分母均计失败。`allScenariosAttempted=true`、`completed=false`；已保留未知回执与预算。完整 `result.json` SHA256 为 `3c99b76b6032d666d6a9fe620d9fb1aefc6c5781e0abd10249cf5c59254befa0`，原机器评分 SHA256 为 `e62a021172e9295eb5686478d5af8776116fe75eac808fbf59f1d93cda77a012`。
- 原进程中断后，仅给 `agent-comparison.mjs` 和 `agent-memory-service.py` 增加恢复支持，继续尚未开始的 15 个组合；已开始的 7 个组合及失败全部保留。读取原账本、不重置预算，旧 result/source-map/集合和账本前缀保持。143 份原指纹仅这两个实验文件变化，恢复段单独记录，产品、题目、答案、提示、工具和评分器未变；结束指纹一致。5 项无网络恢复检查、8 项评分自测、语法检查与原 MVP 冻结收据核对通过。
- 已核实原 `memory_source()` 保存引用校验问题：偏好从“请记住：”后的冒号开始被拒绝；完整首句自身已含句号、后面还有另一句时也可能被拒绝。部分请求引用整条消息才保存成功。多项失败发生在 Mem0 接手前，当时仅记录，没有修产品或重跑。B 实际完成 6 次整理、一次停用删除，但记忆池至多两条；混合意图的派生索引包含本次查询，正文回源限制其直接成为长期依据。`index_failure` 未触发预设整理故障，降级能力未验证；`save_failure` 两组均由服务日志证实数据库 `SQLSTATE 45000`。
- 正式 Agent 共 331 次请求，已结算估算 US$1.537798、未知预留 US$0.147456；Mem0 额外整理 6 次 / US$0.015503，embedding 69 次 / ¥0.0016605，两者未知预留 0。账本沿用原边界。费用为 usage 与价格估算，不是账户账单；模型随机性、保存拒绝和服务失败影响结果，不能把组间差异因果归于 Mem0。
- 验收与要求变更（评分错误说明，原要求不变）：机器 A 6/11、B 5/11。`temporary_override::original` 正文说明“仅当用户当次明确要求 app、store 或全渠道时，当次以明确要求为准，本默认不在该次生效。”，机器把其中 `app` 字样误作长期偏好；独立核对资产 ID/版本/body 未变、临时 app 与之后 web 均正确，最终通过。`disable::mem0` 的 SQL 与停用通过，但解释错误声称 2 月 1–3 日事件未纳入快照，固定业务说明和 SQLite 数据证伪，最终失败。原机器评分与程序保留；最终审查收据为正式目录的 `independent-agent-review.json`，状态 `review_complete`，SHA256 为 `6e727604af58a887710a0c125f0bdf760e9f631f4c0199415a80885d825122f9`。独立审查核对报告、故障触发、原数据连续性及 MVP 303 份冻结文件；审查完成不代表所有题正确或已修复发现的问题。

可视化讲解：[原有记忆方案与 Mem0](visualizations/personal-memory-and-mem0.html)。页面对应上一轮接法，包含个人记忆与对话上下文的区别、两组流程、职责、示例及测量边界。

### 用户质疑后的比较结论复核

用户质疑“我们的方案比 Mem0 更好”是否成立。本次只读复核确认原始结果、评分、固定输入、独立要求和方案的 SHA 均与独立审查绑定一致；7/11 与 4/11 的计算不变，但不能据此判断原方案的记忆能力优于 Mem0。

- 5 个原方案领先场景中，`revision`、`temporary_override`、`combined_preferences` 的 B 组失败点是首次正式保存，发生在 Mem0 接手之前；`mixed_intent` 是后续模型回执未确认；`disable` 是最终快照解释错误。
- 2 个 B 组领先场景中，`money_unit` 的 A 组未正式保存单位偏好，`save_failure` 的 A 组后续模型请求未完成。这些差异也不能证明 Mem0 的稳定增益。
- 实际接法为“原 Agent 提取并经 Rust 保存 → Mem0 整理与检索 → 回源正式正文供 Agent 使用”。Mem0 在 11 个场景中只有 5 个到达真实整理，共 6 次请求；未接管原始聊天到正式记忆的完整提取与修订，派生正文未直接交付 Agent。至多两条的记忆池也不足体现大记忆检索差异。

当前判断为：本次特定接入小样未显示增益，双方记忆能力的优劣仍未验证。保留当前 MVP 是维持交付边界，不代表已证明自研更强；Mem0 继续作为候选。本次没有修改产品、实验程序、题目、原报告或冻结测量，没有追加 API 调用。后续若开展新的比较，应先处理共同保存阻碍，再用相同输入分别检验记忆整理与最终 Agent 采用；保留端到端失败统计，并用重复运行区分偶发调用失败与稳定差异。该补测尚未实施。

本轮没有修改 MVP 源码、契约、根依赖或原验收证据，没有提交、推送或部署。建议当前保留现有记忆方案；如后续改善，优先处理原保存入口问题，再单独验证 Mem0 的增益。任意聊天自由提取、大记忆池、SQL 按钮执行后的解读和真实千表业务仍未验证。本轮不追加模型运行。

### 上一轮检索小样（辅助证据，未回答整体正确率）

上一轮由当前 agent 执行[检索执行包](research/mem0-comparison/README.md)。现有Rust个人资产词法检索、同模型普通向量检索和真实Mem0 OSS三组已完成288次正式检索，错误0；冻结的24个合成资产/25个版本、32题及独立答案保持原样。[结果报告](research/mem0-comparison-results.md)已保存，独立复核通过并保留范围限制。I2-MVP继续保持complete，frontmatter中的delivery仍是已完成MVP的冻结契约，不改写成实验通过证据。

用户选择外部embedding服务，提供百炼凭据文件，并明确授权agent调研和选择合适模型。按官方当前纯文本推荐选择`qwen3.7-text-embedding`默认1024维，北京地域标价每千输入Token ¥0.0005。两向量组共用配置、前处理与归一化；在线服务不公开权重快照，向量非逐位一致，本轮有效前5排序稳定。共259次embedding调用、12,120输入tokens，标价估算¥0.00606，未知预留0；生成模型调用/尝试0。凭据只保存在忽略的本地实验目录，不进入实验源码或公开报告；未加载本地E5或读取DeepSeek配置。

检索小样结论：Mem0相对普通向量未显示额外检索收益；完整 Agent 正确率已在上文另测，旧检索数字不用于接入判断。正例Recall@5为77.3%/100%/100%，MRR@5为0.475/0.977/0.977；三组负例候选噪声均100%，不能当作最终采用准确率。边界违规和回源元数据缺失均0；失效记录由离线宿主快照过滤。未测试自动提取、冲突整理或Agent最终采用；不改写原MVP75%质量基线。

## 原MVP收尾结论（历史版本）

I2-MVP本地合成版本已完成，最终十项工程验收全部退出0、无超时，输入与独立审查指纹一致。固定DeepSeek Flash（原生high）的16题质量基线各测一次：机器流程16/16通过，独立内容判分12/16（75%）；该测量早于最后的检查点读取修复，独立差异审查确认保留原结果，未对修复后版本重测。[质量报告](reviews/mvp-accuracy-20261005.md)保留S01、B08、P01、P02四个错误；不再为语义100%追加开发或重测。基础权限、SQL只读与用户确认、版本、隔离、幂等和恢复继续严格验收。

142次本轮官方调用全部结算、未知预留0；之前的87.5%属于旧版本，不作为当前准确率。Pro对照及其未知预留保留历史，不再调用；尚未调用的max扩展已撤回。题目、独立答案和SQL核算规则未变，AC08验证完整测量和如实判分，不把失败题改为通过。

已按先收尾MVP、再调研的顺序完成[准确率与个人记忆研究](research/memory-and-accuracy-20261005.md)。当前个人记忆/纠错由个人资产模块及MySQL保存，Pi管理会话和原生上下文；尚未引入专业记忆系统。研究建议保留当前基线，优先小样验证Mem0 OSS、Hindsight作为第二候选；这是候选建议，不是接入决定。最终收据为`.local/delivery/I2-MVP-result.json`，独立审查为`reviews/mvp-checkpoint-repair-20261005.json`；先前失败与复核过程见文末，原记录均保留。
用户已授权合成mock数据和DeepSeek持续调用，无需再询问费用；用户最新决定将MVP固定为DeepSeek Flash，Pro对照已经结束，后续不再调用Pro。每个fixture保留独立持久账本，有限重试与未知用量预留仍由程序执行，不重置旧账本。通用目录导入、本地Embedding/Milvus组合检索和受限千表应用验收已实现：最终1204张合成表、2408个新对象、8组检查通过，首次索引100.91秒、查询中位约3570ms；不据此宣称任意业务召回准确率或低延迟。人工deleted目录同步12项、常用范围6组/22回环及浏览器9组也有完整当前结果，收尾独立核对已完成。真实Datasight、正式认证和真实用户试用仍须相应外部证据，保留原I3要求。

最新会话要求已写入AGENTS第12条：Agent能力优先复用Pi；同一对话长期持续、多轮多任务；Pi负责原生上下文整理/压缩，应用负责SDK会话持久恢复及权限/资产/语义变化时的有效性校验，不另写上下文压缩器。

**I0-01与I0-02均已完成；真实模型接入、预算和停止生成通过当前增量验收。** 沿用既定范围、命名规则和四条验收。只在无法自行核实或建议存在重大风险时请求用户决定；常规实现选择直接推进。真实模型和完整I0仍按各自范围验收。

开发防漂移机制已建立：系统设计第21节保留36项需求映射，frontmatter 的 `delivery.increment` 固定当前增量 I2-MVP 的目标、边界、逐行为验收和证据；本地检查器已用失败、超时、中断和证据过期等反例验证。I0-01已实现且关闭，四条命令均实际执行，独立审查与收据绑定当前代码、契约和测试。此项建立不改变已有MVP或授权范围。

**模块设计已落实到首条可运行链路。** 用户指出仅有进程架构、工程原则和开发顺序不足以约束代码；此前“已足够直接进入开发”的判断已收回。现有12个模块的职责、操作、数据、框架/流程、组合事务与依赖设计。本增量已有正式React、Rust API/Worker、MySQL迁移及真实Pi SDK工具循环；I0-01使用本地模拟provider；I0-02已完成官方DeepSeek小样，已通过独立审查和当前收据闭环。取数与语义模块的当前状态见本文件最新收尾记录。


### I0-01代码与约束

- 入口：`apps/web` 是正式工作台；`apps/api`、`apps/worker` 复用 `crates/data-agent`；`apps/agent` 仅接入Pi。`make infra-up` 后用 `make dev` 打开本机5173工作台，演示登录值只存在忽略的私有本地文件。
- 契约：`packages/contracts/schema.json` 唯一真源，OpenAPI引用它；quicktype 26.0.0生成Rust/TypeScript，Rust jsonschema与AJV在边界校验。可选标签分支序列化省略缺失字段，必填nullable字段保留null；精确整数以十进制字符串跨语言传输。
- 恢复：Pi会话记录保存header、entries和leaf。SDK不能直接续接以assistant工具调用结束的半轮，因此适配器只接回已登记的同一个SDK调用，经宿主幂等入口查证/完成，再交还Pi继续。宿主保留operation、origin_run、recovery_chain和budget_scope；新run只替换当前运行授权。模拟provider忽略SDK恢复时追加的system配置消息，按最后一条业务消息继续。
- 状态：同会话交付互斥只由标记持有者释放；会话忙退回等待且不消耗交付次数；实际交付最多四次，耗尽原子保存失败和可读事件。模型调用预算跨run保留，未结算尝试继续计入原预算。
- 存储：两份最小MySQL迁移，模块私有store，具名use_cases组合事务；检查SQL位置/表归属/兄弟模块导入，实际数据库测试验证锁内当前读取、快照事务归属、锁序与并发领取。静态检查是有界规则，不能替代Rust可见性或审查。
- 事件：SSE当前按event_seq返回持久事件批次并关闭；React用持久快照轮询。持续推送、完整对话上下文、后续任务更新和查询生命周期在下一增量落实。
- 修复来自验收和独立审查：恢复重复任务、标签回执多序列化null、被拒绝交付释放他人互斥标记、重试耗尽永久running、HTTP响应未校验，以及浏览器仅读取API提交结果的测试缺口。验收预期保持原值，新增反例保护这些边界。

### I0-02模型与取消实现

- `runtime/model_calls`管理试验额度、单次预留、一次性发送许可和结算；每条消息持久绑定profile，恢复沿用原额度。金额用整数微美元，按官方高峰输入未命中/输出价格计算；未知用量不退款，可靠用量幂等结算，超限熔断。
- Node使用Pi SDK原生OpenAI协议，关闭两层重试与重定向。可靠usage保存后才放行done；内部结算回执丢失重送固定payload，不重发模型请求。Pi保留唯一Agent循环。
- “停止生成”按用户、会话、run和代次保存终态并中止对应HTTP。已保存任务保留；它不是任务或平台查询取消。取消后原调用仍可结算，旧业务写不能提交。
- 密钥只在忽略的0600 `.env`与Node模型进程使用；默认启动不读取。SDK工作目录固定为合成目录，发送前限制短文本/一个工具/2048字节并按4096输入预留；actual usage核对的限制由用户明确接受。
- 官方小样已通过：2请求、1个受控工具任务、持久回答；总输入951、输出277 tokens，保守费用619微美元（US$0.000619），未知预留0。证据[官方小样](sources/evaluation/deepseek-trial.json)；再次验收只审计原记录与MySQL，不额外调用模型。
- 本地协议验证13项检查、13次回环请求；72组契约用例。独立初审发现并修复结算payload不稳定、宿主接受低报预留，以及取消/凭据断言缺口。最终独立审查通过并绑定89个输入文件；四项验收实际重跑通过，收据`.local/delivery/I0-02-result.json`与当前输入一致。

### 最新决定：实现前模块设计

- 2026-10-03 模块设计自审确认并修正10项缺口，详见[审计第9节](mvp-readiness-audit-20261002.md#9-2026-10-03-模块实现设计自审)：取消范围、恢复幂等、本地取消、输入终态、来源防回退、检索补取、首次创建、修改提案、事务边界承诺和锁接口。修正后仍须在各增量运行这些反例；材料检查结果单列于“最近验证”。
- 本轮交付为[实现设计](architecture/implementation-design.md)和[离线图册](architecture/implementation-atlas.html)，包含12个模块、公开操作的输入/输出/错误/副作用、数据归属、框架/流程共28张图。图册由同一份模块Markdown生成，当前状态仍只维护本文件。
- 一个Rust业务库承载M01–M10；API与Worker复用具名use_cases。模块私有store只写自己的记录，组合用例共享AppTx完成已知跨模块事务，网络在事务外。Pi和React分别为M11/M12，模块不对应独立微服务。
- 本轮补实会话/作业租约分离、M09拥有Skill选择与采用记录、查询向量化的原请求预算、自动预填/索引的有界maintenance预算及来源变化即时失效判断。维护配置未确定不自动调用模型；Pi仍是唯一Agent循环，预填可用受控单次结构化模型分析。
- 本轮自审补实：恢复跨run沿用稳定operation_id与SDK映射；输入消费与展示事件分开，撤回/取消有合法处置；来源头按采集起点CAS防回退；首次导入建首版与依赖；候选过滤后有界补取；语义修改建议由本人保存，维护者明确应用才改正式知识，私人材料不隐式进入公共定义。
- 工程边界区分Rust隐私、导入/SQL位置及表owner检查、数据库授权；AppTx不声称能隔离表权限。组合层按公开锁操作取得事务有效事实。跨语言采用OpenAPI 3.1/JSON Schema真源生成边界类型并运行时校验；用户主体与配置限定的维护服务主体分开，后台不能借服务身份冒用用户。
- 已完成设计交叉核对，并修正工具后再次调用模型的许可路径、来源变更早于模型补全时的待复核状态、问句向量输入以及单查询取消入口。代码边界、SDK恢复与平台能力尚待实际验证。
- 本轮只改设计、项目规则与图册构建/检查材料；未创建正式业务工程、启动数据库、读取密钥、调用模型、提交或发布。原环境检查计划保留为历史证据；本轮检查声明改为与设计交付相称的targeted范围。

### 最新决定：开发工程规则

- 2026-10-03 用户补充命名要求：实现名称表达业务概念或实际职责，不采用Agent临时步骤、阶段或任务编号；沿用模块契约术语，避免含混泛称和随意缩写，遵循语言习惯并保留有实际含义的版本及迁移序号。已写入AGENTS第11条及交付检查重点。本次只补规则和交接，不进行批量重命名或正式业务开发。
- 用户要求确立高内聚、低耦合等开发规则，已写入 [项目工程规则](../AGENTS.md#工程规则)，作为后续实现与代码检查依据。按业务能力组织模块，明确公共接口、依赖方向、状态修改入口和跨语言契约；Rust / Pi / Worker 沿用现有分工。
- 程序落实权限、确认、版本、幂等和预算；语义保留来源、模型建议与人工覆盖。按真实边界抽象、按改动风险验证、小步走通完整流程，首版继续统一交付，不提前全面拆微服务。
- 本次仅制定规则与更新当前记录，没有新增业务代码、数据库迁移或服务；规则已记录不等于相应能力已实现。

### 最新决定：开发防漂移

- 完整映射为 D01–D18（用户决定）、C01–C08（基础要求）、A01–A10（审计反例）。对应表只保存需求来源、模块、完成阶段和验收行为；动态进度仍只在本文件。拆增量不会删除后续要求。
- `delivery.increment` 是接手与子代理分工的当前任务契约；本轮将 I0-01 定为合成范围内的最小跨进程接入及恢复验证。它覆盖相关要求的部分行为，不代表完整 I0；真实 DeepSeek 工具调用仍保留为 I0 必需项。
- 记录校验用 `make verify-delivery`，关闭增量用 `make verify-increment`。后者必须具备实际验收命令、代码/测试等输入和独立审查记录；运行失败、超时或证据与当前输入不符时不得标完成。没有安装Hook、CI或文件写入沙箱。
- 审查记录绑定所审代码、测试、契约和已确认决定，完成收据另绑定审查文件；相应内容变化使旧证据失效，重跑测试不能代替重新审查。检查命令开始执行前先把旧收据置为running，中断后不能沿用上次通过结果。具体操作见[开发指南](development.md#5-每个增量怎样防止偏离要求)。
- 四条验收已落实为 `verify-contracts`、`verify-runtime-flow`、`verify-recovery`、`verify-architecture`。最终证据绑定当前代码、契约、测试与审查；检查器自身的通过与正式产品能力分别报告。

### 验收与要求变更

- 上一轮知识回归失败已定位：演示provider将按问题过滤后的空memory命中列表覆盖启动上下文中的有效偏好，导致跨会话默认渠道遗漏。已改为合并、按资产ID去重；不改变真实provider策略或检索过滤。旧Worker日志出现数据库错误但未有错误码，已补只记录数据库code的诊断；新日志与InnoDB死锁信息证实prefill_attempts扫描锁与新增队列插入冲突；已缩短claim事务、补领取/过期索引，并在reserve前校验profile/URL/payload。新增ETL单独改版、配置错误0HTTP、280条短历史以及完整当前回归已通过，已纳入I2-MVP最终绑定收据。

- 2026-10-04：官方Chat Completions只有输出硬上限，公开分词模板不完整覆盖服务端工具注入；输入4,096不能事前精确证明。用户选择A：本轮请求体不超过2,048 UTF-8字节、短文本及一个工具、按4,096输入保守预留，每次实际usage核对，超限熔断。6次请求/1,024输出/US$0.05总预算不变。真实用量验收以API返回usage为准，不把预估称为服务端硬限制。

- 2026-10-03：本轮新增的是既有要求的映射、I0-01范围和验收绑定机制；D01–D18、B/Q/P独立预期和审计A01–A10的要求未降低。当前已绑定真实命令，继续以原可观察行为验收。
- 后续删除用例、放宽断言、更改预期或证据类型，逐项在这里写明旧值、新值、原因、独立依据、影响及必要的用户决定；正常增加实现和测试绑定不重新讨论已确认需求。

### 当前准备：契约、验收与开发环境

- 18 项决定继续有效。用户另选 A：新消息归属未定时，短暂暂缓该对话的新 SQL 确认；判断后恢复不受影响的按钮，已确认/运行的查询继续。具体事务顺序、失败恢复与多页面竞争见设计第 19.5 节。
- 设计第 19.6–19.8 节补齐受控任务/澄清工具、流式输出提交与替换、跨运行预算。预算随主动用户消息建立，后台操作固定引用原范围，内部重试不补额，并受试验总上限约束。它们是实施契约，尚未由运行中的服务证明。
- 起步流程改为 S01–S05，保留行为 B01–B08；B04 修正未提供订单的前提，B05 增加保存、告知、后续复用、停用和失败变体。新增五字段 P01–P05 预填参考，41 处出处可核对；这些答案不进入知识允许列表。E15 相似目录和真实行为验收仍待实施。
- 新增 `make verify`，统一运行准备材料静态核对与离线样例检查。dev_co 已在本文件就地添加检查声明，沿用唯一当前记录；未安装任何 Hook，不把手动执行脚本称为自动会话 Hook 生效。
- 本机依赖：沿用 Node 26.8.1 / npm 11.19.0；新装 Rust 1.99.0、rustfmt 和 Clippy，未修改 shell 启动文件。`package-lock.json` 与 `Cargo.lock` 固定依赖，npm 安装脚本采用项目级允许列表。MySQL CLI 在专用容器中可用，无需另装本机服务。
- **环境选择已确定为 A：**本机 Rust / Node 加项目专用 Colima 内的 MySQL / Milvus，4 CPU、6 GiB 内存、30 GiB 数据盘容量上限；按需启停，不切换全局 Docker context。只读共享项目 `infra/`、`.local/infra/`，不共享整个用户目录。安装和开发依赖检查已获授权，真实模型调用仍需单独确定配置与费用上限。
- 已锁定并安装 Pi SDK `@earendil-works/pi-coding-agent` 1.0.0、React 19.3.0、Vite 8.3.2、Playwright 1.63.0 / Chromium 153.0.8010.12。React 构建、Pi 导出及显式内存管理器已验证；未运行 Agent session、默认资源发现或模型循环，不依赖相邻 Pi 源码目录。
- MySQL 8.4.11、Milvus 3.0.2 及配套 etcd / MinIO 使用锁定 digest 的 ARM64 镜像。Docker CLI 29.3.1、VM Docker Engine 29.2.1、独立 Compose 5.3.1。默认 Docker context 保持 `default`，命令显式操作 `colima-data-agent`。`infra.py` 只创建和使用本项目新生成的开发密码，不读取既有 `.env` 或模型凭据。
- 安装、启停、端口和验证命令见 [开发指南](development.md)。`tools/check-rust` 是临时回环 HTTP / SQLx 依赖检查工具；不是正式 Rust 服务。后续仍需语义/任务最小 schema 与迁移、受控 Pi 工具接入和故障试验。真实模型调用前确定端点、模型配置和费用上限；公开前确定许可证和范围。本轮没有调用模型、提交、推送或发布。

### 最新方向：整体原型与品质标准

- 主导航确定为 **工作台 / 我的积累 / 语义管理**。工作台是默认入口；历史放在工作台侧栏“最近会话 / 查看全部会话”，用弹层承接会话与查询记录，不另设主导航。移动端保留历史按钮。
- 最新交互决定：去掉全局顶部“新建分析”，改成工作台会话区的“新对话”。首次进入可直接提问，点击工作台继续当前对话；换话题时再新开对话，追问与修订保留在原对话。会话区和移动历史入口仅在工作台显示；各业务模块保留自己的现有操作，不额外增加一列导航。
- 单项分析时收起任务数量和任务选择器，多项时再显示。空白新对话重复点击复用当前空白页，不产生额外空记录；未发送的草稿按对话保存，切换时分别恢复，有内容的未发送对话也可在历史中找到。旧浏览器中唯一的输入草稿归到当时的活动对话。
- 我的积累含“记忆与纠错 / 我的 Skill”；语义维护保留已有表、字段、血缘、指标 SQL、文档、变更记录能力。
- 用户要求以 Awwwards、Webby Awards、FWA 获奖作品为品质目标。以真实截图和交互逐轮检查布局、文字层级、信息密度、状态反馈、移动适配和键盘操作；奖项结果不属于本地测试可以证明的结论。
- 已完成三轮截图迭代：第一轮发现新会话空右栏和输入位置分散；第二轮改为单列起问、结果优先、SQL 折叠；第三轮突出记忆管理、统一文字尺度、对齐 Skill 操作、增加任务状态入口和结果解释。移动端在工作台内切换“对话 / 当前任务”，查看 SQL 或结果直接进入任务视图。随后按最新会话决定调整导航，并验证首条未发送草稿也能留在历史中。
- 原型边界：原生 HTML/CSS/JavaScript；本地模拟查询、身份和存储，不执行真实 SQL、不调用模型。正式 React + Rust + Node.js/Pi 方向不变。

### 最新方向：全合成公开项目

用户决定将表、加工 SQL、数据、文档、原型与验收材料全部换成从零构造的虚构业务，准备后续分享到 GitHub。原业务资料不再作为项目知识或测试输入；此决定替代第 17 项的旧样例来源，其余决定继续有效。

- 演示场景：虚构订单、支付退款事件、客户及客户标签。主表 `demo_order_detail`，一行对应一个订单行。
- 演示查询：SQLite 离线执行；金额按整数分保存，时间使用 UTC，口径由合成文档明确。MySQL 仍是应用记录的存储方向，二者用途不同。
- 旧资料、历史审计原文、截图和迁移材料已保存至仓库外的私密归档。公开树保留通用设计和公开资料链接；不将清理后的结论冒称为一次新的外部审计。
- 原型使用新的浏览器存储命名空间，避免旧样例值回灌。旧浏览器存储不自动迁移。
- 密钥不进入项目、文档或长期记忆。`.env.example` 仅定义空配置；当前原型不读取它。本轮没有保存用户提供的密钥，也没有调用模型。
- 未进行 Git 提交、推送或发布。用户仓库和远程配置保持原状；本地 Git 工具的历史快照仍可能含旧资料，不能将整个 Git 目录或全部内部 refs 当作公开包。之后正常首个提交应只选取核对后的工作文件。

## 当前认知

| 方面 | 已定内容 |
| --- | --- |
| 用户与目标 | 产品、算法、数据分析、数据开发；优先取数、分析和解释口径，也支持复杂 SQL、查表和字段含义 |
| 数据规模 | 面向千表级目录；小样用于先验证流程，不将少量样例效果等同于全目录效果 |
| 语义维护 | 主要由数据开发维护；从元数据、血缘、调度节点和加工 SQL 预填，模型补充分析；来源事实、模型建议、人工修改分别保留，人工值受保护 |
| 语义内容 | 表和字段含义、粒度、时间、过滤、关联、指标及计算 SQL、同义词、长业务文档、章节与多对象关联；缺依据时明确缺口 |
| Agent | Pi 是唯一模型与工具循环，负责调查、澄清、规划、生成和解释；Rust 负责业务、身份、工具、存储、任务，不另造规划器 |
| SQL 交互 | 展示 SQL、参数、目标和条件；用户确认具体版本后由宿主执行。执行前用户随时补充或纠正，Agent 可主动澄清；改动生成新版本并重新确认 |
| 任务与恢复 | 一会话可含多个分析任务；查询独立运行，Pi 会话更新串行；关闭页面不取消后台任务，结果回到原任务，重启和未知回执按持久状态处理 |
| 个人积累 | 用户隔离的历史、记忆和 Skill；明确且有复用价值的纠错自动保存并告知，保留适用范围与依据，不能自动变成公共口径 |
| 技术方向 | React 前端；Rust 主应用与 Worker；Node.js/Pi；MySQL；Zilliz/Milvus；DeepSeek。统一交付；个人记忆采用Mem0和百炼1024维向量，公共知识采用本地E5/384维，版本已锁定 |
| 平台与模型 | 数据平台使用可执行合成mock；真实DeepSeek Flash、Mem0及向量接入已有试用证据，模拟与真实调用分别报告；真实Datasight和正式认证未接入 |

## 已确认的 18 项决定

全部选择 A；最新样例来源调整已直接合并到第 17 项。

| 编号 | 决定与边界 |
| --- | --- |
| 1 | 授权维护者保存公共语义后立即生效，保留版本；保存本身不等于业务验证通过 |
| 2 | 保存平台结果引用，回看时核对权限和有效性；过期后重新确认查询，不默认持久化完整结果快照 |
| 3 | 对话、SQL 草稿和任务记录保留到用户删除；不据此推导结果、记忆或 Skill 永久可用 |
| 4 | 全目录基础导入和预填；常用表先模型深入分析，其余按需补齐，无依据内容保留缺口 |
| 5 | 来源变更自动重分析，更新未人工修改的建议；保留人工值并提示复核，保留新建议与依据 |
| 6 | 文档支持粘贴/编辑正文与来源链接、章节、关联、版本；自动同步和复杂附件解析后置，仅有链接时不假装已读正文 |
| 7 | Rust 主应用、Node.js/Pi、Worker 按职责分进程，统一配置、交付和升级，首版不全面微服务化 |
| 8 | 页面关闭后后台在预算内继续；遇澄清或 SQL 确认等待；不默认外部通知 |
| 9 | 查询进行时同一会话可继续提问；Pi 会话修改串行，异步结果关联原任务，不覆盖新条件 |
| 10 | 有价值的明确纠错自动成为个人记忆并告知，可修改、停用、删除；未核实内容仅为查证线索，本次要求保留在本次 |
| 11 | 先用 MySQL 与现有检索实现基础记忆，Mem0 小样合适后再接；不等待它才能用，也不自研完整记忆框架 |
| 12 | Skill 由用户指定，或 Agent 推荐后用户选用；使用当前启用且适用的版本，不绕过任务条件和 SQL 确认 |
| 13 | 聊天工作台是主入口，承接含义、SQL、取数和分析；语义维护独立，个人资产有管理入口 |
| 14 | 表格、基础图表、CSV 导出；说明范围、截断和完整性，不等同于完整 BI 或大批量导出平台 |
| 15 | SQL 支持的趋势、分组、占比、排名等常见分析；可多次查询，每个新查询仍需确认，Python 分析后置 |
| 16 | 先用少量代表问题走通提问、澄清、修改 SQL、确认执行、分析、纠错；实施分阶段不缩减已定 MVP |
| 17 | 以从零构造的合成资料形成独立参考答案，覆盖相似表、跨表和易错口径后扩大验证；参考答案不默认喂给检索系统 |
| 18 | 少量数据开发和分析用户先试用，尽早纳入产品与算法反馈；当前不启动邀请或发布 |

## 实施约定入口

- [需求与增量验收对应](semantic-retrieval-design.md#21-需求与增量验收对应)：36项要求的固定出处、模块、阶段和验收行为；当前I0-01任务与命令绑定在本文件frontmatter的 `delivery.increment`。[增量检查用法](development.md#5-每个增量怎样防止偏离要求)区分材料校验和实际完成验收。
- [实现设计与模块接口](architecture/implementation-design.md)、[图册](architecture/implementation-atlas.html)：代码模块、28张图、公开操作、数据归属、依赖和组合事务；正式编码前对照对应模块。
- [工程规则](../AGENTS.md#工程规则)：模块内聚、跨模块接口、依赖方向、职责与状态归属、验证和交付要求。
- [系统设计](semantic-retrieval-design.md)：第 17–20 节为实施基线、存储关系、接口和首批验收；前文保留各模块详细设计。
- [最新开发前审计](mvp-readiness-audit-20261002.md#9-2026-10-03-模块实现设计自审)：第9节记录模块设计自审、10项修正及实现验收；第8节保留准备阶段历史，不自动重新激活已解决待办。
- [样例与离线验收](sources/README.md)：DDL、加工、业务规则、合成数据和独立参考结果。
- [标准架构图](architecture/data-agent-c4-container.svg)：进程、数据存储、外部模型与平台适配；架构方向不等于接入已验证。
- [整体 Web 原型](../prototype/index.html)：工作台、个人积累与语义管理的本机浏览器演示。

实现时继续保留：SQL 草稿/条件/执行目标版本绑定、确认与执行分离、租约与晚到事件处理、幂等与回执未知查证、取消真实状态、事务中登记任务、用户资产隔离、权限变化后的回源核对。

SQL 执行目标单独记录方言、版本、允许语句与能力；只接受能完整解析且符合能力的单条只读查询。CTE 不能仅按前缀放行，未知语法不能显示检查通过。加工 SQL 的方言不自动决定交互查询方言。用户读取权限与模型端点可以接收的资料范围分别核对。

## 真实进度与验证

- 已有：整体 Web 原型、系统设计、架构图、HTML 讲解和全合成可执行样例。工作台演示澄清、SQL 版本、用户确认、多任务、结果/图表/CSV、来源跳转与返回、纠错保存/查看/撤销；个人 Skill 演示创建、版本、显式选用和停用；两个模拟身份分别保存资产与记录。
- 原型代码入口：`shell.js` 负责全局导航、历史弹层和 Skill；`workbench.js` 负责对话、任务和确定性样例计算；`workbench-fixture.js` 是合成加工结果；`personal.js` 管理个人记忆；`app.js` 与 `knowledge.js` 保留语义及文档维护。样例问题有明确支持范围，无法解析时提示范围；不把预置解析器当作真实 Agent。
- 正式实现：React提交消息；Rust保存会话、请求、预算和作业；Worker交付给Node/Pi；真实SDK经受控工具建立分析任务并保存回执、输出和检查点；两个本地开发身份服务端隔离，刷新可回看。API与Worker复用同一个Rust业务crate。
- 正式业务已实现：词法与向量组合检索、SQL生成工具/版本确认/异步执行、语义与长文维护、个人纠错、显式Skill选择、长期会话和历史回看。真实Flash已有完整16场景质量基线与独立判分；最终本地工程验收完成，正式认证/真实平台属于I3。
- 合成离线验收：Python 3.14.7 / SQLite 3.53.4，13 条参考查询与 11 项结构、边界、错误关联反例检查全部通过。[运行记录](sources/evaluation/verification.json)。原型内嵌 DDL/加工 SQL 与源文件逐字符一致，三个指标 SQL 在同一数据上分别得到 12400 分、5 位客户、0.5。
- 此前维护原型基线：13 字段展开、人工修改及确认、保存刷新、重预填保护、3 个加工上游、3 指标、4 文档版本和引用、两个模拟用户的记忆编辑/停用/删除等 49 项浏览器检查通过。[维护基线检查](../prototype/.checks/retail-browser-checks.json)。本轮整系统检查另行记录，旧报告不能代替新代码的验证。
- 最近整体原型验证：独立 Chromium 中 **14 个场景、151 项断言全部通过，0 页面脚本异常**；13 个产品输入文件在测试前后哈希一致，交付前再次核对与当前源文件相符。[可重跑脚本](../prototype/.checks/verify-system.cjs)、[最新报告](../prototype/.checks/system-browser-checks.json)。覆盖导航、历史弹层、澄清、修订后禁止旧版确认、多任务结果归属、CSV、来源跳转及未保存语义保留、纠错、Skill 版本和停用、模拟用户隔离、刷新与取消；新增跨模块入口隐藏、当前任务和 SQL 查看版本保留、会话草稿分别恢复、旧草稿迁移及空白新对话复用检查。
- 视觉及基础键盘检查：1440px 桌面、390px 手机下工作台、个人资产及六个语义标签页无文档水平溢出；手机结果首屏直接显示。Tab 焦点、新建图标名称、历史与 Skill 弹层 Esc 关闭和焦点返回通过；不等于完整可访问性审计。[首页](../prototype/.checks/system-flow-desktop-home.png)、[SQL 修订](../prototype/.checks/system-flow-sql-revision.png)、[结果](../prototype/.checks/system-flow-result.png)、[手机结果](../prototype/.checks/system-flow-mobile-focused-result.png)、[记忆](../prototype/.checks/conversation-assets-desktop.png)。第三轮检查发现的新会话空状态 `scrollTop` 错误已修复，并完成整轮复测。
- 讲解与架构：6 份 HTML 的脚本语法、可见按钮/下拉选择交互通过，无页面脚本异常；标准架构图重新生成，10 个节点、16 条关系，自动文字越界/重叠检查无问题。[HTML 检查](reviews/publication-20261003/html-browser-checks.json)、[架构检查](architecture/diagram-checks.json)。HTML 检查未覆盖宿主 widget API 与主题集成。
- 文档与公开材料：本地链接核对通过，已知旧业务标记、内部引用、个人绝对路径、密钥样式和旧截图核对无残留。检查范围是当前工作文件，不能据此宣称整个 Git 对象库或所有可能的敏感内容已清除；旧材料私密归档与本地工具快照不属于公开内容。
- 最近公开材料补检：扫描 60 份当时文本文件，未命中已知旧样例标识、个人绝对路径或密钥样式；工作台所有展示和测试仍使用合成资料。该历史轮次没有保存或使用用户密钥，没有提交、推送或发布。
- 本轮开发前审计验证（2026-10-03）：重新运行 `python3 docs/sources/verify.py`，24/24 通过；核对既有浏览器报告声明的 13 份产品文件及离线报告的 21 份输入，SHA-256 全部与当前一致。本轮未重跑整套浏览器测试；浏览器指纹未覆盖测试脚本及依赖版本，不构成完整可复现证明。dev_co `brief` 退出码 2 的配置状态与业务测试结果分开记录。

## 早期验证记录（历史版本）

- 2026-10-04 MVP完成度复审：三路只读审计与主审复核发现R01–R07，详见[报告](reviews/mvp-completion-audit-20261004.md)。审计开始时旧收据与源码一致；新增纯算法探针复现1250事件仅显示1200、缺少201–250且不能继续加载，记忆工具契约确认没有旧资产ID/版本或修订/停用动作。未重跑数据库/浏览器/付费测试，未修改业务源码和运行配置。原“本地MVP已完成、只差模型验收”判断更正为工程闭环已打通、产品MVP待修复和业务验收；I2重开，旧证据保留历史。

- 2026-10-04 I2交付收尾：`make verify-delivery`确认完成收据与当前输入一致，15项检查器测试通过；dev_co五项声明检查全部退出0、无超时，证据`.project-workflow/evidence/20261004T041606Z-1f23aab5/`。默认正式工作台已启动于`http://127.0.0.1:5173/`，使用本地模拟模型/合成平台；登录值在忽略的`.local/development/identities.json`。浏览器工具因管理员安全策略核验不可用拒绝自动打开，未改安全设置或绕过；用户可手动访问。完整真实模型新额度仍待答复，本轮官方新增请求0。

- 2026-10-04 I2-MVP完成：`make verify-increment`实际执行五项绑定验收，全部退出0、无超时，收据`.local/delivery/I2-MVP-result.json`。独立[审查](reviews/mvp-increment.json)通过，绑定211个输入文件。覆盖80项契约、查询/知识与边界回归、8场景正式React浏览器流程、Pi恢复/原生压缩、共用预算回环、代码及合成材料；官方新增请求0，P01–P05回环质量为protocol_only。真实模型完整质量与真实平台/I3缺口继续保留。

- 2026-10-04 dev_co收尾：五项辅助检查全部退出0、无超时，覆盖当前收据、代码质量、启动、公开材料和防漂移记录；证据`.project-workflow/evidence/20261004T000813Z-32f24665/`。验证不增加官方请求；模板`.env.example`因helper凭据路径规则未列为其输入，仍被增量收据指纹覆盖。当前increment=complete只表示I0-02完成，后续I1/MVP继续按既定计划验收。

- 2026-10-04 I0-02完成：`make verify-increment`实际执行四项绑定验收，均退出0、无超时；收据`.local/delivery/I0-02-result.json`。独立[审查](reviews/model-increment.json)通过，绑定89个文件，审查者亲自执行72项契约、架构7反例及官方原状态审计，并只读核对MySQL用量/任务/工具回执/回答；本地协议、原mock链路/恢复/锁和代码检查报告由实现者执行、由审查者核对。官方总请求仍为2，费用上界US$0.000619。闭环证明本增量，不证明完整取数分析MVP。

- 2026-10-04 I0-02关闭前检查：官方Flash真实2请求、1任务和持久回答、输入951/输出277 tokens，按高峰全输入未命中估算费用上界US$0.000619，未知预留0；`verify-model-trial`原MySQL审计通过且无额外调用。72组契约、本地协议13项（含取消146ms/连接关闭128ms、真实Pi错误事件/检查点与结算丢回执）、原mock链路/三退出恢复/7架构反例和真实MySQL锁检查、fmt/Clippy/TypeScript/Web构建通过。正式启动器已验证mock与DeepSeek两种模式，后者只读原结果，不新增调用。曾遇到旧监听关闭后的TIME_WAIT端口复用失败，探测socket现使用SO_REUSEADDR并复测通过；不关闭外部服务。该检查时最终独立审查及增量收据尚待闭环；后续完成记录见上，不将这些记录标为整个MVP完成。

- 2026-10-03 I0-01收尾：dev_co五项声明检查全部退出0、无超时，verify与gate均ready=true；证据`.project-workflow/evidence/20261003T151822Z-2bdc7155/`。此轮检查核对当前完成收据、代码质量、启动、材料与防漂移记录，不重复业务验收。CURRENT已记录increment=complete，收据与当前契约/输入一致。

- 2026-10-03 I0-01完成：`make verify-increment`实际执行四条验收，全部退出0、无超时；耗时约3.1/30.3/15.5/2.2秒。收据`.local/delivery/I0-01-result.json`，覆盖39组跨语言契约用例、React真实提交/创建/刷新、服务端用户隔离与trace、同会话HTTP交付互斥、双Worker等待、连续失败终态、三个真实退出点与稳定操作恢复、7个架构反例及4个真实MySQL锁行为。独立审查[记录](reviews/runtime-increment.json)通过，指纹核对当前78个输入文件；审查者独立运行契约/HTTP并发/架构测试，数据库报告由父代理执行并由其核对，未将此表述为审查者亲自重跑数据库。
- 同轮Rust fmt/Clippy、TypeScript检查、正式React构建和本地启动器通过；材料195项/防漂移检查器15测试通过。桌面1440px与手机390px截图已查看，0页面脚本异常、无文档水平溢出。此轮使用真实Pi SDK 1.0.0、本地local_mock provider和MySQL；未调用DeepSeek或真实平台。先前启动失败留下的空测试数据库已核对并清理，后续测试清理自己的临时库。

- 2026-10-03 命名规则与暂停交接：独立只读核对确认与现有模块术语一致，明确保留文档追踪编号、Rust构造函数惯例、真实协议版本和迁移序号。更新后dev_co四项本地检查全部退出0、无超时；证据`.project-workflow/evidence/20261003T135935Z-ae11ec10/`。业务增量仍为planned，顶层paused表示用户要求等待切换模型；本轮没有开始正式业务开发。
- 2026-10-03 本轮dev_co四项targeted检查全部退出0、无超时，执行期间输入未变化；证据`.project-workflow/evidence/20261003T135622Z-e11b81fe/`。覆盖准备材料、图册重新渲染、模块设计一致性及防漂移记录/检查器测试。顶层ready仅表示本轮机制与材料验证通过，`delivery.increment.status`仍为planned，I0与正式业务未完成。
- 2026-10-03 开发防漂移：`make verify-delivery`通过，检查器15个临时项目测试全部通过；独立审查者核对代码并另跑“已确认决定变化”和“测试变化后复用旧审查”两个反例，2/2通过。实际执行`make verify-increment`按预期拒绝当前I0-01，提示`I0-01-AC01 缺可执行 command，业务未验证`，make退出2；这是拒绝提前关闭的证据，未执行任何业务验收命令。本轮未启动数据库、调用模型或提交Git。
- 2026-10-03 模块设计自审修订：dev_co三项targeted检查全部退出0、无超时；证据 `.project-workflow/evidence/20261003T130230Z-10ad5370/`。准备材料175项（41处出处、54文档链接）；模块覆盖12、图28、设计本地链接17、声明依赖边15且无环。图册重新渲染、全部模块操作表和导航/缩放/视图切换通过，页面异常0、390px无文档级水平溢出，SVG文字边界通过；另查看桌面截图。此记录证明材料与图册一致，不证明A01–A10的运行反例已通过；正式服务/数据库/模型均未运行。
- 2026-10-03 模块实现设计：补齐12个模块的内部结构/流程和3个整体视图、1个跨模块时序，共28张图。图册本地渲染、12模块操作表、导航/缩放/框架与流程切换通过；0页面异常，390px页面无文档水平溢出；SVG文字边界核对通过。另人工查看总体框架、代码依赖、查询模块与手机截图，并调整了总体框架的长标签和布局。文档覆盖/本地链接/来源指纹/声明依赖图无环检查通过；准备材料169项通过。dev_co本轮targeted检查只覆盖设计材料及图册，未重新运行数据库/模型/业务集成，不证明代码已具备这些模块边界。
- 2026-10-03 工程规则阶段：`make verify-materials` 164 项通过，含 41 处出处和 44 个文档链接；另核对 `AGENTS.md` 的 10 条规则、1 个本地链接及两个修改文件的冲突标记/行尾空白，均通过。与设计第 17–20 节完成职责、状态、预算和权限边界核对。本次只改 `AGENTS.md` 与本记录，未启动数据库或重跑集成、浏览器及全量 dev_co gate；以下为先前环境准备的验证证据。
- 2026-10-03 环境准备阶段的 dev_co `verify` 完整通过：6 类检查全部退出 0，无超时，覆盖 60 份声明输入。证据在忽略目录 `.project-workflow/evidence/20261003T043111Z-5943710e/`，绑定当时的材料、配置、锁文件、检查脚本与原型产品文件；后续工程规则变更不据此宣称重新通过全量 gate。
- 准备材料静态检查 160 项通过，含 41 处预填原文引用与 42 个文档链接；合成 SQL/边界检查 24/24 通过。原型 14 场景、151 项断言通过，0 页面异常，产品文件前后哈希一致。
- React SSR/Vite 构建、Pi SDK 导出/内存管理器通过；Rust fmt/Clippy、Axum/Tokio/reqwest 回环 HTTP、SQLx 到真实 MySQL 的参数绑定/临时表写读通过。`npm ci --no-audit --no-fund` 按锁重新安装成功，项目安装脚本允许列表已核对；公开安装命令另显式加 `--engine-strict`。
- 专用栈 MySQL 临时库与 Milvus 匿名拒绝、向量写入/读取/最近邻搜索通过，测试对象清理确认。一次 `down/up` 后，5 个命名卷的身份/创建时间和 8 个本地秘密文件元数据不变，4 个服务恢复健康；之后统一检查再次通过。这不证明应用级故障恢复、Embedding 或语义检索效果。
- 核对完成后已执行 `make vm-stop`：专用容器和 VM 停止，释放内存，卷与本地开发配置保留。需要服务时运行 `make infra-up`；`verify-infra` 要在启动后运行。默认 Docker context 保持 `default`。
- 本次使用新生成的项目开发密码，没有读取既有 `.env` 或模型凭据，没有模型调用、Git 提交、推送或发布。未启用自动会话 Hook；dev_co 的通过是本轮实际执行所声明检查的结果。

## 历史收尾与审计记录（已被页首状态取代）

以下保留早期完成判断、失败、待办和当时授权，不作为新的执行计划；当前收尾结论以页首goal_revision=18及其收据为准。

I2本地合成MVP已经完成，Pi是唯一Agent循环。最终十项验收通过，收据与当前输入及独立审查一致。Flash质量基线12/16（75%）保留四个已知错误，未对最后的检查点工程修复重测。[准确率与记忆选型研究](research/memory-and-accuracy-20261005.md)、[执行包](research/mem0-comparison/README.md)及[真实检索对比](research/mem0-comparison-results.md)已完成，独立复核通过并保留范围限制。当前暂缓Mem0产品接入，后续候选为个人记忆向量召回与独立的自动纠错整理小样，均不在本轮实施。真实平台、正式认证和用户试用继续属于I3。

本轮修复已落地：已应用输入只能修订；条件由宿主按set/unset合并；新增采用项同步到run和原链检查点，停用后拒绝发送/恢复；结果输入绑定原任务，取消跳过失败输入并关闭澄清；同会话保存不清新草稿；补正文保留来源链接；来源同步用空间锁保护并发首导；查询轮询与Pi交付独立。这些先前修复已经当时的绑定回归和独立审查核对；本次复审发现的其余缺口另见复审报告。

### 验收与要求变更

- FIFO调度已阻止前条未完成时领取后条；旧测试要求忙会话第二job的lease_epoch>=2，改为queued且attempts=0，并保留双Worker串行与最终两轮完成断言。依据：排队任务无需重复领取/消耗重试，业务串行要求保持；修改后的runtime flow已通过，完整最终回归仍在执行。
- 语义预填当前由合成平台候选适配器提供，版本更新/人工保护已经实现；已补单次结构化模型预填路径及当前来源事实刷新，模型质量的真实验收仍待新预算。词法索引命中回源，积压时补查当前正文；不能称为向量检索、千表性能或自动分析准确性完成。

### 模型与交付边界（以最新用户授权为准）

2026-10-04用户明确授权使用合成mock资料及DeepSeek，不考虑本轮费用；此前待回答的费用题已被这条决定取代。本轮调用及实际用量记录在`.local/model-workflow/`，不重置已用试验账本、不绕过请求及重试上限。历史的小样上限只对应原试验，不限制新授权的开发验收。没有Git提交、推送、发布或部署授权。

### 长文与长期会话的实际接口

- `read_knowledge`支持entry_id/offset/limit，`read_source`按固定来源版本分段；片段注明offset、total_chars、complete、next_offset。个人资产body与scope可分别读取。模型预览与管理页完整Asset分别建契约。
- 启动可见上下文限制为16KB；只给有界任务与候选，缺条件按read_analysis_task回读。个人资产仍以完整版本和依赖授权，压缩/恢复检查点以宿主持久manifest为准。
- `read_conversation`按总量返回有界用户历史页，带宿主task_id；长消息可按message_id/offset回读。独立SDK原生压缩测试与>24任务定位测试分别验证，不宣称后者已经真实触发长会话压缩。
- 完整官方工作流脚本已准备：`tests/mvp/run-deepseek-workflow.mjs`；`--check`为回环协议验证，不读模型凭据、不付费；`--run`只有新预算获准后可执行，持久保留自己的trial/database并拒绝重做；`--audit`只核对原账本。

- 2026-10-04运行环境恢复：一次MySQL测试清理遇到docker exec退出137，专用MySQL随后自动重启；不据此称代码检查通过，也没有充分证据断言唯一根因。发现容器限640MB而默认临时表预算1GB、表缓存2000/4000，已将本项目临时表预算限制为64MB、两个表缓存限制400，Compose与当前专用MySQL一致；范围增加compose.yaml用于启动恢复，不扩大业务或服务。最终串行回归须重新确认稳定。

- 收尾审查修复：启动候选外的个人记忆/已选Skill可通过search_knowledge按问题或query=*及asset_after遍历；上下文声明asset_counts。read_analysis_task请求枚举已补，26任务和有界历史/长消息连续读取通过。
- D05实现补齐：M03从当前原文刷新DDL/字段类型/加工事实，禁止将旧摘录简单换版本标签；单次结构化模型分析校验引用，来源/人工版本CAS保护，M03持久尝试与M08原维护trial账本，重传去重、过期unknown不重发。无profile明确budget_unavailable；当前9项回环及失效/最终回归通过，真实模型质量仍待新预算，不冒称已通过。

- 长会话协议反例通过：24轮各约1000中文字的旧SDK历史，加近16KB宿主上下文，连续6轮保持同一SDK会话；加上280条短历史后共16次回环请求含2次Pi原生压缩，最大请求63,214字节，全部计原预算，0官方请求。消息条数不另设256的无依据限制，64KB正文门槛保留；整轮已通过。

- 正式语义页增加刷新代次、知识版本与同一预填尝试终态保护，避免保存后旧轮询响应晚到回退；浏览器反例已增加并纳入当前8场景通过证据。模型预填只接收原始来源和条目名称，不输入旧建议、人工测试值或独立验收答案。完整模型验收脚本已扩展P01–P05初次分析/人工编辑/再次分析，10个维护调用与查询流程共用同一trial；预算仍待回复，0新增官方请求。

- 收尾新增预算并发修复：调用身份改为事务内先INSERT，重复1062按原参数回读；原间隙锁/trial锁死锁已由InnoDB证实，原预算竞争[200,409]断言重新通过。
- 完整回环脚本曾遗漏Pi摘要响应分支，已补无工具摘要及压缩后的演示输入识别；真实provider保持自主决策。SQL修订/1600分解释及P01–P05人工保护的23共用回环调用曾全部通过，但DROP测试库时Docker事件明确出现oom/die/start，整轮退出失败，不能作为通过。当前MySQL已按Compose重建（原卷保留），缓存400/400、临时表64MB已验证实际生效，内存余量由640MB调整为1GB；脚本现把清理失败计为失败，最终串行回归进行中。

- 当前代码验证（2026-10-04）：前半`.local/checks/mvp-final.log`中契约、查询与知识全部通过，但browser首帧草稿断言失败；已修首帧初始化，不放宽预期。后半`.local/checks/mvp-final-ui-runtime.log`正常退出0，正式browser8场景、完整regression、startup、材料200项和交付检查器15项通过。Pi24轮中文历史继续6轮、280条短历史共16回环调用/2原生压缩，最大63,214B；综合流程含P01–P05共23回环调用、0未知预留，退出0且自己的临时库清理成功。0新增官方请求；原付费小样与新完整质量待验收分开。


### 2026-10-04 本轮复审修复

- R01：聊天工具支持新增、同条修订和停用本人记忆，核对版本/类型/用户；只替换本轮主动修改的记忆授权版本，其他失效依据仍拒绝。下一输入重建Pi上下文，同输入中断不得复活旧SDK检查点。
- R02：正式启动器把聊天和预填接到同一个profile/endpoint/trial；只从.env读取三项DeepSeek配置，清除继承预填变量。正式启动回环已验证页面聊天、初次/再次预填、人工保护、4次调用共用账本、0未知预留。
- R03/R04：历史按全部已加载事件投影并after_seq增量补读；跨页最终回答替代同次片段。会话首问题标题/100条稳定分页/服务端搜索已实现；当前语义目录及展开对象周期直读，目录游标不被首页轮询重置。
- R05：正文创建/编辑/响应均支持100000字符；文档正文、source_url、related_ids同版保存，旧版本/幂等/非法URL/权限校验保留。60000字符实际创建再编辑与正式浏览器已通过。
- R06：每条用户消息固定UTC参考时刻与UTC/Asia/Shanghai业务时区；幂等、跨日恢复、环境时区改变和结果唤醒仍沿原值。原预算消息通过M08公开身份接口定位，合法result-客户端ID不再阻断终态。
- 检索：去掉全目录5000静默截断，公共目录100条分页；名称优先、索引/正文候选回源；达上限显式返回覆盖不足且不透露权限过滤数量。长JSON的MySQL HY001由主键扫描/先ID后正文修复。5100字段后的指标和首1000项过期候选反例已通过；不宣称千表准确率。
- 业务验收入口：独立SQL验收器通过13参考与4错误反例；新增S/B场景runner记录条件/SQL/工具/查询/记忆和失败。回环固定策略验证宿主链路，官方模式仍由Pi自主决策。真实文本/引用判断留独立审查，不按数字出现在回答中就算通过。
- 新发现B05明确保存失败后的未完成工具会阻断finish，已补持久拒绝回执且业务反例通过；疑似提交丢回执先按原operation回源，不能当作明确失败或重复副作用。
- 独立复核补出结果输入幂等键仍可能被合法客户端`result-<query_id>`占用。已在真实Pi/Rust/MySQL链路复现：另一会话的普通消息即使撤回，原查询也会漏掉结果唤醒（`.local/checks/mvp-result-key-counterexample.log`退出1）。内部结果键改用客户端契约不允许的`server:query-result:`前缀，原合法客户端ID仍接受；同一查询终态、单个结果事件、原预算与时钟反例均通过，94项契约保留原正反例并增加两项标识边界。

### 本轮验收预期说明

- 原五项验收分别绑定全部36要求已改为按实际行为对应；全36项仍保留，官方质量和I3范围明确command=null。记录检查通过不能关闭这些待验收项。
- Q04/Q10原参考SQL额外输出分子/分母，题目只问比率。因此验收器允许单列正确比率，保留原完整结果路径及零分母NULL反例；不要求复制参考别名。依据为独立题目和手工结果，不从模型输出反写答案。
- 记忆测试原用不存在的GET /assets/{id}收到404，已改从正式/assets列表读取，停用state=disabled断言保持。
- 浏览器长文保存原立即检查已存在的旧链接，异步保存尚未返回；改为等待新链接已显示后再核对同一个预期值。测试表ID按正式契约构造，不采用非法字符。
- 新runner首次遗漏Pi压缩后的多模态用户文本处理，只影响回环演示策略，已沿既有协议测试做法读取本轮宿主输入；真实provider保持自主判断。
- 完整回归中的旧runtime浏览器检查仍按“会话 1”定位，因正式历史已按首问题命名而超时。改为在“会话历史”内按已知首问题标题选择同一会话，保留实际发送、持久结果、刷新和身份断言；依据为R04及正式历史标题契约。该失败日志保留，不把前半通过当成整轮成功。
- 移动端原截图在页面刚切换时生成，包含尚未加载的语义目录与上一入口的过渡颜色；不将这种截图当作最终界面证据。现在等待真实Skill及人工维护过的表内容出现，再拍摄关闭过渡动画的稳定截图；移动布局和功能断言保留并加强。

### 上一轮本地修复证据（历史范围）

本地验收按实际退出码记录；源码变化后只重跑受影响的检查，原失败与通过记录分别保留：

- `.local/checks/mvp-repair-final.log`：代码、92项契约、查询/知识/浏览器及模型协议通过；旧runtime标题定位失败，整轮退出2，不能作为全套通过。
- `.local/checks/mvp-repair-final-remaining.log`：修正标题定位后，运行恢复/锁/工程回归、正式启动、业务验收及材料/交付检查正常退出0；包括3个真实进程退出恢复、7项架构反例、204项材料、24项离线核算、15项交付检查器测试。
- `.local/checks/mvp-result-namespace-final.log`：结果标识碰撞修复后，代码、94项跨语言契约、8项查询流程、6项查询边界、2项请求时钟/碰撞反例、独立SQL核算器及完整业务回环正常退出0；原综合查询/预填23调用、未知预留0。
- `.local/checks/mvp-repair-browser-startup-final.log`：最终稳定截图、8个正式浏览器场景、4项时间线、5个历史浏览器场景、默认启动与正式模型启动回环正常退出0。正式启动聊天/预填4调用均记入同一trial，未知预留0。
- `.local/checks/mvp-business-acceptance.json`：当前输入哈希下16个S/B/P场景通过；分析、记忆、预填共112次回环请求，未知预留0、官方请求0。覆盖S01–S05、B01–B08的对应行为及B05明确保存失败变体、P01–P05人工保护；独立验收器检查13个参考SQL和4个错误反例。真实模型的文本、引用和语义质量仍未评价。
- `.local/checks/mvp-migration-status.json`：日常开发库实际应用011/012，两份迁移校验和均与源码一致；012按原预算消息补空标题，保留已有标题。
- 针对性反例另见`mvp-memory-revisions.json`、`mvp-completion-gaps.json`、`mvp-request-clock.json`、`mvp-retrieval-coverage.json`、`mvp-model-startup.json`及`mvp-history-browser.json`。当时的独立审查记录`docs/reviews/mvp-repair-20261004.json`为passed，并绑定226个输入文件；本次审计在相同范围发现IA01–IA09，该记录不再作为当前通过凭据。

未读取官方密钥，新增官方请求0。原6次/US$0.05小样预算已到期，此前24次/US$0.30选择题未回答（历史）；2026-10-04最新用户授权已覆盖本轮调用。完整回环实际需要112次请求，后续建议一次性选择有界完整额度，再从已获准的同一账本验收；到达任一上限保留未完成题目，不重跑补额。data profile技术上限200，task小样仍限6次，现有试验配置/账本及费用未改。无Git提交、推送或发布。

已提出新的费用选择，尚待用户回答：A（推荐）最多160请求/US$1，运行完整业务与预填验收；B最多24请求/US$0.30，仅运行代表性核心流程；C暂不付费。三者均不授权补额或重置账本。A/B使用deepseek-flash、思考关闭、仅合成资料、统一持久账本、一小时期限，请求体至多64KB、输出至多2048tokens，输入按32768tokens保守预留并核对实际usage，未知用量保留预算；任一上限达到即停止。尚未启动新的官方业务试验。

下一步：先修复IA01–IA09并补对应反例，修复后的代码须重新独立审查。最新用户已授权本轮真实DeepSeek验收；AC08继续待实际产物与独立审查。全目录通用导入、Embedding/Milvus组合检索、千表质量/延迟/成本、真实平台/认证和获准试用继续保留原I3范围，不把固定31对象或词法反例当作完成证据。当前`evidence=null`，不得生成或复用整体MVP完成收据。此前免费模拟工作台通过`python3 scripts/development.py`启动；本次审计没有调整启动配置或数据库。

### 2026-10-04最新独立审计证据

- 审计依据为AGENTS、系统设计第17–21节及知识/运行模块契约；两路独立只读审查覆盖查询与Pi运行，主审复核实际调用链并重跑纯探针。[完整问题、要求映射及补测建议](reviews/mvp-independent-audit-20261004.md)。
- 审计前范围指纹为`94b3f181f65dc5cabefd3bfb65240778d95edf2619ed5e2a5d1687bc4509228a`，226个文件，与上一轮记录一致。不是旧记录指向另一份代码的问题。
- 主审实际执行：模块依赖/SQL位置/owner检查及7项反例退出0；`npm run contracts:check`退出0；当前JS运行时94组契约通过，人工文档清除后的null值被拒绝。未重新编译Rust，不能写成这轮重新通过跨语言运行。
- 真实deliver/dataTools/Pi SDK的内存探针复现：多工具第二次恢复漏接registered工具；相同溢出，正常输入2次生成+1次SDK摘要后提交，恢复输入1次生成+0次摘要后失败。RustTransport为内存替身，仍需修复后的数据库集成反例。
- 直接执行原Platform类的纯内存SQLite探针：明确SQL拒绝后lookup返回not_available；运行期整数溢出只返回failed，没有诊断。Worker无限重提路径、旧SQL确认、失效依据回流、删除后结算和Skill选择冲突按静态完整链记录，没有冒称实跑MySQL。
- 原始探针命令与输出：`.local/checks/mvp-independent-audit-20261004-probes.json`。本轮没有读取凭据、调用官方模型、运行浏览器/数据库回归、修改业务源码、提交或推送；只写审计材料与本记录。审查结论为changes_requested，不覆盖或删除旧报告。
- 审计收尾：`make verify-delivery`完整退出0，15项检查器测试通过；只证明36项要求及增量记录有效，不证明IA01–IA09已修复。新审查记录的226文件指纹再次核对一致，报告内本地链接均存在；当前仍为active / review pending / evidence null。

### 最新开发授权与本轮修复

- 用户已授权继续开发、使用合成mock数据及DeepSeek，不再以费用选择题阻止本轮验收。此授权用于本项目合成资料，不授权提交、发布或真实平台写入。原6次小样及此前未回答的预算选项保留为历史。
- 当前按IA01–IA09推进；SQL草稿用明确的replaces_query_id区分修订与独立新查询。Pi恢复沿原调用身份接回未完成工具，通过SDK会话级公开入口继续；不另造Agent循环或压缩器。

- 本轮检查点：新增迁移013与共享查询契约，97组契约、Rust Clippy与React构建退出0。`tests/mvp/check-workflow-reliability.mjs`新增8项反例通过，证明IA01/02/03/06/07/08/09对应行为；证据`.local/checks/mvp-workflow-reliability.json`。Pi恢复新增拒绝回执接回，尚需重新构建与运行组合恢复测试，完整回归和真实业务仍待验证。

- 独立复核追加反例已修复：SQL-only修订声明与归属原子保存，外部校验等待期间旧稿不可确认；执行前坏工具参数作为isError交Pi修正；平台失败后恢复取消保留诊断；Skill同操作跨会话并发用asset_operations唯一行串行校验。新增9项workflow与4项recovery实际集成通过，100组契约通过。完整首轮本地回归退出0，追加修改后的最终回归仍待运行。
- 真实DeepSeek代表样例：S01实际回答和来源工具通过，S02首个模型请求中断且没有业务工具/SQL，原账本保留unknown；原产物`.local/model-workflow/representative-result.json`。正在使用新的有界合成验收fixture补查S02/P01，原试验账本保留，不用失败记录冒称通过。

- 代表样例补查：S02生成整月`COUNT(DISTINCT customer_id)`，排除测试、核对成功付款并使用UTC半开区间，实际取数5，与独立参考一致；匿名NULL客户明确不计入已知客户数。P01首轮因`gaps`字符串违背数组契约被严格拒绝，未应用建议，证据保留在`.local/model-workflow/representative-retry-result.json`及`representative-prefill-rejection.json`。
- 预填接入修正：从`packages/contracts/schema.json`提供同源`PrefillResult`给模型，输入只列可填写的语义条目；明确字符串说明、缺口数组及非空原文引用，DDL/ETL/type继续为来源事实。局部Rust构建和`check-prefill.mjs`9项真实MySQL/API/Worker边界检查退出0。真实P01初次/再次分析2次请求退出0，原始产物`.local/model-workflow/prefill-representative-result.json`，unknown预留0；机器校验仅证明格式/原文引用/人工保护，语义结论由独立审查者继续核对。
- 完整真实验收使用尚未使用的`.local/model-workflow/acceptance-configuration.json`及其持久账本，限200次试验、24次单请求、4096输出tokens、64KB请求体，只发送合成资料。最新用户不要求按费用暂停，保留应用本身的账本、有限重试和unknown预留。当前执行S/B/P，结束后保留全部产物及失败，再串行运行最终本地回归。
- 启动验证增加独立端口与`.local`运行目录，默认工作台已占用端口时`--check`自动选择独立端口。模型启动检查使用专属偏移，最终须实跑`make verify-startup`；当前工作台继续运行。

- 完整官方验收首轮在S01退出1，13次请求均已结算、unknown预留0。回答没有对应任务记录，最终提交被`message_pending`拒绝；原始产物和Pi检查点保留在`acceptance-first-failure.json`及`acceptance-first-failure-checkpoint.json`。检查点证明：模型遗漏新建任务必需的`conditions`，随后误将来源ID当知识对象引用，工具多次拒绝。共享Schema原本只在Rust业务层要求conditions；现已把条件要求、新建身份的JSON null和版本数字字符串纳入边界契约，工具明确说明无须澄清时question=null/options=[]及对象/来源引用区别。仍由Pi自主调查，未放宽引用或确认要求。
- 独立复核发现预填空列表、仅来源事实、漏条目以及空说明无缺口会被误标成功；新增纯Rust反例先实际退出101，保留`mvp-prefill-result-counterexample.log`。修正后3个测试（含完整覆盖、来源事实保留和明确未知的合法路径）退出0，`mvp-prefill-result-fixed.log`。真实Worker增加空/仅类型/空说明拒绝场景，仍验证不应用建议和不增加知识版本。预填提示区分DDL/SQL已知规则与业务未覆盖范围，避免将已给出的来源字段或取值算法写成假缺口。
- 最新构建与代码检查、105组跨语言契约退出0，证据`mvp-model-interface-build.log`。后续验收使用`repair-acceptance-configuration.json`对应的新合成fixture；失败试验账本和原产物保留。费用不作为停工条件，应用有限调用及unknown处理继续有效。

- 第二轮官方S01机器断言4调用通过，S02在SQL独立核算处停止，整轮退出1、26调用、unknown预留0，归档`repair-acceptance-sql-shape-failure.json`。S02的`[5,1,1]`是已知支付客户数及匿名订单/行数；独立审查实际执行确认正确，原验收只接受`[5]`过窄。Q02验收现按各列业务含义绑定主指标及允许的匿名边界，逐列独立核算，不扫描某列出现5；增加5个客户/匿名粒度/测试/期间外数据变体。13参考SQL、3个正确边界形状和9个错误反例退出0；常量5、匿名合成客户、行/订单交换、错值及无解释额外列仍被拒绝。该测试修正保持原数值和用户未知边界要求，不把模型产物反写成答案。
- 独立语义审查同时指出第二轮S01把整单全退状态推广为所有订单行付款非零；原DDL/ETL允许同单未付款行也显示全退。该回答不能算语义通过。通用提示增加字段/规则粒度与推断边界指导，不提供该题固定答案，最终样本重新独立评价。
- 多工具回答存在把全部调查片段拼成正式回答的问题，真实Pi回环先退出1，保留`mvp-final-answer-counterexample.log`。改为最后助手文本后，原Rust全片段校验拒绝`chunk_gap`，保留`mvp-final-answer-commit-rejection.log`；已扩展兼容协议的可选`final_start_chunk_seq`，按Pi原生message_start绑定正式回答范围，Rust仍检查全部片段连续及范围文本，不用宽松后缀匹配。过程事件保留，正式文本覆盖同次暂存片段。
- 共用AnalysisUpdate同时补齐已有revise/clarify的patch及版本约束，拒绝空白和字符串null/undefined澄清；最新代码/构建与112组跨语言契约退出0，`mvp-final-answer-build.log`。完整最终回归及下一轮官方验收仍待运行，不将前述失败改写成成功。

### 本轮续接诊断与修复

- 完整真实验收S01/S02机器通过，S03初始请求24调用后无任务，finish被message_pending拒绝；保留`full-acceptance-s03-failure.json`及旧账本，43调用全部结算。增加失败时返回本轮最终Pi检查点给合成验收器，正式服务不输出检查点正文；实际Pi回环证明执行前参数拒绝和最终回答都能留存。
- 针对S03的下一次独立合成fixture初始SQL成功，但渠道修订失败：模型把condition_patch放进route，宿主返回routed=true却忽略补丁。原始证据`sql-diagnostic-s03-failure.json`、12调用。共享契约现拒绝route携带条件补丁或澄清问题，工具说明明确条件改变用revise；由Pi读取拒绝并自主修正，不让宿主猜测条件。新增跨语言和实际API反例，最终回归待运行。
- S03原断言要求渠道只能作为SQL参数，题目和SQL契约均允许固定字面量。改为核对当前持久条件channel=app；仍要求同任务、新条件版本、时间不变、旧稿拒绝以及实际结果1600分，不放宽取数范围。该修正待独立审查核对。
- 独立语义复核：最新S02 SQL/5个变体/实际结果5及匿名解释可按本题通过；S01仍把整单refunded状态推成每行付款非零，末尾限制不能抵消正文的错误断言，不能算语义通过。继续加强通用字段粒度及绝对断言的依据要求，不向模型提供独立验收答案。

- 独立复核同一原因还可用route+完整conditions触发，已一并拒绝，并修正本地回环合法route参数。新增实际API反例分别拒绝两种表示且不改渠道/版本；10项workflow退出0，116项跨语言契约及Clippy/TypeScript/React构建退出0。独立审查认可S03渠道字面量的预期修正；该题还明确核对旧期间为2026年1月UTC、新版期间/时区保持原值。
- 新完整官方验收S01机器3调用通过、S02因合法匿名存在标记被旧验收器拒绝，10调用全部结算，原产物`quality-acceptance-s02-failure.json`保留。Q02题目要求保留未知边界，匿名存在标记是合法额外列；核算器增加明确has/any/exists匿名标记的逐列核算，并增加删空匿名行变体、恒true和把行数误作布尔值的反例。13参考SQL、4合法形状、6数据变体、11错误反例退出0。原客户数5和匿名处理均保持，测试补充待独立核对。
- 正在新的有界合成fixture中验收S03及剩余S/B/P，未重置旧账本。共享工具说明补充按entry.source_facts引用来源，避免将表结构来源套给同对象的加工SQL条目；不修改知识事实或独立答案。

- 后续官方验收`remaining-acceptance-s04-failure.json`中S03真实12调用通过，S04金额SQL正确返回3600分/16000分/0.225，但旧Q05仅允许单列；现按分子/分母/主比率的明确列语义核算，可加合法辅助列，拒绝交换/错值/无意义列。13参考SQL及16错误反例通过；Q02增加仅测试/期间外匿名的数据变体，已由独立审查亲自认可。比率新增付款/全退/零分母变体；Q05四位小数按原独立参考的精度核对，金额/计数精确，空集SUM/COUNT的NULL/0差异只作用辅助列，主比率仍须NULL。
- 再次S04运行14调用中出现不必要澄清：模型将已明确按金额的比率，说成订单行求和与先按订单求和会产生不同结果，原产物`continuation-s04-failure.json`保留。通用提示增加“只有影响业务答案且资料不能解决的歧义才询问，等价聚合不制造歧义”，保留真正的主动澄清能力；未放宽本题形成SQL的要求。先独立验收P01–P05预填，再继续S/B剩余场景，避免因单题失败重复已通过题目。

- 最新质量复核：`prefill-quality-acceptance.json`为P01–P05真实10调用、全结算。61条引用逐字匹配当前来源，人工覆盖全部保留；独立审查仍指出P01相关费用分摊边界遗漏/P04上游约束混为主表CHECK/P05取消后付款边界遗漏和假缺口。已加强通用输入分析指导，保持独立答案不进入上下文，待重新真实验证。
- `semantic-quality-s04-failure.json`保存18次全结算调用。S02获独立语义认可；S01无依据频率和零价推断拒绝通过。S04首轮已正确询问分母，但无任务写入而finish拒绝message_pending。现在只对此明确未提交拒绝用Pi原生sendCustomMessage反馈一次，由模型沿原run/预算自主修正；其他错误及第二次拒绝仍失败。正在用真实Pi/MySQL验证持久澄清、正式文本替换和有界失败。

- 官方`corrected-quality-b05-failure.json`保留55次全结算调用。S04原退款率歧义、按订单/金额计算及零分母SQL机器通过，S05标签去重及B04支付时间解释也通过，待独立文字/引用复核。B05默认web已写进持久条件，SQL使用合法channel='web'字面量，旧runner只检查parameters.channel而误拒绝。现改为检查持久条件并独立SQLite核算所要求渠道的净收入，加入web/app/store、测试和期间外5种数据变体；补记忆改app后另一会话实际复用。保持明确本次全部渠道优先、同条记忆修订/停用及保存失败不宣称成功要求。
- 新渠道核算反例初版要求order_status='paid'导致净收入错误，但全退款订单贡献0，该额外筛选在此模型中对净收入总和等价，不能据此判错；原失败`mvp-net-scope-evaluator.log`保留。替换为会排除真实正净额行的paid_amount_cents>1000反例，其他不带渠道/错误渠道/常量结果仍拒绝；未改变原业务预期。
- 预填装配补已存在的related_ids及DDL/ETL/type的source_facts，使同名字段的表归属和真实类型可被模型直接定位；不传effective_value、旧suggestion或human_override。正在真实Worker反例验证，质量需新官方产物。

- B04已读回真实数据库Pi检查点，归档`b04-truncation-checkpoint.json`：stopReason/rawStopReason均为stop、输出353tokens，但正文在“2. 下”结束。此次是模型提前结束的不完整回答，不能说成命中长度上限，机器检查不能代表语义通过；原产物保留，提示补完整结尾和精确日期边界。另发现交付只拒绝error/aborted，确实没有拒绝SDK明确length；新增一次Pi原生反馈处理length，保留原任务/预算/正式文本替换，待真实协议回归。不是用length处理冒充修复本次stop质量失败。

- 最新正式回答选择改为Pi原生message_end事件，避免SDK在length后移除上下文消息使交付误取前条toolUse文字。原反例`mvp-output-completeness.log`退出1/chunk_gap保留；修正后`mvp-output-completeness-fixed.log`15次真实Pi/API/MySQL回环通过，截断输出不提交、一次完整补正只保留原任务、全部调用结算。独立审查另亲自执行持续length失败/完整补正/取消不补正的内存SDK反例通过。
- 真实Worker`mvp-prefill-context.log`12项边界、9次回环通过；`mvp-net-scope-evaluator-fixed.log`13原参考及原16错误反例、渠道5变体的字面量/参数形状通过。记忆协议组`mvp-memory-scope-protocol.log`37回环调用通过，本次全部渠道优先、旧默认修订为app的跨会话复用和停用后不采用均有SQL独立数值核算。0官方请求；不是模型质量证据。
- 最新完整官方fixture为`complete-quality-configuration.json`，使用未使用的独立持久账本；全S/B/P真实验收正在执行。期间不修改其源码/契约/知识/测试指纹，不重建共享二进制。
- I3本地Embedding先行可行性试验在忽略的`.local/checks/embedding-sample/`进行，未改项目依赖。FastEmbed 7.1.0已核对支持multilingual-e5-small/384维/本地CPU；默认ORT预编译下载长时间无进展，已停止自己启动的样例进程。公共CDN经curl可访问（9MB归档），下一步验证分发SHA后沿库支持的本地运行库路径验证；此时尚无Embedding可用结论。

- 新完整官方验收已归档`complete-quality-failure.json`，34次实际调用全结算、预留0；S01/S02机器通过，S03尚无任务，连续19次坏空值/漏字段后耗尽请求上限。独立SDK解析验证合法JSON null不会被宿主转成字符串，不能归因网络或harness强制转换。S02独立核算及7变体通过；S01开头仍从正額事件约束推断业务成交价，质量保持待修正。
- 本次接口改进：新建AnalysisUpdate仍要求明确action/goal/完整conditions/options，但可省略尚不存在的task_id/expected_version与无需澄清的question。已有任务真实ID/版本、完整条件、补丁、route限制、权限及字符串null拒绝保持；Rust业务以缺失字段同JSON null读取，未增加模型猜测或业务默认。生成类型将这些可选无值字段省略，原显式null案例增加准确的canonical roundtrip预期，原验证正反例仍全部保留。此变更针对无意义必填造成的19次循环，不改变用户产品行为或独立答案。
- 本地Embedding可行性已通过：ORT分发SHA-256与官方常量一致，库支持的ORT_LIB_PATH完成编译；multilingual-e5-small本地CPU输出384维，退款问法的目标排序第一，推理54ms（首次加载47.3秒）。此样本只证明可运行，不代表千表召回质量；主项目向量检索仍待实现。

- 旧route的双JSON null表示无具体分析任务的消息归属，正式启动、结果通知和控制类输入已有这一合法行为，本轮保持；有task_id时expected_version仍必须是真实当前版本。clarify新建的if分支已补task_id存在条件，避免省略时同时误匹配新建/已有两个分支。

- 新增真实生成类型roundtrip后发现旧ConditionPatch匿名set对象缺失字段会被quicktype序列化成全null，且原检查器未检测这一差异。将同一字段结构命名为同源ConditionSet定义，使生成器按原可选规则省略缺失值；不改变set/unset的请求形状与验证约束。旧首次build失败日志保留，不能作为通过。

- 新P01首个官方请求失败，`prefill-quality-current-failure.json`保留；实际usage为4119输入/1161输出，账本全结算1次，不能归因输出上限。现有解析失败只存null，原输出不可追溯，无法判断具体坏JSON原因。预填解析新增有界失败诊断保存到受控attempt结果，明确length仍拒绝，正常JSON契约不变；诊断不进入公开日志/模型。新样本验证前不声称已定位根因或质量已通过。

- 独立复核补出控制类route双null经可选类型序列化后会变成无效请求。保持既有无任务归属用途：route可省略双身份；有task_id仍强制当前版本，无task_id不得携带非null版本。新增实际生成类型往返及无任务乱带版本反例，JS/Rust都重新验证roundtrip输出，防止仅比对一个不合法canonical。

- 模型准入拒绝budget_exhausted现明确传为model_budget_exhausted，避免19次工具失败耗尽原请求后被误报网络失败。新的SDK协议反例实际验证0网络请求、稳定原因；调用上限/预留/结算规则不改，费用不作为本轮停工条件。预填解析失败有界诊断与length拒绝的4项Rust测试、12项Worker边界（9回环请求）已退出0。

- `prefill-quality-diagnostic-result.json`为最新P01–P05官方机器全通过，共10次请求全结算/预留0；引用与人工保护结构通过，语义逐条审查已交独立审查者，未据此宣布质量通过。独立反例发现带replaces_query_id的route省略身份仍可到Rust后才被拒绝，已在同源替代分支补required并加反例，原Rust绑定校验继续保留。

### 2026-10-04 续接：真实失败归档与依据复核

- 官方分析结果：`.local/model-workflow/analysis-quality-result-20261004-230058.json`，42调用；S04实际失败于新会话“按金额计算退款比例”，并非历史地区或订单澄清回复。S01独立复核仍发现订单行0金额错误推出整单状态，不能按机器通过认定语义通过。
- 官方记忆结果：`.local/model-workflow/memory-quality-result-20261004-230408.json`，30调用；B05机器通过，失败变体未调用save_memory却声称已记下，正修复通用持久意图识别。
- 预填单次分析反复遗漏边界并制造假缺口，改为固定两次结构化维护请求：第一轮分析、第二轮对照同版原资料复核。每次分别领取同一trial预算、固定调用ID、结算usage；保存两轮诊断，不含独立答案。坏格式、坏引用、未知回执、旧版本或复核失败均不应用首轮结果；不创建第二个Agent循环，不自动无限重试。该实现是质量保护，不能直接标成业务验证通过。
- 本地Embedding/Milvus千表可行性结果`.local/checks/embedding-catalog-benchmark.json`：1204合成对象、四问目标均第一，建库约17.3秒；尚未接入正式应用，不能替代I3应用级权限、更新及恢复验证。

### 2026-10-04 后续真实结果与并发修复

- `.local/model-workflow/quality-reconciliation-result.json` 64官方调用全部结算；S04三条SQL及变体、B05-failure真实保存拒绝与后续无偏好均获独立核对。P02/P03假缺口已消除，引用及人工保护通过；P01重复轮仍漏相关未模拟边界，S01仍存在无依据排除零元成交的表述，质量保持pending。P04首轮语义认可，第二轮引用改写换行被严格拒绝；P05未运行。
- `.local/model-workflow/grounded-quality-failure-result.json`：3调用，S01未读取加工SQL而用摘要作答，机器所需COALESCE依据未呈现，保留失败。新增可配置Pi/DeepSeek原生thinking_level（旧profile缺省仍off）、8192输出上限；思考tokens与正式输出共同计入同一持久许可及usage，不新增规划器。下一批用low实测，尚未证明质量通过。
- 预填响应先独立提交usage结算，再校验来源及知识，解除维护trial/source反序。`.local/checks/mvp-prefill-concurrency.log`真实两Worker同trial构造两个等待事务，释放竞争后4HTTP全部结算、预留0、两attempt成功，无额外重发。回环未知/复核/人工保护17场景22HTTP通过。逐行引用目录只是原文复制辅助，引用校验仍严格。
- 独立追加发现：纯解释输出已提交而任务仍investigating；查询终态未解释就被标answered。将任务回答阶段与正式输出提交组合，等待解释与失败不能标已回答。

### 2026-10-05 续接：正式交付与通用目录

- 任务阶段按正式交付与当前业务事实更新：语义解释提交才已回答；结果终态先等解释；开放澄清、其他待确认与queued/submitting/running/submission_unknown优先。恢复链回执按recovery_chain_id接回；宿主结果唤醒只推进原查询条件版本。
- 新增目录契约与/source-syncs接入：分页快照、平台稳定表/字段ID、单调版本与采集前基线CAS、原文来源事实、人工保护、按需预填。authoritative=true仅在全部分页成功后允许退休缺席字段/表；读取版本与退休持同一空间同步锁。平台退休与人工停用分别记录state_origin，回归只自动恢复前者。
- .local/checks/mvp-catalog-import-fixed.log退出0（7组），.local/checks/mvp-answer-phase-final.log退出0（5组）。随后扩展平台退休重现及旧条件无新稿反例，最终回归仍待运行；初次测试辅助代码失败日志保留。
- 本地向量接入正在实现：FastEmbed 7.1.0 / multilingual-e5-small / 384维，模型在本机CPU处理；Milvus只有派生索引。新增本地运行库校验脚本与.cargo配置，锁定ort-sys的官方分发和SHA-256。模型文件与运行库均留在忽略的.local目录。
- 领取索引作业先提交短事务，Embedding/Milvus在事务外；不可变版本/片段键、租约代次、未知先查证、有界重试。索引与查询Worker分开。API/Pi搜索先准备向量候选，再事务内回源核对状态、版本、来源和权限，融合精确/词法/向量与相关对象；向量故障、索引不足及候选限额明确报告。该路径尚待编译与千表应用级验收，不能用先前独立Milvus样例代替。
- 新增read_conversation的任务目录分页，解决同消息多目标在长对话重建后仅留下最后routed_task_id的定位缺口；只返回目录摘要，正文仍通过read_analysis_task当前授权读取。待新增协议反例。

### 2026-10-05 继续修复：目录整批代次与索引恢复

- 千表正式应用验收首轮360秒超时；原产物保存为`.local/checks/mvp-hybrid-retrieval-first-timeout.{log,json}`。随后批量查证/写入/清理属于待验证性能修复，尚不认定千表通过。
- 独立复核新增三个确定问题：内容未变的新完整目录不能阻止旧空快照删除；目录来源改版未自动排队预填；第3次索引领取后崩溃永远sending。正在分别加入范围代次CAS、与知识版本同事务的预填排队、过期耗尽明确失败及幂等索引重建入口，测试先保留这些反例。
- 目录15分钟采集期限覆盖写入和缺席退休；已过期的操作先提交明确失败，再返回错误，新operation重新采集。同平台版本重新出现允许恢复平台退休，人工停用仍受保护。
- 固定本地Embedding权重revision与文件SHA-256，运行时只读已校验本地文件；向量索引绑定模型/目标，换collection不沿用旧完成状态。增加维护者索引重建与检索降级展示。
- 单次模型调用90秒、每阶段预填领取120秒；Worker整轮期限按原请求调用上限推导并持续心跳，避免多工具循环被固定60秒截断。预算身份、重试和使用量规则保持原决定。以上均待当前构建/反例验证，CURRENT保持active。

- 首轮批量优化后索引可写完，但冷启动问句在15秒等待内仍不可用，失败归档`.local/checks/mvp-hybrid-retrieval-query-unavailable.json`。小样实测本地API冷初始化约25秒，2秒检索取消后后台初始化仍持许可。改为启动预热、复用SDK文件加载及仅优化开发SHA-256依赖，保持固定文件校验；需重跑效果证据。
- 独立复核追加“丢同名collection后先新增对象”的遗漏。索引目标现绑定Milvus实际collectionID；新库代次会自动重排当前全体知识，API覆盖核对实际目标。新增该真实Milvus反例；显式维护者重建仍保留。
- 原生思考代表批准备为新的有限持久trial，仅合成材料，不复用/重置旧失败账本；尚未调用。正式预填验收等待期限匹配两个90秒请求，回环40秒不变，不放宽引用或语义标准。

### 验收与要求变更：检索降级覆盖状态

- `check-hybrid-retrieval`末项原断言`state=bounded`，改为`state=candidate_limit`并核对契约限额2200。此次合成目录的通用关键词命中超过1000候选，原设计及SearchCoverage契约明确candidate_limit优先表达该原因；向量不可用、词法降级及精确目标命中断言不变。独立审查者已对照设计认可这是测试预期过窄，未改变产品要求或放宽语义正确性。旧失败产物保留。
- 正式千表generation轮前7项通过，首次导入及索引107.3秒，四种独立中文目标、丢库自动及手动重建、耗尽收尾、丢回执查证、状态/个人边界都已执行。查询耗时多为4–7秒、最大8.84秒，不能宣称低延迟；正在用有界批量回源替代逐对象重复查询，再验证权限及来源版本。
- 独立审查新增混合目标取消遗漏：同输入两任务只记录最后task_id，取消其中一个会撤回整条输入。现补持久多目标关联，取消后在原message/chain/budget/job下续跑其余任务，新反例待运行。

### 2026-10-05 本轮续接：千表证据与混合目标恢复

- `.local/checks/mvp-hybrid-retrieval-bulk-source.log`完整退出0，8组应用级检查通过；1204张表/2408个新对象，索引98.70秒，21次查询中位约3427ms、最大5956ms。独立审查已核对批量回源继续逐项校验空间、状态、正文版本、来源和个人隔离；仍不能宣称低延迟。
- `WorkspaceContext.input_task_ids`纳入同源契约及实际生成类型往返，136条JS/Rust正反例退出0。新输入的全部任务关联持久保存，部分取消在原message/chain/budget/job上继续未取消目标。新增0006迁移，从已成功工具回执补回旧输入的真实任务归属，不修改已应用0005。
- 基础取消四组、27任务目录、资产目录、回答阶段及Pi恢复续接均已完整退出0。迁移fixture首次把SQL注释接在USE之后导致失败，已保留`mvp-mixed-task-migration-fixture-failure.log`；修正fixture换行后再跑，未修改业务预期。
- 独立追加重复取消反例：同operation重传可再次打断剩余目标。已按M06责任增加`task_lifecycle_operations`及回执；同payload重传或不同key取消已取消终态均不撤销新运行，换任务/版本复用同key拒绝。`.local/checks/mvp-task-cancel-idempotency.log`四组完整退出0，保持run/lease/job attempts/events/账本不变；最终完整回归仍待跑。
- 超60秒Worker慢轮首次fixture没有登记控制输入归属，finish被message_pending正确拒绝，并非Worker期限失败。原日志/JSON保留为`mvp-worker-run-deadline-fixture-failure.*`；修正为一次合法route后11次补读及正式输出，仍要求13调用、单run、耗时>60秒、全结算，待新运行结果。

### 2026-10-05 续接：原生请求参数及独立质量失败

- `.local/checks/mvp-user-interruption-epoch.log`完整退出0，8组通过：旧会话回填、重复取消和五目标连续取消沿用原消息/恢复链/预算，用户中断仅退还当前epoch的一次尝试，历史失败及新领取窗口的尝试保持。独立源码复核已认可，最终指纹待绑定。
- `.local/checks/mvp-mixed-task-pi-continuation-current.log`完整退出0，6次回环：Pi真实创建两任务，取消后首个恢复请求包含最新lifecycle与全部input_task_ids，未重复任务或副作用，未知调用保留原scope。SDK对照探针证明原sendCustomMessage首次调用不刷新resource loader，恢复改用公开prompt，Pi继续负责压缩和循环。
- `.local/checks/mvp-native-reserve-contracts.log`138条JS/Rust正反例完整退出0，8192 profile/reserve接口已对齐，独立生成一致性与正反例认可。`.local/checks/mvp-native-worker-run-deadline.log`13次调用、约71.45秒、同run及全部usage结算，实际请求low/8192通过。
- `.local/checks/mvp-catalog-deleted.log`完整退出0，12项通过；手工删除表/字段不复活，同版及改版目录继续同步其他对象。独立复核已认可空间墓碑及批处理行为，D04常用范围仍开放。
- `.local/model-workflow/native-quality-representative-result.json`完整失败，5次官方调用全结算、预留0。S01机器通过但独立审查发现反向粒度推断错误及refund-only例子违反输出表CHECK，保持语义失败；P01首轮finish_reason=length且content为空，不能判断语义质量。旧失败账本不重置。
- 预填prepare原先只传thinking.enabled，未传配置中的reasoning_effort；现对low/high发送对应参数、off省略，需验证分析/复核两阶段。Agent通用指令要求分别查证推断方向及例子能否满足全部入表约束，不写入独立验收答案。

### 验收与要求变更：恢复压缩的触发点计数

- `check-recovery-continuation`原断言`summaries===1`，改为在模型注入唯一一次overflow时记录`summariesAtOverflow`，最终严格要求`chats===2`及`summaries===summariesAtOverflow+1`。公开Pi prompt恢复当前资源时允许先原生preflight压缩，旧固定总数误把合法摘要计为失败。独立审查已对照SDK认可修正；保留原生compaction持久记录、单任务、原run正式完成及IA04不重复副作用断言，不放宽溢出恢复行为。旧失败`.local/checks/mvp-recovery-current-resource.log`保留，新运行待验证。

- 上条“preflight+1”解释被本次源码与运行证据取代：`.local/checks/mvp-recovery-trigger-compaction-current.log`仍失败，overflow触发时摘要0、之后2。锁定Pi 1.0.0的`core/compaction/compaction.js:690–701`在split turn分别请求历史及当前turn前缀摘要，再合为一次compaction；`agent-session.js:2488`只appendCompaction一次。测试现按公开SessionManager写入次数核对触发后恰好一次compaction，另严格核对本fixture2次摘要、split marker、chats2及overflow1。独立复核认可SDK依据与行为范围；`.local/checks/mvp-recovery-split-compaction-current.log`完整退出0，IA04–IA05四组通过。没有删掉溢出场景或改成mock业务通过。
- `.local/checks/mvp-prefill-native-level-current.log`完整退出0，19组/26回环；off不携effort、low/high分别在分析与复核两阶段实际发送对应参数和8192输出上限，每阶段usage全部结算。独立源码及完整日志认可；真实P01仍待新结果。

### 2026-10-05 D04常用范围补齐中

- M03维护独立配置版本及操作回执，不改变正式知识正文版本；表和所属字段继承常用优先级，未领取队列可调整，已发送请求身份/预算保持。维护页提供表级开关与目录标识；所有表基础导入后立即可检索，普通表首次不自动深入分析，可按需预填。来源改版仍自动排队所有受影响对象，保留D05及人工保护；新字段随改版重分析，不将D05缩成仅已分析对象。
- 新增0008迁移、同源配置命令/回执、具名use_case及HTTP接口，职责同步到模块设计。尚待本地配置/排序/初次导入/按需/来源变更/权限/幂等/重启及浏览器验收，不能提前关闭D04。

- 首轮`.local/checks/mvp-analysis-preference-current.log`6组/22回环完整退出0；142组契约及正式浏览器9组也退出0。独立审查追加已完成operation并发重传的锁升级风险与搜索列表旧对象问题。新增反例实际得到6并发中3个503（`mvp-analysis-preference-lock-upgrade-probe.log`保留），不能作为幂等通过；M03初始化既有行改为直接取得排他锁的upsert，原命令指纹与回执不变。另修搜索命中按ID读取当前对象，浏览器保持搜索词验证标识同步。新增30次已有回执并发重传及同配置版本6个不同operation竞争的严格断言，修复后待重跑。
- `.local/checks/mvp-analysis-preference-lock-fixed.log`完整退出0：30次已有operation并发重传均返回原回执且不增任务，6个不同operation竞争同配置版本仅一个成功、其他409，6组/22回环全部结算。`.local/checks/mvp-analysis-preference-search-browser-fixed.log`当前9组完整退出0，保持搜索词的标识更新及晚到响应保护通过；独立审查逐项认可，D04这次最小合成范围没有剩余阻断。模块接口及来源/优先调度流程图已同步；当前真实模型验收使用全新trial，旧失败预算与产物保留。


### 2026-10-05 最新真实代表失败诊断

- `.local/model-workflow/native-quality-fixed-representative-result.json`与`native-quality-fixed-representative-details.json`保留新轮完整报告及持久诊断；4次官方调用全结算，预留0。S01仍给出仅成功退款的零付款成因，违反输出表退款不超过付款的CHECK，未按机器通过关闭质量问题。通用说明改为成因列表前读全相关DDL及加工、检查整个链路是否可落表，未读资料不能声称未提供；没有写入独立参考答案。
- P01实际输入8619/output8192，reasoning7436，正式JSON在引用中被length截断。预填原生low参数发送正确，失败并非引用校验放宽就能解决。下一代表轮使用单独全新off配置检查维护输出，不重置旧账本、不应用截断内容；聊天原生low能力和协议证据仍保留。
- 验收runner失败现携带该预填对象和attempt的受控原始诊断，不再把上一场S01会话当P01失败快照。成功判断仍严格succeeded；来源、引用、人工保护及独立语义标准不变。该诊断只存忽略的本地证据。


### 验收与要求变更：本地MVP与I3范围

- 原AC09混合本地目录/常用/千表与真实平台、正式认证、D18真实用户试用，command为null。按用户已明确的“平台先mock”及系统设计17.2/21节分范围交付，本轮仅验收合成平台本地MVP：AC09绑定实际`verify-catalog-workflow`，D04在AC09与AC10验收，D16/D17在AC07/08/10对账，C06千表部分加入AC10。独立审查者已核对原要求并认可这种范围区分。未放宽对应行为、模型语义或故障验收。
- D18从本轮可关闭runtime要求迁入下面I3待验收范围；完整36项registry、原决定、历史与原I3要求均保留。任何本地命令通过都不构成D18或整个目标空间质量通过，不能据此宣称生产就绪。

### I3仍待验收的明确范围

| 要求 | 必须取得的后续证据 |
| --- | --- |
| D04、D16、D17、C06 | 实际完整目录和更广跨业务问句下的召回、语义、数值、延迟及索引更新；当前1204张合成表、四问目标进前六不等于整个E15或任意业务准确率 |
| D18 | 获准数据开发/分析用户试用，纳入产品/算法反馈，保存使用范围、问题与效果；本地可运行版本只为试用做准备 |
| C02–C05真实接入部分 | 真实Datasight身份/权限、SQL方言、提交与未知查证、取消、分页和结果保留期，以及正式认证；mock平台和演示身份仅证明本地契约 |

### 2026-10-05 原生输出容量与语义复验

- 新off代表轮`.local/model-workflow/structured-quality-representative-result.json`16调用全结算，P01/P04/P05格式引用及人工保护机器通过。但独立语义审查拒绝P04两处假缺口，以及S01前文绝对否认零元成交、末尾才未知的矛盾；不能据此标质量通过。随后low聊天S01保留在`investigation-quality-representative-result.json`（5次全结算），独立审查中。
- 已核对2026-10-05官方[Chat Completions参数](https://api-docs.deepseek.com/zh-cn/api/create-chat-completion)：max_tokens范围至393216；思考模式缺省64K，思考与正文共同占用completion上限。8192是项目选择，不是服务端硬上限。新增有限16384档，同源profile/reserve对齐；原I0的1024/off/6请求规则保留不变，新增正反例及实际维护两阶段请求覆盖。
- 预填复核规则要求每个gap与value、引用、原文的单位/用途/默认过滤/加工事实一致；只写影响当前条目使用的实际缺口，不为了填gap增加展示规范。Agent通用说明要求原文明确声明才称不模拟，未知情形只能保留规则未定义。独立答案仍未进入输入。新16K配置须全新账本验证，所有旧失败保留。


### 验收与要求变更：旧首次导入fixture与完整目录

- `.local/checks/mvp-knowledge-workflow-final.log`首次完整重跑失败于旧断言“两次不同operation并发source-syncs都200”；API服务诊断为version_conflict，无数据库失败。原fixture写于仅三份合成源同步时，现在该入口还执行分页目录及采集前CAS。
- 独立审查对照M03固定采集基线、A05及较新完整目录阻止旧空快照删除的反例，认可新严格预期：至少一个200，其余只能200或409/version_conflict；503、超时、其他错误与全部失败仍拒绝。原operation重放必须保留原成功/失败回执与基线，不能拿旧载荷换起点；新operation重新采集成功。
- 原全库source_snapshots===3改为精确集合：schema/etl/business-guide各一份，加独立fixture五张接口表各一份，共8且全部version1。不改成>=3。新增重放/新采集后的正文、首版历史及待办不重复断言，保留其后人工保护与来源变化检查。失败日志保留，修正后完整结果仍待运行。


### 2026-10-05 16K失败与原生结构输出修复

- `.local/model-workflow/reasoned-quality-representative-result.json`及对应日志保留low/16384代表轮：10次全部结算，P01首轮实际输出7948（reasoning7118），结束于正常JSON但漏了必需evidence，严格拒绝并未调用复核；本次不能归因截断。S01仍有绝对业务否认及跨粒度反向概括，保持语义待修正。
- 查证官方工具参数：思考模式不能指定required或具体tool，会400；原生auto工具可用。预填改为同源PrefillResult作为`submit_semantic_prefill`原生工具Schema，思考模式auto、off指定唯一工具。只接一次完整同名工具参数，长度截断、缺失/多余/异名工具和坏JSON均拒绝；不执行模型的工具声明副作用。仍固定分析与依据复核各一次，不加Agent循环或无限重试，也不放宽完整覆盖/引用/人工保护标准。
- 六个维护回环fixture同步原生工具回执，并新增Rust完整单工具/坏身份/多个工具/截断反例；知识完整回归正在运行。系统说明将“无法由当前事实推出”与“不是/无关”明确区分，未写入合成问题答案。后续官方验证使用全新配置，旧账本继续保留。


### 验收与要求变更：多目标取消后的旧运行

- 修正首次同步fixture后的`.local/checks/mvp-knowledge-workflow-current.log`中知识12组通过；其后旧check-boundaries在同输入任务A/B取消A后，仍调用原已取消run完成文字，得到409/lease_lost。当前多目标取消设计明确使旧run失效，并以原message/chain/budget续接未取消B，原旧run成功finish预期与此矛盾。
- fixture保留A查询取消/B草稿未提交和后续B确认成功；新增旧run文字写入明确lease_lost，Worker新run沿原消息/预算及input_task_ids包含B，续接后才finish。禁止放行旧run、另建消息/任务或给预算补额。修正只在测试入口，真实Pi多目标恢复仍由既有专门反例验证；独立审查中。
- 前两次新fixture失败分别为每次HTTP错误request_id不同、后半段另一个旧并发all200断言；修正只比较稳定错误码和持久基线/回执，HTTP追踪ID仍独立。来源变化断言另加强为schema精确1/2版本及知识只新增一次。旧失败日志均保留，尚未当完整回归通过。

- 新fixture在B续接超时，日志明确为stale_context。独立审查核对：前段已选用/停用Skill并应用语义改版，旧检查点仍带初始依据清单，恢复拒绝符合A07；不能放行旧依据。现保留前段全部拒绝与提案断言，合法撤回已过期输入，然后用取得当前依据的新运行测试纯A/B取消。新运行继续核对原message/chain/budget、完整input_task_ids、A取消/B活跃、任务与B草稿不重复，B只经确认执行。旧失败日志保留；这项修正尚待实际完整运行。
- 当前上下文fixture已通过B续接及确认，后段“新会话未归属”误捕获了B结果唤醒，日志中其conversation/message与发送的新输入不同。测试harness.capture原按数组下标取下一捕获，现严格绑定send实际返回的message_id及conversation_id，不修改业务路由或原拒绝预期。`.local/checks/mvp-boundaries-current-context.log`保留为失败；修正后待重跑。
- 严格消息绑定后暴露fixture没有收尾B结果唤醒，捕获桥接占用串行Worker并使新输入等待。现明确捕获并合法提交B结果唤醒后进入下一场景，仍保留新消息未route时message_pending及撤回检查。`.local/checks/mvp-boundaries-message-bound.log`超时保留，不能当作通过。


### 2026-10-05 原生工具本地整体回归

- `.local/checks/mvp-knowledge-native-tool-final.log`完整退出0：知识同步、7组边界、生命周期、多目标取消/Pi续接、失效依据、长对话/资产目录、预填与并发、记忆、长文/历史、目录和常用范围均通过。预填当前20组/28回环，含low/high/8192及low/16384两阶段实际参数与全结算，未以旧日志代替新协议验收。
- `.local/checks/mvp-boundaries-result-finished.log`完整退出0，前述新上下文、精确消息绑定与B结果唤醒收尾修正的业务预期保留；独立源码审查已认可测试前提。
- `.local/checks/mvp-implementation-atlas-current.log`完整退出0，重新生成28张/12模块图册，图语法、边界、切换及手机检查通过；设计视图不替代运行证据。
- 新官方代表使用`.local/model-workflow/tool-quality-configuration.json`，原生low/16384及全新有限持久trial，正在执行S01/P01/P04/P05。此前所有失败产物与账本均保留，未读取独立答案作为模型输入；完成后仍须独立语义复核。


### 2026-10-05 真实桥取消及语义组合修复

- 独立审查追加旧Pi请求仍占用Node会话的真实窗口；原捕获fixture手动release没有覆盖。新正式Worker/Bridge/Pi反例在旧代码`.local/checks/mvp-mixed-task-bridge-before-fix.log`完整退出1，剩余目标交付耗尽。Worker现续租失效/传输中断按原run/epoch通知现有cancel接口，Pi通过原生abort中止模型。Bridge409明确未接纳时，具名defer_busy_delivery事务标记该run中断、释放自己的运行权，仅退本次attempt并有限退避；保留历史失败、原输入/链/模型账本。
- `.local/checks/mvp-mixed-task-bridge-busy-current.log`完整退出0：真实桥普通取消6回环/2run/约1.37秒；实际Pi中止后延迟2.3秒收尾产生409，保留两次历史失败，6回环/9run/约3.84秒最终完成。拒收代次不调用模型，未知调用保留原scope，不用手动release/abort。整套回归仍待完成，独立复核进行中。
- `.local/model-workflow/tool-quality-representative-result.json`16次官方调用全部结算、预留0，但独立审查仅认可S01、P04及P01/P05初次；再次P01列出无法落表的成功refund-only情形、再次P05忽略行级取消分支断言同单状态必然一致，明确不认定整轮质量通过。87条引用逐字/行号及人工保护虽通过，也不抵消错误推断。
- 预填通用规则补齐整条加工的输出约束/CASE优先级和逐分支粒度核对；没有输入独立参考答案。新的high/16384代表配置已创建，等待当前本地回归后执行。旧trial和失败产物不修改。
- 独立审查确认单独官方业务audit的输入指纹漏掉直接harness/平台/API/Worker及构建配置；已纳入全部apps、harness、crate和Cargo/Node清单，新正式验收会绑定这些实际依赖。最终增量指纹仍保持全范围。

### 2026-10-05 续接审计修复

- 最新独立查询审查发现三项剩余问题：`cancel_query`对终态仍回传失效依据派生正文；相同修订调用在第二个短事务中未重查已完成回执；SQLite整数绑定越界导致连接异常而不是明确诊断。取消入口新增反例已在`mvp-cancel-query-body-before-fix.log`实际失败，参数越界已由原Platform内存探针复现，并发交错待固定反例。
- Pi恢复还存在首次明确拒绝虽已持久记录、Node却立即抛错的问题；在保留历史失败的多目标恢复中可能阻断未取消目标。需让当前恢复接回已持久的回执并交给Pi继续，未知回执和失效租约仍须拒绝。原fixture要求额外恢复一次与正常续接目标矛盾，调整时保留原操作身份、历史失败和预算断言。
- 本轮先修复上述边界并验证，再进行全新high/16384真实代表轮；独立语义认可后才扩大完整业务验收。用户已授权合成mock与DeepSeek调用并解除费用顾虑，有限持久账本、旧失败和独立答案隔离继续保留。launcher 54998继续保留。
- 恢复fixture原要求“第二次恢复抛not_available、第三次才完成”改为首次持久拒绝就在同次恢复交给Pi，并核对仅两个运行及原operation/origin保持。依据为A02/A07和Pi正常工具错误续接行为；没有放宽未知回执、坏参数或压缩反例。内部新增只读已记录拒绝查询，保持现有工具提交HTTP拒绝契约，查不到或失权仍抛出原错误；不重执行未知操作。
- `.local/checks/mvp-control-contracts-current.log`148组Rust/JS同源契约退出0，新增取消控制正例及正文反例；类型及模块边界检查通过。查询新增并发场景延长执行时暴露旧fixture未收尾的结果唤醒占用捕获桥，现明确等待原已确认查询成功并撤回测试结果输入后继续，原确认、只读、未知与诊断断言全部保留。首次修复还被旧取消回执的`error:null`字段反例推翻，改以查询ID识别历史查询载荷过滤；失败日志全部保留。
- `.local/checks/mvp-query-reliability-replay-fixed.log`完整退出0，11组：24同SDK修订并发均同回执/单后继，取消首次及重放均仅五字段（旧完整回执error为空/非空均过滤），绑定整数越界明确诊断且文本大数正例可用，原权限/旧稿/诊断/未知/Skill/删除结算断言保留。恢复新反例及整套回归尚待，不据此关闭MVP。
- 独立审查指出24并发仅为压力回归；现新增真实MySQL锁队列固定B首次空回执、A提交后继、B第二事务交错，并严格限制平台检查仅一次。`.local/checks/mvp-query-reliability-interleaved-fixed.log`12组完整退出0。临时仅移除第二事务回执检查的负对照（压力场景单调用，聚焦固定交错）在`mvp-replay-interleaving-negative.log`准确收到409/version_conflict并退出1；已用finally恢复相同源码及正式二进制。正常验收仍24并发、全部原断言及新固定交错，未放宽标准。
- `.local/checks/mvp-recovery-rejection-current.log`5组完整退出0，首次拒绝在同次恢复接回；保留三次模拟交付中断后，取消A仅退当前attempt，最后合法attempt接回拒绝并完成B，原chain/scope/operation/origin保持。独立Pi内存探针也认可只读查证，无回执/失权/异指纹保留同一原异常。审查建议已修fixture取消后不覆盖真实cancelled历史并补旧lease反例，新完整回归待结果。
- `.local/checks/mvp-recovery-rejection-final.log`更新后5组完整退出0，真实cancelled历史与旧lease拒绝保持；两位独立审查者已认可查询固定交错正反证据及运行时修复。更新的28图/12模块图册退出0。
- `.local/model-workflow/constraint-quality-representative-result.json`保留high/16384真实代表轮：S01及P01初次机器通过，但P01再次复核finish_reason=length，无完整提交而严格invalid_prefill；12次官方调用全部结算、预留0。本轮未完成，不把截断结果当建议应用。该新增证据支持有限32768输出档，ModelProfile/ReserveModelCall同源、预留结算及两阶段实发正反例同步；新trial继续high/32768代表验证，旧ledger/失败产物保留。
- 有限32768档验证已完成：`.local/checks/mvp-expanded-output-contracts.log`152组同源正反例完整退出0；`mvp-expanded-output-prefill.log`21组/30回环完整退出0，high/32768在分析与复核各实际发送一次、usage全结算，原截断/缺失/引用/人工保护/未知与预算反例保留。新的官方high/32768代表轮开始，质量结论仍待。
- `.local/model-workflow/expanded-constraint-quality-representative-result.json`新代表轮完整退出0，S01/P01/P04/P05机器全部通过；16次官方调用全结算、预留0，最大维护completion16915，实际超过旧档并完整提交，容量扩展有真实证据。新产物SHA256为`9876088e39e0f0f050ad00580b11d7d0410beaf9f17e165933f8a2cc65a028a9`，独立语义复核进行中。上一轮P01初次已从保留trial库导出只读历史补证并通过独立复核，不覆盖新轮。

### 2026-10-05 完整回归续接与推断反例

- 独立复核已完成上述32768代表产物：S01失败，P01/P04初次及再次通过，P05初次通过/再次失败。115条引用逐字与行号、人工覆盖保护、全结算虽通过，不能抵消两处错误推断。S01已读取完整输出DDL，故不是资料缺失；P05与其自身前文也矛盾。不开始全量验收，不创建通过收据。
- 新规则用可检验的逻辑替代宽泛的“核对约束”：可能结论须构造经过完整加工且满足全部输出约束的见证；禁止结论须指出实际作用于该组合的谓词并查找合法反例。明确区分程序保证、业务约定、未模拟范围和未知。工作台及固定两阶段预填同时落实；未增加Agent循环，未将独立参考答案或具体失败题答案输入模型。
- `.local/checks/mvp-query-knowledge-current-regression.log`完整退出0：`make -j1 verify-code verify-query-workflow verify-knowledge-workflow`全通过，包含真实MySQL固定交错、真实Pi桥取消及首次拒绝续接、21组/30次预填回环、目录/常用范围。后续新prompt仍须相应局部复核，最终增量会重新绑定当前全范围。
- 新规则后的`mvp-semantic-inference-code.log`和`mvp-semantic-inference-prefill.log`均完整退出0：格式、Clippy、类型、正式Web构建、API/Worker构建及21组/30次预填回环通过。新的`inference-quality-configuration.json`使用全新有限trial/database，当前S01/P01/P04/P05真实代表轮执行中；所有旧失败与账本保留。模型规则不等于业务质量保证，仍等待独立审查。
- 该轮已在S01失败，归档`inference-quality-input-boundary-result.json`（SHA256 `d26dea3c8e98cd3c4b9bf5807a40cfbddfa5c63dfaf36b97d0988be4b7b599f0`），7次官方调用全结算。真实检查点证明Pi两次原生溢出压缩都执行；最近assistant与两条工具回执（检索回执包含20个候选）不可拆散，加上工具定义和摘要仍超过64KiB，有限retry后明确失败，未正式提交回答。此前“执行中”现已被该失败替代。独立审查恢复该检查点并使用锁定SDK的onPayload只读测量73772字节（0网络调用），确认64KiB不足、128KiB可容纳。

### 验收与要求变更：数据请求体容量

- 数据ModelProfile最大请求体从65536提升至131072 UTF-8字节，新试验显式采用128KiB；旧64KiB档、超限发送前拒绝及I0的2048字节/4096输入/1024输出保持。独立依据为上述真实原生压缩后的最小保留组仍超64KiB；不跳过SDK压缩、不删除工具原文、不增加Agent循环。原profile每次实际输入usage仍按32768核验，字节上限不声称是服务端token硬限制。
- 新增同源131072正例/131073反例、旧64KiB拒绝与新128KiB准入及超限拒绝的真实SDK探针，以及当前轮大工具回执触发Pi原生压缩的MySQL/HTTP续答反例。试验全新账本，旧失败保留；这些检查与新代表轮尚待完成，不据容量声明质量通过。
- 新代码/同源契约154组及准入探针完整通过。首次新续答fixture交付已成功，但其新写的“原生压缩仅一条模型摘要请求”断言失败：锁定Pi在切分当前轮时分别总结历史与本轮前缀。根据SDK `compact()` 的split-turn双摘要实现，修正为恰好一次原生compaction、1–2条摘要请求，保持实际溢出、完整工具原文、只一次续答及原操作/预算全结算断言；该前提修正不改变任何旧验收标准。失败日志保留，修正后待实跑。
- `mvp-large-context-continuation-fixed.log`完整退出0：实际HTTP请求体77406/52895/1309/88900字节，1次原生compaction、2次原生摘要、一次续答；最近3个SDK工具及两份8192字中文原文完整保留，任务只一份/已回答，4次全部按原trial结算、预留0。旧64KiB长对话用例保留；新的`large-context-quality-configuration.json`以全新trial开始S01/P01/P04/P05官方代表验证，仍待语义独立复核。


### 2026-10-05 维护边界接续与真实超时

- `.local/model-workflow/large-context-quality-representative-result.json`归档本轮未知调用（SHA256 `47e6408e2218feabc1fe03de62ae9807f136fe9a59540313d1ca73caf0b36b2a`）：S01机器通过；P01初次成功、再次分析完整但复核未知；P04/P05未执行。9次官方调用、spent 65010微美元、reserved 49152微美元保留。不得以未知回执退款或盲目重发，也不得以机器通过代替语义复核。
- 独立查询复核追加MAINTENANCE-REPLAY、IA02-SOURCE-CLEAR和CATALOG-REMOVED-LINEAGE：普通维护需在版本校验前预占并锁定原操作；清除覆盖恢复当前来源基础值；节点缺失仍生成当前版本的明确血缘缺口。先前半成品只改store和导出，组合调用尚未补齐、未编译，旧二进制不能用于验证新源码。
- 独立运行时复核认可128KiB有限档，但需补强两份8192字正文逐字比较、SDK调用/结果精确配对、每次模型调用原run/chain/scope和settled，以及最小工具组经一次原生compact-and-retry仍超限的有限失败。既有前缀/计数断言不足以单独证明这些较强结论。
- 接续先补齐上述修复和有区分度反例，再核对维护90秒HTTP/120秒领取是否适配已验32768输出档。有证据的有限调整不改变聊天超时或未知账本；新官方试验使用新配置和trial，保留全部旧失败。launcher 54998继续保留。

- `mvp-maintenance-replay-final.log`完整退出0：同参知识/资产创建、修改、启停并发同回执/单版本，修改用真实MySQL对象锁与操作锁队列固定竞争；异参与不同操作旧版本冲突、失败回滚、来源description/meaning/DDL/type清除和升级前缺少value均覆盖。节点有→无→恢复时当前检索及受控模型读取通过，人工血缘/历史受保护；来源变化后的旧reanalyze回放不排新任务。新fixture首两次失败是未填契约必需value及误把知识对象按资产body读取，原失败日志保留，均未放宽业务断言。
- 独立运行时复核进一步指出产物只记录model_unknown，没有细分网络原因，不能唯一断言是90秒超时。维护两阶段HTTP已设有限300秒，首次领取/保存草稿后续期同为360秒；官方等待750秒，聊天90秒与原trial一小时/调用/预算不变。新增既有回环模式下50–5000ms快速超时入口，共用阶段时间规则，正式端点忽略此测试值，启动器清除继承值；新超时回归尚待。
- 大回执逐字断言发现新provider fixture把每个TCP Buffer独立转UTF-8，中文跨块产生两个替换字符；这属于接收测试代码，已改为先拼字节再统一解码。没有修改正文或放宽精确断言；原失败诊断日志保留，成功续答/持续超限完整工具组及账本补证仍待运行。

- `mvp-large-context-bounded-final.log`完整退出0：两份8192字正文在实际HTTP续答和SDK压缩后投影逐字一致，三个调用精确配对、原origin/chain/scope不重复，4个实际调用均settled、预留0。六份8192字正文自身147456字节，原生一次compact-and-retry后仍超128KiB；两个实际溢出保留，只有首次规划+两次原生摘要共3个HTTP且全部原范围结算，7个工具不重复、无正式回答。最终异常沿现有安全error.code判定，message固定model_run_failed；fixture先误比message的失败日志保留，未改业务错误契约。
- `mvp-prefill-timeouts-current.log`完整退出0：分析与复核正式领取各350–360秒；延迟两阶段完整应用；分析timeout一次请求、复核timeout保留草稿，均保留49152预留且不自动重发；Worker退出后unknown不重发；过期可靠usage仍结算、建议不应用且预留0。新短测试值仅在已有回环测试模式生效；HTTP固定300秒并不保证任意外部响应完成。当前全代码/契约/查询/知识回归开始，独立维护及运行时复核进行中。

- 上述完整代码/契约/查询/知识链路`mvp-maintenance-full-current.log`已完整退出0，保留21组/30次原生预填、两Worker竞争、来源/人工保护等既有反例。独立复核同期追到资产组合用例先检查当前依赖、预填catch冲突后提交空操作两处关联边界；正在补齐，它们发生后该日志不能替代最终新源码回归。
- 旧重分析兼容已用保留`expanded-constraint-quality` trial的6个成功操作只读重算：source_version字符串逐一匹配，数字不匹配，补证`.local/checks/legacy-reanalysis-fingerprint.json`。新增旧指纹同参/跨对象/异参fixture，不改变旧账本。新固定预填交错等待操作行后由真实HTTP人工改版，再放行锁内冲突，需superseded、人工历史保留且无空操作；先运行尚未重建的旧二进制作为负证，随后重建修复并验证。

- 新固定交错在尚未重建的原二进制上已完整复现：`mvp-prefill-conflict-before-cleanup.log`退出1，superseded后实际留下1条JSON null操作，严格期望0。修改只清除当前owner/operation/同指纹/空回执占位，原成功回执不受影响；可靠用量已单独结算，人工版本不新增。正在验证依赖重放的原二进制负例，随后统一重建修复和局部回归。

- `mvp-maintenance-dependency-before-fix.log`原二进制负例完整退出1：带依赖memory成功保存后知识改版，同参重传实际409、严格期望200。现在资产保存和Skill选择在现有权限/会话锁后先接回原成功回执，首次执行才核对依赖；采用和正文读取仍校验当前有效性。新增改版/停用、新操作拒绝及无版本/选择变动断言，不放宽依赖有效性。


### 2026-10-05 最终维护回归与官方验收接续

- 已接回完整测试进程，`make -j1 verify-code verify-contracts verify-query-workflow verify-knowledge-workflow` 在 `.local/checks/mvp-maintenance-replay-full-final.log` 完整退出0。包含154组同源契约、知识/查询全部既有反例、7组维护超时及固定版本冲突、6组维护操作重传和常用范围；不是仅凭日志尾部判断完成。
- 带依赖资产保存/Skill选择的成功重传先接回原回执，首次操作仍校验当前依赖；固定预填最终改版冲突清除同指纹JSON null占位。两份旧二进制失败日志保留，新完整回归通过。查询与运行时独立审查结论仅覆盖各自限定范围，真实语义与整个MVP仍待。
- 本轮官方代表使用 `.local/model-workflow/maintenance-boundary-quality-configuration.json`；完整16题备用配置为 `.local/model-workflow/complete-maintenance-quality-configuration.json`。两者此前尚未使用，各有独立database/trial；保留原一小时/200调用/单请求24调用及未知预留边界。运行期间不重建共享二进制，不并发运行MySQL集成检查，保留launcher 54998。


### 2026-10-05 原生会话持久化与新增审计问题

- 新代表 `.local/model-workflow/maintenance-boundary-quality-representative-result.json` 已完整退出0，17次官方调用全结算、预留0；独立语义审查发现S01对未定义概念补了确定映射，以及P05初次首句与后文粒度边界矛盾。机器通过不抵消这些问题，当前代表质量未通过，不开始全量官方验收。
- 独立零网络探针复现正式Bridge逐Buffer解码损坏中文；新增正式listener反例在旧代码退出1，字节累计后统一解码已通过同session互斥/取消及中文、emoji、checkpoint参数、512KiB准入/+1拒绝，并通过类型检查；独立审查认可。
- 40轮真实SDK历史加10次原生compaction仍导出约628KiB完整checkpoint，模型投影只有约15KiB，但原Bridge拒绝且dispatch为0。证据 `mvp-runtime-checkpoint-size-before-fix.json`；长期多轮原需求尚未满足，不能仅提高请求上限。
- 决定复用Pi SessionManager原生私有JSONL持久会话，MySQL事务保留同SDK session/精确leaf/authority小引用；恢复选择宿主已保存leaf，文件未确认尾部分支不生效。补存在性、严格JSONL/父链/ID验证、路径/权限与fsync，缺失/损坏明确失败。旧inline先由宿主绑定不可变原值，用小引用读取后在JS一次性物化，保持原SDK调用及operation/origin；Rust不写Pi原生格式，不新增压缩器或Agent循环。实施/验收仍待，最终独立审查必须重新绑定当前全范围。
- 最终增量输入补入已用于正式模型快照的 `.cargo`、`infra`、`rust-toolchain.toml`、`tsconfig.json`，避免构建/Embedding配置变化未被收据覆盖。所有旧失败审查、试验与未知预留保留，launcher 54998不停止。


### 2026-10-05 原生会话回归与参考集合修正

- 原生JSONL持久化164组同源契约、40轮/10原生压缩的627748字节私有journal与218字节引用、628830字节旧inline经正式API迁移均完整退出0。恢复沿MySQL保存leaf；未确认尾分支保留但不进入上下文。纯journal和只读绑定已获运行时独立源码复核；不代表整个MVP完成。
- 原恢复和数据provider断言由直接读取空entries改为restoreCheckpoint(...).getBranch()，保留原工具错误、SDK ID、operation/origin、预算与split-turn compaction断言；完整历史专用验证仍用getEntries。mvp-native-journal-recovery-final.log五组及mvp-native-journal-data-provider-final.log十五调用完整退出0。S08/F08/S11/F11与组件图已同步，mvp-native-journal-atlas.log28图/12模块完整退出0。
- 验收与要求变更：Q04/Q10参考原来把分子缩到期内付款行；新值按文档5.3先圈付款order_id集合，再看其截至快照全部行退款。Python预期独立用集合交集，合成语义SQL由允许列表定义修正，不读取evaluation。依据为独立mvp-refund-rate-reference-before-fix.json合法schema/ETL见证及mvp-maintenance-rules-reference-20261005.json；既有种子数值、SQL确认与指标含义不变，不增加新指标。明确“未模拟跨月分次付款”仅限同一(order_id,line_id)。新增两种跨行/集合外变体及旧聚合拒绝；旧oracle在mvp-order-refund-oracle-before-fix.log实际失败，未用当前模型输出反写参考。

- 当前完整回归 `mvp-native-journal-full-final.log` 实际退出2：代码/164契约/查询/知识/运行恢复均已通过，但旧组合回环fixture在P03用满24调用而失败。失败产物另存`mvp-native-journal-workflow-budget-before-fix.json`：13聊天及原生摘要+11维护，预留0。不能据前段通过宣称整轮完成。
- 验收与要求变更：仅新回环fixture的trial_call_limit从24修正为48；五字段初次/再次的maintenanceAttempts从10修正为20（5字段×2次×分析/复核2阶段），并新增全部聊天+维护调用等于账本的断言。依据为既定固定两阶段及原失败真实调用；历史官方profile/config的24、每请求12、费用/输入/输出/未知预留规则不变，不重置任何旧账本，不改变业务期望。局部回归和独立审核进行中。

- 组合回环修正 `mvp-native-journal-workflow-budget-fixed.log` 完整退出0：13聊天/原生摘要+20维护=33回环请求，全部settled、预留0；独立审查已核对固定两阶段契约及新旧账本，仅回环新配置调整。后续 `mvp-native-journal-remaining-final.log` 完整退出2：浏览器及默认启动已通过，正式模型启动fixture仍把聊天2+初次/再次维护的4请求误写成4总数；实际为6。旧数组4项→6项（2chat+4prefill），原6上限及全部账本/人工/继承配置断言保持。依据同固定两阶段契约，原失败JSON另存`mvp-native-startup-count-before-fix.json`，受影响启动及剩余检查继续。

### 2026-10-05 正式启动竞争与索引锁序修复

- 启动fixture旧等待确实会把受控textarea中的人工文字当作已保存：固定延迟PATCH响应后，第二次reanalyze带expected_version=3返回409，随后PATCH才返回version=4；负例完整退出1，证据`mvp-native-startup-save-delay-reproduction.log`及`mvp-native-startup-save-race-before-fix.json`。等待改为已退出编辑的`.entry-value`与人工标记；每轮预填须见到高于已接受版本的新成功结果，保留原6调用、账本、人工保护及继承配置断言，固定500ms延迟作为回归条件。没有修改服务端CAS或降低成功标准。
- 同时发现独立真实缺陷：索引Worker的UPDATE/锁定JOIN先锁作业、再等对象；语义保存先锁对象、再插入作业，造成40001和503。完整InnoDB环路保留于`mvp-native-startup-deadlock-diagnostic.txt`，原失败另存`mvp-native-startup-first-prefill-deadlock.json`。领取改为无锁候选、主键对象锁SKIP LOCKED、作业主键锁及锁内当前版本核对；保留64批上限、目标换代、代次、三次耗尽、旧版失效。重建先锁对象，再批量登记作业，不使用反向INSERT SELECT。
- 新`check-index-concurrency.mjs`用真实HTTP、Worker和MySQL锁队列固定对象竞争，无模型调用。旧二进制负例`mvp-index-lock-order-before-fix.log`完整退出1，被锁对象确实阻塞其他索引；旧结果JSON保存，未用新实现输出反写预期。该行为来自非阻塞领取及语义修改要求。新二进制构建完整退出0，当前局部回归进行中；知识工作流已纳入新反例。尚未关闭I2-MVP。

- 新索引固定竞争回归`mvp-index-lock-order-after-fix.log`完整退出0：Worker在对象被锁时仍处理其他对象，唯一对象等待来自前端；HTTP200，2个知识版本/1个新作业，旧版作业失效。代码和正式启动（含固定保存延迟）通过；后续业务回环S/B通过，但P03复核的引用严格拒绝。诊断证明本地provider将Buffer逐chunk直接转字符串，破坏了跨chunk中文UTF-8“供”，引用中出现替换字符；失败另存`mvp-business-prefill-utf8-before-fix.json`。同模式fixture改用Node IncomingMessage原生setEncoding增量解码，字节上限、引用逐字校验和业务预期保持；真实服务已使用完整字节解码，本次未改业务模型或降低引用要求。当前预填回环重跑及千表回归待完成。

- 索引新增积压边界`mvp-index-lock-order-boundaries.log`完整退出0：71条旧作业分多轮全部superseded，版本72仍索引。候选上限在SKIP LOCKED之前；最前64候选都被锁时后续对象需等下一轮，记录为有界领取限制，未声称任意并发下即时推进。
- 千表新轮`mvp-index-lock-order-hybrid-final.log`完整退出2：首次1204表/2408对象索引136.18秒，四种中文top6及末尾名称通过；自动重建后top6失败。失败产物另存`mvp-hybrid-generation-wait-before-fix.json`，不能作为整轮通过。独立源码确认旧等待pending=0不能证明当前collection代次全量完成：对象级分批换代在批次间可留下旧target的indexed作业；正式API本来会明确incomplete。等待强化为vector_state=available且index_state=current，再执行原top6与完整性断言，保留failed=0并保存观察。原失败没保存对应查询coverage，尚不能断言此缺陷是该次失败唯一原因；当前完整重跑仍待结果。

- `mvp-hybrid-generation-wait-after-fix.log`完整退出0，8组全部通过：1204表/2408新对象首次索引132.36秒，恢复、第三次领取崩溃、幂等重建、未知查证、旧版/停用、个人隔离与故障降级均通过。产物实际记录18次pending=0但正式API index_state=incomplete的观察，随后current时原四种中文top6再次通过，支持修正完成前置条件；未放宽原召回标准。21次业务查询中位3726ms，最大8661ms，仍不宣称低延迟或任意业务准确率。
- 当前源码/测试已冻结供真实代表验收；新未用native-session-quality配置启动S01/P01/P04/P05官方轮，使用全新trial/database，不读取独立答案为模型材料，不重置历史账本。机器结果、语义独立审查与完整16题、最终增量收据仍待。官方调用期间不并行MySQL集成或重建共用API/Worker二进制，保留launcher54998。

### 2026-10-05 语句与事务保证边界复验

- native-session-quality代表轮完整退出1，归档`.local/model-workflow/native-session-quality-representative-result.json`（SHA256 `920ee872b2f83149985ae15cec05ebe55e8695675f241dcee3d3758a9a0f8555`）；16次官方调用全部settled、reserved=0。S01/P01/P04机器通过，独立复核发现S01把CHECK拒绝写入升级为整个事务自动回滚，P01初次把refund-only中间SUM=0列为成功目标字段成因。P05再次复核completion=32768、reasoning=30066、finish_reason=length，严格拒绝，未采用截断建议。保留失败账本，不扩大完整16题。
- 为完整复核失败题初次结果，只读导出本轮P05的v3/v4/v5及两个prefill_attempt至`native-session-quality-p05-history.json`，不覆盖正式报告，也不进入业务输入。纯内存原始合成DDL/ETL见证`mvp-statement-abort-transaction-boundary.json`完整通过：原目标15行，新增合法refund-only上游后重建触发CHECK，事务仍活跃、DELETE仍可见为0行；显式rollback后才恢复15行。该见证只证明当前SQLite行为，不替外部执行器承诺错误处理。
- 通用聊天及预填规则现在区分语句失败、事务未提交和全事务回滚；无方言/冲突策略/执行器依据不承诺自动撤销DELETE或恢复旧数据。预填仍保留完整定义、来源、粒度、必要限制和逐字引用，但收敛无依据业务故事、假设成因清单和重复证明；必须区分中间表达式与通过全部目标约束的记录。未改质量预期、业务资料、工具或Pi循环。当前局部编译/回环及新代表待验证。
- 新限定源码复核认可上述规则仍覆盖原要求、没有答案注入或新增Pi循环。`make verify-code`、API/Worker构建及5项预填单测完整退出0；五字段预填回环完整退出0，20次仅回环调用、0官方调用。代表失败的独立记录保留于`docs/reviews/mvp-native-session-quality-representative-20261005.json`，不由回环替代。runner现在在再次预填失败时保留已成功初次/人工版本，补齐失败诊断而不放宽断言。用全新semantic-guarantee配置启动相同四题官方复验，仍待独立结论。
- semantic-guarantee官方代表仍在运行（exec session 50688，日志`mvp-semantic-guarantee-quality-representative.log`）。S01机器通过8调用；只读持久预览`semantic-guarantee-quality-s01-preview.json`的独立复核已发现附加订单状态例子遗漏CASE前提：整单付款大于0不能单独推出paid，还需核对取消与整单全退分支。上一轮事务保证/refund-only/未知概念映射已改善，但该新断言仍须修正；待本轮自然结束并归档、正式文本匹配后记录失败，不能开始全量。执行期间源码继续冻结，不取消模型或并行MySQL集成。
- semantic-guarantee代表已完整退出0，归档`semantic-guarantee-quality-representative-result.json`（SHA256 `648a591b27732ea982b3a07bad201ea4f810a2f333cfe0eab76f0afcca43777a`），20次官方调用全结算、reserved=0；四题机器通过，仍待正式语义复核，S01预览缺陷不由机器抵消。本次只改聊天回答范围与必要CASE前提通用规则，预填代码/知识/标准不变。下一新trial只复验本次影响的S01；P01/P04/P05仍需对本轮正式产物独立通过，然后全新完整16题统一绑定当前输入，不能拼接代表充当AC08完成。
- answer-scope单题新trial完整退出0，归档`answer-scope-quality-representative-result.json`（SHA256 `de665a80c549238e8fa2a0ef7f41a42ddabaa054d28fb204b56366cbcbd1df46`），S01机器通过、4次全部settled/预留0；还未声称语义通过。独立审查同时指出semantic-guarantee P01初次漏了原参考要求的税费/运费边界，引用出现不等于正文已解释。通用预填改为逐项保留原文相关限制及未覆盖事项名称，区分不同层面的未知；不写具体答案或业务字段。API/Worker构建及fmt检查完整退出0。新的declared-boundaries trial复验P01/P04/P05，本次预填变化不影响S01的资源指令；最终完整16题仍一份新当前报告，不拼旧产物关闭AC08。
- 独立正式记录`mvp-semantic-guarantee-quality-representative-20261005.json`保留该四题失败与97条引用/人工保护的核对；`mvp-answer-scope-quality-s01-20261005.json`已通过限定S01语义，4次结算，无整事务自动回滚、refund-only落表或必然paid错误。预填新试验仍活跃（exec session 97983，`declared-boundaries-quality-configuration.json`，日志`mvp-declared-boundaries-quality-representative.log`）；当前源码冻结，等完整结果后独立复核，再全新16题。
- declared-boundaries三题代表已完整退出0，归档`declared-boundaries-quality-representative-result.json`，12次官方调用全settled/预留0，三题机器通过。P01v3/v4/v6只读预览独立发现：税费/运费/折扣边界已补齐，但初次把未模拟场景写成已给出的技术取值/退款约束处理无依据，保持语义待修；再次可通过，正式全报告仍待复核。预填通用规则进一步分清业务适用性未验证和技术处理是否已有规则；完整DDL/SQL已确定的行为不能写为gap。没有新增字段答案、放宽断言或改Pi循环。下一新scope-separation试验复验相同三题，S01已审聊天资源不变，最终仍需当前完整16题及增量收据。

### 2026-10-05 用户要求先对照架构与 Pi 复用审计

- 用户最新要求优先核对AGENTS、架构图、模块契约、API和实际代码，确认有没有做偏及是否充分利用模型/Pi。当前暂停新增实现、提示词和官方试验，原完成MVP目标与要求保留；前面“代表通过再扩大16题”的自动接续暂缓。未停止launcher54998，未提交或推送。
- scope-separation原进程已自然结束、退出1；归档`.local/model-workflow/scope-separation-quality-representative-result.json`，SHA256 `37a9b5ef63c4e7f4b45ac24ef92fc8e03f94ea7aaa2d0e9ede8d6b76ce3ebe88`。P01/P04机器通过，P05初次/人工版本保留、再次为invalid_prefill/invalid_input。12次调用全settled、预留0；未进行本轮新增官方调用，也未把机器通过当成语义通过。
- [对齐审计](reviews/mvp-architecture-alignment-20261005.md)由主审直接核对并汇总两位独立只读审查者结果。确定缺口：ALIGN-01模型正文裁掉分析gaps/evidence；ALIGN-02通用目录预填缺关联文档与上游正文；ALIGN-03整消息否定词错误阻止独立长期偏好保存；ALIGN-04全局指令写死样例单位/UTC；ALIGN-05代表验收未充分覆盖正式多条目预填结构。输入指纹和检查结果为`.local/checks/mvp-architecture-alignment-20261005.json`。
- Pi原生循环、会话树/JSONL、精确leaf恢复、事件、取消和compaction已真实复用。用户Skill通过宿主已选版本校验有设计依据；固定两阶段预填属于有界维护调用，不等于另造Agent。全空间authority使无关知识改版也中断对话，记录为有影响的保守实现限制，不能直接移除资料失效检查。
- 本轮实际静态架构检查退出0，7项检查器反例通过；51组OpenAPI方法/路径均有注册，额外GET /health不属于业务契约。设计文档仍有旧确认路径、单次/两阶段说明及其他操作面漂移。本轮未重新运行HTTP、MySQL、完整MVP或真实平台验收，报告不能关闭增量。
- 下一步优先补资料装配和有效语义回传，再修局部宿主判断、同步契约与图册，使用通用多条目/关联文档/上游/混合意图验收。停止“少数样例失败后持续追加全局提示词”的推进方式。I2-MVP仍active、review pending、evidence null。

### 2026-10-05 按已确认六项纠偏恢复实施

- 用户授权按审计确认的范围修复并完成MVP；本轮仅涉及预填材料、语义回传、记忆范围与全局样例规则、实际上下文依赖、对应回归及现有文档同步。Pi以项目SDK依赖嵌入Node组件，维持现有运行分工。
- 成功行为：普通目录对象预填可用关联文档/必要上游并校验版本；人工值与建议边界清楚；模型能分页读全缺口和依据；多目标消息正确保存独立长期偏好；无关知识更新保留原会话，采用资料失效仍拒绝旧上下文。原十项增量验收和独立审查继续执行。
- MySQL集成及官方试验串行；保留launcher54998；凭据仅经既有获准runner使用，测试只用合成资料，独立答案不进入模型。

### 2026-10-05 六项纠偏实施进度（尚未验收）

- 已接通通用目录的上游和关联业务文档材料；文档继续归M02，`document-<id>`仅作为来源别名，由组合层统一读、检索回源和版本核对。首个模型调用前锁定来源与目标/文档版本，分析和复核采用同一材料；人工值仍保留。独立复核发现文档自身旧版形成自依赖，已排除目标自身正文。
- 目录导入保留每表来源/正式对象/预填待办原子保存。该批采集终止前不领取其预填，领取后首次模型调用前装配并持久冻结补充材料；固定原目标版本不变，避免同批后续页上游未进入分析。中断待办不换原对象版本重发。资料深度/数量/字节受限时保存明确coverage，正文片段标记不完整。
- `read_knowledge`正文保留建议缺口、多来源依据及验证状态，单独分页；人工覆盖时同时返回待复核候选value，明确其缺口归属。收窄全局样例金额/时区提示，不追加逐题口径。
- 新增通用多条目、文档/上游、改版/停用、人工保护及截断回归，尚待执行结果。首次直接全crate单测触发需要显式隔离MySQL的4项锁测试（环境缺少该配置），后续沿用项目harness运行；另1项分页断言因新增空coverage字段失败，已改为有coverage才输出并补候选正文断言。没有将这些失败记成通过。

- 验收与要求变更：`check-authority`原先“未读表就停用表也应使整会话失效”与本次已确认的实际资料依赖范围不符。现在先用受控工具读入目标表，再停用并保留reserve/send拒绝、原预留和恢复不复活的断言；新增未读表停用仍可调用模型的正例。依据AGENTS第7/12条、A05及本轮第4项纠偏，不改变已采用资料的撤回要求。记忆工具同源契约增加`instruction_quote`绑定具体纠错分句，既有隔离/版本/仅本次反例不删，新增同条消息混合意图及原文裁剪/伪造反例。

- 当前局部结果：`mvp-prefill-materials-current.log`8组/9回环通过；`mvp-prefill-sources-current.log`21组/30回环通过，含未知预算、人工并发及两阶段profile。`mvp-authority-consumed-current.log`5组、`mvp-memory-intents-current.log`3组及`mvp-boundaries-current.log`7组通过。均为隔离MySQL+本地回环，不是官方模型质量证据。
- 独立复核追加收口：上游字段专属文档也进入有界关系匹配；元数据不再重复携带完整DDL/ETL，辅助引用目录有独立限额。实际依赖清单保留跨轮并集和旧检查点保守重建；重建后再次混入无依赖标识的旧助手短历史、逗号裁掉记忆限定的反例已发现并修正，扩展回归待重跑。新上下文夹具曾引用不存在的合成表`table-raw_refunds`，造成400；现以既有独立`table-customer_tags`替换，断言范围不变。

- 最新定向证据：原生Pi压缩5次/19回环后保留早期实际读取依赖，撤回后发送前拒绝；图册28图/12模块渲染和依赖检查通过。代码/164契约通过；完整知识工作流在旧并发夹具处失败，未记通过。
- 验收与要求变更：`check-prefill-timeouts`原先在Worker取得目标锁后，测试持有其操作锁并同步等待人工PATCH，造成测试自身循环等待。当前新实现先锁来源和目标至提交，该交错不再可能让人工编辑成功。夹具改在提交的来源锁前挂起，先完成人工改版再恢复；仍断言人工值保留、旧建议superseded、两次用量结算、无空回执及无多余版本。冲突更早在资料核对发现，因此精确error_code从`version_conflict`改为`stale_knowledge`；依据实际锁序与不变量，未放松冲突拒绝。
- 记忆引用边界保留同句相邻否定；允许逗号后明确以“另外/此外”另起的完整指令，终点仍到句末/分号。已增加HTTP正反例与契约必填/禁带/文档别名长度反例，不将这些有界检查称作完整中文意图识别。

- 本轮170组同源契约、代码检查、逗号范围Rust单测及HTTP4组、预填超时/租约/并发7组全部通过，进程完整退出0；新日志`mvp-alignment-code-contracts-updated.log`和`mvp-alignment-boundary-fixes.log`。图册重渲染28图/12模块通过。完整知识工作流仍保留原失败，最终增量收据将重新实际执行。审查发现新增分页单测过滤器会选中0项，已修为真实`semantic_context_tests`，等待最终执行。
- 当前正在跑`run-catalog-semantic-sample.mjs`真实代表：新合成sales_day_channel及raw_sales_events、人民币元与Asia/Shanghai、字段专属业务文档、七条语义及人工覆盖重分析，最后由真实Pi读取解释。独立40次有限trial，旧官方失败全部保留；尚无代表通过结论。

- 通用目录真实代表进程完整退出0：初次/再次各两阶段预填及Pi解释共11次DeepSeek调用，全settled、未知预留0。独立审查确认七条语义和四阶段93条引用与实际材料一致、人工有效值和候选状态分开，核心口径通过；聊天有两处非阻塞表达问题，保留在质量记录，不再逐题追加提示词。产物`.local/model-workflow/catalog-semantic-sample-result.json`，质量记录`reviews/mvp-catalog-semantic-quality-20261005.json`。
- 已启动当前完整16题真实业务验收（日志`mvp-alignment-business-official.log`），使用新的200次有限trial；未并行其他MySQL测试或重建二进制。原失败产物、预算与未知回执保留。整个I2-MVP仍未关闭。

- 完整官方轮在B05失败，已归档`.local/model-workflow/mvp-alignment-complete-memory-boundary-failed.json`（SHA256 `895deeccf85734ca51af695c8d0177d33d0bbf774ce00045814c420d4dd7040e`）。S01–S05/B04机器通过，B05的Pi多次正确选择长期偏好原文，但宿主拒绝逗号前结束的引用；76调用全settled、预留0，后9题未跑，不能记完成。
- 对应最小修复：保留原始引用真实性及合法起点；引用在逗号结束时，宿主将同句余下原文补到句/分号作为source_text，再检查否定/临时限定。只补审计来源，记忆正文和scope继续由Pi决定，不增加“但这次”意图词表。Rust新增本次真实输入的反例在原实现退出101；修复后正反例、HTTP和契约待验证。尾部仅本次/不要保存、前置否定、伪造引用、身份版本与幂等要求保持。

- B05宿主引用边界修复后代码/170契约、Rust精确失败反例及HTTP记忆4组完整退出0，日志`mvp-memory-source-code-contracts.log`和`mvp-memory-source-fixed.log`。前置否定、尾部限制、伪造、幂等与原输入身份仍通过。当前用新有限200次trial再次执行完整16题，旧76次失败证据及账本保留。

- 第二轮官方在取消动作发出前已自行因S03断言失败结束；没有发送取消请求。归档`.local/model-workflow/mvp-memory-source-result-shape-failed.json`，SHA256 `f0580ee907479f92cc82c75c0b14a3bc1a35db15549190fe4f897a5e047feefc`；29调用全settled、预留0。实际返回1600分和16.0元，正确解释同值换算，原验收却要求只能有一列。
- 验收与要求变更：S03原`rows==[["1600"]]`改为独立SQL核算后的全部列/行比较。依据behavior-cases B02/B03未限制列数，以及business-guide明确展示元时除100；独立审查认可。金额列按指标和明确cents/yuan单位逐列核算，保留5种数据变体，新增错误换算、常数、多余列、整数截断和错误取整反例；Q06复用单位比较但保持vip/newsletter客户集合与EXISTS不重复计入的独立预期。未改变题目、1600分期望、旧确认拒绝或产品行为。
- 记忆引用自带尾逗号也补到同句末；带/不带逗号得到同一source_text，仍拒绝补齐后包含临时/否定。`mvp-memory-punctuation-fixed.log`的Rust+HTTP完成退出0。修复审查和验收器收口后才再启动官方试验。

- 记忆范围和S03/Q06金额核算均获独立复核通过。新增6种合法单位输出、20个单位/辅助列反例、3个标签错误反例通过，13参考固定数值和原18反例保持；S03/S05回环22调用通过。代码检查完成后，以新有限trial运行当前完整16题，当前日志`mvp-reviewed-business-official.log`。

- 当前完整轮的11个聊天场景机器检查通过，P01–P03也已通过，后续预填继续运行。只读独立语义预审发现S01将仅有成功refund的中间计算结果误称可落表，与目标CHECK冲突；S04金额题的SQL正确，但最终文字写成“未退金额÷付款金额”。实际工具已完整返回DDL/ETL与业务说明，没有发现材料缺失、截断或错误种子引入这两项结论。预审与工具回执保存在`.local/model-workflow/business-quality-readonly-preview.json`和`business-quality-tool-receipts.json`。本轮尚不能通过语义验收，待自然结束保留全量证据；不追加逐题答案或立即重跑整轮。下一步核对现有冗长重复指令的责任与必要性，保留所有有效接口/业务约束，不新增Agent规划或复核循环。

- 上述完整轮已自然结束、退出0，16题机器全过，137次全settled、预留0；归档`mvp-reviewed-semantic-failed.json`，SHA256 `d575b7837b4c11af5f5dec1c4324ecad5e27b77454acf5cc223cdc13e5a518c1`。归档时源码审计匹配，S01/S04的语义失败保留，不能关闭AC08。独立审查确认旧提示已经写有相关限制，继续追加同义规则没有新增依据。
- 当前最小调整只收敛`apps/agent/session/resources.ts`的聊天指令正文，将重复内容合并为任务、依据、SQL/结果及个人资产规则，具体参数仍由工具Schema和说明承载。3323字符减少为1564字符，资源隔离、宿主上下文、Pi循环、工具及服务端契约未改。原文留`.local/checks/chat-instructions-before-consolidation.ts`。这不证明长度是错误根因或精简必然改善质量；先做代码/回环及独立规则核对，再复验S01/S04，标准和原失败产物保持。

- 精简后`make verify-code`、S01/S04/B05及失败记忆回环58调用、Pi原生压缩17调用/3次压缩/6轮续接完整退出0；原280短历史与压缩后依赖撤回拒绝保持。独立审查已逐条核对有效规则，未发现必须补回的要求，低层参数仍由现有工具定义完整承载。新`concise-instructions-representative-configuration.json`以独立60次有限trial复验S01/S04，日志`mvp-concise-instructions-representative.log`；官方运行期间继续冻结源码、不并行MySQL测试。

- 精简后的S01/S04代表完整退出0，29次全settled、预留0，归档`concise-instructions-representative-result.json`，SHA256 `4dc93f4b1d45c230a2cb57b2d8c2aecf01d33ffa2515f6bdac1aac66a03ae484`。独立语义复核认可S04，但S01把整单全退推成每行paid>0，存在合法两行订单反例，仍未通过。不继续追加同义提示或启动下一完整Flash试验。
- 官方文档当前列出`deepseek-flash`和`deepseek-v4-pro`；用户此前明确指定Flash，因此已以选择题询问是否允许Pro同题对照及后续验收，等待答复。没有调用Pro或修改模型支持范围，原验收标准保持。独立于模型选择，继续运行当前完整知识工作流（`mvp-concise-instructions-knowledge.log`），包括此前未完成的全流程和两项语义分页单测。

- `mvp-concise-instructions-knowledge.log`当前完整退出0：知识/边界/生命周期/取消续接/实际上下文依赖/长对话/个人资产/预填/维护重放/记忆/目录等全流程通过，`semantic_context_tests`实际2项运行并通过。原失败日志保留。其余八项不新增官方请求的工程验收开始串行执行，日志`mvp-concise-instructions-engineering.log`；这不是最终十项增量收据，AC08语义失败与模型选择待定仍阻止关闭MVP。

- 其余八项工程验收已串行完整退出0（exec99416）：170组契约、查询工作流、正式页面和连续历史、运行时/恢复/Pi原生压缩、真实启动路径的回环、完整16题业务回环、目录同步以及1204张表/2408新对象的Milvus组合检索均通过，新增官方请求0。加上单独完成的知识工作流，共9项工程验收通过；最后索引首次构建109.34秒、查询中位3688.82毫秒，只代表本地合成规模。日志`mvp-concise-instructions-engineering.log`、`mvp-concise-instructions-knowledge.log`；代表产物当前源码审计和15项交付检查器自测也通过。
- 增量证据输入已加入上述现有日志、真实产物及独立质量记录，审查指针改为`reviews/mvp-final-increment-20261005.json`，等待独立收尾核对。最终审查必须保留AC08未通过的结论，不创建通过的增量收据。用户的模型选择尚未答复，未调用Pro、未改真实模型配置；整个MVP继续active。

- 独立收尾记录`reviews/mvp-final-increment-20261005.json`已落盘，结论`incomplete`，范围SHA256 `17d3e357a3b1b498f49a34fdf5a6778204aefb886e53fa07dd148dbc3d4fd13e`与当前287份绑定输入匹配。认可9项工程验收，保留S01语义阻塞、模型选择待答和I3外部接入范围；没有当前十项通过收据，CURRENT继续active / review pending / evidence null。没有修改模型配置或调用Pro，没有提交、推送或部署，既有launcher54998保留。

### 2026-10-05 Pro同题对照授权与准备

- 用户允许尝试Pro；先在原Pi SDK、原聊天指令/资料/标准下对照S01/S04，high档与输入/输出容量保持。模型变化限定在宿主ModelProfile、原生SDK选择、预填参数和对应价格；不改变默认.env或旧试验。
- 官方价格页核实Pro高峰缓存未命中输入1.32美元/百万tokens、输出3.96美元/百万tokens；继续按保守高峰价核算，不能冒充服务商账单。新增2026-10-05-pro-peak-usd仅适配Pro，旧Flash价和I0不变；原持久trial不可换模型或价格补额。
- 先验证同源模型/价格匹配、Pi/预填实际请求和账本、原Flash回归，再冻结源码做全新60次有限代表。工程旧收据对新增配置不自动有效；AC08及整个I2继续未完成。

- Pro配置接入的代码检查、178组同源契约、构建和两模型正式启动回环通过，当前日志 `mvp-pro-integration-validation.log`、`mvp-pro-startup-current.log`；Flash/Pro各6调用均全部结算、unknown预留0，保守费用分别624/2258微美元。原模型许可/取消/预算回归在 `mvp-pro-integration-code.log` 通过。独立复核发现并补齐Identity、SessionReceipt及启动器模型标签，保留首轮启动未成功日志，不据未保存的诊断猜测原因。
- 已启动 `.local/model-workflow/pro-representative-configuration.json` 的官方S01/S04代表，日志 `.local/checks/mvp-pro-representative-official.log`。提示正文、合成资料和业务题/标准保持；运行时冻结源码、不并发其他MySQL测试、不重建API/Worker。实际结论待完整退出及独立语义审查；原Flash失败产物及账本保留。

- Pro代表进程完整退出1，产物 `.local/model-workflow/pro-representative-result.json`，SHA256 `989777458e20134edd4d80fd61bb498453dd1cb91bd47fe23be4e54999fe4aeb`。7次官方调用，6次settled、1次unknown；保守已结算113440微美元、未知预留173016保留，不能称作服务商实际扣款。S01机器通过3调用，独立复核发现仍用“只出现在”排除了同订单其他行有付款、当前行无事件但整单paid/refunded的合法组合；S04首次口径澄清正确，订单SQL生成90秒超时，后续金额/空分母分支未完成。
- 与精简指令Flash代表相比，资源提示、所有合成资料与独立SQL核算器指纹相同；8项绑定输入因模型接入改变，不能称为整个源码只改一个model字符串。当前产物源码审计 `.local/checks/mvp-pro-representative-source-audit.log`完整退出0。无新的完整16题试验，不拼接旧轮次关闭AC08；默认.env未改。原launcher54998仍在运行，本轮试验进程已结束。
- 本轮资料/声明检查及15项交付检查器自测完整退出0，日志 `.local/checks/mvp-pro-delivery-record.log`，只证明材料和状态记录有效，不代表业务通过。原最终增量审查的范围指纹已过期；本轮限定接入与语义记录不替代整个I2最终审查。下一步仍须有新证据支持的语义质量修复；不默认扩展超时、追加同义提示、重复付费试验或降低既定验收。

- 独立接入记录 `reviews/mvp-pro-model-integration-20261005.json` 的限定结论为passed_for_reviewed_scope：178项同源契约和两模型启动通过，26项源码与6项证据指纹匹配，真实6次已结算费用独立重算一致；不代表AC08。独立语义记录 `reviews/mvp-pro-representative-quality-20261005.json`保留S01错误及S04超时未完成，默认模型继续Flash，I2保持active / review pending / evidence null。

### 2026-10-05 固定Flash与MVP收尾

- 用户要求继续使用DeepSeek Flash，并完成能够收尾的MVP。模型选择已定；既定验收与已知错误不能仅凭“收尾”指令改为通过。
- 新的有界假设：前轮Flash采用原生high。官方thinking-mode文档与锁定Pi 1.0.0都支持独立的max档，而当前宿主Schema未暴露。只增加Flash的原生max配置并验证实际请求；提示词、工具、资料、业务标准、90秒请求时限和输入/输出容量不变。不新增Agent循环，也不把max预先当作正确性保证。
- 先跑178旧契约与max新正例、代码/构建及正式启动的聊天/预填回环，再用同题S01/S04的新60调用有限trial验证。若仍失败，不继续同配置付费重跑；保留原质量阻塞。原Pro支持保留供历史profile/账本解释，默认与本轮调用均为Flash。

### 2026-10-05 验收与要求变更：按准确率收尾

- 依据：用户最新明确要求停止扩大工作，验证准确率，不再一味追求100%正确。该决定替代前面“单题语义失败即阻止整个MVP关闭”和max档试验计划。
- 原值：AC08脚本要求16题机器及语义全部通过。新值：用固定Flash版本完成原16题测量，逐题保留原判分，独立检查报告完整性，公开通过/失败/未完成和分项比例；语义失败可以作为已知局限交付。缺题、冒称成功、陈旧指纹和缺少独立审查仍不能关闭测量。
- 范围：撤回本轮未使用的max配置/测试；不改提示、知识、工具、Pi循环或产品功能，不换模型，不针对失败题反复刷分。原题目/期望值和工程安全边界均保留。只调整质量报告的交付标准，不修改业务答案。
- 验证：上一max本地构建完整退出0，179契约通过、0官方调用；相关功能已撤回，正在执行冻结版本的代码/178契约/构建。随后一次既定完整样本测量，独立判分和必要工程收据。凭据仅由现有授权runner读取，原trial和未知预留保留。

- 固定Flash/high的本轮16题已完整运行一次，进程退出0，全部机器流程检查通过；142次官方调用全settled，预留0，保守费用1077145微美元。未修改提示/知识/工具或重测失败题。产物 `.local/model-workflow/complete-business-result.json`，SHA256 `39c8835320520b27b73dbe83ec009a64b46a5799b325427a27a1794028e966e1`；独立语义判分中，机器检查不是内容准确率。
- 撤回max后的代码、178契约和构建完整退出0，日志 `.local/checks/mvp-flash-frozen-code.log`。交付声明、15项检查器自测及205项材料检查完整通过，日志 `.local/checks/mvp-accuracy-record-validation.log`。一次直接模块方式运行Python自测因导入路径错误退出1，改用项目既定make目标后通过；无产品代码修复或标准放宽。

- 后续研究顺序：先完成本地MVP收尾并确认没有阻塞使用的工程问题，再研究准确率提升与专业记忆系统选型。当前个人纠错/偏好由本项目的个人资产模块和MySQL保存，Pi承担会话续接与原生上下文管理；尚未引入Mem0、Zep/Graphiti或Letta。后续比较效果、模型/存储费用和维护成本，不将外部记忆系统接入加入本轮MVP。当前只核对依赖，未开始外部选型调研。

- 本轮独立判分完成：12/16（75%），失败S01、B08、P01、P02。所有已核算SQL及独立变体通过；126条预填引用匹配、5字段人工值/标记/来源保护通过。错误分别为0金额的无依据归因、已运行旧查询被说成待确认、初次金额预填漏税费/运费未知、仅退款中间结果被误称可落表。原判分保持，不修补后重测。
- 独立质量记录 `reviews/mvp-business-quality-20261005.json`，SHA256 `f86e5b76558aedd36aae7bef1367cf1a8e0ce05b7a33b67963bd677ad13fac01`；面向使用者的汇总 `reviews/mvp-accuracy-20261005.md`。157份模型试验源码指纹核对一致；完整样例原始SHA和142条已结算回执绑定。接下来仅完成当前质量报告反例和最终工程收据，不追加官方模型试验。

- 最终审查已通过（仅表示可以执行增量验收）：`reviews/mvp-final-increment-20261005.json`，scope `07f2183e53c664c2c4686e6fae1bf93857a044f7574e20ac8b2d97c013a34aa3`，302份输入。质量报告门禁2正例/11拒绝反例完整通过，未新增模型请求。
- 当前正在实际运行 `make verify-increment`（exec session 8146，日志 `.local/checks/mvp-final-increment-execution.log`）。契约、查询、知识、页面四组已依序结束，当前进入MVP运行时回归。增量仍active、evidence null，必须等十条全部完成再写完成状态；源码、验收文件和审查记录保持冻结。原收据另保存在 `.local/checks/mvp-receipt-before-accuracy-measurement.json`。模型真实测量已经结束，不再追加。记忆及准确率研究继续排在MVP收尾之后。

- 十项最终命令全部完整退出0、无超时，但首次统一收据判为failed：唯一变化是最终审查JSON在运行开始后完成最后保存；代码、契约及其余输入均未变化。原因是主代理在审查者发出最终落盘完成消息前启动。失败收据原样归档 `.local/checks/mvp-final-checks-review-write-race.json`；不改判失败、不修改检查器。现已收到审查者完成消息，审查记录固定，按原十项重新执行，日志 `.local/checks/mvp-final-increment-fixed-review.log`。真实模型测量不重跑，仍为12/16。

- 第二次统一验收的AC01、AC02退出0，AC03在45,323ms退出2，未超时，before/after指纹一致；后七项未执行。原样归档`.local/checks/mvp-final-checks-knowledge-failure.json`。失败发生的测试目录没有完整关闭日志，现有收据未保存子命令输出，不能据此断言根因。单独运行`check-knowledge-workflow.mjs`完整退出0，12组通过、0官方调用，日志`.local/checks/mvp-knowledge-failure-diagnosis.log`；正在保留完整输出复核整个AC03，未修改代码或放宽验收。
- AC03单独整组复核完整退出0，日志`.local/checks/mvp-knowledge-acceptance-diagnosis.log`，涵盖知识、权限、长期会话、个人资产、预填、恢复和目录等全部原命令，0官方调用。失败未复现，原次具体原因因缺少子命令日志仍未知；没有宣称修复未知原因。代码、契约和审查记录未变，重新执行原十项最终验收，日志`.local/checks/mvp-final-increment-frozen.log`。

### 2026-10-05 最终验收的检查点排序故障

- 第三次收据中AC01–AC04完整通过，AC05退出2、未超时；前后指纹一致。失败收据保留为`.local/checks/mvp-final-checks-runtime-failure.json`。服务日志定位到第二条消息领取时的`storage_failure HY001`，MySQL错误摘要确认1038 `ER_OUT_OF_SORTMEMORY`；没有将该失败记作成功或单纯归为环境问题。
- 旧查询在一种合法连接顺序下先读取完整检查点再排序。CLI复现`.local/checks/mvp-checkpoint-sort-plan-reproduction.json`与真实SQLx反例`.local/checks/mvp-checkpoint-sort-counterexample.log`均得到1038。数据库原排序缓冲仍为262144字节，未修改MySQL资源配置。另一个执行顺序成功，解释了此前单独复核时未复现。
- 修复限定在M08会话检查点读取：先在带LIMIT的派生表中按lease_epoch选同会话、已完成且确有检查点的恢复链ID，再读取完整JSON。接口、事务、授权、SDK历史和恢复顺序保持。回归包含多个超过512KiB的候选、较新的无检查点/运行中/失败候选、逆向时间和强制检查点优先的执行计划；SQLx及原迁移、续聊、权限、租约、失效拒绝均通过，日志`.local/checks/mvp-checkpoint-sort-repaired.log`。
- 最终检查器原先丢弃子命令输出，导致两次失败需要额外重跑定位。现仅补本地0600日志，收据引用每条命令日志；原退出码、超时、内容指纹和失败关闭规则不变，失败日志也不自动输出到终端。
- 验收与要求变更：goal_revision=12。原AC08要求所有当前源码哈希与测量时完全一致；本次工程修复后保留原16题、142次回执、12/16判分和产物SHA，不追加真实模型请求。新增显式独立差异审查，绑定每个变化文件的原/现哈希与原因；未审查、错哈希、缺文件或过期差异仍拒绝复用。报告明确75%测于排序修复前，不冒称修复后再次实测。提示、资料、工具和四项语义失败保持原状；差异审查及最后完整收据尚待完成。

- 本轮局部验证：SQLx宽检查点回归及原迁移流程完整通过；检查器16项自测完整通过；代码质量/178契约完整通过（`.local/checks/mvp-checkpoint-repair-code.log`）。一次Clippy检查指出测试模块位于文件中部，已将测试模块原样移至末尾再检查通过，没有忽略lint或改变断言。测量输入157文件仅两份发生变化：M08的store与业务证据审计runner；独立差异审查进行中。

- 独立差异审查已最终落盘：`reviews/mvp-checkpoint-repair-20261005.json`，SHA256 `461cbf4fdccb100720423f7555d9d0259a29c82339571cd71eed2678541f342c`，scope `41aa9c446564320f9a47a12e81317325a54b37ccc908ba93829074dd3a1d2f50`，302文件。质量证据2正例/19拒绝反例完整退出0，明确`measuredSourcesMatchCurrent=false`，没有新增官方请求；日志`.local/checks/mvp-checkpoint-source-review-validation.log`。交付16项自测与206项材料检查通过，日志`.local/checks/mvp-checkpoint-record-validation.log`。源码、契约、验收和审查记录冻结后执行最终十项；新收据逐命令保留日志，旧失败收据均保留。

### 2026-10-05 本地MVP完成

- 最终`make verify-increment`完整退出0，十项验收全部成功、无超时，before/after一致；收据`.local/delivery/I2-MVP-result.json`。每条完整日志保存在收据所指的`.local/delivery/I2-MVP-1791186983293820000/`目录。本轮工程验收新增官方调用0。
- 覆盖同源契约、查询确认与版本/隔离、语义/个人资产/长期会话、正式页面、Pi原生恢复和压缩、启动、16题本地协议流程、原真实质量证据与源码差异审查、目录同步以及千表组合检索。修复后的大检查点读取在完整验收中再次通过。
- 1204张合成表、2408个新对象的8组索引检查通过，首次构建100.91秒、查询中位3570ms；包括丢库完整重建、第三次领取中断、回执未知查证、旧版/停用过滤、个人资产隔离与降级。不将本地合成规模外推为真实业务召回率或生产性能。
- Flash质量基线仍为12/16（75%），S01/B08/P01/P02未修；原产物SHA及142个结算回执不变。最后的检查点SQL修复和审计runner差异由独立审查绑定，报告明确未重测修复后版本。第一轮审查写入竞争、第二轮原因未知的AC03、第三轮检查点排序失败均保留历史。
- I2按既定本地范围关闭；I3真实Datasight、正式认证、真实用户试用和生产验证仍未完成。接下来按用户顺序只做记忆系统与准确率改进研究，不安装依赖、不接入新记忆服务、不扩大MVP。

### 2026-10-05 完成记录核对与后续研究

- 完成状态保存后，`make verify-delivery`完整退出0，收据与当前契约及输入一致，16项检查器自测通过；日志`.local/checks/mvp-completion-record-validation.log`。独立审查者另行只读核对当前指纹、冻结review、十条命令与完整日志，确认可以关闭I2；未改写冻结审查，也未重跑模型。
- 已核对官方文档、价格与相关源码，形成[准确率与个人记忆研究](research/memory-and-accuracy-20261005.md)。保留现有MySQL正式记忆和Pi上下文管理，优先验证Mem0 OSS、Hindsight次选；Graphiti/Zep/Letta按能力、部署和职责重叠说明暂缓理由。新版Mem0追加式提取不自动裁决旧纠错失效，版本与范围仍由应用回源检查。
- 研究区分已有基础记忆、候选检索增益与尚未验证的自动提取；比较公开托管价格和自托管总成本，没有声称候选已胜出或已兼容当前Flash/Milvus组合。四个语义失败对应的改进仅为后续试验假设，原判分和MVP验收保持。
- 本次后续阶段仅新增研究文档、同步本记录；未安装或调用记忆系统、未更改MVP源码或冻结审查、未发送项目内容给候选服务、未提交或推送。GitHub公开release查询遇到限流，未据此声称核定最新稳定版本。

### 2026-10-05 Mem0对比交接准备

- goal_revision=13。本轮目标改为准备可交接执行包，用户将由其他coding agent实施。已准备`research/mem0-comparison/`中的说明、源语料、查询、评分答案与SHA256清单；不新建第二份当前计划，不启动新线程或代发任务。
- 对比固定为当前真实词法检索、同模型普通向量检索、Mem0 OSS三组，首轮`infer=False`，只测已整理记忆的检索。包含16组/32题（22正例、10负例），每组3轮，共288次正式检索；模型采用、自动提取与MVP整体准确率不在本轮结论范围。
- 明确向量模型选择仍待确认，推荐已有本地E5但未自行采用。MVP源码/根依赖/原验收保持冻结，后续代码限定`experiments/mem0-comparison/`及忽略的本地运行目录。首次小样不通先定位，不改测量题或反写答案。
- 执行包校验通过：记录与查询唯一性、题目/答案覆盖、快照/版本引用、禁止项与期望不冲突、未核实标记、相对链接及输入指纹。检查仅验证材料一致性，不代表Mem0效果或实验程序通过。未安装依赖、初始化向量模型、创建索引、调用模型、提交或推送。
- 交接材料保存后运行`python3 scripts/check_delivery.py`完整退出0，原I2-MVP收据与当前契约及冻结输入仍一致；未重跑十项验收。


### 2026-10-05 Mem0检索对比完成

- goal_revision=14。用户改为由当前agent执行，随后选择外部embedding服务，提供百炼凭据并授权选择模型。采用官方当前推荐的`qwen3.7-text-embedding`1024维；原执行包中的模型待确认状态已由这次决定替代。凭据和业务空间端点仅在忽略的本地配置中，未读取DeepSeek配置。
- 实现独立`experiments/mem0-comparison/`工具：真实Rust词法调用器、普通Milvus向量检索、锁定Mem0 OSS 2.2.1、统一离线回源检查与独立评分。Python依赖锁与虚拟环境独立；产品源码、契约、根依赖、compose、原架构与MVP验收材料保持原样。
- 开始前检查原MVP收据通过。首次本地Milvus预检被继承的代理配置阻断，未调用embedding；仅实验进程回环地址绕过代理后恢复。独立合成小样通过，11项宿主边界与统计自测通过。随后一次完成32题×3组×3轮=288次正式检索，0错误，输入、参数与源码冻结；未反写答案或重跑失败题。
- 当前词法/普通向量/Mem0的正例Recall@5为0.772727/1/1，MRR@5为0.475/0.977273/0.977273。负例候选噪声均100%；边界与最终元数据违规均0。普通向量与Mem0的96对有效前5排序相同，完整原始前20有82对相同。向量召回相对词法6题改善，首条相关记忆排名1题退步。
- Mem0实际BM25正式调用96次，其中6次非空、9个候选有关键词加分，未改变有效前5。可选英文spaCy未安装，实体能力未验证。旧版本、停用、删除及知识依赖改版由离线宿主状态检查拒绝，不能归因于Mem0自动理解失效。
- API账本259次请求全部settled，12,120输入tokens；按公开标价估算¥0.00606，未知预留0，生成调用/尝试0。两组线上向量非逐位一致；49对存储向量最小余弦0.999998901，本轮排名稳定。峰值Python客户端RSS约149MiB；托管模型与Milvus服务端资源未单独测量。
- 证据目录`.local/mem0-comparison/20261005T090450Z_17d3a6d5/`：run-manifest、288条search-results、result、embedding-calls、sample-result、self-test、execution/scoring日志、analysis、vector-consistency和owned-resources。创建6个本次独立集合、3个SQLite历史库；预登记的3个实体集合未创建，全部保留供复核。未关闭或重建用户服务。
- 未参与实现者独立重算全部指标、账本和元数据，核对真实Mem0/PyMilvus依赖文件及wheel RECORD，并以原Rust调用器重新检查32题；`independent-review.json`状态`passed_with_limits`，findings为空。原result是复核前冻结产物，其pending标记保留生成时状态；当前完成状态以本记录与独立收据为准。
- 结束后`python3 scripts/check_delivery.py`通过，原I2-MVP收据与冻结输入仍一致；未重跑全套MVP。另核对实验源码冻结指纹与新公开材料，均通过。结果见`research/mem0-comparison-results.md`；未提交、推送、部署。
- 建议暂缓Mem0产品接入，个人记忆向量召回及自动整理纠错小样作为后续候选。此次已整理记忆的检索小样不覆盖自动提取、冲突处理、Agent采用、真实权限事务、千表或真实试用，不改写原MVP75%内容质量。


### 2026-10-05 完整 Agent 记忆对比完成

- goal_revision=15。完成原方案与真实 Mem0 接入的固定 11 场景对比，最终内容评分 7/11 与 4/11，SQL 10/14 与 9/14。报告见 `research/mem0-agent-comparison-results.md`；旧检索报告开头已撤回越界接入建议并指向本报告。
- 22 个组合均已尝试，3 条模型消息未完成、1 条未启动保留为失败；没有重抽或补额。恢复只补未开始的组合，原结果、三账本前缀、来源映射和集合连续性独立核实。正式结果和原机器评分 SHA 见本文件当前任务段。
- 未参与实现者最终审查 `independent-agent-review.json` 状态 `review_complete`，SHA256 `6e727604af58a887710a0c125f0bdf760e9f631f4c0199415a80885d825122f9`，独立逐题内容、SQL、331 调用账本、实际故障、真实 Mem0 链路及报告均复核完成。审查发现原产品完整句引用边界错误、实验子串评分假阴性；原产品和原机器回执保持，正确率按原要求显式纠正。
- 结束 `python3 scripts/check_delivery.py` 完整退出 0，原 I2-MVP 收据和 303 份冻结文件一致；143 份最终实验指纹一致。`make verify-materials` 的 214 项静态检查通过，报告相对链接及公开内容检查通过。这些检查不替代真实模型内容评分，也没有重跑全套 MVP。
- 本轮只完成实验、研究文档和当前记录，没有改 MVP 产品、契约、根依赖或原验收；未提交、推送或部署。建议保留现方案，后续优先修保存入口；未追加调用或启动该修复。大记忆池、任意聊天自动提取、整理失败降级、真实千表业务和执行后解读等范围限制保留在结果报告。

### 2026-10-05 原始消息记忆对比修复启动

- 用户授权设计、修复并真实比较成功率，沿用 Flash 与百炼 embedding；本轮按 dev_co 管理，源码/旧CURRENT修改前快照位于忽略目录 `.local/memory-extraction-repair/before/`。
- 修复范围仅个人记忆句尾引用边界与实验；Mem0 在 Rust 正式保存前读取原始消息，提取正文进入正式资产。Pi 仍决定保存/修订/停用、权限/版本/范围由 Rust 校验。
- 验收与要求变更：原 temporary_override 用正文不含 app 判断长期偏好，会误伤“当次明确要求 app 时覆盖”的正常说明；改成 ID/版本/正文/来源不变，并核对本次 app 与之后 web SQL。业务要求没有放宽。
- 原 index_failure 定义为正式保存后的二次提取故障；新接法提取发生在保存前，改为正式保存后的索引提交故障，必须查证实际触发和降级。预提取失败另由接缝回归验证并如实记录真实运行失败；不伪装成保存成功。

### 2026-10-05 修复后小样与正式测量

- 冻结小样 `.local/mem0-agent-comparison/20261005T140914943Z_29ab7709/` 4组合/8消息全部输出，50次Agent调用；机器业务评分原方案1/2、Mem0 2/2，原方案一次仍因引用不完整未保存，失败保留不调题。sourceHashes全量一致，2条Mem0正文与正式资产完全一致，真实向量及关键词检索均收到commit_state=ready。接入核验通过不代表小样全部内容正确。
- 独立审查核对了提取身份隔离、候选排序前过滤、真实回源及两轮并发上下文；活动工具换run恢复不在本实验范围，runner恢复只跳过已开始组合。正式12场景×2组×2轮已启动，固定分母和账本，不修改冻结程序/输入。

### 2026-10-05 验收与要求变更：保存故障触达采集修正

- 原采集器只匹配synthetic_memory_failure原文，但现有服务日志记录脱敏SQLSTATE。save_failure::original::1与save_failure::mem0::2的原bool均为false，实际各有两条storage_failure kind=database code=45000。原result和原机器评分（SHA bee99f38e3a4806a98ac8ee425cb0e333e048356e585bb6b849a624f00ad943b）保持。
- 修复runner日志识别与离线评分；补正输出另存scoring-log-corrected.json并绑定具体日志SHA。故障要求原值/新值均为“实际触发SQLSTATE45000并正确告知、不复用”，没有放宽；只纠正观察器。机器故障场景分数A/B均从3/6补正为4/6，其中A四项为无故障参照，不用作对等可靠性胜负。
- audit命令明确读取独立measurement-source-review.json，只接受这次三文件evidence_only精确前后SHA和原result SHA；其余测量源码保持冻结。审查验证了缺记录、错result/current SHA、错effect、漏文件均拒绝。模型调用不重跑，旧预算与未知预留保持。

### 2026-10-05 记忆修复与原始消息比较交付完成

- 未参与实现者完成48组合内容、预算、三文件证据修正及最终范围审查。`docs/reviews/memory-extraction-comparison-review.json`结论passed，scope SHA c466fb650f3cd4e5e47c5c0985f613d4815bac4c7d85df10f176f698c46ebd1a。
- `make verify-increment`六条命令均完整退出0，执行期间契约/输入/审查指纹不变；收据 `.local/delivery/I2-MEMORY-EXTRACTION-result.json`。包括Rust来源边界、评分、提交隔离、真实测量证据核验、既有知识工作流和代码质量。内容质量按16/18对16/18报告，未将验收命令通过当成100%正确。
- CURRENT将本增量标记complete；旧I2-MVP、旧两轮记忆实验结果和未知预留保持历史原值。本轮完成用户授权的方案、局部修复、真实比较和独立复核；未接Mem0生产、未提交推送或部署。后续提高引用错误反馈和更大真实记忆池验证仅为建议，尚未启动。


## 前一可靠性增量声明（未关闭，2026-10-20）

```json
{
  "id": "I2-AGENT-RELIABILITY",
  "phase": "I2",
  "status": "active",
  "goal": "修复flash-r1证实的执行/恢复、澄清归属、依据忠实性、知识维护/分页及历史多来源报告问题；沿持久正文到再次采用的完整路径修复宿主来源遗漏，保持原失败并独立验证一般性行为。 同批宿主工具复用Pi原生顺序执行，避免共享run来源清单自身冲突。",
  "requirements": [
    "C01",
    "C02",
    "C03",
    "C04",
    "C05",
    "C06",
    "C07",
    "C08"
  ],
  "modules": [
    "M01",
    "M02",
    "M03",
    "M04",
    "M05",
    "M06",
    "M07",
    "M08",
    "M09",
    "M10",
    "M11",
    "M12"
  ],
  "allowed_paths": [
    "apps/agent",
    "apps/web",
    "crates/data-agent",
    "packages/contracts",
    "tests/mvp",
    "tests/contracts",
    "tests/runtime",
    "docs/CURRENT.md",
    "docs/architecture",
    "docs/semantic-retrieval-design.md",
    "docs/reviews",
    "README.md",
    "migrations",
    "apps/worker"
  ],
  "non_goals": [
    "不修改原试用结果、独立答案或放宽断言以换取通过；不引入模型规划器、自然语言执行授权分类器或额外无界模型复核循环。",
    "不提交推送或更新用户常驻服务；不扩充原trial预算、不重做unknown；Pro/向量/真实平台未验证不算产品缺陷或通过。"
  ],
  "invariants": [
    "Pi1.3负责唯一Agent循环、恢复和压缩；每消息24次、连续临时失败3次；所有调用沿原持久预算。",
    "权限、用户真实原话、任务/条件/SQL版本、幂等和未知回执由Rust校验；未答问题不自动同意。",
    "历史来源保留原task/version/条件，报告容器与来源归属分离；同一本人会话可组合，任何来源失效仍整份隐藏。",
    "手工业务域显式维护，不从关联表继承，不因查不到资料扩大用户范围；全部验证资料从零合成。",
    "同一响应可合批发出独立工具；宿主工具按Pi原生sequential执行，不放宽authority快照校验；不同会话及后台查询继续独立。"
  ],
  "verification_inputs": [
    "docs/CURRENT.md",
    "README.md",
    "apps/agent",
    "apps/web/src",
    "crates/data-agent/src",
    "packages/contracts",
    "tests/mvp",
    "tests/contracts",
    "tests/runtime",
    "docs/architecture/implementation-design.md",
    "migrations",
    "apps/worker"
  ],
  "acceptance": [
    {
      "id": "REL-CONTRACT",
      "requirements": [
        "C01",
        "C02",
        "C03",
        "C04",
        "C05",
        "C06",
        "C07",
        "C08"
      ],
      "expected": "同源契约正负例、类型、Rust规则和架构边界通过。",
      "evidence_kind": "contract",
      "command": [
        "make",
        "verify-contracts",
        "verify-code",
        "verify-architecture"
      ],
      "timeout_seconds": 1200
    },
    {
      "id": "REL-CLARIFY",
      "requirements": [
        "C01",
        "C03",
        "C04"
      ],
      "expected": "独立澄清只解决指定ID；多题启动和更新回执明确首题预览不完整，实际Pi经既有分页补齐；已有任务省略goal保留原目标及来源，创建仍必填；等待/失效/版本准确区分，历史条件读取不授执行。",
      "evidence_kind": "runtime",
      "command": [
        "node",
        "tests/mvp/check-clarification.mjs"
      ],
      "timeout_seconds": 900
    },
    {
      "id": "REL-EXECUTE",
      "requirements": [
        "C01",
        "C03",
        "C04"
      ],
      "expected": "未归属消息明确执行单一既有SQL时同事务登记目标和确认；拒绝不残留归属，既有目标限制、其他消息阻塞、多任务、重放、unknown和权限保持；真实Pi收到可操作恢复信息。",
      "evidence_kind": "runtime",
      "command": [
        "node",
        "tests/mvp/check-conversational-query.mjs"
      ],
      "timeout_seconds": 900
    },
    {
      "id": "REL-EVIDENCE",
      "requirements": [
        "C02",
        "C04",
        "C05"
      ],
      "expected": "历史依据绑定原版本/查询/快照，错误来源与越权拒绝。",
      "evidence_kind": "runtime",
      "command": [
        "node",
        "tests/mvp/check-analysis-evidence.mjs"
      ],
      "timeout_seconds": 900
    },
    {
      "id": "REL-REPORT",
      "requirements": [
        "C01",
        "C02",
        "C04",
        "C05"
      ],
      "expected": "跨任务和版本组合报告逐源核验，任一来源失效整份隐藏，旧容器版本拒绝。",
      "evidence_kind": "runtime",
      "command": [
        "node",
        "tests/mvp/check-analysis-reports.mjs"
      ],
      "timeout_seconds": 900
    },
    {
      "id": "REL-REPORT-UI",
      "requirements": [
        "C01",
        "C04",
        "C08"
      ],
      "expected": "报告来源条件和图表对应、刷新/窄屏/迟到回执/撤权保持。",
      "evidence_kind": "runtime",
      "command": [
        "node",
        "tests/mvp/check-analysis-reports-browser.mjs"
      ],
      "timeout_seconds": 900
    },
    {
      "id": "REL-DOMAIN",
      "requirements": [
        "C02",
        "C06",
        "C07"
      ],
      "expected": "手工业务域创建编辑权限、版本、人工保护、显式空域与检索范围闭环。",
      "evidence_kind": "runtime",
      "command": [
        "node",
        "tests/mvp/check-business-domain-authoring.mjs"
      ],
      "timeout_seconds": 900
    },
    {
      "id": "REL-PICKER",
      "requirements": [
        "C02",
        "C06",
        "C08"
      ],
      "expected": "真实后页选择与已选保留、去重、错误重试和迟到回执隔离。",
      "evidence_kind": "runtime",
      "command": [
        "node",
        "tests/mvp/check-knowledge-authoring-browser.mjs"
      ],
      "timeout_seconds": 900
    },
    {
      "id": "REL-FINAL",
      "requirements": [
        "C01",
        "C04"
      ],
      "expected": "正式答复独立完整、过程不成为正式结论；刷新及持久化一致。",
      "evidence_kind": "runtime",
      "command": [
        "node",
        "tests/mvp/check-final-answer.mjs"
      ],
      "timeout_seconds": 900
    },
    {
      "id": "REL-PROVIDER",
      "requirements": [
        "C01",
        "C03",
        "C04"
      ],
      "expected": "受控provider真实收到工具事实和恢复提示；预算和持久会话行为保持。",
      "evidence_kind": "runtime",
      "command": [
        "node",
        "tests/mvp/check-data-provider.mjs"
      ],
      "timeout_seconds": 900
    },
    {
      "id": "REL-COMPACT",
      "requirements": [
        "C01",
        "C02",
        "C03",
        "C04",
        "C05"
      ],
      "expected": "Pi原生轮内压缩/恢复、64KiB压力与原24次限制保持。",
      "evidence_kind": "runtime",
      "command": [
        "node",
        "tests/mvp/check-native-compaction.mjs"
      ],
      "timeout_seconds": 900
    },
    {
      "id": "REL-TEXT-AUTHORITY",
      "requirements": [
        "C01",
        "C02",
        "C03"
      ],
      "expected": "当前/历史条件、未答问题与目标正文按真实来源绑定，撤权不经读/启动/目录/成功回执再泄露；合法新目标保持可见。",
      "evidence_kind": "runtime",
      "command": [
        "node",
        "tests/mvp/check-task-text-authority.mjs"
      ],
      "timeout_seconds": 900
    },
    {
      "id": "REL-TOOL-SCHEMA",
      "requirements": [
        "C03",
        "C04"
      ],
      "expected": "模型实际工具schema保留业务title字段，与同源正负例一致，不只检查源schema。",
      "evidence_kind": "runtime",
      "command": [
        "node",
        "tests/mvp/check-tool-schema.mjs"
      ],
      "timeout_seconds": 900
    },
    {
      "id": "REL-CONTEXT",
      "requirements": [
        "C01",
        "C02",
        "C03",
        "C04"
      ],
      "expected": "嵌套查询回执撤下过时启动状态，真实状态与完整恢复数据进入模型，稳定前缀与载荷预检保留。",
      "evidence_kind": "runtime",
      "command": [
        "node",
        "tests/mvp/check-request-context.mjs"
      ],
      "timeout_seconds": 900
    },
    {
      "id": "REL-SEMANTIC-CHOICE",
      "requirements": [
        "C03",
        "C04"
      ],
      "expected": "声明未决口径拒绝保存且旧稿不失效；真实原话、明确口径、旧参数兼容与幂等边界。",
      "evidence_kind": "runtime",
      "command": [
        "node",
        "tests/mvp/check-query-semantics.mjs"
      ],
      "timeout_seconds": 900
    },
    {
      "id": "REL-READING",
      "requirements": [
        "C01",
        "C08"
      ],
      "expected": "历史阅读时异步报告保存保持锚点/焦点/草稿，底部跟随和延迟报告读取返回保持。",
      "evidence_kind": "runtime",
      "command": [
        "node",
        "tests/mvp/check-report-reading-position-browser.mjs"
      ],
      "timeout_seconds": 900
    },
    {
      "id": "REL-RECOVERY",
      "requirements": [
        "C01",
        "C03",
        "C04"
      ],
      "expected": "原Pi会话半轮恢复、unknown身份、取消混合任务和原预算保持。",
      "evidence_kind": "runtime",
      "command": [
        "node",
        "tests/mvp/check-recovery-continuation.mjs"
      ],
      "timeout_seconds": 900
    },
    {
      "id": "REL-ROLE-SYNC",
      "requirements": [
        "C02",
        "C06",
        "C07"
      ],
      "expected": "真实来源版本推进及原同版本冲突负例保持；角色、目录和负责人规则一致。",
      "evidence_kind": "runtime",
      "command": [
        "node",
        "tests/mvp/check-semantic-role-boundaries.mjs",
        "--case",
        "sync"
      ],
      "timeout_seconds": 900
    },
    {
      "id": "REL-ROLE-MEMBERS",
      "requirements": [
        "C02",
        "C06",
        "C07"
      ],
      "expected": "真实来源版本推进及原同版本冲突负例保持；角色、目录和负责人规则一致。",
      "evidence_kind": "runtime",
      "command": [
        "node",
        "tests/mvp/check-semantic-role-boundaries.mjs",
        "--case",
        "members"
      ],
      "timeout_seconds": 900
    },
    {
      "id": "REL-ROLE-DIRECTORY",
      "requirements": [
        "C02",
        "C06",
        "C07"
      ],
      "expected": "真实来源版本推进及原同版本冲突负例保持；角色、目录和负责人规则一致。",
      "evidence_kind": "runtime",
      "command": [
        "node",
        "tests/mvp/check-semantic-role-boundaries.mjs",
        "--case",
        "directory"
      ],
      "timeout_seconds": 900
    },
    {
      "id": "REL-HOST-SOURCES",
      "requirements": [
        "C01",
        "C04",
        "C05"
      ],
      "expected": "宿主完整记录实际来源；清引用、同文、无关改写与连续重建不洗来源，合法字段改写和真人原话保留。",
      "evidence_kind": "runtime",
      "command": [
        "node",
        "tests/mvp/check-task-host-authority.mjs"
      ],
      "timeout_seconds": 900
    },
    {
      "id": "REL-QUERY-SOURCE-UI",
      "requirements": [
        "C01",
        "C04",
        "C05",
        "C08"
      ],
      "expected": "查询来源失效隐藏SQL/参数/已载结果，旧结果迟到不复活；停止与刷新状态继续可用。",
      "evidence_kind": "runtime",
      "command": [
        "node",
        "tests/mvp/check-query-source-browser.mjs"
      ],
      "timeout_seconds": 900
    },
    {
      "id": "REL-QUERY-SOURCES",
      "requirements": [
        "C01",
        "C03",
        "C04",
        "C05"
      ],
      "expected": "查询正文完整来源覆盖读/列表/重放/首次提交；失效拒绝前不发送SQL或失效旧稿，unknown查证和取消保持。",
      "evidence_kind": "runtime",
      "command": [
        "node",
        "tests/mvp/check-query-text-authority.mjs"
      ],
      "timeout_seconds": 900
    },
    {
      "id": "REL-REPORT-SOURCES",
      "requirements": [
        "C01",
        "C02",
        "C04",
        "C05"
      ],
      "expected": "证据正文/报告标题按宿主完整来源保存；原条件、query来源闭包和真正人工重写共同核验。",
      "evidence_kind": "runtime",
      "command": [
        "node",
        "tests/mvp/check-report-text-authority.mjs"
      ],
      "timeout_seconds": 900
    },
    {
      "id": "REL-ASSET-SOURCES",
      "requirements": [
        "C02",
        "C03",
        "C05"
      ],
      "expected": "生成记忆及资产保留完整字段来源；跨会话、旧NULL、同文/局部修改不洗来源，手工合法编辑可恢复。",
      "evidence_kind": "runtime",
      "command": [
        "node",
        "tests/mvp/check-asset-text-authority.mjs"
      ],
      "timeout_seconds": 900
    },
    {
      "id": "REL-SKILL-SOURCES",
      "requirements": [
        "C02",
        "C03",
        "C05"
      ],
      "expected": "Skill草稿确认、选用、读取和公开副本保留完整来源；来源失效与原私密权限继续生效。",
      "evidence_kind": "runtime",
      "command": [
        "node",
        "tests/mvp/check-skill-text-authority.mjs"
      ],
      "timeout_seconds": 900
    },
    {
      "id": "REL-ASSET-SOURCE-UI",
      "requirements": [
        "C05",
        "C08"
      ],
      "expected": "来源失效资产仍可管理；空表单明确重写，完整新正文恢复且刷新/窄屏不带回旧来源。",
      "evidence_kind": "runtime",
      "command": [
        "node",
        "tests/mvp/check-asset-source-browser.mjs"
      ],
      "timeout_seconds": 900
    },
    {
      "id": "REL-ASSET-DEPENDENCY-UI",
      "requirements": [
        "C05",
        "C08"
      ],
      "expected": "人工资产仍能核对更新或明确移除失效依赖，权限/旧选择及取消编辑行为保持。",
      "evidence_kind": "runtime",
      "command": [
        "node",
        "tests/mvp/check-asset-dependencies-browser.mjs"
      ],
      "timeout_seconds": 900
    },
    {
      "id": "REL-MEMORY-CLEANUP",
      "requirements": [
        "C03",
        "C05"
      ],
      "expected": "有来源正文才可发送索引；停用/删除沿原作业身份发送无正文清除，临时失败重试不新增embedding且不换副作用身份。",
      "evidence_kind": "runtime",
      "command": [
        "node",
        "tests/mvp/check-memory-source-cleanup.mjs"
      ],
      "timeout_seconds": 900
    },
    {
      "id": "REL-TASK-RESULT-SOURCES",
      "requirements": [
        "C01",
        "C03",
        "C04",
        "C05"
      ],
      "expected": "真实查询结果唤醒派生目标和条件保留结果出处；跨轮/重建/平台未知与撤权不返旧正文，不以系统输入豁免来源。",
      "evidence_kind": "runtime",
      "command": [
        "node",
        "tests/mvp/check-task-result-authority.mjs"
      ],
      "timeout_seconds": 900
    },
    {
      "id": "REL-TOOL-SERIALIZATION",
      "requirements": [
        "C03",
        "C04",
        "C05"
      ],
      "expected": "真实Pi customTools按模型批内顺序完成结果/统计及混合读写工具，不产生自身stale_context、不重复副作用；原生取消阻止后续工具进入。受控边界接缝与真实Rust验证分别记录。",
      "evidence_kind": "runtime",
      "command": [
        "node",
        "tests/runtime/check-tool-serialization.mjs"
      ],
      "timeout_seconds": 120
    },
    {
      "id": "REL-RESULT-READING",
      "requirements": [
        "C03",
        "C04",
        "C05"
      ],
      "expected": "实际Rust结果与统计读取正确登记原run依赖，跨用户读取仍拒绝，已读结果过期仍拒绝模型预留，不重跑平台查询。",
      "evidence_kind": "runtime",
      "command": [
        "node",
        "tests/mvp/check-query-result-reading.mjs"
      ],
      "timeout_seconds": 900
    }
  ],
  "review": {
    "status": "pending",
    "record": "docs/reviews/dogfood-reliability-review.json"
  },
  "evidence": null
}
```
