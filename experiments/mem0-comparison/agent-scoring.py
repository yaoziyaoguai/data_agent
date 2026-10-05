"""只在Agent完成后读取独立要求；保留机械核算和最终内容复核的区别。"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import re
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("business_evaluation", ROOT / "scripts/evaluate_business_sql.py")
business = importlib.util.module_from_spec(spec)
spec.loader.exec_module(business)


def score_step(step, expected, previous):
    checks = []
    check = lambda name, value: checks.append({"name": name, "passed": bool(value)})
    check("完整真实Agent输出", step.get("machine_complete") is True and bool(step.get("answer")))
    active = [value for value in step.get("assets", []) if value["kind"] == "memory" and value["state"] == "enabled"]
    if "active_memory_count" in expected:
        check("有效个人记忆数", len(active) == expected["active_memory_count"])
    if expected.get("has_active_memory"):
        check("确有持久可读记忆", bool(active) and all(value["body"].strip() for value in active))
    if expected.get("memory_unchanged"):
        fields = ("id", "version", "body", "source_text", "scope", "state")
        snapshot = lambda rows: sorted(tuple(value[key] for key in fields) for value in rows if value["kind"] == "memory")
        check("临时覆盖未改长期资产", snapshot(step.get("assets", [])) == snapshot(previous.get("assets", [])))
    if expected.get("same_asset_revised"):
        old = [value for value in previous.get("assets", []) if value["kind"] == "memory" and value["state"] == "enabled"]
        check("修订原资产并提升版本", len(old) == len(active) == 1 and old[0]["id"] == active[0]["id"] and int(active[0]["version"]) > int(old[0]["version"]))
    if expected.get("active_memory_all_unverified"):
        check("个人线索未冒充核实口径", all(value["verified"] is False for value in active))
    queries = step.get("queries", [])
    if expected.get("no_query"):
        check("没有生成不需要的查询", not queries)
    numerical = None
    if "sql_channel" in expected:
        check("生成了待确认SQL", bool(queries))
        if queries:
            query = queries[-1]
            check("只读检查和未确认状态", query["check_state"] == "passed" and query["execution_state"] == "not_submitted")
            conditions = next((value["body"] for value in step.get("conditions", [])
                               if value["task_id"] == query["task_id"] and value["version"] == query["condition_version"]), None)
            check("任务渠道与用户要求一致", conditions is not None and conditions.get("channel") == expected["sql_channel"])
            sample = {"case_id": "net_revenue_scope", "channel": expected["sql_channel"],
                      "sql": query["sql"], "parameters": query["parameters"]}
            numerical = business.evaluate(sample)
            if expected.get("money_unit") == "yuan":
                # 单列时按预定的用户单位核算，不能让模型列名反过来选择答案单位。
                if len(numerical.get("columns", [])) == 1:
                    column = numerical["columns"][0].replace('"', '""')
                    wrapped = f'SELECT "{column}" AS net_yuan FROM ({query["sql"].rstrip().rstrip(";")})'
                    numerical = business.evaluate({**sample, "sql": wrapped})
                else:
                    check("目标净收入明确输出元金额列", any(re.search(r"net|revenue|净收入", value, re.I) and re.search(r"yuan|rmb|cny|元", value, re.I) for value in numerical.get("columns", [])))
            check("独立种子及数据变体核算", numerical["passed"])
    if expected.get("must_report_save_failure"):
        check("告知持久保存失败（文字初筛）", bool(re.search(r"(未|没|不能|无法|失败|未能).{0,12}(保存|记住)|(保存|记住).{0,12}(失败|未成功|没有成功)", step.get("answer", ""))))
    return {"checks": checks, "machine_passed": all(value["passed"] for value in checks), "sql_evaluation": numerical,
            "language_review": "pending_independent_review"}


def database_failure_count(logs):
    # 当前服务只记录脱敏后的SQLSTATE；不依赖数据库异常的原始正文。
    return sum(len(re.findall(r"\bstorage_failure kind=database code=45000\b", item.get("output", ""))) for item in logs)


def database_failure_evidence(scenario):
    if not scenario.get("harness_directory"):
        return {"triggered": False}
    directory = Path(scenario["harness_directory"]).resolve()
    if not directory.is_relative_to((ROOT / ".local/checks").resolve()):
        raise ValueError("unexpected_harness_log_path")
    path = directory / "service-logs.json"
    if not path.exists():
        return {"triggered": False}
    raw = path.read_bytes()
    count = database_failure_count(json.loads(raw))
    return {"triggered": count > 0, "log": str(path.relative_to(ROOT)),
            "sha256": hashlib.sha256(raw).hexdigest(), "sqlstate_45000_count": count}


def score(run_dir, output_name="scoring.json"):

    raw = (run_dir / "result.json").read_bytes()
    result = json.loads(raw)
    if result.get("preseededProbe"):
        expected = {"provider_probe": {"steps": {"0": {"sql_channel": "store", "has_active_memory": True}}}}
    elif result["sample"]:
        expected = {"sample": {"steps": {"0": {"has_active_memory": True, "no_query": True},
                                                     "1": {"sql_channel": "store"}}}}
    else:
        expected = json.loads((ROOT / "experiments/mem0-comparison/agent-expected.json").read_text())["scenarios"]
    repetitions = 2
    scored = []
    actual = {(value["id"], value["group"], value.get("repetition", 1)): value for value in result["scenarios"]}
    if len(actual) != len(result["scenarios"]):
        raise ValueError("duplicate_scenario_receipt")
    if set(actual) - {(name, group, repeat) for name in expected for group in ("original", "mem0") for repeat in range(1, repetitions + 1)}:
        raise ValueError("unexpected_scenario_receipt")
    for name in expected:
     for repeat in range(1, repetitions + 1):
      for group in ("original", "mem0"):
        scenario = actual.get((name, group, repeat), {"id": name, "group": group, "steps": [], "incomplete": True, "missing": True})
        criteria = expected[scenario["id"]]
        steps = scenario["steps"]
        previous = {}
        scored_steps = []
        for index, wanted in criteria.get("original_steps" if group == "original" else "steps", criteria["steps"]).items():
            step = next((value for value in steps if value["index"] == int(index)), {})
            scored_steps.append({"index": int(index), **score_step(step, wanted, previous)})
            previous = step
        fault = name in {"index_failure", "extraction_failure", "save_failure"}
        triggered = True
        database_evidence = None
        if name == "save_failure":
            database_evidence = database_failure_evidence(scenario)
            triggered = database_evidence["triggered"]
        if name in {"index_failure", "extraction_failure"} and group == "mem0":
            action = "commit_failed" if name == "index_failure" else "prepare_failed"
            error = "synthetic_index_commit_unavailable" if name == "index_failure" else "synthetic_extraction_unavailable"
            triggered = any(value.get("action") == action and value.get("error") == error for value in scenario.get("memoryTrace", []))
        scored.append({"id": scenario["id"], "group": scenario["group"], "repetition": repeat,
                       "category": "fault" if fault else "normal", "fault_triggered": triggered, "database_evidence": database_evidence, "steps": scored_steps,
                       "machine_passed": triggered and not scenario.get("incomplete") and all(value["machine_passed"] for value in scored_steps),
                       "review_requirement": criteria.get("review", "独立小样核对"), "language_review": "pending_independent_review"})
    summary = {}
    for group in ("original", "mem0"):
        rows = [value for value in scored if value["group"] == group]
        summary[group] = {category: {"total": len(selected), "machine_passed": sum(value["machine_passed"] for value in selected)}
                          for category in ("normal", "fault")
                          for selected in [[value for value in rows if value["category"] == category]]}
    output = {"schema": 1, "measurement_sha256": hashlib.sha256(raw).hexdigest(), "summary": summary,
              "coverage": {"expected_receipts": len(expected) * 2 * repetitions, "actual_receipts": len(actual),
                           "missing": [[name, group, repeat] for name in expected for group in ("original", "mem0") for repeat in range(1, repetitions + 1) if (name, group, repeat) not in actual]},
              "scenarios": scored, "quality_status": "pending_independent_review"}
    (run_dir / output_name).write_text(json.dumps(output, ensure_ascii=False, indent=2))
    print(json.dumps(summary))


class ScoringTests(unittest.TestCase):
    def evaluate(self, sql, unit=None, channel=None):
        return score_step({"machine_complete": True, "answer": "合成输出", "assets": [],
                           "conditions": [{"task_id": "t", "version": "1", "body": {"channel": channel}}],
                           "queries": [{"sql": sql, "parameters": {}, "check_state": "passed",
                                        "execution_state": "not_submitted", "task_id": "t", "condition_version": "1"}]},
                          {"sql_channel": channel, **({"money_unit": unit} if unit else {})}, {})

    def test_yuan_requirement_is_independent_of_column_name(self):
        where = "FROM demo_order_detail WHERE is_test=0 AND paid_amount_cents>0 AND paid_at>='2026-01-01T00:00:00Z' AND paid_at<'2026-02-01T00:00:00Z'"
        self.assertTrue(self.evaluate("SELECT SUM(paid_amount_cents-refunded_amount_cents)/100.0 AS amount " + where, "yuan")["machine_passed"])
        self.assertFalse(self.evaluate("SELECT SUM(paid_amount_cents-refunded_amount_cents) AS amount " + where, "yuan")["machine_passed"])

    def test_wrong_channel_is_rejected(self):
        sql = "SELECT SUM(paid_amount_cents-refunded_amount_cents) AS net_cents FROM demo_order_detail WHERE is_test=0 AND paid_amount_cents>0 AND paid_at>='2026-01-01T00:00:00Z' AND paid_at<'2026-02-01T00:00:00Z' AND channel='app'"
        self.assertFalse(self.evaluate(sql, channel="web")["machine_passed"])

    def test_paid_yuan_does_not_satisfy_net_yuan_requirement(self):
        sql = "SELECT SUM(paid_amount_cents-refunded_amount_cents) AS net_cents, SUM(paid_amount_cents)/100.0 AS paid_yuan FROM demo_order_detail WHERE is_test=0 AND paid_amount_cents>0 AND paid_at>='2026-01-01T00:00:00Z' AND paid_at<'2026-02-01T00:00:00Z'"
        self.assertFalse(self.evaluate(sql, unit="yuan")["machine_passed"])

    def test_missing_output_is_failure(self):
        self.assertFalse(score_step({}, {"sql_channel": None}, {})["machine_passed"])

    def test_false_memory_persistence_is_failure(self):
        self.assertFalse(score_step({"machine_complete": True, "answer": "已经保存", "assets": [], "queries": []}, {"has_active_memory": True}, {})["machine_passed"])

    def test_temporary_requirement_cannot_be_persisted(self):
        self.assertFalse(score_step({"machine_complete": True, "answer": "完成", "assets": [{"kind": "memory", "state": "enabled", "body": "app"}], "queries": []}, {"active_memory_count": 0}, {})["machine_passed"])

    def test_temporary_override_accepts_explanatory_text_without_mutation(self):
        asset = {"id": "a", "version": "1", "body": "默认web，仅当次明确要求app时当次覆盖", "kind": "memory",
                 "source_text": "以后默认web", "scope": "默认渠道", "state": "enabled"}
        step = {"machine_complete": True, "answer": "完成", "assets": [asset]}
        self.assertTrue(score_step(step, {"memory_unchanged": True}, step)["machine_passed"])
        changed = {**step, "assets": [{**asset, "body": "默认app", "version": "2"}]}
        self.assertFalse(score_step(changed, {"memory_unchanged": True}, step)["machine_passed"])

    def test_database_failure_uses_sanitized_sqlstate(self):
        self.assertEqual(database_failure_count([{"output": "storage_failure kind=database code=45000\n"}]), 1)
        self.assertEqual(database_failure_count([{"output": "storage_failure kind=database code=1213\n"}]), 0)
        self.assertEqual(database_failure_count([{"output": "scope_incomplete"}]), 0)

    def test_missing_scenarios_keep_the_fixed_denominator(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            (directory / "result.json").write_text(json.dumps({"sample": False, "scenarios": []}))
            score(directory)
            result = json.loads((directory / "scoring.json").read_text())
            self.assertEqual(result["summary"]["original"]["normal"], {"total": 18, "machine_passed": 0})
            self.assertEqual(result["summary"]["mem0"]["normal"], {"total": 18, "machine_passed": 0})
            self.assertEqual(len(result["coverage"]["missing"]), 48)

    def test_unverified_correction_must_be_saved(self):
        self.assertFalse(score_step({"machine_complete": True, "answer": "保存好了", "assets": [], "queries": []},
                                    {"active_memory_count": 1, "active_memory_all_unverified": True}, {})["machine_passed"])


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        unittest.main(argv=[sys.argv[0]])
    else:
        output_name = sys.argv[sys.argv.index("--output") + 1] if "--output" in sys.argv else "scoring.json"
        if not re.fullmatch(r"[a-z0-9_-]+\.json", output_name):
            raise ValueError("invalid_output_name")
        score(Path(sys.argv[1]), output_name)
