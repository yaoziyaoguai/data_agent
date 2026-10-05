"""检查正式记忆接缝的失败/重启行为；不把测试替身当作Mem0质量证据。"""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "apps/memory"))
from service import MemoryService
from store import MemoryError, ReceiptStore


class VectorStore:
    def __init__(self):
        self.records = {}
        self.fail_update = False
        self.client = self

    def get(self, key):
        return SimpleNamespace(payload=self.records[key]) if key in self.records else None

    def update(self, key, payload):
        if self.fail_update:
            self.fail_update = False
            raise RuntimeError("transient_vector_failure")
        self.records[key] = payload

    def flush(self, **_kwargs):
        pass


class FakeMemory:
    def __init__(self):
        self.vector_store = VectorStore()
        self.collection_name = "synthetic"
        self.add_calls = []
        self.fail_extract = False

    def add(self, content, **kwargs):
        self.add_calls.append((content, kwargs))
        if self.fail_extract:
            raise MemoryError("memory_operation_unknown")
        key = "candidate-" + str(len(self.add_calls))
        self.vector_store.records[key] = {**kwargs["metadata"], "user_id": kwargs["user_id"]}
        return {"results": [{"id": key, "memory": "金额默认以元展示" if kwargs["infer"] else content}]}

    def delete(self, key):
        self.vector_store.records.pop(key, None)

    def search(self, query, **kwargs):
        return {"results": [{"id": key, "metadata": value} for key, value in self.vector_store.records.items()
                            if all(value.get(k) == v for k, v in kwargs["filters"].items())][:kwargs["top_k"]]}


class ReceiptTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / "receipts.sqlite"
        self.service = self.load()
        self.message = {"owner_id": "alice", "space_id": "demo", "operation_id": "save-1", "message": "请记住以后金额用元展示。", "quote": "请记住以后金额用元展示。"}

    def load(self):
        service = MemoryService.__new__(MemoryService)
        service.store, service.memory = ReceiptStore(self.path), FakeMemory()
        service.fingerprint = "fixed-configuration"
        return service

    def tearDown(self):
        self.service.store.db.close()
        self.directory.cleanup()

    def apply(self, version="1", state="enabled", operation="index-1", extraction="save-1", asset_id="asset-1"):
        return {**self.message, "operation_id": operation, "extraction_operation_id": extraction,
                "asset": {"id": asset_id, "version": version, "state": state, "body": "金额默认以元展示"}}

    def search(self, owner="alice", space="demo"):
        return self.service.search_current({"owner_id": owner, "space_id": space, "query": "收入单位"})["candidates"]

    def test_prepared_candidate_is_invisible_until_formal_commit(self):
        self.service.extract(self.message)
        self.assertEqual(self.search(), [])
        self.service.index(self.apply())
        self.assertEqual(self.search(), [{"asset_id": "asset-1", "version": "1"}])
        self.assertEqual(self.search("bob"), [])
        self.assertEqual(self.search(space="another"), [])

    def test_extract_replays_after_process_restart_without_new_model_call(self):
        first = self.service.extract(self.message)
        self.service.store.db.close()
        self.service = self.load()
        repeated = self.service.extract(self.message)
        self.assertEqual(first["body"], repeated["body"])
        self.assertTrue(repeated["replayed"])
        self.assertEqual(self.service.memory.add_calls, [])
        with self.assertRaisesRegex(MemoryError, "idempotency_conflict"):
            self.service.extract({**self.message, "quote": "其他指令"})

    def test_unknown_extraction_is_not_reissued(self):
        self.service.memory.fail_extract = True
        for _ in range(2):
            with self.assertRaisesRegex(MemoryError, "memory_operation_unknown"):
                self.service.extract(self.message)
        self.assertEqual(len(self.service.memory.add_calls), 1)
        self.assertEqual(self.search(), [])

    def test_failed_index_commit_can_resume_without_inference(self):
        self.service.extract(self.message)
        self.service.memory.vector_store.fail_update = True
        with self.assertRaisesRegex(RuntimeError, "transient_vector_failure"):
            self.service.index(self.apply())
        self.assertEqual(self.search(), [])
        self.assertEqual(self.service.index(self.apply())["state"], "ready")
        self.assertEqual(len(self.service.memory.add_calls), 1)
        self.assertEqual(len(self.search()), 1)

    def test_old_enabled_job_cannot_revive_disabled_memory(self):
        self.service.extract(self.message)
        self.service.index(self.apply())
        self.service.index(self.apply("2", "disabled", "disable-2", None))
        self.assertEqual(self.service.index(self.apply())["state"], "superseded")
        self.assertEqual(self.search(), [])

    def test_prepared_candidate_cannot_belong_to_two_assets(self):
        self.service.extract(self.message)
        self.service.index(self.apply())
        with self.assertRaisesRegex(MemoryError, "idempotency_conflict"):
            self.service.index(self.apply(operation="index-other", asset_id="asset-other"))

    def test_manual_edit_is_indexed_verbatim_without_inference(self):
        request = self.apply(extraction=None)
        request["asset"]["body"] = "这是用户逐字写下的正式内容"
        self.service.index(request)
        content, options = self.service.memory.add_calls[0]
        self.assertEqual(content, request["asset"]["body"])
        self.assertIs(options["infer"], False)
        self.service.index(request)
        self.assertEqual(len(self.service.memory.add_calls), 1)

    def test_final_body_must_match_prepared_body(self):
        self.service.extract(self.message)
        request = self.apply()
        request["asset"]["body"] = "另一个未经提取的正文"
        with self.assertRaisesRegex(MemoryError, "idempotency_conflict"):
            self.service.index(request)
        self.assertEqual(self.search(), [])


if __name__ == "__main__":
    unittest.main()
