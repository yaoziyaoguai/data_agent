import type { MessageInput, ModelSelection } from "../../../../../packages/contracts/generated/boundary.ts";
import { decodeContract } from "../../../../../packages/contracts/validate.ts";

export const conversationStorageKey = (space: string, user: string) =>
  "data-agent.conversation." + JSON.stringify([space, user]);
export const draftStorageKey = (space: string, user: string, conversation: string | null) =>
  "data-agent.draft." + JSON.stringify([space, user, conversation ?? "new"]);
export const pendingSubmissionKey = (space: string, user: string) =>
  "data-agent.pending-message." + JSON.stringify([space, user]);
export const modelDraftStorageKey = (space: string, user: string, conversation: string | null) =>
  "data-agent.model-draft." + JSON.stringify([space, user, conversation ?? "new"]);

export function readModelDraft(space: string, user: string, conversation: string | null): ModelSelection | null {
  const stored = localStorage.getItem(modelDraftStorageKey(space, user, conversation));
  if (!stored) return null;
  try { return decodeContract<ModelSelection>("ModelSelection", JSON.parse(stored)); }
  catch { return null; }
}

export function adoptNewConversationDraft(space: string, user: string, conversation: string) {
  // 选用方法也会创建会话；这里只转移未发送的界面草稿，不改变消息提交身份。
  for (const keyFor of [draftStorageKey, modelDraftStorageKey]) {
    const origin = keyFor(space, user, null), destination = keyFor(space, user, conversation);
    const value = localStorage.getItem(origin);
    if (value === null || localStorage.getItem(destination) !== null) continue;
    localStorage.setItem(destination, value);
    const revision = localStorage.getItem(origin + ".revision");
    if (revision !== null) localStorage.setItem(destination + ".revision", revision);
    localStorage.removeItem(origin);
    localStorage.removeItem(origin + ".revision");
  }
}

export interface PendingSubmission {
  schema_version: 1;
  space: string;
  user: string;
  origin_conversation_id: string | null;
  conversation_id: string | null;
  creation_operation_id: string;
  input: MessageInput;
  draft_text: string;
  draft_revision: string;
}

export function readPendingSubmission(space: string, user: string): PendingSubmission | null {
  const stored = localStorage.getItem(pendingSubmissionKey(space, user));
  if (!stored) return null;
  const value = JSON.parse(stored) as PendingSubmission;
  if (value.schema_version !== 1 || value.space !== space || value.user !== user ||
      typeof value.creation_operation_id !== "string" || typeof value.draft_text !== "string" ||
      typeof value.draft_revision !== "string" ||
      !(value.origin_conversation_id === null || typeof value.origin_conversation_id === "string") ||
      !(value.conversation_id === null || typeof value.conversation_id === "string")) {
    throw new Error("待确认消息的本地记录无法读取，请保留当前草稿后重新打开页面。");
  }
  decodeContract<MessageInput>("MessageInput", value.input);
  return value;
}

export function storePendingSubmission(value: PendingSubmission) {
  localStorage.setItem(pendingSubmissionKey(value.space, value.user), JSON.stringify(value));
}

export function clearPendingSubmission(value: PendingSubmission) {
  const pending = readPendingSubmission(value.space, value.user);
  if (pending?.input.client_message_id === value.input.client_message_id) {
    localStorage.removeItem(pendingSubmissionKey(value.space, value.user));
  }
}

export function writeDraft(space: string, user: string, conversation: string | null, text: string) {
  const key = draftStorageKey(space, user, conversation);
  localStorage.setItem(key, text);
  localStorage.setItem(key + ".revision", crypto.randomUUID());
}

export function settleSubmission(value: PendingSubmission, conversation: string) {
  const origin = draftStorageKey(value.space, value.user, value.origin_conversation_id);
  const destination = draftStorageKey(value.space, value.user, conversation);
  const revision = localStorage.getItem(origin + ".revision") ?? "";
  const draft = localStorage.getItem(origin) ?? "";
  // 只清理提交时的那份草稿；回执丢失、刷新或继续输入都不能覆盖后写的内容。
  const next = revision === value.draft_revision && draft === value.draft_text ? "" : draft;
  if (origin === destination || localStorage.getItem(destination) === null) {
    localStorage.setItem(destination, next);
    localStorage.setItem(destination + ".revision", revision);
    if (origin !== destination) {
      localStorage.removeItem(origin);
      localStorage.removeItem(origin + ".revision");
    }
  }
  if (!value.origin_conversation_id) {
    const key = modelDraftStorageKey(value.space, value.user, null);
    const draftModel = readModelDraft(value.space, value.user, null);
    if (draftModel?.model_id === value.input.model_selection?.model_id &&
        draftModel?.thinking_level === value.input.model_selection?.thinking_level) {
      localStorage.removeItem(key);
    }
  }
  clearPendingSubmission(value);
  return localStorage.getItem(destination) ?? "";
}
