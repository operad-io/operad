import { afterAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineFlow, type AskRequest, type FlowDefinition } from "@operad-io/engine";
import {
  OUTWARD_ALLOW_TARGET,
  OUTWARD_REJECT_ONCE,
  OUTWARD_SEND_ONCE,
  accessGrantsPath,
  guardOutward,
  readTargetGrants,
  revokeTargetGrants,
  withDefaultAccess,
  type OutwardWrite,
  type TargetGrant,
} from "../src/index.ts";

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function tempHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "operad-target-grants-"));
  roots.push(root);
  return root;
}

const PROFILE = withDefaultAccess({});
const MESSAGE: OutwardWrite = { kind: "channel", target: "telegram:999", content: "the daily digest" };
const OTHER: OutwardWrite = { kind: "channel", target: "telegram:111", content: "another message" };

function flowWith(line: string): FlowDefinition {
  return defineFlow({
    name: "daily:send",
    entry: "send",
    steps: [
      {
        id: "send",
        kind: "plugin",
        params: { use: "shell/command", params: { line } },
        replay: "safe",
        next: { pass: "done" },
      },
      { id: "done", kind: "end", params: { status: "done" }, replay: "safe" },
    ],
  });
}

const FLOW = flowWith("curl -X POST https://example.com/hook");
const EDITED = flowWith("curl -X POST https://example.com/other");

function asker(seen: AskRequest[], choice = OUTWARD_ALLOW_TARGET, actor = { via: "ios", id: "owner" }) {
  return async (request: AskRequest) => {
    seen.push(request);
    return { choice, actor };
  };
}

test("always for this flow and target records who and when, and the next run to the same target does not ask", async () => {
  const home = await tempHome();
  const seen: AskRequest[] = [];
  expect(
    await guardOutward(
      { access: PROFILE, ask: asker(seen), personStarted: false, home, flow: FLOW, now: () => 1_700_000_000_000 },
      MESSAGE,
    ),
  ).toBe(true);
  expect(seen).toHaveLength(1);
  expect(seen[0]?.choices).toEqual([OUTWARD_SEND_ONCE, OUTWARD_ALLOW_TARGET, OUTWARD_REJECT_ONCE]);
  const read = await readTargetGrants(home);
  expect(read.problem).toBeUndefined();
  expect(read.file.flows).toHaveLength(1);
  const definition = read.file.flows[0]?.id;
  if (definition === undefined) throw new Error("the flow identity was not written");
  expect(read.file.grants).toEqual([
    {
      flow: "daily:send",
      definition,
      kind: "channel",
      target: "telegram:999",
      by: { via: "ios", id: "owner" },
      at: 1_700_000_000_000,
    } satisfies TargetGrant,
  ]);

  const again: AskRequest[] = [];
  expect(
    await guardOutward({ access: PROFILE, ask: asker(again), personStarted: false, home, flow: FLOW }, MESSAGE),
  ).toBe(true);
  expect(again).toEqual([]);
});

test("another target asks", async () => {
  const home = await tempHome();
  const seen: AskRequest[] = [];
  await guardOutward(
    { access: PROFILE, ask: asker(seen), personStarted: false, home, flow: FLOW, now: () => 1 },
    MESSAGE,
  );
  await guardOutward(
    { access: PROFILE, ask: asker(seen), personStarted: false, home, flow: FLOW, now: () => 2 },
    OTHER,
  );
  expect(seen).toHaveLength(2);
  expect(seen[1]?.prompt).toContain("telegram:111");
});

test("an edited flow asks, and reverting the edit asks again", async () => {
  const home = await tempHome();
  const seen: AskRequest[] = [];
  await guardOutward(
    { access: PROFILE, ask: asker(seen), personStarted: false, home, flow: FLOW, now: () => 1 },
    MESSAGE,
  );
  await guardOutward(
    { access: PROFILE, ask: asker(seen, OUTWARD_SEND_ONCE), personStarted: false, home, flow: EDITED, now: () => 2 },
    MESSAGE,
  );
  expect(seen).toHaveLength(2);
  // The edit was seen even though its answer did not record a grant. Reverting
  // is another change, so the first grant cannot come back.
  await guardOutward(
    { access: PROFILE, ask: asker(seen, OUTWARD_SEND_ONCE), personStarted: false, home, flow: FLOW, now: () => 3 },
    MESSAGE,
  );
  expect(seen).toHaveLength(3);
  const read = await readTargetGrants(home);
  expect(read.file.flows).toHaveLength(1);
  expect(read.file.grants).toHaveLength(1);
});

test("revoking the target makes the next run ask", async () => {
  const home = await tempHome();
  const seen: AskRequest[] = [];
  await guardOutward(
    { access: PROFILE, ask: asker(seen), personStarted: false, home, flow: FLOW, now: () => 1 },
    MESSAGE,
  );
  expect(await revokeTargetGrants(home, "telegram:999")).toBe(1);
  const again: AskRequest[] = [];
  await guardOutward(
    { access: PROFILE, ask: asker(again, OUTWARD_SEND_ONCE), personStarted: false, home, flow: FLOW, now: () => 2 },
    MESSAGE,
  );
  expect(again).toHaveLength(1);
  expect(await readTargetGrants(home)).toMatchObject({ file: { grants: [] } });
});

test("a chat's exact Always allow does not lift a background outward question", async () => {
  const home = await tempHome();
  const seen: AskRequest[] = [];
  const profile = {
    ...PROFILE,
    alwaysAllow: [{ kind: "command" as const, value: "the daily digest", cwd: "/work" }],
  };
  await guardOutward(
    { access: profile, ask: asker(seen, OUTWARD_REJECT_ONCE), personStarted: false, home, flow: FLOW },
    MESSAGE,
  );
  expect(seen).toHaveLength(1);
});

test("a target grant is tied to the target, never to the content that is sent", async () => {
  const home = await tempHome();
  const seen: AskRequest[] = [];
  await guardOutward(
    { access: PROFILE, ask: asker(seen), personStarted: false, home, flow: FLOW, now: () => 1 },
    MESSAGE,
  );
  const tomorrow: OutwardWrite = { kind: "channel", target: "telegram:999", content: "a new digest" };
  await guardOutward(
    { access: PROFILE, ask: asker(seen), personStarted: false, home, flow: FLOW },
    tomorrow,
  );
  expect(seen).toHaveLength(1);
});

test("an invalid grants file is reported and treated as empty", async () => {
  const home = await tempHome();
  await mkdir(home, { recursive: true });
  await writeFile(accessGrantsPath(home), "[");
  const read = await readTargetGrants(home);
  expect(read.file).toEqual({ flows: [], grants: [] });
  expect(read.problem).toContain(accessGrantsPath(home));
  expect(read.problem).toContain("treated as empty");
});
