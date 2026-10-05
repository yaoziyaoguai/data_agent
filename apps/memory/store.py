"""Mem0技术回执；正式个人资产仍由Rust/MySQL管理。"""
import json
import sqlite3


class MemoryError(Exception):
    pass


class ReceiptStore:
    def __init__(self, path):
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.executescript("""
        CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, state TEXT NOT NULL, result TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS assets(identity TEXT PRIMARY KEY, version INTEGER NOT NULL, state TEXT NOT NULL, memory_ids TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS provider_calls(id TEXT PRIMARY KEY, input TEXT NOT NULL, usage TEXT, state TEXT NOT NULL);
        """)

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
