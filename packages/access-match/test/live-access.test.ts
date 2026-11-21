import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempRoots, tempRoot } from "@operad-io/engine/testing";
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

afterAll(cleanupTempRoots);

describe("a chat's live access level", () => {
  test("is read again from its file, so a lowered level asks the next call", async () => {
    const root = await tempRoot();
    const directory = join(root, "chat");
    const file = join(directory, "access.json");
    const base = { denyCommands: ["rm"], denyPaths: [directory] };
    await writeLiveAccess(file, base, "full");
    const start = withAccessLevel(base, "full");
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
    const directory = join(root, "chat");
    const file = join(directory, "access.json");
    await writeLiveAccess(file, { denyPaths: [directory] }, "full");
    const start = {
      ...withAccessLevel({ denyPaths: [directory] }, "ask"),
      levelFile: file,
      background: true,
      grants: [{ waitId: "w1", kind: "command" as const, value: "true" }],
    };
    const current = liveAccess(start);
    expect(current.level).toBe("full");
    expect(current.background).toBe(true);
    expect(current.grants).toEqual([{ waitId: "w1", kind: "command", value: "true" }]);
  });

  test("a level file that drops the chat directory deny is ignored", async () => {
    const root = await tempRoot();
    const directory = join(root, "chat");
    const file = join(directory, "access.json");
    const start = { ...withAccessLevel({ denyPaths: [directory] }, "ask"), levelFile: file };

    // A file rewritten to full without the deny was not written by chat:access.
    await writeLiveAccess(file, {}, "full");
    const ignored = liveAccess(start);
    expect(ignored.level).toBe("ask");
    expect(match(ignored, { tool: "write", input: { path: join(root, "a.ts") }, cwd: root })).toMatchObject({
      allow: false,
      ask: true,
    });

    // With the deny it is trusted, and the deny still refuses the level file itself.
    await writeLiveAccess(file, { denyPaths: [directory] }, "full");
    const trusted = liveAccess(start);
    expect(trusted.level).toBe("full");
    expect(match(trusted, { tool: "write", input: { path: file }, cwd: root }).allow).toBe(false);
    expect(match(trusted, { tool: "write", input: { path: join(root, "a.ts") }, cwd: root }).allow).toBe(true);
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
