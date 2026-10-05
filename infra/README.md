# 开发依赖来源

安装和启停入口见 [开发环境说明](../docs/development.md)。本目录仅保存非秘密配置与镜像锁定证据。

| 组件 | 固定版本 | 依据 |
| --- | --- | --- |
| MySQL | 8.4.11 LTS | [官方发布说明](https://dev.mysql.com/doc/relnotes/mysql/8.4/en/news-8-4-11.html) |
| Milvus Standalone | 3.0.2 | [官方发布](https://github.com/milvus-io/milvus/releases/tag/v3.0.2) |
| etcd | 3.5.25 | Milvus 3.0.2 官方 Compose 配套版本 |
| MinIO | RELEASE.2024-12-18T13-15-44Z，milvusdb/minio | Milvus 3.0.2 官方 Compose 配套版本 |

[images.lock.json](images.lock.json) 记录 2026-10-03 核对的多架构 index digest、ARM64 manifest digest 和公开来源。[compose.yaml](../compose.yaml) 同时固定 tag、index digest 与 `linux/arm64`；烟测进一步检查实际容器使用的镜像及架构。已缓存的固定镜像会复用，首次缺少镜像时才拉取。

## 与官方示例的差异

- 采用 [Milvus 官方 Standalone Compose](https://github.com/milvus-io/milvus/releases/download/v3.0.2/milvus-standalone-docker-compose.yaml) 的 etcd、MinIO、Milvus 和卷初始化结构。保留其 `seccomp:unconfined` 设置；这是一套本机开发配置。
- 所有数据使用项目专用命名卷。MySQL、Milvus 和健康检查端口仅绑定本机非默认端口；etcd 和 MinIO 无宿主端口。
- 开发密码由本项目首次运行时生成，文件位于被 Git 忽略的 `.local/infra/`，权限 0600。已有秘密保持原样；不从用户已有 `.env` 读取。
- MySQL 与 Milvus 均启用密码验证。MinIO 使用文件型凭据。正式 Milvus 以镜像内 `milvus` 用户运行；初始化进程把私密配置复制到专用卷、设置所有者后，正式进程只读挂载该卷。
- 容器内存上限合计约 4.875 GiB，适配初始 6 GiB VM；etcd 配额设为 512 MiB，MySQL buffer pool 为 128 MiB。容量是否满足后续数据量需要实际测试。

## 烟测依据与边界

`scripts/check-infra.py` 使用随机临时数据库和 collection，创建前确认不存在，完成或失败后清理。MySQL 检查建表、写入和读取。Milvus 检查拒绝匿名访问、加载、向量写入、Strong 一致性读取与确定性 L2 搜索。

Milvus 请求依据固定版本源码：[创建与加载](https://github.com/milvus-io/milvus/blob/v3.0.2/internal/distributed/proxy/httpserver/handler_v2.go#L2868)、[插入](https://github.com/milvus-io/milvus/blob/v3.0.2/internal/distributed/proxy/httpserver/handler_v2.go#L1773)、[查询](https://github.com/milvus-io/milvus/blob/v3.0.2/internal/distributed/proxy/httpserver/handler_v2.go#L1549)、[搜索](https://github.com/milvus-io/milvus/blob/v3.0.2/internal/distributed/proxy/httpserver/handler_v2.go#L2002)。先等待 collection 加载，查询和搜索均指定 `Strong`；本机 REST 请求显式禁用代理。

此检查证明本机依赖可用，不证明应用数据库迁移、Embedding、语义检索质量、持久化重启恢复或生产容量。
