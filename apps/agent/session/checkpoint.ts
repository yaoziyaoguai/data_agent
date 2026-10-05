import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { Checkpoint } from '../../../packages/contracts/generated/boundary.ts';
import { validateContract } from '../../../packages/contracts/validate.ts';
import { createStoredSession, importStoredSession, openStoredSession, storedReference } from './journal.ts';

export const RECOVERY_NOTICE = '[宿主恢复原输入]';

export function isRecoveryNotice(message: { role: string; content?: unknown }): boolean {
  if (message.role !== 'user') return false;
  if (typeof message.content === 'string') return message.content.startsWith(RECOVERY_NOTICE);
  return Array.isArray(message.content) && message.content.some(part => part?.type === 'text' && typeof part.text === 'string' && part.text.startsWith(RECOVERY_NOTICE));
}

export function exportCheckpoint(manager: SessionManager, authority?:string|null, authoritySnapshot?:Record<string,unknown>|null): Checkpoint {
  const header = manager.getHeader();
  if (!header) throw new Error('missing session header');
  const storage=storedReference(manager);
  return { ...(authority?{authority_revision:authority}:{}), ...(authoritySnapshot?{authority_snapshot:authoritySnapshot}:{}), ...(storage?{storage}:{}), sdk_version: '1.0.0', entries: storage?[]:JSON.parse(JSON.stringify([header, ...manager.getEntries()])), leaf_id: manager.getLeafId() };
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
