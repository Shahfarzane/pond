import { spawn, spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import type { JsonValue } from "@pond/schema/json";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tryDecodeFrame } from "./frame";
import { drainInbox } from "./offline-inbox";
import { startNativeServer, stopNativeServer } from "./server";

const source = resolve(
  import.meta.dirname,
  "../../../native-host/pond-native-host.c",
);

/** A Unix socket path must fit in 104 bytes, and macOS's tmpdir alone takes half of that. */
const SHORT_TMP = "/tmp";

const compiler = process.env.CC || "cc";
/** Windows builds the host with MSVC; `server.test.ts` covers its pipe. */
const canCompile =
  process.platform !== "win32" && !spawnSync(compiler, ["--version"]).error;

const dirs: string[] = [];
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(SHORT_TMP, prefix));
  dirs.push(dir);
  return dir;
}

let host = "";
beforeAll(async () => {
  if (!canCompile) return;
  host = join(await tempDir("pond-host-bin-"), "pond-native-host");
  const result = spawnSync(compiler, ["-O2", "-o", host, source], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr);
});

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function home() {
  const dir = await tempDir("pond-host-");
  const pond = join(dir, "Library/Application Support/Pond");
  await mkdir(pond, { recursive: true });
  return { dir, socket: join(pond, "native.sock"), inbox: join(pond, "Inbox") };
}

function frame(text: string): Buffer {
  const body = Buffer.from(text, "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

function runHost(homeDir: string, request: string): Promise<JsonValue> {
  const child = spawn(host, [], {
    env: { HOME: homeDir },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const chunks: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  const reply = new Promise<JsonValue>((resolvePromise, reject) => {
    child.on("error", reject);
    child.on("close", () => {
      const decoded = tryDecodeFrame(Buffer.concat(chunks));
      if (decoded.status === "ok") resolvePromise(decoded.value);
      else reject(new Error("native host returned no reply"));
    });
  });
  child.stdin.end(frame(request));
  return reply;
}

const save = {
  type: "capture.accept",
  draft: {
    id: "c1",
    items: [{ kind: "url", url: 'https://example.com/a?q="}{,' }],
    metadata: { tags: [], folderIds: [] },
  },
};
const withCookies = {
  ...save,
  cookies: [{ name: "sid", value: "secret", domain: ".example.com" }],
};

describe.skipIf(!canCompile)("pond-native-host offline inbox", () => {
  const servers: Awaited<ReturnType<typeof startNativeServer>>[] = [];
  afterAll(async () => {
    for (const server of servers) await stopNativeServer(server);
  });

  it("queues a save without its cookies when Pond is closed", async () => {
    const { dir, inbox } = await home();
    await expect(runHost(dir, JSON.stringify(withCookies))).resolves.toEqual({
      ok: true,
      data: { queued: true },
    });
    const [name, ...rest] = await readdir(inbox);
    expect(rest).toEqual([]);
    expect(name).toMatch(/^\d{13}-\d+\.json$/);
    const file = join(inbox, name ?? "");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(save);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(inbox)).mode & 0o777).toBe(0o700);
  });

  it("queues an enqueue whatever order its members come in", async () => {
    const { dir, inbox } = await home();
    const request =
      '{ "cookies" : [ ] , "url" : "https://example.com/b" , "type" : "enqueue" }';
    await expect(runHost(dir, request)).resolves.toEqual({
      ok: true,
      data: { queued: true },
    });
    const [name] = await readdir(inbox);
    expect(JSON.parse(await readFile(join(inbox, name ?? ""), "utf8"))).toEqual(
      {
        url: "https://example.com/b",
        type: "enqueue",
      },
    );
  });

  it("still answers offline for reads, and writes nothing", async () => {
    const { dir, inbox } = await home();
    for (const type of ["library.info", "tags.list", "extension.settings"]) {
      await expect(runHost(dir, JSON.stringify({ type }))).resolves.toEqual({
        ok: false,
        error: "offline",
      });
    }
    await expect(readdir(inbox)).rejects.toThrow();
  });

  it("does not queue a request it cannot read safely", async () => {
    const { dir, inbox } = await home();
    for (const request of [
      '{"\\u0074ype":"enqueue","url":"https://example.com"}',
      '{"type":"enqueue","url":"https://example.com",}',
      '{"type":"enqueue","url":"https://example.com"',
      '["enqueue"]',
    ]) {
      await expect(runHost(dir, request)).resolves.toEqual({
        ok: false,
        error: "offline",
      });
    }
    await expect(readdir(inbox)).rejects.toThrow();
  });

  it("queues when a crashed Pond left its socket file behind", async () => {
    const { dir, socket, inbox } = await home();
    await writeFile(socket, "");
    await expect(runHost(dir, JSON.stringify(save))).resolves.toEqual({
      ok: true,
      data: { queued: true },
    });
    expect(await readdir(inbox)).toHaveLength(1);
  });

  it("forwards to Pond and queues nothing while Pond is listening", async () => {
    const { dir, socket, inbox } = await home();
    const server = await startNativeServer({
      path: socket,
      dispatch: async () => ({ ok: true as const, data: { live: true } }),
    });
    servers.push(server);
    await expect(runHost(dir, JSON.stringify(withCookies))).resolves.toEqual({
      ok: true,
      data: { live: true },
    });
    await expect(readdir(inbox)).rejects.toThrow();
  });

  it("leaves files Pond's drain reads back as the original save", async () => {
    const { dir, inbox } = await home();
    await runHost(dir, JSON.stringify(withCookies));
    await runHost(
      dir,
      JSON.stringify({ type: "enqueue", url: "https://example.com/c" }),
    );
    const seen: JsonValue[] = [];
    const report = await drainInbox(inbox, async (raw) => {
      seen.push(raw);
      return { ok: true, data: {} };
    });
    expect(report.dropped).toEqual([]);
    expect(seen).toEqual([
      save,
      { type: "enqueue", url: "https://example.com/c" },
    ]);
    expect(await readdir(inbox)).toEqual([]);
  });
});
