// Reloads the nested iframe inside Pond's replayed page and prints network and navigation events for it.
// Usage: node reload-iframe.mjs <devtools port>
const port = process.argv[2];
const targets = await (
  await fetch(`http://127.0.0.1:${port}/json/list`)
).json();
const webview = targets.find(
  (t) => t.type === "webview" && t.url.startsWith("pond://_replay"),
);
const ws = new WebSocket(webview.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0;
const waiting = new Map();
const contexts = [];
ws.addEventListener("message", (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && waiting.has(msg.id)) {
    waiting.get(msg.id)(msg);
    waiting.delete(msg.id);
    return;
  }
  if (msg.method === "Runtime.executionContextCreated")
    contexts.push(msg.params.context);
  const p = msg.params ?? {};
  const url = p.request?.url ?? p.response?.url ?? p.frame?.url ?? p.url ?? "";
  if (
    /frame\.html|chrome-error/.test(url) ||
    msg.method === "Network.loadingFailed" ||
    msg.method === "Page.frameStartedLoading" ||
    msg.method === "Security.securityStateChanged"
  ) {
    console.log(
      msg.method,
      JSON.stringify({
        url: url.slice(0, 140),
        status: p.response?.status,
        fromSW: p.response?.fromServiceWorker,
        errorText: p.errorText,
        blockedReason: p.blockedReason,
        corsErrorStatus: p.corsErrorStatus,
        type: p.type,
        unreachableUrl: p.frame?.unreachableUrl,
      }),
    );
  }
  if (msg.method === "Log.entryAdded")
    console.log("log:", p.entry.text.slice(0, 300));
  if (msg.method === "Runtime.consoleAPICalled")
    console.log(
      "console:",
      p.args
        .map((a) => a.value ?? a.description)
        .join(" ")
        .slice(0, 300),
    );
});
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const mid = ++id;
    waiting.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
await send("Network.enable");
await send("Page.enable");
await send("Log.enable");
await send("Runtime.enable");
await new Promise((r) => setTimeout(r, 300));
const frames = [];
const walk = (node) => {
  frames.push(node.frame);
  for (const child of node.childFrames ?? []) walk(child);
};
walk((await send("Page.getFrameTree")).result.frameTree);
const page = frames.find((f) => f.url.includes("/mp_/"));
const main = contexts.find(
  (c) => c.auxData?.frameId === page.id && c.auxData?.isDefault,
);
await send("Runtime.evaluate", {
  contextId: main.id,
  expression: `(() => { const f = document.querySelector("iframe"); const s = f.src; f.src = "about:blank"; setTimeout(() => { f.src = s; }, 200); return s; })()`,
  returnByValue: true,
});
await new Promise((r) => setTimeout(r, 3000));
walk((await send("Page.getFrameTree")).result.frameTree);
console.log(
  "frames now:",
  frames
    .slice(-4)
    .map((f) =>
      f.unreachableUrl
        ? `${f.url} (unreachable ${f.unreachableUrl.slice(0, 120)})`
        : f.url.slice(0, 120),
    ),
);
ws.close();
