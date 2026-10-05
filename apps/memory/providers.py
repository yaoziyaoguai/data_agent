"""只转换Mem0的模型调用；每次请求均由Rust原预算许可，不创建Agent循环。"""
import hashlib
import json
import math
import os
import time
import uuid
from pathlib import Path

import httpx
from store import MemoryError


class ModelGateway:
    def __init__(self, config, store):
        self.config, self.store = config, store
        self.client = httpx.Client(timeout=90, trust_env=False, follow_redirects=False)
        self.binding = None
        self.failure = None
        self.token = os.environ["DATA_AGENT_INTERNAL_TOKEN"]
        self.key = os.environ["DEEPSEEK_API_KEY"]
        self.embedding_key = Path(config["embedding_key_file"]).read_text().strip()

    def host(self, envelope):
        r = self.client.post(os.environ["DATA_AGENT_API_URL"] + "/internal/memory/model-calls",
                             headers={"Authorization": "Bearer " + self.token}, json=envelope, timeout=10)
        if r.status_code != 200:
            code = r.json().get("code")
            raise MemoryError(code if code in {"budget_exhausted", "lease_lost", "idempotency_conflict"} else "memory_unavailable")
        return r.json()

    def settle_pending(self):
        for envelope, usage in self.store.unsettled():
            self.host({**envelope, "action": "finalize", "usage": usage})
            self.store.call(envelope, usage, "settled")

    def call(self, purpose, payload, input_upper):
        if self.failure:
            raise MemoryError(self.failure)
        try:
            return self._call(purpose, payload, input_upper)
        except Exception as error:
            # SDK会在batch失败后逐条fallback；同一操作一旦失败就禁止继续发送。
            self.failure = str(error) if isinstance(error, MemoryError) else 'memory_operation_unknown'
            raise MemoryError(self.failure) from None

    def _call(self, purpose, payload, input_upper):
        raw = json.dumps(payload, ensure_ascii=False).encode()
        if not self.binding or input_upper < 1 or input_upper > (8192 if purpose == "memory_embedding" else 65536):
            raise MemoryError("memory_unavailable")
        envelope = {"action": "issue", "budget": self.binding, "call_attempt_id": str(uuid.uuid4()),
                    "purpose": purpose, "parameters_fingerprint": hashlib.sha256(raw).hexdigest(),
                    "input_tokens_upper": input_upper, "output_tokens_max": 0 if purpose == "memory_embedding" else 4096, "usage": None}
        self.store.call(envelope)
        if not self.host(envelope)["send_allowed"]:
            raise MemoryError("memory_operation_unknown")
        start, usage = time.monotonic(), None
        try:
            endpoint = self.config["embedding_url"] if purpose == "memory_embedding" else self.config["model_url"]
            key = self.embedding_key if purpose == "memory_embedding" else self.key
            r = self.client.post(endpoint, headers={"Authorization": "Bearer " + key}, json=payload)
            if r.status_code != 200:
                raise MemoryError("memory_unavailable")
            value = r.json()
            raw_usage = value.get("usage", {})
            tokens = raw_usage.get("prompt_tokens", raw_usage.get("total_tokens"))
            output = 0 if purpose == "memory_embedding" else raw_usage.get("completion_tokens")
            if type(tokens) is not int or type(output) is not int or tokens < 0 or output < 0:
                raise MemoryError("memory_operation_unknown")
            usage = {"input_tokens": tokens, "output_tokens": output, "elapsed_ms": min(120000, round((time.monotonic() - start)*1000))}
            # 内容格式有误也先保存真实usage；结算回执丢失仅重送同一结算。
            self.store.call(envelope, usage, "received")
            self.host({**envelope, "action": "finalize", "usage": usage})
            self.store.call(envelope, usage, "settled")
            if tokens > input_upper or output > envelope["output_tokens_max"]:
                raise MemoryError("budget_exhausted")
            return value
        except (httpx.HTTPError, ValueError, KeyError):
            raise MemoryError("memory_operation_unknown") from None
        finally:
            if usage is None:
                try:
                    self.host({**envelope, "action": "finalize", "usage": None})
                except (MemoryError, httpx.HTTPError):
                    pass  # 已发送的Rust预留继续保持issued/unknown，不释放或自动重发。


class BudgetedLLM:
    def __init__(self, gateway):
        self.gateway = gateway

    def generate_response(self, messages, response_format=None, **_kwargs):
        payload = {"model": "deepseek-flash", "messages": messages, "max_tokens": 4096,
                   "thinking": {"type": "disabled"}, "stream": False}
        if response_format:
            payload["response_format"] = response_format
        value = self.gateway.call("memory_extraction", payload, len(json.dumps(payload, ensure_ascii=False).encode()))
        choice = value["choices"][0]
        if choice.get("finish_reason") != "stop":
            raise MemoryError("memory_unavailable")
        return choice["message"]["content"]


class BudgetedEmbedding:
    def __init__(self, gateway):
        self.gateway = gateway

    def embed(self, text, memory_action=None):
        return self.embed_batch([text], memory_action)[0]

    def embed_batch(self, texts, memory_action=None):
        if not texts or len(texts) > 20:
            raise MemoryError("memory_unavailable")
        value = self.gateway.call("memory_embedding", {"model": "qwen3.7-text-embedding", "input": texts,
                                  "dimensions": 1024, "encoding_format": "float"}, sum(len(t.encode()) for t in texts))
        items = sorted(value["data"], key=lambda x: x["index"])
        if [v["index"] for v in items] != list(range(len(texts))):
            raise MemoryError("memory_unavailable")
        vectors = []
        for item in items:
            v = item["embedding"]
            if len(v) != 1024 or not all(type(x) in (int, float) and math.isfinite(x) for x in v):
                raise MemoryError("memory_unavailable")
            norm = math.sqrt(sum(x*x for x in v))
            if norm == 0:
                raise MemoryError("memory_unavailable")
            vectors.append([x/norm for x in v])
        return vectors
