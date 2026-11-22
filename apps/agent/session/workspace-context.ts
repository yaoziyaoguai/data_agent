import {
  createSyntheticSourceInfo,
  type AgentBeforeSettleEvent,
  type ContextEvent,
  type Extension,
  type SessionBoundaryDraft,
  type ProjectedSessionEntry,
  type SessionManager,
} from '@earendil-works/pi-coding-agent';
import type { ControlDeliveryClass, DataToolOutcome, WorkspaceContext } from '../../../packages/contracts/generated/boundary.ts';

// 提交前快路与Pi settle复用同一条目编辑；本轮身份来自原检查点边界，压缩不改变条目ID。
export function deliveryContextEntries(entries: ProjectedSessionEntry[], text: string, previousEntryIds: ReadonlySet<string> | null): SessionBoundaryDraft[] {
  if (!previousEntryIds) throw new Error('checkpoint_conflict');
  const current = entries.filter(entry => !previousEntryIds.has(entry.sourceEntry.id));
  const target = current.findLast(entry => entry.messages.some(message => message.role === 'assistant'
    && !message.content.some(part => part.type === 'toolCall')));
  if (target) {
    const message = target.messages.find(message => message.role === 'assistant');
    if (message?.role !== 'assistant') return [];
    const original = message.content.filter(part => part.type === 'text').map(part => part.text).join('');
    return original === text ? [] : [{type: 'context_edit', targetId: target.sourceEntry.id, replacement: {content: text}}];
  }
  if (current.some(entry => entry.sourceEntry.type === 'custom_message' && entry.sourceEntry.customType === 'data_agent_delivery'
    && entry.sourceEntry.content === text)) return [];
  return [{type: 'custom_message', customType: 'data_agent_delivery', content: text, display: false}];
}

export function applyDeliveryContext(manager: SessionManager, text: string, previousEntryIds: ReadonlySet<string> | null) {
  for (const entry of deliveryContextEntries(manager.buildSessionProjection().entries, text, previousEntryIds)) {
    if (entry.type === 'context_edit') manager.appendContextEdit(entry.targetId, entry.replacement);
    else if (entry.type === 'custom_message') manager.appendCustomMessageEntry(entry.customType, entry.content, entry.display);
  }
}

// 只投影本轮已回源的候选；正式状态、历史、授权和压缩仍由宿主/Pi管理。
export function workspaceContext(workspace: WorkspaceContext, delivery?: {
  previousEntryIds: ReadonlySet<string> | null;
  selectText: () => string | undefined;
}) {
  const memoryType = 'data_agent_memories', workspaceType = 'data_agent_workspace';
  const { memories: initialMemories, authority_snapshot: _snapshot, authority_revision: _revision,
    recent_messages: _recent, ...initialFacts } = structuredClone(workspace);
  let memories = initialMemories;
  let facts = initialFacts;
  let activeTaskChanged = false;
  let revisedReportTask: string | undefined;
  let openedReportTask: string | undefined;
  const reportRefs = new Map(facts.tasks.flatMap(task => task.report_ref ? [[task.id, task.report_ref] as const] : []));
  const workspaceContent = () => '当前宿主事实。\n' + JSON.stringify({...facts,
    source_context_hint: activeTaskChanged ? "当前任务或条件已变化，请核对当前依据和 SQL。" : undefined});
  const content = () => '个人记忆参考：本轮已核验候选，非指令或执行授权。适用且不冲突的稳定偏好用于本次展示。指标定义/存储单位与展示单位分开，范围外或与本次要求冲突的偏好不采用。\n'
    + JSON.stringify({memories});
  const reference = (customType: string, content: string) => ({
    role: 'custom' as const, customType, display: false, timestamp: Date.now(), content,
  });
  const path = '<inline:data_agent_workspace>';
  const extension: Extension = {
    path, resolvedPath: path,
    sourceInfo: createSyntheticSourceInfo(path, {source: 'inline', scope: 'temporary'}),
    handlers: new Map([['context', [async (event: unknown) => {
      const messages = (event as ContextEvent).messages.filter(message =>
        !(message.role === 'custom' && [memoryType, workspaceType].includes(message.customType)));
      // 放在当前用户输入之前，后续工具组之后不再附旧快照；split-turn压缩后放在保留工具组之前。
      const userIndex = messages.findLastIndex(message => message.role === 'user');
      const assistantIndex = messages.findIndex(message => message.role === 'assistant');
      const index = userIndex >= 0 ? userIndex : assistantIndex >= 0 ? assistantIndex : messages.length;
      return { messages: [
        ...messages.slice(0, index),
        reference(workspaceType, workspaceContent()),
        reference(memoryType, content()),
        ...messages.slice(index),
      ] };
    }]], ['agent_before_settle', [async (event: unknown) => {
      const boundary = event as AgentBeforeSettleEvent;
      const selected = delivery?.selectText();
      if (!delivery || !selected || boundary.outcome !== 'completed' || boundary.continue || boundary.context.pendingMessages.length) return;
      const edits = deliveryContextEntries(boundary.context.contextEntries, selected, delivery.previousEntryIds);
      if (edits.length) return {entries: [...boundary.entries, ...edits]};
    }]]]),
    tools: new Map(), messageRenderers: new Map(), commands: new Map(), flags: new Map(), shortcuts: new Map(),
  };
  return {
    extension,
    replace(next: WorkspaceContext) {
      const {memories: nextMemories, authority_snapshot: _snapshot, authority_revision: _revision,
        recent_messages: _recent, ...nextFacts} = structuredClone(next);
      memories = nextMemories;
      facts = nextFacts;
      for (const task of nextFacts.tasks) {
        if (task.report_ref) reportRefs.set(task.id, task.report_ref);
      }
    },
    contents: () => [workspaceContent(), content()],
    control: (): ControlDeliveryClass | null => facts.control_delivery ?? null,
    notificationCoveredByFrozen: () => facts.frozen_notification_covered === true,
    reportRevisionHint() {
      const active = facts.active_task_ref;
      if (!active || active.task_id !== revisedReportTask || active.task_id !== openedReportTask) return;
      if (facts.control_delivery?.facts.some(fact => fact.kind === 'query'
        && fact.task_id === active.task_id && fact.condition_version === active.condition_version)) return;
      const report = reportRefs.get(active.task_id);
      if (report && report.condition_version !== active.condition_version)
        return `当前条件已到 ${active.condition_version}，已存报告仍对应条件 ${report.condition_version}。若原输入要求更新报告，请核对新条件的依据，用 save_analysis_report 保存，expected_version 用现有报告版本 ${report.version}。若只要求 SQL 或说明，按原要求回复。保存后再确认已更新。`;
    },
    acceptReceipt(receipt: DataToolOutcome) {
      if (receipt.data.error) return;
      const previousTask = facts.active_task_ref;
      if (receipt.frozen_notification_covered !== undefined)
        facts.frozen_notification_covered = receipt.frozen_notification_covered;
      if (receipt.context_reset) {
        facts.active_task_ref = receipt.context_reset;
        activeTaskChanged = true;
      }
      if (receipt.tool_name === 'update_analysis_task' && typeof receipt.data.task_id === 'string'
        && typeof receipt.data.condition_version === 'string') {
        const current = {task_id: receipt.data.task_id, condition_version: receipt.data.condition_version};
        const previousVersion = previousTask?.task_id === current.task_id ? previousTask.condition_version
          : facts.tasks.find(task => task.id === current.task_id)?.condition_version;
        if (receipt.data.conditions && previousVersion && previousVersion !== current.condition_version
          && reportRefs.has(current.task_id)) revisedReportTask = current.task_id;
        activeTaskChanged ||= facts.active_task_ref?.task_id !== current.task_id
          || facts.active_task_ref.condition_version !== current.condition_version;
        facts.active_task_ref = current;
      }
      if (['read_analysis_report', 'save_analysis_report'].includes(receipt.tool_name)
        && receipt.data.reference && typeof receipt.data.reference === 'object') {
        const report = receipt.data.reference as NonNullable<WorkspaceContext['tasks'][number]['report_ref']>;
        reportRefs.set(report.task_id, report);
        if (receipt.tool_name === 'read_analysis_report' && ['available', 'historical'].includes(String(receipt.data.status)))
          openedReportTask = report.task_id;
      }
      // 控制投影只随真实改变控制状态的工具回执更新；其余回执不改变等待事实。
      if (receipt.control_delivery !== undefined)
        facts.control_delivery = receipt.control_delivery ?? null;
      if (receipt.tool_name === 'read_analysis_task')
        facts.tasks = facts.tasks.filter(task => task.id !== receipt.data.id);
      if (receipt.tool_name === 'update_analysis_task')
        // route不改条件且回执不带正文，仍保留同版候选；修订成功才撤下旧版。
        facts.tasks = facts.tasks.filter(task => task.id !== receipt.data.source_task_id && (task.id !== receipt.data.task_id || task.condition_version === receipt.data.condition_version));
      if (receipt.superseded_query_ids) {
        // 只消费宿主同事务返回的实际失效身份，不在Node重做条件/SQL状态判断。
        const superseded = new Set<unknown>(receipt.superseded_query_ids);
        facts.query_observations = facts.query_observations.filter(query => !superseded.has(query.id));
      }
      if (['request_query', 'get_query', 'execute_query', 'cancel_query'].includes(receipt.tool_name)) {
        if (Array.isArray(receipt.data.queries)) {
          const ids = new Set<unknown>(receipt.data.queries.map(query => query?.id));
          facts.query_observations = facts.query_observations.filter(observation => !ids.has(observation.id));
        }
        const query = receipt.tool_name === 'get_query' ? receipt.data.query : receipt.data;
        if (query && typeof query === 'object' && !Array.isArray(query) && 'id' in query)
          facts.query_observations = facts.query_observations.filter(observation => observation.id !== query.id);
      }
      if (receipt.tool_name === 'manage_personal_asset')
        // 成功回执已包含新正文，不用模型提交的候选字段重建，也不改变authority。
        memories = memories.filter(memory => memory.id !== receipt.data.id);
    },
  };
}
