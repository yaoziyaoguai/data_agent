"""原始消息提取实验的Mem0接缝；标准输入输出仅传合成业务JSON。"""

from __future__ import annotations

import hashlib
import json
import math
import os
import sys
import time
from pathlib import Path

from adapters import EmbeddingAPI, Mem0Index, OperationError
from fixtures import ROOT


def append(path: Path, value: dict) -> None:
    with path.open("a") as stream:
        stream.write(json.dumps(value, ensure_ascii=False) + "\n")
        stream.flush()


class ExtractionLLM:
    """Mem0模型工厂的真实Flash适配，不包含Agent循环或提取算法。"""

    def __init__(self, directory: Path) -> None:
        import httpx

        self.directory = directory
        self.client = httpx.Client(timeout=90, trust_env=False, follow_redirects=False)
        credentials = {}
        for line in (ROOT / ".env").read_text().splitlines():
            name, sep, value = line.partition("=")
            if sep and name in {"DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL"}:
                credentials[name] = value.strip()
        if credentials.get("DEEPSEEK_BASE_URL") != "https://api.deepseek.com":
            raise OperationError("generation_endpoint_invalid")
        self.key = credentials["DEEPSEEK_API_KEY"]
        self.attempts = 0
        self.spent_micros = 0
        self.reserved_micros = 0
        ledger = directory / "extraction-calls.jsonl"
        if ledger.exists():
            latest = {}
            for line in ledger.read_text().splitlines():
                receipt = json.loads(line)
                latest[receipt["attempt"]] = receipt
            self.attempts = max(latest, default=0)
            self.spent_micros = sum(r.get("actual_micros", 0) for r in latest.values() if r["state"] == "settled")
            self.reserved_micros = sum(r["reserved_micros"] for r in latest.values() if r["state"] != "settled")

    def generate_response(self, messages, response_format=None, **kwargs):
        payload = {"model": "deepseek-flash", "messages": messages, "max_tokens": 4096,
                   "thinking": {"type": "disabled"}, "stream": False}
        if response_format:
            payload["response_format"] = response_format
        raw = json.dumps(payload, ensure_ascii=False)
        input_upper = len(raw.encode())
        reserve = math.ceil((input_upper * 30 + 4096 * 120) / 100)
        # 锁定Mem0的内置提取提示本身约34KiB，门槛须容纳它和本轮小资产。
        if input_upper > 65536:
            raise OperationError("extraction_payload_limit")
        if self.attempts >= 160 or self.spent_micros + self.reserved_micros + reserve > 3_000_000:
            raise OperationError("extraction_budget_exhausted")
        self.attempts += 1
        receipt = {"attempt": self.attempts, "state": "unknown", "reserved_micros": reserve,
                   "payload_sha256": hashlib.sha256(raw.encode()).hexdigest()}
        self.reserved_micros += reserve
        start = time.perf_counter()
        append(self.directory / "extraction-calls.jsonl", receipt)
        try:
            response = self.client.post("https://api.deepseek.com/chat/completions",
                                        headers={"Authorization": "Bearer " + self.key}, json=payload)
            if response.status_code != 200:
                raise OperationError("extraction_http_" + str(response.status_code))
            value = response.json()
            usage = value["usage"]
            input_tokens, output_tokens = usage["prompt_tokens"], usage["completion_tokens"]
            if not all(isinstance(v, int) and v >= 0 for v in (input_tokens, output_tokens)):
                raise OperationError("extraction_usage_invalid")
            cost = math.ceil((input_tokens * 30 + output_tokens * 120) / 100)
            self.reserved_micros -= reserve
            self.spent_micros += cost
            receipt.update(state="settled", usage=usage, actual_micros=cost, request_id=value.get("id"))
            if input_tokens > input_upper or output_tokens > 4096:
                raise OperationError("extraction_usage_limit")
            choice = value["choices"][0]
            if choice.get("finish_reason") != "stop":
                raise OperationError("extraction_incomplete")
            return choice["message"]["content"]
        except OperationError as error:
            receipt["error"] = str(error)
            raise
        except Exception as error:
            receipt["error"] = "extraction_" + type(error).__name__
            raise OperationError(receipt["error"]) from None
        finally:
            receipt["elapsed_ms"] = (time.perf_counter() - start) * 1000
            append(self.directory / "extraction-calls.jsonl", receipt)

    def totals(self):
        return {"calls": self.attempts, "spent_micros": self.spent_micros,
                "reserved_micros": self.reserved_micros}


class MemoryService:
    def __init__(self, directory: Path) -> None:
        self.directory = directory
        self.config = json.loads((directory / "embedding-config.json").read_text())
        self.embedding = EmbeddingAPI(self.config, directory)
        self.llm = ExtractionLLM(directory)
        self.indexes = {}
        self.sources = json.loads((directory / "source-map.json").read_text()) if (directory / "source-map.json").exists() else {}
        self.operations = json.loads((directory / "operations.json").read_text()) if (directory / "operations.json").exists() else {}
        self.collections = json.loads((directory / "collections.json").read_text()) if (directory / "collections.json").exists() else {}

    def operate(self, request):
        action = request["action"]
        if action == "case":
            name = "mem0_agent_" + hashlib.sha256(str(self.directory).encode()).hexdigest()[:12] + "_" + request["name"]
            if request["name"] in self.collections:
                raise OperationError("case_already_exists")
            index = Mem0Index(self.config, name, self.embedding, self.directory, self.llm)
            self.indexes[request["name"]] = index
            self.collections[request["name"]] = name
            self.sources[request["name"]] = {}
            self.save_sources()
            return {"collection": name, "infer": True}
        if action == "totals":
            return {"embedding": self.embedding.totals(), "extraction": self.llm.totals()}
        if action == "close":
            for index in self.indexes.values():
                index.close()
            return self.operate({"action": "totals"})
        index = self.indexes[request["case"]]
        principal = request["principal"]
        tenant = principal["user_id"] + "::" + principal["space_id"]
        if action == "prepare":
            # run_id也隔离Mem0内部最近消息和提取时查找的旧事实，pending标签本身不够。
            message, quote = request["message"], request["quote"]
            if not quote or quote not in message:
                raise OperationError("extraction_source_invalid")
            key = request["case"] + "::" + tenant + "::" + request["operation"]
            source_hash = hashlib.sha256(json.dumps([message, quote], ensure_ascii=False).encode()).hexdigest()
            old = self.operations.get(key)
            if old:
                if old["source_sha256"] != source_hash:
                    raise OperationError("extraction_idempotency_conflict")
                if old["state"] != "prepared":
                    raise OperationError(old.get("error", "extraction_receipt_unknown"))
                return {**old, "replayed": True}
            current = {"state": "unknown", "source_sha256": source_hash, "memory_ids": []}
            self.operations[key] = current
            self.save_sources()
            try:
                if request.get("fault") == "extraction_unavailable":
                    raise OperationError("synthetic_extraction_unavailable")
                result = index.memory.add(
                    [{"role": "user", "content": message}], user_id=tenant, run_id=request["operation"],
                    metadata={"owner_id": principal["user_id"], "space_id": principal["space_id"],
                              "candidate_operation": request["operation"], "commit_state": "pending"}, infer=True,
                    prompt="只提取以下原文引用对应的可复用个人事项。完整消息只用于理解上下文和限制，其他事项不要提取。"
                           "保留默认、适用范围和待核实含义；当次查询及临时例外不得变成长久偏好。"
                           "用中文记录，不增加公共业务口径。若没有可复用事项返回空。原文引用：" + quote)
                items = result.get("results", [])
                if not items or any(not isinstance(item.get("memory"), str) or not item["memory"].strip() for item in items):
                    raise OperationError("extraction_no_usable_fact")
                body = "\n".join(item["memory"].strip() for item in items)
                if len(body) > 12000:
                    raise OperationError("extraction_body_limit")
                index.memory.vector_store.client.flush(collection_name=index.name)
                current.update(state="prepared", body=body, extracted=items, memory_ids=[item["id"] for item in items])
            except Exception as error:
                current["error"] = str(error) if isinstance(error, OperationError) else "extraction_" + type(error).__name__
                self.save_sources()
                raise OperationError(current["error"]) from None
            self.save_sources()
            return current
        if action == "commit":
            asset = request["asset"]
            source_key = tenant + "::" + asset["id"]
            previous = self.sources[request["case"]].get(source_key)
            if previous and previous["version"] == asset["version"] and previous["state"] == asset["state"]:
                return {"replayed": True, **previous}
            current = {"version": asset["version"], "state": asset["state"], "memory_ids": [], "index_state": "pending"}
            # 先撤销旧映射：即使物理删除失败，旧版和未提交候选也不能进入采用路径。
            self.sources[request["case"]][source_key] = current
            self.save_sources()
            if asset["state"] == "enabled":
                prepared = self.operations[request["case"] + "::" + tenant + "::" + request["operation"]]
                if prepared["state"] != "prepared" or prepared["body"] != asset["body"]:
                    raise OperationError("formal_body_mismatch")
                if prepared.get("formal_asset_id", asset["id"]) != asset["id"]:
                    raise OperationError("candidate_already_bound")
                prepared["formal_asset_id"] = asset["id"]
                self.save_sources()
                if request.get("fault") == "index_commit_unavailable":
                    current["index_state"] = "failed"
                    self.save_sources()
                    raise OperationError("synthetic_index_commit_unavailable")
                for memory_id in prepared["memory_ids"]:
                    record = index.memory.vector_store.get(memory_id)
                    index.memory.vector_store.update(memory_id, payload={**record.payload, "commit_state": "ready"})
                index.memory.vector_store.client.flush(collection_name=index.name)
                current.update(memory_ids=prepared["memory_ids"], index_state="ready", body_sha256=hashlib.sha256(asset["body"].encode()).hexdigest())
            else:
                current["index_state"] = "removed"
            self.save_sources()
            for memory_id in (previous or {}).get("memory_ids", []):
                index.memory.delete(memory_id)
            return current
        if action == "search":
            index.trace = []
            result = index.memory.search(request["query"], top_k=20, threshold=0.0, rerank=False,
                                         filters={"user_id": tenant, "owner_id": principal["user_id"],
                                                  "space_id": principal["space_id"], "commit_state": "ready"}, explain=True)
            committed = {}
            for source_key, value in self.sources[request["case"]].items():
                if not source_key.startswith(tenant + "::") or value["state"] != "enabled" or value["index_state"] != "ready":
                    continue
                for memory_id in value["memory_ids"]:
                    committed[memory_id] = {"runtime_id": source_key[len(tenant) + 2:], "asset_version": value["version"],
                                            "owner_id": principal["user_id"], "space_id": principal["space_id"]}
            accepted = [{**hit, "metadata": committed[hit["id"]]} for hit in result["results"] if hit["id"] in committed]
            return {"results": accepted, "excluded_uncommitted": len(result["results"]) - len(accepted), "backend": index.trace}
        raise OperationError("operation_not_supported")

    def save_sources(self):
        for name, value in [("source-map", self.sources), ("collections", self.collections), ("operations", self.operations)]:
            temporary = self.directory / (name + ".json.tmp")
            temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2))
            temporary.replace(self.directory / (name + ".json"))


def main():
    directory = Path(sys.argv[1]).resolve()
    os.environ["no_proxy"] = os.environ["NO_PROXY"] = "127.0.0.1,localhost,::1"
    service = MemoryService(directory)
    for line in sys.stdin:
        request = json.loads(line)
        try:
            value = service.operate(request)
            receipt = {"id": request["id"], "ok": True, "value": value}
        except Exception as error:
            receipt = {"id": request["id"], "ok": False,
                       "error": str(error) if isinstance(error, OperationError) else type(error).__name__}
        append(directory / "memory-service.jsonl", {"request": request, "receipt": receipt})
        print(json.dumps(receipt, ensure_ascii=False), flush=True)
        if request["action"] == "close":
            break


if __name__ == "__main__":
    main()
