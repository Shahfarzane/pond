import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonObject, JsonValue } from "@pond/schema/json";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WARCParser } from "warcio";
import { z } from "zod";
import { type CdpTarget, WarcRecorder } from "./warc-recorder";

type Listener = (
  method: string,
  params: JsonValue,
  sessionId: string | undefined,
) => void;

interface SessionState {
  network: boolean;
  autoAttach: boolean;
  /** Chromium holds an auto-attached target before its first request until the client resumes it. */
  resume?: () => void;
}

interface Resource {
  requestId: string;
  url: string;
  type: string;
  method?: string;
  postData?: string;
  /** Chromium leaves large bodies out of the event; the client must ask for them. */
  postDataOmitted?: boolean;
  status?: number;
  body?: string;
}

const PAGE = "page";
const RequestIdSchema = z.object({ requestId: z.string() });

/**
 * Models how Chromium reports traffic to a page-level DevTools session: an out-of-process iframe or a worker
 * reports nothing to the page session, only to its own auto-attached session, and bodies are only readable
 * from the session that loaded them.
 */
class FakeChromium implements CdpTarget {
  attached = false;
  readonly resumed: string[] = [];
  private readonly listeners = new Set<Listener>();
  private readonly sessions = new Map<string, SessionState>([
    [PAGE, { network: false, autoAttach: false }],
  ]);
  private readonly bodies = new Map<string, string>();
  private readonly postBodies = new Map<string, string>();

  attach(): void {
    this.attached = true;
  }

  detach(): void {
    this.attached = false;
    for (const id of this.sessions.keys()) {
      if (id !== PAGE) this.sessions.delete(id);
    }
  }

  onEvent(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async fetch(): Promise<Response> {
    return new Response(null, { status: 404 });
  }

  async send(
    method: string,
    params: JsonObject = {},
    sessionId?: string,
  ): Promise<JsonValue> {
    const key = sessionId ?? PAGE;
    const session = this.sessions.get(key);
    if (!this.attached || !session) {
      throw new Error(`No session with given id: ${key}`);
    }
    const requestId = RequestIdSchema.safeParse(params).data?.requestId ?? "";
    switch (method) {
      case "Network.enable":
        session.network = true;
        return {};
      case "Network.disable":
        session.network = false;
        return {};
      case "Target.setAutoAttach":
        session.autoAttach = params.autoAttach === true;
        return {};
      case "Runtime.runIfWaitingForDebugger":
        this.resumed.push(key);
        session.resume?.();
        return {};
      case "Network.getResponseBody": {
        const body = this.bodies.get(`${key}|${requestId}`);
        if (body === undefined) {
          throw new Error("No resource with given identifier found");
        }
        return { body, base64Encoded: false };
      }
      case "Network.getRequestPostData": {
        const postData = this.postBodies.get(`${key}|${requestId}`);
        if (postData === undefined) {
          throw new Error("No post data available for the request");
        }
        return { postData };
      }
      default:
        return {};
    }
  }

  /** Starts a cross-site iframe or worker; resolves once the client lets it run, or at once when nobody is attached to it. */
  startChild(sessionId: string, type: string): Promise<void> {
    const parent = this.sessions.get(PAGE);
    if (!parent?.autoAttach) return Promise.resolve();
    return new Promise((resolve) => {
      this.sessions.set(sessionId, {
        network: false,
        autoAttach: false,
        resume: resolve,
      });
      this.emit(
        "Target.attachedToTarget",
        {
          sessionId,
          targetInfo: { targetId: `${sessionId}-target`, type, url: "" },
          waitingForDebugger: true,
        },
        undefined,
      );
    });
  }

  /** Loads one resource in the given target; only a session with Network enabled hears about it. */
  load(target: string, resource: Resource): void {
    const session = this.sessions.get(target);
    if (!session?.network) return;
    const sessionId = target === PAGE ? undefined : target;
    const method = resource.method ?? "GET";
    const request: JsonObject = {
      url: resource.url,
      method,
      headers: method === "GET" ? {} : { "Content-Type": "application/json" },
    };
    if (resource.postData !== undefined) {
      if (resource.postDataOmitted) {
        request.hasPostData = true;
        this.postBodies.set(
          `${target}|${resource.requestId}`,
          resource.postData,
        );
      } else {
        request.postData = resource.postData;
        request.hasPostData = true;
      }
    }
    this.emit(
      "Network.requestWillBeSent",
      { requestId: resource.requestId, request, type: resource.type },
      sessionId,
    );
    this.bodies.set(`${target}|${resource.requestId}`, resource.body ?? "");
    this.emit(
      "Network.responseReceived",
      {
        requestId: resource.requestId,
        type: resource.type,
        response: {
          url: resource.url,
          status: resource.status ?? 200,
          statusText: "OK",
          headers: { "Content-Type": "text/plain" },
        },
      },
      sessionId,
    );
    this.emit(
      "Network.loadingFinished",
      { requestId: resource.requestId },
      sessionId,
    );
  }

  private emit(
    method: string,
    params: JsonObject,
    sessionId: string | undefined,
  ): void {
    for (const listener of this.listeners) listener(method, params, sessionId);
  }
}

interface ReadRecord {
  type: string;
  url: string;
  method: string | null;
  status: number | null;
  payload: string;
  concurrentTo: string | null;
  id: string | null;
}

async function readWarc(path: string): Promise<ReadRecord[]> {
  const records: ReadRecord[] = [];
  for await (const record of new WARCParser(createReadStream(path))) {
    const payload = new TextDecoder().decode(await record.readFully(false));
    records.push({
      type: record.warcType ?? "",
      url: record.warcTargetURI ?? "",
      method:
        record.warcType === "request"
          ? (record.httpHeaders?.method ?? null)
          : null,
      status: record.httpHeaders?.statusCode
        ? Number(record.httpHeaders.statusCode)
        : null,
      payload,
      concurrentTo: record.warcHeader("WARC-Concurrent-To") ?? null,
      id: record.warcHeader("WARC-Record-ID") ?? null,
    });
  }
  return records;
}

describe("WarcRecorder", () => {
  let dir: string;
  let warcPath: string;
  let chromium: FakeChromium;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pond-warc-recorder-"));
    warcPath = join(dir, "archive.warc.gz");
    chromium = new FakeChromium();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function record(
    scenario: (chromium: FakeChromium) => Promise<void>,
  ): Promise<ReadRecord[]> {
    const recorder = await WarcRecorder.start(chromium, warcPath);
    await scenario(chromium);
    await recorder.flush();
    await recorder.stop();
    return readWarc(warcPath);
  }

  const responseUrls = (records: ReadRecord[]) =>
    records.filter((r) => r.type === "response").map((r) => r.url);

  it("records what a cross-site iframe and a worker load", async () => {
    const records = await record(async (c) => {
      c.load(PAGE, {
        requestId: "1",
        url: "https://site.test/",
        type: "Document",
        body: "<iframe src=https://embed.test/frame>",
      });
      await c.startChild("frame", "iframe");
      c.load("frame", {
        requestId: "f1",
        url: "https://embed.test/frame-data.json",
        type: "Fetch",
        body: '{"ok":true}',
      });
      await c.startChild("worker", "worker");
      c.load("worker", {
        requestId: "w1",
        url: "https://site.test/worker-data.json",
        type: "Fetch",
        body: '{"worker":true}',
      });
    });

    expect(responseUrls(records)).toEqual([
      "https://site.test/",
      "https://embed.test/frame-data.json",
      "https://site.test/worker-data.json",
    ]);
    expect(chromium.resumed).toEqual(["frame", "worker"]);
  });

  it("lets targets it does not record run without capturing them", async () => {
    const records = await record(async (c) => {
      await c.startChild("sw", "service_worker");
      c.load("sw", {
        requestId: "s1",
        url: "https://site.test/sw-cache.json",
        type: "Fetch",
        body: "{}",
      });
    });

    expect(chromium.resumed).toEqual(["sw"]);
    expect(responseUrls(records)).toEqual([]);
  });

  it("keeps each answer when two POSTs share one endpoint", async () => {
    const records = await record(async (c) => {
      c.load(PAGE, {
        requestId: "q1",
        url: "https://site.test/graphql",
        type: "Fetch",
        method: "POST",
        postData: '{"query":"alpha"}',
        body: '{"answer":"first"}',
      });
      c.load(PAGE, {
        requestId: "q2",
        url: "https://site.test/graphql",
        type: "Fetch",
        method: "POST",
        postData: '{"query":"bravo"}',
        postDataOmitted: true,
        body: '{"answer":"second"}',
      });
    });

    expect(
      records.map((r) => [r.type, r.method ?? r.status, r.payload]),
    ).toEqual([
      ["response", 200, '{"answer":"first"}'],
      ["request", "POST", '{"query":"alpha"}'],
      ["response", 200, '{"answer":"second"}'],
      ["request", "POST", '{"query":"bravo"}'],
    ]);
    /** wabac.js pairs a response with the request record that follows it and replays the POST by its body. */
    expect(records[1]?.concurrentTo).toBe(records[0]?.id);
    expect(records[3]?.concurrentTo).toBe(records[2]?.id);
  });

  it("stores a GET once, without a request record", async () => {
    const records = await record(async (c) => {
      for (const requestId of ["1", "2"]) {
        c.load(PAGE, {
          requestId,
          url: "https://site.test/app.js",
          type: "Script",
          body: "console.log(1)",
        });
      }
    });

    expect(records.map((r) => r.type)).toEqual(["response"]);
  });

  it("keeps the real page when a bot check answers first", async () => {
    const records = await record(async (c) => {
      c.load(PAGE, {
        requestId: "1",
        url: "https://site.test/",
        type: "Document",
        status: 403,
        body: "Checking your browser",
      });
      c.load(PAGE, {
        requestId: "2",
        url: "https://site.test/",
        type: "Document",
        body: "The real page",
      });
    });

    expect(records.map((r) => [r.status, r.payload])).toEqual([
      [200, "The real page"],
    ]);
  });

  it("still keeps an error page that nothing replaces", async () => {
    const records = await record(async (c) => {
      c.load(PAGE, {
        requestId: "1",
        url: "https://site.test/gone",
        type: "Document",
        status: 404,
        body: "Not found",
      });
    });

    expect(records.map((r) => [r.status, r.payload])).toEqual([
      [404, "Not found"],
    ]);
  });
});
