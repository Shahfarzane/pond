// Evaluates an expression inside the replayed page frame (the mp_ frame) of Pond's archive webview.
// Usage: node replay-eval.mjs <devtools port> <expression>
const [port, expression] = process.argv.slice(2);
const targets = await (
  await fetch(`http://127.0.0.1:${port}/json/list`)
).json();
const webview = targets.find(
  (t) => t.type === "webview" && /^pond:\/\/_?replay\//.test(t.url),
);
const ws = new WebSocket(webview.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0;
const waiting = new Map();
ws.addEventListener("message", (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && waiting.has(msg.id)) {
    waiting.get(msg.id)(msg);
    waiting.delete(msg.id);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const mid = ++id;
    waiting.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
const frames = [];
const walk = (node) => {
  frames.push(node.frame);
  for (const child of node.childFrames ?? []) walk(child);
};
walk((await send("Page.getFrameTree")).result.frameTree);
const page = frames.find((f) => f.url.includes("/mp_/"));
const contexts = [];
ws.addEventListener("message", (e) => {
  const msg = JSON.parse(e.data);
  if (msg.method === "Runtime.executionContextCreated")
    contexts.push(msg.params.context);
});
await send("Runtime.enable");
await new Promise((r) => setTimeout(r, 300));
const main = contexts.find(
  (c) => c.auxData?.frameId === page.id && c.auxData?.isDefault,
);
const res = await send("Runtime.evaluate", {
  contextId: main.id,
  expression,
  awaitPromise: true,
  returnByValue: true,
});
console.log(
  JSON.stringify(
    res.result?.result?.value ??
      res.result?.exceptionDetails?.exception?.description ??
      res,
    null,
    2,
  ),
);
ws.close();
