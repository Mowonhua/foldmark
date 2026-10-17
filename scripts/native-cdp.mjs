/** 原生 WebView 验收辅助：连接显式开启的调试端口，不读取其他应用页面。 */
export async function connectWebview(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const target = targets.find(target => target.type === 'page');
  if (!target) throw new Error('未找到原生应用页面');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let next = 0; const pending = new Map(); const listeners = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method) { for (const listener of listeners.get(message.method) ?? []) listener(message.params); return; }
    const waiter = pending.get(message.id);
    if (!waiter) return; pending.delete(message.id); clearTimeout(waiter.timeout);
    if (message.error) waiter.reject(new Error(message.error.message)); else waiter.resolve(message.result);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++next; const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} 超时`)); }, 30000);
    pending.set(id, { resolve, reject, timeout }); socket.send(JSON.stringify({ id, method, params }));
  });
  return {
    call,
    /** 订阅调试器事件，返回取消函数；事件数据仅留在调用方，不输出页面上下文。 */
    on(method, listener) {
      if (!listeners.has(method)) listeners.set(method, new Set());
      listeners.get(method).add(listener);
      return () => listeners.get(method)?.delete(listener);
    },
    async evaluate(expression) {
      const value = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description ?? value.exceptionDetails.text);
      return value.result?.value;
    },
    close() { socket.close(); },
  };
}
