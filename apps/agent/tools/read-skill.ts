import { createReadToolDefinition, createReadTool } from '@earendil-works/pi-coding-agent';
import type { DataToolOutcome, SkillReadInput } from '../../../packages/contracts/generated/boundary.ts';

export const nativeSkillRead = createReadToolDefinition('/');

// 复用 Pi 的行分页、截断和输出格式；仅替换读取能力，禁止主机文件 IO。
export async function formatSkillRead(receipt: DataToolOutcome, args: SkillReadInput, signal?: AbortSignal) {
  const path = receipt.data.path;
  const text = receipt.data.text;
  if (typeof path !== 'string' || typeof text !== 'string' || path !== args.path || !path.startsWith('/skills/')) throw new Error('invalid_skill_receipt');
  const check = async (requested: string) => { if (requested !== path) throw new Error('not_available'); };
  const tool = createReadTool('/', {operations: {
    access: check,
    readFile: async requested => { await check(requested); return Buffer.from(text); },
    detectImageMimeType: async () => null,
  }});
  return tool.execute('controlled-read', args, signal);
}
