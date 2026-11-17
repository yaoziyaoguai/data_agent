# 语义交付修复包：本地复审与 Oracle 交叉核对

日期：2026-11-01。对象是 [剩余缺口执行包](../execution/semantic-runtime/delivery-repairs.md)，不是产品修复报告。当前目标与实施状态仅在 [CURRENT](../CURRENT.md)。本轮只编辑文档、准备脱敏审计材料和咨询 Oracle；09 不变。

## 本地审计与前轮证据

前轮 `I2-SEMANTIC-CLOSURE-REPAIRS` 的 31 条验收映射为 30 条去重命令，于 2026-11-01 北京时间 19:48:14 全部 exit 0。复审实跑 `make verify-delivery`，当时收据匹配输入。前轮 passed 不是伪造，但测试未覆盖下面的组合路径；它不代表这些问题已修。

分支 `codex/semantic-maintenance-prototype`，HEAD `04d27d06ba7b97d4cf3e288d4cf9e6300ef491a9`。原独立审查范围指纹 `7607161f3a0c9f783f966b5623d8da62088beae893bafab9ae9a0e1f872a28bd` 保留历史身份，不用作本包实现审查。本次审计反例采用已有构建产物、隔离合成库和本地协议端点；官方请求为 0。

| 缺口 | 已观察事实 | 根因/证据等级 | 执行包 |
| --- | --- | --- | --- |
| 1 P1 控制文字来源 | 正式停用来源后，普通 data 已隐藏文字，control_delivery 仍含标记且 finish 200 | `task_answers` 原始 goal/question 投影、重放和组合未核自身字段 authority；真实 Rust HTTP/MySQL | 第4节 |
| 2 P1 待执行工具恢复 | 第一 SQL 成功、第二仅登记；真实 Worker 恢复后 Node 直接 finish 409，第二仍 registered/execution_started=0 | `deliver.ts` 快路只排除新建任务，漏普通 pending 工具；实际恢复/Node/Rust | 第5节 |
| 3 P1 历史结果组合 | B 已定稿，Q/A-v1 的答案工具成功，route A-v2 后组合 finish version_conflict | notification_matches 后仍调 current-version scope；实际 Pi/本地模型协议/MySQL | 第6节 |
| 4 P1 支持末页状态 | 三个短支持分三回执，各只有1条，状态partial/partial/delivered | 忽略同窗先前已交的短成员，把cursor耗尽当本回执全交；正式API/Rust回执 | 第8节 |
| 5 P2 新操作复用旧事实 | 同任务同版本成功保存两条SQL，第二控制仍仅第一query_id和“1条” | 恢复投影只比task/version集合，新操作误走原事实复用；真实Rust/MySQL | 第4节 |
| 6 P1 压缩后草稿 | SDK投影为compactionSummary＋assistant时hook返回undefined，草稿仍可见 | 以最后user作为唯一本轮边界；真实SDK＋产品hook，尚非完整provider E2E | 第7节 |
| 7 P2 正文选择不一致 | 成功答案为“已核验结果为99”，hook替换成旧等待提示 | hook只看control，commitAnswer优先grounded；真实SDK/hook合成成功回执，需正式链补验 | 第7节 |
| 8 P1 Pi深翻页未闭环 | 正式深链脚本因Pi tool_response_capacity改走内部直工具 | 后端游标证据有效，Pi同题未通过；容量根因未确认，不能直接归因双编码 | 第9节 |

本机证据目录 `.local/audits/semantic-closure-current-20261101/`：`REPORT.md`、`control-authority.json`、`control-recovery.json`、`late-query.json`、`probes.json`、`context.json` 及各 `probe-*.mjs`。忽略目录不保证随 Git 交接，因此执行包写明公开接口重建步骤，不要求其他机器有这些文件。

已有成果保留：R02 容量与下游扩列、R03–R05 同修订重整/档案/profile、R06/R08/R09 资产与来源、R12–R14 实际覆盖事实。没有证据要求推倒架构或新造 Agent 服务。本文不是穷尽全部潜在缺陷的声明。

## 文档归因勘误

前轮 CURRENT 切片5⑦及第四次独立增量审查将第三轮 UPGRADE-FROZEN 归为“组内命令全部完成、退出挂起、环境瞬时性”。原日志 `.local/delivery/I2-SEMANTIC-CLOSURE-REPAIRS-1793519936483898000/command-02.log` 仅有 prefill-timeouts 七模式中的前四个，无后三个和 suite 最终通过。正确范围是“第4模式收尾/第5初始化或后续阶段无输出，原因未定位；后续同题重跑通过”。不改写原审查者文件，在 CURRENT 与此处追加勘误，后续通过不证明当时具体环境原因。

“所有第二页必因 schema 双编码失败”也超出证据；同 131072 配置的其他 Pi 分页检查已有成功。执行包要求同题与成功样本对照真实序列化载荷，先归因再改。

## 编包方法和本地检查

采用已安装 `dev_co` 的按任务展开/持续交接约定；`tdd` 只为每个可观察缺口安排最小反例与有意义回归；`contract-first` 明确 Rust/Pi 提供者、消费者和缺省/null语义，不新增合同框架。本轮不实施产品、不跑产品全电池。

用户新增要求已经纳入：禁止以微小理论风险添加防护、重复校验、无意义 helper/catch；限制重复/低价值测试和无依据的整套重跑。六个实施切片覆盖八项问题，共享入口由一人顺序整合；冻结后才做独立实现审查，不自动开评审面板。

新验收初始 `command:null` 不是漏项：它表示正式脚本尚未加入新断言，实施者补齐后绑定。现有受影响回归有真实命令；原30条电池不整套复制。编包静态检查与实现收据分别报告。

## Oracle 审包与本地处置

本轮咨询已完成，exit 0。会话 `semantic-delivery-repairs-20261101` 于2026-11-01运行，上传前后两次核实 `Power, item 5 of 5 (slider ARIA)`；已取得新会话提交及完整答复，未启用外部并行代理。只发送执行包草稿、本地合成证据摘要和关键代码摘录三份附件，未发送凭据、真实业务数据、浏览器资料或私密日志。

- 送审执行包 SHA256：`2ad6642a3287e0254c5af7781e79eaddb95b622ea6b4d787fe133f4d9916df17`。
- 完整答复 SHA256：`7ac0c2dd3d64079b0180cedb45f42579a8be0909fb4f1c06e622a9edb0dd1bdf`。
- 本地证据目录：`.local/audits/semantic-delivery-package-20261101/`，含 `oracle-input-manifest.json`、冻结输入、`oracle-run.log`、`oracle-answer.md`、`oracle-submission.json`、`oracle-cleanup.json`。
- 已核本次准确 Chrome PID 45608 不存活、临时 profile 不存在；没有关闭持久登录源或其他浏览器。

**Oracle结论：“需小改”——八项入口和六切片足够集中，补四处明确化后可以交接，不要求扩大架构或新增测试体系。** 以下是建议落地后的本地回源核对；最终修订没有再次送Oracle，不能称其直接批准最终稿，也不能把本次审包算实现独立审查。

| 意见 | 回源事实 | 处置 |
| --- | --- | --- |
| C1 控制投影被抑制时三值含义不够明确 | `workspace-context.ts::acceptReceipt` 对error直接返回，对成功仅在字段不为undefined时更新；省略不会撤旧候选 | 采纳。包第3/4节要求成功抑制显式null；拒绝路径不当成功继续用旧候选，不把所有失败改成更新control。并入同一个authority用例，不加测试体系 |
| C2 只修历史版本比较仍可能残留整轮来源/新标题依赖 | `generated_text_authority_in_tx`确实读runtime run authority，`merge_run_in_tx`向其合并；compose随后合当前goal authority和标题；`analysis_answers::check_in_tx`已有按query sources验证入口 | 采纳并补本地事实。包第6节明确历史末项不套current scope/run并集，沿原答案来源/用途；无历史goal时用中性原条件结果标题，不加历史快照表。普通当前答案原检查保留 |
| C3 settle与恢复快路需要共同的结束资格/投影选择 | 锁定SDK的边界草稿支持context_edit/custom_message且会刷新投影；canContinue由上下文形状/队列推导，实际继续由result.continue或队列决定；deliver快路确在extension创建之前，commitAnswer还会检查needsResultAnswer | 采纳。包第5/7节点名两个出口、原未完成义务和本轮条目身份；不强制额外模型调用、不建常驻会话服务；小SDK反例与正式Pi后续/恢复分别证明不同层级 |
| C4 容量诊断需先定位失败边界，源码注释仍过度归因 | capacity工具分配、request-size预检和实际provider wire是不同边界；旧深链测试注释写了任何第二页必失败，当前证据不足以支持 | 采纳。包第9/10节要求标首错组件，实际字节/token估算/合成usage分开；只有真正发送才有wire。后续实施纠正测试注释，当前编包不改测试，不预定容量修法 |

Oracle没有从材料中发现需要新增的防护或重复测试体系，也没有足够全文证据建议删除某个现存基线测试。本地采纳其边界：八个验收ID不等于八个新脚本；真实SDK反例与正式Pi链、后端分页与Pi分页各有不同职责，复用夹具而非删必要证据。没有把外部意见扩成额外治理任务。

剩余技术落点由实施者在本包中解决：压缩后原条目定位、现有支持窗口信息如何传至最终装配、深链首错与余量原因。这些是有界工程问题，不重新询问已确认的R02/R07/D1/D2。若深链实测确需改变产品容量行为，按包内规则带测量报告决定，不私自调大。

## 本轮验证

- `make verify-materials verify-delivery`：exit 0，493项材料静态检查、16项交付检查器测试通过；声明明确“业务未验证；未运行任何验收命令”。日志与退出码在 `.local/audits/semantic-delivery-package-20261101/material-validation-final.log` 和对应 result JSON。
- 本轮7份文档的224个相对链接有效，`git diff --check` exit 0；相对开工manifest只有这7份文档变化，没有产品/正式测试改动、没有新增公共私人路径或密钥模式。结果在同目录 `scope-and-links-final-result.json`。
- 09 SHA256仍为 `ebcdc8798f6d63dcad8c399d95822a0db1e8103b44bcce9c305b9c9541c01e74`，原文未改，任务未执行。
- 新增量保持planned，八条新增验收command为null，13条直接受影响基线已有命令；实现审查pending、实现证据null。它们是下一实施者的绑定与验证任务，不能拿本次文档检查或Oracle审包关闭。
- 本轮没有实施产品修复、运行产品全电池、付费模型/embedding、提交推送或部署/更新日常服务。Oracle为用户明确要求的独立审包咨询。
