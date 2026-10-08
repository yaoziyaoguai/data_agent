"""本机Mem0适配进程：显式配置、同源JSON Schema、内部凭据及串行SDK访问。"""
import argparse
import fcntl
import json
import os
import re
import threading
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


def validate(name, value):
    jsonschema.Draft202012Validator({"$ref": "#/$defs/" + name, "$defs": CONTRACT["$defs"]}).validate(value)


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
    lock = threading.Lock()
    token = os.environ["DATA_AGENT_INTERNAL_TOKEN"]
    if len(token) < 32:
        raise RuntimeError("memory_token_invalid")

    class Handler(BaseHTTPRequestHandler):
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
            if self.headers.get("Authorization") != "Bearer " + token:
                return self.reply(401, {"error": "unauthenticated"})
            if self.path not in ROUTES:
                return self.reply(404, {"error": "not_available"})
            if not lock.acquire(timeout=3):
                return self.reply(503, {"error": "memory_unavailable"})
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 131072:
                    raise MemoryError("invalid_input")
                request = json.loads(self.rfile.read(length))
                request_schema, response_schema = ROUTES[self.path]
                validate(request_schema, request)
                value = service.handle(self.path, request)
                validate(response_schema, value)
                self.reply(200, value)
            except (json.JSONDecodeError, jsonschema.ValidationError, ValueError):
                self.reply(400, {"error": "invalid_input"})
            except Exception as e:
                code = str(e) if isinstance(e, MemoryError) else "memory_unavailable"
                print("memory_operation_failed code=" + (code if isinstance(e, MemoryError) else type(e).__name__), flush=True)
                self.reply(503, {"error": code})
            finally:
                service.gateway.binding = None
                lock.release()

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"startup service=memory stage=listening elapsed={time.monotonic()-_started:.2f}s", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
