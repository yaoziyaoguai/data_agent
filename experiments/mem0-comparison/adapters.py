"""现有Rust调用器、真实向量索引与Mem0的薄适配。"""

from __future__ import annotations

import hashlib
import json
import math
import os
import selectors
import subprocess
import time
import uuid
from pathlib import Path
from unittest.mock import patch

from fixtures import ROOT, embedding_text, runtime_id, tenant_id, write_json


class OperationError(Exception):
    """错误码不携带凭据、服务地址或自由格式的外部异常正文。"""


class EmbeddingAPI:
    def __init__(self, config: dict, run_dir: Path) -> None:
        import httpx

        self.config, self.run_dir = config, run_dir
        self.requests, self.input_tokens, self.unknown_charge = 0, 0, 0.0
        self.attempts: list[dict] = []
        ledger = run_dir / "embedding-calls.jsonl"
        if ledger.exists():
            latest = {}
            for line in ledger.read_text().splitlines():
                receipt = json.loads(line)
                latest[receipt["attempt"]] = receipt
            self.attempts = list(latest.values())
            self.requests = max(latest, default=0)
            self.input_tokens = sum(r.get("input_tokens", 0) for r in self.attempts)
            self.unknown_charge = sum(r["reserved_cny"] for r in self.attempts if r["status"] == "unknown")
        self.client = httpx.Client(timeout=config["request_timeout_seconds"], trust_env=False, follow_redirects=False)
        self.key = (ROOT / config["key_file"]).read_text().strip()
        self.dimensions = config["dimensions"]
        self.phase = "initialization"

    def embed(self, text: str, action: str = "search") -> list[float]:
        return self.embed_batch([text], action)[0]

    def embed_batch(self, texts: list[str], action: str = "search") -> list[list[float]]:
        if not texts or len(texts) > 20 or any(not isinstance(t, str) for t in texts):
            raise OperationError("invalid_embedding_input")
        input_bytes = sum(len(t.encode("utf-8")) for t in texts)
        if input_bytes > 8192:
            raise OperationError("embedding_input_limit")
        price = self.config["price_cny_per_1000_input_tokens"] / 1000
        reserve = input_bytes * price
        if self.requests >= self.config["request_limit"] or self.input_tokens * price + self.unknown_charge + reserve > self.config["maximum_charge_cny"]:
            raise OperationError("embedding_budget_exhausted")
        self.requests += 1
        receipt = {"attempt": self.requests, "phase": self.phase, "action": action,
                   "text_sha256": [hashlib.sha256(t.encode()).hexdigest() for t in texts],
                   "input_bytes": input_bytes, "reserved_cny": reserve, "status": "unknown"}
        start = time.perf_counter()
        self.unknown_charge += reserve
        self._append(receipt)
        try:
            response = self.client.post(self.config["base_url"].rstrip("/") + "/embeddings",
                                        headers={"Authorization": "Bearer " + self.key},
                                        json={"model": self.config["model"], "input": texts,
                                              "dimensions": self.dimensions, "encoding_format": "float"})
            receipt["http_status"] = response.status_code
            if response.status_code != 200:
                raise OperationError(f"embedding_http_{response.status_code}")
            data = response.json()
            receipt["request_id"] = data.get("id") or response.headers.get("x-request-id")
            receipt["response_model"] = data.get("model")
            usage = data.get("usage", {})
            tokens = usage.get("prompt_tokens", usage.get("total_tokens"))
            if not isinstance(tokens, int) or tokens < 0:
                raise OperationError("embedding_usage_missing")
            self.input_tokens += tokens
            self.unknown_charge -= reserve
            receipt.update(input_tokens=tokens, status="settled")
            items = sorted(data["data"], key=lambda r: r["index"])
            if len(items) != len(texts) or [r["index"] for r in items] != list(range(len(texts))):
                raise OperationError("embedding_batch_mismatch")
            vectors = []
            for item in items:
                vector = item["embedding"]
                if len(vector) != self.dimensions or not all(isinstance(x, (int, float)) and math.isfinite(x) for x in vector):
                    raise OperationError("embedding_vector_invalid")
                norm = math.sqrt(sum(x * x for x in vector))
                if not norm:
                    raise OperationError("embedding_zero_vector")
                vectors.append([x / norm for x in vector])
            receipt["vector_sha256"] = [hashlib.sha256(json.dumps(v).encode()).hexdigest() for v in vectors]
            return vectors
        except OperationError as error:
            receipt["error"] = str(error)
            raise
        except Exception as error:
            receipt["error"] = "embedding_" + type(error).__name__
            raise OperationError(receipt["error"]) from None
        finally:
            receipt["elapsed_ms"] = (time.perf_counter() - start) * 1000
            self.attempts.append(receipt)
            self._append(receipt)

    def _append(self, receipt: dict) -> None:
        with (self.run_dir / "embedding-calls.jsonl").open("a") as stream:
            stream.write(json.dumps(receipt, ensure_ascii=False) + "\n")
            stream.flush()

    def totals(self) -> dict:
        return {"embedding_api_requests": self.requests, "input_tokens": self.input_tokens,
                "estimated_charge_cny": self.input_tokens * self.config["price_cny_per_1000_input_tokens"] / 1000,
                "unknown_charge_reservation_cny": max(0, self.unknown_charge),
                "failed_requests": sum("error" in r for r in self.attempts)}


class DisabledLLM:
    def __init__(self) -> None:
        self.attempts = 0

    def generate_response(self, *args, **kwargs):
        self.attempts += 1
        raise OperationError("generation_disabled")


class Mem0Embedding:
    def __init__(self, api: EmbeddingAPI) -> None:
        self.api = api

    def embed(self, text, memory_action=None):
        return self.api.embed(text, memory_action or "search")

    def embed_batch(self, texts, memory_action=None):
        return self.api.embed_batch(texts, memory_action or "search")


def metadata(record: dict) -> dict:
    return {"runtime_id": runtime_id(record), "asset_version": record["version"],
            "owner_id": record["owner_id"], "space_id": record["space_id"],
            "verified": record["verified"], "source": record["source"], "scope": record["scope"]}


def filters(principal: dict) -> dict:
    return {"user_id": tenant_id(principal), "owner_id": principal["user_id"], "space_id": principal["space_id"]}


class LexicalCaller:
    def __init__(self, binary: Path, run_dir: Path) -> None:
        self.stderr = (run_dir / "lexical-stderr.log").open("w")
        self.process = subprocess.Popen([str(binary)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=self.stderr, text=True, cwd=ROOT, bufsize=1)
        self.selector = selectors.DefaultSelector()
        self.selector.register(self.process.stdout, selectors.EVENT_READ)

    def search(self, text: str, items: list[dict]) -> tuple[list[dict], dict]:
        self.process.stdin.write(json.dumps({"items": items, "query": text}, ensure_ascii=False) + "\n")
        self.process.stdin.flush()
        if not self.selector.select(timeout=15):
            raise OperationError("lexical_timeout")
        line = self.process.stdout.readline()
        if not line:
            raise OperationError("lexical_process_ended")
        result = json.loads(line)
        candidates = [{"engine_id": r["id"], "runtime_id": r["id"], "version": r["version"],
                       "score": None, "engine_metadata": {k: r.get(k) for k in ("verified", "scope")}}
                      for r in result["memories"]]
        return candidates, {"total": result["total"], "next_asset_after": result["next_asset_after"]}

    def close(self) -> None:
        self.process.stdin.close()
        self.process.wait(timeout=10)
        self.selector.close()
        self.stderr.close()


class VectorIndex:
    def __init__(self, client, name: str, api: EmbeddingAPI) -> None:
        self.client, self.name, self.api = client, name, api

    def prepare(self, records: list[dict]) -> dict:
        from pymilvus import DataType

        if self.client.has_collection(self.name):
            raise OperationError("experiment_collection_exists")
        schema = self.client.create_schema(auto_id=False, enable_dynamic_field=True)
        schema.add_field("id", DataType.VARCHAR, is_primary=True, max_length=128)
        schema.add_field("vector", DataType.FLOAT_VECTOR, dim=self.api.dimensions)
        schema.add_field("metadata", DataType.JSON)
        indexes = self.client.prepare_index_params()
        indexes.add_index(field_name="vector", metric_type="COSINE", index_type="AUTOINDEX")
        self.client.create_collection(collection_name=self.name, schema=schema, index_params=indexes, consistency_level="Strong")
        start = time.perf_counter()
        for offset in range(0, len(records), 20):
            batch = records[offset:offset + 20]
            vectors = self.api.embed_batch([embedding_text(r) for r in batch], "add")
            values = []
            for record, vector in zip(batch, vectors, strict=True):
                attrs = metadata(record)
                attrs.update(filters({"user_id": record["owner_id"], "space_id": record["space_id"]}))
                values.append({"id": str(uuid.uuid5(uuid.UUID(runtime_id(record)), record["version"])),
                               "vector": vector, "metadata": attrs})
            self.client.insert(collection_name=self.name, data=values)
        self.client.flush(collection_name=self.name)
        return {"records": len(records), "insert_embedding_ms": (time.perf_counter() - start) * 1000}

    def search(self, text: str, principal: dict) -> tuple[list[dict], dict]:
        vector = self.api.embed(text, "search")
        expression = " and ".join(f'metadata[{json.dumps(k)}] == {json.dumps(v)}' for k, v in filters(principal).items())
        rows = self.client.search(collection_name=self.name, data=[vector], anns_field="vector",
                                  filter=expression, limit=20, output_fields=["metadata"],
                                  consistency_level="Strong", timeout=15)[0]
        result = [{"engine_id": str(r["id"]), "runtime_id": r["entity"]["metadata"]["runtime_id"],
                   "version": r["entity"]["metadata"]["asset_version"], "score": r["distance"],
                   "engine_metadata": r["entity"]["metadata"]} for r in rows]
        return result, {"filter": filters(principal), "backend_candidate_limit": 20}


class Mem0Index:
    def __init__(self, config: dict, name: str, api: EmbeddingAPI, run_dir: Path, blocked_llm: DisabledLLM) -> None:
        os.environ["MEM0_TELEMETRY"] = "False"
        os.environ["MEM0_DIR"] = str(run_dir / "mem0")
        from mem0 import Memory
        from mem0.utils.factory import EmbedderFactory, LlmFactory

        self.name, self.api, self.run_dir = name, api, run_dir
        self.trace: list[dict] = []
        token = "root:" + (ROOT / config["milvus_token_file"]).read_text().strip()
        settings = {"vector_store": {"provider": "milvus", "config": {
            "url": config["milvus_url"], "token": token, "collection_name": name,
            "embedding_model_dims": api.dimensions, "metric_type": "COSINE", "db_name": "default"}},
            "embedder": {"provider": "openai", "config": {"model": config["model"], "embedding_dims": api.dimensions}},
            "llm": {"provider": "openai", "config": {"enable_vision": False}},
            "history_db_path": str(run_dir / (name + "-history.sqlite")), "reranker": None}
        # SDK没有实例注入参数；只替换模型工厂接缝，检索/写入/排序仍调用锁定的真实Mem0。
        with patch.object(EmbedderFactory, "create", return_value=Mem0Embedding(api)), patch.object(LlmFactory, "create", return_value=blocked_llm):
            self.memory = Memory.from_config(settings)
        self._observe_backend("search")
        self._observe_backend("keyword_search")

    def _observe_backend(self, method: str) -> None:
        original = getattr(self.memory.vector_store, method)

        def observed(*args, **kwargs):
            rows = original(*args, **kwargs)
            self.trace.append({"method": method, "available": rows is not None, "requested_limit": kwargs.get("top_k"),
                               "filters": kwargs.get("filters"), "results": [
                {"engine_id": str(r.id), "runtime_id": r.payload.get("runtime_id"),
                 "version": r.payload.get("asset_version"), "owner_id": r.payload.get("owner_id"),
                 "space_id": r.payload.get("space_id"), "score": r.score} for r in rows or []]})
            return rows

        setattr(self.memory.vector_store, method, observed)

    def prepare(self, records: list[dict]) -> dict:
        mapping = {}
        for record in records:
            attrs = metadata(record)
            receipt = self.memory.add(embedding_text(record), user_id=tenant_id({"user_id": record["owner_id"], "space_id": record["space_id"]}), metadata=attrs, infer=False)
            if len(receipt.get("results", [])) != 1:
                raise OperationError("mem0_add_receipt_invalid")
            result = receipt["results"][0]
            if result["memory"] != embedding_text(record):
                raise OperationError("mem0_changed_embedding_text")
            mapping[result["id"]] = {"runtime_id": runtime_id(record), "version": record["version"]}
        self.memory.vector_store.client.flush(collection_name=self.name)
        write_json(self.run_dir / (self.name + "-id-map.json"), mapping)
        return {"records": len(records), "bm25_schema": self.memory.vector_store._has_bm25_schema,
                "entity_store_created": self.memory._entity_store is not None,
                "reranker": self.memory.reranker is not None, "threshold": 0.0,
                "internal_candidate_limit": 80, "api_version": self.memory.api_version}

    def search(self, text: str, principal: dict) -> tuple[list[dict], dict]:
        self.trace = []
        receipt = self.memory.search(text, top_k=20, filters=filters(principal), threshold=0.0, rerank=False, explain=True)
        result = [{"engine_id": r["id"], "runtime_id": r["metadata"]["runtime_id"],
                   "version": r["metadata"]["asset_version"], "score": r["score"],
                   "engine_metadata": r["metadata"], "score_details": r.get("score_details")}
                  for r in receipt["results"]]
        return result, {"filter": filters(principal), "backend": self.trace}

    def close(self) -> None:
        self.memory.db.close()
        self.memory.vector_store.client.close()
