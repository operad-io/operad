import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  defineFlow,
  MemoryPluginStore,
  PluginRegistry,
  validateUsage,
  type FlowDefinition,
  type PluginStepResult,
} from "@operad-io/engine";
import { readTargetGrants } from "@operad-io/access-match";
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
} from "../../process/test/support.ts";
import {
  APPROVAL_POLICY,
  CANCEL_GRACE_MS,
  SANDBOX_MODE,
  createCodexHarnessPlugin,
  failureOf,
} from "../src/index.ts";

afterAll(cleanupTempRoots);

const FAKE = fileURLToPath(new URL("./fake-codex-app-server.ts", import.meta.url));

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
  options: {
    readonly settings?: Record<string, unknown>;
    readonly clock?: ManualClock;
    readonly vars?: Record<string, string>;
    readonly now?: (() => number) | undefined;
  } = {},
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
  const plugin = createCodexHarnessPlugin({
    clock,
    now: options.now ?? (() => 1000),
    codex: [process.execPath, FAKE],
  });
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

function paramsOf(env: TestEnv, method: string): Record<string, unknown>[] {
  return sent(env)
    .filter((message) => message.method === method)
    .map((message) => (message.params ?? {}) as Record<string, unknown>);
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
    readonly trigger?: Record<string, unknown>;
    readonly asker?: {
      readonly ask: (request: { readonly prompt: string }) => Promise<{
        readonly kind: "answered";
        readonly answer: {
          readonly choice: string | undefined;
          readonly actor?: { readonly via: string; readonly id: string };
        };
      }>;
      readonly useGrant: (waitId: string) => Promise<boolean>;
    };
    readonly flow?: FlowDefinition;
  } = {},
) {
  return env.registry.runStep("codex/agent", params, {
    runId: "run-1",
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.access === undefined ? {} : { access: options.access as never }),
    ...(options.trigger === undefined ? {} : { trigger: options.trigger as never }),
    ...(options.asker === undefined ? {} : { asker: options.asker as never }),
    ...(options.flow === undefined ? {} : { flow: options.flow }),
  });
}

describe("codex/agent: a prompt run", () => {
  test("a prompt runs to the end over app-server and the tool calls are in the log", async () => {
    const env = await setup("done");
    const result = await runAgent(env, { prompt: "hello", cwd: env.root });
    expect(result.result).toBe("done");
    const data = dataOf(result);
    expect(data.sessionId).toBe("fake-thread-1");
    expect(data.finalMessage).toBe("all done (1 blocks)");
    expect(data.exitCode).toBe(0);

    expect(methods(env)).toEqual(["initialize", "initialized", "thread/start", "turn/start"]);
    const start = paramsOf(env, "thread/start")[0];
    expect(start?.cwd).toBe(env.root);
    expect(start?.approvalPolicy).toBe(APPROVAL_POLICY);
    expect(start?.approvalsReviewer).toBe("user");
    expect(start?.sandbox).toBe(SANDBOX_MODE);
    const turn = paramsOf(env, "turn/start")[0];
    expect(turn?.threadId).toBe("fake-thread-1");
    expect(turn?.input).toEqual([{ type: "text", text: "hello", text_elements: [] }]);

    const lines = await logLines(result);
    const starts = lines.filter((line) => line.type === "tool_execution_start");
    expect(starts.map((line) => [line.toolCallId, line.toolName, line.input])).toEqual([
      ["t1", "bash", "make test"],
      ["t2", "edit", "/w/a.ts"],
      ["t3", "bash", "false"],
      ["img1", "image_gen", "Image generation"],
    ]);
    expect(starts[0]?.at).toBe(1000);
    const outputs = lines.filter((line) => line.type === "tool_output");
    expect(outputs[0]).toMatchObject({ type: "tool_output", toolCallId: "t1", text: "all green\nsecond line" });
    expect(outputs.find((line) => line.toolCallId === "t2")?.text).toBe("changed /w/a.ts");
    expect(outputs.find((line) => line.toolCallId === "t3")?.text).toBe("could not write\nmore");
    expect(lines[0]).toMatchObject({ type: "session", sessionId: "fake-thread-1" });
    expect(lines.every((line) => typeof line.receivedAt === "number")).toBe(true);
    const ends = lines.filter((line) => line.type === "tool_execution_end");
    expect(ends.map((line) => [line.toolCallId, line.isError, line.error])).toEqual([
      ["t1", false, undefined],
      ["t2", false, undefined],
      ["t3", true, "could not write"],
      ["img1", false, undefined],
    ]);
    expect(lines.filter((line) => line.type === "thinking_delta")).toHaveLength(1);
    expect(lines.filter((line) => line.type === "text_delta").map((line) => line.text).join("")).toContain("all done (1 blocks)");
    expect(lines.at(-2)?.type).toBe("message_end");
    expect(lines.at(-1)?.type).toBe("result");
  });

  test("a prompt that starts with a slash reaches the model as text, never as one of codex's commands", async () => {
    const env = await setup("done");
    const result = await runAgent(env, { prompt: "/clear hi", cwd: env.root });
    expect(result.result).toBe("done");
    expect(paramsOf(env, "turn/start")[0]?.input).toEqual([
      { type: "text", text: "/clear hi", text_elements: [] },
    ]);
  });

  test("a scripted run gives the time to its session line, to the first increment, and the whole step", async () => {
    const times = [1_000, 2_000];
    const env = await setup("done", { now: () => times.shift() ?? 9_000 });
    const result = await runAgent(env, { prompt: "hello", cwd: env.root });
    expect(result.result).toBe("done");
    const data = dataOf(result);
    expect(data.timings).toEqual({
      startToReadyMs: 1_000,
      readyToFirstMs: 7_000,
      totalMs: 8_000,
    });
    expect(data.durationMs).toBe(8_000);
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
    expect(dataOf(result).context).toEqual({ used: 19, window: 200_000 });
  });

  test("--model and --effort become thread and turn settings, and other args are refused", async () => {
    const env = await setup("done");
    const result = await runAgent(env, { prompt: "hi", cwd: env.root, args: ["--model", "gpt-5.5", "--effort", "high"] });
    expect(result.result).toBe("done");
    expect(paramsOf(env, "thread/start")[0]?.model).toBe("gpt-5.5");
    expect(paramsOf(env, "turn/start")[0]?.effort).toBe("high");

    const refused = await runAgent(env, { prompt: "hi", cwd: env.root, args: ["--sandbox", "none"] });
    expect(refused.result).toBe("failed");
    expect(dataOf(refused).reason).toBe("invalid_args");
    expect(String(dataOf(refused).message)).toContain('unknown entry "--sandbox"');
  });

  test("operad's tools and mounted servers reach Codex as mcp_servers config", async () => {
    const env = await setup("done");
    const result = await runAgent(env, {
      prompt: "hello",
      cwd: env.root,
      operadTools: { home: env.root },
      mcpServers: { extra: { command: "/bin/extra", args: ["--serve"] } },
    });
    expect(result.result).toBe("done");
    const config = paramsOf(env, "thread/start")[0]?.config as { mcp_servers?: Record<string, unknown> } | undefined;
    const servers = config?.mcp_servers ?? {};
    expect(Object.keys(servers).sort()).toEqual(["extra", "operad"]);
    expect(servers.operad).toMatchObject({ env: { OPERAD_HOME: env.root } });
    expect(servers.extra).toEqual({ command: "/bin/extra", args: ["--serve"] });
  });

  test("an image is sent with the prompt as a local image", async () => {
    const env = await setup("done");
    const png = join(env.root, "ref.png");
    writeFileSync(png, "not really a png");
    const result = await runAgent(env, { prompt: "look", cwd: env.root, images: [{ path: png, mediaType: "image/png" }] });
    expect(result.result).toBe("done");
    const turn = paramsOf(env, "turn/start")[0];
    expect(turn?.input).toEqual([
      { type: "text", text: "look", text_elements: [] },
      { type: "localImage", path: png },
    ]);
  });

  test("given skills are listed in the prompt with their description and path, never their body", async () => {
    const env = await setup("done");
    const dir = join(env.root, "skills", "weather");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      "---\nname: weather\ndescription: tells the forecast for a city\n---\n\nBody text the agent must read itself.\n",
    );
    const result = await runAgent(env, { prompt: "hello", cwd: env.root, skills: [dir] });
    expect(result.result).toBe("done");
    const turn = paramsOf(env, "turn/start")[0];
    expect(turn?.input).toEqual([
      {
        type: "text",
        text: [
          "hello",
          "",
          "Read a skill's SKILL.md before doing what it describes.",
          `- weather: tells the forecast for a city (SKILL.md at ${join(dir, "SKILL.md")})`,
        ].join("\n"),
        text_elements: [],
      },
    ]);
    expect(JSON.stringify(turn?.input)).not.toContain("Body text the agent must read itself.");
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
      .map((text) => JSON.parse(text) as { permissionResponse: { decision?: unknown } })[0];
    return line?.permissionResponse.decision;
  }

  test("without a rule the call is allowed once, never for the session", async () => {
    const env = await setup("permission");
    const result = await runAgent(env, { prompt: "x", cwd: env.root });
    expect(result.result).toBe("done");
    expect(permissionOutcome(env)).toBe("accept");
    expect(dataOf(result).finalMessage).toBe("it ran");
  });

  test("a step a flow generates with no profile still gets the default", async () => {
    const env = await setup("permission", { vars: { FAKE_CODEX_COMMAND: "sudo ls" } });
    const result = await runAgent(env, { prompt: "x", cwd: env.root });
    expect(result.result).toBe("done");
    expect(permissionOutcome(env)).toBe("decline");
    expect(dataOf(result).finalMessage).toBe("it was refused");
  });

  test("the live level file is read for the permission request, not only at the start", async () => {
    const env = await setup("permission", { vars: { FAKE_CODEX_COMMAND: "touch hi" } });
    const directory = join(env.root, "chat");
    mkdirSync(directory, { recursive: true });
    const levelFile = join(directory, "access.json");
    const base = { denyPaths: [directory] };
    writeFileSync(levelFile, JSON.stringify({ access: base, level: "ask" }));
    const asked: string[] = [];
    const result = await runAgent(
      env,
      { prompt: "x", cwd: env.root },
      {
        access: { level: "full", levelFile, denyPaths: [directory] },
        asker: {
          ask: (request) => {
            asked.push(request.prompt);
            return Promise.resolve({ kind: "answered" as const, answer: { choice: "allow_once" } });
          },
          useGrant: () => Promise.resolve(false),
        },
      },
    );
    expect(result.result).toBe("done");
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("touch hi");
    expect(permissionOutcome(env)).toBe("accept");
  });

  test("a command the profile denies is rejected and logged as blocked", async () => {
    const env = await setup("permission");
    const result = await runAgent(env, { prompt: "x", cwd: env.root }, { access: { denyCommands: ["rm -rf"] } });
    expect(result.result).toBe("done");
    expect(permissionOutcome(env)).toBe("decline");
    expect(dataOf(result).finalMessage).toBe("it was refused");
    const lines = await logLines(result);
    expect(lines.some((line) => line.type === "blocked" && line.toolName === "bash")).toBe(true);
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
    expect(permissionOutcome(env)).toBe("accept");
  });

  test("a network request that carries a command is judged as that command", async () => {
    const env = await setup("permission-network", { vars: { FAKE_CODEX_COMMAND: "curl https://example.com" } });
    await runAgent(env, { prompt: "x", cwd: env.root }, { access: { denyCommands: ["curl"] } });
    expect(permissionOutcome(env)).toBe("decline");
  });

  test("a path the profile denies is rejected for a file change", async () => {
    const env = await setup("permission-edit", { vars: { FAKE_CODEX_PATH: "/etc/passwd" } });
    await runAgent(env, { prompt: "x", cwd: env.root }, { access: { denyPaths: ["/etc"] } });
    expect(permissionOutcome(env)).toBe("decline");
  });

  test("the legacy command approval answers with Codex's ReviewDecision", async () => {
    const allowed = await setup("permission-legacy", { vars: { FAKE_CODEX_COMMAND: "make test" } });
    expect((await runAgent(allowed, { prompt: "x", cwd: allowed.root })).result).toBe("done");
    expect(permissionOutcome(allowed)).toBe("approved");
    const denied = await setup("permission-legacy", { vars: { FAKE_CODEX_COMMAND: "rm -rf build" } });
    expect((await runAgent(denied, { prompt: "x", cwd: denied.root }, { access: { denyCommands: ["rm -rf"] } })).result).toBe("done");
    expect(permissionOutcome(denied)).toEqual({ denied: { rejection: "the access profile refused this call" } });
  });

  test("the legacy patch approval is judged by the paths it changes", async () => {
    const env = await setup("permission-legacy-edit", { vars: { FAKE_CODEX_PATH: "/etc/passwd" } });
    await runAgent(env, { prompt: "x", cwd: env.root }, { access: { denyPaths: ["/etc"] } });
    expect(permissionOutcome(env)).toEqual({ denied: { rejection: "the access profile refused this call" } });
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
    expect(permissionOutcome(env)).toBe("accept");
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
    expect(permissionOutcome(env)).toBe("decline");
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
    expect(permissionOutcome(env)).toBe("accept");
  });

  test("a question about a command the log cannot read shows the command itself", async () => {
    const command = "rm -rf 'build";
    const env = await setup("permission", { vars: { FAKE_CODEX_COMMAND: command } });
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
    expect(asked).toEqual([`Run this command? ${command}`]);
    expect(asked[0]).not.toContain("command not shown");
  });

  test("a background run asks about an outward command with its target", async () => {
    const env = await setup("permission");
    const asked: Array<{ readonly prompt: string; readonly choices?: readonly string[] }> = [];
    const result = await runAgent(
      env,
      { prompt: "x", cwd: env.root },
      {
        access: { outwardCommands: ["rm -rf"] },
        trigger: { source: "cron", type: "tick", key: "t1", hops: 0 },
        asker: {
          ask: (request) => {
            asked.push(request);
            return Promise.resolve({ kind: "answered", answer: { choice: "send_once" } });
          },
          useGrant: () => Promise.resolve(false),
        },
      },
    );
    expect(result.result).toBe("done");
    expect(asked[0]?.prompt).toContain("rm -rf build");
    expect(asked[0]?.choices).toEqual(["send_once", "reject_once"]);
  });

  test("always for this flow and target records a grant and the next scheduled run does not ask", async () => {
    const env = await setup("permission");
    const flow = defineFlow({
      name: "daily:codex",
      entry: "done",
      steps: [{ id: "done", kind: "end", params: { status: "done" }, replay: "safe" }],
    });
    const asked: string[] = [];
    const first = await runAgent(
      env,
      { prompt: "x", cwd: env.root },
      {
        access: { outwardCommands: ["rm -rf"] },
        trigger: { source: "cron", type: "tick", key: "t1", hops: 0 },
        flow,
        asker: {
          ask: (request) => {
            asked.push(request.prompt);
            return Promise.resolve({
              kind: "answered",
              answer: { choice: "allow_target", actor: { via: "ios", id: "owner" } },
            });
          },
          useGrant: () => Promise.resolve(false),
        },
      },
    );
    expect(first.result).toBe("done");
    expect(asked).toHaveLength(1);
    expect((await readTargetGrants(env.root)).file.grants).toMatchObject([
      { flow: "daily:codex", target: "rm -rf build", by: { via: "ios", id: "owner" } },
    ]);

    const second = await runAgent(
      env,
      { prompt: "x", cwd: env.root },
      {
        access: { outwardCommands: ["rm -rf"] },
        trigger: { source: "cron", type: "tick", key: "t2", hops: 0 },
        flow,
        asker: {
          ask: () => {
            asked.push("asked again");
            return Promise.reject(new Error("the target grant must lift this question"));
          },
          useGrant: () => Promise.resolve(false),
        },
      },
    );
    expect(second.result).toBe("done");
    expect(asked).toHaveLength(1);
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
    expect(permissionOutcome(env)).toBe("decline");
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

  test("a model the app-server does not offer is an unavailable model error", async () => {
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
    const error = (info: string, status = "failed") =>
      ({
        kind: "stopped",
        stopReason: status,
        usage: null,
        sessionId: "s",
        error: { code: 0, message: "m", data: { message: "m", codexErrorInfo: info } },
      }) as const;
    expect(failureOf(error("rateLimitExceeded"), undefined).modelError).toEqual({ kind: "usage_limit" });
    expect(failureOf(error("serverOverloaded"), undefined).modelError).toEqual({ kind: "unavailable" });
    expect(failureOf(error("httpConnectionFailed"), undefined).modelError).toEqual({ kind: "protocol" });
  });
});

describe("codex/agent: cancel", () => {
  test("a cancel sends turn/interrupt and the step is interrupted when the server answers", async () => {
    const env = await setup("cancel");
    const controller = new AbortController();
    const running = runAgent(env, { prompt: "x", cwd: env.root }, { signal: controller.signal });
    const pid = await waitForPid(env.marker);
    controller.abort();
    const result = await running;
    expect(result.result).toBe("interrupted");
    expect(dataOf(result).reason).toBe("cancelled");
    expect(methods(env)).toContain("turn/interrupt");
    await waitForGone(pid);
  });

  test("a server that ignores the interrupt is ended after the grace", async () => {
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
  test("a resumed run resumes the thread, and what it replays is not this run's", async () => {
    const env = await setup("done");
    const result = await runAgent(env, { prompt: "go on", cwd: env.root, resumeSession: "old-session" });
    expect(result.result).toBe("done");
    expect(methods(env)).toEqual(["initialize", "initialized", "thread/resume", "turn/start"]);
    const resume = paramsOf(env, "thread/resume")[0];
    expect(resume?.threadId).toBe("old-session");
    expect(resume?.cwd).toBe(env.root);
    expect(dataOf(result).sessionId).toBe("old-session");
    const lines = await logLines(result);
    expect(JSON.stringify(lines)).not.toContain("an earlier message");
    expect(lines.some((line) => line.toolCallId === "old1")).toBe(false);
    expect(dataOf(result).imageGenCalls).toBe(1);
  });

  test("a thread that cannot be resumed fails with session_missing", async () => {
    const env = await setup("no-load");
    const result = await runAgent(env, { prompt: "go on", cwd: env.root, resumeSession: "old-session" });
    expect(result.result).toBe("failed");
    expect(dataOf(result).reason).toBe("session_missing");
    expect(methods(env)).not.toContain("turn/start");
  });
});

test("the codex plugin declares that it takes messages mid-run", () => {
  expect(createCodexHarnessPlugin().capabilities).toEqual({ takesMessagesMidRun: true });
});

describe("codex/agent: a message from the host", () => {
  test("a message sent mid-run steers the turn", async () => {
    const env = await setup("steer");
    let listener: (text: string) => boolean | void = () => undefined;
    const inbox = {
      listen(handler: (text: string) => boolean | void) {
        listener = handler;
        return () => {
          listener = () => undefined;
        };
      },
      begin() {
        // The test sends after the turn started.
      },
    };
    const running = runAgent(env, { prompt: "x", cwd: env.root, inbox });
    await waitForFile(env.marker);
    expect(listener("please stop")).toBe(true);
    const result = await running;
    expect(result.result).toBe("done");
    expect(dataOf(result).finalMessage).toBe("heard: please stop");
    expect(methods(env)).toContain("turn/steer");
  });
});

describe("codex/agent: an app-server that exits early", () => {
  test("a process that exits without a turn result fails with no_result", async () => {
    const env = await setup("exited-early");
    const result = await runAgent(env, { prompt: "x", cwd: env.root });
    expect(result.result).toBe("failed");
    expect(dataOf(result).reason).toBe("no_result");
  });
});

describe("codex check", () => {
  test("reports the codex version, the app-server command and the login", async () => {
    const env = await setup("done");
    const checks = await env.registry.checks();
    const check = checks.find((item) => item.plugin === "codex");
    expect(check?.ok).toBe(true);
    expect(check?.message).toContain("codex 9.9.9");
    expect(check?.message).toContain("app-server");
    expect(check?.message).toContain("login ChatGPT");
  });

  test("refuses when Codex is not logged in", async () => {
    const env = await setup("done", { vars: { FAKE_CODEX_LOGIN: "out" } });
    const check = (await env.registry.checks()).find((item) => item.plugin === "codex");
    expect(check?.ok).toBe(false);
    expect(check?.message).toContain("not logged in");
  });

  test("refuses an installed Codex that is too old", async () => {
    const env = await setup("done", { vars: { FAKE_CODEX_VERSION: "0.100.0" } });
    const check = (await env.registry.checks()).find((item) => item.plugin === "codex");
    expect(check?.ok).toBe(false);
    expect(check?.message).toContain("too old");
    expect(check?.message).toContain("0.166.0");
  });

  test("refuses a Codex with no app-server", async () => {
    const env = await setup("no-app-server");
    const check = (await env.registry.checks()).find((item) => item.plugin === "codex");
    expect(check?.ok).toBe(false);
    expect(check?.message).toContain("no app-server");
  });

  test("refuses a command that cannot start", async () => {
    const env = await setup("done", { settings: { command: [process.execPath, join(tempRootless(), "missing.ts")] } });
    const check = (await env.registry.checks()).find((item) => item.plugin === "codex");
    expect(check?.ok).toBe(false);
    expect(check?.message).toContain("app-server");
  });
});

function tempRootless(): string {
  return fileURLToPath(new URL("./does-not-exist/", import.meta.url));
}
