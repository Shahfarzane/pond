import { describe, expect, it } from "vitest";
import {
  isInterstitial,
  looksLikeAuthWall,
  type MainFrameStatus,
  waitPastBotCheck,
} from "./navigation";

/** A main frame that commits the given statuses one after another, each `gapMs` apart. */
function mainFrame(statuses: number[], gapMs = 10): MainFrameStatus {
  let current = statuses[0] ?? 0;
  const waiters = new Set<(navigated: boolean) => void>();
  statuses.slice(1).forEach((status, index) => {
    setTimeout(
      () => {
        current = status;
        for (const wake of waiters) wake(true);
        waiters.clear();
      },
      gapMs * (index + 1),
    );
  });
  return {
    current: () => current,
    nextNavigation: (timeoutMs) =>
      new Promise((resolve) => {
        const timer = setTimeout(() => {
          waiters.delete(wake);
          resolve(false);
        }, timeoutMs);
        const wake = (navigated: boolean) => {
          clearTimeout(timer);
          resolve(navigated);
        };
        waiters.add(wake);
      }),
    stop: () => {},
  };
}

describe("waitPastBotCheck", () => {
  it("returns at once for a page that loaded", async () => {
    const loaded: MainFrameStatus = {
      current: () => 200,
      nextNavigation: () => Promise.reject(new Error("should not wait")),
      stop: () => {},
    };
    expect(await waitPastBotCheck(loaded, 1_000)).toBe(200);
  });

  it("waits for a bot check to reload into the page", async () => {
    expect(await waitPastBotCheck(mainFrame([403, 200]), 1_000)).toBe(200);
  });

  it("follows a check that takes more than one reload", async () => {
    expect(await waitPastBotCheck(mainFrame([503, 403, 200]), 1_000)).toBe(200);
  });

  it("gives up with the check's status when it never passes", async () => {
    expect(await waitPastBotCheck(mainFrame([403]), 50)).toBe(403);
  });

  it("leaves a plain missing page alone", async () => {
    expect(await waitPastBotCheck(mainFrame([404, 200]), 1_000)).toBe(404);
  });
});

describe("looksLikeAuthWall", () => {
  it("catches Vimeo and Dribbble sign-in pages", () => {
    expect(looksLikeAuthWall("https://vimeo.com/log_in")).toBe(true);
    expect(looksLikeAuthWall("https://dribbble.com/session/new")).toBe(true);
    expect(looksLikeAuthWall("https://dribbble.com/signups/new")).toBe(true);
  });

  it("leaves content pages alone", () => {
    expect(looksLikeAuthWall("https://dribbble.com/simplebits/likes")).toBe(
      false,
    );
  });
});

describe("isInterstitial", () => {
  it("spots the Anubis proof-of-work page", () => {
    expect(
      isInterstitial(
        "https://unsplash.com/.within.website/?redir=%2Fbookmarks",
      ),
    ).toBe(true);
    expect(isInterstitial("https://unsplash.com/bookmarks")).toBe(false);
  });
});
