# 操作与证据

## 使用环境

先核对当前 `docs/CURRENT.md` 和本地交接中的运行目录、端口、实际模型、身份与快照。不要根据旧试用URL或本包猜服务端口。身份文件、访问令牌与私有配置只在已授权本地使用，报告不要展示密钥。

普通UI和分析场景使用已交接的当前工作台。工程故障、撤权、基线表维护、模型停用、重预填等场景使用独立运行目录、应用库和平台账本；不在用户日常工作台做这类变更。模型管理只新建本轮本地协议项，不改现有收费连接。

已有启动器支持 `--runtime-dir`、`--port-offset`、`--model`、`--model-profile`。先读 `python3 scripts/development.py --help` 和[开发说明](../../development.md)。无模型费用的隔离基线可用：

```sh
python3 scripts/development.py --model mock --runtime-dir .local/dogfood-runs/voice-isolated/runtime --port-offset 10000
```

先确认端口空闲与该目录尚未被其他进程占用，再运行。此命令使用固定模拟模型，适合工程/UI前置，不可替代真实模型场景。真实模型用已批准配置及原持久预算，不能复制trial、重置数据库或换ID获得额外额度。当前真实配置若无法隔离所需故障，将该分支记为blocked_environment，而不是破坏日常数据。

`G08`的权限文件位于该隔离平台运行目录中，使用平台已有的 `denied_query_users` 机制；先保存本轮文件原内容，完成后恢复。只撤回本轮试用身份，不操作其他环境。`T13`需证明服务已接受但响应丢失；只断网后重发一条新消息不能验证幂等。`X10`只停止并重启自己创建的隔离进程，记录PID、配置与中断位置。固定协议/模型替身跑过的故障场景必须标成engineering/model_mock。

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

```sh
python3 docs/dogfood/cockpit/grade.py .local/dogfood-runs/<run_id>/results.json
python3 docs/dogfood/cockpit/grade.py --reference-key turns_september --actual .local/dogfood-runs/<run_id>/actual.json
```

每一批结束写HANDOFF，保留已发送/尚未发送消息、已执行/在途/未知动作、依赖产物和下一案例。中断不等于失败或取消，未知操作先查原身份，不盲目重发。试用结束后清理本轮对象清单，不删除账本和问题证据。
