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

const filteredPath = fileURLToPath(
  new URL("../../engine/test/fixtures/plugins/filtered.ts", import.meta.url),
);

const treePath = fileURLToPath(
  new URL("../../engine/test/fixtures/plugins/tree.ts", import.meta.url),
);

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

  test("a row's badge prints after its state, and a row without one keeps its line", async () => {
    const { home } = await makeHome();
    seed(home, { title: "First", state: "new", note: "$1", badge: "#2" }, "one");
    seed(home, { title: "Second", state: "open" }, "two");

    const listed = capture();
    expect(await main(["list", "item"], { home, io: listed.io })).toBe(0);
    expect(listed.text()).toContain("one  new  #2  First  $1");
    expect(listed.text()).toContain("two  open  Second\n");

    const shown = capture();
    expect(await main(["show", "item:one"], { home, io: shown.io })).toBe(0);
    expect(shown.text().split("\n")[0]).toBe("one  new  #2  First  $1");
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
    expect(nextLine).toContain("--where plan=P1");
    const cursor = (nextLine ?? "").replace("next: operad list item --where plan=P1 --cursor ", "");

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

  test("show lays a table out for the terminal's width; a pipe keeps the old output", async () => {
    const { home } = await makeHome();
    seed(home, { title: "First", state: "new", note: "$1" }, "one");

    const tty = capture();
    expect(
      await main(["show", "item:one", "--section", "info"], {
        home,
        io: tty.io,
        isTTY: true,
        columns: 60,
      }),
    ).toBe(0);
    expect(tty.text()).not.toContain("| alpha");
    expect(tty.text()).toContain("─────");

    const piped = capture();
    expect(
      await main(["show", "item:one", "--section", "info"], {
        home,
        io: piped.io,
        isTTY: false,
        columns: 60,
      }),
    ).toBe(0);
    expect(piped.text()).toContain("| alpha | 1");
  });

  test("show prints the row, the sections, the actions and the first section", async () => {
    const { home } = await makeHome();
    seed(home, { title: "First", state: "new" }, "one");
    const output = capture();
    expect(await main(["show", "item:one"], { home, io: output.io })).toBe(0);
    expect(output.text()).toContain("one  new  First");
    expect(output.text()).toContain("sections: Info, Log (live), Pages, Digits, Hang, Big, History");
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

  test("schema flags accept values that look like ids or negative numbers", async () => {
    const { home } = await makeHome();
    seed(home, { title: "One", state: "new" }, "one");

    const idLike = capture();
    expect(
      await main(["demo:label", "item:one", "--text", "x:y"], {
        home,
        io: idLike.io,
      }),
    ).toBe(0);
    expect(freshStore(home).get("item", "one")?.data.label).toBe("x:y");

    const numericText = capture();
    expect(
      await main(["demo:label", "item:one", "--text", "123"], {
        home,
        io: numericText.io,
      }),
    ).toBe(0);
    expect(freshStore(home).get("item", "one")?.data.label).toBe("123");

    const negative = capture();
    expect(
      await main(["demo:label", "item:one", "--count", "-1"], {
        home,
        io: negative.io,
      }),
    ).toBe(0);
    expect(freshStore(home).get("item", "one")?.data.count).toBe(-1);
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

  test("show --page takes a number as a position before a label", async () => {
    const { home } = await makeHome();
    seed(home, { title: "One", state: "new" }, "one");
    const page = async (value: string): Promise<string> => {
      const output = capture();
      await main(["show", "item:one", "--section", "digits", "--page", value, "--raw"], {
        home,
        io: output.io,
      });
      return output.text();
    };
    // Position 1 is labelled "2" and position 2 is labelled "1".
    expect(await page("1")).toMatch(/^first \d+\n$/);
    expect(await page("2")).toBe("second\n");
  });

  test("show --page of the first page reads it once; another page costs one more read", async () => {
    const { home } = await makeHome();
    seed(home, { title: "One", state: "new" }, "one");
    const read = async (value: string): Promise<number> => {
      const output = capture();
      await main(["show", "item:one", "--section", "digits", "--page", value, "--raw"], {
        home,
        io: output.io,
      });
      const count = /^first (\d+)\n$/.exec(output.text())?.[1];
      return count === undefined ? -1 : Number(count);
    };
    const a = await read("1");
    const b = await read("1");
    // The page counted is the one shown: one read per run, not two.
    expect(a).toBeGreaterThan(0);
    expect(b - a).toBe(1);
  });

  test("show --page prints one page by number or by label", async () => {
    const { home } = await makeHome();
    seed(home, { title: "One", state: "new" }, "one");
    const page = async (value: string): Promise<{ code: number; text: string; error: string }> => {
      const output = capture();
      const code = await main(
        ["show", "item:one", "--section", "pages", "--page", value, "--raw"],
        { home, io: output.io },
      );
      return { code, text: output.text(), error: output.errors() };
    };
    expect((await page("2")).text).toBe("page two\n");
    expect((await page("two")).text).toBe("page two\n");
    expect((await page("1")).text).toBe("page one\n");
    expect((await page("one")).text).toBe("page one\n");
    const missing = await page("9");
    expect(missing.code).not.toBe(0);
    expect(missing.error).toContain('has no page "9"');
    const flat = capture();
    expect(
      await main(["show", "item:one", "--section", "info", "--page", "1"], { home, io: flat.io }),
    ).not.toBe(0);
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
  test("list applies the default filter, --filter all shows everything, and a hidden line counts the rest", async () => {
    const { root, home } = await makeHome();
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        plugins: [filteredPath],
        store: { backend: "jsonl", path: join(root, "store") },
      }),
    );
    const store = freshStore(home);
    store.put("job", "a", { state: "open", title: "Alpha" }, "seed");
    store.put("job", "b", { state: "merged", title: "Beta" }, "seed");
    store.put("job", "c", { state: "merged", title: "Gamma" }, "seed");
    store.put("note", "n", { state: "merged", title: "Note" }, "seed");

    const byDefault = capture();
    expect(await main(["list", "job"], { home, io: byDefault.io })).toBe(0);
    expect(byDefault.text()).toContain("a  open  Alpha");
    expect(byDefault.text()).not.toContain("Beta");
    expect(byDefault.text().trimEnd().split("\n").pop()).toBe(
      "2 hidden (--filter all to show)",
    );

    const all = capture();
    expect(await main(["list", "job", "--filter", "all"], { home, io: all.io })).toBe(0);
    expect(all.text()).toContain("Beta");
    expect(all.text()).toContain("Gamma");
    expect(all.text()).not.toContain("hidden");

    const done = capture();
    expect(await main(["list", "job", "--filter", "done"], { home, io: done.io })).toBe(0);
    expect(done.text()).not.toContain("Alpha");
    expect(done.text().trimEnd().split("\n").pop()).toBe("1 hidden (--filter all to show)");

    const json = capture();
    expect(await main(["list", "job", "--json"], { home, io: json.io })).toBe(0);
    expect(JSON.parse(json.text())).toMatchObject({ hidden: 2 });

    const plain = capture();
    expect(await main(["list", "note"], { home, io: plain.io })).toBe(0);
    expect(plain.text()).not.toContain("hidden");
    const refused = capture();
    expect(await main(["list", "note", "--filter", "x"], { home, io: refused.io })).not.toBe(0);
    expect(refused.errors()).toContain("this type has no filters");
    const unknown = capture();
    expect(await main(["list", "job", "--filter", "x"], { home, io: unknown.io })).not.toBe(0);
    expect(unknown.errors()).toContain("allowed: active, all, done");
  });
  test("the printed next: command shell-quotes the repo value", async () => {
    const { root, home } = await makeHome();
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        plugins: [filteredPath],
        store: { backend: "jsonl", path: join(root, "store") },
      }),
    );
    const store = freshStore(home);
    store.put("job", "r1", { state: "open", title: "R1", repository: "my repo" }, "seed");
    store.put("job", "r2", { state: "open", title: "R2", repository: "my repo" }, "seed");

    const quoted = capture();
    expect(
      await main(["list", "job", "--filter", "all", "--repo", "my repo", "--limit", "1"], {
        home,
        io: quoted.io,
      }),
    ).toBe(0);
    const quotedNext = quoted.text().split("\n").find((line) => line.startsWith("next: "));
    expect(quotedNext).toContain("--filter all --repo 'my repo' --cursor ");

  });
});

describe("operad list hierarchy", () => {
  test("--root and --parent list one level; show prints the parent", async () => {
    const { root, home } = await makeHome();
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        plugins: [treePath],
        store: { backend: "jsonl", path: join(root, "store") },
      }),
    );
    const store = freshStore(home);
    store.put("group", "g1", { title: "G1" }, "seed");
    store.put("leaf", "a", { state: "open", title: "Alpha", parent: "group:g1" }, "seed");
    store.put("leaf", "b", { state: "merged", title: "Beta", parent: "group:g1" }, "seed");
    store.put("leaf", "d", { state: "open", title: "Delta" }, "seed");

    const flat = capture();
    expect(await main(["list", "leaf", "--filter", "all"], { home, io: flat.io })).toBe(0);
    expect(flat.text()).toContain("Alpha");
    expect(flat.text()).toContain("Delta");

    const top = capture();
    expect(await main(["list", "leaf", "--root"], { home, io: top.io })).toBe(0);
    expect(top.text()).toContain("Delta");
    expect(top.text()).not.toContain("Alpha");

    const kids = capture();
    expect(await main(["list", "leaf", "--parent", "group:g1"], { home, io: kids.io })).toBe(0);
    expect(kids.text()).toContain("a  open  Alpha");
    expect(kids.text()).not.toContain("Delta");
    expect(kids.text().trimEnd().split("\n").pop()).toBe("1 hidden (--filter all to show)");

    const none = capture();
    expect(await main(["list", "leaf", "--parent", "group:zzz"], { home, io: none.io })).toBe(0);
    expect(none.text()).toContain('no objects of type "leaf"');

    const both = capture();
    expect(
      await main(["list", "leaf", "--root", "--parent", "group:g1"], { home, io: both.io }),
    ).not.toBe(0);

    const shown = capture();
    expect(await main(["show", "leaf:a"], { home, io: shown.io })).toBe(0);
    expect(shown.text()).toContain("parent: group:g1");
    const topShown = capture();
    expect(await main(["show", "leaf:d"], { home, io: topShown.io })).toBe(0);
    expect(topShown.text()).not.toContain("parent:");
  });

  test("show prints an object's children as rows between the row and the sections", async () => {
    const { root, home } = await makeHome();
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        plugins: [treePath],
        store: { backend: "jsonl", path: join(root, "store") },
      }),
    );
    const store = freshStore(home);
    store.put("group", "g1", { title: "G1" }, "seed");
    store.put("group", "g2", { title: "G2" }, "seed");
    store.put("leaf", "a", { state: "open", title: "Alpha", parent: "group:g1" }, "seed");
    store.put("leaf", "b", { state: "merged", title: "Beta", parent: "group:g1" }, "seed");

    const withKids = capture();
    expect(await main(["show", "group:g1"], { home, io: withKids.io })).toBe(0);
    const lines = withKids.text().split("\n");
    const first = lines.findIndex((line) => line.startsWith("a  open  Alpha"));
    const sections = lines.findIndex((line) => line.startsWith("sections:"));
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(sections);
    expect(withKids.text()).toContain("1 hidden");

    const leaf = capture();
    expect(await main(["show", "group:g2"], { home, io: leaf.io })).toBe(0);
    expect(leaf.text()).not.toContain("Alpha");
    expect(leaf.text()).not.toContain("hidden");
  });
});
