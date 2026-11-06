import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FilePluginStore,
  openConfigLog,
  openPluginStore,
  readConfig,
  storeRootOf,
} from "@operad-io/engine";
import { main, type CliIo } from "../src/main.ts";
import { cleanupTempRoots, tempRoot } from "../../engine/test/plugin/support.ts";

afterAll(cleanupTempRoots);

const pluginPath = fileURLToPath(
  new URL("../../engine/test/fixtures/plugins/presentation.ts", import.meta.url),
);

interface Output {
  readonly io: CliIo;
  text(): string;
  errors(): string;
}

function capture(lines?: readonly string[]): Output {
  let out = "";
  let err = "";
  const queue = [...(lines ?? [])];
  return {
    io: {
      write: (text) => {
        out += text;
      },
      error: (text) => {
        err += text;
      },
      readLine: async () => queue.shift(),
    },
    text: () => out,
    errors: () => err,
  };
}

async function makeHome(): Promise<{
  readonly root: string;
  readonly home: string;
  readonly storeRoot: string;
}> {
  const root = await tempRoot();
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      plugins: [pluginPath],
      store: { backend: "jsonl", path: join(root, "store") },
    }),
  );
  const config = await readConfig(home);
  return { root, home, storeRoot: storeRootOf(config) };
}

function seed(home: string, data: Record<string, unknown>, id = "one"): void {
  const store = new FilePluginStore({ root: join(storeRootSync(home), "plugins") });
  store.put("item", id, data, "seed");
}

function storeRootSync(home: string): string {
  // The test config puts the store under `<root>/store`.
  return join(home, "..", "store");
}

function freshStore(home: string): FilePluginStore {
  return new FilePluginStore({ root: join(storeRootSync(home), "plugins") });
}

async function addWaitingRun(home: string, object: string): Promise<void> {
  const config = await readConfig(home);
  const log = openConfigLog(config);
  try {
    const info = await log.startRun("demo-flow", object);
    await log.append(info.runId, 0, [
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
  } finally {
    await log.close();
  }
}

const INTERNAL = ["fact", "effect", "node", "graph", "decide", "evolve"];

function assertUserWords(text: string): void {
  const lower = text.toLowerCase();
  for (const word of INTERNAL) {
    expect(lower).not.toContain(word);
  }
}

describe("operad presentation commands", () => {
  test("list shows rows and flags; --json gives the kernel fields", async () => {
    const { home } = await makeHome();
    seed(home, { title: "First", state: "new", note: "$1" }, "one");
    seed(home, { title: "Second", state: "open" }, "two");
    await addWaitingRun(home, "item:one");

    const output = capture();
    expect(await main(["list", "item"], { home, io: output.io })).toBe(0);
    expect(output.text()).toContain("one  new  First  $1");
    expect(output.text()).toContain("two  open  Second");
    assertUserWords(output.text());

    const json = capture();
    expect(await main(["list", "item", "--json"], { home, io: json.io })).toBe(0);
    const page = JSON.parse(json.text()) as {
      rows: {
        id: string;
        waiting: boolean;
        running: boolean;
        note?: string;
      }[];
      next?: string;
    };
    expect(page.rows[0]).toMatchObject({ id: "one", waiting: true, note: "$1" });
    expect(page.rows[1]).toMatchObject({ id: "two", waiting: false });
    expect(page.next).toBeUndefined();
  });

  test("list filters on indexed fields and pages with --limit and --cursor", async () => {
    const { home } = await makeHome();
    seed(home, { title: "One", state: "new", plan: "P1" }, "one");
    seed(home, { title: "Two", state: "open", plan: "P1" }, "two");
    seed(home, { title: "Three", state: "new", plan: "P1" }, "three");

    const filtered = capture();
    expect(
      await main(["list", "item", "--where", "state=new"], {
        home,
        io: filtered.io,
      }),
    ).toBe(0);
    expect(filtered.text()).toContain("one");
    expect(filtered.text()).toContain("three");
    expect(filtered.text()).not.toContain("two");

    const refused = capture();
    expect(
      await main(["list", "item", "--where", "title=One"], {
        home,
        io: refused.io,
      }),
    ).toBe(2);
    expect(refused.errors()).toContain('field "title"');
    expect(refused.errors()).toContain('"state"');

    const first = capture();
    expect(
      await main(["list", "item", "--where", "plan=P1", "--limit", "2"], {
        home,
        io: first.io,
      }),
    ).toBe(0);
    const nextLine = first
      .text()
      .split("\n")
      .find((line) => line.startsWith("next: "));
    expect(nextLine).toBeDefined();
    const cursor = (nextLine ?? "").replace("next: operad list item --cursor ", "");

    const second = capture();
    expect(
      await main(["list", "item", "--where", "plan=P1", "--limit", "2", "--cursor", cursor], {
        home,
        io: second.io,
      }),
    ).toBe(0);
    expect(second.text()).toContain("two");
    expect(second.text()).not.toContain("one  ");
    expect(second.text()).not.toContain("three");
    expect(second.text()).not.toContain("next: ");
  });

  test("list and actions use the configured sqlite store", async () => {
    const { root, home } = await makeHome();
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        plugins: [pluginPath],
        store: { backend: "sqlite", path: join(root, "store", "log.sqlite") },
      }),
    );
    const store = openPluginStore({
      backend: "sqlite",
      root: join(root, "store"),
    });
    store.put("item", "one", { title: "One", state: "new", plan: "P1" }, "seed");

    const output = capture();
    expect(
      await main(["list", "item", "--where", "state=new"], {
        home,
        io: output.io,
      }),
    ).toBe(0);
    expect(output.text()).toContain("one  new  One");

    const action = capture();
    expect(
      await main(["demo:auto", "item:one", "--level", "run"], {
        home,
        io: action.io,
      }),
    ).toBe(0);
    expect(store.get("item", "one")?.data.auto).toBe("run");
  });

  test("list shows a Promise row as an error row", async () => {
    const { home } = await makeHome();
    seed(home, { title: "Async", mode: "async" }, "async");
    const output = capture();
    expect(await main(["list", "item"], { home, io: output.io })).toBe(0);
    expect(output.text()).toContain("error");
    expect(output.text()).toContain("Promise");
    assertUserWords(output.text());
  });

  test("show renders a section, its table, diff and mermaid code", async () => {
    const { home } = await makeHome();
    seed(home, { title: "First", state: "new", note: "$1" }, "one");

    const output = capture();
    expect(
      await main(["show", "item:one", "--section", "info"], {
        home,
        io: output.io,
      }),
    ).toBe(0);
    const text = output.text();
    expect(text).toContain("DEMO ITEM");
    expect(text).toContain("bold");
    expect(text).toContain("link (https://example.com)");
    expect(text).toContain("--- a/file.ts");
    expect(text).toContain("+new");
    expect(text).toContain("| alpha | 1");
    expect(text).toContain("| beta  | 22");
    expect(text).toContain("mermaid");
    expect(text).toContain("flowchart TD");
    expect(text).toContain("A --> B");
    expect(output.errors()).toBe("");
    assertUserWords(text);

    const raw = capture();
    expect(
      await main(["show", "item:one", "--section", "info", "--raw"], {
        home,
        io: raw.io,
      }),
    ).toBe(0);
    expect(raw.text()).toContain("```diff");
    expect(raw.text()).toContain("```mermaid");
    assertUserWords(raw.text());
  });

  test("show prints the row, the sections, the actions and the first section", async () => {
    const { home } = await makeHome();
    seed(home, { title: "First", state: "new" }, "one");
    const output = capture();
    expect(await main(["show", "item:one"], { home, io: output.io })).toBe(0);
    expect(output.text()).toContain("one  new  First");
    expect(output.text()).toContain("sections: Info, Log (live), Pages, Hang, Big, History");
    expect(output.text()).toContain("demo:approve (m)  needs a note");
    expect(output.text()).toContain("demo:drop  asks to confirm");
    expect(output.text()).toContain("DEMO ITEM");
    assertUserWords(output.text());
  });

  test("show on an unknown id fails clearly", async () => {
    const { home } = await makeHome();
    const output = capture();
    expect(await main(["show", "item:nope"], { home, io: output.io })).toBe(1);
    expect(output.errors()).toContain('no object "item:nope"');
    assertUserWords(output.errors());
  });

  test("show keeps the history when the plugin is no longer loaded", async () => {
    const { root, home } = await makeHome();
    seed(home, { title: "Gone" }, "gone");
    await addWaitingRun(home, "item:gone");
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        plugins: [],
        store: { backend: "jsonl", path: join(root, "store") },
      }),
    );

    const output = capture();
    expect(await main(["show", "item:gone"], { home, io: output.io })).toBe(0);
    expect(output.errors()).toContain("not loaded");
    expect(output.text()).toContain("History");
    expect(output.text()).toContain("waiting for you");
    assertUserWords(output.text());
    assertUserWords(output.errors());
  });

  test("actions run by plugin:action, plugin action and the bare verb", async () => {
    const { home } = await makeHome();
    seed(home, { title: "One", state: "new" }, "one");
    seed(home, { title: "Two", state: "new" }, "two");
    seed(home, { title: "Three", state: "new" }, "three");

    const first = capture();
    expect(
      await main(["demo:approve", "item:one", "--note", "looks good"], {
        home,
        io: first.io,
      }),
    ).toBe(0);
    expect(freshStore(home).get("item", "one")?.data.approvedNote).toBe(
      "looks good",
    );

    const second = capture();
    expect(
      await main(["demo", "approve", "item:two", "--note", "two"], {
        home,
        io: second.io,
      }),
    ).toBe(0);
    expect(freshStore(home).get("item", "two")?.data.approved).toBe(true);

    const third = capture();
    expect(
      await main(["approve", "item:three", "--note", "three"], {
        home,
        io: third.io,
      }),
    ).toBe(0);
    expect(freshStore(home).get("item", "three")?.data.approved).toBe(true);
  });

  test("an enum argument is listed in help and validated", async () => {
    const { home } = await makeHome();
    seed(home, { title: "One", state: "new" }, "one");

    const shown = capture();
    expect(await main(["show", "item:one"], { home, io: shown.io })).toBe(0);
    expect(shown.text()).toContain("demo:auto");
    expect(shown.text()).toContain("--level off|run|merge");

    const usage = capture();
    expect(
      await main(["demo:auto", "--help"], { home, io: usage.io }),
    ).toBe(0);
    expect(usage.text()).toContain("usage: operad demo:auto <id>");
    expect(usage.text()).toContain("--level off|run|merge");

    const refused = capture();
    expect(
      await main(["demo:auto", "item:one", "--level", "bogus"], {
        home,
        io: refused.io,
      }),
    ).toBe(2);
    expect(refused.errors()).toContain("level");
    expect(refused.errors()).toContain('"off"');
    expect(refused.errors()).toContain('"run"');
    expect(refused.errors()).toContain('"merge"');

    const accepted = capture();
    expect(
      await main(["demo:auto", "item:one", "--level", "merge"], {
        home,
        io: accepted.io,
      }),
    ).toBe(0);
    expect(freshStore(home).get("item", "one")?.data.auto).toBe("merge");
  });

  test("a required note outside a terminal is a usage error", async () => {
    const { home } = await makeHome();
    seed(home, { title: "One", state: "new" }, "one");
    const output = capture();
    expect(
      await main(["demo:approve", "item:one"], { home, io: output.io }),
    ).toBe(2);
    expect(output.errors()).toContain("needs a note");
    expect(freshStore(home).get("item", "one")?.data.approved).toBeUndefined();
  });

  test("a note is prompted in a terminal, ending with an empty line", async () => {
    const { home } = await makeHome();
    seed(home, { title: "One", state: "new" }, "one");
    const output = capture(["line one", "line two", ""]);
    expect(
      await main(["demo:approve", "item:one"], {
        home,
        io: output.io,
        isTTY: true,
      }),
    ).toBe(0);
    expect(freshStore(home).get("item", "one")?.data.approvedNote).toBe(
      "line one\nline two",
    );
  });

  test("confirm needs --yes outside a terminal and asks in one", async () => {
    const { home } = await makeHome();
    seed(home, { title: "One", state: "new" }, "one");
    seed(home, { title: "Two", state: "new" }, "two");

    const refused = capture();
    expect(
      await main(["demo:drop", "item:one"], { home, io: refused.io }),
    ).toBe(2);
    expect(refused.errors()).toContain("needs confirmation");
    expect(freshStore(home).get("item", "one")?.data.dropped).toBeUndefined();

    const yes = capture();
    expect(
      await main(["demo:drop", "item:one", "--yes"], { home, io: yes.io }),
    ).toBe(0);
    expect(freshStore(home).get("item", "one")?.data.dropped).toBe(true);

    const asked = capture(["n"]);
    expect(
      await main(["demo:drop", "item:two"], {
        home,
        io: asked.io,
        isTTY: true,
      }),
    ).toBe(0);
    expect(asked.text()).toContain("cancelled");
    expect(freshStore(home).get("item", "two")?.data.dropped).toBeUndefined();

    const agreed = capture(["y"]);
    expect(
      await main(["demo:drop", "item:two"], {
        home,
        io: agreed.io,
        isTTY: true,
      }),
    ).toBe(0);
    expect(freshStore(home).get("item", "two")?.data.dropped).toBe(true);
  });

  test("pending lists actions as plugin:action", async () => {
    const { home } = await makeHome();
    seed(home, { title: "One", state: "new" }, "one");
    await addWaitingRun(home, "item:one");
    const output = capture();
    expect(await main(["pending"], { home, io: output.io })).toBe(0);
    expect(output.text()).toContain("demo:approve");
    expect(output.text()).toContain("demo:drop");
    expect(output.text()).not.toContain("demo/approve");
    assertUserWords(output.text());
  });

  test("keys.json overrides a plugin's default key", async () => {
    const { home } = await makeHome();
    seed(home, { title: "One", state: "new" }, "one");
    writeFileSync(join(home, "keys.json"), JSON.stringify({ m: "demo:drop" }));
    const output = capture();
    expect(await main(["show", "item:one"], { home, io: output.io })).toBe(0);
    expect(output.text()).toContain("demo:drop (m)");
    expect(output.text()).not.toContain("demo:approve (m)");
  });

  test("show --json includes the section content", async () => {
    const { home } = await makeHome();
    seed(home, { title: "One", state: "new" }, "one");
    const output = capture();
    expect(
      await main(["show", "item:one", "--section", "pages", "--json"], {
        home,
        io: output.io,
      }),
    ).toBe(0);
    const parsed = JSON.parse(output.text()) as {
      row: { id: string };
      section: { markdown: string; next: string };
    };
    expect(parsed.row.id).toBe("one");
    expect(parsed.section.markdown).toBe("page one");
    expect(parsed.section.next).toBe("two");
  });

  test("colours follow only waiting and running", async () => {
    const { home } = await makeHome();
    seed(home, { title: "Plain", state: "new" }, "plain");
    seed(home, { title: "Waits", state: "new" }, "waits");
    await addWaitingRun(home, "item:waits");

    const output = capture();
    expect(
      await main(["list", "item"], { home, io: output.io, isTTY: true }),
    ).toBe(0);
    const lines = output.text().split("\n");
    const plain = lines.find((line) => line.includes("Plain")) ?? "";
    const waits = lines.find((line) => line.includes("Waits")) ?? "";
    expect(plain).not.toContain("\x1b[");
    expect(waits).toContain("\x1b[33m");
    expect(waits).toContain("new");
    assertUserWords(output.text());
  });

  test("show styles Markdown for a terminal and stays plain otherwise", async () => {
    const { home } = await makeHome();
    seed(home, { title: "One", state: "new" }, "one");

    const plain = capture();
    expect(
      await main(["show", "item:one", "--section", "info"], {
        home,
        io: plain.io,
      }),
    ).toBe(0);
    expect(plain.text()).not.toContain("\x1b[");
    expect(plain.text()).toContain("DEMO ITEM");

    const colour = capture();
    expect(
      await main(["show", "item:one", "--section", "info"], {
        home,
        io: colour.io,
        isTTY: true,
      }),
    ).toBe(0);
    const styled = colour.text();
    expect(styled).toContain("\x1b[1m");
    expect(styled).toContain("\x1b[4m");
    expect(styled).toContain("\x1b[32m");
    expect(styled).toContain("\x1b[31m");
    expect(styled).toContain("\x1b[2m");
    expect(styled).toContain("DEMO ITEM");
    expect(styled).not.toContain("```");
    expect(styled.replace(/\x1b\[[0-9;]*m/g, "")).toBe(plain.text());
    assertUserWords(styled);

    const raw = capture();
    expect(
      await main(["show", "item:one", "--section", "info", "--raw"], {
        home,
        io: raw.io,
        isTTY: true,
      }),
    ).toBe(0);
    expect(raw.text()).not.toContain("\x1b[");
    expect(raw.text()).toContain("```diff");
  });
});
