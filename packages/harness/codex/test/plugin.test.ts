import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MemoryPluginStore,
  PluginRegistry,
  validateUsage,
  type PluginStepResult,
} from "@operad-io/engine";
import { FLUSH_MS } from "@operad-io/harness-process";
import {
  alive,
  cleanupTempRoots,
  manualClock,
  tempRoot,
  waitForFile,
  waitForGone,
  waitForPid,
  type ManualClock,
} from "@operad-io/harness-process/test-support";
import { CANCEL_GRACE_MS, SESSION_MODE, createCodexHarnessPlugin, failureOf } from "../src/index.ts";

afterAll(cleanupTempRoots);

const FAKE = fileURLToPath(new URL("./fake-codex-acp.ts", import.meta.url));

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length > 0) restores.pop()?.();
});

function setEnv(name: string, value: string): void {
  const previous = process.env[name];
  process.env[name] = value;
  restores.push(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

interface TestEnv {
  readonly root: string;
  readonly clock: ManualClock;
  readonly registry: PluginRegistry;
  readonly record: string;
  readonly marker: string;
  readonly release: string;
}

async function setup(
  mode: string,
  options: { readonly settings?: Record<string, unknown>; readonly clock?: ManualClock; readonly vars?: Record<string, string> } = {},
): Promise<TestEnv> {
  const root = await tempRoot();
  const record = join(root, "record.jsonl");
  const marker = join(root, "marker");
  const release = join(root, "release");
  setEnv("FAKE_CODEX_MODE", mode);
  setEnv("FAKE_CODEX_RECORD", record);
  setEnv("FAKE_CODEX_MARKER", marker);
  setEnv("FAKE_CODEX_RELEASE", release);
  for (const [name, value] of Object.entries(options.vars ?? {})) setEnv(name, value);

  const clock = options.clock ?? manualClock();
  const plugin = createCodexHarnessPlugin({ clock, now: () => 1000, codex: [process.execPath, FAKE] });
  const registry = new PluginRegistry([plugin], {
    home: root,
    cwd: root,
    store: new MemoryPluginStore({ root: join(root, "store") }),
    settings: { codex: { command: [process.execPath, FAKE], ...(options.settings ?? {}) } },
  });
  return { root, clock, registry, record, marker, release };
}

function dataOf(result: PluginStepResult): Record<string, unknown> {
  return (result.data ?? {}) as Record<string, unknown>;
}

function sent(env: TestEnv): Record<string, unknown>[] {
  return readFileSync(env.record, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function methods(env: TestEnv): string[] {
  return sent(env).flatMap((message) => (typeof message.method === "string" ? [message.method] : []));
}

async function logLines(result: PluginStepResult): Promise<Record<string, unknown>[]> {
  const text = await Bun.file(String(dataOf(result).log)).text();
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function runAgent(
  env: TestEnv,
  params: Record<string, unknown>,
  options: {
    readonly signal?: AbortSignal;
    readonly access?: Record<string, unknown>;
    readonly asker?: {
      readonly ask: (request: { readonly prompt: string }) => Promise<{
        readonly kind: "answered";
        readonly answer: { readonly choice: string | undefined };
      }>;
      readonly useGrant: (waitId: string) => Promise<boolean>;
    };
  } = {},
) {
  return env.registry.runStep("codex/agent", params, {
    runId: "run-1",
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.access === undefined ? {} : { access: options.access as never }),
    ...(options.asker === undefined ? {} : { asker: options.asker as never }),
  });
}

describe("codex/agent: a prompt run", () => {
  test("a prompt runs to the end over ACP and the tool calls are in the log", async () => {
    const env = await setup("done");
    const result = await runAgent(env, { prompt: "hello", cwd: env.root });
    expect(result.result).toBe("done");
    const data = dataOf(result);
    expect(data.sessionId).toBe("fake-session-1");
    expect(data.finalMessage).toBe("all done (1 blocks)");
    expect(data.exitCode).toBe(0);

    // The conversation the client had with the agent.
    expect(methods(env)).toEqual([
      "initialize",
      "session/new",
      "session/set_config_option",
      "session/prompt",
    ]);
    const messages = sent(env);
    expect((messages[0]?.params as Record<string, unknown>).protocolVersion).toBe(1);
    expect((messages[1]?.params as Record<string, unknown>).cwd).toBe(env.root);
    // Codex's own sandbox stays on: workspace-write, not agent-full-access.
    expect(SESSION_MODE).toBe("workspace-write");
    expect(messages[2]?.params).toEqual({ sessionId: "fake-session-1", configId: "mode", value: "workspace-write" });
    expect(messages[3]?.params).toEqual({ sessionId: "fake-session-1", prompt: [{ type: "text", text: "hello" }] });

    // Every tool call is logged: start, an output head, end; a failure has its first error line.
    const lines = await logLines(result);
    const starts = lines.filter((line) => line.type === "tool_execution_start");
    expect(starts.map((line) => [line.toolCallId, line.toolName, line.input])).toEqual([
      ["t1", "bash", "make test"],
      ["t2", "edit", "/w/a.ts"],
      ["img1", "image_gen", "Image generation"],
    ]);
    expect(starts[0]?.at).toBe(1000);
    const outputs = lines.filter((line) => line.type === "tool_output");
    expect(outputs[0]).toEqual({ type: "tool_output", toolCallId: "t1", text: "all green\nsecond line" });
    const ends = lines.filter((line) => line.type === "tool_execution_end");
    expect(ends.map((line) => [line.toolCallId, line.isError, line.error])).toEqual([
      ["t1", false, undefined],
      ["t2", true, "could not write"],
      ["img1", false, undefined],
    ]);
    expect(lines.filter((line) => line.type === "thinking_delta")).toHaveLength(1);
    expect(lines.filter((line) => line.type === "text_delta").map((line) => line.text)).toEqual(["starting. ", "all ", "done (1 blocks)"]);
    expect(lines.at(-2)?.type).toBe("message_end");
    expect(lines.at(-1)?.type).toBe("result");
  });

  test("the usage has the token counts and an unknown cost, never 0", async () => {
    const env = await setup("done", { settings: { model: "gpt-fake" } });
    const result = await runAgent(env, { prompt: "hello", cwd: env.root });
    const usage = validateUsage(dataOf(result).usage);
    expect(usage.ok).toBe(true);
    expect(dataOf(result).usage).toEqual({
      harness: "codex",
      model: "gpt-fake",
      tokens: { input: 11, output: 7, cacheread: 3, cachewrite: 5 },
      costMicros: null,
      costQuality: null,
    });
  });

  test("--model and --effort become session settings after the mode, and other args are refused", async () => {
    const env = await setup("done");
    const result = await runAgent(env, { prompt: "hi", cwd: env.root, args: ["--model", "gpt-5.5", "--effort", "high"] });
    expect(result.result).toBe("done");
    const settings = sent(env)
      .filter((message) => message.method === "session/set_config_option")
      .map((message) => [(message.params as Record<string, unknown>).configId, (message.params as Record<string, unknown>).value]);
    expect(settings).toEqual([
      ["mode", "workspace-write"],
      ["model", "gpt-5.5"],
      ["reasoning_effort", "high"],
    ]);

    const refused = await runAgent(env, { prompt: "hi", cwd: env.root, args: ["--sandbox", "none"] });
    expect(refused.result).toBe("failed");
    expect(dataOf(refused).reason).toBe("invalid_args");
    expect(String(dataOf(refused).message)).toContain('unknown entry "--sandbox"');
  });

  test("an image is sent with the prompt as an image block", async () => {
    const env = await setup("done");
    const png = join(env.root, "ref.png");
    writeFileSync(png, "not really a png");
    const result = await runAgent(env, { prompt: "look", cwd: env.root, images: [{ path: png, mediaType: "image/png" }] });
    expect(result.result).toBe("done");
    const prompt = sent(env).find((message) => message.method === "session/prompt");
    const blocks = (prompt?.params as { prompt: Record<string, unknown>[] }).prompt;
    expect(blocks[1]).toEqual({ type: "image", data: Buffer.from("not really a png").toString("base64"), mimeType: "image/png" });
  });
});

describe("codex/agent: image generations", () => {
  test("each image_gen call of the attempt is counted in the step result and its log", async () => {
    const env = await setup("images");
    const result = await runAgent(env, { prompt: "draw", cwd: env.root });
    expect(result.result).toBe("done");
    expect(dataOf(result).imageGenCalls).toBe(2);
    const lines = await logLines(result);
    expect(lines.at(-1)?.imageGenCalls).toBe(2);
    expect(lines.filter((line) => line.toolName === "image_gen" && line.type === "tool_execution_start")).toHaveLength(2);
  });

  test("a run without one counts 0", async () => {
    const env = await setup("permission", { vars: { FAKE_CODEX_COMMAND: "make test" } });
    const result = await runAgent(env, { prompt: "x", cwd: env.root });
    expect(dataOf(result).imageGenCalls).toBe(0);
  });

  test("silence while an image generation is open is not a stall", async () => {
    const env = await setup("silent-image");
    // The step logs a tool call's start after the stall timer was paused for it.
    let opened: () => void = () => undefined;
    const toolOpen = new Promise<void>((resolve) => {
      opened = resolve;
    });
    const running = env.registry.runStep(
      "codex/agent",
      { prompt: "draw", cwd: env.root, wallTimeSecs: 300, stallSecs: 1 },
      { runId: "run-1", receiver: (line) => (line.includes("tool_execution_start") ? opened() : undefined) },
    );
    await toolOpen;
    // Twice the stall limit passes with no line and no stop: the generation is open.
    expect(env.clock.fireBetween(FLUSH_MS, 2_000)).toBe(0);
    writeFileSync(env.release, "settle");
    const result = await running;
    expect(result.result).toBe("done");
    expect(dataOf(result).imageGenCalls).toBe(1);
    const outputs = (await logLines(result)).filter((line) => line.type === "tool_output");
    expect(String(outputs[0]?.text)).toContain("saved /tmp/fox.png");
  });

  test("silence with no tool call open is a stall", async () => {
    const env = await setup("silent");
    const running = runAgent(env, { prompt: "x", cwd: env.root, wallTimeSecs: 300, stallSecs: 1 });
    await waitForFile(env.marker);
    await env.clock.when(() => env.clock.clears > 0);
    const pid = await waitForPid(env.marker);
    env.clock.fireUpTo(1000);
    const result = await running;
    expect(result.result).toBe("failed");
    expect(dataOf(result).reason).toBe("stall");
    await waitForGone(pid);
  });
});

describe("codex/agent: permissions", () => {
  function permissionOutcome(env: TestEnv): unknown {
    const line = readFileSync(env.record, "utf8")
      .split("\n")
      .filter((text) => text.includes("permissionResponse"))
      .map((text) => JSON.parse(text) as { permissionResponse: { outcome: unknown } })[0];
    return line?.permissionResponse.outcome;
  }

  test("without a rule the call is allowed once, never always", async () => {
    const env = await setup("permission");
    const result = await runAgent(env, { prompt: "x", cwd: env.root });
    expect(result.result).toBe("done");
    expect(permissionOutcome(env)).toEqual({ outcome: "selected", optionId: "approve" });
    expect(dataOf(result).finalMessage).toBe("it ran");
  });

  test("a command the profile denies is rejected and logged as blocked", async () => {
    const env = await setup("permission");
    const result = await runAgent(env, { prompt: "x", cwd: env.root }, { access: { denyCommands: ["rm -rf"] } });
    expect(result.result).toBe("done");
    expect(permissionOutcome(env)).toEqual({ outcome: "selected", optionId: "deny" });
    expect(dataOf(result).finalMessage).toBe("it was refused");
    const lines = await logLines(result);
    expect(lines.some((line) => line.type === "blocked" && line.toolName === "bash")).toBe(true);
    // The refused call's own error text is not kept in the log.
    const end = lines.find((line) => line.type === "tool_execution_end" && line.toolCallId === "p1");
    expect(end?.isError).toBe(true);
    expect(end?.error).toBeUndefined();
    const start = lines.find((line) => line.type === "tool_execution_start" && line.toolCallId === "p1");
    expect(String(start?.input)).toContain("denied by the access profile");
  });

  test("a network request with no command is allowed once even where a command rule is set", async () => {
    const env = await setup("permission-network");
    const result = await runAgent(env, { prompt: "x", cwd: env.root }, { access: { denyCommands: ["curl"] } });
    expect(result.result).toBe("done");
    expect(permissionOutcome(env)).toEqual({ outcome: "selected", optionId: "approve" });
  });

  test("a network request that carries a command is judged as that command", async () => {
    const env = await setup("permission-network", { vars: { FAKE_CODEX_COMMAND: "curl https://example.com" } });
    await runAgent(env, { prompt: "x", cwd: env.root }, { access: { denyCommands: ["curl"] } });
    expect(permissionOutcome(env)).toEqual({ outcome: "selected", optionId: "deny" });
  });

  test("a path the profile denies is rejected for an edit", async () => {
    const env = await setup("permission-edit", { vars: { FAKE_CODEX_PATH: "/etc/passwd" } });
    await runAgent(env, { prompt: "x", cwd: env.root }, { access: { denyPaths: ["/etc"] } });
    expect(permissionOutcome(env)).toEqual({ outcome: "selected", optionId: "deny" });
  });

  test("a one-time grant lets the refused call through once, through the host", async () => {
    const env = await setup("permission");
    const used: string[] = [];
    const result = await runAgent(
      env,
      { prompt: "x", cwd: env.root },
      {
        access: { denyCommands: ["rm -rf"], grants: [{ waitId: "w1", kind: "command", value: "rm -rf build" }] },
        asker: {
          ask: () => Promise.reject(new Error("no question here")),
          useGrant: (waitId) => {
            used.push(waitId);
            return Promise.resolve(true);
          },
        },
      },
    );
    expect(result.result).toBe("done");
    expect(used).toEqual(["w1"]);
    expect(permissionOutcome(env)).toEqual({ outcome: "selected", optionId: "approve" });
  });

  test("a grant the host refuses to use does not let the call through", async () => {
    const env = await setup("permission");
    await runAgent(
      env,
      { prompt: "x", cwd: env.root },
      {
        access: { denyCommands: ["rm -rf"], grants: [{ waitId: "w1", kind: "command", value: "rm -rf build" }] },
        asker: { ask: () => Promise.reject(new Error("no")), useGrant: () => Promise.resolve(false) },
      },
    );
    expect(permissionOutcome(env)).toEqual({ outcome: "selected", optionId: "deny" });
  });

  test("a call that must ask goes to a person; allow_once lets it through", async () => {
    const env = await setup("permission");
    const asked: string[] = [];
    const result = await runAgent(
      env,
      { prompt: "x", cwd: env.root },
      {
        access: { askCommands: ["rm -rf"] },
        asker: {
          ask: (request) => {
            asked.push(request.prompt);
            return Promise.resolve({ kind: "answered", answer: { choice: "allow_once" } });
          },
          useGrant: () => Promise.resolve(false),
        },
      },
    );
    expect(result.result).toBe("done");
    expect(asked).toEqual(["Run this command? rm -rf build"]);
    expect(permissionOutcome(env)).toEqual({ outcome: "selected", optionId: "approve" });
  });

  test("a person who refuses leaves the call rejected", async () => {
    const env = await setup("permission");
    await runAgent(
      env,
      { prompt: "x", cwd: env.root },
      {
        access: { askCommands: ["rm -rf"] },
        asker: { ask: () => Promise.resolve({ kind: "answered", answer: { choice: "reject_once" } }), useGrant: () => Promise.resolve(false) },
      },
    );
    expect(permissionOutcome(env)).toEqual({ outcome: "selected", optionId: "deny" });
  });

  test("the step declares what it applies and that it can resume", async () => {
    const env = await setup("done");
    const type = env.registry.stepTypes().find((item) => item.name === "codex/agent");
    expect(type?.resumable).toBe(true);
    expect(type?.results).toEqual(["done", "failed", "interrupted", "waiting"]);
    expect(type?.timeoutSecs).toBeGreaterThan(3600);
  });
});

describe("codex/agent: model errors", () => {
  test("an exhausted ChatGPT quota is a usage_limit model error", async () => {
    const env = await setup("usage-limit");
    const result = await runAgent(env, { prompt: "x", cwd: env.root });
    expect(result.result).toBe("failed");
    const data = dataOf(result);
    expect(data.reason).toBe("model_error");
    expect(data.modelError).toEqual({
      kind: "usage_limit",
      status: null,
      retry_after_secs: null,
      message: "Your ChatGPT allowance is used up. Try again later.",
    });
  });

  test("a model codex-acp does not offer is an unavailable model error", async () => {
    const env = await setup("bad-model");
    const result = await runAgent(env, { prompt: "x", cwd: env.root, args: ["--model", "gpt-nope"] });
    expect(result.result).toBe("failed");
    expect(dataOf(result).reason).toBe("model_error");
    expect((dataOf(result).modelError as Record<string, unknown>).kind).toBe("unavailable");
    expect(String(dataOf(result).message)).toContain("gpt-nope");
  });

  test("an effort the model does not take is invalid_args, not a model error", async () => {
    const env = await setup("bad-effort");
    const result = await runAgent(env, { prompt: "x", cwd: env.root, args: ["--effort", "xhigh"] });
    expect(dataOf(result).reason).toBe("invalid_args");
    expect("modelError" in dataOf(result)).toBe(false);
  });

  test("no login is not_logged_in", async () => {
    const env = await setup("auth");
    const result = await runAgent(env, { prompt: "x", cwd: env.root });
    expect(dataOf(result).reason).toBe("not_logged_in");
  });

  test("the error info maps to the kinds dev and pool act on", () => {
    const error = (info: unknown, stage: "prompt" | "session" = "prompt") =>
      ({ kind: "error", stage, error: { code: -32603, message: "Internal error", data: { message: "m", codexErrorInfo: info } }, sessionId: null }) as const;
    expect(failureOf(error("rateLimitExceeded"), undefined).modelError).toEqual({ kind: "usage_limit" });
    expect(failureOf(error("serverOverloaded"), undefined).modelError).toEqual({ kind: "unavailable" });
    expect(failureOf(error({ httpConnectionFailed: {} }), undefined).modelError).toEqual({ kind: "protocol" });
  });
});

describe("codex/agent: cancel", () => {
  test("a cancel sends session/cancel and the step is interrupted when codex-acp answers", async () => {
    const env = await setup("cancel");
    const controller = new AbortController();
    const running = runAgent(env, { prompt: "x", cwd: env.root }, { signal: controller.signal });
    const pid = await waitForPid(env.marker);
    controller.abort();
    const result = await running;
    expect(result.result).toBe("interrupted");
    expect(dataOf(result).reason).toBe("cancelled");
    expect(methods(env)).toContain("session/cancel");
    await waitForGone(pid);
  });

  test("an agent that ignores the cancel is ended after the grace", async () => {
    const manual = manualClock();
    let armed: () => void = () => undefined;
    const waitArmed = new Promise<void>((resolve) => {
      armed = resolve;
    });
    const clock: ManualClock = {
      ...manual,
      setTimeout(handler, ms) {
        const handle = manual.setTimeout(handler, ms);
        if (ms === CANCEL_GRACE_MS) armed();
        return handle;
      },
      clearTimeout: (handle) => manual.clearTimeout(handle),
      fireUpTo: (max) => manual.fireUpTo(max),
      fireBetween: (min, max) => manual.fireBetween(min, max),
      when: (predicate) => manual.when(predicate),
      get sleeps() {
        return manual.sleeps;
      },
      get clears() {
        return manual.clears;
      },
    };
    const env = await setup("cancel-ignored", { clock });
    const controller = new AbortController();
    const running = runAgent(env, { prompt: "x", cwd: env.root }, { signal: controller.signal });
    const pid = await waitForPid(env.marker);
    controller.abort();
    await waitArmed;
    expect(alive(pid)).toBe(true);
    manual.fireUpTo(CANCEL_GRACE_MS);
    const result = await running;
    expect(result.result).toBe("interrupted");
    await waitForGone(pid);
  });

  test("a run aborted before it starts is interrupted without a prompt", async () => {
    const env = await setup("done");
    const controller = new AbortController();
    controller.abort();
    const result = await runAgent(env, { prompt: "x", cwd: env.root }, { signal: controller.signal });
    expect(result.result).toBe("interrupted");
  });
});

describe("codex/agent: resume", () => {
  test("a resumed run loads the session instead of opening one, and what it replays is not this run's", async () => {
    const env = await setup("done");
    const result = await runAgent(env, { prompt: "go on", cwd: env.root, resumeSession: "old-session" });
    expect(result.result).toBe("done");
    expect(methods(env)).toEqual(["initialize", "session/load", "session/set_config_option", "session/prompt"]);
    const load = sent(env).find((message) => message.method === "session/load");
    expect(load?.params).toEqual({ sessionId: "old-session", cwd: env.root, mcpServers: [] });
    // A resumed run continues the session it was given.
    expect(dataOf(result).sessionId).toBe("old-session");
    // The replayed image generation and message are not in the log and not counted.
    const lines = await logLines(result);
    expect(JSON.stringify(lines)).not.toContain("an earlier message");
    expect(lines.some((line) => line.toolCallId === "old1")).toBe(false);
    expect(dataOf(result).imageGenCalls).toBe(1);
  });

  test("an agent without session/load cannot resume: the step fails and says why", async () => {
    const env = await setup("no-load");
    const result = await runAgent(env, { prompt: "go on", cwd: env.root, resumeSession: "old-session" });
    expect(result.result).toBe("failed");
    expect(dataOf(result).reason).toBe("session_missing");
    expect(methods(env)).not.toContain("session/prompt");
  });
});

describe("codex check", () => {
  test("reports the codex-acp and codex versions and the login", async () => {
    const env = await setup("done");
    const checks = await env.registry.checks();
    const check = checks.find((item) => item.plugin === "codex");
    expect(check?.ok).toBe(true);
    expect(check?.message).toContain("codex-acp 9.9.9");
    expect(check?.message).toContain("codex 9.9.9");
    expect(check?.message).toContain("login ChatGPT");
  });

  test("refuses when Codex is not logged in", async () => {
    const env = await setup("done", { vars: { FAKE_CODEX_LOGIN: "out" } });
    const check = (await env.registry.checks()).find((item) => item.plugin === "codex");
    expect(check?.ok).toBe(false);
    expect(check?.message).toContain("not logged in");
  });

  test("refuses when codex-acp cannot start", async () => {
    const env = await setup("done", { settings: { command: [process.execPath, join(tempRootless(), "missing.ts")] } });
    const check = (await env.registry.checks()).find((item) => item.plugin === "codex");
    expect(check?.ok).toBe(false);
    expect(check?.message).toContain("cannot start");
  });
});

function tempRootless(): string {
  return fileURLToPath(new URL("./does-not-exist/", import.meta.url));
}
