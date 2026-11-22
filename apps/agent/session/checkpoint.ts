import { SessionManager, VERSION } from '@earendil-works/pi-coding-agent';
import type { Checkpoint } from '../../../packages/contracts/generated/boundary.ts';
import { validateContract } from '../../../packages/contracts/validate.ts';
import { createStoredSession, importStoredSession, openStoredSession, storedReference } from './journal.ts';

export const RECOVERY_NOTICE = '[宿主恢复原输入]';

export function isRecoveryNotice(message: { role: string; content?: unknown }): boolean {
  if (message.role !== 'user') return false;
  if (typeof message.content === 'string') return message.content.startsWith(RECOVERY_NOTICE);
  return Array.isArray(message.content) && message.content.some(part => part?.type === 'text' && typeof part.text === 'string' && part.text.startsWith(RECOVERY_NOTICE));
}

export function exportCheckpoint(manager: SessionManager, authority?:string|null, authoritySnapshot?:Record<string,unknown>|null, verifyPersisted=false): Checkpoint {
  if (VERSION !== '1.4.0') throw new Error('checkpoint_sdk_version_unsupported');
  const header = manager.getHeader();
  if (!header) throw new Error('missing session header');
  const storage=storedReference(manager,verifyPersisted);
  const leaf = manager.getLeafId();
  const calls = new Set<string>();
  // 只沿当前输入的父链读取工具 ID，避免复制整份历史或把已离开的分支算进来。
  for (let id = leaf; id !== null;) {
    const entry = manager.getEntry(id);
    if (!entry) throw new Error('checkpoint_leaf_unavailable');
    if (entry.type === 'message') {
      const message = entry.message;
      if (message.role === 'user' && !isRecoveryNotice(message)) break;
      if (message.role === 'assistant') {
        for (const part of message.content)
          if (part.type === 'toolCall') calls.add(part.id);
      }
    } else if (entry.type === 'custom_message' && entry.customType === 'data_agent_current_input') {
      const call = (entry.details as {sdk_tool_call_id?: string})?.sdk_tool_call_id;
      if (typeof call === 'string') calls.add(call);
      break;
    }
    id = entry.parentId;
  }
  return {
    ...(authority ? {authority_revision: authority} : {}),
    ...(authoritySnapshot ? {authority_snapshot: authoritySnapshot} : {}),
    ...(storage ? {storage} : {}),
    sdk_version: VERSION, leaf_id: leaf, branch_tool_call_ids: [...calls],
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
