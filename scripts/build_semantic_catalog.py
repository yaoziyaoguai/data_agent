#!/usr/bin/env python3
"""从知识允许列表生成合成语义目录；--check 只核对，不写入文件。"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import sys
from typing import Any

SOURCE_DIRECTORY = Path(__file__).resolve().parents[1] / "docs/sources"
SOURCE_IDS = {
    "schema.sql": "schema",
    "etl.sql": "etl",
    "business-guide.md": "business-guide",
}
CATALOG_FILE = "semantic-catalog.json"


def read_knowledge_sources(directory: Path) -> dict[str, str]:
    manifest = json.loads((directory / "knowledge-manifest.json").read_text(encoding="utf-8"))
    # 固定知识输入边界：即使清单意外加入答案，也不将其送入生成器。
    if manifest.get("synthetic") is not True or set(manifest["knowledge_files"]) != set(SOURCE_IDS):
        raise ValueError("知识输入必须为 schema.sql、etl.sql、business-guide.md")
    return {name: (directory / name).read_text(encoding="utf-8") for name in SOURCE_IDS}


def sections(text: str, depth: int) -> dict[str, tuple[str, str]]:
    pattern = rf"(?m)^{'#' * depth} (.*?)\n(.*?)(?=^#{{1,{depth}}} |\Z)"
    return {title: (match.group(0).rstrip(), body.strip())
            for match in re.finditer(pattern, text, re.S)
            for title, body in [match.groups()]}


def source_entry(path: str, label: str, value: str, source_id: str, location: str,
                 quote: str | None = None) -> dict[str, Any]:
    quote = value if quote is None else quote
    return {
        "entry_id": path.replace(".", "-"), "path": path, "label": label,
        "source_facts": {
            "value": value, "quote": quote, "source_id": source_id, "version": "1",
            "location": location, "complete": True,
            "classification": "authored_definition" if source_id == "business-guide" else "source_text",
        },
        "suggestion": {}, "human_override": None, "effective_value": value,
        "review_state": "unverified",
    }


def missing_entry(path: str, label: str, source_id: str, gap: str) -> dict[str, Any]:
    return {
        "entry_id": path.replace(".", "-"), "path": path, "label": label,
        "source_facts": {"source_id": source_id, "version": "1", "location": path,
                         "complete": False, "gap": gap},
        "suggestion": {}, "human_override": None, "effective_value": "",
        "review_state": "unverified",
    }


def knowledge_object(ident: str, kind: str, name: str, entries: list[dict[str, Any]],
                     source_id: str, related: list[str] | None = None) -> dict[str, Any]:
    return {
        "id": ident, "kind": kind, "name": name, "version": "1", "state": "enabled",
        "entries": entries, "related_ids": related or [], "source_id": source_id,
        "source_version": "1", "updated_by": "synthetic-import",
    }


def build_catalog(directory: Path = SOURCE_DIRECTORY) -> dict[str, Any]:
    sources = read_knowledge_sources(directory)
    schema, etl, guide = (sources[name] for name in SOURCE_IDS)
    guide_sections = sections(guide, 2)
    guide_subsections = sections(guide, 3)
    table_definitions = {name: ddl for ddl, name in re.findall(
        r"(CREATE TABLE (\w+)\s*\(.*?\n\);)", schema, re.S)}
    if not table_definitions:
        raise ValueError("DDL 中没有合成表")
    etl_targets = set(re.findall(r"(?i)\bINSERT\s+INTO\s+(\w+)", etl))
    if not etl_targets <= table_definitions.keys():
        raise ValueError("加工 SQL 包含没有 DDL 的目标表")

    descriptions = {
        match.group(1): (title, body)
        for title, (_, body) in guide_subsections.items()
        if (match := re.search(r"`(\w+)`", title))
    }
    # 主表粒度的整节正文与上游表章节是规范说明；此处只建立对象定位。
    primary_section = next((item for title, item in guide_sections.items()
                            if title.startswith("2. ")), None)
    if primary_section is None:
        raise ValueError("业务说明缺少行粒度章节")
    main_table_match = re.search(r"`(\w+)`", primary_section[1])
    if main_table_match is None:
        raise ValueError("行粒度章节没有表名")
    main_table = main_table_match.group(1)
    descriptions[main_table] = ("第2节", primary_section[1])
    if set(descriptions) != table_definitions.keys():
        raise ValueError("表说明与 DDL 表集合不一致")

    objects: list[dict[str, Any]] = []
    for name, ddl in table_definitions.items():
        location, description = descriptions[name]
        entries = [source_entry("description", "表含义", description, "business-guide", location),
                   source_entry("ddl", "表结构", ddl, "schema", f"CREATE TABLE {name}")]
        if name in etl_targets:
            entries.append(source_entry("etl", "加工SQL", etl, "etl", "全文"))
        else:
            entries.append(missing_entry("etl", "加工SQL", "schema",
                                         "当前知识来源未提供该表加工SQL，不能由来源表身份推断它没有加工逻辑"))
        objects.append(knowledge_object("table-" + name, "table", name, entries, "schema"))

    connection = sqlite3.connect(":memory:")
    try:
        connection.executescript(schema)
        columns = {row[1]: row for row in connection.execute(f'PRAGMA table_info("{main_table}")')}
    finally:
        connection.close()
    field_rows = list(re.finditer(r"(?m)^\| `(\w+)` \| ([^|]+) \| ([^|]+) \|$", guide))
    if {match.group(1) for match in field_rows} != columns.keys():
        raise ValueError("字段说明与主表实际字段集合不一致")
    for match in field_rows:
        field, declared_type, meaning = (part.strip() for part in match.groups())
        row = columns[field]
        datatype = row[2] + ("，可空" if not row[3] else "")
        if datatype != declared_type:
            raise ValueError(f"字段 {field} 的文档类型与实际 DDL 不一致")
        declaration = next(line.strip().rstrip(",") for line in table_definitions[main_table].splitlines()
                           if line.strip().startswith(field + " "))
        type_entry = source_entry("type", "字段类型", declaration, "schema",
                                  f"CREATE TABLE {main_table} / {field}")
        type_entry["suggestion"] = {
            "value": datatype, "method": "ddl_type_derivation", "uncertainty": [],
            "evidence": [{"source_id": "schema", "version": "1",
                          "location": type_entry["source_facts"]["location"], "quote": declaration}],
            "basis": "SQLite table_info 的字段类型与 NOT NULL 约束；未从样本值推断类型或唯一性",
        }
        type_entry["effective_value"] = datatype
        objects.append(knowledge_object("field-" + field, "field", field,
                       [source_entry("meaning", "字段含义", meaning, "business-guide", "第4节 / " + field,
                                     match.group(0)), type_entry], "business-guide", ["table-" + main_table]))

    for title, (body_with_heading, body) in guide_subsections.items():
        if not title.startswith("5."):
            continue
        ident_match = re.search(r"(?m)^- 指标标识：`(\w+)`$", body)
        aliases_match = re.search(r"(?m)^- 别名：(.*)$", body)
        sql_match = re.search(r"(?m)^```sql\n(.*?)\n```$", body, re.S)
        if not (ident_match and aliases_match and sql_match):
            raise ValueError(f"指标章节 {title} 缺少标识、别名或 SQL")
        ident = ident_match.group(1)
        name = title.split(" ", 1)[1]
        entries = [source_entry("definition", "指标口径", body_with_heading, "business-guide", title),
                   source_entry("aliases", "别名", aliases_match.group(1).strip(), "business-guide", title,
                                aliases_match.group(0)),
                   source_entry("sql", "计算SQL", sql_match.group(1), "business-guide", title)]
        objects.append(knowledge_object("metric-" + ident, "metric", name, entries, "business-guide",
                       ["table-" + main_table, "field-paid_at", "field-is_test"]))

    for index, (title, (_, body)) in enumerate(guide_sections.items(), 1):
        objects.append(knowledge_object("document-guide-" + str(index), "document", title,
                       [source_entry("body", "章节正文", body, "business-guide", title)], "business-guide",
                       ["table-" + main_table]))

    for ident, name, table_names in (
        ("tags", "客户标签关联", [main_table, "customer_tags"]),
        ("payments", "订单行与支付事件", ["raw_order_lines", "raw_payments"]),
    ):
        table = table_names[1]
        location, body = descriptions[table]
        objects.append(knowledge_object("relationship-" + ident, "relationship", name,
                       [source_entry("join", "关联说明", body, "business-guide", location)],
                       "business-guide", ["table-" + name for name in table_names]))

    # 结构约定由业务说明显式给出，生成器只检查目标与列，不由样本猜口径。
    structure_blocks = re.findall(r"(?m)^```semantic-structure\n(.*?)\n```$", guide, re.S)
    by_id = {obj["id"]: obj for obj in objects}
    connection = sqlite3.connect(":memory:")
    try:
        connection.executescript(schema)
        all_columns = {"table-" + name: {row[1] for row in connection.execute(
            f'PRAGMA table_info("{name}")')} for name in table_definitions}
    finally:
        connection.close()
    seen_structures = set()
    for block in structure_blocks:
        definition_quotes = {json.loads(match.group(0))["object_id"]: match.group(0)
                             for match in re.finditer(r'(?m)^  \{\n    "object_id":.*?^  \}', block, re.S)}
        for definition in json.loads(block):
            ident, entry_id, structure = (definition[key] for key in ("object_id", "entry_id", "structure"))
            obj = by_id.get(ident)
            entry = next((entry for entry in obj["entries"] if entry["entry_id"] == entry_id), None) if obj else None
            if entry is None or obj["kind"] != structure["kind"] or (ident, entry_id) in seen_structures:
                raise ValueError("结构约定的目标、类型或条目不合法")
            seen_structures.add((ident, entry_id))
            refs = [structure[key] for key in ("table", "left_table", "right_table") if key in structure]
            if any(ref["object_id"] not in all_columns or ref["version"] != "1" for ref in refs):
                raise ValueError("结构约定引用不存在的表或版本")
            def check_columns(table_id: str, names: list[str]) -> None:
                if not set(names) <= all_columns[table_id]:
                    raise ValueError("结构约定引用不存在的列")
            if structure["kind"] == "table":
                check_columns(ident, [column for key in structure["unique_keys"] for column in key]
                              + [item["column"] for item in structure["time_columns"]])
            elif structure["kind"] == "field":
                check_columns(structure["table"]["object_id"], [structure["column"]])
            elif structure["kind"] == "relationship":
                for side in ("left", "right"):
                    check_columns(structure[side + "_table"]["object_id"],
                                  [key[side + "_column"] for key in structure["join_keys"]])
            elif structure["kind"] == "metric":
                check_columns(structure["table"]["object_id"], structure["dimensions"]
                              + ([structure["time_column"]] if structure["time_column"] else []))
            entry["source_facts"]["structured_value"] = structure
            entry["source_facts"]["structured_evidence"] = [{
                "source_id": "business-guide", "version": "1", "location": "可计算语义定义 / " + ident,
                "quote": definition_quotes.get(ident, block),
            }]
            entry["effective_structure"] = structure

    domain = re.search(r"(?m)^业务域标识：`([^`]+)`。.*$", guide)
    if domain:
        for obj in objects:
            obj["entries"].append(source_entry("business_domain", "业务范围", domain.group(1),
                                              "business-guide", "第8节 / 业务域", domain.group(0)))

    source_bodies = {SOURCE_IDS[name]: body for name, body in sources.items()}
    object_ids = [obj["id"] for obj in objects]
    if len(set(object_ids)) != len(object_ids):
        raise ValueError("语义对象标识重复")
    for obj in objects:
        if not set(obj["related_ids"]) <= set(object_ids):
            raise ValueError(f"对象 {obj['id']} 包含不存在的关联")
        for entry in obj["entries"]:
            facts = entry["source_facts"]
            if facts.get("complete") and facts["quote"] not in source_bodies[facts["source_id"]]:
                raise ValueError(f"对象 {obj['id']} 的来源引用不是原文")

    return {
        "synthetic": True,
        "source_files_sha256": {name: hashlib.sha256(body.encode("utf-8")).hexdigest()
                                for name, body in sources.items()},
        "objects": objects,
    }


def render_catalog(catalog: dict[str, Any]) -> str:
    return json.dumps(catalog, ensure_ascii=False, indent=2) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="只读比较当前目录与生成结果")
    parser.add_argument("--source-directory", type=Path, default=SOURCE_DIRECTORY,
                        help="隔离合成资料目录，须包含知识允许列表")
    args = parser.parse_args()
    try:
        catalog = build_catalog(args.source_directory)
        generated = render_catalog(catalog)
        target = args.source_directory / CATALOG_FILE
        if args.check:
            if not target.exists() or target.read_text(encoding="utf-8") != generated:
                print("语义目录与当前知识来源不一致，请重新运行目录生成器", file=sys.stderr)
                return 1
            print(f"语义目录检查通过：{len(catalog['objects'])} 个对象，生成过程未读取验收资料")
        else:
            target.write_text(generated, encoding="utf-8")
            print(f"已生成 {len(catalog['objects'])} 个合成语义对象")
    except (ValueError, KeyError, OSError, sqlite3.Error) as error:
        print(f"语义目录生成失败：{error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
