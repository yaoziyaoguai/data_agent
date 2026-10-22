import type { Root } from "mdast";

export type ObjectReferenceLabels = Readonly<Record<string, string>>;

type MarkdownNode = { type: string; value?: string; children?: MarkdownNode[] };

function displayReference(value: string, labels: ObjectReferenceLabels): string | undefined {
  if (Object.hasOwn(labels, value)) return labels[value];
  const shortened = /^(.*?)(?:…|\.{3})$/.exec(value)?.[1];
  // 只接回明确省略且能唯一定位的宿主引用；普通业务编号不按前缀猜测。
  if (!shortened || shortened.length < 8) return;
  const matches = Object.keys(labels).filter(id => id.startsWith(shortened));
  return matches.length === 1 ? labels[matches[0]] : undefined;
}

// 仅替换Markdown正文中的已知对象引用；SQL代码、链接地址及未知业务ID保持原文。
export function remarkObjectReferences(labels: ObjectReferenceLabels) {
  return function objectReferencePlugin() {
    return function transform(tree: Root) {
      const visit = (node: MarkdownNode) => {
        if (node.type === "code" || node.type === "html") return;
        if (node.type === "text" && node.value) {
          node.value = node.value.replace(/[A-Za-z0-9_-]+(?:…|\.{3})?/g,
            value => displayReference(value, labels) ?? value);
        }
        if (!node.children) return;
        node.children = node.children.map(child => {
          if (child.type === "inlineCode") {
            const label = displayReference(child.value ?? "", labels);
            return label ? { type: "text", value: label } : child;
          }
          visit(child);
          return child;
        });
      };
      visit(tree);
    };
  };
}
