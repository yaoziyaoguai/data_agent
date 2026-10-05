import os
from pathlib import Path
import tempfile
import unittest

from development import read_model_credentials, memory_configuration
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
