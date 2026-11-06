import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  answerRun,
  ConfigError,
  Kernel,
  LockHeldError,
  Runner,
  StateError,
  TriggerError,
  ViewError,
  createViews,
  defaultOperadHome,
  ensureConfig,
  formatHistoryEntry,
  historyEntry,
  historyEntries,
  listPending,
  listRunning,
  loadPluginRegistry,
  loadTriggerRules,
  openConfigLog,
  openPluginStore,
  parseObjectKey,
  readConfig,
  readStoredStart,
  readStoredTrigger,
  serve,
  splitActionName,
  storeRootOf,
  ENGINE_VERSION,
  type ActionArgsSchema,
  type ActionArgSchema,
  type ActionInfo,
  type Actor,
  type LogBackend,
  type GlobalFact,
  type OperadConfig,
  type PluginRegistry,
  type RunInfo,
  type TriggerEvent,
  type TriggerRule,
  type ViewAction,
  type ViewObject,
  type ViewRow,
  type Views,
} from "@operad-io/engine";
import { renderMarkdown } from "./markdown.ts";

/** Where a command writes. Tests pass a collector instead of the process. */
export interface CliIo {
  write(text: string): void;
  error(text: string): void;
  /** Reads one line, for a prompt in a terminal. Tests inject it. */
  readLine?(prompt: string): Promise<string | undefined>;
}

const STDIO: CliIo = {
  write: (text) => {
    process.stdout.write(text);
  },
  error: (text) => {
    process.stderr.write(text);
  },
};

/** A command line mistake; exit code 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export interface MainOptions {
  /** The operad home; defaults to `$OPERAD_HOME` or `~/.operad`. */
  readonly home?: string | undefined;
  readonly io?: CliIo | undefined;
  /** Whether prompts and colours are available; defaults to the real terminal. */
  readonly isTTY?: boolean | undefined;
}

const KERNEL_VERBS = [
  "init",
  "serve",
  "pending",
  "history",
  "running",
  "flows",
  "trigger",
  "list",
  "show",
  "run-internal",
] as const;

const KERNEL_ACTIONS = ["operad:start", "operad:dismiss"] as const;

const HELP = [
  "usage: operad <command> [options]",
  "",
  "  init                 create the operad home and check the plugins",
  "  serve                run the kernel loop for this home",
  "  pending [--json]     things waiting for a person",
  "  list <type>          objects of one type",
  "  show <id>            one object, its sections and its actions",
  "  history <id> [--json] steps of a run, or of a plugin object's runs",
  "  running              runs in progress",
  "  flows                loaded flows and where they come from",
  "  trigger <source> <key> [--type t] [--object o] [--summary text] [--data file]",
  "                       send one event through the rules",
  "  operad:start <id>    start a pending event",
  "  operad:dismiss <id>  dismiss a pending event",
  "  <plugin>:<action>    an action on one object",
  "  <plugin> <verb>      a verb a loaded plugin declares",
  "",
].join("\n");

const COLOUR = {
  reset: "\x1b[0m",
  attention: "\x1b[33m",
  running: "\x1b[34m",
} as const;

function paintState(row: ViewRow, text: string, tty: boolean): string {
  if (!tty) return text;
  if (row.waiting) return `${COLOUR.attention}${text}${COLOUR.reset}`;
  if (row.running) return `${COLOUR.running}${text}${COLOUR.reset}`;
  return text;
}

interface Context {
  readonly home: string;
  readonly config: OperadConfig;
  readonly registry: PluginRegistry;
  readonly log: LogBackend;
  readonly storeRoot: string;
  readonly views: Views;
}

async function openContext(home: string, io: CliIo): Promise<Context> {
  const config = await readConfig(home);
  const storeRoot = storeRootOf(config);
  const store = openPluginStore({ backend: config.store.backend, root: storeRoot });
  const log = openConfigLog(config);
  let loaded: PluginRegistry | undefined;
  const registry = await loadPluginRegistry({
    home,
    cwd: home,
    store,
    kernelVerbs: KERNEL_VERBS,
    onLog: (message) => io.error(`${message}\n`),
    onAnswer: async (runId, choice, note, actor) => {
      const runs = await log.runs();
      const run = runs.find((candidate) => candidate.runId === runId);
      if (run === undefined) throw new StateError(`no run "${runId}"`);
      const found = loaded?.flow(run.flow);
      if (found === undefined) {
        throw new StateError(`run "${runId}": flow "${run.flow}" is not loaded`);
      }
      await answerRun({
        log,
        flow: found.flow,
        runId,
        choice,
        ...(note === undefined ? {} : { note }),
        actor,
      });
    },
  });
  loaded = registry;
  return {
    home,
    config,
    registry,
    log,
    storeRoot,
    views: createViews({
      registry,
      store,
      log,
      onLog: (message) => io.error(`${message}\n`),
    }),
  };
}

function kernelFor(
  context: Context,
  io: CliIo,
  rules: readonly TriggerRule[],
): Kernel {
  return new Kernel({
    log: context.log,
    registry: context.registry,
    home: context.home,
    storeRoot: context.storeRoot,
    rules,
    onLog: (message) => io.error(`${message}\n`),
  });
}

function splitFlag(
  argv: readonly string[],
  flag: string,
): { readonly args: string[]; readonly present: boolean } {
  const args: string[] = [];
  let present = false;
  for (const arg of argv) {
    if (arg === flag) present = true;
    else args.push(arg);
  }
  return { args, present };
}

function seconds(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const whole = Math.floor(ms / 1000);
  if (whole < 60) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return `${minutes}m ${rest}s`;
}

function printValue(io: CliIo, value: unknown): void {
  if (value === undefined) return;
  if (typeof value === "string") {
    io.write(`${value}\n`);
    return;
  }
  io.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function commandInit(home: string, io: CliIo): Promise<number> {
  const ensured = await ensureConfig(home);
  io.write(
    `${ensured.created ? "created" : "using"} ${ensured.path}\n`,
  );
  const config = await readConfig(home);
  const storeRoot = storeRootOf(config);
  const registry = await loadPluginRegistry({
    home,
    cwd: home,
    store: openPluginStore({ backend: config.store.backend, root: storeRoot }),
    kernelVerbs: KERNEL_VERBS,
    onLog: (message) => io.error(`${message}\n`),
  });

  const checks = await registry.checks();
  if (checks.length === 0) {
    io.write("no plugins loaded\n");
    return 0;
  }
  let failed = false;
  for (const check of checks) {
    if (!check.ok) failed = true;
    io.write(`${check.plugin}: ${check.message}\n`);
  }
  return failed ? 1 : 0;
}

async function commandPending(
  context: Context,
  io: CliIo,
  json: boolean,
): Promise<void> {
  const pending = await listPending(
    context.log,
    context.registry,
    kernelFor(context, io, []),
  );
  if (json) {
    io.write(`${JSON.stringify(pending, null, 2)}\n`);
    return;
  }
  if (pending.length === 0) {
    io.write("nothing is waiting\n");
    return;
  }
  for (const item of pending) {
    io.write(`${item.runId}  ${item.flow}  ${item.step ?? "-"}\n`);
    io.write(`  waiting: ${item.prompt}\n`);
    if (item.choices.length > 0) {
      io.write(`  choices: ${item.choices.join(", ")}\n`);
    }
    if (item.actions.length > 0) {
      io.write(
        `  actions: ${item.actions
          .map((action) => `${action.plugin}:${action.action}`)
          .join(", ")}\n`,
      );
    }
  }
}

/**
 * Resolves what `history <id>` names: a run id, a typed plugin object such as
 * `task:42`, or an untyped object id. A bare id that only one declared object
 * type owns resolves to that type; one owned by several is ambiguous.
 */
function takeValueFlag(
  argv: readonly string[],
  flag: string,
): { readonly args: string[]; readonly value: string | undefined; readonly present: boolean } {
  const args: string[] = [];
  let value: string | undefined;
  let present = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === flag) {
      present = true;
      const next = argv[index + 1];
      if (next === undefined) {
        throw new UsageError(`${flag} needs a value`);
      }
      value = next;
      index += 1;
      continue;
    }
    if (arg.startsWith(`${flag}=`)) {
      present = true;
      value = arg.slice(flag.length + 1);
      continue;
    }
    args.push(arg);
  }
  return { args, value, present };
}

function takeRepeatedFlag(
  argv: readonly string[],
  flag: string,
): { readonly args: string[]; readonly values: string[] } {
  const args: string[] = [];
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === flag) {
      const next = argv[index + 1];
      if (next === undefined) throw new UsageError(`${flag} needs a value`);
      values.push(next);
      index += 1;
      continue;
    }
    if (arg.startsWith(`${flag}=`)) {
      values.push(arg.slice(flag.length + 1));
      continue;
    }
    args.push(arg);
  }
  return { args, values };
}

/** A `--where` value keeps its text unless it is an obvious JSON scalar. */
function whereValue(text: string): unknown {
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null") return null;
  if (/^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(text)) return Number(text);
  return text;
}

function parseWhere(values: readonly string[]): Record<string, unknown> {
  const where: Record<string, unknown> = {};
  for (const value of values) {
    const at = value.indexOf("=");
    if (at <= 0) {
      throw new UsageError(`--where needs field=value, got "${value}"`);
    }
    where[value.slice(0, at)] = whereValue(value.slice(at + 1));
  }
  return where;
}

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new UsageError(`--limit needs a positive integer, got "${value}"`);
  }
  return parsed;
}

async function commandList(
  context: Context,
  io: CliIo,
  type: string,
  json: boolean,
  tty: boolean,
  options: {
    readonly where: readonly string[];
    readonly limit: string | undefined;
    readonly cursor: string | undefined;
  },
): Promise<void> {
  const limit = parseLimit(options.limit);
  const page = await context.views.list(type, {
    ...(options.where.length === 0 ? {} : { where: parseWhere(options.where) }),
    ...(limit === undefined ? {} : { limit }),
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
  });
  if (json) {
    io.write(`${JSON.stringify(page, null, 2)}\n`);
    return;
  }
  if (page.rows.length === 0) {
    io.write(`no objects of type "${type}"\n`);
  } else {
    for (const row of page.rows) {
      const state = paintState(row, row.state, tty);
      const note = row.note === undefined ? "" : `  ${row.note}`;
      io.write(`${row.id}  ${state}  ${row.title}${note}\n`);
    }
  }
  if (page.next !== undefined) {
    io.write(`next: operad list ${type} --cursor ${page.next}\n`);
  }
}

function firstSection(object: ViewObject): string | undefined {
  return object.sections[0]?.id;
}

function actionArgFlags(action: ViewAction | ActionInfo): string[] {
  const args: string[] = [];
  for (const [name, property] of Object.entries(action.args?.properties ?? {})) {
    if (property.enum !== undefined) {
      args.push(`--${name} ${property.enum.map((item) => String(item)).join("|")}`);
    } else {
      args.push(`--${name} <${property.type ?? "value"}>`);
    }
  }
  return args;
}

function actionLine(action: ViewAction): string {
  const key = action.key === undefined ? "" : ` (${action.key})`;
  const needs: string[] = [];
  if (action.noteRequired) needs.push("needs a note");
  if (action.confirm) needs.push("asks to confirm");
  const args = actionArgFlags(action);
  const suffix = needs.length === 0 ? "" : `  ${needs.join(", ")}`;
  const list = args.length === 0 ? "" : `  ${args.join(" ")}`;
  return `${action.name}${key}${suffix}${list}`;
}

async function commandShow(
  context: Context,
  io: CliIo,
  argv: readonly string[],
  tty: boolean,
): Promise<void> {
  let rest = [...argv];
  const sectionFlag = takeValueFlag(rest, "--section");
  rest = sectionFlag.args;
  const cursorFlag = takeValueFlag(rest, "--cursor");
  rest = cursorFlag.args;
  const full = splitFlag(rest, "--full");
  rest = full.args;
  const raw = splitFlag(rest, "--raw");
  rest = raw.args;
  const json = splitFlag(rest, "--json");
  rest = json.args;

  const id = rest[0];
  if (id === undefined) throw new UsageError("show needs an object id");
  if (rest.length > 1) throw new UsageError("show takes one object id");

  const object = await context.views.get(id);
  const requested = sectionFlag.value ?? firstSection(object);

  if (json.present) {
    if (requested === undefined) {
      io.write(`${JSON.stringify(object, null, 2)}\n`);
      return;
    }
    const content = await context.views.section(
      id,
      requested,
      cursorFlag.value,
      { full: full.present },
    );
    io.write(`${JSON.stringify({ ...object, section: content }, null, 2)}\n`);
    return;
  }

  if (requested !== undefined) {
    const exists = object.sections.some((section) => section.id === requested);
    if (!exists) {
      throw new Error(`object "${id}" has no section "${requested}"`);
    }
  }

  if (raw.present) {
    if (requested === undefined) {
      io.write("");
      return;
    }
    const content = await context.views.section(
      id,
      requested,
      cursorFlag.value,
      { full: full.present },
    );
    io.write(`${content.markdown.replace(/\n?$/, "\n")}`);
    return;
  }

  const state = paintState(object.row, object.row.state, tty);
  const note = object.row.note === undefined ? "" : `  ${object.row.note}`;
  io.write(`${object.row.id}  ${state}  ${object.row.title}${note}\n`);
  if (object.unavailable !== undefined) {
    io.error(`operad: ${object.unavailable}\n`);
  }
  io.write(
    `sections: ${object.sections.map((section) => (section.live === true ? `${section.title} (live)` : section.title)).join(", ")}\n`,
  );
  io.write(
    `actions: ${object.actions.length === 0 ? "none" : object.actions.map(actionLine).join(", ")}\n`,
  );
  if (requested === undefined) return;

  const content = await context.views.section(
    id,
    requested,
    cursorFlag.value,
    { full: full.present },
  );
  io.write(`\n${renderMarkdown(content.markdown, { colour: tty })}`);
  if (content.next !== undefined) {
    io.write(
      `next: operad show ${id} --section ${requested} --cursor ${content.next}\n`,
    );
  }
}

interface ActionArguments {
  readonly positionals: readonly string[];
  readonly values: ReadonlyMap<string, string | true>;
  readonly yes: boolean;
}

/** The action an argv names, found before its flags are classified. */
function actionInfoForArgv(
  context: Context,
  argv: readonly string[],
): ActionInfo | undefined {
  const actions = context.registry.actions();
  const tokens = argv.filter((arg) => !arg.startsWith("--"));
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    const split = splitActionName(token);
    if (split !== undefined) {
      const found = actions.find(
        (info) => info.plugin === split.plugin && info.action === split.action,
      );
      if (found !== undefined) return found;
    }
    const next = tokens[index + 1];
    if (next !== undefined) {
      const found = actions.find(
        (info) => info.plugin === token && info.action === next,
      );
      if (found !== undefined) return found;
    }
    const candidates = actions.filter((info) => info.action === token);
    if (candidates.length === 1) return candidates[0];
  }
  return undefined;
}

/** Reads `--flag value`, `--flag=value` and a bare boolean `--flag`. */
function parseActionArguments(
  argv: readonly string[],
  args?: ActionArgsSchema,
): ActionArguments {
  const positionals: string[] = [];
  const values = new Map<string, string | true>();
  const properties = args?.properties ?? {};
  const note = noteField(args);
  let yes = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (!arg.startsWith("--") || arg === "--") {
      positionals.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const at = body.indexOf("=");
    if (at >= 0) {
      values.set(body.slice(0, at), body.slice(at + 1));
      continue;
    }
    if (body === "yes") {
      yes = true;
      continue;
    }
    const next = argv[index + 1];
    const property = properties[body];
    if (property?.type === "boolean") {
      if (next === "true" || next === "false") {
        values.set(body, next);
        index += 1;
      } else {
        values.set(body, true);
      }
      continue;
    }
    const takesValue = property !== undefined || (note !== undefined && body === "note");
    if (!takesValue) {
      // An unknown flag stays bare, so a following object id is not swallowed.
      values.set(body, true);
      continue;
    }
    // A schema value may look like an object id or a negative number.
    if (next === undefined || next.startsWith("--")) {
      values.set(body, true);
      continue;
    }
    values.set(body, next);
    index += 1;
  }
  return { positionals, values, yes };
}

/** Turns one flag's text into the value the schema's type names. */
function actionArgValue(
  name: string,
  property: ActionArgSchema,
  raw: string | true,
): unknown {
  if (property.type === "boolean") {
    if (raw === true || raw === "true") return true;
    if (raw === "false") return false;
    throw new UsageError(`--${name}: expected true or false, got "${String(raw)}"`);
  }
  if (raw === true) {
    throw new UsageError(`--${name}: needs a value`);
  }
  if (property.type === "integer" || property.type === "number") {
    const value = Number(raw);
    if (!Number.isFinite(value) || (property.type === "integer" && !Number.isInteger(value))) {
      throw new UsageError(`--${name}: expected a ${property.type}, got "${raw}"`);
    }
    return value;
  }
  if (property.type === "array" || property.type === "object") {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw new UsageError(`--${name}: expected JSON, got "${raw}"`);
    }
  }
  return raw;
}

function actionArgsFromFlags(
  action: ViewAction,
  values: ReadonlyMap<string, string | true>,
): Record<string, unknown> {
  const properties = action.args?.properties ?? {};
  const known = new Set(Object.keys(properties));
  const copied = new Map(values);
  const note = noteField(action.args);
  if (note !== undefined && note !== "note" && copied.has("note") && !copied.has(note)) {
    copied.set(note, copied.get("note") ?? true);
    copied.delete("note");
  }

  const args: Record<string, unknown> = {};
  for (const [name, raw] of copied) {
    if (name === "yes") continue;
    if (!known.has(name)) {
      const hint =
        note !== undefined && name === "note"
          ? ` (the note argument is --${note})`
          : "";
      throw new UsageError(
        `action "${action.name}" has no argument "--${name}"${hint}`,
      );
    }
    const property = properties[name];
    if (property === undefined) continue;
    args[name] = actionArgValue(name, property, raw);
  }
  return args;
}

function noteField(args: ActionArgsSchema | undefined): string | undefined {
  for (const [name, property] of Object.entries(args?.properties ?? {})) {
    if (property.role === "note") return name;
  }
  return undefined;
}

function actorOfCli(): Actor {
  return { via: "cli", id: userInfo().username };
}

function actionCandidates(
  context: Context,
  name: string,
): readonly { readonly name: string; readonly on: string }[] {
  return context.registry
    .actions()
    .filter((info) => info.action === name);
}

function resolveActionRequest(
  context: Context,
  positionals: readonly string[],
): { readonly name: string; readonly id: string } | undefined {
  const first = positionals[0];
  if (first === undefined) return undefined;

  if (splitActionName(first) !== undefined) {
    const id = positionals[1];
    if (id === undefined) {
      throw new UsageError(`action "${first}" needs an object id`);
    }
    if (positionals.length > 2) {
      throw new UsageError(`action "${first}" takes one object id`);
    }
    return { name: first, id };
  }

  const second = positionals[1];
  if (
    second !== undefined &&
    context.registry.actions().some(
      (info) => info.plugin === first && info.action === second,
    )
  ) {
    const id = positionals[2];
    if (id === undefined) {
      throw new UsageError(`action "${first}:${second}" needs an object id`);
    }
    if (positionals.length > 3) {
      throw new UsageError(`action "${first}:${second}" takes one object id`);
    }
    return { name: `${first}:${second}`, id };
  }

  const candidates = actionCandidates(context, first);
  if (candidates.length === 0) return undefined;
  if (second === undefined) {
    throw new UsageError(`action "${first}" needs an object id`);
  }
  if (candidates.length > 1) {
    throw new UsageError(
      `action "${first}" is offered by ${candidates
        .map((candidate) => `"${candidate.name}"`)
        .join(", ")}; use "<plugin>:<action>"`,
    );
  }
  if (positionals.length > 2) {
    throw new UsageError(`action "${first}" takes one object id`);
  }
  return { name: candidates[0]?.name ?? first, id: second };
}

async function promptNote(io: CliIo): Promise<string> {
  const lines: string[] = [];
  for (;;) {
    const line = await readLine(io, lines.length === 0 ? "note: " : "      ");
    if (line === undefined || line.length === 0) break;
    lines.push(line);
  }
  return lines.join("\n");
}

async function readLine(io: CliIo, prompt: string): Promise<string | undefined> {
  if (io.readLine !== undefined) return io.readLine(prompt);
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

async function promptConfirm(io: CliIo, name: string): Promise<boolean> {
  const answer = await readLine(io, `${name}: confirm? [y/N] `);
  return /^y(es)?$/i.test((answer ?? "").trim());
}

function actionUsage(action: ActionInfo): string {
  const flags = actionArgFlags(action);
  if (action.confirm) flags.push("--yes");
  const suffix = flags.length === 0 ? "" : ` ${flags.map((flag) => `[${flag}]`).join(" ")}`;
  return `usage: operad ${action.name} <id>${suffix}\n`;
}

async function commandAction(
  context: Context,
  io: CliIo,
  argv: readonly string[],
  tty: boolean,
): Promise<boolean> {
  const help = splitFlag(argv, "--help");
  if (help.present) {
    const info = actionInfoForArgv(context, help.args);
    if (info === undefined) return false;
    io.write(actionUsage(info));
    return true;
  }

  const info = actionInfoForArgv(context, argv);
  const args = parseActionArguments(argv, info?.args);
  const request = resolveActionRequest(context, args.positionals);
  if (request === undefined) return false;

  const object = await context.views.get(request.id);
  const available = object.actions.find((action) => action.name === request.name);
  if (available === undefined) {
    // Let the kernel say why: unavailable now, or not declared at all.
    await context.views.act(request.name, request.id, {
      args: {},
      yes: args.yes,
      actor: actorOfCli(),
    });
    return true;
  }

  const actionArgs = actionArgsFromFlags(available, args.values);
  const note = noteField(available.args);
  if (
    note !== undefined &&
    available.noteRequired &&
    (actionArgs[note] === undefined ||
      (typeof actionArgs[note] === "string" &&
        (actionArgs[note] as string).trim().length === 0))
  ) {
    if (!tty) {
      throw new UsageError(
        `action "${request.name}" needs a note; pass --${note} <text>`,
      );
    }
    const text = await promptNote(io);
    if (text.trim().length === 0) {
      throw new UsageError(`action "${request.name}" needs a note`);
    }
    actionArgs[note] = text;
  }

  if (available.confirm && args.yes !== true) {
    if (!tty) {
      throw new UsageError(
        `action "${request.name}" needs confirmation; pass --yes`,
      );
    }
    if (!(await promptConfirm(io, request.name))) {
      io.write("cancelled\n");
      return true;
    }
  }

  const run = await context.views.act(request.name, request.id, {
    args: actionArgs,
    yes: args.yes || available.confirm,
    actor: actorOfCli(),
  });
  printValue(io, run.value);
  return true;
}

async function findHistoryRuns(
  log: LogBackend,
  objectTypes: readonly string[],
  id: string,
): Promise<readonly RunInfo[]> {
  const runs = await log.runs();
  const exact = runs.find((run) => run.runId === id);
  if (exact !== undefined) return [exact];

  const parsed = parseObjectKey(id);
  if (parsed !== undefined) {
    return runs.filter((run) => run.object === `${parsed.type}:${parsed.id}`);
  }

  const plain = runs.filter((run) => run.object === id);
  if (plain.length > 0) return plain;

  const byType = new Map<string, RunInfo[]>();
  for (const run of runs) {
    const key = parseObjectKey(run.object);
    if (key === undefined || key.id !== id) continue;
    if (!objectTypes.includes(key.type)) continue;
    const list = byType.get(key.type) ?? [];
    list.push(run);
    byType.set(key.type, list);
  }
  if (byType.size > 1) {
    const names = [...byType.keys()].sort();
    throw new Error(
      `"${id}" is ambiguous: use ${names.map((type) => `${type}:${id}`).join(", ")}`,
    );
  }
  return byType.values().next().value ?? [];
}

async function streamEntriesJson(
  log: LogBackend,
  runId: string,
  io: CliIo,
  indent: string,
): Promise<void> {
  let first = true;
  for await (const entry of historyEntries(log.read(runId))) {
    if (!first) io.write(",\n");
    first = false;
    io.write(
      `${indent}${JSON.stringify({
        time: new Date(entry.time).toISOString(),
        step: entry.step,
        what: entry.what,
        why: entry.why,
        ...(entry.actor === undefined ? {} : { actor: entry.actor }),
      })}`,
    );
  }
}

async function commandTrigger(
  context: Context,
  io: CliIo,
  argv: readonly string[],
): Promise<void> {
  const flags = parseValueFlags(argv, ["--type", "--object", "--summary", "--data"]);
  const source = flags.positionals[0];
  const key = flags.positionals[1];
  if (source === undefined || key === undefined) {
    throw new UsageError("trigger needs a source and a key");
  }
  if (flags.positionals.length > 2) {
    throw new UsageError("trigger takes one source and one key");
  }
  if (source === "operad") {
    throw new UsageError('trigger: the source "operad" is reserved');
  }

  const dataFile = flags.values.get("--data");
  let data: string | undefined;
  if (dataFile !== undefined) {
    try {
      data = readFileSync(dataFile, "utf8");
    } catch (error) {
      throw new UsageError(`trigger: cannot read ${dataFile}: ${String(error)}`);
    }
  }

  const rules = await loadTriggerRules({
    home: context.home,
    registry: context.registry,
  });
  const kernel = kernelFor(context, io, rules);
  const type = flags.values.get("--type") ?? "event";
  const object = flags.values.get("--object");
  const summary = flags.values.get("--summary");
  const event: TriggerEvent = {
    source,
    key,
    type,
    hops: 0,
    ...(object === undefined ? {} : { object }),
    ...(summary === undefined ? {} : { summary }),
    ...(data === undefined ? {} : { data }),
  };
  const result = await kernel.receive(event);
  if (result.kind === "started" && result.runId !== undefined) {
    io.write(`started ${result.runId}\n`);
  } else if (result.kind === "candidate" && result.pendingId !== undefined) {
    io.write(`waiting ${result.pendingId}\n`);
  } else if (result.kind === "active" && result.runId !== undefined) {
    io.write(`recorded in ${result.runId}\n`);
  } else if (result.kind === "observed") {
    io.write(`observed ${result.flow ?? ""} on ${result.object ?? ""}\n`);
  } else if (result.kind === "skipped") {
    io.write(`not started: ${result.reason ?? "the chain is too deep"}\n`);
  } else {
    io.write(`recorded ${result.inputId}\n`);
  }
}

interface ValueFlags {
  readonly positionals: readonly string[];
  readonly values: ReadonlyMap<string, string>;
}

function parseValueFlags(argv: readonly string[], allowed: readonly string[]): ValueFlags {
  const positionals: string[] = [];
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    if (!allowed.includes(arg)) {
      throw new UsageError(`unknown option "${arg}"`);
    }
    const value = argv[index + 1];
    if (value === undefined) {
      throw new UsageError(`${arg} needs a value`);
    }
    values.set(arg, value);
    index += 1;
  }
  return { positionals, values };
}

function kernelAction(
  command: string,
  registry: PluginRegistry,
): "start" | "dismiss" | undefined {
  if (command === "operad:start") return "start";
  if (command === "operad:dismiss") return "dismiss";
  if (command !== "start" && command !== "dismiss") return undefined;
  return registry.resolveCommand([command]) === undefined ? command : undefined;
}

async function commandKernelAction(
  context: Context,
  io: CliIo,
  action: "start" | "dismiss",
  argv: readonly string[],
): Promise<void> {
  const id = argv[0];
  if (id === undefined) throw new UsageError(`${action} needs a pending id`);
  if (argv.length > 1) throw new UsageError(`${action} takes one pending id`);
  const kernel = kernelFor(context, io, []);
  if (action === "dismiss") {
    await kernel.dismiss(id);
    io.write(`dismissed ${id}\n`);
    return;
  }
  const result = await kernel.startCandidate(id);
  if (result.kind !== "started") {
    throw new StateError(`pending item "${id}" could not be started`);
  }
  io.write(`started ${result.runId}\n`);
}

async function commandHistory(
  context: Context,
  io: CliIo,
  id: string,
  json: boolean,
): Promise<void> {
  const runs = await findHistoryRuns(
    context.log,
    context.registry.objectTypes().map((entry) => entry.type),
    id,
  );
  if (runs.length === 0) {
    // An observed event belongs to no run; its fact is in the global log.
    const globals: GlobalFact[] = [];
    for await (const fact of context.log.readGlobal()) {
      if (fact.cause === id) globals.push(fact);
    }
    if (globals.length > 0) {
      if (json) {
        io.write("[\n");
        for (const [index, fact] of globals.entries()) {
          if (index > 0) io.write(",\n");
          const entry = historyEntry(fact);
          io.write(
            `  ${JSON.stringify({
              time: new Date(entry.time).toISOString(),
              step: entry.step,
              what: entry.what,
              why: entry.why,
            })}`,
          );
        }
        io.write("\n]\n");
        return;
      }
      for (const fact of globals) {
        io.write(`${formatHistoryEntry(historyEntry(fact))}\n`);
      }
      return;
    }
    throw new Error(`no run or object "${id}"`);
  }
  const ordered = [...runs].sort(
    (left, right) => left.startedAt - right.startedAt,
  );

  if (json && ordered.length === 1) {
    const run = ordered[0];
    if (run === undefined) return;
    io.write("[\n");
    await streamEntriesJson(context.log, run.runId, io, "  ");
    io.write("\n]\n");
    return;
  }

  if (json) {
    io.write("[\n");
    for (const [index, run] of ordered.entries()) {
      if (index > 0) io.write(",\n");
      io.write(
        `${JSON.stringify({ id: run.runId, flow: run.flow }).slice(0, -1)},"entries":[\n`,
      );
      await streamEntriesJson(context.log, run.runId, io, "    ");
      io.write("\n  ]}");
    }
    io.write("\n]\n");
    return;
  }

  for (const [index, run] of ordered.entries()) {
    if (index > 0) io.write("\n");
    if (ordered.length > 1) {
      io.write(`run ${run.runId} (${run.flow})\n`);
    }
    for await (const entry of historyEntries(context.log.read(run.runId))) {
      io.write(`${formatHistoryEntry(entry)}\n`);
    }
  }
}

async function commandRunning(
  context: Context,
  io: CliIo,
  json: boolean,
): Promise<void> {
  const running = await listRunning(context.log);
  if (json) {
    io.write(`${JSON.stringify(running, null, 2)}\n`);
    return;
  }
  if (running.length === 0) {
    io.write("nothing is running\n");
    return;
  }
  for (const item of running) {
    io.write(
      `${item.runId}  ${item.flow}  ${item.step ?? "-"}  ${seconds(item.elapsedMs)}\n`,
    );
  }
}

function commandFlows(context: Context, io: CliIo, json: boolean): void {
  const flows = context.registry.flows();
  if (json) {
    io.write(
      `${JSON.stringify(
        flows.map((entry) => ({
          name: entry.flow.name,
          plugin: entry.plugin,
          source: entry.source ?? null,
        })),
        null,
        2,
      )}\n`,
    );
    return;
  }
  if (flows.length === 0) {
    io.write("no flows loaded\n");
    return;
  }
  for (const entry of flows) {
    const source =
      entry.source === undefined || entry.source === entry.plugin
        ? ""
        : `  (${entry.source})`;
    io.write(`${entry.flow.name}  ${entry.plugin}${source}\n`);
  }
}

const CLI_ENTRY = fileURLToPath(new URL("../bin/operad.ts", import.meta.url));

function spawnChild(
  home: string,
  storeRoot: string,
): (runId: string, options: { readonly recover: boolean }) => void {
  return (runId, options) => {
    const directory = join(storeRoot, "logs", "runs");
    mkdirSync(directory, { recursive: true });
    const output = join(directory, `${runId}.out`);
    const fd = openSync(output, "a");
    try {
      const child = Bun.spawn({
        cmd: [
          process.execPath,
          CLI_ENTRY,
          "run-internal",
          runId,
          ...(options.recover ? ["--recover"] : []),
        ],
        cwd: home,
        env: { ...process.env, OPERAD_HOME: home },
        stdin: "ignore",
        stdout: fd,
        stderr: fd,
      });
      child.unref();
    } finally {
      closeSync(fd);
    }
  };
}

async function commandServe(
  context: Context,
  io: CliIo,
  argv: readonly string[],
): Promise<void> {
  const interval = process.env.OPERAD_SERVE_INTERVAL_MS;
  const parsed = interval === undefined ? Number.NaN : Number(interval);
  const controller = new AbortController();
  const stop = (): void => {
    controller.abort();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  let rules: readonly TriggerRule[] = [];
  let sourcesAllowed = true;
  try {
    rules = await loadTriggerRules({
      home: context.home,
      registry: context.registry,
    });
  } catch (error) {
    sourcesAllowed = false;
    io.error(
      `operad: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
  const kernel = kernelFor(context, io, rules);
  if (sourcesAllowed) {
    await kernel.startSources();
  }

  try {
    io.write(`serving ${context.home}\n`);
    await serve({
      home: context.home,
      log: context.log,
      registry: context.registry,
      lockRoot: context.storeRoot,
      kernel,
      spawnRun: spawnChild(context.home, context.storeRoot),
      intervalMs: Number.isFinite(parsed) && parsed > 0 ? parsed : 1_000,
      signal: controller.signal,
      clock: () => Date.now(),
    });
  } finally {
    await kernel.stopSources();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

async function commandRunInternal(
  context: Context,
  io: CliIo,
  argv: readonly string[],
): Promise<void> {
  const { args, present } = splitFlag(argv, "--recover");
  const runId = args[0];
  if (runId === undefined) throw new UsageError("run-internal needs a run id");

  const runs = await context.log.runs();
  const run = runs.find((candidate) => candidate.runId === runId);
  if (run === undefined) throw new Error(`no run "${runId}"`);
  const found = context.registry.flow(run.flow);
  if (found === undefined) {
    throw new StateError(`run "${runId}": flow "${run.flow}" is not loaded`);
  }
  const object = parseObjectKey(run.object);
  let rules: readonly TriggerRule[] = [];
  try {
    rules = await loadTriggerRules({
      home: context.home,
      registry: context.registry,
    });
  } catch (error) {
    // The run still has to finish; a broken rule file is not a run error.
    io.error(`${error instanceof Error ? error.message : String(error)}\n`);
  }
  const kernel = kernelFor(context, io, rules);
  // A start that died after creating its run left no start files; restore
  // them so this runner starts from the input and event that were recorded.
  kernel.adoptStart(run);
  const startInput = readStoredStart(context.storeRoot, runId);
  const trigger = readStoredTrigger(context.storeRoot, runId);
  const runner = new Runner({
    log: context.log,
    flow: found.flow,
    runId,
    registry: context.registry,
    lockRoot: context.storeRoot,
    recover: present,
    ...(object === undefined ? {} : { object }),
    ...(startInput === undefined ? {} : { startInput }),
    ...(trigger === undefined ? {} : { trigger }),
    onEnded: async (endedRunId, state) => {
      await kernel.emitRunEnd(endedRunId, state);
    },
    emit: async (event) => {
      const dot = event.type.indexOf(".");
      if (dot <= 0) {
        throw new Error(`emit: type "${event.type}" must begin with "<plugin>."`);
      }
      await kernel.emitStep(
        runId,
        event.type.slice(0, dot),
        event,
        run.object,
      );
    },
  });
  await runner.run();
}

async function commandPlugin(
  context: Context,
  io: CliIo,
  argv: readonly string[],
): Promise<boolean> {
  const run = await context.registry.runCommand(argv, {
    cwd: context.home,
  });
  if (run === undefined) return false;
  printValue(io, run.value);
  return true;
}

/**
 * The `operad` command. Returns the exit code; the caller sets it and exits.
 * 0 ok, 1 error, 2 usage, 3 state does not allow it, 4 a lock is held.
 */
export async function main(
  args: readonly string[],
  options: MainOptions = {},
): Promise<number> {
  const io = options.io ?? STDIO;
  const home = options.home ?? defaultOperadHome();
  const tty =
    options.isTTY ??
    (process.stdout.isTTY === true && process.stdin.isTTY === true);
  const command = args[0];

  try {
    if (command === "--version" || command === "-V") {
      io.write(`operad ${ENGINE_VERSION}\n`);
      return 0;
    }
    if (command === undefined || command === "help" || command === "--help") {
      io.write(HELP);
      return command === undefined ? 2 : 0;
    }

    if (command === "init") {
      return await commandInit(home, io);
    }

    if (command === "run-internal") {
      const context = await openContext(home, io);
      try {
        await commandRunInternal(context, io, args.slice(1));
      } finally {
        context.views.close();
        await context.log.close();
      }
      return 0;
    }

    if (command === "serve") {
      if (args.length > 1) throw new UsageError("serve takes no arguments");
      const context = await openContext(home, io);
      try {
        await commandServe(context, io, args.slice(1));
      } finally {
        context.views.close();
        await context.log.close();
      }
      return 0;
    }

    if (command === "trigger") {
      const context = await openContext(home, io);
      try {
        await commandTrigger(context, io, args.slice(1));
      } finally {
        await context.log.close();
      }
      return 0;
    }

    if (
      command === "pending" ||
      command === "history" ||
      command === "running" ||
      command === "flows" ||
      command === "list" ||
      command === "show"
    ) {
      const context = await openContext(home, io);
      try {
        if (command === "pending") {
          const { args: rest, present } = splitFlag(args.slice(1), "--json");
          if (rest.length > 0) {
            throw new UsageError("pending takes no arguments");
          }
          await commandPending(context, io, present);
          return 0;
        }
        if (command === "history") {
          const { args: rest, present } = splitFlag(args.slice(1), "--json");
          const id = rest[0];
          if (id === undefined) throw new UsageError("history needs a run id");
          if (rest.length > 1) throw new UsageError("history takes one id");
          await commandHistory(context, io, id, present);
          return 0;
        }
        if (command === "running") {
          const { args: rest, present } = splitFlag(args.slice(1), "--json");
          if (rest.length > 0) {
            throw new UsageError("running takes no arguments");
          }
          await commandRunning(context, io, present);
          return 0;
        }
        if (command === "list") {
          let rest = args.slice(1);
          const jsonFlag = splitFlag(rest, "--json");
          rest = jsonFlag.args;
          const whereFlag = takeRepeatedFlag(rest, "--where");
          rest = whereFlag.args;
          const limitFlag = takeValueFlag(rest, "--limit");
          rest = limitFlag.args;
          const cursorFlag = takeValueFlag(rest, "--cursor");
          rest = cursorFlag.args;
          const type = rest[0];
          if (type === undefined) throw new UsageError("list needs an object type");
          if (rest.length > 1) throw new UsageError("list takes one object type");
          await commandList(context, io, type, jsonFlag.present, tty, {
            where: whereFlag.values,
            limit: limitFlag.value,
            cursor: cursorFlag.value,
          });
          return 0;
        }
        if (command === "show") {
          await commandShow(context, io, args.slice(1), tty);
          return 0;
        }
        const { args: rest, present } = splitFlag(args.slice(1), "--json");
        if (rest.length > 0) throw new UsageError("flows takes no arguments");
        commandFlows(context, io, present);
        return 0;
      } finally {
        context.views.close();
        await context.log.close();
      }
    }

    const context = await openContext(home, io);
    try {
      const action = kernelAction(command, context.registry);
      if (action !== undefined) {
        await commandKernelAction(context, io, action, args.slice(1));
        return 0;
      }
      if (await commandAction(context, io, args, tty)) return 0;
      if (await commandPlugin(context, io, args)) return 0;
    } finally {
      context.views.close();
      await context.log.close();
    }
    throw new UsageError(`unknown command "${command ?? ""}"`);
  } catch (error) {
    if (error instanceof UsageError) {
      io.error(`operad: ${error.message}\n\n${HELP}`);
      return 2;
    }
    if (error instanceof ViewError) {
      if (
        error.kind === "note" ||
        error.kind === "confirm" ||
        error.kind === "ambiguous" ||
        error.kind === "args" ||
        error.kind === "where" ||
        error.kind === "cursor"
      ) {
        io.error(`operad: ${error.message}\n`);
        return 2;
      }
      if (error.kind === "action" || error.kind === "unavailable") {
        io.error(`operad: ${error.message}\n`);
        return 3;
      }
      io.error(`operad: ${error.message}\n`);
      return 1;
    }
    if (error instanceof LockHeldError) {
      io.error(`operad: ${error.message}\n`);
      return 4;
    }
    if (error instanceof StateError) {
      io.error(`operad: ${error.message}\n`);
      return 3;
    }
    if (error instanceof ConfigError) {
      io.error(`operad: ${error.message}\n`);
      return 1;
    }
    io.error(
      `operad: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}
