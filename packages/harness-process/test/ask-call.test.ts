import { describe, expect, test } from "bun:test";
import type { AskAnswer, AskRequest } from "@operad-io/engine";
import {
  ALLOW_ONCE,
  askCall,
  askRequest,
  askToolEvent,
  canAsk,
  createCallAsker,
  degradedAskRequest,
  REJECT_ONCE,
} from "../src/ask-call.ts";

const LINE = JSON.stringify({
  type: "ask_call",
  id: 4,
  kind: "command",
  value: "git push origin main",
  shown: "git push origin main",
  session: "s-1",
});

describe("askCall", () => {
  test("reads an ask_call line and nothing else", () => {
    expect(askCall(LINE)).toEqual({ id: 4, kind: "command", value: "git push origin main", shown: "git push origin main", session: "s-1" });
    expect(askCall(LINE.replace('"s-1"', "null"))?.session).toBeNull();
    expect(askCall('{"type":"ask_resolved","id":4}')).toBeUndefined();
    expect(askCall('{"type":"ask_call","id":"4","kind":"command","value":"x","shown":"x","session":null}')).toBeUndefined();
    expect(askCall('{"type":"ask_call","id":4,"kind":"url","value":"x","shown":"x","session":null}')).toBeUndefined();
    expect(askCall('{"type":"ask_call","id":4,"kind":"command","value":"","shown":"x","session":null}')).toBeUndefined();
    expect(askCall("ask_call but not json")).toBeUndefined();
  });

  test("a path question carries the tool", () => {
    const line = JSON.stringify({ type: "ask_call", id: 1, kind: "path", value: "/w/a", tool: "write", shown: "/w/a", session: "s" });
    expect(askCall(line)?.tool).toBe("write");
  });
});

describe("askToolEvent", () => {
  test("an open question pauses the stall timer until it is resolved", () => {
    expect(askToolEvent(LINE)).toBe("tool-start");
    expect(askToolEvent('{"type":"ask_resolved","id":4}')).toBe("tool-end");
    expect(askToolEvent('{"type":"message_end"}')).toBeUndefined();
  });
});

describe("canAsk", () => {
  test("is true only for a profile with an askCommands rule", () => {
    expect(canAsk({ askCommands: ["git push"] })).toBe(true);
    expect(canAsk({ askPaths: ["~/.zshrc"] })).toBe(true);
    expect(canAsk({ askCommands: [], askPaths: [] })).toBe(false);
    expect(canAsk({ denyCommands: ["rm"] })).toBe(false);
    expect(canAsk(null)).toBe(false);
  });
});

describe("askRequest", () => {
  const call = askCall(LINE);
  if (call === undefined) throw new Error("the line must parse");

  test("offers allow_once and reject_once, and a late answer resumes the session with a grant for the call", () => {
    expect(askRequest(call)).toEqual({
      prompt: "Run this command? git push origin main",
      choices: [ALLOW_ONCE, REJECT_ONCE],
      resume: { session: "s-1", grant: { kind: "command", value: "git push origin main", choice: ALLOW_ONCE } },
    });
  });

  test("a path question names the tool in the grant", () => {
    const path = askCall(JSON.stringify({ type: "ask_call", id: 1, kind: "path", value: "/w/a", tool: "write", shown: "/w/a", session: "s" }));
    if (path === undefined) throw new Error("the line must parse");
    expect(askRequest(path).resume).toEqual({ session: "s", grant: { kind: "path", value: "/w/a", choice: ALLOW_ONCE, tool: "write" } });
  });

  test("without a session nothing can be continued: the question rejects once after the grace", () => {
    const request = askRequest({ ...call, session: null });
    expect(request.onTimeout).toBe("reject_once");
    expect(request.resume).toBeUndefined();
  });

  test("a harness that cannot enforce a grant asks with reject_once and no grant", () => {
    expect(degradedAskRequest("Run it?")).toEqual({ prompt: "Run it?", choices: [ALLOW_ONCE, REJECT_ONCE], onTimeout: "reject_once" });
  });
});

describe("createCallAsker", () => {
  function setup(answer: (request: AskRequest) => Promise<AskAnswer>, secrets: readonly string[] = []) {
    const sent: Array<Record<string, unknown>> = [];
    const asked: AskRequest[] = [];
    let stops = 0;
    const asker = createCallAsker({
      ask: (request) => {
        asked.push(request);
        return answer(request);
      },
      onStop: () => {
        stops += 1;
      },
      secrets,
    });
    const reply = (text: string): void => {
      sent.push(JSON.parse(text) as Record<string, unknown>);
    };
    return { asker, sent, asked, reply, stops: () => stops };
  }

  test("allow_once answers allow", async () => {
    const env = setup(async () => ({ choice: ALLOW_ONCE }));
    await env.asker.handle(LINE, env.reply);
    expect(env.sent).toEqual([{ type: "ask_ack", id: 4, decision: "allow" }]);
    expect(env.asker.stopped()).toBeUndefined();
  });

  test("reject_once and a timeout rejection answer deny", async () => {
    const refused = setup(async () => ({ choice: REJECT_ONCE }));
    await refused.asker.handle(LINE, refused.reply);
    expect(refused.sent[0]).toMatchObject({ decision: "deny" });
    const silent = setup(async () => ({ choice: undefined, rejected: true }));
    await silent.asker.handle(LINE, silent.reply);
    expect(silent.sent[0]).toMatchObject({ decision: "deny", reason: "nobody answered in time" });
  });

  test("a question that ends the wait answers stop, ends the program once and keeps the error", async () => {
    const timeout = new Error("grace passed");
    const env = setup(() => Promise.reject(timeout));
    await env.asker.handle(LINE, env.reply);
    expect(env.sent).toEqual([{ type: "ask_ack", id: 4, decision: "stop" }]);
    expect(env.stops()).toBe(1);
    expect(env.asker.stopped()?.error).toBe(timeout);
    // A later question is not asked: the program is going away.
    await env.asker.handle(LINE.replace('"id":4', '"id":5'), env.reply);
    expect(env.sent[1]).toEqual({ type: "ask_ack", id: 5, decision: "stop" });
    expect(env.asked).toHaveLength(1);
    expect(env.stops()).toBe(1);
  });

  test("questions are asked one at a time", async () => {
    const open: string[] = [];
    let most = 0;
    const env = setup(async () => {
      open.push("q");
      most = Math.max(most, open.length);
      await Promise.resolve();
      await Promise.resolve();
      open.pop();
      return { choice: ALLOW_ONCE };
    });
    await Promise.all([env.asker.handle(LINE, env.reply), env.asker.handle(LINE.replace('"id":4', '"id":5'), env.reply)]);
    expect(most).toBe(1);
    expect(env.sent.map((entry) => entry["id"])).toEqual([4, 5]);
  });

  test("a call that holds a secret value is refused and nobody is asked", async () => {
    const env = setup(async () => ({ choice: ALLOW_ONCE }), ["hunter2hunter2"]);
    await env.asker.handle(LINE.replaceAll("origin main", "hunter2hunter2"), env.reply);
    expect(env.sent[0]).toMatchObject({ decision: "deny" });
    expect(env.asked).toHaveLength(0);
  });

  test("any other line is left alone", async () => {
    const env = setup(async () => ({ choice: ALLOW_ONCE }));
    await env.asker.handle('{"type":"message_end"}', env.reply);
    expect(env.sent).toEqual([]);
  });
});
