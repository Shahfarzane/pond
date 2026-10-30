import { Toast } from "@pond/ui/toast";
import type { CaptureStatus } from "@/utils/outcome";
import type { OverlayRequest, OverlayToast } from "@/utils/overlay-messaging";
import type { Appearance } from "@/utils/paint-theme";

export type OverlayTool = Exclude<
  OverlayRequest,
  { view: "clear" } | { view: "toast" }
>;

export interface OverlayState {
  appearance: Appearance;
  tool: OverlayTool | null;
}

export interface ToastData {
  status: CaptureStatus;
  saveId?: string;
}

const TOAST_TIMEOUT_MS = 2500;

const HEADINGS = {
  sending: "Saving to Pond",
  saved: "Saved to Pond",
  duplicate: "Already in Pond",
  failed: "Couldn't save",
  offline: "Pond isn't running",
  queued: "Saved",
} satisfies Record<CaptureStatus, string>;

const HINTS = new Map([
  ["offline", "Open Pond on your computer, then try again."],
  ["queued", "Pond will finish it the next time it opens."],
]);

export type OverlayStore = ReturnType<typeof createOverlayStore>;

export function createOverlayStore() {
  let state: OverlayState = {
    appearance: { theme: null, mode: null },
    tool: null,
  };
  const listeners = new Set<() => void>();
  const toasts = Toast.createToastManager<ToastData>();
  const live = new Set<string>();

  const set = (next: Partial<OverlayState>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };

  const toast = (input: OverlayToast) => {
    const options = {
      title: HEADINGS[input.status],
      description: input.message ?? HINTS.get(input.status) ?? input.title,
      timeout: input.status === "sending" ? 0 : TOAST_TIMEOUT_MS,
      data: { status: input.status, saveId: input.saveId },
    };
    if (live.has(input.id)) {
      toasts.update(input.id, options);
      return;
    }
    live.add(input.id);
    toasts.add({
      ...options,
      id: input.id,
      onRemove: () => live.delete(input.id),
    });
  };

  return {
    toasts,
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    show(request: OverlayRequest, appearance: Appearance) {
      if (request.view === "clear") {
        toasts.close();
        set({ tool: null });
        return;
      }
      set({ appearance });
      if (request.view === "toast") {
        toast(request.toast);
        return;
      }
      set({ tool: request });
    },
    closeTool() {
      set({ tool: null });
    },
  };
}
