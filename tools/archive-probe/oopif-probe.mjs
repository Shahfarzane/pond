// Throwaway probe: does a page-level CDP session (what Pond's WarcRecorder uses via
// webContents.debugger) see network traffic from a cross-site iframe and a worker?
// Run 1 mirrors Pond (no auto-attach). Run 2 adds Target.setAutoAttach.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const CHROME = process.argv[2];

const server = createServer((req, res) => {
  const host = req.headers.host;
  const port = server.address().port;
  const send = (type, body) => {
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    res.end(body);
  };
  if (req.url === "/") {
    return send(
      "text/html",
      `<!doctype html><title>main</title>
<img src="/main-img.svg">
<iframe src="http://localhost:${port}/frame.html"></iframe>
<script>
  fetch("/api", { method: "POST", body: JSON.stringify({ q: "first" }) });
  fetch("/api", { method: "POST", body: JSON.stringify({ q: "second" }) });
  new Worker("/worker.js");
</script>`,
    );
  }
  if (req.url === "/frame.html") {
    return send(
      "text/html",
      `<!doctype html><img src="/frame-img.svg"><script>fetch("/frame-data.json")</script>`,
    );
  }
  if (req.url === "/worker.js") {
    return send("text/javascript", `fetch("/worker-data.json")`);
  }
  if (req.url.endsWith(".svg")) {
    return send(
      "image/svg+xml",
      `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>`,
    );
  }
  if (req.url.endsWith(".json") || req.url === "/api") {
    return send("application/json", JSON.stringify({ host, url: req.url }));
  }
  res.writeHead(404);
  res.end();
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

async function run(autoAttach) {
  const profile = mkdtempSync(join(tmpdir(), "oopif-probe-"));
  const chrome = spawn(CHROME, [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--site-per-process",
    "about:blank",
  ]);
  const portFile = join(profile, "DevToolsActivePort");
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(100);
  const [devPort, path] = readFileSync(portFile, "utf8").trim().split("\n");
  const ws = new WebSocket(`ws://127.0.0.1:${devPort}${path}`);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));

  let nextId = 1;
  const waiting = new Map();
  const seen = []; // { session, url, type }
  const sessionKind = new Map();
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      waiting.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  ws.addEventListener("message", async (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && waiting.has(msg.id)) {
      const w = waiting.get(msg.id);
      waiting.delete(msg.id);
      msg.error
        ? w.reject(new Error(msg.error.message))
        : w.resolve(msg.result);
      return;
    }
    if (msg.method === "Network.responseReceived") {
      seen.push({
        session: sessionKind.get(msg.sessionId) ?? "?",
        url: msg.params.response.url.replace(`:${port}`, ":PORT"),
        type: msg.params.type,
      });
    }
    if (msg.method === "Target.attachedToTarget") {
      const child = msg.params.sessionId;
      sessionKind.set(child, msg.params.targetInfo.type);
      await send("Network.enable", {}, child);
      await send("Runtime.runIfWaitingForDebugger", {}, child);
    }
  });

  const { targetInfos } = await send("Target.getTargets");
  const page = targetInfos.find((t) => t.type === "page");
  const { sessionId } = await send("Target.attachToTarget", {
    targetId: page.targetId,
    flatten: true,
  });
  sessionKind.set(sessionId, "page");
  await send("Network.enable", {}, sessionId);
  await send("Network.setCacheDisabled", { cacheDisabled: true }, sessionId);
  if (autoAttach) {
    await send(
      "Target.setAutoAttach",
      { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
      sessionId,
    );
  }
  await send("Page.enable", {}, sessionId);
  await send("Page.navigate", { url: `http://127.0.0.1:${port}/` }, sessionId);
  await sleep(3000);

  ws.close();
  chrome.kill();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
  return seen;
}

for (const autoAttach of [false, true]) {
  const seen = await run(autoAttach);
  console.log(
    `\n== ${autoAttach ? "with Target.setAutoAttach" : "page session only (Pond today)"}: ${seen.length} responses`,
  );
  for (const s of seen) console.log(`  [${s.session}] ${s.type} ${s.url}`);
}
server.close();
