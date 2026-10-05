#!/usr/bin/env python3
"""真实检查专用容器、MySQL 写读、Milvus 鉴权及向量写读搜索。"""

from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

import infra


ROOT = Path(__file__).resolve().parents[1]
REPORT_PATH = ROOT / ".local" / "checks" / "infra-smoke.json"
SERVICES = ("mysql", "etcd", "minio", "milvus")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def containers() -> tuple[dict[str, str], dict]:
    ids = infra.run(infra.compose_args("ps", "--all", "--quiet"), capture=True).stdout.split()
    require(bool(ids), "本项目没有容器；先运行 python3 scripts/infra.py up。")
    records = json.loads(infra.run(infra.docker_args("inspect", *ids), capture=True).stdout)
    by_service = {}
    for record in records:
        labels = record["Config"]["Labels"]
        require(labels.get("com.docker.compose.project") == infra.PROJECT, "发现非本项目容器，停止检查。")
        service = labels["com.docker.compose.service"]
        require(service not in by_service, f"服务出现重复容器：{service}")
        by_service[service] = record
    require(set(by_service) == set(SERVICES) | {"milvus-volume-init"}, "本项目服务集合不完整。")
    locked = json.loads((ROOT / "infra" / "images.lock.json").read_text())["images"]
    evidence = {}
    for service, record in by_service.items():
        state = record["State"]
        if service == "milvus-volume-init":
            require(state["Status"] == "exited" and state["ExitCode"] == 0, "Milvus 卷初始化未成功退出。")
        else:
            require(state["Status"] == "running" and state.get("Health", {}).get("Status") == "healthy",
                    f"容器尚未健康：{service}")
        require(not state.get("OOMKilled"), f"容器曾因内存不足退出：{service}")
        image_lock = locked["milvus" if service == "milvus-volume-init" else service]
        expected = image_lock["tag"] + "@" + image_lock["index_digest"]
        require(record["Config"]["Image"] == expected, f"镜像与锁定值不一致：{service}")
        image = json.loads(infra.run(infra.docker_args("image", "inspect", record["Image"]), capture=True).stdout)[0]
        require(image["Architecture"] == "arm64" and image["Os"] == "linux", f"镜像不是原生 linux/arm64：{service}")
        if service == "milvus":
            require(record["Config"].get("User") not in ("", "0", "0:0", "root"), "正式 Milvus 进程不能以 root 用户运行。")
        expected_ports = {
            "mysql": {"3306/tcp": [{"HostIp": "127.0.0.1", "HostPort": "13306"}]},
            "milvus": {"19530/tcp": [{"HostIp": "127.0.0.1", "HostPort": "19531"}],
                       "9091/tcp": [{"HostIp": "127.0.0.1", "HostPort": "19091"}]},
        }.get(service, {})
        actual_ports = {port: bindings for port, bindings in (record["HostConfig"].get("PortBindings") or {}).items() if bindings}
        require(actual_ports == expected_ports, f"端口绑定与本地开发约定不符：{service}")
        evidence[service] = {
            "state": state["Status"], "health": state.get("Health", {}).get("Status"),
            "exit_code": state["ExitCode"], "oom_killed": state.get("OOMKilled"),
            "restart_count": record["RestartCount"], "image": expected,
            "image_id": record["Image"], "architecture": image["Architecture"],
            "configured_user": record["Config"].get("User"), "ports": actual_ports,
            "memory_limit_bytes": record["HostConfig"]["Memory"],
        }
    return {service: record["Id"] for service, record in by_service.items()}, evidence


def mysql_smoke(container_id: str) -> dict:
    def sql(statement: str) -> str:
        return infra.run(infra.docker_args("exec", "-i", container_id, "mysql",
                         "--defaults-extra-file=/run/secrets/mysql_root_client",
                         "--batch", "--skip-column-names"),
                         capture=True, input_text=statement + "\n", timeout=30).stdout.strip()

    name = "data_agent_smoke_" + uuid.uuid4().hex
    require(sql(f"SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name='{name}';") == "0",
            "临时数据库名已存在，停止以保护现有数据。")
    version = sql("SELECT VERSION();")
    require(version.startswith("8.4.11"), "MySQL 运行版本与锁定版本不符。")
    failure = None
    try:
        sql(f"CREATE DATABASE `{name}`;")
        actual = sql(f"USE `{name}`;\nCREATE TABLE items (id INT PRIMARY KEY, value INT NOT NULL);\n"
                     "INSERT INTO items VALUES (1, 41), (2, 17);\n"
                     "SELECT id, value FROM items ORDER BY id;")
        require(actual == "1\t41\n2\t17", "MySQL 写入/读取的内容不一致。")
    except Exception as error:
        failure = error
    finally:
        try:
            # 名称由本次生成，已在创建前确认不存在；回执未知时仍清理这个名称。
            sql(f"DROP DATABASE IF EXISTS `{name}`;")
            require(sql(f"SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name='{name}';") == "0",
                    "MySQL 临时数据库清理后仍存在。")
        except Exception as cleanup_error:
            if failure is not None:
                raise RuntimeError("MySQL 烟测失败且临时对象清理未确认。") from failure
            raise RuntimeError("MySQL 临时对象清理未确认。") from cleanup_error
    if failure is not None:
        raise failure
    return {"passed": True, "version": version, "rows_verified": 2, "temporary_database_removed": True}


def milvus_smoke() -> dict:
    password = (infra.SECRET_DIR / "milvus-root-password").read_text().strip()
    base_url = "http://127.0.0.1:19531/v2/vectordb"
    # 本机开发端点不经系统代理，避免本机密码进入代理请求。
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def request(path: str, payload: dict, *, authenticated: bool = True) -> tuple[int, dict]:
        headers = {"Content-Type": "application/json", "Accept-Type-Allow-Int64": "true"}
        if authenticated:
            headers["Authorization"] = "Bearer root:" + password
        req = urllib.request.Request(base_url + path, data=json.dumps(payload).encode(), headers=headers, method="POST")
        try:
            with opener.open(req, timeout=30) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            # 只在内存解析，调用方不输出返回正文，避免服务错误包含敏感上下文。
            try:
                body = json.load(error)
            except (ValueError, OSError):
                body = {}
            return error.code, body

    def post(path: str, payload: dict) -> dict:
        status, body = request(path, payload)
        require(status == 200 and body.get("code") == 0,
                f"Milvus 请求失败：{path}（HTTP {status}, code {body.get('code')}）。")
        return body.get("data")

    status, body = request("/collections/list", {"dbName": "default"}, authenticated=False)
    require(status in (401, 403) or (status == 200 and body.get("code") in (401, 403, 1800)),
            "Milvus 未明确拒绝无凭据访问。")
    auth_evidence = {"http_status": status, "code": body.get("code")}
    name = "da_smoke_" + uuid.uuid4().hex
    base = {"dbName": "default", "collectionName": name}
    require(post("/collections/has", base).get("has") is False, "临时 collection 名已存在，停止检查。")
    expected = {
        101: [1.0, 0.0, 0.0, 0.0],
        102: [0.0, 1.0, 0.0, 0.0],
        103: [-1.0, 0.0, 0.0, 0.0],
    }
    failure = None
    try:
        post("/collections/create", {**base, "dimension": 4, "idType": "Int64", "autoID": False,
             "primaryFieldName": "id", "vectorFieldName": "vector", "metricType": "L2",
             "consistencyLevel": "Strong", "params": {"enableDynamicField": False}})
        deadline = time.monotonic() + 90
        while True:
            state = post("/collections/get_load_state", base)
            if state.get("loadState") == "LoadStateLoaded":
                break
            require(time.monotonic() < deadline, "Milvus collection 在 90 秒内未加载完成。")
            time.sleep(0.5)
        inserted = post("/entities/insert", {**base, "data": [{"id": key, "vector": value} for key, value in expected.items()]})
        require(inserted.get("insertCount") == 3 and sorted(int(x) for x in inserted.get("insertIds", [])) == list(expected),
                "Milvus 插入数量或 ID 不符合预期。")
        rows = post("/entities/query", {**base, "filter": "id in [101, 102, 103]", "outputFields": ["id", "vector"],
                    "limit": 3, "consistencyLevel": "Strong"})
        require(len(rows) == 3 and {int(row["id"]): row["vector"] for row in rows} == expected,
                "Milvus 读取的向量与写入内容不一致。")
        hits = post("/entities/search", {**base, "data": [[1.0, 0.0, 0.0, 0.0]], "annsField": "vector",
                    "limit": 3, "outputFields": ["id"], "consistencyLevel": "Strong"})
        require([int(hit["id"]) for hit in hits] == list(expected), "Milvus 最近邻顺序不符合预期。")
        require(all(math.isclose(float(hit["distance"]), distance, abs_tol=1e-5)
                    for hit, distance in zip(hits, (0.0, 2.0, 4.0))), "Milvus L2 距离不符合预期。")
    except Exception as error:
        failure = error
    finally:
        try:
            if post("/collections/has", base).get("has"):
                post("/collections/drop", base)
            require(post("/collections/has", base).get("has") is False, "Milvus 临时 collection 清理后仍存在。")
        except Exception as cleanup_error:
            if failure is not None:
                raise RuntimeError("Milvus 烟测失败且临时对象清理未确认。") from failure
            raise RuntimeError("Milvus 临时对象清理未确认。") from cleanup_error
    if failure is not None:
        raise failure
    return {"passed": True, "unauthenticated_request_rejected": auth_evidence,
            "collection_loaded": True, "vectors_verified": 3, "dimension": 4,
            "metric": "L2", "consistency": "Strong", "nearest_ids": list(expected),
            "temporary_collection_removed": True}


def main() -> int:
    started = time.monotonic()
    report = {"checked_at": datetime.now(timezone.utc).isoformat(), "context": infra.CONTEXT,
              "compose_project": infra.PROJECT, "passed": False,
              "scope": "本机依赖烟测；不证明应用迁移、Embedding、语义检索质量、重启持久化或生产容量。"}
    try:
        infra.validate_secrets()
        ids, report["containers"] = containers()
        print("容器健康、ARM64 镜像锁定、本机端口及运行用户检查通过。", flush=True)
        report["mysql"] = mysql_smoke(ids["mysql"])
        print("MySQL 临时数据库建表、写入、读取、清理通过。", flush=True)
        report["milvus"] = milvus_smoke()
        print("Milvus 鉴权、加载、向量写读、最近邻搜索、清理通过。", flush=True)
        active_ids = [ids[service] for service in SERVICES]
        stats = infra.run(infra.docker_args("stats", "--no-stream", "--format", "{{json .}}", *active_ids), capture=True, timeout=30)
        report["resources"] = [json.loads(line) for line in stats.stdout.splitlines() if line.strip()]
        info = json.loads(infra.run(infra.docker_args("info", "--format", "{{json .}}"), capture=True).stdout)
        report["docker_server"] = {key: info.get(key) for key in ("ServerVersion", "Architecture", "NCPU", "MemTotal")}
        report["passed"] = True
    except (OSError, ValueError, KeyError, TypeError, RuntimeError, subprocess.SubprocessError) as error:
        report["error"] = f"{type(error).__name__}: {error}"
        print("基础设施烟测未通过：" + report["error"], file=sys.stderr)
    finally:
        report["duration_seconds"] = round(time.monotonic() - started, 3)
        report["input_sha256"] = {str(file.relative_to(ROOT)): hashlib.sha256(file.read_bytes()).hexdigest()
                                   for file in [ROOT / "compose.yaml", ROOT / "scripts" / "infra.py", Path(__file__).resolve(),
                                                ROOT / "infra" / "images.lock.json", ROOT / "infra" / "prepare-milvus.sh"]}
        REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
        REPORT_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print("证据：.local/checks/infra-smoke.json")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
