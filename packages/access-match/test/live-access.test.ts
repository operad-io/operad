import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hasLiveAccess,
  liveAccess,
  match,
  readLiveAccess,
  readProfile,
  updateLiveAccessLevel,
  withAccessLevel,
  writeLiveAccess,
} from "../src/index.ts";

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "operad-live-access-"));
  roots.push(root);
  return root;
}

describe("a chat's live access level", () => {
  test("is read again from its file, so a lowered level asks the next call", async () => {
    const root = await tempRoot();
    const file = join(root, "access.json");
    await writeLiveAccess(file, { denyCommands: ["rm"] }, "full");
    const start = withAccessLevel({ denyCommands: ["rm"] }, "full");
    const withFile = { ...start, levelFile: file };

    expect(hasLiveAccess(withFile)).toBe(true);
    expect(match(liveAccess(withFile), { tool: "write", input: { path: join(root, "a.ts") }, cwd: root }).allow).toBe(true);

    await updateLiveAccessLevel(file, "ask");
    const current = liveAccess(withFile);
    expect(current.level).toBe("ask");
    expect(current.denyCommands).toContain("rm");
    expect(match(current, { tool: "write", input: { path: join(root, "a.ts") }, cwd: root })).toMatchObject({
      allow: false,
      ask: true,
    });
    // The file kept the base profile, so changing the level did not drop its deny.
    const denied = match(current, { tool: "bash", input: { command: "rm -rf build" }, cwd: root });
    expect(denied.allow).toBe(false);
    expect(denied.ask).toBeUndefined();
  });

  test("a one-time grant and a background flag survive the level the file gives", async () => {
    const root = await tempRoot();
    const file = join(root, "access.json");
    await writeLiveAccess(file, {}, "full");
    const start = {
      ...withAccessLevel({}, "ask"),
      levelFile: file,
      background: true,
      grants: [{ waitId: "w1", kind: "command" as const, value: "true" }],
    };
    const current = liveAccess(start);
    expect(current.level).toBe("full");
    expect(current.background).toBe(true);
    expect(current.grants).toEqual([{ waitId: "w1", kind: "command", value: "true" }]);
  });

  test("a missing or unreadable file leaves the profile it was started with", () => {
    const start = { ...withAccessLevel({}, "ask"), levelFile: "/no/such/access.json" };
    expect(liveAccess(start)).toEqual(start);
    expect(hasLiveAccess(start)).toBe(true);
    expect(hasLiveAccess(withAccessLevel({}, "ask"))).toBe(false);
  });

  test("the profile reader accepts a level file and refuses an empty one", async () => {
    const root = await tempRoot();
    const file = join(root, "access.json");
    await writeLiveAccess(file, {}, "edits");
    expect(readProfile({ levelFile: file }).ok).toBe(true);
    expect(readLiveAccess(file)).toEqual({ access: {}, level: "edits" });
    expect(readProfile({ levelFile: "" })).toEqual({ ok: false, message: "levelFile must be a non-empty string" });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ access: {}, level: "edits" });
  });
});
