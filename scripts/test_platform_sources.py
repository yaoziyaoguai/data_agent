"""平台来源同版检查；使用独立临时目录，不接触开发实例或模型。"""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sqlite3
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import ProxyHandler, Request, build_opener


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('platform_mock', ROOT / 'apps/platform-mock/server.py')
platform_mock = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(platform_mock)


class PlatformSourceTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.sources = self.directory / 'sources'
        self.sources.mkdir()
        for name in platform_mock.SOURCE_FILES:
            shutil.copyfile(ROOT / 'docs/sources' / name, self.sources / name)
        self.runtime = self.directory / 'runtime'

    def platform(self, runtime=None):
        return platform_mock.Platform(runtime or self.runtime, self.sources)

    def submit(self, platform, query_id='original-query'):
        platform.delay = 0
        return platform.operate('/submit', {'owner_id': 'alice', 'query_id': query_id,
                                          'sql': 'SELECT SUM(paid_amount_cents-refunded_amount_cents) AS net FROM demo_order_detail',
                                          'parameters': {}, 'target_id': 'synthetic-sqlite',
                                          'target_version': platform.platform_version})

    def change_source(self):
        with (self.sources / 'etl.sql').open('a') as output:
            output.write('\n-- 新的来源修订，旧实例不得冒称同版。\n')

    def create_legacy(self):
        self.runtime.mkdir()
        with sqlite3.connect(self.runtime / 'business.sqlite') as db:
            platform_mock.build_business(db, platform_mock.source_documents(self.sources))
        (self.runtime / 'submissions.sqlite').write_bytes(b'legacy-ledger-preserved')

    def test_default_catalog_uses_actual_database_and_complete_executed_lineage(self):
        platform = self.platform()
        tables = platform.catalog({})['tables']
        main = next(table for table in tables if table['id'] == 'demo_order_detail')
        self.assertEqual(main['node']['upstream_ids'], ['dim_customers', 'raw_order_lines', 'raw_payments'])
        self.assertEqual(main['node']['sql'], (self.sources / 'etl.sql').read_text())
        self.assertEqual(main['platform_version'], platform.platform_version)
        with sqlite3.connect(platform.business) as db:
            for table in tables:
                ddl = db.execute('SELECT sql FROM sqlite_master WHERE name=?', (table['name'],)).fetchone()[0]
                self.assertEqual(table['ddl'], ddl)
        self.assertEqual(platform.compile({'sql': 'SELECT COUNT(*) FROM demo_order_detail'})['state'], 'passed')
        self.assertEqual(platform.compile({'sql': 'SELECT 1'})['target_version'], platform.platform_version)

    def test_submission_requires_the_validated_target_revision(self):
        platform = self.platform()
        with self.assertRaisesRegex(ValueError, 'version_conflict'):
            platform.operate('/submit', {'owner_id': 'alice', 'query_id': 'old-target',
                                       'sql': 'SELECT 1', 'parameters': {}, 'target_id': 'synthetic-sqlite',
                                       'target_version': '1'})
        with sqlite3.connect(platform.ledger) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM submissions').fetchone()[0], 0)

    def test_explicit_revision_is_frozen_for_a_runtime_and_new_directory_can_upgrade(self):
        with patch.dict(os.environ, {'DATA_AGENT_SYNTHETIC_PLATFORM_VERSION': '7'}):
            original = self.platform()
            self.assertEqual(original.catalog({})['tables'][0]['platform_version'], '7')
            self.assertEqual(original.compile({'sql': 'SELECT 1'})['target_version'], '7')
        before = original.business.read_bytes()
        with patch.dict(os.environ, {'DATA_AGENT_SYNTHETIC_PLATFORM_VERSION': '8'}):
            with self.assertRaises(platform_mock.SourceVersionConflict):
                self.platform()
            upgraded = self.platform(self.directory / 'upgraded-runtime')
            self.assertEqual(upgraded.compile({'sql': 'SELECT 1'})['target_version'], '8')
        self.assertEqual(original.business.read_bytes(), before)

    def test_explicit_revision_obeys_existing_positive_decimal_contract(self):
        for version in ('0', '01', 'hash-value', '1.5', '９', '12345678901234567'):
            with self.subTest(version=version), patch.dict(os.environ, {'DATA_AGENT_SYNTHETIC_PLATFORM_VERSION': version}):
                with self.assertRaisesRegex(ValueError, 'invalid synthetic platform version'):
                    self.platform()
        self.assertFalse((self.runtime / 'business.sqlite').exists())

    def test_unchanged_restart_preserves_database_query_ledger_and_result(self):
        platform = self.platform()
        self.submit(platform)
        identity = {'owner_id': 'alice', 'query_id': 'original-query'}
        self.assertEqual(platform.operate('/status', identity)['state'], 'succeeded')
        result = platform.operate('/results', identity)
        self.assertEqual(result['data_freshness'], 'synthetic_snapshot_2026-02-04')
        before = {name: (self.runtime / name).read_bytes() for name in ('business.sqlite', 'submissions.sqlite', 'source-manifest.json')}
        restarted = self.platform()
        self.assertEqual(restarted.catalog({}), platform.catalog({}))
        self.assertEqual(restarted.operate('/results', identity), result)
        for name, value in before.items():
            self.assertEqual((self.runtime / name).read_bytes(), value)

    def test_snapshot_metadata_is_frozen_and_each_source_reports_its_own_date(self):
        original = self.platform()
        self.submit(original)
        identity = {'owner_id': 'alice', 'query_id': 'original-query'}
        original.operate('/lookup', identity)
        old = original.operate('/results', identity)
        manifest = json.loads((self.sources / 'knowledge-manifest.json').read_text())
        manifest['snapshot_exclusive'] = '2026-04-04T00:00:00Z'
        (self.sources / 'knowledge-manifest.json').write_text(json.dumps(manifest))
        with self.assertRaises(platform_mock.SourceVersionConflict):
            original.compile({'sql': 'SELECT 1'})
        with self.assertRaises(platform_mock.SourceVersionConflict):
            self.platform()
        self.assertEqual(original.operate('/results', identity), old)
        fresh = platform_mock.Platform(self.directory / 'fresh-snapshot', ROOT / 'docs/sources/analysis')
        self.submit(fresh, 'new-query')
        result = fresh.operate('/results', {'owner_id': 'alice', 'query_id': 'new-query'})
        self.assertEqual(result['data_freshness'], 'synthetic_snapshot_2026-04-04')
        self.assertNotEqual(fresh.source_fingerprint, original.source_fingerprint)

    def test_missing_or_invalid_snapshot_metadata_cannot_be_claimed_as_fresh(self):
        manifest = json.loads((self.sources / 'knowledge-manifest.json').read_text())
        for snapshot in (None, '2026-02-30T00:00:00Z', '2026-2-4T00:00:00Z'):
            with self.subTest(snapshot=snapshot):
                manifest['snapshot_exclusive'] = snapshot
                (self.sources / 'knowledge-manifest.json').write_text(json.dumps(manifest))
                with self.assertRaises(ValueError):
                    self.platform()
        self.assertFalse(self.runtime.joinpath('business.sqlite').exists())

    def legacy_marked_platform(self):
        platform = self.platform()
        self.submit(platform)
        identity = {'owner_id': 'alice', 'query_id': 'original-query'}
        platform.operate('/lookup', identity)
        result = platform.operate('/results', identity)
        manifest = json.loads(platform.manifest_file.read_text())
        manifest['files'].pop('knowledge-manifest.json')
        manifest['source_fingerprint'] = platform_mock.source_fingerprint(manifest['files'])
        platform.manifest_file.write_text(json.dumps(manifest))
        (platform.source_snapshot / 'knowledge-manifest.json').unlink()
        return platform, identity, result

    def test_same_business_legacy_snapshot_can_adopt_metadata_without_changing_results(self):
        platform, identity, result = self.legacy_marked_platform()
        before = {name: (self.runtime / name).read_bytes() for name in ('business.sqlite', 'submissions.sqlite')}
        upgraded = self.platform()
        self.assertEqual(upgraded.operate('/results', identity), result)
        for name, value in before.items():
            self.assertEqual((self.runtime / name).read_bytes(), value)
        self.assertIn('knowledge-manifest.json', json.loads(upgraded.manifest_file.read_text())['files'])
        self.assertEqual((upgraded.source_snapshot / 'knowledge-manifest.json').read_text(), (self.sources / 'knowledge-manifest.json').read_text())
        self.assertEqual(self.platform().operate('/results', identity), result)
        manifest = json.loads((self.sources / 'knowledge-manifest.json').read_text())
        manifest['snapshot_exclusive'] = '2026-04-04T00:00:00Z'
        (self.sources / 'knowledge-manifest.json').write_text(json.dumps(manifest))
        with self.assertRaises(platform_mock.SourceVersionConflict):
            self.platform()

    def test_legacy_metadata_upgrade_rejects_changed_business_or_damaged_frozen_source(self):
        platform, _, _ = self.legacy_marked_platform()
        before = platform.manifest_file.read_bytes()
        (platform.source_snapshot / 'etl.sql').write_text('SELECT 1;')
        with self.assertRaises(platform_mock.SourceVersionConflict):
            self.platform()
        self.assertEqual(platform.manifest_file.read_bytes(), before)
        self.assertFalse((platform.source_snapshot / 'knowledge-manifest.json').exists())
        (platform.source_snapshot / 'etl.sql').write_text((self.sources / 'etl.sql').read_text())
        with sqlite3.connect(platform.business) as db:
            db.execute("UPDATE demo_order_detail SET paid_amount_cents=paid_amount_cents+1 WHERE order_id='O1001' AND line_id=1")
        with self.assertRaises(platform_mock.SourceVersionConflict):
            self.platform()
        self.assertEqual(platform.manifest_file.read_bytes(), before)
        self.assertFalse((platform.source_snapshot / 'knowledge-manifest.json').exists())

    def test_legacy_upgrade_cannot_adopt_a_new_snapshot_date_from_unfrozen_metadata(self):
        platform, identity, result = self.legacy_marked_platform()
        before = {name: (self.runtime / name).read_bytes() for name in ('business.sqlite', 'submissions.sqlite', 'source-manifest.json')}
        manifest = json.loads((self.sources / 'knowledge-manifest.json').read_text())
        manifest['snapshot_exclusive'] = '2026-04-04T00:00:00Z'
        (self.sources / 'knowledge-manifest.json').write_text(json.dumps(manifest))
        with self.assertRaises(platform_mock.SourceVersionConflict):
            self.platform()
        self.assertEqual(platform.operate('/results', identity), result)
        for name, body in before.items():
            self.assertEqual((self.runtime / name).read_bytes(), body)
        self.assertFalse((platform.source_snapshot / 'knowledge-manifest.json').exists())

    def test_source_change_rejects_new_operations_but_completes_original_query(self):
        platform = self.platform()
        # 直接按原始成功事件核算，不用平台加工结果反写参考值。
        with sqlite3.connect(platform.business) as db:
            expected_net = db.execute("SELECT SUM(CASE WHEN event_type='charge' THEN amount_cents ELSE -amount_cents END) FROM raw_payments WHERE event_status='success' AND event_at<'2026-02-04T00:00:00Z'").fetchone()[0]
        self.submit(platform)
        self.change_source()
        for operation in (lambda: platform.catalog({}),
                          lambda: platform.compile({'sql': 'SELECT 1'}),
                          lambda: self.submit(platform, 'new-query')):
            with self.assertRaises(platform_mock.SourceVersionConflict):
                operation()
        identity = {'owner_id': 'alice', 'query_id': 'original-query'}
        self.assertEqual(platform.operate('/lookup', identity)['state'], 'succeeded')
        result = platform.operate('/results', identity)
        self.assertEqual(result['rows'], [[str(expected_net)]])
        self.assertTrue(result['result_complete'])
        with sqlite3.connect(platform.ledger) as db:
            self.assertEqual(db.execute('SELECT id FROM submissions').fetchall(), [('original-query',)])

    def test_stale_restart_keeps_old_files_and_new_directory_gets_new_snapshot(self):
        platform = self.platform()
        self.submit(platform)
        before = {name: (self.runtime / name).read_bytes() for name in ('business.sqlite', 'submissions.sqlite', 'source-manifest.json')}
        old_fingerprint = platform.source_fingerprint
        old_snapshot = platform.catalog({})['snapshot_id']
        self.change_source()
        with self.assertRaises(platform_mock.SourceVersionConflict):
            self.platform()
        for name, value in before.items():
            self.assertEqual((self.runtime / name).read_bytes(), value)
        new = self.platform(self.directory / 'new-runtime')
        self.assertNotEqual(new.source_fingerprint, old_fingerprint)
        self.assertNotEqual(new.catalog({})['snapshot_id'], old_snapshot)
        self.assertEqual(new.catalog({})['tables'][0]['platform_version'], new.platform_version)

    def test_matching_unmarked_database_can_adopt_sources_after_content_check(self):
        self.create_legacy()
        # 旧账本必须是可用 SQLite；用一条额外历史记录检验不删除。
        ledger = self.runtime / 'submissions.sqlite'
        ledger.unlink()
        with sqlite3.connect(ledger) as db:
            db.execute('CREATE TABLE prior_history(id TEXT PRIMARY KEY)')
            db.execute("INSERT INTO prior_history VALUES('historical-result')")
        business = (self.runtime / 'business.sqlite').read_bytes()
        platform = self.platform()
        self.assertEqual(platform.business.read_bytes(), business)
        self.assertTrue(platform.manifest_file.exists())
        with sqlite3.connect(ledger) as db:
            self.assertEqual(db.execute('SELECT * FROM prior_history').fetchall(), [('historical-result',)])

    def test_unmarked_database_with_changed_data_cannot_claim_current_sources(self):
        self.create_legacy()
        with sqlite3.connect(self.runtime / 'business.sqlite') as db:
            db.execute("UPDATE demo_order_detail SET paid_amount_cents=paid_amount_cents+100 WHERE order_id='O1001' AND line_id=1")
        before = {name: (self.runtime / name).read_bytes() for name in ('business.sqlite', 'submissions.sqlite')}
        with self.assertRaises(platform_mock.SourceVersionConflict):
            self.platform()
        self.assertFalse((self.runtime / 'source-manifest.json').exists())
        for name, value in before.items():
            self.assertEqual((self.runtime / name).read_bytes(), value)

    def test_unmarked_database_with_changed_constraint_is_rejected(self):
        self.create_legacy()
        with sqlite3.connect(self.runtime / 'business.sqlite') as db:
            db.execute('CREATE TABLE additional_business_data(id INTEGER PRIMARY KEY)')
        with self.assertRaises(platform_mock.SourceVersionConflict):
            self.platform()
        self.assertFalse((self.runtime / 'source-manifest.json').exists())

    def test_marked_database_or_saved_source_damage_is_rejected(self):
        platform = self.platform()
        (platform.source_snapshot / 'etl.sql').write_text('SELECT 1;')
        with self.assertRaises(platform_mock.SourceVersionConflict):
            self.platform()
        (platform.source_snapshot / 'etl.sql').write_text((self.sources / 'etl.sql').read_text())
        with sqlite3.connect(platform.business) as db:
            db.execute("DELETE FROM customer_tags WHERE customer_id='C001'")
        with self.assertRaises(platform_mock.SourceVersionConflict):
            self.platform()

    def test_missing_current_source_rejects_catalog_without_erasing_database(self):
        platform = self.platform()
        before = platform.business.read_bytes()
        (self.sources / 'schema.sql').unlink()
        with self.assertRaises(platform_mock.SourceVersionConflict):
            platform.catalog({})
        self.assertEqual(platform.business.read_bytes(), before)

    def test_explicit_catalog_test_override_keeps_its_namespace_and_version(self):
        platform = self.platform()
        actual = platform.catalog({})
        override = {'source_namespace': 'synthetic-other-platform', 'tables': actual['tables']}
        override['tables'][0]['platform_version'] = 'explicit-test-version'
        platform.catalog_file.write_text(json.dumps(override))
        observed = platform.catalog({})
        self.assertEqual(observed['source_namespace'], override['source_namespace'])
        self.assertEqual(observed['tables'][0]['platform_version'], 'explicit-test-version')
        self.assertEqual(platform.documents['etl.sql'], (self.sources / 'etl.sql').read_text())

    def test_http_reports_source_conflict_without_disguising_it_as_empty_catalog(self):
        server = platform_mock.ThreadingHTTPServer(('127.0.0.1', 0), platform_mock.Handler)
        server.platform = self.platform()
        server.token = 'synthetic-internal-token-for-source-test'
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            endpoint = 'http://127.0.0.1:' + str(server.server_address[1])
            client = build_opener(ProxyHandler({}))
            def request(path):
                return Request(endpoint + path, data=b'{"sql":"SELECT 1"}',
                               headers={'Authorization': 'Bearer ' + server.token, 'Content-Type': 'application/json'})
            with client.open(request('/catalog'), timeout=3) as response:
                self.assertEqual(len(json.load(response)['tables']), 5)
            self.change_source()
            for path in ('/catalog', '/validate'):
                with self.assertRaises(HTTPError) as raised:
                    client.open(request(path), timeout=3)
                self.assertEqual(raised.exception.code, 409)
                value = json.load(raised.exception)
                self.assertEqual(value['code'], 'version_conflict')
                self.assertIn('新的运行目录', value['message'])
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


if __name__ == '__main__':
    unittest.main()
