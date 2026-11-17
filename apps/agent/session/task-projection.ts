import {createSyntheticSourceInfo, formatSkillsForPrompt, type ContextWithSystemEvent, type Extension, type SessionManager} from '@earendil-works/pi-coding-agent';
import {getCurrentSystemMessage} from '@earendil-works/pi-ai';
import type {DataToolOutcome, WorkspaceContext} from '../../../packages/contracts/generated/boundary.ts';
import type {RustTransport} from '../transport/client.ts';
import {exportCheckpoint} from './checkpoint.ts';
import {selectedSkillResources} from './skills.ts';
import {sourceContextFacts, sourceContextGuidance} from './workspace-context.ts';

// 业务范围变化使用Pi自保留边界，旧条目仍在原会话中；不做模型摘要、不重放工具。
// 来源未裁决期间暂停正文读取与执行工具，以及Rust requires_source_context必拒的纯受限工具
// （data_tools.rs无豁免名单，可见即必拒）；归属/来源身份/任务目录/取消及资产停用保留，Rust业务门仍兜底。
const pausedWhileUnresolved = new Set(['read', 'read_knowledge', 'read_source', 'request_query', 'execute_query',
  'get_query', 'prepare_analysis_answer', 'present_analysis_answer', 'save_analysis_evidence',
  'save_analysis_report', 'read_analysis_report', 'read_analysis_task', 'validate_sql',
  'prepare_skill_draft', 'propose_semantic_change']);
export function taskProjection(transport: RustTransport, manager: SessionManager,
  replaceWorkspace: (workspace: WorkspaceContext) => void) {
  let pending: string | undefined;
  let failure: unknown;
  let toolGate: ((names: string[]) => void) | undefined;
  let allTools: string[] = [];
  // 就绪随非错误回执实时更新（与workspace-context同一语义）；派发快照只作初值。
  let sourceReady = transport.run.workspace_context?.source_context_ready;
  let skills = formatSkillsForPrompt(selectedSkillResources(transport.run.workspace_context?.selected_skills ?? []));
  const initialEntryIds = new Set(manager.getBranch().map(entry => entry.id));
  const hidden = () => pending !== undefined || sourceReady === false;
  const workspace = transport.run.workspace_context;
  const previous = workspace?.authority_snapshot?.active_task as Record<string, unknown> | undefined;
  const current = workspace?.active_task_ref;
  if (transport.run.resume_same_input && current &&
    (previous?.task_id !== current.task_id || previous?.condition_version !== current.condition_version)) {
    // 工具回执可能已进检查点，但尚未提交新投影；接回控制身份，不重做业务。
    for (const message of manager.buildSessionContext().messages) {
      if (message.role !== 'toolResult') continue;
      const receipt = message.details as DataToolOutcome | undefined;
      if (receipt?.context_reset?.task_id === current.task_id &&
        receipt.context_reset.condition_version === current.condition_version) pending = message.toolCallId;
    }
  }
  const apply = async () => {
    if (!pending) return false;
    const sdkId = pending;
    const previousLeaf = manager.getLeafId();
    const completedTools = manager.buildSessionContext().messages.filter(message => message.role === 'toolResult')
      .slice(-20).map(message => ({sdk_tool_call_id:message.toolCallId,tool_name:message.toolName,
        state:message.isError?'failed':'completed'}));
    manager.appendCompaction('活动任务或来源范围已更新。先前资料及其摘要已移出当前上下文；成功操作保留原身份，不重复执行。', null, 0, {scope_change_tool_call_id:sdkId}, true);
    manager.appendCustomMessageEntry('data_agent_current_input',
      '继续处理原用户输入：'+transport.run.text+'\n当前任务与版本以宿主事实为准；范围变更工具已成功，必要资料按当前范围补读。已处理工具的控制记录：'+JSON.stringify(completedTools), false,
      {message_id:transport.run.message_id, sdk_tool_call_id:sdkId});
    try {
      const workspace = await transport.post(
        '/internal/context/refresh', 'RefreshRunContext', {...transport.binding(), sdk_tool_call_id:sdkId,
          checkpoint:exportCheckpoint(manager)});
      // 已进入新准入协议的输入不能因旧刷新缺字段而获得正文承诺；旧v1原本缺字段仍沿原行为。
      if (workspace.source_context_ready === undefined && transport.run.workspace_context?.source_context_ready !== undefined)
        workspace.source_context_ready = false;
      transport.run.workspace_context = workspace;
      replaceWorkspace(workspace);
      pending = undefined;
      sourceReady = workspace.source_context_ready;
      // 刷新后仍未裁决则保持收窄；Pi在每轮下一请求前重读active集（§6.1）。
      toolGate?.(hidden() ? allTools.filter(name => !pausedWhileUnresolved.has(name)) : allTools);
      skills = formatSkillsForPrompt(selectedSkillResources(workspace.selected_skills));
      return true;
    } catch (error) {
      if (previousLeaf) manager.branch(previousLeaf);
      failure = error;
      throw error;
    }
  };
  const path = '<inline:data_agent_task_projection>';
  const extension: Extension = {
    path, resolvedPath:path, sourceInfo:createSyntheticSourceInfo(path,{source:'inline',scope:'temporary'}),
    handlers:new Map<string, ((event: unknown) => Promise<unknown>)[]>([
      ['turn_end', [async () => await apply() ? {continue:true} : undefined]],
      // Pi原生摘要直接读持久分支，不经过context；隐藏期间不得把旧正文发给摘要模型。
      ['session_before_compact', [async () => hidden() ? {cancel:true} : undefined]],
      ['context_with_system', [async event => {
        const messages = (event as ContextWithSystemEvent).messages.map(message => {
          if (message.role === 'system' && message.sections) {
            return {...message, sections: {...message.sections, skills: hidden() ? '' : skills}};
          }
          return message;
        });
        if (!hidden()) return {messages};
        const system = getCurrentSystemMessage(messages.filter(message => message.role === 'system'));
        const branch = manager.getBranch();
        // 新输入按启动leaf之后定位，恢复按原话或宿主message_id定位；不拿最后一条恢复通知当用户原话。
        const start = branch.findLastIndex(entry =>
          (entry.type === 'custom_message' && entry.customType === 'data_agent_current_input'
            && (entry.details as {message_id?: string} | undefined)?.message_id === transport.run.message_id)
          || (entry.type === 'message' && entry.message.role === 'user'
            && (transport.run.resume_same_input || !initialEntryIds.has(entry.id))
            && (typeof entry.message.content === 'string' ? entry.message.content
              : entry.message.content.filter(part => part.type === 'text').map(part => part.text).join('')) === transport.run.text));
        const currentEntries = start < 0 ? [] : branch.slice(start + 1);
        const currentResults = new Set(currentEntries.flatMap(entry =>
          entry.type === 'message' && entry.message.role === 'toolResult' ? [entry.message.toolCallId] : []));
        const directoryCalls = new Set(currentEntries.flatMap(entry =>
          entry.type === 'message' && entry.message.role === 'assistant' ? entry.message.content.flatMap(part =>
            part.type === 'toolCall' && part.name === 'read_conversation' && part.arguments.task_directory === true ? [part.id] : []) : []));
        const control = messages.flatMap(message => {
          if (message.role !== 'toolResult' || !currentResults.has(message.toolCallId)) return [];
          const receipt = message.details as DataToolOutcome | undefined;
          const data = receipt?.data ?? {};
          const fields = Object.fromEntries(['id', 'task_id', 'source_task_id', 'condition_version', 'current_condition_version',
            'lifecycle', 'phase', 'error', 'outcome', 'execution_state', 'context_complete', 'has_more_clarifications', 'routed']
            .filter(key => data[key] === null || ['string', 'boolean', 'number'].includes(typeof data[key]))
            .map(key => [key, data[key]]));
          // task_context_required的hint是Rust固定指导；恢复只选控制身份，不携正文或尚未开放的read_tool。
          const recovery = data.error === 'task_context_required' && data.recovery
            ? Object.fromEntries(['task', 'query'].flatMap(kind => {
              const state = (data.recovery as Record<string, Record<string, unknown>>)[kind];
              if (!state) return [];
              return [[kind, Object.fromEntries(['task_id', 'query_id', 'condition_version', 'draft_version',
                'lifecycle', 'phase', 'confirmation_state', 'execution_state', 'cancel_state',
                'open_clarification_ids', 'has_more_clarifications']
                .filter(key => state[key] !== undefined).map(key => [key, state[key]]))]];
            })) : undefined;
          const admission = data.error === 'task_context_required' ? {
            hint: data.hint,
            ...(data.new_execution_authorized === false ? {new_execution_authorized: false} : {}),
            ...(recovery ? {recovery} : {}),
          } : {};
          // 目录RPC只透传宿主已净化的控制标题；不从旧范围目录补goal，也不附条件/问题/答案/SQL。
          const directory = receipt?.tool_name === 'read_conversation' && directoryCalls.has(message.toolCallId) && Array.isArray(data.tasks)
            ? {tasks:data.tasks.map(task => ({id:task.id, condition_version:task.condition_version,
              lifecycle:task.lifecycle, phase:task.phase, context_complete:task.context_complete,
              ...(typeof task.goal === 'string' ? {goal:task.goal} : {})})),
              ...Object.fromEntries(['next_task_after', 'page_limited']
                .filter(key => data[key] === null || ['string', 'boolean'].includes(typeof data[key])).map(key => [key, data[key]]))}
            : undefined;
          // 身份结果只用于选择StableSourceKey，不携取证正文，也不生成已读依据。
          const hits = receipt?.tool_contract_version === 2 && receipt.tool_name === 'search_knowledge' && Array.isArray(data.hits)
            ? data.hits.filter(hit => hit?.record_kind === 'source_identity').map(hit => ({
              record_kind: hit.record_kind, name: hit.name, kind: hit.kind,
              object_id: hit.object_id, object_version: hit.object_version,
              source_keys: hit.source_keys, roots_complete: hit.roots_complete,
            })) : [];
          const coverage = receipt?.tool_name === 'search_knowledge' && data.search_coverage
            && typeof data.search_coverage === 'object' ? data.search_coverage as Record<string, unknown> : undefined;
          return [{role:'custom' as const, customType:'data_agent_source_control', display:false, timestamp:message.timestamp,
            content:JSON.stringify({sdk_tool_call_id:message.toolCallId, tool_name:message.toolName,
              isError:message.isError, source_context_ready:receipt?.source_context_ready, context_reset:receipt?.context_reset,
              source_context_blocker:receipt?.source_context_blocker,
              source_context_hint:sourceContextGuidance(receipt?.source_context_blocker),
              data:{...fields, ...admission, ...directory, ...(hits.length ? {hits} : {}), ...(coverage ? {search_coverage:{
                state:coverage.state, next:coverage.next, reasons:coverage.reasons, channels:coverage.channels,
              }} : {})}})}];
        });
        const currentWorkspace = transport.run.workspace_context;
        return {messages:[
          ...(system ? [system] : []),
          // 附件/Skill正文暂不可读是来源门结果，不是选择失效；给真实状态和合法下一动作，
          // 防止模型把暂不可用误读成未选择而要求用户重选。
          ...(currentWorkspace ? [{role:'custom' as const, customType:'data_agent_workspace', display:false, timestamp:0,
            content:'当前宿主事实：来源尚未确定，仅含控制身份；先用update_analysis_task落实归属与来源，等待必要刷新并由宿主确认source_context_ready=true后继续原请求。正文工具仍受来源门约束。\n'
              +((currentWorkspace.asset_counts?.selected_skills ?? currentWorkspace.selected_skills.length) > 0
                ? '已选Skill保持原选择和版本（数量见asset_counts.selected_skills）；selected_skills仅列当前允许交付的预览，列表为空不代表没有选择。正文暂不可读只是来源未决，不是未选择或已失效，来源确认后按原选择补读，不需要重新选用。\n' : '')
              +JSON.stringify(sourceContextFacts(currentWorkspace))}] : []),
          {role:'user' as const, content:transport.run.text, timestamp:0},
          ...control,
        ]};
      }]],
    ]),
    tools:new Map(), messageRenderers:new Map(), commands:new Map(), flags:new Map(), shortcuts:new Map(),
  };
  return {
    extension, apply, hidesSourceContext:hidden,
    attachToolGate(gate: (names: string[]) => void, names: string[]) {
      toolGate = gate;
      allTools = names;
      // Pi在run开始时快照工具集：首次prompt/恢复回放前的收窄必须先落进active集，
      // 请求边界内再调整只影响下一轮。
      if (hidden()) gate(names.filter(name => !pausedWhileUnresolved.has(name)));
    },
    acceptReceipt(receipt: DataToolOutcome, sdkId: string) {
      if (receipt.data.error) return;
      if (receipt.context_reset) {
        pending = sdkId;
        // 回执即翻转裁决状态；下一请求前收窄可见集合，Rust业务门仍兜底。
        toolGate?.(allTools.filter(name => !pausedWhileUnresolved.has(name)));
      } else if (pending === undefined && receipt.source_context_ready !== undefined) {
        // 成功回执确认来源已裁决即恢复全集；等待刷新期间不重复采信（§6.1）。
        sourceReady = receipt.source_context_ready;
        toolGate?.(hidden() ? allTools.filter(name => !pausedWhileUnresolved.has(name)) : allTools);
      }
    },
    check() { if (failure) throw failure; },
  };
}
