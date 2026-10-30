/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { onMessage } from "@/utils/messaging";
import type { ProbeResult } from "@/utils/probe";
import { App } from ".";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement;
let root: Root;
let stopProbe: () => void = () => {};

beforeEach(async () => {
  fakeBrowser.reset();
  /** The fake browser leaves `commands` unimplemented; the popup only lists shortcuts. */
  vi.spyOn(fakeBrowser.commands, "getAll").mockImplementation(async () => []);
  /** `@webext-core/messaging` reaches the browser through the `chrome` global. */
  vi.stubGlobal("chrome", fakeBrowser);
  /** jsdom has no media queries; the popup reads one to pick light or dark. */
  vi.stubGlobal("matchMedia", (media: string) => ({
    matches: false,
    media,
    addEventListener() {},
    removeEventListener() {},
  }));
  const focused = await fakeBrowser.windows.create({ focused: true });
  await fakeBrowser.tabs.create({
    windowId: focused?.id,
    url: "https://example.com/page",
    active: true,
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  stopProbe();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function open(result: ProbeResult): Promise<void> {
  stopProbe = onMessage("probe", () => result);
  await act(async () => root.render(<App />));
  await vi.waitFor(() =>
    expect(
      container.querySelector('[aria-label="Connecting to Pond"]'),
    ).toBeNull(),
  );
}

function button(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(label),
  );
}

it("lets you save while Pond is closed, and says when it will finish", async () => {
  await open({ state: "offline", reason: "offline" });
  expect(container.textContent).toContain(
    "Pond is closed. Saves will finish the next time it opens.",
  );
  expect(container.textContent).not.toContain("Pond isn't running");
  expect(button("Save Page")?.disabled).toBe(false);
});

it("still stops at setup when the browser can't reach Pond at all", async () => {
  await open({ state: "offline", reason: "host_missing" });
  expect(container.textContent).toContain("Pond isn't set up for this browser");
  expect(button("Save Page")).toBeUndefined();
});

it("shows no notice when Pond is running", async () => {
  await open({ state: "connected", library: { name: "Pond" } });
  expect(container.textContent).not.toContain("Pond is closed");
  expect(button("Save Page")?.disabled).toBe(false);
});
