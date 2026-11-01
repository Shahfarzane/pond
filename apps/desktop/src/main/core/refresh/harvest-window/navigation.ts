import { setTimeout as sleep } from "node:timers/promises";
import type { BrowserWindow, WebContents } from "electron";
import log from "electron-log/main.js";

export function looksLikeAuthWall(currentUrl: string): boolean {
  try {
    const u = new URL(currentUrl);
    const p = u.pathname.toLowerCase();
    if (
      p.startsWith("/login") ||
      p.startsWith("/log-in") ||
      p.startsWith("/log_in") ||
      p.startsWith("/signin") ||
      p.startsWith("/sign-in") ||
      p.startsWith("/sign_in") ||
      p.startsWith("/signup") ||
      p.startsWith("/sign-up") ||
      p.startsWith("/session/new") ||
      p.startsWith("/register") ||
      p.startsWith("/i/flow/login") ||
      p.startsWith("/accounts/login") ||
      p.startsWith("/auth")
    ) {
      return true;
    }
    if (u.hostname.includes("accounts.google.com")) return true;
    if (u.hostname.includes("login.reddit.com")) return true;
    return false;
  } catch {
    return false;
  }
}

export function looksLikeChallenge(currentUrl: string): null | {
  kind: "challenge" | "checkpoint" | "captcha";
} {
  try {
    const u = new URL(currentUrl);
    const p = u.pathname.toLowerCase();
    const hay = `${p}?${u.search.toLowerCase()}`;
    if (p.includes("/challenge") || hay.includes("challenge")) {
      return { kind: "challenge" };
    }
    if (p.includes("/checkpoint")) return { kind: "checkpoint" };
    if (
      p.includes("/account/access") ||
      p.includes("/i/flow/consent") ||
      p.includes("/captcha") ||
      u.hostname.includes("funcaptcha") ||
      u.hostname.includes("arkoselabs")
    ) {
      return { kind: "captcha" };
    }
    return null;
  } catch {
    return null;
  }
}

export async function navigateWithTimeout(
  win: BrowserWindow,
  url: string,
  timeoutMs: number,
): Promise<boolean> {
  const wc = win.webContents;
  const finished = new Promise<boolean>((resolve) => {
    const onDone = () => {
      cleanup();
      resolve(true);
    };
    const onFail = (
      _e: Electron.Event,
      code: number,
      desc: string,
      failedUrl: string,
      isMainFrame: boolean,
    ) => {
      if (!isMainFrame || code === -3) return;
      log.info("[pond scrape] nav load failed", { code, desc, failedUrl });
      cleanup();
      resolve(false);
    };
    const cleanup = () => {
      wc.off("did-finish-load", onDone);
      wc.off("did-fail-load", onFail);
    };
    wc.once("did-finish-load", onDone);
    wc.on("did-fail-load", onFail);
  });

  /** loadURL can hang on stalled hosts; race the whole nav against a timeout and stop on miss. */
  const navPromise = (async () => {
    try {
      await wc.loadURL(url);
    } catch (err) {
      if (err instanceof Error && err.message.includes("ERR_ABORTED")) {
        return finished;
      }
      log.info("[pond scrape] loadURL rejected", {
        url,
        err: err instanceof Error ? err.message : String(err),
      });
      return false as const;
    }
    return finished;
  })();
  const TIMEOUT = Symbol("nav-timeout");
  const result = await Promise.race([
    navPromise,
    sleep(timeoutMs).then(() => TIMEOUT),
  ]);
  if (result === TIMEOUT) {
    try {
      wc.stop();
    } catch {}
    return false;
  }
  return result === true;
}

/** Anubis serves its proof-of-work page here, then redirects back once the browser solves it. */
export function isInterstitial(currentUrl: string): boolean {
  try {
    return new URL(currentUrl).pathname.startsWith("/.within.website");
  } catch {
    return false;
  }
}

export async function waitPastInterstitial(
  win: BrowserWindow,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!win.isDestroyed() && isInterstitial(win.webContents.getURL())) {
    if (Date.now() > deadline) return false;
    await sleep(250);
  }
  return !win.isDestroyed();
}

/** Cloudflare-style checks answer the first load with one of these and a script that reloads the page once the browser passes. */
const BOT_CHECK_STATUSES = new Set([403, 503]);

/** The HTTP status of a window's main frame, followed across reloads. */
export interface MainFrameStatus {
  /** Status of the latest main-frame navigation; 0 before the first. */
  current(): number;
  /** Resolves true at the next main-frame navigation, false when none comes within timeoutMs. */
  nextNavigation(timeoutMs: number): Promise<boolean>;
  stop(): void;
}

export function watchMainFrameStatus(wc: WebContents): MainFrameStatus {
  let status = 0;
  const waiters = new Set<(navigated: boolean) => void>();
  const wakeAll = (navigated: boolean) => {
    for (const wake of waiters) wake(navigated);
    waiters.clear();
  };
  const onNavigate = (
    _event: Electron.Event,
    _url: string,
    httpResponseCode: number,
  ) => {
    status = httpResponseCode;
    wakeAll(true);
  };
  wc.on("did-navigate", onNavigate);
  return {
    current: () => status,
    nextNavigation: (timeoutMs) =>
      new Promise((resolve) => {
        const timer = setTimeout(
          () => {
            waiters.delete(wake);
            resolve(false);
          },
          Math.max(0, timeoutMs),
        );
        const wake = (navigated: boolean) => {
          clearTimeout(timer);
          resolve(navigated);
        };
        waiters.add(wake);
      }),
    stop: () => {
      wc.off("did-navigate", onNavigate);
      wakeAll(false);
    },
  };
}

/** A bot check keeps the URL and only the status gives it away, so isInterstitial can't see it. Returns the status the page settled on. */
export async function waitPastBotCheck(
  frame: MainFrameStatus,
  timeoutMs: number,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (BOT_CHECK_STATUSES.has(frame.current())) {
    const remaining = deadline - Date.now();
    if (remaining <= 0 || !(await frame.nextNavigation(remaining))) break;
  }
  return frame.current();
}
