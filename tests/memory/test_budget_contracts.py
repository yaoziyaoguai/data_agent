"""侧车同源契约接受真实工具、启动检索和后台索引各自的调用身份。"""
import sys
import unittest
from pathlib import Path

import jsonschema

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "apps/memory"))
from server import validate


class BudgetContractTests(unittest.TestCase):
    def request(self, kind, sdk_id):
        return {
            "action": "issue",
            "budget": {"kind": kind, "id": "synthetic-run-or-job", "epoch": "1",
                       "sdk_tool_call_id": sdk_id, "operation_id": "synthetic-operation"},
            "call_attempt_id": "synthetic-call", "purpose": "memory_embedding",
            "parameters_fingerprint": "a" * 64, "input_tokens_upper": 100,
            "output_tokens_max": 0, "usage": None,
        }

    def test_tool_context_and_index_bindings_reach_the_host(self):
        for kind, sdk_id in [("run", "call_1|fc_2"), ("run", None), ("index", None)]:
            with self.subTest(kind=kind, sdk_id=sdk_id):
                validate("MemoryModelCall", self.request(kind, sdk_id))

    def test_index_does_not_invent_sdk_identity_and_tool_ids_remain_validated(self):
        for kind, sdk_id in [("index", "invented-tool"), ("run", ""), ("run", "call\n1")]:
            with self.subTest(kind=kind, sdk_id=sdk_id):
                with self.assertRaises(jsonschema.ValidationError):
                    validate("MemoryModelCall", self.request(kind, sdk_id))


if __name__ == "__main__":
    unittest.main()
