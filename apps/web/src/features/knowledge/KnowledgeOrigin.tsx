import type { KnowledgeObject } from '../../../../../packages/contracts/generated/boundary.ts';

// 完整身份直接显示，避免同名对象或短标识碰撞；来源字段不参与授权。
export function KnowledgeOrigin({object, detail = false}: {object: KnowledgeObject; detail?: boolean}) {
  return <span className={'knowledge-origin' + (detail ? ' detail' : '')}>
    <span>来源：{object.source_id || '未标注'}</span>
    <span>对象：{object.id}</span>
  </span>;
}
