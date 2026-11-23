import { SessionManager, VERSION, type SessionEntry } from '@earendil-works/pi-coding-agent';
import type { AnswerPartReference, Checkpoint, DataToolOutcome } from '../../../packages/contracts/generated/boundary.ts';
import { validateContract } from '../../../packages/contracts/validate.ts';
import { createStoredSession, importStoredSession, openStoredSession, storedReference } from './journal.ts';

export const RECOVERY_NOTICE = '[宿主恢复原输入]';

export function isRecoveryNotice(message: { role: string; content?: unknown }): boolean {
  if (message.role !== 'user') return false;
  if (typeof message.content === 'string') return message.content.startsWith(RECOVERY_NOTICE);
  return Array.isArray(message.content) && message.content.some(part => part?.type === 'text' && typeof part.text === 'string' && part.text.startsWith(RECOVERY_NOTICE));
}

type CurrentInputMarker = {
  message_id: string;
  sdk_tool_call_id?: string;
  adopted_tool_call_ids?: string[];
};

export function currentInputToolCalls(manager: SessionManager, leaf: string | null, completedOnly = false) {
  const calls = new Set<string>();
  const adopted = new Set<string>();
  let legacy = false;
  // 只沿当前输入的父链读取工具 ID，避免复制整份历史或把已离开的分支算进来。
  for (let id = leaf; id !== null;) {
    const entry = manager.getEntry(id);
    if (!entry) throw new Error('checkpoint_leaf_unavailable');
    if (entry.type === 'message') {
      const message = entry.message;
      if (message.role === 'user' && !isRecoveryNotice(message)) break;
      if (!completedOnly && message.role === 'assistant') {
        for (const part of message.content)
          if (part.type === 'toolCall') calls.add(part.id);
      } else if (completedOnly && message.role === 'toolResult' && !message.isError) {
        calls.add(message.toolCallId);
      }
    } else if (entry.type === 'custom' && entry.customType === 'data_agent_adopted_steps') {
      for (const call of entry.data as string[]) adopted.add(call);
    } else if (entry.type === 'custom_message' && entry.customType === 'data_agent_current_input') {
      const marker = entry.details as CurrentInputMarker | undefined;
      if (marker?.sdk_tool_call_id !== undefined) calls.add(marker.sdk_tool_call_id);
      else legacy = true;
      for (const call of marker?.adopted_tool_call_ids ?? []) adopted.add(call);
      break;
    }
    id = entry.parentId;
  }
  for (const id of adopted) calls.add(id);
  return {ids: [...calls], adopted: [...adopted], legacy};
}

export function restoreAdoptedSteps(manager: SessionManager, branch: SessionEntry[], messageId: string,
  frozen: AnswerPartReference[]) {
  const markerIndex = branch.findLastIndex(entry => entry.type === 'custom_message' &&
    entry.customType === 'data_agent_current_input' && (entry.details as CurrentInputMarker | undefined)?.message_id === messageId);
  const marker = branch[markerIndex];
  if (marker?.type !== 'custom_message') return;
  const details = marker.details as CurrentInputMarker;
  if (!details.sdk_tool_call_id || details.adopted_tool_call_ids !== undefined ||
    branch.slice(markerIndex + 1).some(entry => entry.type === 'custom' && entry.customType === 'data_agent_adopted_steps')) return;

  // 旧标记缺步骤。用Rust已定稿的引用在已加载的Pi树上找原回执，只采纳对应父链。
  const finals = new Map(frozen.map(part => [part.finalized_by_sdk_tool_call_id, part]));
  const entries = manager.getEntries();
  const adopted = new Set<string>();
  for (let i = entries.findIndex(entry => entry.id === marker.id) - 1; i >= 0 && finals.size; i--) {
    const entry = entries[i]!;
    if (entry.type !== 'message' || entry.message.role !== 'toolResult' || entry.message.isError) continue;
    const {toolCallId} = entry.message;
    const part = finals.get(toolCallId);
    const receipt = entry.message.details as DataToolOutcome | undefined;
    if (!part || !receipt?.answer_parts?.some(ref => ref.finalized_by_sdk_tool_call_id === toolCallId &&
      ref.task_ref.task_id === part.task_ref.task_id && ref.task_ref.condition_version === part.task_ref.condition_version &&
      ref.scope_fingerprint === part.scope_fingerprint)) continue;
    for (const call of currentInputToolCalls(manager, entry.id, true).ids) adopted.add(call);
    finals.delete(toolCallId);
  }
  manager.appendCustomEntry('data_agent_adopted_steps', [...adopted]);
}

export function exportCheckpoint(manager: SessionManager, authority?:string|null, authoritySnapshot?:Record<string,unknown>|null, verifyPersisted=false): Checkpoint {
  if (VERSION !== '1.4.0') throw new Error('checkpoint_sdk_version_unsupported');
  const header = manager.getHeader();
  if (!header) throw new Error('missing session header');
  const storage=storedReference(manager,verifyPersisted);
  const leaf = manager.getLeafId();
  const {ids, legacy} = currentInputToolCalls(manager, leaf);
  return {
    ...(authority ? {authority_revision: authority} : {}),
    ...(authoritySnapshot ? {authority_snapshot: authoritySnapshot} : {}),
    ...(storage ? {storage} : {}),
    sdk_version: VERSION, leaf_id: leaf, ...(!legacy ? {branch_tool_call_ids: ids} : {}),
    entries: storage ? [] : JSON.parse(JSON.stringify([header, ...manager.getEntries()])),
  };
}
export function restoreCheckpoint(cwd: string, checkpoint: Checkpoint | null): SessionManager {
  if (!checkpoint) return createStoredSession(cwd);
  validateContract('Checkpoint', checkpoint);
  if(checkpoint.storage){
    if(checkpoint.storage.kind!=='pi_session'||typeof checkpoint.storage.file!=='string'||typeof checkpoint.storage.session_id!=='string')throw new Error('checkpoint_storage_invalid');
    return openStoredSession(cwd,checkpoint.storage.file,checkpoint.storage.session_id,checkpoint.leaf_id);
  }
  return importStoredSession(cwd,checkpoint.entries,checkpoint.leaf_id);
}
