#!/usr/bin/env python3
"""交付检查器的临时项目反例；不访问项目数据库、模型或真实凭据。"""

from contextlib import redirect_stdout
from copy import deepcopy
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import check_delivery as checker


class DeliveryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name).resolve()
        self.write('AGENTS.md', '# Project rules\n')
        self.write('docs/registry.md', '\n'.join(
            f'| {key} | source | I0 | M05 | observable behavior | acceptance |'
            for key in sorted(checker.REQUIREMENTS)))
        self.write('docs/review.md', 'Reviewed the behavior and declared input scope.\n')
        self.write('src/value.txt', 'ready')
        self.write('lock.json', '{}\n')
        self.write('tests/check.py', 'from pathlib import Path\nassert Path("src/value.txt").read_text() == "ready"\n')
        self.increment = {
            'id': 'fixture', 'phase': 'I0', 'status': 'planned', 'goal': 'Verify a local fixture',
            'requirements': ['D01'], 'modules': ['M05'], 'allowed_paths': ['src', 'tests', 'lock.json'],
            'non_goals': ['No external services'], 'invariants': ['Keep existing values'],
            'acceptance': [{'id': 'value', 'requirements': ['D01'], 'expected': 'The value is ready',
                            'command': ['python3', 'tests/check.py'], 'timeout_seconds': 2,
                            'evidence_kind': 'contract'}],
            'verification_inputs': ['src', 'tests', 'lock.json'],
            'review': {'status': 'passed', 'record': 'docs/review.md'}, 'evidence': None,
        }
        self.delivery = {'schema': 1, 'registry': 'docs/registry.md', 'increment': self.increment}
        self.decisions = '\n'.join(f'| {n} | confirmed choice {n} |' for n in range(1, 19))
        self.save()
        self.approve_review()

    def write(self, name: str, content: str) -> None:
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding='utf-8')

    def save(self) -> None:
        self.write('docs/CURRENT.md', '---\n' + json.dumps({'delivery': self.delivery})
                   + '\n---\n# Current\n\n## 已确认的 18 项决定\n\n' + self.decisions + '\n\n## Progress\n')

    def approve_review(self) -> None:
        self.write('docs/review.md', json.dumps({'reviewer': 'fixture-reviewer', 'conclusion': 'passed',
                   'scope_sha256': checker.review_scope(self.root, self.delivery),
                   'summary': 'Reviewed fixture expectations, checks and declared source scope.'}))

    def run_check(self, complete: bool = False) -> tuple[int, dict]:
        output = io.StringIO()
        args = ['--root', str(self.root)] + (['--complete'] if complete else [])
        with redirect_stdout(output):
            status = checker.main(args)
        return status, json.loads(output.getvalue())

    def receipt(self) -> dict:
        return json.loads((self.root / '.local/delivery/fixture-result.json').read_text())

    def mark_complete(self) -> None:
        self.increment['status'] = 'complete'
        self.increment['evidence'] = '.local/delivery/fixture-result.json'
        self.save()

    def test_planned_never_runs_commands_and_allows_missing_inputs(self) -> None:
        self.increment['verification_inputs'] = ['not-created-yet']
        self.increment['acceptance'][0]['command'] = ['python3', '-c', 'from pathlib import Path; Path("executed").touch()']
        self.save()
        status, result = self.run_check()
        self.assertEqual(status, 0)
        self.assertIn('业务未验证', result['message'])
        self.assertFalse((self.root / 'executed').exists())
        self.increment['acceptance'][0]['command'] = None
        self.save()
        self.assertEqual(self.run_check()[0], 0)

    def test_failed_command_keeps_stdout_and_stderr_without_claiming_success(self) -> None:
        self.write('tests/check.py', 'import sys\nprint("before failure", flush=True)\nprint("failure detail", file=sys.stderr)\nsys.exit(3)\n')
        self.approve_review()
        self.assertEqual(self.run_check(complete=True)[0], 1)
        command = self.receipt()['commands'][0]
        self.assertEqual(command['exit_code'], 3)
        self.assertFalse(command['passed'])
        log = self.root / command['log']
        self.assertEqual(log.read_text(), 'before failure\nfailure detail\n')
        self.assertEqual(log.stat().st_mode & 0o777, 0o600)

    def test_registry_missing_requirement_and_unknown_selection_fail(self) -> None:
        original = (self.root / 'docs/registry.md').read_text()
        self.write('docs/registry.md', '\n'.join(line for line in original.splitlines() if '| D18 |' not in line))
        self.assertEqual(self.run_check()[0], 1)
        self.write('docs/registry.md', original)
        self.increment['requirements'] = ['D99']
        self.save()
        self.assertEqual(self.run_check()[0], 1)

    def test_each_selected_requirement_must_have_acceptance(self) -> None:
        self.increment['requirements'].append('A01')
        self.save()
        self.assertIn('未绑定', self.run_check()[1]['message'])
        self.increment['acceptance'][0]['requirements'] = ['C01']
        self.save()
        self.assertIn('非本轮', self.run_check()[1]['message'])

    def test_complete_preflight_requires_command_inputs_and_review(self) -> None:
        baseline = deepcopy(self.increment)
        for field, value in [('command', None), ('input', 'missing'), ('review', None)]:
            with self.subTest(field=field):
                self.increment.clear()
                self.increment.update(deepcopy(baseline))
                if field == 'command':
                    self.increment['acceptance'][0]['command'] = value
                elif field == 'input':
                    self.increment['verification_inputs'].append(value)
                else:
                    self.increment['review']['record'] = value
                self.save()
                self.assertEqual(self.run_check(complete=True)[0], 1)
                self.assertFalse((self.root / '.local/delivery/fixture-result.json').exists())

    def test_material_wrappers_and_self_check_cannot_close_increment(self) -> None:
        for command in [['make', 'verify'], ['make', 'verify-materials'], ['make', 'verify-increment'],
                        ['python3', 'scripts/check_delivery.py'], ['python3', 'scripts/check_preparation.py'],
                        ['node', 'docs/architecture/render-implementation.mjs'], ['dev_co', 'gate']]:
            with self.subTest(command=command):
                self.increment['acceptance'][0]['command'] = command
                self.save()
                self.assertEqual(self.run_check(complete=True)[0], 1)

    def test_command_failure_and_timeout_create_failed_receipts(self) -> None:
        for content, timeout in [('raise SystemExit(7)\n', 2), ('import time\ntime.sleep(1)\n', 0.03)]:
            with self.subTest(content=content):
                self.write('tests/check.py', content)
                self.increment['acceptance'][0]['timeout_seconds'] = timeout
                self.save()
                self.approve_review()
                self.assertEqual(self.run_check(complete=True)[0], 1)
                self.assertEqual(self.receipt()['status'], 'failed')
                self.assertFalse(self.receipt()['commands'][0]['passed'])
        self.assertTrue(self.receipt()['commands'][0]['timed_out'])

    def test_valid_receipt_and_duplicate_commands_execute_once(self) -> None:
        self.write('tests/check.py', 'from pathlib import Path\np = Path(".local/count")\np.write_text(str(int(p.read_text()) + 1) if p.exists() else "1")\nassert Path("src/value.txt").read_text() == "ready"\n')
        other = deepcopy(self.increment['acceptance'][0])
        other['id'] = 'same-command'
        self.increment['acceptance'].append(other)
        self.save()
        self.approve_review()
        self.assertEqual(self.run_check(complete=True)[0], 0)
        self.assertEqual(len(self.receipt()['commands']), 1)
        self.mark_complete()
        self.assertEqual(self.run_check()[0], 0)
        self.assertEqual((self.root / '.local/count').read_text(), '1')

    def test_changed_expected_or_declared_input_or_review_invalidates_receipt(self) -> None:
        self.assertEqual(self.run_check(complete=True)[0], 0)
        self.mark_complete()
        self.increment['acceptance'][0]['expected'] = 'A different behavior'
        self.save()
        self.assertIn('过期', self.run_check()[1]['message'])
        self.increment['acceptance'][0]['expected'] = 'The value is ready'
        self.save()
        for name in ['src/value.txt', 'lock.json', 'AGENTS.md']:
            with self.subTest(name=name):
                original = (self.root / name).read_text()
                self.write(name, original + ' changed')
                self.assertIn('过期', self.run_check()[1]['message'])
                self.write(name, original)
        record = json.loads((self.root / 'docs/review.md').read_text())
        record['summary'] += ' changed'
        self.write('docs/review.md', json.dumps(record))
        self.assertIn('过期', self.run_check()[1]['message'])

    def test_drift_during_execution_is_rejected(self) -> None:
        self.write('tests/check.py', 'from pathlib import Path\nPath("src/value.txt").write_text("changed")\n')
        self.approve_review()
        self.assertEqual(self.run_check(complete=True)[0], 1)
        self.assertIn('发生变化', self.receipt()['error'])

    def test_interrupted_rerun_invalidates_old_pass(self) -> None:
        self.assertEqual(self.run_check(complete=True)[0], 0)
        self.mark_complete()
        with patch.object(checker, 'run_command', side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                self.run_check(complete=True)
        self.assertEqual(self.receipt()['status'], 'running')
        self.assertEqual(self.run_check()[0], 1)

    def test_one_line_pass_is_not_evidence(self) -> None:
        self.write('.local/delivery/fixture-result.json', '{"status":"passed"}')
        self.mark_complete()
        self.assertEqual(self.run_check()[0], 1)

    def test_sensitive_and_escaping_paths_are_rejected(self) -> None:
        for name in ['../outside', '/tmp/outside', '.env', 'src/secret.key']:
            with self.subTest(name=name):
                self.increment['verification_inputs'] = [name]
                self.save()
                self.assertEqual(self.run_check()[0], 1)
        self.increment['verification_inputs'] = ['src']
        self.save()
        (self.root / 'src/alias').symlink_to(self.root / 'lock.json')
        self.assertEqual(self.run_check(complete=True)[0], 1)

    def test_build_outputs_do_not_expire_source_evidence(self) -> None:
        self.write('tests/check.py', 'from pathlib import Path\nfor name in ["dist", "node_modules", "target", ".vite", ".local"]:\n p = Path("src") / name\n p.mkdir(exist_ok=True)\n (p / "build").write_text("output")\n')
        self.approve_review()
        self.assertEqual(self.run_check(complete=True)[0], 0)
        self.mark_complete()
        self.assertEqual(self.run_check()[0], 0)
        self.write('src/generated/contract.py', 'VERSION = 2\n')
        self.assertEqual(self.run_check()[0], 1)

    def test_changed_decision_invalidates_review_and_missing_section_rejects(self) -> None:
        self.assertEqual(self.run_check(complete=True)[0], 0)
        self.mark_complete()
        self.decisions = self.decisions.replace('confirmed choice 1', 'changed choice 1')
        self.save()
        self.assertIn('过期', self.run_check()[1]['message'])
        self.write('docs/CURRENT.md', (self.root / 'docs/CURRENT.md').read_text().replace('## 已确认的 18 项决定', '## Different'))
        self.assertEqual(self.run_check()[0], 1)

    def test_changed_test_cannot_reuse_old_review_for_new_completion(self) -> None:
        self.assertEqual(self.run_check(complete=True)[0], 0)
        self.write('tests/check.py', 'raise SystemExit(0)\n')
        status, result = self.run_check(complete=True)
        self.assertEqual(status, 1)
        self.assertIn('审查证据已过期', result['message'])


if __name__ == '__main__':
    unittest.main()
