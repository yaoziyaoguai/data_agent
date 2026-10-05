"""独立检索比较；正式检索阶段不导入评分程序。"""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import os
import platform
import resource
import sys
import time
from collections import Counter
from pathlib import Path
from urllib.parse import urlsplit

from fixtures import ROOT, Fixtures, digest, load_json, runtime_id, write_json

GROUPS = ("current_lexical", "vector_only", "mem0")


def inputs_fingerprint() -> dict:
    directory = ROOT / "experiments/mem0-comparison"
    return {str(p.relative_to(ROOT)): digest(p) for p in sorted(directory.rglob("*"))
            if p.is_file() and "__pycache__" not in p.parts and p.suffix in (".py", ".toml", ".lock", ".in", ".md", ".rs")}


def read_config(args) -> tuple[Path, dict]:
    run_dir = (ROOT / args.run_dir).resolve()
    if run_dir.parent != (ROOT / ".local/mem0-comparison").resolve() or not run_dir.is_dir():
        raise ValueError("run_directory_outside_experiment")
    config = load_json(run_dir / "embedding-config.json")
    endpoint = urlsplit(config["base_url"])
    if endpoint.scheme != "https" or endpoint.username or endpoint.password or endpoint.query or not endpoint.hostname.endswith(".cn-beijing.maas.aliyuncs.com") or endpoint.path != "/compatible-mode/v1":
        raise ValueError("unapproved_embedding_endpoint")
    if config["model"] != "qwen3.7-text-embedding" or config["dimensions"] != 1024:
        raise ValueError("model_decision_mismatch")
    if config["milvus_url"] != "http://127.0.0.1:19531":
        raise ValueError("unapproved_milvus_endpoint")
    key = ROOT / config["key_file"]
    if key.resolve().parent != run_dir or key.stat().st_mode & 0o077:
        raise ValueError("credential_file_not_private")
    return run_dir, config


def owned_resources(run_dir: Path, names: list[str]) -> None:
    path = run_dir / "owned-resources.json"
    existing = load_json(path) if path.exists() else {"collections": [], "files_directory": str(run_dir.relative_to(ROOT)), "cleanup": "retain for evidence; remove only exact owned names"}
    for name in names:
        if not name.startswith("mem0_compare_" + run_dir.name + "_"):
            raise ValueError("resource_name_outside_run")
        if name not in existing["collections"]:
            existing["collections"].append(name)
    write_json(path, existing)


def milvus_client(config: dict):
    # 共享本地服务只经回环连接；继承的HTTP代理也会影响gRPC。
    for name in ("no_proxy", "NO_PROXY"):
        os.environ[name] = ",".join(filter(None, [os.environ.get(name, ""), "127.0.0.1", "localhost"]))
    from pymilvus import MilvusClient

    token = "root:" + (ROOT / config["milvus_token_file"]).read_text().strip()
    return MilvusClient(uri=config["milvus_url"], token=token, db_name="default", timeout=15)


def usage() -> dict:
    import psutil

    process = psutil.Process()
    cpu = process.cpu_times()
    value = resource.getrusage(resource.RUSAGE_SELF)
    peak_bytes = value.ru_maxrss if sys.platform == "darwin" else value.ru_maxrss * 1024
    return {"client_cpu_seconds": cpu.user + cpu.system, "client_rss_bytes": process.memory_info().rss,
            "client_peak_rss_bytes": peak_bytes}


def local_bytes(path: Path) -> int:
    return sum(p.stat().st_size for p in path.rglob("*") if p.is_file() and not p.is_symlink())


def search_receipt(group: str, question: dict, repeat: int, fixtures: Fixtures, lexical, indexes: dict, api) -> dict:
    from adapters import OperationError

    before = api.totals()
    start = time.perf_counter()
    row = {"group": group, "query_id": question["query_id"], "snapshot": question["snapshot"],
           "repeat": repeat, "principal": question["principal"], "raw": [], "valid": [],
           "rejected": [], "violations": [], "error": None}
    try:
        if group == "current_lexical":
            raw, engine = lexical.search(question["text"], fixtures.directory_input(question["principal"], question["snapshot"]))
        else:
            raw, engine = indexes[group, question["snapshot"]].search(question["text"], question["principal"])
        row["engine_elapsed_ms"] = (time.perf_counter() - start) * 1000
        if len(raw) > 20:
            raise OperationError("candidate_limit_exceeded")
        row.update(raw=raw, engine=engine)
        for candidate in raw:
            record = fixtures.record_by_version.get((candidate["runtime_id"], str(candidate["version"])))
            if record:
                candidate["asset_id"] = record["asset_id"]
        host_start = time.perf_counter()
        row.update(fixtures.validate(raw, question["principal"], question["snapshot"]))
        # Mem0的内部池也检查身份；它正常过取80条，返回给宿主的候选仍最多20。
        for backend in engine.get("backend", []):
            for candidate in backend["results"]:
                if (candidate["owner_id"], candidate["space_id"]) != (question["principal"]["user_id"], question["principal"]["space_id"]):
                    row["violations"].append(dict(candidate, reason="backend_principal_exposure"))
        row["host_elapsed_ms"] = (time.perf_counter() - host_start) * 1000
    except OperationError as error:
        row["error"] = str(error)
    except Exception as error:
        row["error"] = "search_" + type(error).__name__
    row["elapsed_ms"] = (time.perf_counter() - start) * 1000
    after = api.totals()
    row["calls"] = {k: after[k] - before[k] for k in before}
    return row


def sample(args) -> None:
    from adapters import DisabledLLM, EmbeddingAPI, Mem0Index, VectorIndex

    run_dir, config = read_config(args)
    if (run_dir / "sample-result.json").exists():
        raise ValueError("sample_already_recorded")
    api = EmbeddingAPI(config, run_dir)
    api.phase = "representative_sample"
    blocked = DisabledLLM()
    principal = {"user_id": "synthetic_precheck", "space_id": "synthetic_precheck_space"}
    records = []
    for index, (owner, space) in enumerate([(principal["user_id"], principal["space_id"]), ("synthetic_other_user", principal["space_id"]), (principal["user_id"], "synthetic_other_space")]):
        records.append({"asset_id": f"precheck_memory_{index}", "version": "1", "owner_id": owner,
                        "space_id": space, "kind": "memory", "name": "独立接口小样",
                        "body": "这份合成小样的报告金额用元展示，存储的整数金额单位为分。",
                        "scope": "仅用于接口与身份过滤预检。", "verified": False,
                        "dependencies": [], "source": {"kind": "synthetic_precheck", "reference": "precheck"}})
    prefix = "mem0_compare_" + run_dir.name + "_sample_"
    names = [prefix + "vector", prefix + "mem0", prefix + "mem0_entities"]
    owned_resources(run_dir, names)
    client = milvus_client(config)
    engine = None
    receipt = {"status": "failed", "scope": "independent synthetic API/index/filter sample"}
    try:
        vector = VectorIndex(client, names[0], api)
        vector.prepare(records)
        engine = Mem0Index(config, names[1], api, run_dir, blocked)
        receipt["mem0_features"] = engine.prepare(records)
        receipt["results"] = {}
        for name, adapter in [("vector_only", vector), ("mem0", engine)]:
            rows, details = adapter.search("合成小样的金额应该以什么单位展示？", principal)
            if not rows or any(r["runtime_id"] != runtime_id(records[0]) for r in rows):
                raise ValueError("sample_identity_filter_failed")
            receipt["results"][name] = {"raw": rows, "engine": details}
        if blocked.attempts:
            raise ValueError("sample_hidden_generation_attempt")
        receipt["status"] = "passed"
    finally:
        receipt["calls"] = api.totals()
        receipt["generation_attempts"] = blocked.attempts
        receipt["resources"] = {"created_collections": [n for n in names if client.has_collection(n)]}
        write_json(run_dir / "sample-result.json", receipt)
        if engine:
            engine.close()
        client.close()
        api.client.close()
    print(json.dumps({"status": receipt["status"], "sample": str((run_dir / "sample-result.json").relative_to(ROOT)), "calls": receipt["calls"]}, ensure_ascii=False), flush=True)


def run(args) -> None:
    from adapters import DisabledLLM, EmbeddingAPI, LexicalCaller, Mem0Index, VectorIndex

    run_dir, config = read_config(args)
    if (run_dir / "search-results.jsonl").exists() or (run_dir / "run-manifest.json").exists():
        raise ValueError("formal_run_already_recorded")
    if load_json(run_dir / "sample-result.json")["status"] != "passed":
        raise ValueError("representative_sample_required")
    fixture = Fixtures()
    api, blocked = EmbeddingAPI(config, run_dir), DisabledLLM()
    manifest = {"schema": 1, "status": "running", "run_id": run_dir.name,
                "model_decision": {k: config[k] for k in ("provider", "model", "dimensions", "decision", "documentation")},
                "endpoint_template": "https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
                "model_weight_revision": "not exposed by hosted API; identical model alias/config within this run",
                "preprocessing": {"passage": "name + newline + body + newline + scope", "query": "question.text only", "prefix": "none", "normalization": "L2", "query_cache": False},
                "limits": {"raw_candidates": 20, "valid_candidates": 5, "repeats": 3, "warmups_per_group": 4,
                           "mem0_internal_pool": 80, "mem0_threshold": 0.0, "api_request_limit": config["request_limit"], "maximum_charge_cny": config["maximum_charge_cny"]},
                "fixture_manifest": fixture.manifest, "source_sha256": inputs_fingerprint(),
                "sample_receipt_sha256": digest(run_dir / "sample-result.json"),
                "lexical_binary_sha256": digest(run_dir / "cargo-target/debug/asset-directory-caller"),
                "product_retrieval_source_sha256": digest(ROOT / "crates/data-agent/src/modules/retrieval/mod.rs"),
                "python": platform.python_version(),
                "dependencies": {d.metadata["Name"]: d.version for d in importlib.metadata.distributions()},
                "query_order": [q["query_id"] for q in fixture.questions],
                "index_receipts": {}, "metrics": {}, "scoring_answers_loaded": False}
    write_json(run_dir / "run-manifest.json", manifest)
    client = milvus_client(config)
    lexical = LexicalCaller(run_dir / "cargo-target/debug/asset-directory-caller", run_dir)
    indexes, created_mem0, unique = {}, [], {}
    measured_start = time.perf_counter()
    first_usage = usage()
    manifest["metrics"]["usage_before_formal_setup"] = api.totals()
    try:
        for snapshot in fixture.snapshots:
            records = fixture.indexed_records(snapshot)
            signature = hashlib.sha256(json.dumps(records, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:12]
            for group in GROUPS[1:]:
                key = group, signature
                if key not in unique:
                    name = "mem0_compare_" + run_dir.name + "_" + group + "_" + signature
                    owned_resources(run_dir, [name, name + "_entities"] if group == "mem0" else [name])
                    api.phase = f"index:{group}:{signature}"
                    begin, before = time.perf_counter(), api.totals()
                    if group == "vector_only":
                        index = VectorIndex(client, name, api)
                    else:
                        index = Mem0Index(config, name, api, run_dir, blocked)
                        created_mem0.append(index)
                    details = index.prepare(records)
                    unique[key] = index
                    manifest["index_receipts"][name] = {"elapsed_ms": (time.perf_counter() - begin) * 1000,
                                                          "calls": {k: api.totals()[k] - before[k] for k in before},
                                                          "details": details, "client_usage": usage()}
                    write_json(run_dir / "run-manifest.json", manifest)
                    print("index_ready", group, snapshot, len(records), flush=True)
                indexes[group, snapshot] = unique[key]
        manifest["snapshot_indexes"] = {s: {g: indexes[g, s].name for g in GROUPS[1:]} for s in fixture.snapshots}
        # 参数、源码和输入先固定；预热结果不参与语义评分。
        if manifest["source_sha256"] != inputs_fingerprint():
            raise ValueError("experiment_code_changed_after_freeze")
        manifest["warmups"] = []
        for group in GROUPS:
            api.phase = "warmup:" + group
            for question in fixture.questions[:4]:
                receipt = search_receipt(group, question, 0, fixture, lexical, indexes, api)
                manifest["warmups"].append(receipt)
                if receipt["error"] or receipt["violations"]:
                    raise ValueError("warmup_failed")
        write_json(run_dir / "run-manifest.json", manifest)
        with (run_dir / "search-results.jsonl").open("x") as output:
            completed = 0
            for group in GROUPS:
                for repeat in range(1, 4):
                    api.phase = f"formal:{group}:{repeat}"
                    for question in fixture.questions:
                        receipt = search_receipt(group, question, repeat, fixture, lexical, indexes, api)
                        output.write(json.dumps(receipt, ensure_ascii=False) + "\n")
                        output.flush()
                        completed += 1
                        if completed % 16 == 0:
                            print("retrieval_progress", completed, "/288", group, repeat, flush=True)
        manifest["status"] = "retrieval_complete"
    finally:
        for index in created_mem0:
            index.close()
        lexical.close()
        client.close()
        api.client.close()
        manifest["metrics"].update(api.totals())
        manifest["metrics"].update(usage())
        manifest["metrics"]["client_cpu_seconds_delta"] = usage()["client_cpu_seconds"] - first_usage["client_cpu_seconds"]
        manifest["metrics"]["measured_elapsed_seconds"] = time.perf_counter() - measured_start
        manifest["metrics"]["generation_attempts"] = blocked.attempts
        manifest["metrics"]["local_run_directory_bytes"] = local_bytes(run_dir)
        manifest["metrics"]["milvus_collection_disk_bytes"] = None
        manifest["metrics"]["model_load_seconds"] = None
        manifest["metrics"]["measurement_limits"] = ["hosted model has no local load/RSS measurement", "client metrics shared across groups; server disk/CPU not attributable", "run-directory bytes include isolated dependencies and Rust build outputs"]
        manifest["final_source_sha256"] = inputs_fingerprint()
        write_json(run_dir / "run-manifest.json", manifest)
    print("retrieval_complete", manifest["status"], api.totals(), flush=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["preflight", "self-test", "sample", "run", "report"])
    parser.add_argument("--run-dir", required=False)
    args = parser.parse_args()
    if args.command == "self-test":
        import unittest
        suite = unittest.defaultTestLoader.discover(str(Path(__file__).parent), pattern="test_*.py")
        result = unittest.TextTestRunner(verbosity=2).run(suite)
        if not result.wasSuccessful():
            raise SystemExit(1)
        return
    if not args.run_dir:
        parser.error("--run-dir is required")
    if args.command == "preflight":
        run_dir, config = read_config(args)
        fixture = Fixtures()
        print(json.dumps({"status": "passed", "model": config["model"], "dimensions": config["dimensions"], "fixtures": fixture.manifest["counts"], "source_sha256": inputs_fingerprint(), "model_calls": 0}, ensure_ascii=False))
    elif args.command == "sample":
        sample(args)
    elif args.command == "run":
        run(args)
    else:
        from scoring import report
        report((ROOT / args.run_dir).resolve())


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        from adapters import OperationError
        message = str(error) if isinstance(error, (OperationError, ValueError)) and str(error).isidentifier() else type(error).__name__
        print(json.dumps({"status": "failed", "error": message}), file=sys.stderr, flush=True)
        raise SystemExit(1)
