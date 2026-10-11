// 只合并 Pi 已产生的文本事件；不改变模型循环、消息边界或恢复身份。
export function outputStream(write: (sequence: string, text: string) => Promise<unknown>) {
  let sequence = 0;
  let buffer = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = Promise.resolve();
  let closed = false;
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    if (!buffer || closed) return;
    const text = buffer;
    buffer = "";
    const next = String(++sequence);
    pending = pending.then(async () => { await write(next, text); });
    // SDK 订阅回调不能 await；交付和关闭仍会等待这条队列。
    void pending.catch(() => {});
  };
  return {
    startMessage() {
      flush();
      return sequence + 1;
    },
    append(delta: string) {
      if (closed) return;
      // 按码点分片，保持 Unicode 完整并低于 AppendOutput 的上限。
      for (const character of delta) {
        buffer += character;
        if (buffer.length >= 2048) flush();
      }
      if (buffer && timer === undefined) timer = setTimeout(flush, 50);
    },
    async drain() {
      flush();
      await pending;
    },
    async close() {
      closed = true;
      clearTimeout(timer);
      buffer = "";
      await pending.catch(() => {});
    },
  };
}
