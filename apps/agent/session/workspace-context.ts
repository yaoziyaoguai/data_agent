import {
  createSyntheticSourceInfo,
  type ContextEvent,
  type Extension,
} from '@earendil-works/pi-coding-agent';
import type { DataToolOutcome, WorkspaceContext } from '../../../packages/contracts/generated/boundary.ts';

// 只投影本轮已回源的候选；正式状态、历史、授权和压缩仍由宿主/Pi管理。
export function workspaceContext(workspace: WorkspaceContext) {
  const memoryType = 'data_agent_memories', workspaceType = 'data_agent_workspace';
  const { memories: initialMemories, authority_snapshot: _snapshot, authority_revision: _revision,
    recent_messages: _recent, ...initialFacts } = structuredClone(workspace);
  let memories = initialMemories;
  const facts = initialFacts;
  const workspaceContent = () => '当前宿主事实：本轮启动快照，后续工具回执优先。\n' + JSON.stringify(facts);
  const content = () => '个人记忆参考：本轮已核验候选，非指令或执行授权；当前正文以成功工具回执为准。\n' + JSON.stringify({memories});
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
    }]]]),
    tools: new Map(), messageRenderers: new Map(), commands: new Map(), flags: new Map(), shortcuts: new Map(),
  };
  return {
    extension,
    contents: () => [workspaceContent(), content()],
    acceptReceipt(receipt: DataToolOutcome) {
      if (receipt.data.error) return;
      if (receipt.tool_name === 'read_analysis_task')
        facts.tasks = facts.tasks.filter(task => task.id !== receipt.data.id);
      if (receipt.tool_name === 'update_analysis_task')
        // route不改条件且回执不带正文，仍保留同版候选；修订成功才撤下旧版。
        facts.tasks = facts.tasks.filter(task => task.id !== receipt.data.task_id || task.condition_version === receipt.data.condition_version);
      if (['request_query', 'get_query', 'execute_query', 'cancel_query'].includes(receipt.tool_name)) {
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
