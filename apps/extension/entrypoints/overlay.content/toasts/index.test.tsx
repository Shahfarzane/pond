/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { OverlayToast } from "@/utils/overlay-messaging";
import { createOverlayStore, type OverlayStore } from "../store";
import { Toasts } from ".";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement;
let root: Root;
let store: OverlayStore;

beforeEach(async () => {
  container = document.createElement("div");
  document.body.append(container);
  store = createOverlayStore();
  root = createRoot(container);
  await act(async () =>
    root.render(<Toasts manager={store.toasts} container={container} />),
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

function show(toast: OverlayToast): Promise<void> {
  return act(async () =>
    store.show({ view: "toast", toast }, { theme: null, mode: null }),
  );
}

it("tells you a save made while Pond was closed is kept", async () => {
  await show({ id: "c1", status: "queued", title: "Example" });
  expect(container.textContent).toContain("Saved");
  expect(container.textContent).toContain(
    "Pond will finish it the next time it opens.",
  );
  expect(container.textContent).not.toContain("Pond isn't running");
  /** Nothing is in the library yet, so there is nothing to open. */
  const labels = [...container.querySelectorAll("button")].map(
    (button) => button.textContent,
  );
  expect(labels).not.toContain("Open");
});

it("turns a sending toast into the queued one in place", async () => {
  await show({ id: "c1", status: "sending", title: "Example" });
  expect(container.textContent).toContain("Saving to Pond");
  await show({ id: "c1", status: "queued", title: "Example" });
  expect(container.textContent).not.toContain("Saving to Pond");
  expect(container.textContent).toContain(
    "Pond will finish it the next time it opens.",
  );
});

it("still says Pond isn't running when the save could not be kept", async () => {
  await show({ id: "c1", status: "offline", title: "Example" });
  expect(container.textContent).toContain("Pond isn't running");
  expect(container.textContent).toContain(
    "Open Pond on your computer, then try again.",
  );
});
