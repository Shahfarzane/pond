// Prints the frame tree of Pond's archive webview and a snippet of each frame's DOM.
// Usage: node inspect-replay.mjs <devtools port>
const port = process.argv[2];
const targets = await (
  await fetch(`http://127.0.0.1:${port}/json/list`)
).json();
const webview = targets.find(
  (t) => t.type === "webview" && /^pond:\/\/_?replay\//.test(t.url),
);
if (!webview) throw new Error("no replay webview");
const ws = new WebSocket(webview.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0;
const waiting = new Map();
ws.addEventListener("message", (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && waiting.has(msg.id)) {
    waiting.get(msg.id)(msg);
    waiting.delete(msg.id);
  } else if (
    msg.method === "Runtime.consoleAPICalled" ||
    msg.method === "Log.entryAdded"
  ) {
    const text =
      msg.params.entry?.text ??
      msg.params.args?.map((a) => a.value ?? a.description).join(" ");
    console.log("console:", String(text).slice(0, 300));
  }
});
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const mid = ++id;
    waiting.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });

const tree = (await send("Page.getFrameTree")).result.frameTree;
const frames = [];
const walk = (node, depth) => {
  frames.push({ id: node.frame.id, url: node.frame.url, depth });
  for (const child of node.childFrames ?? []) walk(child, depth + 1);
};
walk(tree, 0);
for (const f of frames) {
  const world = await send("Page.createIsolatedWorld", {
    frameId: f.id,
    worldName: "probe",
  });
  const ctx = world.result?.executionContextId;
  const res = ctx
    ? await send("Runtime.evaluate", {
        contextId: ctx,
        expression: `JSON.stringify({ text: (document.body ? document.body.innerText : "").replace(/\\s+/g, " ").slice(0, 120), iframes: [...document.querySelectorAll("iframe")].map((f) => f.getAttribute("src") + " => " + f.src) })`,
        returnByValue: true,
      })
    : null;
  console.log(
    `${"  ".repeat(f.depth)}${f.url.slice(0, 150)}\n${"  ".repeat(f.depth)}  -> ${JSON.stringify(res?.result?.result?.value ?? world.error?.message)}`,
  );
}
ws.close();
