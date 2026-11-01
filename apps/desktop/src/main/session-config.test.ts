import { describe, expect, it } from "vitest";
import { grantsPermission, productionResponseHeaders } from "./session-config";

describe("grantsPermission", () => {
  const appRequest = {
    permission: "fullscreen",
    isMainFrame: true,
    requestingUrl:
      "file:///Applications/Pond.app/Contents/Resources/app.asar/out/renderer/index.html",
    rendererUrl: undefined,
  };

  it.each([
    appRequest,
    {
      ...appRequest,
      requestingUrl: "http://localhost:5173/index.html",
      rendererUrl: "http://localhost:5173",
    },
  ])(
    "lets Pond's renderer enter full screen from $requestingUrl",
    (request) => {
      expect(grantsPermission(request)).toBe(true);
    },
  );

  it.each([
    { ...appRequest, permission: "media" },
    { ...appRequest, permission: "notifications" },
    { ...appRequest, isMainFrame: false },
    { ...appRequest, requestingUrl: "https://x.com/home" },
    { ...appRequest, requestingUrl: "pond://replay/index.html" },
    { ...appRequest, requestingUrl: "http://localhost:5173/index.html" },
  ])("denies %o", (request) => {
    expect(grantsPermission(request)).toBe(false);
  });
});

describe("productionResponseHeaders", () => {
  it("replaces the CSP on file:// documents without enabling cross-origin isolation", () => {
    const headers = productionResponseHeaders(
      "file:///Applications/Pond.app/Contents/Resources/app.asar/out/renderer/index.html",
      { "content-security-policy": ["default-src *"] },
    );

    expect(Object.keys(headers ?? {})).toStrictEqual([
      "Content-Security-Policy",
    ]);
  });

  it("isolates http documents", () => {
    const headers = productionResponseHeaders("https://example.com/", {
      "Content-Type": ["text/html"],
    });

    expect(headers).toMatchObject({
      "Content-Type": ["text/html"],
      "Cross-Origin-Opener-Policy": ["same-origin"],
      "Cross-Origin-Embedder-Policy": ["credentialless"],
    });
  });

  it("leaves pond:// responses untouched", () => {
    const original = { "Content-Type": ["text/html"] };

    expect(
      productionResponseHeaders("pond://archive/index.html", original),
    ).toBe(original);
  });
});
