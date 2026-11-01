import { createHash } from "node:crypto";
import { once } from "node:events";
import { createWriteStream, type WriteStream } from "node:fs";
import type { JsonObject, JsonValue } from "@pond/schema/json";
import type { WebContents } from "electron";
import log from "electron-log/main.js";
import { WARCRecord, WARCSerializer } from "warcio";
import { z } from "zod";
import { readResponseBodyWithinBudget } from "../../../lib/response-body";

const MAX_BODY_BYTES = 30 * 1024 * 1024;
const MAX_TOTAL_BYTES = 250 * 1024 * 1024;
/** CDP commands can hang forever on a wedged window; a hung getResponseBody would otherwise stall the crawl into the watchdog. */
const CDP_TIMEOUT_MS = 10_000;
const FLUSH_BUDGET_MS = 15_000;
const FULL_BODY_TIMEOUT_MS = 30_000;
/** Full bodies share one archive budget, so reads are serialized to avoid buffering the same remaining bytes concurrently. */
const FULL_BODY_CONCURRENCY = 1;
/**
 * Network.getResponseBody loses bodies for the document and parse-time subresources across the navigation process swap; pausing those responses captures them where they're guaranteed available.
 * Only these four types lose bodies retrievably; Electron rejects Manifest/Prefetch as filter types, and wider interception overloads the debugger bridge (segfaults observed).
 */
const INTERCEPTED_TYPES = ["Document", "Stylesheet", "Script", "Font"];
/** Cross-site iframes and workers report their traffic only to their own DevTools session, never to the page's. */
const RECORDED_TARGET_TYPES = new Set(["iframe", "worker"]);

export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    promise.catch(() => {});
  }
}

type CdpEventListener = (
  method: string,
  params: JsonValue,
  sessionId: string | undefined,
) => void;

/** The parts of a WebContents the recorder drives, so tests can stand in for Chromium. */
export interface CdpTarget {
  attach(): void;
  detach(): void;
  send(
    method: string,
    params?: JsonObject,
    sessionId?: string,
  ): Promise<JsonValue>;
  onEvent(listener: CdpEventListener): () => void;
  fetch(url: string, init: { signal: AbortSignal }): Promise<Response>;
}

export function cdpTargetFor(wc: WebContents): CdpTarget {
  const dbg = wc.debugger;
  return {
    attach: () => {
      if (!dbg.isAttached()) dbg.attach("1.3");
    },
    detach: () => dbg.detach(),
    send: (method, params, sessionId) =>
      dbg.sendCommand(method, params ?? {}, sessionId),
    onEvent: (listener) => {
      const onMessage = (
        _event: Electron.Event,
        method: string,
        params: JsonValue,
        sessionId: string,
      ) => {
        /** Electron reports the page's own session as "". */
        listener(method, params, sessionId || undefined);
      };
      dbg.on("message", onMessage);
      return () => dbg.off("message", onMessage);
    },
    fetch: (url, init) => wc.session.fetch(url, init),
  };
}

const CdpResponseSchema = z.object({
  url: z.string(),
  status: z.number(),
  statusText: z.string(),
  headers: z.record(z.string(), z.string()),
});

type CdpResponse = z.infer<typeof CdpResponseSchema>;

/** Lenient past the URL: a paused request whose event fails to parse would never be resumed. */
const CdpRequestSchema = z.object({
  url: z.string(),
  method: z.string().catch("GET"),
  headers: z.record(z.string(), z.string()).catch({}),
  postData: z.string().optional().catch(undefined),
  hasPostData: z.boolean().optional().catch(undefined),
});

type CdpRequest = z.infer<typeof CdpRequestSchema>;

const ResponseReceivedSchema = z.object({
  requestId: z.string(),
  response: CdpResponseSchema,
});

const RequestWillBeSentSchema = z.object({
  requestId: z.string(),
  request: CdpRequestSchema,
  redirectResponse: CdpResponseSchema.optional(),
});

const RequestIdSchema = z.object({ requestId: z.string() });

const FetchRequestPausedSchema = z.object({
  requestId: z.string(),
  request: CdpRequestSchema,
  responseStatusCode: z.number().optional(),
  responseStatusText: z.string().optional(),
  responseHeaders: z
    .array(z.object({ name: z.string(), value: z.string() }))
    .optional(),
});

type FetchRequestPaused = z.infer<typeof FetchRequestPausedSchema>;

const AttachedToTargetSchema = z.object({
  sessionId: z.string(),
  targetInfo: z.object({ type: z.string() }),
});

const CdpBodySchema = z.object({
  body: z.string(),
  base64Encoded: z.boolean(),
});

const PostDataSchema = z.object({ postData: z.string() });

/** A non-GET request, kept so replay can tell apart calls that share one URL. */
interface RecordedRequest {
  method: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

interface PendingRecord {
  key: string;
  meta: CdpResponse;
  body: Uint8Array;
  request: RecordedRequest | null;
}

function isArchivableUrl(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://");
}

/** Each iframe and worker session numbers its requests on its own. */
function requestKey(sessionId: string | undefined, requestId: string): string {
  return `${sessionId ?? ""}|${requestId}`;
}

function toRecordedRequest(
  request: CdpRequest | undefined,
  postData = request?.postData,
): RecordedRequest | null {
  if (!request || request.method === "GET") return null;
  return {
    method: request.method,
    headers: request.headers,
    body: new Uint8Array(Buffer.from(postData ?? "", "utf8")),
  };
}

/** GETs replay by URL alone; other methods replay by URL and body, so two GraphQL POSTs to one endpoint keep their own answers. */
function recordKey(url: string, request: RecordedRequest | null): string {
  if (!request) return url;
  const digest = createHash("sha256").update(request.body).digest("hex");
  return `${request.method} ${url} ${digest}`;
}

/**
 * CDP returns decoded bodies, so encoding/length headers would lie after re-serialization.
 */
const DROPPED_HEADERS = new Set([
  "content-encoding",
  "transfer-encoding",
  "content-length",
]);

function toHttpHeaders(
  raw: Record<string, string>,
  bodyLength: number,
): [string, string][] {
  const entries: [string, string][] = [];
  for (const [name, value] of Object.entries(raw)) {
    if (DROPPED_HEADERS.has(name.toLowerCase())) continue;
    /** CDP folds duplicate headers into one \n-joined value. */
    for (const part of value.split("\n")) {
      entries.push([name, part]);
    }
  }
  entries.push(["Content-Length", String(bodyLength)]);
  return entries;
}

function requestRecord(
  url: string,
  request: RecordedRequest,
  response: WARCRecord,
): WARCRecord {
  const target = new URL(url);
  const warcHeaders: Record<string, string> = {};
  const responseId = response.warcHeader("WARC-Record-ID");
  if (responseId) warcHeaders["WARC-Concurrent-To"] = responseId;
  return WARCRecord.create(
    {
      url,
      date: response.warcDate ?? new Date().toISOString(),
      type: "request",
      warcVersion: "WARC/1.1",
      statusline: `${request.method} ${target.pathname}${target.search} HTTP/1.1`,
      httpHeaders: toHttpHeaders(request.headers, request.body.byteLength),
      warcHeaders,
    },
    [request.body],
  );
}

export class WarcRecorder {
  private readonly target: CdpTarget;
  private readonly stream: WriteStream;
  private readonly requests = new Map<string, CdpRequest>();
  private readonly responses = new Map<string, CdpResponse>();
  private readonly writtenKeys = new Set<string>();
  private readonly partialUrls = new Set<string>();
  private readonly pending = new Set<Promise<void>>();
  private writeChain: Promise<void> = Promise.resolve();
  private totalBytes = 0;
  private reservedBytes = 0;
  private attached = false;
  private lastNetworkActivity = Date.now();
  private stopListening: () => void = () => {};

  private constructor(target: CdpTarget, filePath: string) {
    this.target = target;
    this.stream = createWriteStream(filePath);
  }

  static async start(
    target: CdpTarget,
    filePath: string,
  ): Promise<WarcRecorder> {
    const recorder = new WarcRecorder(target, filePath);
    target.attach();
    recorder.attached = true;
    recorder.stopListening = target.onEvent(recorder.onEvent);
    try {
      await recorder.enableCapture(undefined);
    } catch (err) {
      recorder.stopListening();
      try {
        target.detach();
      } catch {}
      recorder.attached = false;
      recorder.stream.destroy();
      throw err;
    }
    try {
      await recorder.autoAttach(undefined);
    } catch (err) {
      log.warn("[pond warc] iframe and worker capture unavailable", err);
    }
    return recorder;
  }

  private command(
    method: string,
    params: JsonObject,
    sessionId: string | undefined,
  ): Promise<JsonValue> {
    return withTimeout(
      this.target.send(method, params, sessionId),
      CDP_TIMEOUT_MS,
    );
  }

  /** Turns on capture for the page, or for an auto-attached iframe or worker. */
  private async enableCapture(sessionId: string | undefined): Promise<void> {
    await this.command(
      "Network.enable",
      { maxTotalBufferSize: 200_000_000, maxResourceBufferSize: 60_000_000 },
      sessionId,
    );
    /** Cached responses have no retrievable body over CDP; forcing network keeps the capture complete. */
    await this.command(
      "Network.setCacheDisabled",
      { cacheDisabled: true },
      sessionId,
    );
    await this.command(
      "Fetch.enable",
      {
        patterns: INTERCEPTED_TYPES.map((resourceType) => ({
          requestStage: "Response",
          resourceType,
        })),
      },
      sessionId,
    );
  }

  /** Each new iframe or worker starts paused, so its first request can't slip past before capture is on. */
  private async autoAttach(sessionId: string | undefined): Promise<void> {
    await this.command(
      "Target.setAutoAttach",
      { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
      sessionId,
    );
  }

  private async attachChild(sessionId: string, type: string): Promise<void> {
    try {
      if (!RECORDED_TARGET_TYPES.has(type)) return;
      await this.enableCapture(sessionId);
      await this.autoAttach(sessionId);
    } catch (err) {
      log.debug("[pond warc] child capture setup failed", type, err);
    } finally {
      /** The target stays paused until resumed; leaving it would hang the frame or worker. */
      await this.command(
        "Runtime.runIfWaitingForDebugger",
        {},
        sessionId,
      ).catch(() => {});
    }
  }

  private track(task: Promise<void>, label: string): void {
    const tracked = task.catch((err) => {
      log.debug("[pond warc] capture failed", label, err);
    });
    this.pending.add(tracked);
    void tracked.finally(() => this.pending.delete(tracked));
  }

  private onEvent = (
    method: string,
    params: JsonValue,
    sessionId: string | undefined,
  ): void => {
    try {
      if (method.startsWith("Network.")) {
        this.lastNetworkActivity = Date.now();
      }
      if (method === "Network.responseReceived") {
        const p = ResponseReceivedSchema.parse(params);
        if (!isArchivableUrl(p.response.url)) return;
        /** A range response holds one slice of the file; replaying that slice alone leaves media undecodable. */
        if (p.response.status === 206) {
          this.partialUrls.add(p.response.url);
          return;
        }
        this.responses.set(requestKey(sessionId, p.requestId), p.response);
        return;
      }
      if (method === "Network.requestWillBeSent") {
        const p = RequestWillBeSentSchema.parse(params);
        const key = requestKey(sessionId, p.requestId);
        if (p.redirectResponse && isArchivableUrl(p.redirectResponse.url)) {
          this.enqueueWrite(
            p.redirectResponse,
            new Uint8Array(0),
            toRecordedRequest(this.requests.get(key)),
          );
        }
        this.requests.set(key, p.request);
        return;
      }
      if (method === "Network.loadingFinished") {
        const p = RequestIdSchema.parse(params);
        const key = requestKey(sessionId, p.requestId);
        const meta = this.responses.get(key);
        const request = this.requests.get(key);
        this.requests.delete(key);
        if (!meta) return;
        this.responses.delete(key);
        this.track(
          this.captureBody(sessionId, p.requestId, meta, request),
          meta.url,
        );
        return;
      }
      if (method === "Network.loadingFailed") {
        const p = RequestIdSchema.parse(params);
        const key = requestKey(sessionId, p.requestId);
        this.requests.delete(key);
        this.responses.delete(key);
        return;
      }
      if (method === "Fetch.requestPaused") {
        const p = FetchRequestPausedSchema.parse(params);
        this.track(this.capturePausedResponse(sessionId, p), p.request.url);
        return;
      }
      if (method === "Target.attachedToTarget") {
        const p = AttachedToTargetSchema.parse(params);
        this.track(
          this.attachChild(p.sessionId, p.targetInfo.type),
          p.targetInfo.type,
        );
      }
    } catch (err) {
      log.debug("[pond warc] event handling failed", method, err);
    }
  };

  /** Writes the paused response, then always resumes it; a request left paused would hang the page. */
  private async capturePausedResponse(
    sessionId: string | undefined,
    p: FetchRequestPaused,
  ): Promise<void> {
    try {
      const status = p.responseStatusCode;
      const request = toRecordedRequest(p.request);
      if (
        status != null &&
        (status < 300 || status >= 400) &&
        isArchivableUrl(p.request.url) &&
        !this.writtenKeys.has(recordKey(p.request.url, request))
      ) {
        const res = CdpBodySchema.parse(
          await this.command(
            "Fetch.getResponseBody",
            { requestId: p.requestId },
            sessionId,
          ),
        );
        const body = res.base64Encoded
          ? new Uint8Array(Buffer.from(res.body, "base64"))
          : new Uint8Array(Buffer.from(res.body, "utf8"));
        const headers: Record<string, string> = {};
        for (const h of p.responseHeaders ?? []) {
          headers[h.name] = headers[h.name]
            ? `${headers[h.name]}\n${h.value}`
            : h.value;
        }
        const meta = {
          url: p.request.url,
          status,
          statusText: p.responseStatusText ?? "",
          headers,
        };
        const lost = body.byteLength === 0 && this.expectsBody(meta);
        if (!lost && body.byteLength <= MAX_BODY_BYTES) {
          this.enqueueWrite(meta, body, request);
        }
      }
    } finally {
      try {
        await this.command(
          "Fetch.continueRequest",
          { requestId: p.requestId },
          sessionId,
        );
      } catch {}
    }
  }

  private async captureBody(
    sessionId: string | undefined,
    requestId: string,
    meta: CdpResponse,
    sent: CdpRequest | undefined,
  ): Promise<void> {
    const request = await this.recordedRequest(sessionId, requestId, sent);
    if (this.writtenKeys.has(recordKey(meta.url, request))) return;
    let body = new Uint8Array(0);
    let bodyRetrieved = false;
    try {
      const res = CdpBodySchema.parse(
        await this.command("Network.getResponseBody", { requestId }, sessionId),
      );
      body = res.base64Encoded
        ? new Uint8Array(Buffer.from(res.body, "base64"))
        : new Uint8Array(Buffer.from(res.body, "utf8"));
      bodyRetrieved = true;
    } catch {}
    if ((!bodyRetrieved || body.byteLength === 0) && this.expectsBody(meta)) {
      return;
    }
    if (body.byteLength > MAX_BODY_BYTES) return;
    this.enqueueWrite(meta, body, request);
  }

  /** Chromium leaves large request bodies out of requestWillBeSent; they have to be asked for. */
  private async recordedRequest(
    sessionId: string | undefined,
    requestId: string,
    sent: CdpRequest | undefined,
  ): Promise<RecordedRequest | null> {
    let postData = sent?.postData;
    if (
      sent &&
      sent.method !== "GET" &&
      postData === undefined &&
      sent.hasPostData
    ) {
      try {
        postData = PostDataSchema.parse(
          await this.command(
            "Network.getRequestPostData",
            { requestId },
            sessionId,
          ),
        ).postData;
      } catch {}
    }
    return toRecordedRequest(sent, postData);
  }

  private expectsBody(meta: CdpResponse): boolean {
    if (meta.status === 204 || meta.status === 205 || meta.status === 304) {
      return false;
    }
    for (const [name, value] of Object.entries(meta.headers)) {
      if (name.toLowerCase() === "content-length" && value.trim() === "0") {
        return false;
      }
    }
    return true;
  }

  private enqueueWrite(
    meta: CdpResponse,
    body: Uint8Array,
    request: RecordedRequest | null = null,
  ): void {
    const key = recordKey(meta.url, request);
    if (this.writtenKeys.has(key)) return;
    this.write({ key, meta, body, request });
  }

  private write({ key, meta, body, request }: PendingRecord): void {
    if (body.byteLength > this.remainingCaptureBudget()) return;
    this.writtenKeys.add(key);
    this.reservedBytes += body.byteLength;
    const task = this.writeChain.then(async () => {
      try {
        const response = WARCRecord.create(
          {
            url: meta.url,
            date: new Date().toISOString(),
            type: "response",
            warcVersion: "WARC/1.1",
            statusline: `HTTP/1.1 ${meta.status} ${meta.statusText || "OK"}`,
            httpHeaders: toHttpHeaders(meta.headers, body.byteLength),
          },
          [body],
        );
        /** wabac.js pairs a response with the request record right after it, and replays a non-GET by its body. */
        const records = request
          ? [response, requestRecord(meta.url, request, response)]
          : [response];
        const chunks: Uint8Array[] = [];
        for (const record of records) {
          chunks.push(await WARCSerializer.serialize(record, { gzip: true }));
        }
        const bytes = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
        if (bytes > MAX_TOTAL_BYTES - this.totalBytes) return;
        this.totalBytes += bytes;
        for (const chunk of chunks) {
          if (!this.stream.write(chunk)) {
            await once(this.stream, "drain");
          }
        }
      } finally {
        this.reservedBytes -= body.byteLength;
      }
    });
    this.writeChain = task.catch((err) => {
      log.warn("[pond warc] record write failed", meta.url, err);
    });
    this.pending.add(task);
    void task.catch(() => {}).finally(() => this.pending.delete(task));
  }

  /** Refetches range-loaded and DOM-referenced media through the page's session so each URL is stored whole. */
  async captureFullBodies(extraUrls: readonly string[] = []): Promise<void> {
    const queue = [...new Set([...this.partialUrls, ...extraUrls])].filter(
      (url) => isArchivableUrl(url) && !this.writtenKeys.has(url),
    );
    this.partialUrls.clear();
    const worker = async (): Promise<void> => {
      for (let url = queue.shift(); url; url = queue.shift()) {
        await this.captureFullBody(url).catch((err) => {
          log.debug("[pond warc] full body capture failed", url, err);
        });
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(FULL_BODY_CONCURRENCY, queue.length) },
        worker,
      ),
    );
  }

  private async captureFullBody(url: string): Promise<void> {
    if (this.writtenKeys.has(url) || this.remainingCaptureBudget() === 0)
      return;
    const res = await this.target.fetch(url, {
      signal: AbortSignal.timeout(FULL_BODY_TIMEOUT_MS),
    });
    if (res.status !== 200) {
      await res.body?.cancel();
      return;
    }
    const body = await readResponseBodyWithinBudget(
      res,
      this.remainingCaptureBudget(),
    );
    if (!body) return;
    const headers: Record<string, string> = {};
    res.headers.forEach((value, name) => {
      headers[name] = headers[name] ? `${headers[name]}\n${value}` : value;
    });
    this.enqueueWrite({ url, status: 200, statusText: "OK", headers }, body);
  }

  private remainingCaptureBudget(): number {
    return Math.max(0, MAX_TOTAL_BYTES - this.totalBytes - this.reservedBytes);
  }

  async waitForNetworkIdle(quietMs: number, budgetMs: number): Promise<void> {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
      const quietFor = Date.now() - this.lastNetworkActivity;
      if (quietFor >= quietMs && this.responses.size === 0) return;
      await new Promise((r) => setTimeout(r, Math.min(250, quietMs)));
    }
  }

  async flush(budgetMs: number = FLUSH_BUDGET_MS): Promise<void> {
    const deadline = Date.now() + budgetMs;
    while (this.pending.size > 0 && Date.now() < deadline) {
      const remaining = deadline - Date.now();
      await Promise.race([
        Promise.allSettled(this.pending),
        new Promise((r) => setTimeout(r, remaining)),
      ]);
    }
  }

  async stop(): Promise<void> {
    await this.flush();
    this.stopListening();
    if (this.attached) {
      try {
        await withTimeout(
          (async () => {
            await this.target.send("Target.setAutoAttach", {
              autoAttach: false,
              waitForDebuggerOnStart: false,
            });
            await this.target.send("Fetch.disable");
            await this.target.send("Network.setCacheDisabled", {
              cacheDisabled: false,
            });
            await this.target.send("Network.disable");
          })(),
          CDP_TIMEOUT_MS,
        );
      } catch {}
      try {
        this.target.detach();
      } catch {}
      this.attached = false;
    }
    await new Promise<void>((resolvePromise, reject) => {
      this.stream.end((err?: Error | null) =>
        err ? reject(err) : resolvePromise(),
      );
    });
  }

  get bytesWritten(): number {
    return this.totalBytes;
  }
}
