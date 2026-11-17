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


# 原2026-11-14 J02草稿（合成语音链路资料）逐字保留：多CTE链中GROUP BY+HAVING形状的
# CTE引用会以CTE名触发SQLITE_READ，曾在编译期被误拒为SQLITE_AUTH。
J02_DRAFT_SQL = """WITH qualified_turns AS (
    SELECT t.turn_id, t.started_at
    FROM syn_voice_turn t
    JOIN syn_voice_session s ON s.session_id = t.session_id
    JOIN syn_vehicle v ON v.vehicle_id = s.vehicle_id
    WHERE v.is_lab_unit = 0 AND v.telemetry_consent = 1
      AND s.quality_state = 'valid' AND s.is_complete = 1
      AND t.quality_state = 'valid'
      AND t.started_at >= :start AND t.started_at < :end
      AND s.started_at < :snapshot AND s.ended_at < :snapshot
      AND t.finished_at < :snapshot
      AND t.received_at < :snapshot AND s.received_at < :snapshot
),
visible_attempts AS (
    SELECT a.asr_attempt_id, a.turn_id, a.attempt_no
    FROM syn_asr_attempt a
    JOIN qualified_turns t ON t.turn_id = a.turn_id
    WHERE a.received_at < :snapshot
      AND CAST(strftime('%s', t.started_at) AS INTEGER) * 1000 + a.finish_offset_ms
          < CAST(strftime('%s', :snapshot) AS INTEGER) * 1000
),
last_attempts AS (
    SELECT turn_id, MAX(attempt_no) AS last_no
    FROM visible_attempts
    GROUP BY turn_id
),
final_attempts AS (
    SELECT a.asr_attempt_id
    FROM visible_attempts a
    JOIN last_attempts l ON l.turn_id = a.turn_id AND l.last_no = a.attempt_no
),
visible_hyp AS (
    SELECT h.hypothesis_id,
           h.asr_attempt_id,
           h.turn_id,
           h.candidate_rank AS candidate_rank,
           h.confidence_permille AS score,
           h.selected_for_nlu AS selected
    FROM syn_asr_hypothesis h
    JOIN qualified_turns t ON t.turn_id = h.turn_id
    WHERE h.received_at < :snapshot
),
attempt_best AS (
    SELECT vh.asr_attempt_id,
           bb.best_score AS best_score,
           COUNT(*) AS candidates,
           SUM(CASE WHEN vh.score = bb.best_score THEN 1 ELSE 0 END) AS at_best_candidates
    FROM visible_hyp vh
    JOIN (SELECT asr_attempt_id, MAX(score) AS best_score
          FROM visible_hyp GROUP BY asr_attempt_id) bb
      ON bb.asr_attempt_id = vh.asr_attempt_id
    GROUP BY vh.asr_attempt_id
),
selected_eval AS (
    SELECT s.turn_id,
           s.asr_attempt_id,
           s.score AS selected_score,
           b.best_score AS best_score,
           CASE WHEN s.score < b.best_score THEN 1 ELSE 0 END AS not_highest,
           CASE WHEN s.score = b.best_score AND b.at_best_candidates > 1 THEN 1 ELSE 0 END AS tied_top_not_unique,
           CASE WHEN fa.asr_attempt_id IS NULL THEN 1 ELSE 0 END AS not_final_attempt
    FROM visible_hyp s
    JOIN attempt_best b ON b.asr_attempt_id = s.asr_attempt_id
    LEFT JOIN final_attempts fa ON fa.asr_attempt_id = s.asr_attempt_id
    WHERE s.selected = 1
),
turn_candidate_gap AS (
    SELECT vh.turn_id
    FROM visible_hyp vh
    GROUP BY vh.turn_id
    HAVING SUM(vh.selected) = 0
),
turn_multi_selected AS (
    SELECT s.turn_id
    FROM selected_eval s
    GROUP BY s.turn_id
    HAVING COUNT(*) > 1
)
SELECT
    (SELECT COUNT(*) FROM qualified_turns) AS qualified_turns,
    (SELECT COUNT(*) FROM selected_eval) AS selected_records,
    (SELECT COUNT(DISTINCT turn_id) FROM selected_eval) AS turns_with_selected,
    (SELECT COALESCE(SUM(not_highest), 0) FROM selected_eval) AS selected_not_highest_records,
    CAST((SELECT COALESCE(SUM(not_highest), 0) FROM selected_eval) AS REAL)
        / NULLIF((SELECT COUNT(*) FROM selected_eval), 0) AS selected_not_highest_ratio,
    (SELECT COALESCE(SUM(tied_top_not_unique), 0) FROM selected_eval) AS selected_tied_top_not_unique_records,
    (SELECT COALESCE(SUM(not_final_attempt), 0) FROM selected_eval) AS selected_on_non_final_attempt_records,
    (SELECT COUNT(*) FROM turn_multi_selected) AS turns_with_multiple_selected,
    (SELECT COUNT(*) FROM turn_candidate_gap) AS turns_with_candidates_but_no_selection;"""
J02_DRAFT_PARAMETERS = {"start": "2026-09-01T00:00:00Z", "end": "2026-10-01T00:00:00Z", "snapshot": "2026-10-04T00:00:00Z"}


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

    def test_cte_queries_authorize_statement_local_relations_with_underlying_reads(self):
        platform = self.platform()
        # 最小等价query：CTE本体引用与触发READ事件的HAVING形状都要放行。
        minimal = {
            'plain': 'WITH t AS (SELECT COUNT(*) AS c FROM demo_order_detail) SELECT c FROM t',
            'having': 'WITH g AS (SELECT order_id FROM demo_order_detail GROUP BY order_id HAVING COUNT(*)>0) SELECT COUNT(*) FROM g',
            'shadow': 'WITH demo_order_detail AS (SELECT COUNT(*) AS c FROM dim_customers) SELECT c FROM demo_order_detail',
        }
        for label, sql in minimal.items():
            with self.subTest(shape=label):
                self.assertEqual(platform.compile({'sql': sql})['state'], 'passed', label)
        # 合法遮蔽：CTE与物理表同名时实际读取底表，许可随底表判定，不因重名拒绝。
        platform.delay = 0
        platform.operate('/submit', {'owner_id': 'alice', 'query_id': 'shadow-query', 'sql': minimal['shadow'],
                                     'parameters': {}, 'target_id': 'synthetic-sqlite',
                                     'target_version': platform.platform_version})
        with sqlite3.connect(platform.business) as db:
            expected = db.execute('SELECT COUNT(*) FROM dim_customers').fetchone()[0]
        result = platform.operate('/results', {'owner_id': 'alice', 'query_id': 'shadow-query'})
        self.assertEqual(result['rows'], [[str(expected)]])

    def test_original_cte_draft_compiles_and_executes_with_normal_diagnostics(self):
        platform = platform_mock.Platform(self.directory / 'cockpit-runtime', ROOT / 'docs/sources/cockpit')
        report = platform.compile({'sql': J02_DRAFT_SQL, 'parameters': J02_DRAFT_PARAMETERS})
        self.assertEqual(report['state'], 'passed')
        platform.delay = 0
        platform.operate('/submit', {'owner_id': 'bob', 'query_id': 'cte-draft', 'sql': J02_DRAFT_SQL,
                                     'parameters': J02_DRAFT_PARAMETERS, 'target_id': 'synthetic-sqlite',
                                     'target_version': platform.platform_version})
        # 独立核对：同库无授权直连执行同一SQL，逐值比对，不用平台结果反写预期。
        with sqlite3.connect(f'file:{platform.business}?mode=ro', uri=True) as db:
            expected = [[None if cell is None else str(cell) for cell in row]
                        for row in db.execute(J02_DRAFT_SQL, J02_DRAFT_PARAMETERS).fetchall()]
        result = platform.operate('/results', {'owner_id': 'bob', 'query_id': 'cte-draft'})
        self.assertEqual(platform.operate('/status', {'owner_id': 'bob', 'query_id': 'cte-draft'})['state'], 'succeeded')
        self.assertEqual(result['rows'], expected)

    def test_read_guard_keeps_engine_objects_and_internal_tables_denied(self):
        platform = self.platform()
        # 引擎eponymous对象与内部表不得借READ事件混入：仍然拒绝。
        for label, sql in {
            'pragma-vtab': "SELECT name FROM pragma_table_info('demo_order_detail')",
            'json-each': "SELECT value FROM json_each('[1,2]')",
            'internal': 'SELECT name FROM sqlite_master',
        }.items():
            with self.subTest(engine_object=label):
                report = platform.compile({'sql': sql})
                self.assertEqual(report['state'], 'rejected')
                self.assertEqual(report['reason'], 'sql_not_supported')
        # 探针连接与被守卫连接同物理宇宙（平台上两者同开business文件）：
        # 未授权底表在探针上可解析，因而被拒；CTE名不可解析，是语句内虚拟关系。
        with sqlite3.connect(':memory:') as probe:
            probe.execute('CREATE TABLE demo_order_detail(id INTEGER)')
            probe.execute('CREATE TABLE dim_customers(id INTEGER)')
            guard = platform_mock.ReadGuard({'demo_order_detail'}, probe)
            ok = sqlite3.SQLITE_OK
            deny = sqlite3.SQLITE_DENY
            # 物理授权集与语句内虚拟关系放行；未授权底表、内部表、引擎对象拒绝。
            self.assertEqual(guard(sqlite3.SQLITE_READ, 'demo_order_detail', 'id', None, None), ok)
            self.assertEqual(guard(sqlite3.SQLITE_READ, 'qualified_turns', '', None, None), ok)
            self.assertEqual(guard(sqlite3.SQLITE_READ, 'dim_customers', 'id', None, None), deny)
            self.assertEqual(guard(sqlite3.SQLITE_READ, 'sqlite_master', 'name', None, None), deny)
            self.assertEqual(guard(sqlite3.SQLITE_READ, 'sqlite_sequence', 'name', None, None), deny)
            self.assertEqual(guard(sqlite3.SQLITE_READ, None, None, None, None), deny)
            self.assertEqual(guard(sqlite3.SQLITE_READ, 'json_each', 'value', None, None), deny)
            self.assertEqual(guard(sqlite3.SQLITE_READ, 'pragma_table_info', 'name', None, None), deny)
            # 只读与函数白名单不变：写、ATTACH、PRAGMA、白名单外函数仍拒。
            self.assertEqual(guard(sqlite3.SQLITE_INSERT, 'demo_order_detail', None, None, None), deny)
            self.assertEqual(guard(sqlite3.SQLITE_ATTACH, None, None, 'x.db', None), deny)
            self.assertEqual(guard(sqlite3.SQLITE_PRAGMA, 'main', 'journal_mode', None, None), deny)
            self.assertEqual(guard(sqlite3.SQLITE_FUNCTION, None, 'count', None, None), ok)
            self.assertEqual(guard(sqlite3.SQLITE_FUNCTION, None, 'load_extension', None, None), deny)

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
