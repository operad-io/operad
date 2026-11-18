import { describe, expect, test } from "bun:test";
import { withDefaultAccess, type AccessProfile } from "@operad-io/access-match";
import type { StepContext, StepRunOptions } from "@operad-io/engine";
import { runPrepare } from "../src/prepare.ts";
import type { DevSettings } from "../src/settings.ts";

describe("prepare", () => {
  test("a prepare call gets a task's profile: the default's denies, not its asks", async () => {
    const calls: StepRunOptions[] = [];
    const ctx = {
      runId: "prepare-run",
      object: undefined,
      params: null,
      access: { denyCommands: ["no-local-command"] },
      trigger: undefined,
      signal: new AbortController().signal,
      runStep: async (
        _use: string,
        _params: unknown,
        options?: StepRunOptions,
      ) => {
        if (options !== undefined) calls.push(options);
        return { result: "pass" as const, data: {} };
      },
    } as unknown as StepContext;
    const settings = {
      prepare: ["true"],
      gate: { commandTimeoutSecs: 60 },
    } as unknown as DevSettings;

    expect(await runPrepare(ctx, settings, "/tmp")).toBeUndefined();
    expect(calls).toHaveLength(1);
    const access = calls[0]?.access;
    expect(access).toMatchObject({
      defaultAsks: false,
      denyCommands: ["no-local-command"],
    });
    const profile = withDefaultAccess(access as AccessProfile);
    expect(profile.denyPaths).toContain("~/.ssh");
    expect(profile.denyCommands).toEqual(
      expect.arrayContaining(["sudo", "no-local-command"]),
    );
    expect(profile.askCommands).toBeUndefined();
    expect(profile.askPaths).toBeUndefined();
  });
});
