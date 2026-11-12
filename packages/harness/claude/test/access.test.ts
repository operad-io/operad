import { describe, expect, test } from "bun:test";
import type { AccessProfile } from "@operad-io/access-match";
import { INERT_TOOLS, TOOL_TABLE, decideAccess, hasRules, translate } from "../src/access.ts";

const CWD = "/work/project";

/** What each row of the table must do, written out here and not read from the table. */
const ROWS: ReadonlyArray<{
  readonly claude: string;
  readonly tool: string;
  readonly input: Record<string, unknown>;
  readonly mapped: Record<string, unknown>;
  readonly profile: AccessProfile;
  readonly reason: RegExp;
  readonly allowed: Record<string, unknown>;
}> = [
  {
    claude: "Bash",
    tool: "bash",
    input: { command: "rm -rf build", description: "clean" },
    mapped: { command: "rm -rf build" },
    profile: { denyCommands: ["rm"] },
    reason: /denyCommands rule "rm"/,
    allowed: { command: "ls" },
  },
  {
    claude: "Read",
    tool: "read",
    input: { file_path: "/etc/passwd" },
    mapped: { path: "/etc/passwd" },
    profile: { denyPaths: ["/etc"] },
    reason: /under denyPaths entry "\/etc"/,
    allowed: { file_path: "/work/project/a.txt" },
  },
  {
    claude: "Write",
    tool: "write",
    input: { file_path: "/etc/hosts", content: "x" },
    mapped: { path: "/etc/hosts" },
    profile: { denyPaths: ["/etc"] },
    reason: /under denyPaths entry "\/etc"/,
    allowed: { file_path: "/work/project/a.txt", content: "x" },
  },
  {
    claude: "Edit",
    tool: "edit",
    input: { file_path: "/etc/hosts", old_string: "a", new_string: "b" },
    mapped: { path: "/etc/hosts" },
    profile: { denyPaths: ["/etc"] },
    reason: /under denyPaths entry "\/etc"/,
    allowed: { file_path: "secret-free.txt", old_string: "a", new_string: "b" },
  },
  {
    claude: "MultiEdit",
    tool: "edit",
    input: { file_path: "/etc/hosts", edits: [] },
    mapped: { path: "/etc/hosts" },
    profile: { denyPaths: ["/etc"] },
    reason: /under denyPaths entry "\/etc"/,
    allowed: { file_path: "/work/project/a.txt", edits: [] },
  },
  {
    claude: "NotebookEdit",
    tool: "edit",
    input: { notebook_path: "/etc/n.ipynb", new_source: "x" },
    mapped: { path: "/etc/n.ipynb" },
    profile: { denyPaths: ["/etc"] },
    reason: /under denyPaths entry "\/etc"/,
    allowed: { notebook_path: "/work/project/n.ipynb", new_source: "x" },
  },
  {
    claude: "Grep",
    tool: "grep",
    input: { pattern: "x", path: "/etc" },
    mapped: { path: "/etc" },
    profile: { denyPaths: ["/etc"] },
    reason: /under denyPaths entry "\/etc"/,
    allowed: { pattern: "x", path: "/work/project/src" },
  },
  {
    claude: "Glob",
    tool: "find",
    input: { pattern: "*", path: "/etc" },
    mapped: { path: "/etc" },
    profile: { denyPaths: ["/etc"] },
    reason: /under denyPaths entry "\/etc"/,
    allowed: { pattern: "*" },
  },
];

describe("the tool table", () => {
  test("it has exactly the rows these tests cover", () => {
    expect(TOOL_TABLE.map((row) => row.claude)).toEqual(ROWS.map((row) => row.claude));
  });

  for (const row of ROWS) {
    test(`${row.claude}: mapped to ${row.tool}, refused by the profile, allowed elsewhere`, async () => {
      const got = translate(row.claude, row.input);
      expect(got.kind).toBe("mapped");
      const seen: unknown = got.kind === "mapped" ? { tool: got.tool, input: got.input } : got;
      expect(seen).toEqual({ tool: row.tool, input: row.mapped });

      const denied = await decideAccess(row.profile, row.claude, row.input, CWD);
      expect(denied.allow).toBe(false);
      expect(denied.allow === false ? denied.reason : "").toMatch(row.reason);

      expect(await decideAccess(row.profile, row.claude, row.allowed, CWD)).toEqual({ allow: true });
      // No rule: nothing is refused.
      expect(await decideAccess({}, row.claude, row.input, CWD)).toEqual({ allow: true });
    });
  }

  test("a relative path is judged against the working directory", async () => {
    const verdict = await decideAccess({ denyPaths: ["secrets"] }, "Read", { file_path: "secrets/key" }, CWD);
    expect(verdict.allow).toBe(false);
  });

  test("a tool whose target is required but missing is refused while a rule is set", async () => {
    for (const name of ["Bash", "Read", "Write", "Edit", "MultiEdit", "NotebookEdit"]) {
      const verdict = await decideAccess({ denyCommands: ["rm"] }, name, {}, CWD);
      expect(verdict.allow).toBe(false);
      expect(verdict.allow === false ? verdict.reason : "").toContain(`tool "${name}" has no`);
    }
    expect(await decideAccess({}, "Bash", {}, CWD)).toEqual({ allow: true });
    // A non-string command is as good as none.
    expect((await decideAccess({ denyCommands: ["rm"] }, "Bash", { command: 3 }, CWD)).allow).toBe(false);
  });

  test("Glob and Grep with no path search the working directory and are allowed", async () => {
    expect(await decideAccess({ denyPaths: ["/etc"] }, "Grep", { pattern: "x" }, CWD)).toEqual({ allow: true });
    expect(await decideAccess({ denyPaths: ["/etc"] }, "Glob", { pattern: "*" }, CWD)).toEqual({ allow: true });
  });
});

describe("tools outside the table", () => {
  const rules: AccessProfile = { denyPaths: ["/etc"], denyCommands: ["rm"] };

  test("an inert tool is allowed under any profile", async () => {
    for (const name of INERT_TOOLS) {
      expect(translate(name, {})).toEqual({ kind: "inert" });
      expect(await decideAccess(rules, name, { url: "https://example.com" }, CWD)).toEqual({ allow: true });
    }
    expect(INERT_TOOLS).toEqual([
      "TodoWrite",
      "WebFetch",
      "WebSearch",
      "ExitPlanMode",
      "BashOutput",
      "KillShell",
      "Task",
      "Agent",
    ]);
  });

  test("an unmapped tool is refused while denyPaths or denyCommands is set", async () => {
    for (const name of ["mcp__files__read", "SomeNewTool"]) {
      expect(translate(name, {})).toEqual({ kind: "unmapped" });
      for (const profile of [{ denyPaths: ["/etc"] }, { denyCommands: ["rm"] }, rules]) {
        const verdict = await decideAccess(profile, name, {}, CWD);
        expect(verdict.allow).toBe(false);
        expect(verdict.allow === false ? verdict.reason : "").toContain(`tool "${name}" is not one the access profile can check`);
      }
    }
  });

  test("an unmapped tool is allowed when no rule could match it", async () => {
    for (const profile of [{}, { denyPaths: [] }, { denyCommands: [] }, { grants: [{ waitId: "w", kind: "command" as const, value: "x" }] }]) {
      expect(await decideAccess(profile, "mcp__files__read", {}, CWD)).toEqual({ allow: true });
    }
  });

  test("hasRules is true only for a non-empty deny list", () => {
    expect(hasRules({})).toBe(false);
    expect(hasRules({ denyPaths: [] })).toBe(false);
    expect(hasRules({ denyPaths: ["/x"] })).toBe(true);
    expect(hasRules({ denyCommands: ["rm"] })).toBe(true);
  });
});

describe("one-time grants", () => {
  const grants = [
    { waitId: "w-cmd", kind: "command" as const, value: "rm -rf build" },
    { waitId: "w-path", kind: "path" as const, value: "/etc/hosts", tool: "write" },
  ];
  const profile: AccessProfile = { denyCommands: ["rm"], denyPaths: ["/etc"], grants };

  test("a command grant that matches exactly is used and lets the call run", async () => {
    const used: string[] = [];
    const verdict = await decideAccess(profile, "Bash", { command: "rm -rf build" }, CWD, async (id) => {
      used.push(id);
      return true;
    });
    expect(verdict).toEqual({ allow: true });
    expect(used).toEqual(["w-cmd"]);
  });

  test("a path grant covers the one tool it names", async () => {
    const used: string[] = [];
    const useGrant = async (id: string): Promise<boolean> => {
      used.push(id);
      return true;
    };
    expect(await decideAccess(profile, "Write", { file_path: "/etc/hosts" }, CWD, useGrant)).toEqual({ allow: true });
    expect((await decideAccess(profile, "Edit", { file_path: "/etc/hosts" }, CWD, useGrant)).allow).toBe(false);
    expect(used).toEqual(["w-path"]);
  });

  test("a grant the host does not use up lets nothing through", async () => {
    const verdict = await decideAccess(profile, "Bash", { command: "rm -rf build" }, CWD, async () => false);
    expect(verdict.allow).toBe(false);
    expect(verdict.allow === false ? verdict.reason : "").toMatch(/denyCommands rule "rm"/);
  });

  test("a host that throws is a grant not used", async () => {
    const verdict = await decideAccess(profile, "Bash", { command: "rm -rf build" }, CWD, async () => {
      throw new Error("the host is gone");
    });
    expect(verdict.allow).toBe(false);
  });

  test("without a host no grant applies", async () => {
    expect((await decideAccess(profile, "Bash", { command: "rm -rf build" }, CWD)).allow).toBe(false);
  });

  test("a different command does not ask the host at all", async () => {
    let asked = false;
    const verdict = await decideAccess(profile, "Bash", { command: "rm -rf dist" }, CWD, async () => {
      asked = true;
      return true;
    });
    expect(verdict.allow).toBe(false);
    expect(asked).toBe(false);
  });

  test("a call the profile allows never asks the host", async () => {
    let asked = false;
    const verdict = await decideAccess(profile, "Bash", { command: "ls" }, CWD, async () => {
      asked = true;
      return true;
    });
    expect(verdict).toEqual({ allow: true });
    expect(asked).toBe(false);
  });
});

describe("operad's own tools", () => {
  test("are not judged by the profile, though other MCP tools are refused while a deny rule is set", async () => {
    const profile: AccessProfile = { denyPaths: ["~/.ssh"], readOnly: true };
    expect(translate("mcp__operad__act", { id: "task:1" })).toEqual({ kind: "inert" });
    expect(await decideAccess(profile, "mcp__operad__list", { type: "task" }, CWD)).toEqual({ allow: true });
    const other = await decideAccess(profile, "mcp__other__list", {}, CWD);
    expect(other.allow).toBe(false);
  });

  test("another server's tool is judged by server and tool when the profile has allowMcp: a listed one runs, any other asks", async () => {
    const profile: AccessProfile = { denyPaths: ["~/.ssh"], allowMcp: ["notes.echo"] };
    expect(translate("mcp__notes__echo", {}, true)).toEqual({ kind: "mapped", tool: "mcp", input: { server: "notes", tool: "echo" } });
    expect(translate("mcp__notes__echo", {})).toEqual({ kind: "unmapped" });
    expect(await decideAccess(profile, "mcp__notes__echo", {}, CWD)).toEqual({ allow: true });
    const refused = await decideAccess(profile, "mcp__notes__wipe", {}, CWD);
    expect(refused.allow).toBe(false);
    const asked: unknown[] = [];
    const allowed = await decideAccess(profile, "mcp__notes__wipe", {}, CWD, undefined, async (question) => {
      asked.push(question);
      return { decision: "allow" };
    });
    expect(allowed).toEqual({ allow: true });
    expect(asked).toEqual([{ kind: "command", value: "mcp notes.wipe" }]);
    // Operad's own tools stay outside the profile.
    expect(await decideAccess(profile, "mcp__operad__list", {}, CWD)).toEqual({ allow: true });
  });

  test("a read-only profile asks about a write in the working directory", async () => {
    const asked: unknown[] = [];
    const verdict = await decideAccess({ readOnly: true }, "Write", { file_path: `${CWD}/a.ts` }, CWD, undefined, async (question) => {
      asked.push(question);
      return { decision: "deny", reason: "no" };
    });
    expect(verdict.allow).toBe(false);
    expect(asked).toEqual([{ kind: "path", value: `${CWD}/a.ts`, tool: "write" }]);
  });
});
