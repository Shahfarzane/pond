import { describe, expect, it } from "vitest";
import { type CrawlResult, crawlWithCookieFallback } from "./archive-page";

function crawlResult(overrides: Partial<CrawlResult>): CrawlResult {
  return {
    pages: [],
    warcBytes: Buffer.alloc(0),
    landedOnSignIn: false,
    ...overrides,
  };
}

const PAGE = { url: "https://site.test/", title: "Site" };

/** Records which crawls ran and answers each from the given results. */
function crawler(results: { withCookies: CrawlResult; without: CrawlResult }) {
  const calls: boolean[] = [];
  const crawl = async (withCookies: boolean) => {
    calls.push(withCookies);
    return withCookies ? results.withCookies : results.without;
  };
  return { calls, crawl };
}

describe("crawlWithCookieFallback", () => {
  it("crawls again without the tab's cookies when they led to a sign-in page", async () => {
    const without = crawlResult({ pages: [PAGE] });
    const { calls, crawl } = crawler({
      withCookies: crawlResult({ landedOnSignIn: true }),
      without,
    });

    expect(await crawlWithCookieFallback(true, crawl)).toBe(without);
    expect(calls).toEqual([true, false]);
  });

  it("keeps the signed-in crawl when it captured the page", async () => {
    const withCookies = crawlResult({ pages: [PAGE] });
    const { calls, crawl } = crawler({
      withCookies,
      without: crawlResult({}),
    });

    expect(await crawlWithCookieFallback(true, crawl)).toBe(withCookies);
    expect(calls).toEqual([true]);
  });

  it("leaves other failures to the task retry", async () => {
    const withCookies = crawlResult({});
    const { calls, crawl } = crawler({
      withCookies,
      without: crawlResult({ pages: [PAGE] }),
    });

    expect(await crawlWithCookieFallback(true, crawl)).toBe(withCookies);
    expect(calls).toEqual([true]);
  });

  it("crawls once when the save brought no cookies", async () => {
    const { calls, crawl } = crawler({
      withCookies: crawlResult({}),
      without: crawlResult({ landedOnSignIn: true }),
    });

    await crawlWithCookieFallback(false, crawl);
    expect(calls).toEqual([false]);
  });
});
