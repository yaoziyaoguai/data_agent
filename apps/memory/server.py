"""本机Mem0适配进程：同源JSON Schema、内部凭据及独立的记忆对账线程。"""
import argparse
import fcntl
import json
import os
import re
import threading
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

import time
_started = time.monotonic()
print("startup service=memory stage=imports_started", flush=True)
import jsonschema
from service import MemoryService
print(f"startup service=memory stage=imports_ready elapsed={time.monotonic()-_started:.2f}s", flush=True)
from store import MemoryError

ROOT = Path(__file__).resolve().parents[2]
CONTRACT = json.loads((ROOT / "packages/contracts/schema.json").read_text())
ROUTES = {"/extract": ("MemoryExtractionRequest", "MemoryExtractionReceipt"),
          "/index": ("MemoryIndexRequest", "MemoryIndexReceipt"), "/search": ("MemorySearchRequest", "MemorySearchReceipt")}
VALIDATORS = {
    name: jsonschema.Draft202012Validator(
        {"$ref": "#/$defs/" + name, "$defs": CONTRACT["$defs"]},
        format_checker=jsonschema.Draft202012Validator.FORMAT_CHECKER,
    )
    for schemas in ROUTES.values() for name in schemas
}


class MemoryServer(ThreadingHTTPServer):
    request_queue_size = 64
    worker_limit = 32
    connection_limit = 48
    client_io_timeout = 10

    def __init__(self, address, service, token):
        self.service = service
        self.token = token
        self.slots = threading.BoundedSemaphore(self.worker_limit)
        self.connections = threading.BoundedSemaphore(self.connection_limit)
        self.workers = ThreadPoolExecutor(max_workers=self.connection_limit)
        super().__init__(address, MemoryHandler)

    def process_request(self, request, client_address):
        # 正文读取槽满时暂停接入，让监听队列施加反压，避免重置已发送的 POST。
        self.connections.acquire()
        request.settimeout(self.client_io_timeout)
        self.workers.submit(self.serve_request, request, client_address)

    def serve_request(self, request, client_address):
        try:
            self.process_request_thread(request, client_address)
        finally:
            self.connections.release()

    def server_close(self):
        super().server_close()
        self.workers.shutdown()


class MemoryHandler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def reply(self, status, value):
        data = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.reply(200 if self.path == "/health" else 404, {"provider": "mem0", "version": "2.2.1"})

    def do_POST(self):
        if self.headers.get("Authorization") != "Bearer " + self.server.token:
            return self.reply(401, {"error": "unauthenticated"})
        if self.path not in ROUTES:
            return self.reply(404, {"error": "not_available"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return self.reply(400, {"error": "invalid_input"})
        if not 0 < length <= 131072:
            return self.reply(400, {"error": "invalid_input"})
        # 先接收有界正文再拒绝业务过载，避免关连接时重置仍在发送的客户端。
        body = self.rfile.read(length)
        if not self.server.slots.acquire(blocking=False):
            return self.reply(503, {"error": "memory_busy"})
        try:
            request_schema, response_schema = ROUTES[self.path]
            request = json.loads(body)
            VALIDATORS[request_schema].validate(request)
            value = self.server.service.handle(self.path, request)
            VALIDATORS[response_schema].validate(value)
            status = 200
        except (json.JSONDecodeError, jsonschema.ValidationError, ValueError):
            status, value = 400, {"error": "invalid_input"}
        except Exception as e:
            code = str(e) if isinstance(e, MemoryError) else "memory_unavailable"
            print("memory_operation_failed code=" + (code if isinstance(e, MemoryError) else type(e).__name__), flush=True)
            status, value = 503, {"error": code}
        finally:
            self.server.slots.release()
        self.reply(status, value)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--configuration", type=Path, required=True)
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()
    config = json.loads(args.configuration.read_text())
    for key, expected in [("model_url", "https://api.deepseek.com/chat/completions"), ("embedding_url", "https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings")]:
        url = urlparse(config[key])
        testing = os.environ.get("DATA_AGENT_MEMORY_TEST") == "1" and url.scheme == "http" and url.hostname == "127.0.0.1"
        if config[key] != expected and not testing:
            raise RuntimeError("memory_endpoint_invalid")
    if not re.fullmatch(r"[A-Za-z0-9_]{1,128}", config["collection"]):
        raise RuntimeError("memory_collection_invalid")
    os.umask(0o077)
    args.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    process_lock = (args.directory / 'service.lock').open('a')
    fcntl.flock(process_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    service = MemoryService(config, args.directory)
    token = os.environ["DATA_AGENT_INTERNAL_TOKEN"]
    if len(token) < 32:
        raise RuntimeError("memory_token_invalid")

    with MemoryServer((os.environ.get("DATA_AGENT_BIND_HOST", "127.0.0.1"), args.port), service, token) as server:
        print(f"startup service=memory stage=listening elapsed={time.monotonic()-_started:.2f}s", flush=True)
        stop = threading.Event()
        threading.Thread(target=service.maintain, args=(stop,), daemon=True).start()
        try:
            server.serve_forever()
        finally:
            stop.set()


if __name__ == "__main__":
    main()
