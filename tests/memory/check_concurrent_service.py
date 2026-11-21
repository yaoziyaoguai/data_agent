"""锁定 Mem0、真实 Milvus 和 SQLite。模型 HTTP 和预算接口使用本地合成响应。"""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import uuid

import httpx
from pymilvus import MilvusClient


ROOT = Path(__file__).resolve().parents[2]
TOKEN = "synthetic-" + uuid.uuid4().hex


@contextmanager
def host():
    issued, finalized = set(), []
    lock = threading.Lock()
    building, release = threading.Event(), threading.Event()
    lost = []

    class BenchmarkHost(BaseHTTPRequestHandler):
        def log_message(self, *_):
            return

        def do_POST(self):
            data = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            if self.path == "/internal/memory/model-calls":
                call = data["call_attempt_id"]
                with lock:
                    if data["action"] == "issue":
                        assert call not in issued
                        issued.add(call)
                        status, payload = 200, {"send_allowed": True}
                    else:
                        assert call in issued
                        if not lost:
                            lost.append(call)
                            status, payload = 503, {"code": "unavailable"}
                        else:
                            finalized.append(call)
                            status, payload = 200, {"state": "settled"}
            elif self.path == "/embeddings":
                texts = data["input"]
                if isinstance(texts, str):
                    texts = [texts]
                if any(text == "合成记忆构建屏障" for text in texts):
                    building.set()
                    assert release.wait(25)
                status = 200
                payload = {
                    "data": [{"index": i, "embedding": [1.0] + [0.0] * 1023} for i in range(len(texts))],
                    "usage": {"prompt_tokens": len(texts)},
                }
            else:
                status, payload = 404, {"code": "not_available"}
            raw = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

    with ThreadingHTTPServer(("127.0.0.1", 0), BenchmarkHost) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield server.server_port, issued, finalized, lost, building, release
        finally:
            release.set()
            server.shutdown()
            thread.join()


def eventually(action, timeout=40):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = action()
        if result:
            return result
        time.sleep(0.08)
    raise AssertionError("等待服务状态超时")


def main():
    url = "http://127.0.0.1:19531"
    token_file = ROOT / ".local/infra/milvus-root-password"
    collection = "memory_concurrency_" + uuid.uuid4().hex
    with tempfile.TemporaryDirectory(prefix="data-agent-memory-") as temp, host() as fixture:
        port, issued, finalized, lost, building, release = fixture
        home = Path(temp)
        upstream = f"http://127.0.0.1:{port}"
        with socket.socket() as server:
            server.bind(("127.0.0.1", 0))
            service_port = server.getsockname()[1]
        endpoint = f"http://127.0.0.1:{service_port}"
        key = home / "provider-key"
        key.write_text("synthetic-local-provider")
        configuration = home / "configuration.json"
        configuration.write_text(json.dumps({
            "milvus_url": url, "milvus_token_file": str(token_file), "collection": collection,
            "embedding_url": upstream + "/embeddings", "model_url": upstream + "/model",
            "embedding_key_file": str(key),
        }))
        env = dict(os.environ, DATA_AGENT_API_URL=upstream, DATA_AGENT_INTERNAL_TOKEN=TOKEN,
                   DATA_AGENT_MEMORY_TEST="1", DEEPSEEK_API_KEY="synthetic-local-provider")
        with (home / "service.log").open("w+") as log:
            service = subprocess.Popen(
                [sys.executable, "apps/memory/server.py", "--directory", temp,
                 "--configuration", str(configuration), "--port", str(service_port)],
                cwd=ROOT, env=env, stdout=log, stderr=log,
            )
            try:
                with httpx.Client(trust_env=False, timeout=40, headers={"Authorization": "Bearer " + TOKEN}) as client:
                    def healthy():
                        if service.poll() is not None:
                            raise RuntimeError("Mem0 测试实例提前退出")
                        try:
                            return client.get(endpoint + "/health", timeout=0.5).status_code == 200
                        except httpx.TransportError:
                            return False
                    eventually(healthy)
                    def call(path, op, payload):
                        binding = {"kind": "index" if path == "index" else "run", "id": op,
                                   "epoch": "1", "sdk_tool_call_id": None, "operation_id": op}
                        return client.post(endpoint + "/" + path, json={
                            "owner_id": "alice", "space_id": "synthetic", "operation_id": op,
                            "budget": binding, **payload,
                        })
                    def index(version, body=None, operation=None):
                        return call("index", operation or f"index-{version}", {
                            "extraction_operation_id": None, "asset": {
                                "id": "remembered-unit", "version": str(version), "state": "enabled",
                                "kind": "memory", "name": "合成单位", "body": body or f"合成单位修订 {version}",
                                "scope": "，仅供合成验证", "verified": True, "source_text": "合成材料",
                                "dependencies": [], "selected": False,
                            },
                        })
                    def search(op):
                        return call("search", op, {"query": "合成单位"})
                    first = index(1)
                    assert first.status_code == 503, first.text
                    eventually(lambda: lost and lost[0] in finalized)
                    # 第一次向量写已经开始且模型回执未知。用独立的正式新修订建立可读基线。
                    ready = index(2)
                    assert ready.status_code == 200 and ready.json()["state"] == "ready", ready.text
                    with ThreadPoolExecutor(max_workers=16) as pool:
                        pending = pool.submit(index, 3, "合成记忆构建屏障")
                        assert building.wait(20), "新向量正在生成"
                        try:
                            in_build = search("during-build")
                            assert in_build.status_code == 200, in_build.text
                            assert in_build.json()["candidates"] == [{"asset_id": "remembered-unit", "version": "2"}]
                        finally:
                            release.set()
                        assert pending.result().status_code == 200
                        requests = []
                        for n in range(100):
                            requests.append(("index", pool.submit(index, n + 4)))
                            requests.append(("search", pool.submit(search, f"search-{n}")))
                        recall = 0
                        written = 0
                        for kind, future in requests:
                            result = future.result()
                            assert result.status_code == 200, (kind, result.text)
                            if kind == "search":
                                assert result.json()["candidates"][0]["asset_id"] == "remembered-unit", result.text
                                recall += 1
                            else:
                                assert result.json()["state"] in ("ready", "superseded"), result.text
                                written += result.json()["state"] == "ready"
                    eventually(lambda: len(issued) == len(finalized))
                    assert len(set(finalized)) == len(finalized)
                    with sqlite3.connect(home / "receipts.sqlite") as db:
                        assert db.execute("SELECT COUNT(*) FROM provider_calls WHERE state='received'").fetchone()[0] == 0
                    print(json.dumps({"passed": True, "threads": 16, "requests": 200, "indexReady": written,
                                      "searches": recall, "recall": 1, "rescuedSettlements": len(lost),
                                      "duplicateFinalizations": len(finalized) - len(set(finalized)),
                                      "officialRequests": 0}, ensure_ascii=False))
            except Exception:
                log.seek(0)
                # 只输出阶段和错误类型。SDK 可能在连接错误里带有连接配置。
                lines = [line.strip() for line in log if line.startswith(("startup service=", "memory_operation_failed", "memory_vector_cleanup_failed"))]
                print("\n".join(lines[-12:]), file=sys.stderr)
                raise
            finally:
                if service.poll() is None:
                    service.terminate()
                    service.wait(timeout=15)
                milvus = MilvusClient(uri=url, token="root:" + token_file.read_text().strip())
                try:
                    for name in milvus.list_collections():
                        if name == collection or name.startswith(collection + "_"):
                            milvus.drop_collection(name)
                finally:
                    milvus.close()


if __name__ == "__main__":
    main()
