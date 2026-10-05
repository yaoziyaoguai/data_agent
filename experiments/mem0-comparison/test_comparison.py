from __future__ import annotations

import copy
import unittest

from fixtures import Fixtures, runtime_id, tenant_id
from scoring import assert_complete, percentile, relevance_metrics


class AuthorityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.fixtures = Fixtures()
        self.principal = {"user_id": "demo_analyst", "space_id": "synthetic_shop"}

    def candidate(self, asset: str, version: str = "1") -> dict:
        record = next(r for r in self.fixtures.records if r["asset_id"] == asset and r["version"] == version)
        return {"runtime_id": runtime_id(record), "version": version, "engine_id": "synthetic-test-result", "score": 0.7}

    def test_snapshots_are_independent_and_inherit_knowledge(self) -> None:
        current = copy.deepcopy(self.fixtures.snapshots["current"])
        self.assertEqual(self.fixtures.snapshots["channel_disabled"]["knowledge_versions"], current["knowledge_versions"])
        self.assertEqual(self.fixtures.snapshots["knowledge_revised"]["knowledge_versions"]["synthetic_gmv_rule"], "4")
        self.assertEqual(self.fixtures.snapshots["current"], current)

    def test_stale_disabled_deleted_and_dependency_revised_are_rejected(self) -> None:
        candidate = self.candidate("default_channel")
        for snapshot, reason in [("channel_revised", "stale_asset_version"), ("channel_disabled", "asset_disabled"), ("channel_deleted", "asset_deleted")]:
            with self.subTest(snapshot=snapshot):
                result = self.fixtures.validate([candidate], self.principal, snapshot)
                self.assertEqual(result["valid"], [])
                self.assertEqual(result["rejected"][0]["reason"], reason)
        result = self.fixtures.validate([self.candidate("gmv_rule")], self.principal, "knowledge_revised")
        self.assertEqual(result["valid"], [])
        self.assertEqual(result["rejected"][0]["reason"], "stale_dependency_version")

    def test_revised_asset_and_original_metadata_are_preserved(self) -> None:
        result = self.fixtures.validate([self.candidate("default_channel", "2")], self.principal, "channel_revised")
        record = result["valid"][0]["record"]
        self.assertEqual(record["version"], "2")
        self.assertIn("source", record)
        unverified = next(r for r in self.fixtures.formal_records(self.principal, "current") if r["verified"] is False)
        candidate = {"runtime_id": runtime_id(unverified), "version": unverified["version"], "engine_id": "unverified"}
        result = self.fixtures.validate([candidate], self.principal, "current")
        self.assertIs(result["valid"][0]["record"]["verified"], False)
        self.assertEqual(result["valid"][0]["record"]["source"], unverified["source"])

    def test_other_users_and_spaces_are_explicit_violations(self) -> None:
        foreign = [r for r in self.fixtures.records if (r["owner_id"], r["space_id"]) != (self.principal["user_id"], self.principal["space_id"])]
        self.assertGreaterEqual(len(foreign), 2)
        for record in foreign:
            result = self.fixtures.validate([{"runtime_id": runtime_id(record), "version": record["version"], "engine_id": "foreign"}], self.principal, "current")
            self.assertEqual(result["valid"], [])
            self.assertEqual(result["violations"][0]["reason"], "raw_principal_exposure")

    def test_tenant_binding_is_unambiguous(self) -> None:
        a = tenant_id({"user_id": "a/b", "space_id": "c"})
        b = tenant_id({"user_id": "a", "space_id": "b/c"})
        self.assertNotEqual(a, b)
        self.assertEqual(a, tenant_id({"user_id": "a/b", "space_id": "c"}))

    def test_duplicate_candidates_do_not_fill_context(self) -> None:
        candidate = self.candidate("monthly_buyers")
        result = self.fixtures.validate([candidate, candidate], self.principal, "current")
        self.assertEqual(len(result["valid"]), 1)
        self.assertEqual(result["rejected"][0]["reason"], "duplicate_record")


class ScoringTests(unittest.TestCase):
    def test_combined_question_requires_both_records(self) -> None:
        metrics = relevance_metrics(["unrelated@1", "a@1"], ["a@1", "b@1"])
        self.assertEqual(metrics["recall_at_5"], .5)
        self.assertEqual(metrics["mrr_at_5"], .5)

    def test_candidate_six_is_not_a_hit_and_duplicates_do_not_boost_recall(self) -> None:
        self.assertEqual(relevance_metrics(["x"] * 5 + ["a"], ["a"])["recall_at_5"], 0)
        self.assertEqual(relevance_metrics(["a", "a"], ["a", "b"])["recall_at_5"], .5)

    def test_failed_negative_query_is_not_successful_rejection(self) -> None:
        self.assertIsNone(relevance_metrics([], [], "timeout")["negative_noise"])
        self.assertFalse(relevance_metrics([], [])["negative_noise"])
        self.assertTrue(relevance_metrics(["noise"], [])["negative_noise"])

    def test_missing_and_duplicate_receipts_are_rejected(self) -> None:
        rows = [{"group": g, "query_id": "q", "repeat": r} for g in ("current_lexical", "vector_only", "mem0") for r in range(1, 4)]
        assert_complete(rows, ["q"])
        with self.assertRaisesRegex(ValueError, "missing_or_unexpected"):
            assert_complete(rows[:-1], ["q"])
        with self.assertRaisesRegex(ValueError, "duplicate"):
            assert_complete(rows + [rows[0]], ["q"])

    def test_percentiles_include_slowest_samples(self) -> None:
        self.assertEqual(percentile([1, 2, 100], .5), 2)
        self.assertAlmostEqual(percentile([1, 2, 100], .95), 90.2)


if __name__ == "__main__":
    unittest.main()
