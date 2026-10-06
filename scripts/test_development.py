import os
from pathlib import Path
import tempfile
import unittest

from development import read_model_credentials, memory_configuration, embedding_configuration, with_local_proxy_bypass
from unittest.mock import patch
import json


class ModelCredentialsTest(unittest.TestCase):
    def test_memory_state_is_stable_per_database_and_target(self):
        with tempfile.TemporaryDirectory() as directory, patch('development.ROOT', Path(directory)):
            source = Path(directory) / 'memory.json'
            source.write_text(json.dumps({'collection': 'personal_memory'}))
            first = memory_configuration(source, 'data_agent_trial_aaa')
            self.assertEqual(first, memory_configuration(source, 'data_agent_trial_aaa'))
            self.assertNotEqual(first, memory_configuration(source, 'data_agent_trial_bbb'))
            source.write_text(json.dumps({'collection': 'personal_memory_rebuilt'}))
            self.assertNotEqual(first, memory_configuration(source, 'data_agent_trial_aaa'))

    def test_shared_embedding_uses_private_key_and_separate_stable_collection(self):
        with tempfile.TemporaryDirectory() as directory, patch('development.ROOT', Path(directory)):
            root = Path(directory)
            (root / 'infra').mkdir()
            endpoint = 'https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings'
            (root / 'infra/embedding-model.json').write_text(json.dumps({'endpoint': endpoint}))
            key = root / 'embedding-key'
            key.write_text('synthetic-test-key')
            key.chmod(0o600)
            source = root / 'memory.json'
            source.write_text(json.dumps({'embedding_url': endpoint, 'embedding_key_file': 'embedding-key', 'collection': 'personal_memory'}))
            first = embedding_configuration(source, 'data_agent_trial_aaa')
            self.assertEqual(first, embedding_configuration(source, 'data_agent_trial_aaa'))
            self.assertNotEqual(first['DATA_AGENT_VECTOR_COLLECTION'], embedding_configuration(source, 'data_agent_trial_bbb')['DATA_AGENT_VECTOR_COLLECTION'])
            self.assertTrue(first['DATA_AGENT_VECTOR_COLLECTION'].startswith('data_agent_shared_qwen1024_'))
            self.assertNotIn('synthetic-test-key', json.dumps(first))
            key.chmod(0o644)
            with self.assertRaisesRegex(RuntimeError, '0600'):
                embedding_configuration(source, 'data_agent_trial_aaa')
            key.chmod(0o600)
            source.write_text(json.dumps({'embedding_url': 'https://example.invalid/embeddings', 'embedding_key_file': 'embedding-key'}))
            with self.assertRaisesRegex(RuntimeError, '百炼端点'):
                embedding_configuration(source, 'data_agent_trial_aaa')

    def test_local_grpc_bypasses_proxy_without_losing_existing_exclusions(self):
        source = {'http_proxy': 'http://proxy.example:3128', 'NO_PROXY': 'a.example', 'no_proxy': 'b.example,a.example', 'no_grpc_proxy': 'grpc.example'}
        effective = with_local_proxy_bypass(source)
        self.assertEqual(effective['NO_PROXY'], 'a.example,b.example,grpc.example,127.0.0.1,localhost,::1')
        self.assertEqual(effective['NO_PROXY'], effective['no_proxy'])
        self.assertEqual(effective['NO_PROXY'], effective['no_grpc_proxy'])
        self.assertEqual(effective['http_proxy'], source['http_proxy'])
        self.assertEqual(source['NO_PROXY'], 'a.example')

    def test_legacy_prefill_settings_are_not_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / '.env'
            source.write_text('DEEPSEEK_API_KEY=synthetic-test-key\n'
                              'DEEPSEEK_BASE_URL=https://api.deepseek.com\n'
                              'DEEPSEEK_MODEL=deepseek-flash\n'
                              'DATA_AGENT_PREFILL_PROFILE={"trial_id":"old-trial"}\n'
                              'DATA_AGENT_PREFILL_URL=http://127.0.0.1:1/wrong\n'
                              'DATA_AGENT_PREFILL_TEST=1\n')
            os.chmod(source, 0o600)
            self.assertEqual(set(read_model_credentials(source)), {
                'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_MODEL'})


if __name__ == '__main__':
    unittest.main()
