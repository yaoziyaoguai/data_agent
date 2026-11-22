import {createSyntheticSourceInfo, formatSkillsForPrompt, type ContextWithSystemEvent, type Extension, type SessionManager} from '@earendil-works/pi-coding-agent';
import type {DataToolOutcome, WorkspaceContext} from '../../../packages/contracts/generated/boundary.ts';
import type {RustTransport} from '../transport/client.ts';
import {exportCheckpoint} from './checkpoint.ts';
import {selectedSkillResources} from './skills.ts';

export function taskProjection(transport: RustTransport, manager: SessionManager,
  replaceWorkspace: (workspace: WorkspaceContext) => void, refreshSession?: () => void) {
  let pending: string | undefined;
  let failure: unknown;
  const workspace = transport.run.workspace_context;
  let skills = formatSkillsForPrompt(selectedSkillResources(workspace?.selected_skills ?? []));
  const previous = workspace?.authority_snapshot?.active_task as Record<string, unknown> | undefined;
  const current = workspace?.active_task_ref;
  if (transport.run.resume_same_input && current &&
    (previous?.task_id !== current.task_id || previous?.condition_version !== current.condition_version)) {
    // 恢复时沿已成功的工具回执更新任务和来源，保留原调用身份。
    for (const message of manager.buildSessionContext().messages) {
      if (message.role !== 'toolResult') continue;
      const receipt = message.details as DataToolOutcome | undefined;
      if (receipt?.context_reset?.task_id === current.task_id &&
        receipt.context_reset.condition_version === current.condition_version) pending = message.toolCallId;
    }
  }
  const apply = async () => {
    if (!pending) return;
    const sdkId = pending;
    const originalLeaf = manager.getLeafId();
    const history = manager.getBranch();
    const result = history.findLast(entry => entry.type === 'message' && entry.message.role === 'toolResult'
      && entry.message.toolCallId === sdkId);
    if (result?.type !== 'message' || result.message.role !== 'toolResult') throw new Error('checkpoint_conflict');

    // 保留旧树和原控制回执。新来源下，普通请求与 Pi 摘要从同一个原生分支开始。
    manager.resetLeaf();
    manager.appendMessage({role: 'user', content: transport.run.text, timestamp: result.message.timestamp});
    manager.appendCustomMessageEntry('data_agent_current_input',
      '任务或来源范围已更新。沿当前用户消息和最新工作区继续，已完成的操作无需重做。',
      false, {message_id: transport.run.message_id, sdk_tool_call_id: sdkId});
    try {
      const next = await transport.post('/internal/context/refresh', 'RefreshRunContext', {
        ...transport.binding(), sdk_tool_call_id: sdkId, checkpoint: exportCheckpoint(manager),
      });
      transport.run.workspace_context = next;
      replaceWorkspace(next);
      skills = formatSkillsForPrompt(selectedSkillResources(next.selected_skills));
      pending = undefined;
      refreshSession?.();
    } catch (error) {
      if (originalLeaf) manager.branch(originalLeaf);
      throw error;
    }
  };
  const path = '<inline:data_agent_task_projection>';
  const extension: Extension = {
    path, resolvedPath:path, sourceInfo:createSyntheticSourceInfo(path,{source:'inline',scope:'temporary'}),
    handlers:new Map<string, ((event: unknown) => Promise<unknown>)[]>([
      ['turn_end', [async () => {
        try { await apply(); }
        catch (error) { failure = error; throw error; }
      }]],
      ['context_with_system', [async event => ({messages:(event as ContextWithSystemEvent).messages.map(message =>
        message.role === 'system' && message.sections
          ? {...message, sections: {...message.sections, skills}}
          : message)})]],
    ]),
    tools:new Map(), messageRenderers:new Map(), commands:new Map(), flags:new Map(), shortcuts:new Map(),
  };
  return {
    extension, apply,
    acceptReceipt(receipt: DataToolOutcome, sdkId: string) {
      if (!receipt.data.error && receipt.context_reset) pending = sdkId;
    },
    check() { if (failure) throw failure; },
  };
}
