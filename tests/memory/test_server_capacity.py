"""验证真实 HTTP 连接占满记忆侧车时等待线程不会继续增加。"""
from concurrent.futures import ThreadPoolExecutor
from http.client import HTTPConnection
import json
from pathlib import Path
from select import select
import socket
import sys
import threading
from types import SimpleNamespace
import unittest

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "apps/memory"))
from server import MemoryServer


class MemoryServerCapacityTests(unittest.TestCase):
    def test_incomplete_http_request_releases_its_connection(self):
        class Server(MemoryServer):
            client_io_timeout = 0.25

        with Server(("127.0.0.1", 0), None, "test-token") as server:
            loop = threading.Thread(target=server.serve_forever)
            loop.start()
            try:
                with socket.create_connection(server.server_address, timeout=2) as incomplete:
                    incomplete.sendall(b"GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n")
                    self.assertEqual(incomplete.recv(1), b"")
                response = httpx.get(f"http://127.0.0.1:{server.server_port}/health", trust_env=False)
                self.assertEqual(response.status_code, 200)
            finally:
                server.shutdown()
                loop.join()

    def test_full_server_rejects_extra_request_and_recovers(self):
        arrived = threading.Event()
        release = threading.Event()
        lock = threading.Lock()
        workers = set()

        def handle(path, request):
            if path == "/search":
                return {"candidates": [], "bounded": False}
            with lock:
                workers.add(threading.get_ident())
                if len(workers) == 32:
                    arrived.set()
            if not release.wait(10):
                raise TimeoutError("合成慢请求未释放")
            return {"operation_id": request["operation_id"], "body": "合成记忆", "replayed": False}

        token = "test-token"
        common = {"operation_id": "test-operation", "owner_id": "alice", "space_id": "test",
                  "budget": {"kind": "run", "id": "run", "epoch": "1",
                             "sdk_tool_call_id": "call", "operation_id": "test-operation"}}
        extract = json.dumps({**common, "message": "合成消息", "quote": "合成消息"}).encode().ljust(96 * 1024)
        search = json.dumps({**common, "query": "合成查询"}).encode().ljust(64 * 1024)

        with MemoryServer(("127.0.0.1", 0), SimpleNamespace(handle=handle), token) as server:
            loop = threading.Thread(target=server.serve_forever)
            loop.start()
            address = f"http://127.0.0.1:{server.server_port}"
            try:
                with httpx.Client(trust_env=False, timeout=12, headers={"Authorization": "Bearer " + token}) as client, ThreadPoolExecutor(48) as callers:
                    waiting = [callers.submit(client.post, address + "/extract", content=extract) for _ in range(32)]
                    try:
                        self.assertTrue(arrived.wait(8), "32 个请求应同时进入服务")
                        rejected = [
                            callers.submit(client.post, address + path, content=body)
                            for path, body in [("/extract", extract), ("/search", search)] * 7 + [("/extract", extract)]
                        ]
                        fragmented = HTTPConnection("127.0.0.1", server.server_port, timeout=4)
                        try:
                            fragmented.putrequest("POST", "/search")
                            fragmented.putheader("Authorization", "Bearer " + token)
                            fragmented.putheader("Content-Length", str(len(search)))
                            fragmented.endheaders(search[:1024])
                            self.assertFalse(select([fragmented.sock], [], [], .25)[0],
                                             "满载拒绝须等客户端发完有界正文")
                            fragmented.send(search[1024:])
                            response = fragmented.getresponse()
                            self.assertEqual(response.status, 503)
                            self.assertEqual(json.loads(response.read()), {"error": "memory_busy"})
                        finally:
                            fragmented.close()
                        for response in [request.result() for request in rejected]:
                            self.assertEqual(response.status_code, 503)
                            self.assertEqual(response.json(), {"error": "memory_busy"})
                    finally:
                        release.set()
                    self.assertEqual([item.result().status_code for item in waiting], [200] * 32)
                    self.assertEqual(client.post(address + "/search", content=search).status_code, 200)
            finally:
                server.shutdown()
                loop.join()
