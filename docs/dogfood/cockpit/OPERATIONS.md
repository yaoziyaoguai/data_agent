# 操作与证据

## 使用环境

先核对当前 `docs/CURRENT.md` 和本地交接中的运行目录、端口、实际模型、身份与快照。不要根据旧试用URL或本包猜服务端口。身份文件、访问令牌与私有配置只在已授权本地使用，报告不要展示密钥。

普通UI和分析场景使用已交接的当前工作台。工程故障、撤权、基线表维护、模型停用、重预填等场景使用独立运行目录、应用库和平台账本；不在用户日常工作台做这类变更。模型管理只新建本轮本地协议项，不改现有收费连接。

已有启动器支持 `--runtime-dir`、`--port-offset`、`--model`、`--model-profile`。先读 `python3 scripts/development.py --help` 和[开发说明](../../development.md)。无模型费用的隔离基线可用：

```sh
python3 scripts/development.py --model mock --tool-contract-version 2 --public-content-retention latest_only --memory builtin --retrieval lexical --runtime-dir .local/dogfood-runs/voice-isolated/runtime --port-offset 10000
```

先确认端口空闲与该目录尚未被其他进程占用，再运行。此命令使用固定模拟模型，适合工程/UI前置，不可替代真实模型场景。真实模型用已批准配置及原持久预算，不能复制trial、重置数据库或换ID获得额外额度。每个收费通道分别核原期限与剩余；正常消息无默认累计调用/费用/整轮时限，显式测试帽仍生效。维护输入的公开编码计量与托管API模板映射分别核证；后者未获充分依据时，启动参数显式加`--prefill disabled`，关闭预填/整理而保留聊天profile和原账本，不用mock补成真实通过。当前真实配置若无法隔离所需故障，将该分支记为blocked_environment，而不是破坏日常数据。

`G08`的权限文件位于该隔离平台运行目录中，使用平台已有的 `denied_query_users` 机制；先保存本轮文件原内容，完成后恢复。只撤回本轮试用身份，不操作其他环境。`T13`需证明服务已接受但响应丢失；只断网后重发一条新消息不能验证幂等。`X10`只停止并重启自己创建的隔离进程，记录PID、配置与中断位置。固定协议/模型替身跑过的故障场景必须标成engineering/model_mock。

交互修复版中，查询卡保留首次持久事件位置，状态变化只更新卡内内容；活动提示区分处理请求、生成回答和解读原查询结果。v2数值说明先准备绑定，再流式显示同一份正文，刷新读回正式正文。验证流式过程须保存provider结束前的DOM采样和增长，不能用定稿截图代替；原`check-answer-streaming-browser.mjs`为本包唯一整体浏览器流程。当前通过范围、真实模型失败和日常入口是否更新以CURRENT为准；隔离harness证据不表示已部署到试用服务。

## 独立参考

参考由业务规范独立写出，不复制模型生成SQL或产品结果。`reference/oracle_queries.py`是SQL真源，`reference/queries/`是展开后的可读SQL。`expected-results.json`冻结列、完整行数、所有行摘要和至多200行的完整结果；更大结果只含前20行供人工阅读，不能把这20行当总体。

```sh
python3 docs/dogfood/cockpit/verify.py
python3 docs/dogfood/cockpit/reference/check_reference.py
```

校验在临时SQLite上加载DDL、seed与ETL，并实际调用平台 `compile/submit/lookup/results`，逐页比对平台保存前1000行及截断标志。不会连官方模型，也不会更改常驻平台库。ASR、首音、标签、动作与反馈的核心量另由逐行Python计算，避免仅靠两份相似SQL互证。

资料真正变化后，维护者先复核业务定义、独立SQL与数据验证，再明确运行 `build.py --freeze-reference`；普通试用Agent不能更新预期。文档或场景变更后用 `build.py`更新导航和模板，`build.py --check`检查是否过期。不能为了让失败变绿重新冻结答案。

## 记录

把 `records/results-template.json` 复制到本轮忽略目录。记录实际commit及资料指纹，模型、思考档、Pi版本、检索/记忆模式、授权来源、会话与对象版本。每个attempt保存实际输入、答复、最终SQL/参数、工具轨迹、截图或下载及判定理由。所有证据路径相对于该次results.json所在目录。

每个逐条断言使用与案例相同的状态枚举，`pass`必须有可定位证据；案例全部断言与必要步骤通过才可标pass。模板中的空证据仅允许not_run。失败后重试保留原attempt。数值对比可把实际结果另存为 `{"columns":[...],"rows":[...]}`；使用 `grade.py --reference-key KEY --actual FILE`核对同列同顺序结果，列名不同先作明确可审计映射。

原100项继续使用 `results.json`，默认严格检查原100个ID和冻结断言。十条综合轨迹另存 `trajectory-results.json`，显式传 `--trajectories` 后只读取[轨迹清单](../../execution/semantic-runtime/integrated-trajectories.json)的 `cases`，按其ID数量、顺序一致的 `expect` 和 `mode` 复用同一记录校验。初始记录每条为 `case_id=id`、`status=not_run`、`attempts=[]`，每条断言为 `{expected,status:not_run,reason:'',evidence:[]}`；不得覆盖已有结果。两份记录分别报告分母。

`--require-pass CASE_ID ...`在原完整记录、冻结断言、attempt及证据检查后，要求指定ID存在且总状态为pass；默认命令仍允许合法not_run，不能传只有核心行的缩减记录。09固定选择与两条实际命令绑定在CURRENT，不能按当前成绩挑选ID。记录检查不能自动判语义或证明某个pass确由真实attempt支持，仍需对应证据与独审；核心前提未满足时不运行已知必失败的完成检查。

轨迹的 `mode=model` 沿用真实模型要求，仅有 `model_mock` attempt 不能标pass；`mode=engineering` 可以保留本地工程证据。工程轨迹里的真实端点子断言仍须由操作者核对对应真实证据，证据不足按清单记 `partial`、`inconclusive` 或相应blocked状态。当前清单的 `expect` 是字符串，没有机器可读的真实子断言标记；校验器检查记录和证据文件存在，不从文字或文件名推断真实调用、语义正确性或端点能力。

```sh
python3 docs/dogfood/cockpit/grade.py .local/dogfood-runs/<run_id>/results.json
python3 docs/dogfood/cockpit/grade.py --trajectories .local/dogfood-runs/<run_id>/trajectory-results.json
python3 docs/dogfood/cockpit/grade.py --reference-key turns_september --actual .local/dogfood-runs/<run_id>/actual.json
```

持续执行的当前进度只更新`docs/CURRENT.md`，原attempt和证据保留已发送/尚未发送消息、已执行/在途/未知动作及依赖产物，不另维护平行HANDOFF。中断不等于失败或取消，未知操作先查原身份，不盲目重发。试用结束后清理本轮对象清单，不删除账本和问题证据。
