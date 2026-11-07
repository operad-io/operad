import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  TuiClient,
  type FetchLike,
  TuiConflictError,
  TuiNotFoundError,
  TuiPayloadTooLargeError,
  TuiRefusedError,
  TuiTimeoutError,
  TuiUnauthorizedError,
  TuiUnreachableError,
  TuiUrlError,
  discoverServer,
} from "../src/index.ts";
import {
  freePort,
  makeHarness,
  tempRoot,
  type TuiHarness,
} from "./support.ts";

function client(h: TuiHarness, token = h.token): TuiClient {
  return new TuiClient({ url: h.base, token });
}

function seed(
  h: TuiHarness,
  id: string,
  data: Record<string, unknown>,
): void {
  h.store.put("item", id, data, "seed");
}

async function addWaitingRun(h: TuiHarness, object: string): Promise<string> {
  const run = await h.log.startRun("demo-flow", object);
  await h.log.append(run.runId, 0, [
    {
      kind: "waiting_for_person",
      payload: {
        waitId: "wait:1",
        step: "ask",
        prompt: "Approve?",
        choices: ["yes"],
        waitKind: "step",
        effectId: null,
      },
      cause: "test",
    },
  ]);
  return run.runId;
}

describe("TuiClient", () => {
  test("lists the types and pages objects with the server's cursors", async () => {
    const h = await makeHarness();
    try {
      for (let index = 0; index < 105; index += 1) {
        seed(h, `item-${String(index).padStart(3, "0")}`, {
          title: `Item ${index}`,
          state: "new",
        });
      }

      expect(await client(h).types()).toEqual({
        types: [{ type: "item", title: "Item" }],
      });

      const first = await client(h).objects("item");
      expect(first.rows).toHaveLength(100);
      expect(first.rows[0]?.id).toBe("item-000");
      expect(first.rows[0]?.waiting).toBe(false);
      const next = first.next;
      expect(next).toBeDefined();
      if (next === undefined) return;

      const second = await client(h).objects("item", next);
      expect(second.rows).toHaveLength(5);
      expect(second.rows.map((row) => row.id)).toEqual([
        "item-100",
        "item-101",
        "item-102",
        "item-103",
        "item-104",
      ]);
      expect(second.next).toBeUndefined();
    } finally {
      await h.close();
    }
  });

  test("gets one object with its row, sections, actions and a URL-encoded id", async () => {
    const h = await makeHarness();
    try {
      seed(h, "one", { title: "First", state: "new", note: "$1" });
      seed(h, "odd/id", { title: "Odd", state: "new" });

      const got = await client(h).object("item:one");
      expect(got.id).toBe("one");
      expect(got.type).toBe("item");
      expect(got.link).toBe("operad://objects/item%3Aone");
      expect(got.row).toMatchObject({
        id: "one",
        title: "First",
        state: "new",
        note: "$1",
        waiting: false,
        running: false,
      });
      expect(got.sections.map((section) => section.id)).toEqual([
        "info",
        "pages",
        "hang",
        "big",
        "history",
      ]);
      expect(got.sections.at(-1)?.title).toBe("History");

      const approve = got.actions.find((action) => action.name === "tuitest:approve");
      expect(approve?.args).toBeDefined();
      expect(approve?.note).toBe("note");
      expect(approve?.noteRequired).toBe(true);
      expect(approve?.confirm).toBe(false);
      const drop = got.actions.find((action) => action.name === "tuitest:drop");
      expect(drop?.confirm).toBe(true);

      const odd = await client(h).object("odd/id");
      expect(odd.id).toBe("odd/id");
      expect(odd.row.title).toBe("Odd");

      const info = await client(h).section("item:one", "info");
      expect(info).toEqual({ markdown: "# Item\n\nSome **text**." });

      const pages = await client(h).section("item:one", "pages");
      expect(pages).toEqual({ markdown: "page one", next: "two" });
      expect(
        await client(h).section("item:one", "pages", { cursor: "two" }),
      ).toEqual({ markdown: "page two" });

      const capped = await client(h).section("item:one", "big");
      expect(capped.markdown.length).toBeLessThan(300 * 1024);
      expect(capped.markdown).toContain("[Truncated.");
      const full = await client(h).section("item:one", "big", { full: true });
      expect(full.markdown).toBe("x".repeat(300 * 1024));

      const history = await client(h).section("item:one", "history");
      expect(history.markdown).toContain("No history");
    } finally {
      await h.close();
    }
  });

  test("lists pending and running runs", async () => {
    const h = await makeHarness();
    try {
      seed(h, "waiting", { title: "Waiting", state: "new" });
      seed(h, "running", { title: "Running", state: "new" });
      const runId = await addWaitingRun(h, "item:waiting");
      await h.log.startRun("demo-flow", "item:running");

      const pending = await client(h).pending();
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        runId,
        object: "item:waiting",
        link: "operad://objects/item%3Awaiting",
        prompt: "Approve?",
        choices: ["yes"],
      });
      expect(pending[0]?.actions).toContainEqual({
        plugin: "tuitest",
        action: "approve",
      });
      // The item carries the object's row, so no read per item is needed.
      expect(pending[0]?.row).toMatchObject({
        id: "waiting",
        title: "Waiting",
        state: "new",
        waiting: true,
      });

      const running = await client(h).running();
      expect(running).toHaveLength(1);
      expect(running[0]?.flow).toBe("demo-flow");
      expect(running[0]?.elapsedMs).toBeGreaterThanOrEqual(0);
    } finally {
      await h.close();
    }
  });

  test("acts with a note, arguments and confirmation", async () => {
    const h = await makeHarness();
    try {
      seed(h, "one", { title: "First", state: "new" });

      const approve = await client(h).act({
        action: "tuitest:approve",
        id: "item:one",
        note: "looks good",
      });
      expect(approve.name).toBe("tuitest:approve");
      expect(h.store.get("item", "one")?.data.approvedNote).toBe("looks good");

      const again = await client(h).act({
        action: "tuitest:approve",
        id: "item:one",
        note: "again",
      }).catch((error: unknown) => error);
      expect(again).toBeInstanceOf(TuiConflictError);
      expect((again as TuiConflictError).status).toBe(409);
      expect((again as TuiConflictError).kind).toBe("not-available");

      await client(h).act({
        action: "tuitest:label",
        id: "item:one",
        args: { text: "reviewed", count: 2 },
      });
      expect(h.store.get("item", "one")?.data.label).toBe("reviewed");
      expect(h.store.get("item", "one")?.data.count).toBe(2);

      const refused = await client(h).act({
        action: "tuitest:drop",
        id: "item:one",
      }).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(TuiConflictError);
      const confirmError = refused as TuiConflictError;
      expect(confirmError.kind).toBe("confirm");
      expect(confirmError.message).toContain('"confirmed": true');
      expect(h.store.get("item", "one")?.data.dropped).toBeUndefined();

      await client(h).act({
        action: "tuitest:drop",
        id: "item:one",
        confirmed: true,
      });
      expect(h.store.get("item", "one")?.data.dropped).toBe(true);
    } finally {
      await h.close();
    }
  });

  test("turns each server error into its typed error and keeps the message", async () => {
    const h = await makeHarness();
    try {
      seed(h, "one", { title: "First", state: "new" });

      const unauthorized = await client(h, "wrong-token")
        .types()
        .catch((error: unknown) => error);
      expect(unauthorized).toBeInstanceOf(TuiUnauthorizedError);
      expect((unauthorized as TuiUnauthorizedError).status).toBe(401);
      expect((unauthorized as TuiUnauthorizedError).message).toBe(
        "a bearer token is required",
      );

      const missing = await client(h)
        .object("item:missing")
        .catch((error: unknown) => error);
      expect(missing).toBeInstanceOf(TuiNotFoundError);
      expect((missing as TuiNotFoundError).message).toBe(
        'no object "item:missing"',
      );

      const refused = await client(h)
        .act({ action: "tuitest:fail", id: "item:one" })
        .catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(TuiRefusedError);
      expect((refused as TuiRefusedError).status).toBe(422);
      expect((refused as TuiRefusedError).message).toBe("the plugin refused");

      const tooLarge = await client(h)
        .act({
          action: "tuitest:approve",
          id: "item:one",
          note: "x".repeat(1024 * 1024 + 1),
        })
        .catch((error: unknown) => error);
      expect(tooLarge).toBeInstanceOf(TuiPayloadTooLargeError);
      expect((tooLarge as TuiPayloadTooLargeError).status).toBe(413);

      const slow = await makeHarness({ loadTimeoutMs: 20 });
      try {
        seed(slow, "one", { title: "First", state: "new" });
        const timeout = await client(slow)
          .section("item:one", "hang")
          .catch((error: unknown) => error);
        expect(timeout).toBeInstanceOf(TuiTimeoutError);
        const timeoutError = timeout as TuiTimeoutError;
        expect(timeoutError.status).toBe(504);
        expect(timeoutError.message).toContain("did not answer within");
      } finally {
        await slow.close();
      }
    } finally {
      await h.close();
    }
  });

  test("reports a server that answers nothing as unreachable", async () => {
    const port = await freePort();
    const unreachable = await new TuiClient({
      url: `http://127.0.0.1:${port}`,
      token: "a-token",
    })
      .types()
      .catch((error: unknown) => error);
    expect(unreachable).toBeInstanceOf(TuiUnreachableError);
    expect((unreachable as TuiUnreachableError).status).toBeUndefined();
    expect((unreachable as TuiUnreachableError).kind).toBe("unreachable");
  });

  test("discovers the server from the home, and the flags win", async () => {
    const h = await makeHarness();
    try {
      expect(await discoverServer({ home: h.home })).toEqual({
        url: h.base,
        token: h.token,
      });

      const flags = await discoverServer({
        home: join(h.root, "no-such-home"),
        url: `${h.base}/`,
        token: "from-the-flag",
      });
      expect(flags).toEqual({ url: h.base, token: "from-the-flag" });
    } finally {
      await h.close();
    }
  });

  test("a missing http section means the default address", async () => {
    const root = await tempRoot();
    try {
      const home = join(root, "home");
      mkdirSync(home, { recursive: true });
      writeFileSync(
        join(home, "config.json"),
        JSON.stringify({
          plugins: [],
          store: { backend: "jsonl", path: join(root, "store") },
        }),
      );
      const found = await discoverServer({ home });
      expect(found.url).toBe("http://127.0.0.1:7480");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a harness removes its own scratch home and leaves another's alone", async () => {
    const first = await makeHarness();
    const second = await makeHarness();
    try {
      await first.close();
      expect(existsSync(first.root)).toBe(false);
      expect(existsSync(second.root)).toBe(true);
    } finally {
      await second.close();
    }
    expect(existsSync(second.root)).toBe(false);
  });

  test("refuses a URL that is not an http base URL", async () => {
    for (const url of [
      "not a url",
      "ftp://host",
      "http://user:pw@host",
      "http://host?x=1",
    ]) {
      const bad = await discoverServer({
        url,
        token: "a-token",
        home: "/does/not/matter",
      }).catch((error: unknown) => error);
      expect(bad).toBeInstanceOf(TuiUrlError);
    }
  });

  test("an aborted request rejects with the abort, not an unreachable server", async () => {
    const seen: AbortSignal[] = [];
    const hanging: FetchLike = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal === undefined || signal === null) {
          reject(new Error("the request carried no signal"));
          return;
        }
        seen.push(signal);
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    const c = new TuiClient({
      url: "http://127.0.0.1:1",
      token: "t",
      fetch: hanging,
    });
    const controller = new AbortController();
    const pending = c.pending(controller.signal);
    const section = c.section("item:a", "overview", {
      signal: controller.signal,
    });
    const act = c.act({ action: "demo:go", signal: controller.signal });
    controller.abort();
    for (const call of [pending, section, act]) {
      const error = await call.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DOMException);
      expect(error).not.toBeInstanceOf(TuiUnreachableError);
    }
    expect(seen).toHaveLength(3);
  });
});
