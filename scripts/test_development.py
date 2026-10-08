import os
import socket
from pathlib import Path
import tempfile
import unittest

from development import read_model_credentials, memory_configuration, embedding_configuration, with_local_proxy_bypass, wait_health, available_ports
from unittest.mock import patch, Mock
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


class StartupHealthTest(unittest.TestCase):
    def test_restart_accepts_closed_connections_in_time_wait(self):
        with socket.socket() as listener:
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.bind(('127.0.0.1', 0))
            listener.listen()
            port = listener.getsockname()[1]
            with socket.create_connection(('127.0.0.1', port)) as client:
                connection, _ = listener.accept()
                connection.close()
                self.assertEqual(client.recv(1), b'')
        with patch('development.PORTS', {'api': port}):
            self.assertEqual(available_ports(0), {'api': port})

    def test_active_listener_is_still_rejected(self):
        with socket.socket() as listener:
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.bind(('127.0.0.1', 0))
            listener.listen()
            with patch('development.PORTS', {'api': listener.getsockname()[1]}):
                with self.assertRaises(OSError):
                    available_ports(0)

    def test_delayed_health_records_actual_service_and_runtime(self):
        process = Mock(); process.poll.return_value = None
        response = Mock(); response.__enter__ = Mock(return_value=response); response.__exit__ = Mock(return_value=False)
        response.status = 200
        with patch('development.request', side_effect=[OSError(), response]), patch('development.time.sleep'), patch('builtins.print') as output:
            wait_health('http://127.0.0.1/health', [('bridge', process)], 'bridge', Path('/tmp/isolated-startup'))
        self.assertIn('stage=ready', output.call_args.args[0])
        self.assertIn('/tmp/isolated-startup/bridge.log', output.call_args.args[0])

    def test_early_exit_names_failed_process(self):
        process = Mock(); process.poll.return_value = 73
        with self.assertRaisesRegex(RuntimeError, 'service=memory stage=exited code=73.*log=/tmp/isolated-startup/memory.log'):
            wait_health('http://127.0.0.1/health', [('memory', process)], 'bridge', Path('/tmp/isolated-startup'))

    def test_unready_service_never_reports_success(self):
        process = Mock(); process.poll.return_value = None
        with patch('development.request', side_effect=OSError()), patch('builtins.print') as output:
            with self.assertRaisesRegex(RuntimeError, 'service=bridge stage=timeout.*log=/tmp/isolated-startup/bridge.log'):
                wait_health('http://127.0.0.1/health', [('bridge', process)], 'bridge', Path('/tmp/isolated-startup'), timeout=.02)
        self.assertFalse(any('stage=ready' in call.args[0] for call in output.call_args_list))


if __name__ == '__main__':
    unittest.main()
