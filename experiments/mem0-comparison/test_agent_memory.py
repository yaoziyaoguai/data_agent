"""Mem0外部边界用可控替身；只验证应用的提交隔离，不冒称模型提取准确率。"""
import importlib.util
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest

spec = importlib.util.spec_from_file_location('agent_memory', Path(__file__).with_name('agent-memory-service.py'))
service_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(service_module)


class MemoryDouble:
    def __init__(self):
        self.rows = []
        self.calls = []
        self.texts = ['以后默认web']
        self.vector_store = SimpleNamespace(client=SimpleNamespace(flush=lambda **kw: None), get=self.get, update=self.update)

    def get(self, memory_id):
        return SimpleNamespace(payload=next(row['metadata'] for row in self.rows if row['id'] == memory_id))

    def update(self, memory_id, payload):
        next(row for row in self.rows if row['id'] == memory_id)['metadata'] = payload

    def add(self, messages, **kwargs):
        self.calls.append((messages, kwargs))
        rows = [{'id': str(len(self.rows) + i), 'memory': text, 'metadata': kwargs['metadata']}
                for i, text in enumerate(self.texts)]
        self.rows.extend(rows)
        return {'results': rows}

    def search(self, query, **kwargs):
        return {'results': [r for r in self.rows if r['metadata'].get('commit_state') == 'ready'][:kwargs['top_k']]}

    def delete(self, memory_id):
        self.rows = [row for row in self.rows if row['id'] != memory_id]


class CommitBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.service = service_module.MemoryService.__new__(service_module.MemoryService)
        self.service.directory = Path(self.tmp.name)
        self.memory = MemoryDouble()
        self.service.indexes = {'case': SimpleNamespace(memory=self.memory, name='test', trace=[])}
        self.service.sources = {'case': {}}
        self.service.operations = {}
        self.service.collections = {'case': 'test'}
        self.principal = {'user_id': 'alice', 'space_id': 'demo'}
        self.source = '请记住以后默认web。但这次查询全部渠道。'
        self.quote = '请记住以后默认web。'

    def call(self, action, **kw):
        return self.service.operate({'action': action, 'case': 'case', 'principal': self.principal, **kw})

    def prepare(self, operation='one', **kw):
        return self.call('prepare', operation=operation, message=self.source, quote=self.quote, **kw)

    def asset(self, body='以后默认web', version='1', state='enabled'):
        return {'id': 'asset', 'version': version, 'state': state, 'body': body}

    def search(self):
        return self.call('search', query='默认渠道')['results']

    def test_pending_never_adopted_and_formal_body_is_extracted_body(self):
        prepared = self.prepare()
        self.assertEqual(self.search(), [])
        self.assertEqual(self.memory.calls[0][0], [{'role': 'user', 'content': self.source}])
        self.call('commit', operation='one', asset=self.asset())
        self.assertEqual(self.search()[0]['metadata']['runtime_id'], 'asset')
        self.assertEqual(prepared['body'], self.search()[0]['memory'])

    def test_formal_save_failure_does_not_contaminate_next_extraction(self):
        self.prepare()
        self.assertEqual(self.search(), [])
        self.prepare('another')
        self.assertEqual([call[1]['run_id'] for call in self.memory.calls], ['one', 'another'])
        self.assertEqual(self.search(), [])

    def test_replay_keeps_exact_body_and_rejects_changed_source(self):
        first = self.prepare()
        self.assertEqual(self.prepare()['body'], first['body'])
        self.assertEqual(len(self.memory.calls), 1)
        with self.assertRaisesRegex(service_module.OperationError, 'idempotency_conflict'):
            self.call('prepare', operation='one', message='请记住以后默认app。', quote='请记住以后默认app。')

    def test_failed_extraction_is_sticky_without_paid_retry(self):
        for fault in ['extraction_unavailable', None]:
            with self.assertRaisesRegex(service_module.OperationError, 'synthetic_extraction_unavailable'):
                self.prepare(fault=fault)
        self.assertEqual(self.memory.calls, [])

    def test_empty_extraction_is_not_pi_body_fallback(self):
        self.memory.texts = []
        with self.assertRaisesRegex(service_module.OperationError, 'no_usable_fact'):
            self.prepare()
        self.assertEqual(self.search(), [])

    def test_revision_and_disable_remove_old_adoption(self):
        self.prepare()
        self.call('commit', operation='one', asset=self.asset())
        self.memory.texts = ['以后默认app']
        self.prepare('two')
        self.call('commit', operation='two', asset=self.asset('以后默认app', '2'))
        self.assertEqual([r['metadata']['asset_version'] for r in self.search()], ['2'])
        self.call('commit', asset=self.asset('以后默认app', '3', 'disabled'))
        self.assertEqual(self.search(), [])

    def test_wrong_body_and_commit_failure_cannot_publish(self):
        self.prepare()
        with self.assertRaisesRegex(service_module.OperationError, 'formal_body_mismatch'):
            self.call('commit', operation='one', asset=self.asset('Pi原始正文'))
        self.assertEqual(self.search(), [])
        with self.assertRaisesRegex(service_module.OperationError, 'synthetic_index_commit_unavailable'):
            self.call('commit', operation='one', asset=self.asset(version='2'), fault='index_commit_unavailable')
        self.assertEqual(self.search(), [])

    def test_other_principal_cannot_adopt_committed_candidate(self):
        self.prepare()
        self.call('commit', operation='one', asset=self.asset())
        self.principal = {'user_id': 'bob', 'space_id': 'demo'}
        self.assertEqual(self.search(), [])

    def test_candidate_cannot_be_shared_by_two_formal_assets(self):
        self.prepare()
        self.call('commit', operation='one', asset=self.asset())
        with self.assertRaisesRegex(service_module.OperationError, 'candidate_already_bound'):
            self.call('commit', operation='one', asset={**self.asset(), 'id': 'second'})
        self.assertEqual([r['metadata']['runtime_id'] for r in self.search()], ['asset'])

    def test_pending_candidates_cannot_crowd_committed_top_k(self):
        for i in range(21):
            self.prepare(str(i))
        self.prepare('committed')
        self.call('commit', operation='committed', asset=self.asset())
        self.assertEqual(len(self.search()), 1)

    def test_multiple_facts_are_joined_without_answer_based_selection(self):
        self.memory.texts = ['金额默认用元', '保留到分的精度']
        self.assertEqual(self.prepare()['body'], '金额默认用元\n保留到分的精度')


if __name__ == '__main__':
    unittest.main()
