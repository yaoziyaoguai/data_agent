"""使用锁定的真实Mem0 SDK，只替换网络；未知回执不能触发SDK隐式重试。"""
import importlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'apps/memory'))
from providers import BudgetedEmbedding, ModelGateway
from service import MemoryService
from store import MemoryError, ReceiptStore

os.environ['MEM0_TELEMETRY'] = 'False'


class SdkFailureTests(unittest.TestCase):
    def test_batch_timeout_cannot_issue_sdk_individual_fallback_requests(self):
        main = importlib.import_module('mem0.memory.main')
        sent, permits = [], []
        with tempfile.TemporaryDirectory() as directory:
            store = ReceiptStore(Path(directory) / 'receipts.sqlite')
            gateway = ModelGateway.__new__(ModelGateway)
            gateway.store, gateway.failure = store, None
            gateway.binding = {'operation_id': 'synthetic-operation'}
            gateway.config = {'embedding_url': 'http://127.0.0.1/synthetic'}
            gateway.embedding_key = 'synthetic-not-a-key'
            gateway.host = lambda value: permits.append(value) or {'send_allowed': True}

            def post(_url, **kwargs):
                sent.append(kwargs['json']['input'])
                if len(sent) == 2:
                    raise httpx.ReadTimeout('synthetic_unknown_receipt')
                return SimpleNamespace(status_code=200, json=lambda: {
                    'usage': {'prompt_tokens': 1},
                    'data': [{'index': i, 'embedding': [1.0] + [0.0] * 1023} for i, _ in enumerate(sent[-1])]})

            gateway.client = SimpleNamespace(post=post)
            memory = main.Memory.__new__(main.Memory)
            memory.api_version, memory.custom_instructions = 'v1.1', None
            memory.db = SimpleNamespace(get_last_messages=lambda *_, **__: [], save_messages=lambda *_: None, batch_add_history=lambda *_: None)
            memory.vector_store = SimpleNamespace(search=lambda **_: [], insert=lambda **_: None)
            memory.llm = SimpleNamespace(generate_response=lambda **_: json.dumps({'memory': [{'text': '默认展示元'}, {'text': '默认只看web'}]}))
            memory.embedding_model = BudgetedEmbedding(gateway)
            service = MemoryService.__new__(MemoryService)
            service.gateway, service.store, service.fingerprint = gateway, store, 'synthetic'
            service.memory = SimpleNamespace(add=lambda messages, **_: {'results': memory._add_to_vector_store(
                messages, {'user_id': 'alice'}, {'user_id': 'alice', 'run_id': 'synthetic-operation'}, True)})
            with patch.object(main, 'extract_entities_batch', side_effect=lambda texts: [[] for _ in texts]), patch.object(main, 'lemmatize_for_bm25', side_effect=lambda text: text), patch.object(main, 'capture_event'):
                with self.assertRaisesRegex(MemoryError, 'memory_operation_unknown'):
                    service.extract({'operation_id': 'synthetic-operation', 'owner_id': 'alice', 'space_id': 'demo', 'message': '请记住默认展示元并只看web', 'quote': '请记住默认展示元并只看web'})
            self.assertEqual(len(sent), 2)
            self.assertEqual(sum(v['action'] == 'issue' for v in permits), 2)
            self.assertEqual(sum(v['action'] == 'finalize' and v['usage'] is None for v in permits), 1)
            store.db.close()


if __name__ == '__main__':
    unittest.main()
