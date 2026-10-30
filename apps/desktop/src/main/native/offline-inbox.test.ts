import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@pond/schema/json";
import type { NativeResponse } from "@pond/schema/native";
import { describe, expect, it, vi } from "vitest";
import { drainInbox, startOfflineInbox } from "./offline-inbox";

const capture = (id: string) => ({
  type: "capture.accept",
  draft: { id, items: [{ kind: "url", url: `https://example.com/${id}` }] },
});

const json = (value: JsonValue) => JSON.stringify(value);

async function inbox(files: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "pond-inbox-"));
  for (const [name, text] of Object.entries(files)) {
    await writeFile(join(root, name), text);
  }
  return root;
}

function recorder(response: NativeResponse = { ok: true, data: {} }) {
  const seen: JsonValue[] = [];
  const dispatch = async (raw: JsonValue) => {
    seen.push(raw);
    return response;
  };
  return { seen, dispatch };
}

describe("drainInbox", () => {
  it("dispatches saves oldest first and deletes them", async () => {
    const root = await inbox({
      "1793356974817-2.json": json(capture("second")),
      "1793356974731-1.json": json(capture("first")),
      "1793356975000-3.json": json({
        type: "enqueue",
        url: "https://example.com",
      }),
    });
    const { seen, dispatch } = recorder();
    const report = await drainInbox(root, dispatch);
    expect(seen).toEqual([
      capture("first"),
      capture("second"),
      { type: "enqueue", url: "https://example.com" },
    ]);
    expect(report.dispatched).toEqual([
      "1793356974731-1.json",
      "1793356974817-2.json",
      "1793356975000-3.json",
    ]);
    expect(await readdir(root)).toEqual([]);
  });

  it("never passes cookies on, even when a file kept them", async () => {
    const root = await inbox({
      "1793356974731-1.json": json({
        ...capture("c1"),
        cookies: [{ name: "sid", value: "secret" }],
      }),
    });
    const { seen, dispatch } = recorder();
    await drainInbox(root, dispatch);
    expect(seen).toEqual([capture("c1")]);
  });

  it("deletes files that are not a readable save without dispatching them", async () => {
    const root = await inbox({
      "1793356974731-1.json": "{not json",
      "1793356974732-2.json": json([capture("array")]),
      "1793356974733-3.json": json({
        type: "files.import",
        paths: ["/etc/hosts"],
      }),
      "1793356974734-4.json": json({ type: "session.import", cookies: [] }),
      "1793356974735-5.json": json(capture("kept")),
    });
    const { seen, dispatch } = recorder();
    const report = await drainInbox(root, dispatch);
    expect(seen).toEqual([capture("kept")]);
    expect(report.dropped).toHaveLength(4);
    expect(await readdir(root)).toEqual([]);
  });

  it("leaves temp files, other names, and folders alone", async () => {
    const root = await inbox({
      ".1793356974731-1.tmp": json(capture("writing")),
      "notes.json": json(capture("stray")),
    });
    await mkdir(join(root, "1793356974732-2.json"));
    const { seen, dispatch } = recorder();
    const report = await drainInbox(root, dispatch);
    expect(seen).toEqual([]);
    expect(report).toEqual({ dispatched: [], dropped: [] });
    expect((await readdir(root)).sort()).toEqual([
      ".1793356974731-1.tmp",
      "1793356974732-2.json",
      "notes.json",
    ]);
  });

  it.skipIf(process.platform === "win32")(
    "does not follow a link out of the inbox, and removes only the link",
    async () => {
      const outside = await inbox({ "secret.json": json(capture("outside")) });
      const root = await inbox();
      await symlink(
        join(outside, "secret.json"),
        join(root, "1793356974731-1.json"),
      );
      const { seen, dispatch } = recorder();
      const report = await drainInbox(root, dispatch);
      expect(seen).toEqual([]);
      expect(report.dropped).toEqual(["1793356974731-1.json"]);
      expect(await readdir(root)).toEqual([]);
      expect(existsSync(join(outside, "secret.json"))).toBe(true);
    },
  );

  it("deletes a save Pond answered with an error, so it is not retried forever", async () => {
    const root = await inbox({ "1793356974731-1.json": json(capture("c1")) });
    const { dispatch } = recorder({ ok: false, error: "unsupported_url" });
    const report = await drainInbox(root, dispatch);
    expect(report.dispatched).toEqual(["1793356974731-1.json"]);
    expect(await readdir(root)).toEqual([]);
  });

  it("keeps a save whose dispatch threw for the next drain", async () => {
    const root = await inbox({ "1793356974731-1.json": json(capture("c1")) });
    const report = await drainInbox(root, async () => {
      throw new Error("library not ready");
    });
    expect(report).toEqual({ dispatched: [], dropped: [] });
    expect(await readdir(root)).toEqual(["1793356974731-1.json"]);
  });

  it("does nothing when the inbox does not exist", async () => {
    const { seen, dispatch } = recorder();
    await expect(
      drainInbox(join(tmpdir(), "pond-inbox-missing", "Inbox"), dispatch),
    ).resolves.toEqual({ dispatched: [], dropped: [] });
    expect(seen).toEqual([]);
  });
});

describe("startOfflineInbox", () => {
  it("drains at start, then picks up saves a host adds later", async () => {
    const root = join(await inbox(), "Inbox");
    await mkdir(root);
    await writeFile(
      join(root, "1793356974731-1.json"),
      json(capture("before")),
    );
    const { seen, dispatch } = recorder();
    const stop = await startOfflineInbox({ path: root, dispatch });
    try {
      await vi.waitFor(() => expect(seen).toEqual([capture("before")]));
      await writeFile(
        join(root, ".1793356974800-2.tmp"),
        json(capture("after")),
      );
      await rename(
        join(root, ".1793356974800-2.tmp"),
        join(root, "1793356974800-2.json"),
      );
      await vi.waitFor(
        () => expect(seen).toEqual([capture("before"), capture("after")]),
        { timeout: 3000, interval: 50 },
      );
      await vi.waitFor(async () => expect(await readdir(root)).toEqual([]));
    } finally {
      stop();
    }
  });

  it("creates the inbox when no host has written one yet", async () => {
    const root = join(await inbox(), "Pond", "Inbox");
    const stop = await startOfflineInbox({
      path: root,
      dispatch: recorder().dispatch,
    });
    stop();
    expect(existsSync(root)).toBe(true);
  });
});
