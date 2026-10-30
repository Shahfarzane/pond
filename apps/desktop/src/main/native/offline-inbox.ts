import { watch } from "node:fs";
import { lstat, mkdir, readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { JsonObject } from "@pond/schema/json";
import log from "electron-log/main.js";
import { z } from "zod";
import { MAX_NATIVE_MSG } from "./frame";
import { liveNativePorts } from "./ports";
import { dispatchNative } from "./rpc";
import type { NativeDispatch } from "./server";

/**
 * `<13-digit epoch ms>-<suffix>.json`, as `pond-native-host.c` and
 * `SafariWebExtensionHandler.swift` name them, so sorting by name keeps the order the
 * saves were made. Hosts write a dot-prefixed temp file first, which this skips.
 */
const QUEUED_FILE = /^\d{13}-[\w-]+\.json$/;

const queuedFileSchema = z.record(z.string(), z.json());

export interface DrainReport {
  dispatched: string[];
  dropped: string[];
}

/** Only a save is accepted from the inbox, and never with cookies, even if a file kept them. */
function parseQueued(text: string): JsonObject | null {
  try {
    const parsed = queuedFileSchema.safeParse(JSON.parse(text));
    if (!parsed.success) return null;
    const { cookies: _cookies, ...request } = parsed.data;
    return request.type === "enqueue" || request.type === "capture.accept"
      ? request
      : null;
  } catch {
    return null;
  }
}

/**
 * Dispatches every save the native hosts queued while Pond was closed, oldest first, and
 * deletes each file once Pond has answered. A file that is not a readable save is deleted
 * without dispatching. A dispatch that throws keeps its file for the next drain.
 */
export async function drainInbox(
  root: string,
  dispatch: NativeDispatch,
): Promise<DrainReport> {
  const report: DrainReport = { dispatched: [], dropped: [] };
  const names = await readdir(root).catch(() => []);
  for (const name of names.filter((n) => QUEUED_FILE.test(n)).sort()) {
    const path = join(root, name);
    /** lstat does not follow links, so only a file that sits in the inbox itself is read. */
    const info = await lstat(path).catch(() => null);
    if (!info || info.isDirectory()) continue;
    const request =
      info.isFile() && info.size <= MAX_NATIVE_MSG
        ? parseQueued(await readFile(path, "utf8").catch(() => ""))
        : null;
    if (!request) {
      await unlink(path).catch(() => {});
      report.dropped.push(name);
      continue;
    }
    try {
      const response = await dispatch(request);
      if (!response.ok) {
        log.warn("[pond native] queued save failed", name, response.error);
      }
    } catch (err) {
      log.warn("[pond native] queued save kept for later", name, err);
      continue;
    }
    await unlink(path).catch(() => {});
    report.dispatched.push(name);
  }
  return report;
}

export interface OfflineInboxOpts {
  path: string;
  dispatch?: NativeDispatch;
}

/**
 * Drains the inbox now and again whenever a host adds a file, which only happens when a
 * host missed the socket, such as just before Pond bound it. Returns a stop function.
 */
export async function startOfflineInbox(
  opts: OfflineInboxOpts,
): Promise<() => void> {
  const dispatch =
    opts.dispatch ?? ((raw) => dispatchNative(raw, liveNativePorts()));
  await mkdir(opts.path, { recursive: true, mode: 0o700 });

  let running = false;
  let again = false;
  let stopped = false;
  const drain = (): void => {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    void drainInbox(opts.path, dispatch)
      .then(({ dispatched, dropped }) => {
        if (dispatched.length > 0 || dropped.length > 0) {
          log.info("[pond native] inbox drained", opts.path, {
            dispatched: dispatched.length,
            dropped: dropped.length,
          });
        }
      })
      .catch((err) => log.warn("[pond native] inbox drain failed", err))
      .finally(() => {
        running = false;
        if (!again) return;
        again = false;
        drain();
      });
  };

  /** Started before the first drain so a file written in between is not missed. */
  const watcher = watch(opts.path, (_event, filename) => {
    if (!filename || QUEUED_FILE.test(filename)) drain();
  });
  watcher.on("error", (err) =>
    log.warn("[pond native] inbox watch failed", err),
  );
  watcher.unref();
  drain();
  return () => {
    stopped = true;
    watcher.close();
  };
}
