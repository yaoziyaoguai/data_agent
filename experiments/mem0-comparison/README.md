# 个人记忆检索实验

执行边界、冻结语料与独立答案见 [执行包](../../docs/research/mem0-comparison/README.md)。本目录只提供比较工具，不接入产品。

## 实际配置

- Mem0 OSS `mem0ai==2.2.1`；`pymilvus==2.5.18`，实际连接现有 Milvus 3.0.2。
- Python 3.12 独立环境；全部传递依赖与下载哈希固定在 `requirements.lock`。
- 用户选择外部服务，并授权选择模型。本轮使用百炼北京地域的 `qwen3.7-text-embedding`，1024维，`encoding_format=float`，客户端做L2归一化。服务不公开底层权重/分词器修订，不能声称锁定了权重快照。
- 不加查询/正文前缀或任务指令，不缓存查询向量。正文仅由名称、正文、范围组成；查询仅使用原始 `text`。
- Mem0 `infer=False`，关闭遥测、生成模型、重排。它的 `search`、Milvus适配、关键词混合排序与历史写入使用实际库；模型工厂接缝用于接入同一个真实embedding适配与明确失败的生成适配。
- 不安装可选的英文spaCy模型。实体增强与词形还原降级须在结果里记录；Milvus BM25是否实际可用由回执判断。
- 两组对宿主都返回最多20条候选，统一回源检查后最多5条。Mem0内部按原算法过取80条，观察并保存内部结果；不把内部池改成普通向量查询。
- 每组4次预热，32题各跑3轮。0为Mem0允许的最低阈值；不根据正式题调参数。负例出现候选属于检索噪声。
- embedding请求上限400次、按标价最多预留¥1；未知回执保留费用预留，不由SDK自动重试。实际账单可能受免费额度等影响，报告只给usage与标价估算。

## 命令

先在忽略的 `.local/mem0-comparison/<run-id>/` 建独立环境和配置。`embedding-config.json` 包含端点、模型、维度、凭据文件路径、Milvus配置及上述限制；Key只保存在权限为600的本地文件，配置和凭据都不进入Git。端点使用用户导出的业务空间OpenAI兼容地址。

```sh
uv venv --python 3.12 .local/mem0-comparison/<run-id>/venv
uv pip sync --python .local/mem0-comparison/<run-id>/venv/bin/python --require-hashes experiments/mem0-comparison/requirements.lock
CARGO_TARGET_DIR=.local/mem0-comparison/<run-id>/cargo-target cargo build --manifest-path experiments/mem0-comparison/lexical-caller/Cargo.toml --locked --offline

.local/mem0-comparison/<run-id>/venv/bin/python experiments/mem0-comparison/compare.py preflight --run-dir .local/mem0-comparison/<run-id>
.local/mem0-comparison/<run-id>/venv/bin/python experiments/mem0-comparison/compare.py self-test
.local/mem0-comparison/<run-id>/venv/bin/python experiments/mem0-comparison/compare.py sample --run-dir .local/mem0-comparison/<run-id>
.local/mem0-comparison/<run-id>/venv/bin/python experiments/mem0-comparison/compare.py run --run-dir .local/mem0-comparison/<run-id>
.local/mem0-comparison/<run-id>/venv/bin/python experiments/mem0-comparison/compare.py report --run-dir .local/mem0-comparison/<run-id>
```

不重复使用已经运行的目录。失败收据保留，正式检索开始后不改源码或输入。评分只在完整检索结束后解析独立答案。结果文件、调用账本、索引与历史库均记录在本地目录；共享Milvus的已有集合保持原样。不自动清理资源或执行全局reset。

## 证据解释

Rust基线通过独立Cargo项目的路径依赖直接调用 `retrieval::asset_directory`。宿主有效性检查使用冻结的合成状态快照，不能代替MySQL/真实平台的权限与事务验证。结果回源保留版本、来源、范围和核实状态，`visibility=personal`来自实验资产的私有归属，不提升公共口径。

延迟包括每次真实embedding API与索引调用，并单列宿主处理耗时。CPU/RSS为实验客户端的共享过程测量；独立环境和Rust构建产物计入本地磁盘量。托管模型加载耗时、服务端CPU/RSS及每个集合的实际磁盘占用标为未测量。

## 官方依据

- [百炼模型规格与北京地域价格](https://help.aliyun.com/zh/model-studio/embedding)
- [OpenAI兼容embedding接口](https://help.aliyun.com/zh/model-studio/embedding-interfaces-compatible-with-openai)
- [Mem0固定版本](https://pypi.org/project/mem0ai/2.2.1/)
- [Mem0 Milvus接入](https://github.com/mem0ai/mem0/blob/main/mem0/vector_stores/milvus.py)；实际运行使用锁定wheel的源码，不以可变主分支代替。
