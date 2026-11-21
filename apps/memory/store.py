"""Mem0技术回执；正式个人资产仍由Rust/MySQL管理。WAL下各线程独立连接并发读，写由SQLite自身串行。"""
import json
import sqlite3
import threading


class MemoryError(Exception):
    pass


class ReceiptStore:
    def __init__(self, path):
        self.path = path
        self._local = threading.local()
        # 建表只跑一次；WAL让各线程的独立连接并发读取互不阻塞。
        self.db.executescript("""
        CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, state TEXT NOT NULL, result TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS assets(identity TEXT PRIMARY KEY, version INTEGER NOT NULL, state TEXT NOT NULL, memory_ids TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS provider_calls(id TEXT PRIMARY KEY, input TEXT NOT NULL, usage TEXT, state TEXT NOT NULL);
        """)

    @property
    def db(self):
        # 线程局部连接：检索与提取并发时不再共用一个连接互相阻塞；
        # 写入竞争交给SQLite写锁，busy_timeout内自动等待而非立即报错。
        db = getattr(self._local, "db", None)
        if db is None:
            db = sqlite3.connect(self.path, check_same_thread=False)
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("PRAGMA synchronous=FULL")
            db.execute("PRAGMA busy_timeout=5000")
            self._local.db = db
        return db

    def operation(self, key, fingerprint):
        row = self.db.execute("SELECT fingerprint,state,result FROM operations WHERE id=?", (key,)).fetchone()
        if row and row[0] != fingerprint:
            raise MemoryError("idempotency_conflict")
        return {"state": row[1], **json.loads(row[2])} if row else None

    def write_operation(self, key, fingerprint, state, value):
        with self.db:
            self.db.execute("INSERT INTO operations VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,result=excluded.result",
                            (key, fingerprint, state, json.dumps(value, ensure_ascii=False)))

    def asset(self, key):
        row = self.db.execute("SELECT version,state,memory_ids FROM assets WHERE identity=?", (key,)).fetchone()
        return {"version": row[0], "state": row[1], "memory_ids": json.loads(row[2])} if row else None

    def write_asset(self, key, version, state, ids):
        with self.db:
            self.db.execute("INSERT INTO assets VALUES(?,?,?,?) ON CONFLICT(identity) DO UPDATE SET version=excluded.version,state=excluded.state,memory_ids=excluded.memory_ids",
                            (key, version, state, json.dumps(ids)))

    def call(self, envelope, usage=None, state="issued"):
        with self.db:
            self.db.execute("INSERT INTO provider_calls VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET usage=excluded.usage,state=excluded.state",
                            (envelope["call_attempt_id"], json.dumps(envelope), json.dumps(usage), state))

    def unsettled(self):
        return [(json.loads(row[0]), json.loads(row[1])) for row in self.db.execute("SELECT input,usage FROM provider_calls WHERE state='received'")]
