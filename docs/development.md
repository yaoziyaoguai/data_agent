# 本地开发环境

当前合成平台 MVP 已完成。验证环境为 macOS ARM64：Node / Rust / Python 在本机运行，MySQL / Milvus 在专用 Colima 实例运行。正式工作台使用 React、Rust API/Worker 与 Pi SDK；真实模型模式已接入 DeepSeek Flash 和 Mem0 个人记忆。当前状态和证据见 [CURRENT](CURRENT.md)，运行职责见[架构说明](architecture/README.md)。真实数据平台、正式认证和同事使用验收属于后续接入。

## 1. 固定的运行时与依赖

| 部分 | 固定版本与依据 |
| --- | --- |
| Node / npm | 26.8.1 / 11.19.0；`.node-version`、`package.json`，安装时检查 engines |
| React / React DOM | 19.3.0；通过静态渲染与 Vite 构建检查 |
| Vite | 8.3.2；依赖烟测生成临时 React 项目，输出在 `.local/` |
| Pi SDK | `@earendil-works/pi-coding-agent` 1.0.0；npm 依赖，不依赖相邻源码目录 |
| Playwright | 1.63.0；使用对应 Chromium，避免依赖会自行升级的日常 Chrome |
| Rust | 1.99.0，minimal 工具链加 rustfmt / Clippy；见 `rust-toolchain.toml` |
| Rust HTTP / 异步 / MySQL | Axum 0.8.9、Tokio 1.53.1、SQLx 0.9.0；依赖检查工具见 `tools/check-rust/` |
| Rust HTTP 客户端 / JSON | reqwest 0.13.5、serde 1.0.229、serde_json 1.0.151 |
| MySQL | 8.4.11 LTS，ARM64 镜像按 tag 与 digest 锁定 |
| Milvus | 3.0.2 standalone，配套 etcd 3.5.25 与 MinIO 官方组合，均使用 ARM64 镜像 |

Node 依赖由 `package-lock.json` 锁定，`make setup-node` 显式使用 `npm ci --engine-strict`；Rust 依赖由 `Cargo.lock` 锁定。升级时修改声明并重新生成对应锁文件，重跑相关检查；不能只改文档中的版本。

镜像来源、架构和摘要见 [infra/images.lock.json](../infra/images.lock.json)，实际执行配置是 [compose.yaml](../compose.yaml)。npm 安装脚本采用项目级允许列表：仅批准当前 esbuild 安装脚本；无需运行的安装脚本明确禁用，升级后重新核对。

Pi通过显式资源加载器与内存凭据/模型存储运行，不发现本机工具、扩展、Skill或私人配置。Pi运行本地模拟或显式选择的DeepSeek provider；两者分别记录证据。运行目录固定为合成目录，不把本机路径加进模型提示词。

## 2. 安装和运行

以下命令均在项目根目录执行。首次需要网络下载安装包和镜像；检查只使用合成资料，不需要模型密钥。

### 本机工具

需要固定版本的 Node / npm、Python 3.10+、Make、Rust，以及 Colima、Docker CLI 和 Docker Compose。已核对的本机版本是 Colima 0.10.1、Docker CLI 29.3.1、独立 `docker-compose` 5.3.1。独立 Compose 命令可用时，不要求额外安装 `docker compose` 插件。

若当前终端找到旧版 Node，先调整当前终端的 PATH 或使用支持 `.node-version` 的版本管理器。Apple Silicon Homebrew 的 Node 通常位于 `/opt/homebrew/bin`。检查脚本会拒绝错误的 Node 版本，不能把另一个版本的通过当作固定版本的证据。

Rust 通过[官方 rustup](https://rustup.rs/)安装；本机准备采用 `--no-modify-path`，没有改写 shell 启动文件。Make 默认使用 `$(HOME)/.cargo/bin/cargo`；其他安装位置可设置 `CARGO=cargo`。

```sh
node --version
npm --version
make setup-node setup-rust
make infra-up
```

`setup-node` 使用 `npm ci` 并安装锁定的 Chromium；`setup-rust` 按锁文件获取 crate，rustup 读取工具链文件准备相应组件。Colima 使用项目专用 `data-agent` profile，4 CPU、6 GiB 内存、30 GiB 数据磁盘容量上限；磁盘是虚拟盘容量，并非立即占满。只读共享 `infra/` 和 `.local/infra/`，不共享整个用户目录。

启动命令不切换全局 Docker context；后续操作始终指向 `colima-data-agent`。数据使用专用命名卷，服务只对本机回环地址开放。这里的本地环境不是对外部署或正式身份验证方案。

| 连接 | 地址 |
| --- | --- |
| MySQL，库/应用用户均为 `data_agent` | `127.0.0.1:13306` |
| Milvus REST / gRPC | `127.0.0.1:19531` |
| Milvus 健康检查 | `http://127.0.0.1:19091/healthz` |

MySQL 容器限制1GB，表缓存400/400、临时表内存64MB；配置由Compose实际应用，不能仅用临时SET后声称重启仍生效。etcd 和 MinIO 仅在专用容器网络中访问。端口冲突时启动失败并报告，不接管其他项目已占用的端口。

### 检查

```sh
make verify
make verify-browser
make verify-infra
```

| 命令 | 验证范围 |
| --- | --- |
| `make verify` | 准备材料、合成 SQLite 参考、React/Vite/Pi 基础导入、Rust 格式与 Clippy、临时本地 HTTP JSON 往返 |
| `make verify-browser` | 在随机本地端口启动原型，用锁定 Chromium 运行既有 151 项断言；检查后关闭服务和隔离浏览器 |
| `make verify-infra` | 真实本地 MySQL / Milvus 检查，以及 Rust SQLx 的参数绑定与临时表读写；需要专用容器已启动 |
| `make infra-status` | 查看专用栈的当前状态 |
| `make prototype` | 在本机 8765 端口展示既有原型；端口已占用时沿用已有原型服务或先处理占用 |

Node 构建及浏览器环境证据写入 `.local/checks/`；浏览器原报告和截图按原脚本写入 `prototype/.checks/`。dev_co 检查证据写入 `.project-workflow/`。本地生成日志不默认纳入 Git。

### 停止

```sh
make infra-down
make vm-stop
```

前者关闭专用服务并保留数据卷；后者停止该项目虚拟机，释放内存。再次 `make infra-up` 恢复环境。不提供自动删除数据卷的快捷命令；需要清空时先确认目标和数据范围。

## 3. 本地配置与凭据

环境脚本只为新建的项目环境生成本地开发密码，保存在忽略目录 `.local/infra/`，文件权限为 0600。已有文件不覆盖；它们通过只读 secret 文件交给相应服务。不能将该目录上传 GitHub。

模型配置模板仍在 `.env.example`，当前检查不读取用户的 `.env`、旧密钥或本机 Pi 凭据。真正调用模型前，需要明确实际端点、模型标识、材料范围和调用预算。依赖已安装不等于可以无限调用模型。

## 4. 正式工作台与增量检查

`make dev` 构建Rust和React，并启动API（8780）、Pi Bridge（8781）、Worker及Vite（5173）。全部仅监听回环地址；端口已占用时失败，不关闭其他进程。用`.local/development/identities.json`中的alice或bob值登录，文件由启动器生成并设为0600。已有身份文件保留；Ctrl+C仅关闭当前应用进程，MySQL会话数据保留。`make verify-startup`验证同一启动器后自行停止。

| 命令 | 当前验证行为 |
| --- | --- |
| `make verify-code` | Rust fmt/Clippy、TypeScript类型检查、正式React构建 |
| `make verify-contracts` | 同源产物一致、Rust/JS正反例与序列化往返 |
| `make verify-runtime-flow` | 真实页面提交、Pi受控工具、持久结果、身份隔离、刷新、双Worker串行和失败终态 |
| `make verify-recovery` | 三个真实进程退出点、新run/原operation恢复、一份副作用、旧代次拒绝 |
| `make verify-architecture` | 导入/SQL归属及故意反例、真实MySQL当前读取/事务快照/锁序/并发 |

测试只创建和删除自己随机命名的临时数据库，使用本项目新生成的开发密码；日志与截图在忽略的`.local/checks/`。本地模拟provider调用也向Rust预留/结算调用预算，每个模拟输入最多12次模型调用，跨恢复run保留；实际交付最多4次，会话忙等待不计入次数。生产认证与真实 Datasight 仍需接入验证；真实模型验收遵守单独的持久试验额度。

### 完整业务验证

- `make verify-query-workflow`：SQL只读检查、条件/草稿版本、确认、结果与取消查证。
- `make verify-knowledge-workflow`：人工保护、来源版本、长文与链接、个人资产隔离、失效上下文、任务撤回和取消。
- `make verify-mvp-browser`：正式页面、历史、草稿、SQL/结果/图表/CSV，桌面和手机。
- `make verify-mvp-regression`：代码、原协议/恢复/锁边界、Pi会话与原生压缩、完整工具协议。

MySQL集成测试串行运行。查询跟踪、索引和语义预填在同一Worker中的独立异步任务运行；同一Pi会话仍串行。检索融合精确名称、关键词与Milvus候选，所有命中回源核对权限、当前版本、状态与来源。向量不可用时返回明确降级；候选限额和索引积压均标明覆盖不足。常用表可优先分析表及字段，普通表首次只做基础导入并可检索，深入分析按需发起；来源改版仍自动重分析全部受影响对象。配置版本独立于知识版本。预填固定分析和依据复核各一次，只有两轮引用/格式和当前版本全部通过才应用，人工值保留。回环协议与真实模型质量分别验收。

`make setup-rust`除锁定运行库外，还按`infra/embedding-model.json`准备`intfloat/multilingual-e5-small`的固定revision和SHA-256，384维、均值池化、512 token；运行时只读取`.local/embedding-model`并再次核验，不自动下载新权重。文本以`query:`或`passage:`输入；版本化片段使用360字符窗口及280字符步长，每对象最多128片段，超限明确报告。Milvus本地端口19531，凭据只通过忽略文件提供。

启动器默认启用组合检索；可显式运行`python3 scripts/development.py --retrieval lexical`。更换collection或模型后，旧索引完成状态失效。维护者页面“重建检索索引”及`POST /knowledge-index/rebuilds`使用operation_id幂等排队，从当前MySQL重建索引；正式知识版本不变。回执未知先查已存在的不可变片段，每个作业最多3次；第3次领取后进程中断会明确失败，仍可经该入口重建。

`make verify-hybrid-retrieval`在独立数据库和临时Milvus collection中导入1204张合成表，验证中文检索、精确名称、实际写入回执丢失、旧版过滤、个人资产隔离、服务降级，以及保留MySQL后的索引重建。实际结果统一见CURRENT，测试规模本身不构成通过证据。

目录分页必须保持namespace、snapshot_id及authoritative一致；仅完整权威目录允许停用缺席对象。采集起点固定来源头与范围代次，完成即使内容未变也推进范围代次，晚到旧快照不能执行删除。15分钟后中断的采集明确失败，原operation不换基线自动重试，新同步重新读取。聊天模型单调用90秒；语义维护每阶段模型调用300秒、领取360秒，分析与复核各一次；Worker整轮按原请求调用上限推导期限并持续续租。

预填把同源`PrefillResult`作为原生`submit_semantic_prefill`工具的参数Schema，只列待分析的语义条目。思考模式使用auto工具选择，off指定唯一提交工具；服务只接受一次完整同名工具参数，按当前来源继续验证后才保存建议。工具只提交建议，不执行业务副作用。服务端要求完整覆盖，拒绝空结果、漏条目和来源事实条目。没有业务资料时可以留空说明，但必须记录明确缺口及已查材料引用。`verify-knowledge-workflow`同时运行这些纯Rust反例与实际Worker拒绝/人工保护流程。

工作台解释与预填都区分程序约束、业务文档约定、样例未覆盖和未知。描述某个值可能存在时，模型需核对完整加工及目标表全部约束；描述某组合不能保存时，需有实际排除该组合的谓词，并检查合法反例。预填第二次调用着重挑战草稿的推断及前后矛盾。这些是模型分析要求，程序对引用与结构的校验仍不能证明业务推断正确；真实模型验收须另做独立语义复核。

官方参数允许较大的completion上限；项目数据profile保留1024/2048/4096/8192/16384/32768几个有限档，预留与结算使用同一档，截断一律拒绝。32768用于实际复核在16384截断后的有限扩容，思考与正文共用completion额度。历史I0任务小样仍限定1024。具体质量与延迟由真实样本验证，不由输出容量保证。

数据profile的请求体上限可配置至128KiB。真实中文调查中，Pi原生压缩须保留最近一组工具回执，这组原文、系统工具定义和摘要合计可能超过旧64KiB；128KiB给这组原文留出空间，之后仍由Pi原生压缩历史。旧64KiB配置继续执行自己的上限，超128KiB仍在预留与发送前拒绝。字节门槛不等于token硬上限，每次返回usage仍按原profile核验；历史I0的2048字节与4096输入约定保持。

范围、最新结果和仍未完成的证据统一记录在 [CURRENT.md](CURRENT.md)，不在本文件另建任务状态表。

## 5. 每个增量怎样防止偏离要求

1. 先读 CURRENT 的 `delivery.increment`，对照系统设计第21节的需求编号与模块契约。状态为 `planned` 表示尚未实现；本轮需求是该增量要覆盖的部分，不意味着整个MVP已完成。
2. 开始实际编码时将状态改为 `active`。按已有验收预期实现对应测试，在 `acceptance.command` 绑定真实 argv；把相应代码、契约、测试、锁文件列入 `verification_inputs`。命令为空就保留未验证，不以材料检查替代。
3. 独立审查者核对原要求、代码、测试预期、范围变化和已有运行结果。`review.record` 引用 JSON 记录，字段为 `reviewer`、`conclusion: "passed"`、`scope_sha256`、`summary`；摘要来自检查器 `review_scope(root, delivery)`，绑定所审契约、输入、已确认决定和检查器，排除审查文件自身避免循环。重新改代码、测试或要求后须重新审查；仅重跑测试不能沿用旧审查。重要验收改动按 AGENTS 的规则在 CURRENT 说明原因和依据。
4. `make verify-delivery` 核对36项要求没有遗漏、当前增量可追溯，并运行检查器自身的反例测试。该命令通过只说明记录和检查机制有效。
5. `make verify-increment` 才进行增量关闭检查：先核对真实输入、命令与审查记录，再实际运行绑定的验收；命令失败、超时或运行中输入变化均拒绝。外部调用仍受原授权与费用上限约束，不因为填写命令就获得授权。
6. 通过后将返回的 `.local/delivery/` 证据路径写入 CURRENT 的 `delivery.increment.evidence`，才可把本增量置 `complete`；再次运行普通检查会核对证据与当前输入是否一致。证据不代表尚未覆盖的要求、真实模型或平台已经通过。

`allowed_paths` 供分工和审查使用，不是系统写入权限。当前脚本与记录由同一工作区持有者可编辑，不能防止恶意篡改，也不能自动证明一段测试的断言足够；预期是否符合用户原意由需求对照和独立审查负责。没有安装会话Hook或CI保护，不能称为已经自动拦截所有coding agent。

## 6. 真实模型小样与取消

I0-02仅验证受控任务工具和模型协议，不生成或执行数据平台SQL。工作台的模型标签取自服务端；“停止生成”只停止指定run，保留已保存任务，不代替后续任务/查询取消操作。

- `.env`保存在本机，权限0600，Git忽略。I0小样密钥只传给Node/Pi进程。完整语义预填另由Worker进行受预算约束的单次维护调用；密钥仅交给承担模型调用的进程，API和前端不接收密钥。
- 历史I0小样固定官方`https://api.deepseek.com`、`deepseek-flash`、思考关闭、全部合成材料；完整业务profile另支持原生off/low/high。思考tokens与正式输出共享配置上限和持久用量。
- 原试验最多6次请求，每次输出最多1024 tokens，总预算US$0.05。每次按4096输入和官方高峰未命中价格预留，未知用量保留金额与次数；API重启、run恢复和新会话均不能给试验补额。
- API不提供输入硬截断；用户批准请求体最多2048 UTF-8字节、短文本及一个工具，并逐次核对actual usage。输入超4096或输出超1024会保存真实用量、熔断试验；不把预估称为服务端硬限制。
- 发送许可只领取一次、禁止SDK隐式重试与HTTP重定向。可靠usage先幂等结算再放行模型完成事件；丢失结算回执只重送固定payload。
- 取消先原子保存run、输入、job终态，再通知Pi中止HTTP；晚到业务写拒绝，原模型调用仍可结算，其他会话继续。

```sh
make verify-model-provider
# 已批准小样的首次执行，会付费；拒绝重做已分配过请求的试验。
node tests/runtime/run-deepseek-trial.mjs --run
# 审计保存的官方证据与MySQL，不增加模型请求。
make verify-model-trial
```

小样配置、原试验数据库和结果在忽略的`.local/model-trial/`；保留用于重启和审计，不能删除/改ID来绕过授权。普通`make dev`继续使用本地模拟；显式`python3 scripts/development.py --model deepseek`沿用小样的原数据库和额度，试验到期/耗尽后拒绝新的模型请求。不要把密钥复制到命令参数或报告。

协议测试使用真实Pi SDK与本地MySQL，只将模型端点替换为回环协议服务。它覆盖真实连接取消、错误、缺用量、预算竞争和结算丢回执；官方小样另有证据，两者不能互相替代。

官方依据：[Chat Completions参数](https://api-docs.deepseek.com/api/create-chat-completion)、[定价](https://api-docs.deepseek.com/quick_start/pricing)、[用量与离线分词说明](https://api-docs.deepseek.com/quick_start/token_usage)。历史I0及当前profile的价格版本固定为2026-10-04高峰USD；实际用量以返回usage为准。

### 完整多工具模型验收

`node tests/mvp/run-deepseek-workflow.mjs --check`以回环OpenAI协议和真实Pi/Rust/MySQL检验“调查→SQL→条件补丁修订→按钮确认→查询→解释”和P01–P05原始来源预填/人工保护的共用账本，不会读取.env或访问官方端点。正式`--run`沿用CURRENT记录的有效授权；超出材料或端点授权范围时需新的决定。配置、原数据库和报告持续保存在忽略的`.local/model-workflow/`，拒绝重置已经分配过的额度。新试验配置与旧I0小样完全独立，不挪用/恢复到期额度；授权状态见CURRENT。

Agent读取长文、来源、记忆、Skill和历史采用有界分页，正文页带完整性与下一位置，后续页绑定原版本；管理页面仍可完整编辑。启动候选上下文上限16KB，长期会话找回任务通过历史中的task_id与当前任务读取工具完成。

### 正式模型启动与业务验收

```sh
# 在有效模型授权范围内启动；重启沿用原配置、数据库和剩余额度。
python3 scripts/development.py --model deepseek --model-profile .local/model-workflow/configuration.json
```

本机已有工作台时，启动验收会选用独立端口和`.local/checks`运行目录。也可以显式传`--port-offset 18000 --runtime-dir .local/checks/my-startup`，保留现有工作台、身份及平台账本。

持久试验配置的 `profile.model_id` 决定本次模型；`.env` 的 `DEEPSEEK_MODEL` 保留默认选择。Flash 配对 `2026-10-04-peak-usd`，Pro 配对 `2026-10-05-pro-peak-usd`；Flash 支持 off/low/high；Pro 的现有试验配置限 off/high。本地MVP沿用用户选定的Flash。价格依据[官方价格页](https://api-docs.deepseek.com/quick_start/pricing)，以高峰未命中价保守计账。更换模型须新建有授权的有限试验，不能重用旧 trial 改额。

启动器只从0600的`.env`读取三个`DEEPSEEK_*`配置字段，并清除继承的预填配置。聊天与语义预填使用同一profile、端点和持久trial账本；Worker与Pi Bridge分别收到调用所需密钥，API和前端不接收。旧预填环境变量不会把维护调用记到另一份预算。`--model protocol-test --model-profile <本地配置> --model-url http://127.0.0.1:<端口>`仅用于隔离回环验收，不读取`.env`。

`make verify-startup`同时检查默认启动和正式模型路径的回环接线、页面预填与人工保护；不调用官方模型。MySQL集成目标须串行运行，测试期间不得重建它们使用的共享API/Worker二进制。

```sh
make verify-business-acceptance
# 用获准配置运行指定业务题；不会创建新trial或补额。
node tests/mvp/run-business-acceptance.mjs --run --model-profile .local/model-workflow/configuration.json --cases S02,S04,S05
# 只核对保存的业务证据与公开输入哈希，0新增模型请求。
node tests/mvp/run-business-acceptance.mjs --audit
```

业务入口记录S01–S05、B01–B08及B05保存失败变体的适用流程，并用独立SQLite数据核算Q02/Q04/Q05/Q06/Q10。同一入口还可运行P01–P05的初次/再次预填和人工保护，聊天与维护共用原trial账本。回环演示模型只有固定策略，证明宿主工具与流程可用；真实模型的解释、引用和缺口仍须独立审查。达到请求、费用或时间上限时保留已使用账本和未完成题目，不能自动重跑或以模拟输出补齐。Q01–Q13参考SQL及18种错误SQL另由独立验收器核对；不声称已验证全部题的模型生成质量。

订单退款率先确定期间付款的订单集合，再检查集合订单截至快照的全部行退款；不能将分子再限为期内付款行。独立预期使用集合交集，数据变体覆盖同单不同行分月付款和集合外退款。业务语义SQL仅由合成知识允许列表生成；验收参考及数据变体不进入模型输入。

`make verify-official-business`只读取已保存的完整16题Flash/high官方产物与逐题独立判分，检查输入指纹、可靠用量、无未知预留及统计一致性，0新增模型调用。按当前MVP决定，语义质量以原标准报告通过数和失败数，不要求100%；`measurement_complete`仅表示测量完整。两项正例（包括诚实保留语义失败）和11项拒绝反例验证报告规则；缺题、未审、统计不符或过期产物仍不能完成测量。权限、SQL确认和用户隔离等基础工程验收保持。

通用目录的真实代表使用 `node tests/mvp/run-catalog-semantic-sample.mjs --run <获准的独立配置>`：从零构造两张表、关联业务文档和上游字段文档，验证七个语义条目、人工修改后的再次预填及 Pi 实际读取。运行保留模型产物、来源版本和全部调用回执；语义结论仍由独立审查给出，该代表不替代完整16题或千表检索验证。

### 时间、历史和语义目录

宿主环境变量`DATA_AGENT_BUSINESS_TIMEZONE`目前支持`UTC`（默认）和`Asia/Shanghai`。每条消息接收时固定UTC参考时刻和业务时区；重传、跨日恢复、查询结果唤醒均沿用原值。相对日期仍由Pi模型展开，宿主提供可信输入而不猜测用户时间意图。

历史会话按首问题标题搜索、每页100条；对话事件用`before_seq`补旧页、`after_seq`增量读取，已加载历史持续保留。公共语义目录按ID每页100对象，后台刷新保持已推进游标并直读当前对象和展开的相关对象。搜索候选达到工作量上限时返回`search_coverage.state=candidate_limit`，页面和模型明确提示缩小范围；不透露被权限过滤的数量。当前支持本地Embedding/Milvus组合检索与受限合成千表验证；更广跨业务质量和真实目录仍属I3，实际证据统一见CURRENT。


### Pi 原生会话文件

Agent 会话由 Pi 原生 JSONL 保存在项目 `.local/pi-sessions`（目录0700、文件0600，不入Git）。MySQL 检查点保存精确叶子和小文件引用，完整原始历史及 Pi 摘要仍在原生日志内。启动和备份须同时保留数据库及该目录；不能把目录当作可清理的构建缓存。文件缺失、损坏或引用不匹配会明确失败，不新建会话冒充恢复成功。

旧内联检查点通过当前运行绑定的只读 `/internal/checkpoints/read` 迁移；该接口不接受用户指定的链或文件。初次物化保留原 SDK 会话及条目 ID，恢复仍沿原操作/预算。验证由 `check:bridge` 的40轮/10次原生压缩和 `verify-mvp-regression` 的正式MySQL/API大检查点迁移、状态及授权反例覆盖。

## 7. Mem0个人记忆

正式DeepSeek启动默认启用Mem0；`make dev`仍为无付费的本地模拟模式。Mem0负责原始消息提取和个人记忆检索，Pi继续是唯一Agent循环。Python依赖单独锁定在`apps/memory/requirements.lock`，避免把实验环境作为运行依赖。安装需要可用的 `uv`；`make setup-memory` 使用独立 Python 3.12 环境。

```sh
make setup-memory
# 按 apps/memory/config.example.json 准备忽略的 .local/memory/configuration.json。
# embedding_key_file 指向权限0600的本地密钥文件；不要写入源码或命令行。
python3 scripts/development.py --model deepseek \
  --model-profile .local/model-workflow/configuration.json \
  --memory-configuration .local/memory/configuration.json
```

模型profile必须是已准备的试用数据库和有限持久预算；沿用第6节的实际授权，不因换启动目录补额。新profile必须明确数据库、trial_id、调用/费用上限。提取至少需要4096输出容量，个人记忆所有模型调用都计入原请求或维护profile。端口默认8791，`--port-offset`同时偏移全部服务。启动顺序为平台→API→Mem0→Pi→Worker→Web；启动失败应查本次运行目录日志，不能把侧车缺失冒充成功。

| 数据 | 位置与责任 |
| --- | --- |
| 正式记忆正文、来源、范围、状态与版本 | MySQL，M09唯一写入入口 |
| 索引待办与原预算 | MySQL `personal_memory_index_jobs`；与正式资产同事务 |
| 向量 | Mem0 OSS 2.2.1的Milvus集合；qwen3.7-text-embedding，1024维 |
| 幂等提取、候选提交、调用技术回执及SDK历史 | `.local/memory/state/<database>/<collection>/`内的SQLite文件 |
| 模型次数、预留、实际usage和费用 | MySQL M08原账本；侧车SQLite不代替预算 |

启动器把配置中的collection前缀加上数据库摘要；不同试用数据库隔离，同库同集合重启复用状态目录。禁止两个侧车同时使用同一目录。共享知识E5/384维检索与个人记忆1024维索引分别配置，不互相替换。本轮不安装可选spaCy实体模型；SDK可能提示未安装，中文记忆提取与向量检索仍由LLM/embedding完成，不据此宣称实体图谱可用。

**已有资产与重建：**启动Worker后，每批最多32条当前启用且目标索引缺失的正式记忆自动排队，人工正文使用`infer=False`。页面显示索引待处理/完成/失败。索引丢失或需要重建时，停止本次应用、在本地配置使用新的collection前缀，再以同一数据库和有剩余额度的原profile启动；新集合及新技术回执由MySQL正文重建。旧资产版本、旧队列、旧账本保留。不要删除旧预算、改已使用trial_id或把未知作业清成未调用来“重试”；预算耗尽时另行明确维护额度。停用/删除立即禁止采用，异步清理不等于物理抹除全部历史。

**失败与重放：**完整原始消息先通过引用和权限检查，再交Mem0。候选只有MySQL成功保存后才可检索。首次HTTP提取回执丢失仅按同operation接回一次；未知模型请求不自动重发，包含SDK内部batch fallback。索引失败可按相同任务恢复，旧版本不能覆盖新状态。检索服务暂不可用时返回`directory_fallback`，仍可读正式目录；提取失败不能宣称记忆已保存。

**预算估算：**Flash按冻结高峰未命中价格；百炼标价¥0.5/百万token，M08按US$0.10/百万token保守预留，price_version=`2026-10-05-qwen-cny-usd-ceiling`。报告同时保留用途及usage；估算不代表账单或实时汇率。每次LLM和embedding分别计数，成功usage先结算，内容验证失败不退掉真实费用。

```sh
make verify-memory       # 真实Rust/MySQL/Worker + 受控网络替身；不付费
make verify-contracts    # 包括WorkspaceContext的记忆检索状态
```

公开HTTP仍是`/assets`和已有启停删除接口，增加可选`memory_index_state`。新内部`/internal/memory/model-calls`及侧车`/extract`、`/index`、`/search`均使用同源Schema和内部token，详见[个人资产模块契约](architecture/knowledge-modules.md#正式mem0接缝同源契约)。服务凭据只给承担调用的进程；API、页面、公开报告不接收密钥。上述命令的替身通过只证明工程边界，真实模型试用和内容评分须另列证据。
