// 只核验供应商是否实际提供用量；协议解析与标准化仍由Pi完成。
export function providerUsage(api: string) {
  let usage: { input_tokens: number; output_tokens: number } | undefined;
  let anthropicInput:
    { input: number; read: number; write: number } | undefined;
  const count = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  const object = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  return {
    read: () => usage,
    accept(chunk: unknown) {
      const event = object(chunk);
      if (api === "anthropic-messages") {
        const start = object(object(event.message).usage),
          delta = object(event.usage);
        if (event.type === "message_start" && count(start.input_tokens)) {
          const read = start.cache_read_input_tokens ?? 0,
            write = start.cache_creation_input_tokens ?? 0;
          if (count(read) && count(write))
            anthropicInput = { input: start.input_tokens, read, write };
        }
        if (event.type === "message_delta" && count(delta.output_tokens)) {
          // 当前协议在message_delta只更新明确出现的输入计数字段。
          if (anthropicInput) {
            for (const [source, target] of [
              ["input_tokens", "input"],
              ["cache_read_input_tokens", "read"],
              ["cache_creation_input_tokens", "write"],
            ] as const) {
              if (delta[source] !== undefined) {
                if (!count(delta[source])) {
                  anthropicInput = undefined;
                  return;
                }
                anthropicInput[target] = delta[source];
              }
            }
            usage = {
              input_tokens:
                anthropicInput.input +
                anthropicInput.read +
                anthropicInput.write,
              output_tokens: delta.output_tokens,
            };
          }
        }
      } else {
        const raw = object(
          api === "openai-responses"
            ? object(event.response).usage
            : event.usage,
        );
        const input =
          raw[api === "openai-responses" ? "input_tokens" : "prompt_tokens"];
        const output =
          raw[
            api === "openai-responses" ? "output_tokens" : "completion_tokens"
          ];
        if (count(input) && count(output))
          usage = { input_tokens: input, output_tokens: output };
      }
    },
  };
}
