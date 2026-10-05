import { Type } from 'typebox';
import type { ToolDefinition, SessionManager } from '@earendil-works/pi-coding-agent';
import type { TaskInput, ToolInvocation, ToolOutcome, ToolReceipt } from '../../../packages/contracts/generated/boundary.ts';
import schema from '../../../packages/contracts/schema.json' with { type: 'json' };
import { validateContract } from '../../../packages/contracts/validate.ts';
import { exportCheckpoint } from '../session/checkpoint.ts';
import { RustTransport } from '../transport/client.ts';

export function taskTool(transport: RustTransport, manager: SessionManager, fault: string) {
  const invocation = (sdkId: string, args: TaskInput): ToolInvocation => ({ ...transport.binding(), sdk_tool_call_id: sdkId, arguments: args, checkpoint: exportCheckpoint(manager) });
  const invokeRecorded = async (sdkId: string, args: TaskInput): Promise<ToolReceipt> => {
    validateContract('TaskInput', args);
    const outcome = await transport.post('/internal/tools', 'ToolInvocation', invocation(sdkId, args));
    validateContract('ToolOutcome', outcome);
    const typed = outcome as ToolOutcome;
    if (typed.type !== 'succeeded' || !typed.receipt) throw new Error('tool failed');
    return typed.receipt;
  };
  const definition: ToolDefinition = {
    name: 'update_analysis_task', label: '建立分析任务', description: '为当前用户的当前会话建立分析任务。',
    parameters: Type.Unsafe<TaskInput>(schema.$defs.TaskInput),
    execute: async (sdkId, args) => {
      validateContract('TaskInput', args);
      await transport.post('/internal/tool-calls', 'ToolInvocation', invocation(sdkId, args as TaskInput));
      if (fault === 'before_business_commit') process.exit(73);
      const receipt = await invokeRecorded(sdkId, args as TaskInput);
      if (fault === 'after_business_commit') process.exit(74);
      return { content: [{ type: 'text', text: JSON.stringify(receipt) }], details: receipt };
    },
  };
  return { definition, invokeRecorded };
}
