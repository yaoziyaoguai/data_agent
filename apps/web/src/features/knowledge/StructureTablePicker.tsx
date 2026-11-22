import { useState, useEffect, useRef } from "react";
import type { KnowledgeObject } from "../../../../../packages/contracts/generated/boundary.ts";
import { api } from "../../shared/api.ts";
import { knowledgeSourceLabel } from "../../shared/knowledge-labels.ts";
import { reference, type TableReference } from "./semantic-structure-draft.ts";

export function TablePicker({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: TableReference | null;
  disabled: boolean;
  onChange: (value: TableReference | null) => void;
}) {
  const [selected, setSelected] = useState<KnowledgeObject | null>(null);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<KnowledgeObject[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextAfter, setNextAfter] = useState<string | null>(null);
  const searchGeneration = useRef(0);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    setSelected(null);
    setError("");
    if (value)
      void api(
        "KnowledgeObject",
        "/knowledge/" + encodeURIComponent(value.object_id),
      )
        .then((object) => {
          if (live) setSelected(object);
        })
        .catch(() => {
          if (live) setError("暂时无法读取已选表，请重新选择。");
        });
    return () => {
      live = false;
    };
  }, [value?.object_id]);
  useEffect(() => {
    const generation = ++searchGeneration.current;
    let live = true;
    setItems([]);
    setNextAfter(null);
    setLoadingMore(false);
    setLoading(Boolean(query.trim()));
    if (!query.trim()) return;
    const timer = setTimeout(() => {
      void api(
        "KnowledgeList",
        "/knowledge?directory=all&directory_view=grouped&state=enabled&q=" +
          encodeURIComponent(query.trim()),
      )
        .then((result) => {
          if (live && generation === searchGeneration.current) {
            setItems(
              result.objects.filter((object) => object.kind === "table"),
            );
            setNextAfter(result.next_after_id);
          }
        })
        .catch(() => {
          if (live) setError("查找表失败，请重试。");
        })
        .finally(() => {
          if (live) setLoading(false);
        });
    }, 150);
    return () => {
      live = false;
      clearTimeout(timer);
      ++searchGeneration.current;
    };
  }, [query]);
  const loadMore = async () => {
    if (!nextAfter || loadingMore || disabled) return;
    const generation = searchGeneration.current;
    setLoadingMore(true);
    setError("");
    try {
      const result = await api(
        "KnowledgeList",
        "/knowledge?directory=all&directory_view=grouped&state=enabled&q=" +
          encodeURIComponent(query.trim()) +
          "&after_id=" +
          encodeURIComponent(nextAfter),
      );
      if (generation !== searchGeneration.current) return;
      setItems((old) => {
        const current = new Map(old.map((object) => [object.id, object]));
        for (const object of result.objects.filter(
          (object) => object.kind === "table",
        ))
          current.set(object.id, object);
        return [...current.values()];
      });
      setNextAfter(result.next_after_id);
    } catch {
      if (generation === searchGeneration.current)
        setError("后续结果暂时无法读取，请继续查找重试。");
    } finally {
      if (generation === searchGeneration.current) setLoadingMore(false);
    }
  };
  return (
    <div className="semantic-table-picker">
      <label className="form-label">
        {label}
        <input
          value={query}
          disabled={disabled}
          placeholder={selected ? selected.name : "输入表名查找"}
          onChange={(event) => {
            setError("");
            setQuery(event.target.value);
          }}
        />
      </label>
      {value && (
        <p className="quiet">
          已选择：
          {selected
            ? `${selected.name} · ${knowledgeSourceLabel(selected)}`
            : "正在读取表名…"}{" "}
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange(null)}
          >
            重新选择
          </button>
        </p>
      )}
      {value && selected && selected.version !== value.version && (
        <p className="quiet">
          这张表的定义已变化。
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange(reference(selected))}
          >
            采用当前表定义
          </button>
        </p>
      )}
      {loading && <p role="status">正在查找表…</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!loading && query.trim() && !items.length && !error && (
        <p className="quiet">
          {nextAfter
            ? "当前已读取的结果中没有匹配的表，可继续查找。"
            : "没有匹配的表，请换个名称。"}
        </p>
      )}
      {items.map((object) => (
        <button
          type="button"
          key={object.id}
          aria-label={`${object.name} · ${knowledgeSourceLabel(object)}`}
          disabled={disabled}
          onClick={() => {
            setSelected(object);
            onChange(reference(object));
            setQuery("");
          }}
        >
          {object.name}
          <small>{knowledgeSourceLabel(object)}</small>
        </button>
      ))}
      {nextAfter && (
        <button
          type="button"
          disabled={disabled || loadingMore}
          onClick={() => void loadMore()}
        >
          {loadingMore ? "正在继续查找…" : "继续查找表"}
        </button>
      )}
    </div>
  );
}

export function useColumnSuggestions(value: TableReference | null) {
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    setNames([]);
    if (!value) return;
    // 这里只提供当前可读字段的输入建议；完整列校验仍在服务端执行。
    void api(
      "KnowledgeList",
      "/knowledge?related_id=" + encodeURIComponent(value.object_id),
    )
      .then((result) => {
        if (live)
          setNames([
            ...new Set(
              result.objects
                .filter((object) => object.kind === "field")
                .map((object) => object.name.split(".").at(-1) ?? object.name),
            ),
          ]);
      })
      .catch(() => {
        if (live) setNames([]);
      });
    return () => {
      live = false;
    };
  }, [value?.object_id, value?.version]);
  return names;
}
