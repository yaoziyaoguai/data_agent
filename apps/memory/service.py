"""锁定Mem0的提取、提交和检索适配，不决定用户意图或公共口径。"""
import hashlib
import json
import os
import time
from pathlib import Path

from providers import BudgetedEmbedding, BudgetedLLM, ModelGateway
from store import MemoryError, ReceiptStore


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


class MemoryService:
    def __init__(self, config, directory):
        os.environ["MEM0_TELEMETRY"] = "False"
        os.environ["MEM0_DIR"] = str(directory / "sdk")
        started = time.monotonic()
        print("startup service=memory stage=mem0_import_started", flush=True)
        from mem0 import Memory
        print(f"startup service=memory stage=mem0_import_ready elapsed={time.monotonic()-started:.2f}s", flush=True)

        self.store = ReceiptStore(directory / "receipts.sqlite")
        self.gateway = ModelGateway(config, self.store)
        self.fingerprint = digest(config)
        print("startup service=memory stage=configuration_started", flush=True)
        self.memory = Memory.from_config({
            "vector_store": {"provider": "milvus", "config": {
                "url": config["milvus_url"], "token": "root:" + Path(config["milvus_token_file"]).read_text().strip(),
                "collection_name": config["collection"], "embedding_model_dims": 1024, "metric_type": "COSINE", "db_name": "default"}},
            "embedder": {"provider": "openai", "config": {"model": "qwen3.7-text-embedding", "embedding_dims": 1024, "api_key": "host-adapter"}},
            "llm": {"provider": "openai", "config": {"api_key": "host-adapter", "enable_vision": False}},
            "history_db_path": str(directory / "history.sqlite"), "reranker": None})
        print(f"startup service=memory stage=configuration_ready elapsed={time.monotonic()-started:.2f}s", flush=True)
        # 固定SDK构造器不发模型请求；替换公开实例属性以沿用宿主预算，SDK算法保持原样。
        self.memory.llm = BudgetedLLM(self.gateway)
        self.memory.embedding_model = BudgetedEmbedding(self.gateway)

    def flush(self):
        self.memory.vector_store.client.flush(collection_name=self.memory.collection_name)

    def handle(self, path, request):
        self.gateway.settle_pending()
        self.gateway.binding = request["budget"]
        self.gateway.failure = None
        if path == "/extract":
            return self.extract(request)
        if path == "/index":
            return self.index(request)
        return self.search(request)

    @staticmethod
    def tenant(r):
        return r["owner_id"] + "::" + r["space_id"]

    def extract(self, r):
        key = "extract:" + r["operation_id"]
        fp = digest([self.fingerprint, r["owner_id"], r["space_id"], r["message"], r["quote"]])
        previous = self.store.operation(key, fp)
        if previous:
            if previous["state"] != "prepared":
                raise MemoryError(previous.get("error", "memory_operation_unknown"))
            return {"operation_id": r["operation_id"], "body": previous["body"], "replayed": True}
        if r["quote"] not in r["message"]:
            raise MemoryError("memory_unavailable")
        self.store.write_operation(key, fp, "unknown", {})
        try:
            result = self.memory.add([{"role": "user", "content": r["message"]}], user_id=self.tenant(r), run_id=r["operation_id"],
                metadata={"owner_id": r["owner_id"], "space_id": r["space_id"], "commit_state": "pending", "operation_id": r["operation_id"]}, infer=True,
                prompt="只提取以下原文引用对应的可复用个人事项。完整消息用于理解上下文及限制；当次查询与临时例外不得变成长久偏好。每条记忆在同一段中保留适用对象、默认、范围、例外和待核实含义，用中文记录。业务指标和对象名称沿用原话，不添加原话没有的别名、英文缩写或同义关系，不扩大到其他指标，不增加公共口径。没有可复用事项返回空。原文引用：" + r["quote"])
            self.check_calls()
            items = result.get("results", [])
            if not items or any(not isinstance(v.get("memory"), str) or not v["memory"].strip() for v in items):
                raise MemoryError("memory_extraction_empty")
            body = "\n".join(v["memory"].strip() for v in items)
            if len(body) > 12000:
                raise MemoryError("memory_unavailable")
            self.flush()
            self.store.write_operation(key, fp, "prepared", {"body": body, "ids": [v["id"] for v in items], "owner_id": r["owner_id"], "space_id": r["space_id"]})
            return {"operation_id": r["operation_id"], "body": body, "replayed": False}
        except Exception as e:
            code = getattr(getattr(self, 'gateway', None), 'failure', None) or (str(e) if isinstance(e, MemoryError) else "memory_operation_unknown")
            self.store.write_operation(key, fp, "failed", {"error": code})
            raise MemoryError(code) from None

    def index(self, r):
        asset, key = r["asset"], "index:" + r["operation_id"]
        identity = self.tenant(r) + "::" + asset["id"]
        fp = digest([self.fingerprint, identity, asset, r["extraction_operation_id"]])
        previous = self.store.operation(key, fp)
        current = self.store.asset(identity)
        version = int(asset["version"])
        receipt = {"operation_id": r["operation_id"], "state": "ready" if asset["state"] == "enabled" else "removed"}
        if current and current["version"] > version:
            return {**receipt, "state": "superseded"}
        if previous and previous["state"] == "completed":
            return previous["receipt"]
        old_ids = current["memory_ids"] if current else []
        # 先取消旧映射；检索返回前还会核对这份映射及Rust正式记录。
        self.store.write_asset(identity, version, "pending", old_ids)
        ids = (previous or {}).get("ids")
        if asset["state"] == "enabled" and ids is None:
            if r["extraction_operation_id"]:
                row = self.store.db.execute("SELECT state,result FROM operations WHERE id=?", ("extract:" + r["extraction_operation_id"],)).fetchone()
                if not row or row[0] != "prepared":
                    raise MemoryError("memory_operation_unknown")
                prepared = json.loads(row[1])
                if prepared["body"] != asset["body"] or prepared["owner_id"] != r["owner_id"] or prepared["space_id"] != r["space_id"] or prepared.get("asset_id", asset["id"]) != asset["id"]:
                    raise MemoryError("idempotency_conflict")
                prepared["asset_id"] = asset["id"]
                with self.store.db:
                    self.store.db.execute("UPDATE operations SET result=? WHERE id=?", (json.dumps(prepared, ensure_ascii=False), "extract:" + r["extraction_operation_id"]))
                ids = prepared["ids"]
            else:
                if previous:
                    raise MemoryError("memory_operation_unknown")
                self.store.write_operation(key, fp, "unknown", {})
                result = self.memory.add(asset["body"], user_id=self.tenant(r), run_id=r["operation_id"], infer=False,
                    metadata={"owner_id": r["owner_id"], "space_id": r["space_id"], "commit_state": "pending"})
                self.check_calls()
                ids = [v["id"] for v in result.get("results", [])]
                if not ids:
                    raise MemoryError("memory_unavailable")
        ids = ids or []
        self.store.write_operation(key, fp, "prepared", {"ids": ids})
        # 下列仅改向量元数据或删除，可按相同IDs重放，不重新infer或embedding。
        for memory_id in old_ids:
            if memory_id not in ids and self.memory.vector_store.get(memory_id):
                self.memory.delete(memory_id)
        if asset["state"] == "enabled":
            for memory_id in ids:
                record = self.memory.vector_store.get(memory_id)
                if not record:
                    raise MemoryError("memory_unavailable")
                self.memory.vector_store.update(memory_id, payload={**record.payload, "commit_state": "ready", "asset_id": asset["id"], "asset_version": asset["version"]})
        self.flush()
        self.store.write_asset(identity, version, receipt["state"], ids if asset["state"] == "enabled" else [])
        self.store.write_operation(key, fp, "completed", {"receipt": receipt})
        return receipt

    def search(self, r):
        key = 'search:' + r.get('operation_id', 'test')
        fp = digest([self.fingerprint, self.tenant(r), r['query']])
        previous = self.store.operation(key, fp)
        if previous:
            if previous['state'] != 'completed':
                raise MemoryError('memory_operation_unknown')
            return previous['receipt']
        self.store.write_operation(key, fp, 'unknown', {})
        receipt = self.search_current(r)
        self.store.write_operation(key, fp, 'completed', {'receipt': receipt})
        return receipt

    def check_calls(self):
        failure = getattr(getattr(self, 'gateway', None), 'failure', None)
        if failure:
            raise MemoryError(failure)

    def search_current(self, r):
        result = self.memory.search(r["query"], top_k=200, threshold=0.0, rerank=False,
            filters={"user_id": self.tenant(r), "owner_id": r["owner_id"], "space_id": r["space_id"], "commit_state": "ready"})
        self.check_calls()
        candidates, seen = [], set()
        for item in result.get("results", []):
            meta = item.get("metadata", {})
            if not meta.get("asset_id") or not meta.get("asset_version"):
                continue
            identity = self.tenant(r) + "::" + meta["asset_id"]
            current = self.store.asset(identity)
            if not current or current["state"] != "ready" or current["version"] != int(meta["asset_version"]) or item["id"] not in current["memory_ids"]:
                continue
            pair = (meta["asset_id"], meta["asset_version"])
            if pair not in seen:
                seen.add(pair)
                candidates.append({"asset_id": pair[0], "version": pair[1]})
        return {"candidates": candidates, "bounded": len(result.get("results", [])) == 200}
