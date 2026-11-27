/**
 * The hub side of a pi API-key login (ADR 0023 D11). It starts the child of
 * `login-worker.ts`, keeps its line protocol, and turns each prompt and notice
 * into a question or a pending item through `ctx.ask` (ADR 0008). The pi
 * library is never imported here.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chatgptLoginCommand } from "./pi-install.ts";
import {
  isRecord,
  messageOf,
  type AskAnswer,
  type ChoiceInfo,
  type PluginStepResult,
  type StepContext,
} from "@operad-io/engine";
import {
  type LoginCommand,
  type LoginLine,
  type LoginNotice,
  type LoginPrompt,
  type LoginProvider,
  type LoginStart,
} from "./login-protocol.ts";

/** The child program a login starts. */
export const LOGIN_WORKER_PATH = fileURLToPath(new URL("./login-worker.ts", import.meta.url));

/** How long the provider choice and the login itself may take (ADR 0023 D11). */
export const LOGIN_TIMEOUT_MS = 300_000;

/** How long the model choice after a finished login may take. */
export const MODEL_CHOICE_SECS = 300;

/** How much of the child's stderr a failure keeps. */
const STDERR_LINES = 20;

/** What the login step starts and reads. */
export interface LoginRunOptions {
  /** The executable that runs the login child; defaults to the running Bun. */
  readonly command: string;
  /** Its arguments; defaults to the login worker. */
  readonly args?: readonly string[] | undefined;
  /** Test seam: the whole login timeout in milliseconds. */
  readonly timeoutMs?: number | undefined;
  /** The time now in milliseconds; defaults to `Date.now`. */
  readonly now?: (() => number) | undefined;
}

/** A failure that ends the login without a person's answer. */
class LoginFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoginFailure";
  }
}

/** The line queue and the process of one login child. */
class LoginChild {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #terminal: Interface;
  readonly #now: () => number;
  readonly #deadline: number;
  readonly #lines: LoginLine[] = [];
  readonly #stderr: string[] = [];
  #wake: (() => void) | undefined;
  #status: "open" | "done" | "failed" | "exited" = "open";
  #message: string | undefined;

  constructor(child: ChildProcessWithoutNullStreams, now: () => number, deadline: number) {
    this.#child = child;
    this.#now = now;
    this.#deadline = deadline;
    this.#terminal = createInterface({ input: child.stdout });
    this.#terminal.on("line", (line) => this.#take(line));
    createInterface({ input: child.stderr }).on("line", (line) => {
      if (line.length === 0) return;
      this.#stderr.push(line);
      if (this.#stderr.length > STDERR_LINES) this.#stderr.shift();
    });
    child.on("close", () => {
      if (this.#status === "open") this.#status = "exited";
      this.#wakeUp();
    });
    child.on("error", (error) => {
      this.#status = "failed";
      this.#message = this.#message ?? messageOf(error);
      this.#wakeUp();
    });
  }

  static start(options: LoginRunOptions, input: LoginStart): LoginChild {
    const now = options.now ?? Date.now;
    const deadline = now() + (options.timeoutMs ?? LOGIN_TIMEOUT_MS);
    const args = options.args ?? [LOGIN_WORKER_PATH];
    const child = spawn(options.command, [...args, JSON.stringify(input)], {
      cwd: input.cwd,
      // Three entries: stdin carries the commands, stdout the lines, stderr the
      // diagnostics. An extra pipe is what Bun closes twice (AGENTS.md).
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    return new LoginChild(child, now, deadline);
  }

  get deadline(): number {
    return this.#deadline;
  }

  #take(line: string): void {
    let parsed: LoginLine;
    try {
      parsed = JSON.parse(line) as LoginLine;
    } catch {
      return;
    }
    if (parsed.type === "done") {
      this.#status = "done";
    } else if (parsed.type === "failed") {
      this.#status = "failed";
      this.#message = parsed.message;
    }
    this.#lines.push(parsed);
    this.#wakeUp();
  }

  #wakeUp(): void {
    this.#wake?.();
    this.#wake = undefined;
  }

  #failure(): string {
    const details = this.#stderr.length === 0 ? "" : `: ${this.#stderr.join(" ")}`;
    return this.#message === undefined ? `the login program ended before its answer${details}` : this.#message;
  }

  /** The next line, waiting no longer than the login's deadline. */
  async next(): Promise<LoginLine> {
    for (;;) {
      const found = this.#lines.shift();
      if (found !== undefined) return found;
      if (this.#status !== "open") throw new LoginFailure(this.#failure());
      const left = this.#deadline - this.#now();
      if (left <= 0) throw new LoginFailure("the login timed out");
      await new Promise<void>((resolveWait, rejectWait) => {
        const timer = setTimeout(() => {
          this.#wake = undefined;
          rejectWait(new LoginFailure("the login timed out"));
        }, left);
        this.#wake = () => {
          clearTimeout(timer);
          resolveWait();
        };
      });
    }
  }

  send(command: LoginCommand): void {
    if (this.#child.stdin.destroyed) return;
    this.#child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  /** While a question waits: whether the login still needs the person. */
  recheck(): { readonly ask: boolean; readonly note?: string } {
    if (this.#status === "open") return { ask: true };
    if (this.#status === "done") return { ask: false, note: "the login finished in the browser" };
    return { ask: false, note: this.#message ?? "the login ended" };
  }

  stop(): void {
    this.#terminal.close();
    if (this.#status === "open") this.#child.kill();
  }
}

/** A route one provider offers in the login: always its API key. */
interface LoginRoute {
  readonly provider: string;
  readonly auth: "api_key";
}

/** The label pi gives a route, which a client shows instead of the id. */
function routeLabel(provider: LoginProvider): string {
  return provider.apiKey?.name ?? provider.name;
}

/**
 * The routes operad's interface offers: the API-key login of every provider.
 * No subscription (OAuth) login is offered, ChatGPT's included: a person runs
 * pi's own `pi auth login openai-codex` for it (ADR 0023 D11).
 */
function routesOf(providers: readonly LoginProvider[]): readonly LoginRoute[] {
  const routes: LoginRoute[] = [];
  for (const provider of providers) {
    if (provider.apiKey !== undefined) routes.push({ provider: provider.id, auth: "api_key" });
  }
  return routes;
}

function remainingSecs(deadline: number, now: () => number): number {
  return Math.max(0, Math.ceil((deadline - now()) / 1000));
}

function failed(message: string): PluginStepResult {
  return { result: "failed", data: { message } };
}

/** Expands a leading `~` to the user's home directory. */
function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return isAbsolute(path) ? path : resolve(path);
}

/** Asks which provider route to take; undefined when the person stopped. */
async function chooseProvider(
  ctx: StepContext,
  providers: readonly LoginProvider[],
  deadline: number,
  now: () => number,
  command: string,
): Promise<LoginRoute | undefined> {
  const routes = routesOf(providers);
  if (routes.length === 0) throw new LoginFailure("no provider of pi can log in");
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  const choices = routes.map((route) => route.provider);
  const choiceInfo: Record<string, ChoiceInfo> = {};
  for (const route of routes) {
    const provider = byId.get(route.provider);
    if (provider === undefined) continue;
    choiceInfo[route.provider] = { label: routeLabel(provider) };
  }
  const answer = await ctx.ask({
    prompt: "Choose a provider to log in with an API key. For a ChatGPT plan, run the command below instead; operad picks it up once it is done.",
    command,
    choices,
    choiceInfo,
    graceSecs: remainingSecs(deadline, now),
    onTimeout: "reject_once",
  });
  if (answer.rejected === true || answer.choice === undefined) return undefined;
  const route = routes.find((candidate) => candidate.provider === answer.choice);
  return route;
}

/** The text of a one-question form's answer, or undefined when none came. */
function answerText(answer: AskAnswer): string | undefined {
  const found = answer.answers?.[0];
  if (found === undefined || found.skipped === true) return undefined;
  return typeof found.text === "string" && found.text.trim().length > 0 ? found.text : undefined;
}

/** The answer for one prompt, or undefined when the person stopped the login. */
async function answerPrompt(
  ctx: StepContext,
  child: LoginChild,
  line: Extract<LoginLine, { type: "prompt" }>,
  deadline: number,
  now: () => number,
): Promise<string | undefined> {
  const prompt: LoginPrompt = line.prompt;
  const graceSecs = remainingSecs(deadline, now);
  if (graceSecs <= 0) throw new LoginFailure("the login timed out");
  if (prompt.type === "select") {
    const choices = prompt.options.map((option) => option.id);
    const choiceInfo: Record<string, ChoiceInfo> = {};
    for (const option of prompt.options) {
      choiceInfo[option.id] = {
        label: option.label,
        ...(option.description === undefined ? {} : { hint: option.description }),
      };
    }
    const answer = await ctx.ask({
      prompt: prompt.message,
      choices,
      choiceInfo,
      graceSecs,
      onTimeout: "reject_once",
    });
    if (answer.rejected === true || answer.choice === undefined) return undefined;
    return answer.choice;
  }
  if (prompt.type === "secret" || prompt.type === "text") {
    const answer = await ctx.ask({
      prompt: prompt.message,
      questions: [
        {
          id: "value",
          text: prompt.message,
          freeText: true,
          ...(prompt.type === "secret" ? { secret: true as const } : {}),
        },
      ],
      graceSecs,
      onTimeout: "reject_once",
      recheck: () => child.recheck(),
    });
    if (answer.choice === "allow_once") return "";
    if (answer.rejected === true) return undefined;
    return answerText(answer);
  }
  return undefined;
}

/** The model the person chose after the login; undefined when they stopped. */
async function chooseModel(
  ctx: StepContext,
  provider: string,
): Promise<string | undefined> {
  const models = (await ctx.harnessModelsReady?.("pi")) ?? ctx.harnessModels?.("pi");
  const ids = (models?.list ?? []).map((model) => (typeof model === "string" ? model : model.id));
  const list = ids.filter((id) => id.startsWith(`${provider}/`));
  if (list.length === 0) throw new LoginFailure(`pi lists no model for ${provider}`);
  const preferred = models?.default;
  const primary = preferred !== undefined && preferred !== null && list.includes(preferred) ? preferred : list[0];
  const choiceInfo: Record<string, ChoiceInfo> = {};
  if (primary !== undefined) choiceInfo[primary] = { role: "primary" };
  const answer = await ctx.ask({
    prompt: "Choose the model the bot uses.",
    choices: list,
    choiceInfo,
    graceSecs: MODEL_CHOICE_SECS,
    onTimeout: "reject_once",
  });
  if (answer.rejected === true || answer.choice === undefined) return undefined;
  return list.includes(answer.choice) ? answer.choice : undefined;
}

/**
 * `pi/login`: asks for a provider and a model and hands the provider to the
 * child that runs pi's login. The result is `done` with `{ provider, model }`
 * or `failed` with `{ message }`.
 */
export async function runLoginStep(
  ctx: StepContext,
  options: LoginRunOptions,
): Promise<PluginStepResult> {
  const now = options.now ?? Date.now;
  const settings = ctx.settings;
  const input: LoginStart = {
    authPath: expandHome(
      typeof settings.authPath === "string" && settings.authPath !== ""
        ? settings.authPath
        : "~/.pi/agent/auth.json",
    ),
    modelsPath:
      typeof settings.modelsPath === "string" && settings.modelsPath !== ""
        ? expandHome(settings.modelsPath)
        : join(homedir(), ".pi", "agent", "models.json"),
    home: ctx.home,
    command:
      typeof settings.command === "string" && settings.command !== "" ? settings.command : "pi",
    cwd: ctx.cwd,
  };
  let child: LoginChild;
  try {
    child = LoginChild.start(options, input);
  } catch (error) {
    return failed(messageOf(error));
  }
  try {
    const first = await child.next();
    if (first.type === "failed") return failed(first.message);
    if (first.type !== "providers") {
      return failed("the login program did not report its providers");
    }
    const command = chatgptLoginCommand(input.command, { home: ctx.home, cwd: ctx.cwd });
    const route = await chooseProvider(ctx, first.providers, child.deadline, now, command);
    if (route === undefined) return failed("the login was cancelled");
    child.send({ type: "login", provider: route.provider, auth: route.auth });
    for (;;) {
      const line = await child.next();
      if (line.type === "done") break;
      if (line.type === "failed") return failed(line.message);
      if (line.type === "notice") continue;
      if (line.type === "prompt") {
        const answer = await answerPrompt(ctx, child, line, child.deadline, now);
        if (answer === undefined) return failed("the login was cancelled");
        if (answer !== "") child.send({ type: "answer", id: line.id, value: answer });
      }
    }
    const model = await chooseModel(ctx, route.provider);
    if (model === undefined) return failed("the login finished but no model was chosen");
    return { result: "done", data: { provider: route.provider, model } };
  } catch (error) {
    if (error instanceof LoginFailure) return failed(error.message);
    return failed(messageOf(error));
  } finally {
    child.stop();
  }
}
