#!/usr/bin/env python3
"""验证目录只读核对、来源隔离和业务定义的单一来源。"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

MODULE_PATH = Path(__file__).with_name("build_semantic_catalog.py")
SPEC = importlib.util.spec_from_file_location("build_semantic_catalog", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
CATALOG = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CATALOG)


class SemanticCatalogTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        for name in (*CATALOG.SOURCE_IDS, "knowledge-manifest.json"):
            shutil.copyfile(CATALOG.SOURCE_DIRECTORY / name, self.directory / name)

    def entry(self, catalog: dict, ident: str, path: str) -> dict:
        obj = next(obj for obj in catalog["objects"] if obj["id"] == ident)
        return next(entry for entry in obj["entries"] if entry["path"] == path)

    def check_command(self) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(MODULE_PATH), "--source-directory", str(self.directory), "--check"],
            capture_output=True, text=True, timeout=30, check=False,
        )

    def test_check_does_not_create_or_replace_catalog(self) -> None:
        target = self.directory / "semantic-catalog.json"
        self.assertEqual(self.check_command().returncode, 1)
        self.assertFalse(target.exists())
        original = CATALOG.render_catalog(CATALOG.build_catalog(self.directory))
        target.write_text(original, encoding="utf-8")
        before = target.stat().st_mtime_ns
        self.assertEqual(self.check_command().returncode, 0)
        self.assertEqual(target.stat().st_mtime_ns, before)

        guide = self.directory / "business-guide.md"
        guide.write_text(guide.read_text(encoding="utf-8") + "\n资料变动。\n", encoding="utf-8")
        self.assertEqual(self.check_command().returncode, 1)
        self.assertEqual(target.read_text(encoding="utf-8"), original)
        self.assertEqual(target.stat().st_mtime_ns, before)

    def test_business_definition_changes_are_taken_from_document(self) -> None:
        guide = self.directory / "business-guide.md"
        text = guide.read_text(encoding="utf-8")
        text = text.replace("- 别名：净收入 收入 净收", "- 别名：新增合成别名")
        text = text.replace("SELECT SUM(paid_amount_cents - refunded_amount_cents) AS net_revenue",
                            "SELECT SUM(paid_amount_cents) AS net_revenue")
        guide.write_text(text, encoding="utf-8")
        catalog = CATALOG.build_catalog(self.directory)
        self.assertEqual(self.entry(catalog, "metric-net_revenue", "aliases")["effective_value"], "新增合成别名")
        self.assertIn("SELECT SUM(paid_amount_cents) AS net_revenue",
                      self.entry(catalog, "metric-net_revenue", "sql")["effective_value"])

    def test_every_complete_fact_quotes_current_source_and_marks_authored_definition(self) -> None:
        catalog = CATALOG.build_catalog(self.directory)
        sources = {source_id: (self.directory / name).read_text(encoding="utf-8")
                   for name, source_id in CATALOG.SOURCE_IDS.items()}
        for obj in catalog["objects"]:
            for entry in obj["entries"]:
                facts = entry["source_facts"]
                if facts["complete"]:
                    self.assertIn(facts["quote"], sources[facts["source_id"]])
                    if facts["source_id"] == "business-guide":
                        self.assertEqual(facts["classification"], "authored_definition")
                self.assertEqual(entry["review_state"], "unverified")
                self.assertIsNone(entry["human_override"])

    def test_type_derivation_keeps_original_declaration(self) -> None:
        entry = self.entry(CATALOG.build_catalog(self.directory), "field-customer_id", "type")
        self.assertEqual(entry["source_facts"]["quote"], "customer_id TEXT")
        self.assertEqual(entry["source_facts"]["value"], "customer_id TEXT")
        self.assertEqual(entry["effective_value"], "TEXT，可空")
        self.assertEqual(entry["suggestion"]["method"], "ddl_type_derivation")

    def test_missing_source_etl_stays_unknown(self) -> None:
        entry = self.entry(CATALOG.build_catalog(self.directory), "table-raw_payments", "etl")
        self.assertFalse(entry["source_facts"]["complete"])
        self.assertEqual(entry["effective_value"], "")
        self.assertEqual(entry["suggestion"], {})

    def test_conflicting_document_type_fails_instead_of_creating_fact(self) -> None:
        guide = self.directory / "business-guide.md"
        text = guide.read_text(encoding="utf-8").replace("| `quantity` | INTEGER |", "| `quantity` | TEXT |")
        guide.write_text(text, encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "quantity.*类型"):
            CATALOG.build_catalog(self.directory)

    def test_generation_does_not_use_evaluation_answers(self) -> None:
        baseline = CATALOG.build_catalog(self.directory)
        evaluation = self.directory / "evaluation"
        evaluation.mkdir()
        (evaluation / "cases.json").write_text("非法 JSON 与独立答案，不是知识输入", encoding="utf-8")
        self.assertEqual(CATALOG.build_catalog(self.directory), baseline)

    def test_business_domain_requires_an_explicit_source_declaration(self) -> None:
        catalog = CATALOG.build_catalog(self.directory)
        for obj in catalog["objects"]:
            domain = next(entry for entry in obj["entries"] if entry["path"] == "business_domain")
            self.assertEqual(domain["effective_value"], "合成零售")
            self.assertIn("业务域标识", domain["source_facts"]["quote"])
        guide = self.directory / "business-guide.md"
        text = guide.read_text(encoding="utf-8")
        text = "\n".join(line for line in text.split("\n") if not line.startswith("业务域标识："))
        guide.write_text(text + "\n这里只提到合成零售，并没有为对象指定业务域。\n", encoding="utf-8")
        rebuilt = CATALOG.build_catalog(self.directory)
        self.assertTrue(all(not any(entry["path"] == "business_domain" for entry in obj["entries"])
                            for obj in rebuilt["objects"]))

    def test_manifest_cannot_expand_input_to_evaluation(self) -> None:
        manifest_path = self.directory / "knowledge-manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["knowledge_files"].append("evaluation/cases.json")
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "知识输入"):
            CATALOG.build_catalog(self.directory)


if __name__ == "__main__":
    unittest.main()
