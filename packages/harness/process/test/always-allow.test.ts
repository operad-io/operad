import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  accessUserPath,
  accessWithAlwaysAllow,
  alwaysAllowEntry,
  alwaysAllowFromGrant,
  appendAlwaysAllow,
  personStarted,
  readAlwaysAllow,
} from "../src/always-allow.ts";
import { cleanupTempRoots, tempRoot } from "./support.ts";

afterAll(cleanupTempRoots);

const CWD = "/work/project";

describe("readAlwaysAllow", () => {
  test("a missing file is an empty list without a problem", async () => {
    const home = await tempRoot();
    expect(await readAlwaysAllow(home)).toEqual({ entries: [] });
  });

  test("an invalid file is empty with a readable message naming the file", async () => {
    const home = await tempRoot();
    const path = accessUserPath(home);
    for (const [text, wording] of [
      ["{", "is not valid JSON"],
      ['{"kind":"command"}', "must be a JSON array"],
      ['[{"kind":"command","value":"ls"}]', "entry 0"],
      ['[{"kind":"path","value":"/x","cwd":"/w"}]', "entry 0"],
    ] as const) {
      writeFileSync(path, text);
      const read = await readAlwaysAllow(home);
      expect(read.entries).toEqual([]);
      expect(read.problem).toContain(path);
      expect(read.problem).toContain(wording);
      expect(read.problem).toContain("treated as empty");
    }
  });

  test("a valid file is read as the command and path entries it holds", async () => {
    const home = await tempRoot();
    writeFileSync(
      accessUserPath(home),
      JSON.stringify([
        { kind: "command", value: "git push origin main", cwd: CWD },
        { kind: "path", value: "/w/a.ts", cwd: CWD, tool: "write" },
      ]),
    );
    expect((await readAlwaysAllow(home)).entries).toEqual([
      { kind: "command", value: "git push origin main", cwd: CWD },
      { kind: "path", value: "/w/a.ts", cwd: CWD, tool: "write" },
    ]);
  });
});

describe("appendAlwaysAllow", () => {
  test("writes the entry and keeps the entries already in the file", async () => {
    const home = await tempRoot();
    await appendAlwaysAllow(home, { kind: "command", value: "ls", cwd: CWD });
    await appendAlwaysAllow(home, { kind: "path", value: "/w/a.ts", cwd: CWD, tool: "write" });
    expect((await readAlwaysAllow(home)).entries).toEqual([
      { kind: "command", value: "ls", cwd: CWD },
      { kind: "path", value: "/w/a.ts", cwd: CWD, tool: "write" },
    ]);
    const text = readFileSync(accessUserPath(home), "utf8");
    expect(text.endsWith("\n")).toBe(true);
  });

  test("does not add the same entry twice", async () => {
    const home = await tempRoot();
    const entry = { kind: "command" as const, value: "ls", cwd: CWD };
    await appendAlwaysAllow(home, entry);
    await appendAlwaysAllow(home, entry);
    expect((await readAlwaysAllow(home)).entries).toEqual([entry]);
  });

  test("two writers in one process take the lock and both entries survive", async () => {
    const home = await tempRoot();
    await Promise.all([
      appendAlwaysAllow(home, { kind: "command", value: "one", cwd: CWD }),
      appendAlwaysAllow(home, { kind: "command", value: "two", cwd: CWD }),
    ]);
    expect((await readAlwaysAllow(home)).entries.map((entry) => entry.value).sort()).toEqual(["one", "two"]);
  });

  test("a user layer that does not exist yet is created under the home", async () => {
    const home = join(await tempRoot(), "nested", "home");
    mkdirSync(home, { recursive: true });
    await appendAlwaysAllow(home, { kind: "command", value: "ls", cwd: CWD });
    expect(await readAlwaysAllow(home)).toEqual({
      entries: [{ kind: "command", value: "ls", cwd: CWD }],
    });
  });
});

describe("entries and profiles", () => {
  test("an entry copies the exact command or tool, path and working directory", () => {
    expect(alwaysAllowEntry({ kind: "command", value: "git push origin main" }, CWD)).toEqual({
      kind: "command",
      value: "git push origin main",
      cwd: CWD,
    });
    expect(alwaysAllowEntry({ kind: "path", value: "~/.zshrc", tool: "write" }, CWD)).toEqual({
      kind: "path",
      value: "~/.zshrc",
      cwd: CWD,
      tool: "write",
    });
  });

  test("the profile gets the user entries only when the run may consult them", () => {
    expect(accessWithAlwaysAllow({ askCommands: ["git push"] }, [], true)).toEqual({ askCommands: ["git push"] });
    expect(accessWithAlwaysAllow({ askCommands: ["git push"] }, [{ kind: "command", value: "git push", cwd: CWD }], true)).toEqual({
      askCommands: ["git push"],
      alwaysAllow: [{ kind: "command", value: "git push", cwd: CWD }],
    });
    expect(accessWithAlwaysAllow({ alwaysAllow: [{ kind: "command", value: "ls", cwd: CWD }] }, [], false)).toEqual({
      alwaysAllow: [],
    });
    expect(accessWithAlwaysAllow({ alwaysAllow: [{ kind: "command", value: "ls", cwd: CWD }] }, [{ kind: "command", value: "pwd", cwd: CWD }], true)).toEqual({
      alwaysAllow: [
        { kind: "command", value: "ls", cwd: CWD },
        { kind: "command", value: "pwd", cwd: CWD },
      ],
    });
  });

  test("a late answer carries the call in its grant", () => {
    expect(alwaysAllowFromGrant({ grants: [{ waitId: "w1", kind: "command", value: "ls" }] }, CWD)).toEqual({
      kind: "command",
      value: "ls",
      cwd: CWD,
    });
    expect(alwaysAllowFromGrant({ grants: [{ waitId: "w1", kind: "path", value: "/x", tool: "write" }] }, CWD)).toEqual({
      kind: "path",
      value: "/x",
      cwd: CWD,
      tool: "write",
    });
    expect(alwaysAllowFromGrant({ grants: [] }, CWD)).toBeUndefined();
    expect(alwaysAllowFromGrant({}, CWD)).toBeUndefined();
  });

  test("only a person's command or message is a person-started run", () => {
    expect(personStarted(undefined)).toBe(true);
    expect(personStarted(null)).toBe(true);
    expect(personStarted({ source: "ios", type: "message" })).toBe(true);
    expect(personStarted({ source: "other", type: "message" })).toBe(true);
    expect(personStarted({ source: "cron", type: "tick" })).toBe(false);
    expect(personStarted({ source: "webhook", type: "push" })).toBe(false);
    expect(personStarted({ source: "email", type: "message" })).toBe(false);
    expect(personStarted("not a trigger")).toBe(false);
  });
});

test("the package ships the user layer's JSON Schema", () => {
  const schema = JSON.parse(
    readFileSync(join(import.meta.dir, "..", "access-user.schema.json"), "utf8"),
  ) as { type?: unknown; items?: unknown };
  expect(schema.type).toBe("array");
  expect(schema.items).toBeDefined();
});
