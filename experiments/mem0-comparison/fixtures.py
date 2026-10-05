"""固定合成输入与宿主有效性检查；不读取评分答案。"""

from __future__ import annotations

import copy
import hashlib
import json
import uuid
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "docs/research/mem0-comparison"
NAMESPACE = uuid.UUID("46b1baba-69ef-4a7b-b1f4-177eca0106ba")


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        value = hashlib.file_digest(stream, "sha256")
    return value.hexdigest()


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def asset_key(record: dict) -> tuple[str, str, str]:
    return record["owner_id"], record["space_id"], record["asset_id"]


def runtime_id(record: dict) -> str:
    return str(uuid.uuid5(NAMESPACE, json.dumps(asset_key(record), ensure_ascii=False)))


def tenant_id(principal: dict) -> str:
    return str(uuid.uuid5(NAMESPACE, json.dumps([principal["user_id"], principal["space_id"]])))


def embedding_text(record: dict) -> str:
    return "\n".join(record[key] for key in ("name", "body", "scope"))


class Fixtures:
    def __init__(self) -> None:
        self.manifest = load_json(FIXTURES / "fixture-manifest.json")
        for name, expected in self.manifest["files"].items():
            path = FIXTURES / name
            if path.stat().st_size != expected["bytes"] or digest(path) != expected["sha256"]:
                raise ValueError(f"frozen_fixture_changed:{name}")
        self.records = load_json(FIXTURES / "source-memories.json")["records"]
        queries = load_json(FIXTURES / "questions.json")
        self.questions = queries["questions"]
        self.defaults = queries["authority_defaults"]
        self.snapshot_specs = queries["authority_snapshots"]
        self.record_by_version = {(runtime_id(r), r["version"]): r for r in self.records}
        if len(self.record_by_version) != len(self.records):
            raise ValueError("duplicate_record_version")
        if len({q["query_id"] for q in self.questions}) != len(self.questions):
            raise ValueError("duplicate_query")
        if len(self.records) != 25 or len(self.questions) != 32:
            raise ValueError("unexpected_fixture_count")
        self.snapshots = {name: self._snapshot(name) for name in self.snapshot_specs}
        for question in self.questions:
            if question["snapshot"] not in self.snapshots:
                raise ValueError("unknown_snapshot")

    def _snapshot(self, name: str, ancestors: tuple = ()) -> dict:
        if name in ancestors:
            raise ValueError("snapshot_cycle")
        spec = self.snapshot_specs[name]
        result = self._snapshot(spec["base"], ancestors + (name,)) if "base" in spec else {
            "include_versions": [], "asset_overrides": [], "knowledge_versions": {}
        }
        result = copy.deepcopy(result)
        if "include_versions" in spec:
            result["include_versions"] = spec["include_versions"][:]
        result["knowledge_versions"].update(spec.get("knowledge_versions", {}))
        overrides = {asset_key(r): r for r in result["asset_overrides"]}
        overrides.update({asset_key(r): r for r in spec.get("asset_overrides", [])})
        result["asset_overrides"] = list(overrides.values())
        return result

    def indexed_records(self, snapshot: str) -> list[dict]:
        refs = set(self.snapshots[snapshot]["include_versions"])
        result = [r for r in self.records if f'{r["asset_id"]}@{r["version"]}' in refs]
        if len(result) != len(refs):
            raise ValueError("invalid_index_reference")
        return result

    def invalid_reason(self, record: dict, principal: dict, snapshot: str) -> str | None:
        if (record["owner_id"], record["space_id"]) != (principal["user_id"], principal["space_id"]):
            return "principal_mismatch"
        authority = self.snapshots[snapshot]
        state = dict(self.defaults)
        for override in authority["asset_overrides"]:
            if asset_key(override) == asset_key(record):
                state.update(override)
        if state["state"] != "enabled":
            return "asset_" + state["state"]
        if state["current_version"] != record["version"]:
            return "stale_asset_version"
        if any(authority["knowledge_versions"].get(d["object_id"]) != d["version"] for d in record["dependencies"]):
            return "stale_dependency_version"
        return None

    def formal_records(self, principal: dict, snapshot: str) -> list[dict]:
        return [r for r in self.indexed_records(snapshot) if self.invalid_reason(r, principal, snapshot) is None]

    def validate(self, candidates: list[dict], principal: dict, snapshot: str, limit: int = 5) -> dict:
        valid, rejected, violations = [], [], []
        seen = set()
        for rank, candidate in enumerate(candidates, 1):
            candidate = dict(candidate, rank=rank)
            key = (candidate["runtime_id"], str(candidate["version"]))
            record = self.record_by_version.get(key)
            if record is None:
                reason = "unmapped_engine_result"
                violations.append(dict(candidate, reason=reason))
            else:
                candidate.update(asset_id=record["asset_id"], owner_id=record["owner_id"], space_id=record["space_id"])
                reason = self.invalid_reason(record, principal, snapshot)
                if reason == "principal_mismatch":
                    violations.append(dict(candidate, reason="raw_principal_exposure"))
            if reason:
                rejected.append(dict(candidate, reason=reason))
                continue
            if key in seen:
                rejected.append(dict(candidate, reason="duplicate_record"))
                continue
            seen.add(key)
            if len(valid) < limit:
                valid.append(dict(candidate, record=copy.deepcopy(record), visibility="personal"))
        return {"valid": valid, "rejected": rejected, "violations": violations}

    def directory_input(self, principal: dict, snapshot: str) -> list[dict]:
        return [dict(r, id=runtime_id(r), selected=False) for r in self.formal_records(principal, snapshot)]
