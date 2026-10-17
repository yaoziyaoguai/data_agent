import type { Message, Tool } from '@earendil-works/pi-ai';

// 预检只决定是否提前调用Pi原生compact；不复制SDK序列化器，也不替代provider最终字节检查。
export function estimateRequestBytes(
  systemPrompt: string, history: Message[], tools: Tool[], references: string[], input: string,
): number {
  const serialized = JSON.stringify({
    systemPrompt, history, references, input,
    tools: tools.map(({name, description, parameters}) => ({name, description, parameters})),
  });
  // 工具参数在OpenAI协议中再编码为JSON字符串；对完整内容多计一次转义并预留协议外壳。
  return Buffer.byteLength(JSON.stringify(serialized), 'utf8') + 4096;
}
