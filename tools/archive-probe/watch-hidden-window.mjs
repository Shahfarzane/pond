// Waits for a hidden Pond window to load a URL containing <match>, then records its title and
// visible text every two seconds, without enabling Runtime (a common bot-check signal).
// Usage: node watch-hidden-window.mjs <devtools port> <match> [seconds]
const [port, match, secondsArg] = process.argv.slice(2);
const seconds = Number(secondsArg ?? 24);

let target;
for (let i = 0; i < 240 && !target; i++) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  target = list.find((t) => t.type === "page" && t.url.includes(match));
  if (!target) await new Promise((r) => setTimeout(r, 250));
}
if (!target) throw new Error(`no page matching ${match}`);
console.log("found", target.url);

const ws = new WebSocket(target.webSocketDebuggerUrl);
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
ws.addEventListener("close", () => {
  console.log("target closed");
  process.exit(0);
});
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const mid = ++id;
    waiting.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params }));
    setTimeout(
      () => resolve({ error: { message: `${method} timed out` } }),
      2500,
    );
  });

const started = Date.now();
while (Date.now() - started < seconds * 1000) {
  const info = await send("Runtime.evaluate", {
    expression: `JSON.stringify({ t: Math.round(performance.now()), url: location.href, title: document.title, visibility: document.visibilityState, text: (document.body?.innerText || "").replace(/\\s+/g, " ").slice(0, 160), turnstile: !!document.querySelector("iframe[src*='challenges.cloudflare.com'], #challenge-stage, .cf-turnstile") })`,
    returnByValue: true,
  });
  console.log(
    `${((Date.now() - started) / 1000).toFixed(1)}s`,
    info.result?.result?.value ?? info.error?.message ?? "(closed)",
  );
  if (!info.result) break;
  await new Promise((r) => setTimeout(r, 2000));
}
ws.close();
