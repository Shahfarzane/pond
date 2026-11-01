// Local test site for Pond's archiver. Each check renders PASS or MISSING so a replayed
// archive shows on screen which parts survived.
//   http://127.0.0.1:47831/          main page: GraphQL-style POSTs, a worker, a cross-site iframe
//   http://localhost:47831/frame.html the iframe (localhost vs 127.0.0.1 is cross-site)
//   http://127.0.0.1:47831/guarded   answers 403 with a script that sets a cookie and reloads,
//                                     the way a Cloudflare managed challenge does
import { createServer } from "node:http";

const PORT = 47831;
const ANSWERS = { alpha: "first answer", bravo: "second answer" };
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const css = `body{font:20px/1.5 -apple-system,system-ui,sans-serif;margin:32px;color:#111;background:#fff}
li{margin:6px 0} .pass{color:#0a7d32;font-weight:600} .miss{color:#c0261c;font-weight:600}`;

const mainPage = `<!doctype html><html><head><meta charset="utf-8"><title>Pond archive probe</title>
<style>${css} iframe{width:640px;height:190px;border:2px solid #999;margin-top:12px}</style></head>
<body><h1>Pond archive probe</h1>
<ul>
  <li>Query alpha: <span id="alpha" class="miss">MISSING</span></li>
  <li>Query bravo: <span id="bravo" class="miss">MISSING</span></li>
  <li>Worker data: <span id="worker" class="miss">MISSING</span></li>
</ul>
<div>Cross-site iframe:</div>
<iframe src="http://localhost:${PORT}/frame.html"></iframe>
<script>
  const show = (id, ok, text) => {
    const el = document.getElementById(id);
    el.textContent = text;
    el.className = ok ? "pass" : "miss";
  };
  for (const [id, expected] of ${JSON.stringify(Object.entries(ANSWERS))}) {
    fetch("/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: id }),
    })
      .then((r) => r.json())
      .then((d) => show(id, d.answer === expected, d.answer === expected ? "PASS (" + d.answer + ")" : "WRONG (" + d.answer + ")"))
      .catch(() => show(id, false, "MISSING"));
  }
  try {
    const w = new Worker("/worker.js");
    w.onmessage = (e) => show("worker", e.data === "worker ok", e.data === "worker ok" ? "PASS" : "MISSING");
    w.onerror = () => show("worker", false, "MISSING");
  } catch { show("worker", false, "MISSING"); }
</script></body></html>`;

const framePage = `<!doctype html><html><head><meta charset="utf-8"><style>${css} body{margin:12px}</style></head>
<body><div>Frame data: <span id="data" class="miss">MISSING</span></div>
<div>Frame image: <img id="img" src="/frame-img.svg" width="120" height="40" alt="MISSING"></div>
<script>
  fetch("/frame-data.json").then((r) => r.json())
    .then((d) => { const el = document.getElementById("data"); el.textContent = d.ok ? "PASS" : "MISSING"; el.className = d.ok ? "pass" : "miss"; })
    .catch(() => {});
</script></body></html>`;

const frameImg = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><rect width="120" height="40" rx="6" fill="#0a7d32"/><text x="60" y="27" font-family="sans-serif" font-size="20" fill="#fff" text-anchor="middle">PASS</text></svg>`;

const challengePage = `<!doctype html><html><head><meta charset="utf-8"><title>Just a moment...</title><style>${css}</style></head>
<body><h1>Checking your browser</h1><script>
  setTimeout(() => { document.cookie = "probe_clearance=1; path=/"; location.reload(); }, 1500);
</script></body></html>`;

const guardedPage = `<!doctype html><html><head><meta charset="utf-8"><title>Guarded probe page</title>
<meta property="og:title" content="Guarded probe page"><meta name="description" content="Passed the browser check">
<style>${css}</style></head><body><h1>Guarded probe page</h1><p class="pass">PASS: got past the browser check</p></body></html>`;

const server = createServer((req, res) => {
  const send = (status, type, body) => {
    res.writeHead(status, {
      "content-type": type,
      "cache-control": "no-store",
    });
    res.end(body);
  };
  const path = new URL(req.url, "http://x").pathname;
  console.log(new Date().toISOString(), req.method, req.headers.host, req.url);
  if (path === "/" && req.method === "GET")
    return send(200, "text/html; charset=utf-8", mainPage);
  if (path === "/frame.html")
    return send(200, "text/html; charset=utf-8", framePage);
  if (path === "/frame-img.svg") return send(200, "image/svg+xml", frameImg);
  if (path === "/frame-data.json")
    return send(200, "application/json", JSON.stringify({ ok: true }));
  if (path === "/worker.js")
    return send(
      200,
      "text/javascript",
      `fetch("/worker-data.json").then(r => r.json()).then(d => postMessage(d.ok ? "worker ok" : "bad")).catch(() => postMessage("bad"));`,
    );
  if (path === "/worker-data.json")
    return send(200, "application/json", JSON.stringify({ ok: true }));
  if (path === "/graphql" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let query = "";
      try {
        query = JSON.parse(body).query;
      } catch {}
      send(
        200,
        "application/json",
        JSON.stringify({ answer: ANSWERS[query] ?? "unknown" }),
      );
    });
    return;
  }
  if (path === "/guarded") {
    const cleared = /(?:^|;\s*)probe_clearance=1/.test(
      req.headers.cookie ?? "",
    );
    return cleared
      ? send(200, "text/html; charset=utf-8", guardedPage)
      : send(403, "text/html; charset=utf-8", challengePage);
  }
  if (path === "/favicon.ico") {
    res.writeHead(200, {
      "content-type": "image/png",
      "cache-control": "no-store",
    });
    return res.end(Buffer.from(PNG_1X1, "base64"));
  }
  send(404, "text/plain", "not found");
});

server.listen(PORT, "127.0.0.1", () =>
  console.log(`fixture on http://127.0.0.1:${PORT}/`),
);
