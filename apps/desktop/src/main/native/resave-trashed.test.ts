import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CaptureReceipt } from "@pond/schema/capture";
import { saves } from "@pond/schema/db";
import type { NativeResponse } from "@pond/schema/native";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { app } from "electron";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { executeBatch } from "../core/executor";
import { enqueue } from "../core/pipeline/enqueue";
import { closeDb, getDb } from "../db";
import { invalidatePaths, resolvePaths } from "../paths";
import { liveNativePorts } from "./ports";
import { dispatchNative } from "./rpc";

function nativeSqliteAvailable(): boolean {
  try {
    new Database(":memory:").close();
    return true;
  } catch (error) {
    if (process.versions.electron) throw error;
    return false;
  }
}

const PAGE = "https://example.com/articles/trash-resave";

async function row(id: string) {
  const db = await getDb();
  return db.select().from(saves).where(eq(saves.id, id)).get();
}

async function trash(id: string) {
  await executeBatch([
    {
      kind: "trash",
      model: "save",
      id,
      meta: { actor: "user", actorReason: "test:trash" },
    },
  ]);
}

/** The extension's Save Page sends `capture.accept`, then polls `capture.status` until it settles. */
async function savePageFromExtension(
  draftId: string,
  tags: string[] = [],
): Promise<CaptureReceipt> {
  const ports = liveNativePorts();
  const accepted: NativeResponse = await dispatchNative(
    {
      type: "capture.accept",
      draft: {
        id: draftId,
        trigger: "action",
        items: [{ kind: "url", url: PAGE, title: "Trash resave" }],
        metadata: { tags, folderIds: [] },
      },
    },
    ports,
  );
  expect(accepted.ok).toBe(true);
  for (let attempt = 0; attempt < 200; attempt++) {
    const status = await dispatchNative(
      { type: "capture.status", id: draftId },
      ports,
    );
    if (!status.ok) throw new Error(`capture.status failed: ${status.error}`);
    /** SAFETY: `capture.status` answers with the queue's CaptureReceipt. */
    const receipt = status.data as CaptureReceipt;
    if (receipt.state !== "accepted" && receipt.state !== "processing")
      return receipt;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("capture never settled");
}

describe.skipIf(!nativeSqliteAvailable())(
  "re-saving a Save that is in Trash",
  () => {
    let dir = "";

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "pond-trash-resave-"));
      vi.spyOn(app, "getPath").mockReturnValue(dir);
      invalidatePaths();
      resolvePaths(join(dir, "Trash Resave.pond"));
    });

    afterAll(() => {
      closeDb();
      vi.restoreAllMocks();
      invalidatePaths();
      rmSync(dir, { recursive: true, force: true });
    });

    it("brings the page back to the Library when the extension saves it again", async () => {
      const first = await savePageFromExtension("first-save");
      expect(first).toMatchObject({ state: "complete", duplicateCount: 0 });
      const [saveId] = first.saveIds;
      if (!saveId) throw new Error("first save returned no Save");

      await trash(saveId);
      expect((await row(saveId))?.deletedAt).toBeInstanceOf(Date);

      const again = await savePageFromExtension("save-again", ["resaved"]);

      expect(again.state).toBe("complete");
      const answered = await row(again.saveIds[0] ?? "");
      expect(answered?.tags).toContain("resaved");
      expect(answered?.deletedAt ?? null).toBeNull();
    });

    it("brings a pasted link back to the Library when it is in Trash", async () => {
      const url = "https://example.com/articles/trash-resave-paste";
      const first = await enqueue(url, { trigger: "user:quickAdd" });
      expect(first.created).toBe(true);
      await trash(first.id);

      const again = await enqueue(url, { trigger: "user:quickAdd" });

      expect((await row(again.id))?.deletedAt ?? null).toBeNull();
    });

    it("keeps a Save in Trash when an account sync lists it again", async () => {
      const url = "https://example.com/articles/trash-resave-sync";
      const first = await enqueue(url, { trigger: "user:quickAdd" });
      await trash(first.id);

      const again = await enqueue(url, { trigger: "sync:twitter" });

      expect(again).toEqual({ id: first.id, created: false });
      expect((await row(first.id))?.deletedAt).toBeInstanceOf(Date);
    });
  },
);
