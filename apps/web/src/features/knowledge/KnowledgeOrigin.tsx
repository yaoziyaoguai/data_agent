import type { KnowledgeObject } from '../../../../../packages/contracts/generated/boundary.ts';
import { knowledgeSourceLabel } from '../../shared/knowledge-labels.ts';

export function KnowledgeOrigin({object, detail = false}: {object: KnowledgeObject; detail?: boolean}) {
  return <span className={'knowledge-origin' + (detail ? ' detail' : '')}>
    <span>{knowledgeSourceLabel(object)}</span>
  </span>;
}
