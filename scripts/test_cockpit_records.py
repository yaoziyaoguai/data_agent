#!/usr/bin/env python3
"""只通过 grade CLI 校验轨迹记录，不连接数据库或模型。"""
from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
GRADE = ROOT / "docs/dogfood/cockpit/grade.py"
TRAJECTORIES = ROOT / "docs/execution/semantic-runtime/integrated-trajectories.json"


class CockpitRecordsTest(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.cases = json.loads(TRAJECTORIES.read_text(encoding="utf-8"))["cases"]
        self.record = {
            "cases": [
                {
                    "case_id": case["id"],
                    "status": "not_run",
                    "attempts": [],
                    "assertions": [
                        {"expected": expected, "status": "not_run", "reason": "", "evidence": []}
                        for expected in case["expect"]
                    ],
                }
                for case in self.cases
            ],
        }

    def grade_record(self, *options: str, trajectories: bool = True) -> subprocess.CompletedProcess[str]:
        record_path = self.directory / "trajectory-results.json"
        record_path.write_text(json.dumps(self.record, ensure_ascii=False), encoding="utf-8")
        return subprocess.run(
            [sys.executable, "-B", "-I", str(GRADE), *(["--trajectories"] if trajectories else []), str(record_path), *options],
            cwd=ROOT, capture_output=True, text=True, timeout=10, check=False,
        )

    def test_required_pass_keeps_full_records_and_rejects_unfinished_selected_cases(self) -> None:
        for trajectories, selected in ((True, "time-and-definition-continuation"), (False, "P01")):
            with self.subTest(trajectories=trajectories):
                source = TRAJECTORIES if trajectories else ROOT / "docs/dogfood/cockpit/scenarios.json"
                cases = json.loads(source.read_text(encoding="utf-8"))["cases"]
                self.record["cases"] = [
                    {"case_id": case["id"], "status": "not_run", "attempts": [], "assertions": [
                        {"expected": expected, "status": "not_run", "reason": "", "evidence": []}
                        for expected in case["expect"]
                    ]} for case in cases
                ]
                row = next(row for row in self.record["cases"] if row["case_id"] == selected)
                for status in ("not_run", "fail", "partial", "blocked_environment", "blocked_authorization", "inconclusive"):
                    row["status"] = status
                    result = self.grade_record("--require-pass", selected, trajectories=trajectories)
                    self.assertEqual(result.returncode, 1, result.stderr or result.stdout)
                    self.assertEqual(json.loads(result.stdout)["errors"], [f"{selected}: required pass, got {status}"])
                row["status"] = "pass"
                row["attempts"] = [{
                    "attempt_id": "record-fixture", "mode": "real_model",
                    "started_at": "2026-11-04T00:00:00Z", "status": "pass", "trace": "trace.json",
                }]
                (self.directory / "trace.json").write_text('{"fixture":"validator sample only; no business execution"}\n', encoding="utf-8")
                for assertion in row["assertions"]:
                    assertion.update(status="pass", reason="仅记录校验器工具样例", evidence=["trace.json"])
                result = self.grade_record("--require-pass", selected, trajectories=trajectories)
                self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
                report = json.loads(result.stdout)
                self.assertEqual(report["case_count"], len(cases))
                self.assertEqual(report["states"], {"pass": 1, "not_run": len(cases) - 1})
                result = self.grade_record("--require-pass", "missing-case", trajectories=trajectories)
                self.assertEqual(result.returncode, 1, result.stderr or result.stdout)
                self.assertEqual(json.loads(result.stdout)["errors"], ["required pass case ID not found: missing-case"])

    def test_not_run_trajectories_are_valid(self) -> None:
        result = self.grade_record()
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        report = json.loads(result.stdout)
        self.assertTrue(report["record_consistent"], report["errors"])
        self.assertEqual(report["case_count"], 10)
        self.assertEqual(report["states"], {"not_run": 10})
        specification = json.loads(TRAJECTORIES.read_text(encoding="utf-8"))
        coverage = specification["requirement_coverage"]
        requirements = {f"D{i:02}" for i in range(1, 19)} | {f"C{i:02}" for i in range(1, 9)} | {f"A{i:02}" for i in range(1, 11)}
        self.assertEqual(set(coverage), requirements)
        original = json.loads((ROOT / specification["source_cases"]).read_text(encoding="utf-8"))
        self.assertEqual({case for entry in coverage.values() for case in entry["cases"]},
                         {case["id"] for case in original["cases"]})
        for entry in coverage.values():
            self.assertTrue(entry["cases"] or entry["trajectories"] or entry["engineering_checks"] or entry.get("deferred"))
            for check in entry["engineering_checks"]:
                self.assertTrue((ROOT / check).is_file(), check)

    def test_missing_trajectory_id_is_rejected(self) -> None:
        self.record["cases"].pop()
        result = self.grade_record()
        self.assertEqual(result.returncode, 1, result.stderr or result.stdout)
        report = json.loads(result.stdout)
        self.assertFalse(report["record_consistent"])
        self.assertIn("must contain each of the 10 case IDs exactly once", report["errors"])

    def test_pass_without_assertion_evidence_is_rejected(self) -> None:
        row = next(row for row in self.record["cases"] if row["case_id"] == "source-change-preservation")
        row["status"] = "pass"
        row["attempts"] = [{
            "attempt_id": "record-fixture", "mode": "engineering",
            "started_at": "2026-11-02T00:00:00Z", "status": "pass", "trace": "trace.json",
        }]
        (self.directory / "trace.json").write_text('{"fixture":"record validation only"}\n', encoding="utf-8")
        for assertion in row["assertions"]:
            assertion.update(status="pass", reason="校验夹具：未提供断言证据")
        result = self.grade_record()
        self.assertEqual(result.returncode, 1, result.stderr or result.stdout)
        report = json.loads(result.stdout)
        self.assertFalse(report["record_consistent"])
        self.assertEqual(set(report["errors"]), {"source-change-preservation: pass/fail assertion needs evidence"})

    def test_model_case_cannot_pass_with_only_mock_attempt(self) -> None:
        row = next(row for row in self.record["cases"] if row["case_id"] == "raw-bootstrap")
        self.assertEqual(next(case for case in self.cases if case["id"] == row["case_id"])["mode"], "model")
        row["status"] = "pass"
        row["attempts"] = [{
            "attempt_id": "record-fixture", "mode": "model_mock",
            "started_at": "2026-11-02T00:00:00Z", "status": "pass", "trace": "trace.json",
        }]
        (self.directory / "trace.json").write_text('{"fixture":"record validation only"}\n', encoding="utf-8")
        for assertion in row["assertions"]:
            assertion.update(status="pass", reason="校验夹具：只有模拟模型证据", evidence=["trace.json"])
        result = self.grade_record()
        self.assertEqual(result.returncode, 1, result.stderr or result.stdout)
        report = json.loads(result.stdout)
        self.assertFalse(report["record_consistent"])
        self.assertEqual(set(report["errors"]), {"raw-bootstrap: a model case cannot pass only on mock evidence"})


if __name__ == "__main__":
    unittest.main()
