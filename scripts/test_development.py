import io
import os
import socket
from pathlib import Path
import tempfile
import unittest

from development import main, read_model_credentials, model_database, memory_configuration, embedding_configuration, with_local_proxy_bypass, wait_health, available_ports
from unittest.mock import patch, Mock
import json


class ModelCredentialsTest(unittest.TestCase):
    def test_model_database_keeps_trial_scope_and_explicit_normal_mode(self):
        self.assertEqual(model_database({'database': 'data_agent', 'profile': {'budget_mode': 'request'}}), 'data_agent')
        for profile in ({}, {'budget_mode': 'trial'}, {'budget_mode': 'request'}):
            self.assertEqual(model_database({'database': 'data_agent_trial_abc123', 'profile': profile}), 'data_agent_trial_abc123')
        for profile in ({}, {'budget_mode': 'trial'}):
            with self.assertRaisesRegex(RuntimeError, '数据库配置无效'):
                model_database({'database': 'data_agent', 'profile': profile})
        for database in ('another_project', 'data_agent_trial_ab;DROP DATABASE data_agent', 'data_agent_trial_xyz'):
            with self.assertRaisesRegex(RuntimeError, '数据库配置无效'):
                model_database({'database': database, 'profile': {'budget_mode': 'request'}})

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
                              'DATA_AGENT_PREFILL_TEST=1\n'
                              'DATA_AGENT_VECTOR_COLLECTION=dotenv_collection\n'
                              'DATA_AGENT_PUBLIC_CONTENT_RETENTION=latest_only\n'
                              'DATA_AGENT_TOOL_CONTRACT_VERSION=2\n')
            os.chmod(source, 0o600)
            self.assertEqual(set(read_model_credentials(source)), {
                'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_MODEL'})


class StartupConfigurationTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.runtime = self.root / '.local/unit-startup'
        self.runtime.mkdir(parents=True)
        self.identities = {'alice': 'a' * 64, 'bob': 'b' * 64, 'internal': 'c' * 64}
        (self.runtime / 'identities.json').write_text(json.dumps(self.identities))
        for directory in ('infra', '.local/infra', '.local/model-trial', '.local/embedding',
                          '.local/memory', '.local/memory-venv/bin', 'docs/sources/cockpit'):
            (self.root / directory).mkdir(parents=True, exist_ok=True)
        (self.root / '.local/infra/prepared.json').write_text('{}')
        (self.root / '.local/infra/mysql-app-password').write_text('synthetic-database-password')
        (self.root / '.local/infra/milvus-root-password').write_text('synthetic-vector-token')
        (self.root / 'docs/sources/cockpit/knowledge-manifest.json').write_text('{}')
        self.profile = {'model_id': 'deepseek-v4-pro', 'toolset': 'data', 'trial_id': 'synthetic-trial'}
        (self.root / '.local/model-trial/configuration.json').write_text(json.dumps({
            'database': 'data_agent_trial_abc123', 'profile': self.profile}))
        endpoint = 'https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings'
        (self.root / 'infra/embedding-model.json').write_text(json.dumps({'endpoint': endpoint}))
        self.key = self.root / 'embedding-key'
        self.key.write_text('synthetic-embedding-key')
        self.key.chmod(0o600)
        (self.root / '.local/memory/configuration.json').write_text(json.dumps({
            'collection': 'personal_memory', 'embedding_url': endpoint, 'embedding_key_file': 'embedding-key'}))
        (self.root / '.local/embedding/profile.json').write_text(json.dumps({'trial_id': 'synthetic-embedding-trial'}))
        (self.root / '.local/memory-venv/bin/python').touch()
        self.credentials = self.root / '.env'
        self.credentials.write_text('DEEPSEEK_API_KEY=synthetic-model-key\n'
                                    'DEEPSEEK_BASE_URL=https://api.deepseek.com\n'
                                    'DEEPSEEK_MODEL=deepseek-flash\n')
        self.credentials.chmod(0o600)
        self.argv = ['development.py', '--check', '--runtime-dir', str(self.runtime)]
        self.spawn = Mock()
        self.spawn.return_value.poll.return_value = None

        def response(request, timeout):
            user = next((user for user, token in self.identities.items()
                         if request.get_header('Authorization') == 'Bearer ' + token), None)
            result = io.BytesIO(json.dumps({'user_id': user, 'space_id': 'demo', 'space_name': '合成座舱语音空间',
                                           'model_label': 'DeepSeek V4 Pro' if '--model' in self.argv else '本地模拟模型'}).encode())
            result.status = 200
            return result

        opener = Mock()
        opener.open.side_effect = response
        for patcher in (
            patch('development.ROOT', self.root),
            patch('sys.argv', self.argv),
            patch.dict(os.environ, {
                'DATA_AGENT_VECTOR_COLLECTION': 'inherited_collection',
                'DATA_AGENT_EMBEDDING_URL': 'https://inherited.invalid/embeddings',
                'DATA_AGENT_MEMORY_URL': 'http://inherited.invalid/memory',
                'DATA_AGENT_PUBLIC_CONTENT_RETENTION': 'latest_only',
                'DATA_AGENT_TOOL_CONTRACT_VERSION': '2',
                'DEEPSEEK_API_KEY': 'inherited-model-key',
            }, clear=True),
            patch('development.socket.socket'),
            patch('development.signal.signal'),
            patch('development.subprocess.Popen', self.spawn),
            patch('development.subprocess.run', side_effect=AssertionError('unexpected subprocess.run')),
            patch('development.subprocess.check_output', side_effect=AssertionError('unexpected subprocess.check_output')),
            patch('development.urllib.request.build_opener', return_value=opener),
            patch('sys.stdout', new_callable=io.StringIO),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_chat_can_keep_maintenance_disabled_without_replacing_its_profile(self):
        self.argv.extend(['--model', 'deepseek', '--memory', 'builtin', '--retrieval', 'lexical',
                          '--prefill', 'disabled'])
        main()
        self.assertEqual(len(self.spawn.call_args_list), 5)
        for call in self.spawn.call_args_list:
            with self.subTest(command=call.args[0]):
                env = call.kwargs['env']
                self.assertEqual(json.loads(env['DATA_AGENT_MODEL_PROFILE']), self.profile)
                self.assertTrue(env['DATA_AGENT_DATABASE_URL'].endswith('/data_agent_trial_abc123'))
                self.assertEqual(env['DATA_AGENT_TOOLSET'], 'data')
                self.assertNotIn('DATA_AGENT_PREFILL_PROFILE', env)
                self.assertNotIn('DATA_AGENT_PREFILL_URL', env)

    def test_api_initialization_has_local_wait_budget(self):
        self.argv.extend(['--model', 'deepseek', '--memory', 'builtin', '--retrieval', 'lexical'])
        with patch('development.wait_health') as health:
            main()
        budgets = {call.args[2]: call.kwargs.get('timeout', 25) for call in health.call_args_list}
        self.assertEqual(budgets, {'platform': 25, 'api': 75, 'bridge': 25, 'web': 25})

    def test_environment_record_contains_only_effective_non_secret_selections(self):
        self.argv.extend(['--model', 'deepseek', '--public-collection', 'upgraded_public_20261030',
                          '--public-content-retention', 'latest_only', '--tool-contract-version', '2',
                          '--port-offset', '100'])
        main()
        self.assertEqual(json.loads((self.runtime / 'environment.json').read_text()), {
            'database': 'data_agent_trial_abc123',
            'source_directory': 'docs/sources/cockpit',
            'ports': {'api': 8880, 'bridge': 8881, 'web': 5273, 'platform': 8890, 'memory': 8891},
            'model_mode': 'deepseek', 'retrieval_mode': 'hybrid', 'memory_mode': 'mem0',
            'public_collection': 'upgraded_public_20261030',
            'public_content_retention': 'latest_only', 'tool_contract_version': 2,
        })
        self.assertEqual(len(self.spawn.call_args_list), 6)
        for call in self.spawn.call_args_list:
            with self.subTest(command=call.args[0]):
                env = call.kwargs['env']
                self.assertEqual(env['DATA_AGENT_VECTOR_COLLECTION'], 'upgraded_public_20261030')
                self.assertEqual(env['DATA_AGENT_PUBLIC_CONTENT_RETENTION'], 'latest_only')
                self.assertEqual(env['DATA_AGENT_TOOL_CONTRACT_VERSION'], '2')
                if call.args[0][0] in ('python3', 'node') and call.args[0][1] != 'apps/agent/server.ts':
                    self.assertNotIn('DEEPSEEK_API_KEY', env)
                else:
                    self.assertEqual(env['DEEPSEEK_API_KEY'], 'synthetic-model-key')
                    self.assertEqual(env['DEEPSEEK_MODEL'], 'deepseek-v4-pro')

    def test_deepseek_defaults_keep_hashed_collection_and_ignore_dotenv_rollout_flags(self):
        with self.credentials.open('a') as output:
            output.write('DATA_AGENT_VECTOR_COLLECTION=dotenv_collection\n'
                         'DATA_AGENT_PUBLIC_CONTENT_RETENTION=latest_only\n'
                         'DATA_AGENT_TOOL_CONTRACT_VERSION=2\n')
        self.argv.extend(['--model', 'deepseek'])
        main()
        collection = embedding_configuration(self.root / '.local/memory/configuration.json', 'data_agent_trial_abc123')['DATA_AGENT_VECTOR_COLLECTION']
        self.assertEqual(len(self.spawn.call_args_list), 6)
        for call in self.spawn.call_args_list:
            with self.subTest(command=call.args[0]):
                env = call.kwargs['env']
                self.assertEqual(env['DATA_AGENT_VECTOR_COLLECTION'], collection)
                self.assertEqual(env['DATA_AGENT_PUBLIC_CONTENT_RETENTION'], 'archive')
                self.assertEqual(env['DATA_AGENT_TOOL_CONTRACT_VERSION'], '1')
                self.assertEqual(env['DATA_AGENT_MEMORY_URL'], 'http://127.0.0.1:8791')
                self.assertEqual(json.loads(env['DATA_AGENT_MODEL_PROFILE']), self.profile)
                self.assertEqual(json.loads(env['DATA_AGENT_PREFILL_PROFILE']), self.profile)
                self.assertEqual(env['DATA_AGENT_PREFILL_URL'], 'https://api.deepseek.com/chat/completions')
        metadata = json.loads((self.runtime / 'environment.json').read_text())
        self.assertEqual(metadata['public_collection'], collection)
        self.assertEqual(metadata['memory_mode'], 'mem0')
        self.assertEqual(metadata['retrieval_mode'], 'hybrid')
        self.assertEqual(metadata['public_content_retention'], 'archive')
        self.assertEqual(metadata['tool_contract_version'], 1)

    def test_deepseek_lexical_builtin_needs_no_embedding_or_memory_configuration(self):
        self.key.unlink()
        (self.root / '.local/memory/configuration.json').unlink()
        (self.root / '.local/embedding/profile.json').unlink()
        self.argv.extend(['--model', 'deepseek', '--retrieval', 'lexical', '--memory', 'builtin'])
        main()
        self.assertEqual(len(self.spawn.call_args_list), 5)
        for call in self.spawn.call_args_list:
            with self.subTest(command=call.args[0]):
                env = call.kwargs['env']
                for option in ('DATA_AGENT_VECTOR_URL', 'DATA_AGENT_VECTOR_COLLECTION',
                               'DATA_AGENT_EMBEDDING_URL', 'DATA_AGENT_MEMORY_URL'):
                    self.assertNotIn(option, env)
        metadata = json.loads((self.runtime / 'environment.json').read_text())
        self.assertIsNone(metadata['public_collection'])
        self.assertEqual(metadata['retrieval_mode'], 'lexical')
        self.assertEqual(metadata['memory_mode'], 'builtin')

    def test_deepseek_still_requires_private_model_credentials(self):
        self.argv.extend(['--model', 'deepseek'])
        self.credentials.chmod(0o644)
        with self.assertRaisesRegex(RuntimeError, r'\.env权限必须为0600'):
            main()
        self.spawn.assert_not_called()

    def test_deepseek_hybrid_still_requires_private_embedding_credentials(self):
        self.argv.extend(['--model', 'deepseek'])
        self.key.chmod(0o644)
        with self.assertRaisesRegex(RuntimeError, '百炼密钥文件缺失或权限不是0600'):
            main()
        self.spawn.assert_not_called()

    def test_protocol_test_still_rejects_hybrid_and_mem0(self):
        for option, value, error in (('--retrieval', 'hybrid', '真实向量需要显式deepseek'),
                                     ('--memory', 'mem0', 'Mem0默认使用真实服务')):
            with self.subTest(option=option), patch('sys.argv', [*self.argv, '--model', 'protocol-test', option, value]):
                with self.assertRaisesRegex(RuntimeError, error):
                    main()
                self.spawn.assert_not_called()

    def test_rollout_options_reject_unsupported_values(self):
        for option, value in (('--public-content-retention', 'purge'), ('--tool-contract-version', '3')):
            with self.subTest(option=option), patch('sys.argv', ['development.py', option, value]), patch('sys.stderr', new_callable=io.StringIO) as errors:
                with self.assertRaises(SystemExit) as rejected:
                    main()
                self.assertEqual(rejected.exception.code, 2)
                self.assertIn(option, errors.getvalue())
                self.spawn.assert_not_called()

    def test_protocol_defaults_override_inherited_rollout_flags_without_paid_services(self):
        self.credentials.chmod(0o644)
        self.argv.extend(['--model', 'protocol-test', '--model-url', 'http://127.0.0.1:28881'])
        main()
        self.assertEqual(len(self.spawn.call_args_list), 5)
        for call in self.spawn.call_args_list:
            with self.subTest(command=call.args[0]):
                env = call.kwargs['env']
                self.assertEqual(env['DATA_AGENT_PUBLIC_CONTENT_RETENTION'], 'archive')
                self.assertEqual(env['DATA_AGENT_TOOL_CONTRACT_VERSION'], '1')
                for option in ('DATA_AGENT_EMBEDDING_URL', 'DATA_AGENT_EMBEDDING_PROFILE',
                               'DATA_AGENT_VECTOR_URL', 'DATA_AGENT_VECTOR_COLLECTION',
                               'DATA_AGENT_MEMORY_URL', 'DATA_AGENT_MEMORY_INDEX_TARGET'):
                    self.assertNotIn(option, env)

    def test_protocol_explicit_collection_does_not_enable_embedding_or_mem0(self):
        self.credentials.unlink()
        self.key.unlink()
        self.argv.extend(['--model', 'protocol-test', '--model-url', 'http://127.0.0.1:28881',
                          '--public-collection', '_' + 'a' * 127,
                          '--public-content-retention', 'latest_only', '--tool-contract-version', '2'])
        main()
        self.assertEqual(len(self.spawn.call_args_list), 5)
        for call in self.spawn.call_args_list:
            with self.subTest(command=call.args[0]):
                env = call.kwargs['env']
                self.assertEqual(env['DATA_AGENT_VECTOR_COLLECTION'], '_' + 'a' * 127)
                self.assertEqual(env['DATA_AGENT_PUBLIC_CONTENT_RETENTION'], 'latest_only')
                self.assertEqual(env['DATA_AGENT_TOOL_CONTRACT_VERSION'], '2')
                for option in ('DATA_AGENT_EMBEDDING_URL', 'DATA_AGENT_EMBEDDING_KEY_FILE',
                               'DATA_AGENT_EMBEDDING_PROFILE', 'DATA_AGENT_VECTOR_URL',
                               'DATA_AGENT_VECTOR_TOKEN_FILE', 'DATA_AGENT_MEMORY_URL'):
                    self.assertNotIn(option, env)
        metadata = json.loads((self.runtime / 'environment.json').read_text())
        self.assertEqual(metadata['public_collection'], '_' + 'a' * 127)
        self.assertEqual(metadata['model_mode'], 'protocol-test')
        self.assertEqual(metadata['retrieval_mode'], 'lexical')
        self.assertEqual(metadata['memory_mode'], 'builtin')

    def test_invalid_public_collection_is_rejected_before_runtime_access(self):
        self.argv.extend(['--model', 'protocol-test', '--model-url', 'http://127.0.0.1:28881'])
        for collection in ('', '123public', 'public-name', 'public name', 'public.name', '公共集合', 'a' * 129):
            with self.subTest(collection=collection), patch('sys.argv', [*self.argv, '--public-collection', collection]), patch('sys.stderr', new_callable=io.StringIO) as errors:
                with self.assertRaises(SystemExit) as rejected:
                    main()
                self.assertEqual(rejected.exception.code, 2)
                self.assertIn('--public-collection', errors.getvalue())
                self.spawn.assert_not_called()

    def test_explicit_public_collection_reaches_every_hybrid_subprocess(self):
        self.argv.extend(['--model', 'deepseek', '--memory', 'builtin', '--public-collection', 'upgraded_public_20261030'])
        main()
        self.assertEqual(len(self.spawn.call_args_list), 5)
        for call in self.spawn.call_args_list:
            with self.subTest(command=call.args[0]):
                self.assertEqual(call.kwargs['env']['DATA_AGENT_VECTOR_COLLECTION'], 'upgraded_public_20261030')


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
