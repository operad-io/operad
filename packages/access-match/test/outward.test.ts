import { expect, test } from "bun:test";
import {
  declaredOutward,
  defaultAccess,
  guardOutward,
  match,
  OUTWARD_SEND_ONCE,
  outwardAllowed,
  outwardCommandWrites,
  outwardQuestion,
  withDefaultAccess,
  type OutwardWrite,
} from "../src/index.ts";
import type { AskRequest } from "@operad-io/engine";

const HOME = "/home/u";
const CWD = "/work/project";
const PROFILE = withDefaultAccess({});

function bash(profile: ReturnType<typeof withDefaultAccess>, command: string) {
  return match(profile, { tool: "bash", input: { command }, cwd: CWD }, { home: HOME });
}

function asker(seen: AskRequest[], choice = OUTWARD_SEND_ONCE) {
  return async (request: AskRequest) => {
    seen.push(request);
    return { choice };
  };
}

test("the default profile names the outward commands and the owner's channels", () => {
  const profile = defaultAccess();
  expect(profile.outwardCommands).toContain("git push");
  expect(profile.outwardCommands).toContain("gh pr create");
  expect(profile.outwardCommands).toContain("gh issue comment");
  expect(profile.outwardCommands).toContain("curl");
  expect(profile.outwardCommands).toContain("mail");
  expect(profile.outwardCommands).toContain("sendmail");
  expect(profile.outwardAllow).toEqual(["owner"]);
});

test("a background run asks about git push with the remote and branch as its target", () => {
  const verdict = bash({ ...PROFILE, background: true }, "git push origin main");
  expect(verdict).toMatchObject({
    allow: false,
    ask: true,
    outward: { kind: "repository", target: "origin/main" },
  });
  expect(bash({ ...PROFILE, background: true }, "git push -u origin feature/x")).toMatchObject({
    outward: { target: "origin/feature/x" },
  });
  expect(bash({ ...PROFILE, background: true }, "git push origin HEAD:refs/heads/main")).toMatchObject({
    outward: { target: "origin/main" },
  });
});

test("curl asks only when it writes, and names its URL", () => {
  expect(bash({ ...PROFILE, background: true }, "curl https://example.com")).toEqual({ allow: true });
  const post = bash({ ...PROFILE, background: true }, "curl -X POST https://example.com/hook");
  expect(post).toMatchObject({ ask: true, outward: { kind: "service", target: "https://example.com/hook" } });
  const data = bash({ ...PROFILE, background: true }, "curl --data hello https://example.com/hook");
  expect(data).toMatchObject({ ask: true, outward: { target: "https://example.com/hook" } });
});

test("an allowlisted target is not outward; a person-started run never asks for one", () => {
  const profile = { ...PROFILE, background: true, outwardAllow: ["owner", "https://example.com/hook"] };
  expect(bash(profile, "curl -X POST https://example.com/hook")).toEqual({ allow: true });
  expect(bash({ ...PROFILE, background: true }, "git push origin main")).toMatchObject({ ask: true });
  expect(bash(PROFILE, "curl -X POST https://example.com/hook")).toEqual({ allow: true });
});

test("an exact Always allow from a chat does not lift a background outward question", () => {
  const command = "curl -X POST https://example.com/hook";
  const profile = {
    ...PROFILE,
    background: true,
    alwaysAllow: [{ kind: "command" as const, value: command, cwd: CWD }],
  };
  expect(bash(profile, command)).toMatchObject({ ask: true, outward: { target: "https://example.com/hook" } });
});

test("an unknown MCP tool in a background run is an outward service call", () => {
  const profile = { ...PROFILE, background: true, allowMcp: [] };
  const verdict = match(profile, { tool: "mcp", input: { server: "calendar", tool: "create" }, cwd: CWD }, { home: HOME });
  expect(verdict).toMatchObject({
    ask: true,
    outward: { kind: "service", target: "mcp calendar.create" },
  });
});

const MESSAGE: OutwardWrite = { kind: "channel", target: "telegram:999", content: "the digest" };

test("a background message to another chat asks, names the chat, and carries the text", async () => {
  const seen: AskRequest[] = [];
  const allowed = await guardOutward(
    { access: PROFILE, ask: asker(seen), personStarted: false },
    MESSAGE,
  );
  expect(allowed).toBe(true);
  expect(seen).toHaveLength(1);
  expect(seen[0]?.prompt).toContain("telegram:999");
  expect(seen[0]?.prompt).toContain("the digest");
  expect(seen[0]?.choices).toEqual([OUTWARD_SEND_ONCE, "reject_once"]);
});

test("send once is the only answer that lets a background message go; reject refuses it", async () => {
  const before: AskRequest[] = [];
  expect(await guardOutward({ access: PROFILE, ask: asker(before, "reject_once"), personStarted: false }, MESSAGE)).toBe(false);
  const once: AskRequest[] = [];
  expect(await guardOutward({ access: PROFILE, ask: asker(once), personStarted: false }, MESSAGE)).toBe(true);
  expect(once).toHaveLength(1);
});

test("the owner's own channel and a person-started chat do not ask", async () => {
  const seen: AskRequest[] = [];
  const owner: OutwardWrite = { ...MESSAGE, owner: true };
  expect(await guardOutward({ access: PROFILE, ask: asker(seen), personStarted: false }, owner)).toBe(true);
  expect(await guardOutward({ access: PROFILE, ask: asker(seen), personStarted: true }, MESSAGE)).toBe(true);
  expect(seen).toEqual([]);
});

test("an allowlisted message target does not ask", async () => {
  const seen: AskRequest[] = [];
  const profile = { ...PROFILE, outwardAllow: ["owner", "telegram:999"] };
  expect(await guardOutward({ access: profile, ask: asker(seen), personStarted: false }, MESSAGE)).toBe(true);
  expect(seen).toEqual([]);
  expect(outwardAllowed(profile, MESSAGE)).toBe(true);
});

test("a step or action that reaches outside without a target function counts the whole call", () => {
  expect(declaredOutward({ reachesOutside: true }, { chat: "telegram:999", text: "hi" })).toEqual([
    { kind: "command", target: '{"chat":"telegram:999","text":"hi"}', content: '{"chat":"telegram:999","text":"hi"}' },
  ]);
  expect(declaredOutward({ reachesOutside: true, outward: (input) => ({ kind: "channel", target: String(input) }) }, "x")).toEqual([
    { kind: "channel", target: "x" },
  ]);
  expect(declaredOutward({}, { any: "call" })).toEqual([]);
});

test("the question names the target and keeps the whole content", () => {
  const question = outwardQuestion({ kind: "channel", target: "telegram:999", content: "line one\nline two" });
  expect(question.prompt).toContain("telegram:999");
  expect(question.prompt).toContain("line one\nline two");
});

test("outward commands are read from the profile, so a configured command is added", () => {
  const profile = { outwardCommands: ["deploy"] };
  expect(outwardCommandWrites(profile, "deploy production")).toEqual([
    { kind: "command", target: "deploy production", content: "deploy production" },
  ]);
  expect(outwardCommandWrites(profile, "git push origin main")).toEqual([]);
});
