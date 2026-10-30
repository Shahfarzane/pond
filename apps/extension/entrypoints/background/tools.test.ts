import type { CaptureReceipt } from "@pond/schema/capture";
import {
  type NativeRequest,
  type NativeResponse,
  nativeRequestSchema,
} from "@pond/schema/native";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { runTool } from "./tools";

/** Pond is closed: its native host keeps saves in the inbox and has nothing to read. */
function closedPond(request: NativeRequest): NativeResponse {
  return request.type === "capture.accept" || request.type === "enqueue"
    ? { ok: true, data: { queued: true } }
    : { ok: false, error: "offline" };
}

/** Pond is running and finishes the save straight away. */
function runningPond(request: NativeRequest): NativeResponse {
  if (request.type !== "capture.accept") return { ok: false, error: "invalid" };
  const receipt: CaptureReceipt = {
    id: request.draft.id,
    library: "Pond",
    state: "complete",
    completed: 1,
    total: 1,
    saveIds: ["s1"],
    duplicateCount: 0,
  };
  return { ok: true, data: receipt };
}

let sent: NativeRequest[] = [];

function useHost(answer: (request: NativeRequest) => NativeResponse) {
  vi.spyOn(fakeBrowser.runtime, "sendNativeMessage").mockImplementation(
    async (_host, message) => {
      const request = nativeRequestSchema.parse(message);
      sent.push(request);
      return answer(request);
    },
  );
}

/** Read back through `browser`, as the background's `runTool` message handler does. */
async function webTab() {
  const focused = await fakeBrowser.windows.create({ focused: true });
  const created = await fakeBrowser.tabs.create({
    windowId: focused?.id,
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    active: true,
  });
  return browser.tabs.get(created.id ?? browser.tabs.TAB_ID_NONE);
}

beforeEach(() => {
  fakeBrowser.reset();
  sent = [];
  vi.spyOn(fakeBrowser.cookies, "getAll").mockImplementation(async () => []);
  vi.spyOn(fakeBrowser.action, "setBadgeBackgroundColor").mockImplementation(
    async () => {},
  );
  vi.spyOn(fakeBrowser.action, "setBadgeTextColor").mockImplementation(
    async () => {},
  );
  /**
   * `scripting.executeScript` stays unimplemented, so the page refuses Pond's overlay,
   * as Safari does on a site the extension has not been allowed on.
   */
});

afterEach(() => {
  vi.restoreAllMocks();
});

it("tells the panel when a save it made was kept for Pond's next launch", async () => {
  useHost(closedPond);
  const result = await runTool(await webTab(), "page");
  expect(sent.map((request) => request.type)).toContain("capture.accept");
  expect(result).toEqual({ ok: true, queued: true });
});

it("lets the panel close when Pond took the save", async () => {
  useHost(runningPond);
  const result = await runTool(await webTab(), "page");
  expect(sent.map((request) => request.type)).toContain("capture.accept");
  expect(result).toEqual({ ok: true });
});
