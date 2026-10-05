"""独立评分阶段；此模块由正式检索完成后的report命令加载。"""

from __future__ import annotations

import json
import statistics
from collections import Counter
from pathlib import Path

from fixtures import FIXTURES, ROOT, Fixtures, digest, load_json, write_json

GROUPS = ("current_lexical", "vector_only", "mem0")


def record_ref(candidate: dict) -> str:
    return candidate["asset_id"] + "@" + str(candidate["version"])


def relevance_metrics(refs: list[str], relevant: list[str], error: str | None = None) -> dict:
    if len(set(relevant)) != len(relevant):
        raise ValueError("duplicate_relevant_record")
    if error:
        return {"recall_at_5": 0.0 if relevant else None,
                "mrr_at_5": 0.0 if relevant else None, "negative_noise": None}
    top = refs[:5]
    if not relevant:
        return {"recall_at_5": None, "mrr_at_5": None, "negative_noise": bool(top)}
    recall = len(set(top).intersection(relevant)) / len(relevant)
    mrr = next((1 / rank for rank, ref in enumerate(top, 1) if ref in relevant), 0.0)
    return {"recall_at_5": recall, "mrr_at_5": mrr, "negative_noise": None}


def percentile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    values = sorted(values)
    position = (len(values) - 1) * fraction
    lo = int(position)
    hi = min(lo + 1, len(values) - 1)
    return values[lo] * (hi - position) + values[hi] * (position - lo) if hi != lo else values[lo]


def assert_complete(rows: list[dict], question_ids: list[str]) -> None:
    expected = {(group, q, repeat) for group in GROUPS for q in question_ids for repeat in range(1, 4)}
    keys = [(r["group"], r["query_id"], r["repeat"]) for r in rows]
    if len(keys) != len(set(keys)):
        raise ValueError("duplicate_search_receipt")
    if set(keys) != expected:
        raise ValueError("missing_or_unexpected_search_receipt")


def evaluate(rows: list[dict], cases: list[dict], questions: list[dict]) -> dict:
    case_by_id = {c["query_id"]: c for c in cases}
    if len(case_by_id) != len(cases) or set(case_by_id) != {q["query_id"] for q in questions}:
        raise ValueError("answer_coverage_mismatch")
    assert_complete(rows, [q["query_id"] for q in questions])
    output = {"groups": {}, "per_query": {}, "violations": [], "metadata_failures": [], "rows": []}
    for row in rows:
        case = case_by_id[row["query_id"]]
        metrics = relevance_metrics([record_ref(c) for c in row["valid"]], case["relevant_records"], row["error"])
        item = {"group": row["group"], "query_id": row["query_id"], "repeat": row["repeat"], **metrics,
                "candidate_refs": [record_ref(c) for c in row["valid"]], "error": row["error"]}
        output["rows"].append(item)
        for violation in row["violations"]:
            output["violations"].append({"group": row["group"], "query_id": row["query_id"], "repeat": row["repeat"], **violation})
        forbidden_final = set(case.get("forbidden_final_records", [])) | set(case.get("forbidden_raw_and_final_records", []))
        forbidden_raw = set(case.get("forbidden_raw_and_final_records", []))
        for stage, values, forbidden in [("raw", row["raw"], forbidden_raw), ("final", row["valid"], forbidden_final)]:
            for candidate in values:
                if candidate.get("asset_id") and record_ref(candidate) in forbidden:
                    output["violations"].append({"group": row["group"], "query_id": row["query_id"], "repeat": row["repeat"], "stage": stage, "record": record_ref(candidate), "reason": "forbidden_record"})
        for candidate in row["valid"]:
            record = candidate["record"]
            missing = [field for field in ("asset_id", "version", "owner_id", "space_id", "name", "body", "scope", "source", "verified") if field not in record]
            if missing or not isinstance(record.get("verified"), bool) or not record.get("source"):
                output["metadata_failures"].append({"query_id": row["query_id"], "group": row["group"], "repeat": row["repeat"], "record": record_ref(candidate), "missing": missing})
            required = case.get("required_metadata", {}).get(record_ref(candidate), {})
            for field, expected in required.items():
                actual = candidate.get(field, record.get(field))
                if actual != expected:
                    output["metadata_failures"].append({"query_id": row["query_id"], "group": row["group"], "repeat": row["repeat"], "record": record_ref(candidate), "field": field, "expected": expected, "actual": actual})
    for group in GROUPS:
        scored = [r for r in output["rows"] if r["group"] == group]
        original = [r for r in rows if r["group"] == group]
        positives = [r for r in scored if r["recall_at_5"] is not None]
        negatives = [r for r in scored if r["negative_noise"] is not None]
        output["groups"][group] = {
            "completed_receipts": len(original), "failed_receipts": sum(r["error"] is not None for r in original),
            "positive_unique_questions": len({r["query_id"] for r in positives}),
            "negative_unique_questions": len({c["query_id"] for c in cases if not c["relevant_records"]}),
            "recall_at_5": statistics.mean(r["recall_at_5"] for r in positives),
            "mrr_at_5": statistics.mean(r["mrr_at_5"] for r in positives),
            "negative_candidate_noise": statistics.mean(r["negative_noise"] for r in negatives) if negatives else None,
            "successful_negative_receipts": len(negatives),
            "latency_p50_ms": percentile([r["elapsed_ms"] for r in original], .5),
            "latency_p95_ms": percentile([r["elapsed_ms"] for r in original], .95),
            "engine_p50_ms": percentile([r.get("engine_elapsed_ms", r["elapsed_ms"]) for r in original], .5),
            "host_p50_ms": percentile([r.get("host_elapsed_ms", 0) for r in original], .5),
            "boundary_violations": sum(v["group"] == group for v in output["violations"]),
            "metadata_failures": sum(v["group"] == group for v in output["metadata_failures"]),
            "metadata_checked_candidates": sum(len(r["valid"]) for r in original),
            "rejected_reasons": dict(Counter(c["reason"] for r in original for c in r["rejected"])),
            "embedding_api_requests": sum(r["calls"]["embedding_api_requests"] for r in original)}
        output["per_query"][group] = {}
        for case in cases:
            values = [r for r in scored if r["query_id"] == case["query_id"]]
            output["per_query"][group][case["query_id"]] = {
                "recall_at_5": statistics.mean(r["recall_at_5"] for r in values) if case["relevant_records"] else None,
                "mrr_at_5": statistics.mean(r["mrr_at_5"] for r in values) if case["relevant_records"] else None,
                "distinct_rankings": len({tuple(r["candidate_refs"]) for r in values}),
                "first_round_candidates": values[0]["candidate_refs"], "relevant_records": case["relevant_records"]}
    output["counts"] = {"search_receipts": len(rows), "queries": len(questions), "positive_queries": sum(bool(c["relevant_records"]) for c in cases),
                        "negative_queries": sum(not c["relevant_records"] for c in cases), "failed_receipts": sum(r["error"] is not None for r in rows)}
    return output


def report(run_dir: Path) -> None:
    fixture = Fixtures()
    manifest = load_json(run_dir / "run-manifest.json")
    if manifest["status"] != "retrieval_complete" or manifest["source_sha256"] != manifest["final_source_sha256"]:
        raise ValueError("retrieval_incomplete_or_code_changed")
    rows = [json.loads(line) for line in (run_dir / "search-results.jsonl").read_text().splitlines()]
    # 评分答案只在正式检索结束后解析；它们不传给任何检索或模型适配器。
    answers = load_json(FIXTURES / "expected-results.json")
    result = evaluate(rows, answers["cases"], fixture.questions)
    result.update(schema=1, run_id=run_dir.name, metrics=manifest["metrics"], model=manifest["model_decision"],
                  input_sha256=digest(run_dir / "search-results.jsonl"), index_receipts=manifest["index_receipts"],
                  status="measurement_complete", independent_review="pending",
                  limits=["32 synthetic queries; repetitions measure timing/stability, not independent business cases",
                          "infer=False; no extraction, conflict adjudication, Agent answers or Pi workflow measurement",
                          "host validity is an offline synthetic snapshot, not a new MySQL authorization test",
                          "hosted model weights/tokenizer revision not exposed; compare one alias/config within this run",
                          "0 score threshold and fixed candidate counts measure recall/noise, not final adoption accuracy",
                          "optional English spaCy NLP not installed; entity enhancement not tested"])
    write_json(run_dir / "result.json", result)
    manifest["scoring_answers_loaded"] = True
    manifest["scoring_answer_sha256"] = fixture.manifest["files"]["expected-results.json"]["sha256"]
    write_json(run_dir / "run-manifest.json", manifest)
    print(json.dumps({"status": result["status"], "counts": result["counts"], "groups": result["groups"], "violations": len(result["violations"]), "metadata_failures": len(result["metadata_failures"])}, ensure_ascii=False), flush=True)
