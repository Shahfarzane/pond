import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import {
  BOT_CHECK_TIMEOUT_MS,
  NAV_TIMEOUT_MS,
} from "./harvest-window/constants";
import {
  navigateWithTimeout,
  waitPastBotCheck,
  watchMainFrameStatus,
} from "./harvest-window/navigation";
import { leaseWindow } from "./harvest-window/pool";

export { browserUserAgent } from "./harvest-window/constants";

const RENDER_SETTLE_MS = 1_500;
const RENDER_READ_TIMEOUT_MS = 10_000;
const RenderedHtmlSchema = z.string().trim().min(1);

export type RenderPageResult =
  | { ok: true; html: string; status: number }
  | { ok: false; reason: "navigation" | "read-timeout" | "empty" };

export async function renderPageHtml(
  url: string,
  signal?: AbortSignal,
): Promise<RenderPageResult> {
  const lease = await leaseWindow("web", { signal });
  const frame = watchMainFrameStatus(lease.win.webContents);
  try {
    const webContents = lease.win.webContents;
    const loaded = await navigateWithTimeout(lease.win, url, NAV_TIMEOUT_MS);
    if (!loaded) return { ok: false, reason: "navigation" };
    const status = await waitPastBotCheck(frame, BOT_CHECK_TIMEOUT_MS);
    await sleep(RENDER_SETTLE_MS);
    const html: unknown = await Promise.race([
      webContents.executeJavaScript("document.documentElement.outerHTML", true),
      sleep(RENDER_READ_TIMEOUT_MS).then(() => null),
    ]);
    if (html === null) return { ok: false, reason: "read-timeout" };
    const rendered = RenderedHtmlSchema.safeParse(html);
    return rendered.success
      ? { ok: true, html: rendered.data, status }
      : { ok: false, reason: "empty" };
  } finally {
    frame.stop();
    lease.release();
  }
}
