"""验证真实 HTTP 连接占满记忆侧车时等待线程不会继续增加。"""
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler
from pathlib import Path
import socket
import sys
import threading
import unittest

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "apps/memory"))
from server import MemoryServer


class MemoryServerCapacityTests(unittest.TestCase):
    def test_incomplete_http_request_releases_its_connection(self):
        class Server(MemoryServer):
            client_io_timeout = 0.25

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_GET(self):
                self.send_response(200)
                self.end_headers()

        with Server(("127.0.0.1", 0), Handler) as server:
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

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_GET(self):
                ticket = int(self.path[1:])
                if ticket < 32:
                    with lock:
                        workers.add(threading.get_ident())
                        if len(workers) == 32:
                            arrived.set()
                    if not release.wait(10):
                        raise TimeoutError("合成慢请求未释放")
                self.send_response(200)
                self.end_headers()

        with MemoryServer(("127.0.0.1", 0), Handler) as server:
            loop = threading.Thread(target=server.serve_forever)
            loop.start()
            address = f"http://127.0.0.1:{server.server_port}"
            try:
                with httpx.Client(trust_env=False, timeout=12) as client, ThreadPoolExecutor(32) as callers:
                    waiting = [callers.submit(client.get, f"{address}/{i}") for i in range(32)]
                    try:
                        self.assertTrue(arrived.wait(8), "32 个请求应同时进入服务")
                        rejected = client.get(f"{address}/32")
                        self.assertEqual(rejected.status_code, 503)
                        self.assertEqual(rejected.json(), {"error": "memory_busy"})
                    finally:
                        release.set()
                    self.assertEqual([item.result().status_code for item in waiting], [200] * 32)
                    self.assertEqual(client.get(f"{address}/33").status_code, 200)
            finally:
                server.shutdown()
                loop.join()
