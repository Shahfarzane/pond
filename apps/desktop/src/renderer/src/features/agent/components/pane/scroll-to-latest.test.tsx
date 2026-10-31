import { Thread } from "@pond/ui/thread";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

class ResizeObserverStub {
  observe() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it("shows the icon-only latest response control only while scrolled away from the bottom", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(
        <Thread.Conversation composer={<div>Composer</div>}>
          <p>Response</p>
        </Thread.Conversation>,
      );
    });
    const viewport = host.firstElementChild?.firstElementChild;
    if (!(viewport instanceof HTMLDivElement))
      throw new Error("Missing conversation viewport");
    const scrollTo = vi.fn();
    Object.defineProperties(viewport, {
      scrollHeight: { configurable: true, value: 600 },
      clientHeight: { configurable: true, value: 200 },
      scrollTop: { configurable: true, value: 400, writable: true },
      scrollTo: { configurable: true, value: scrollTo },
    });

    await act(async () => viewport.dispatchEvent(new Event("scroll")));
    expect(
      host.querySelector('[aria-label="Read Latest Response"]'),
    ).toBeNull();

    viewport.scrollTop = 300;
    await act(async () => viewport.dispatchEvent(new Event("scroll")));
    const latest = host.querySelector('[aria-label="Read Latest Response"]');
    if (!(latest instanceof HTMLButtonElement))
      throw new Error("Missing latest response control");
    expect(latest.textContent).toBe("");

    await act(async () => latest.click());
    expect(scrollTo).toHaveBeenCalledWith({ top: 600, behavior: "smooth" });

    viewport.scrollTop = 390;
    await act(async () => viewport.dispatchEvent(new Event("scroll")));
    expect(
      host.querySelector('[aria-label="Read Latest Response"]'),
    ).toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
