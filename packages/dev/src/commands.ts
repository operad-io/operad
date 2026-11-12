/** The command verbs the dev plugin adds to `operad`. */

import type {
  CommandContext,
  CommandDefinition,
  StoredObject,
} from "@operad-io/engine";
import { DevError, bareId, briefBody, storeKey, taskData, type RepositoryData } from "./model.ts";
import { chatWorktreeOf } from "./chat.ts";
import { flakyTasksByName } from "./flaky.ts";
import { listRerunCounts } from "./reruns.ts";
import { loadProjectFlows } from "./project-flows.ts";
import { readDevSettings } from "./settings.ts";
import { readStdinText, readStdinWithin, type StdinReadOptions } from "./stdin.ts";
import { editText, editorCommand } from "./editor.ts";
import {
  addPlan,
  validatePlanConcurrency,
  addRepository,
  addTask,
  editTaskBrief,
  getTask,
  listRepositories,
  removeRepository,
  requestTaskStart,
  resolveObjectRepository,
  resolveRepository,
  updateTask,
} from "./service.ts";

interface ParsedArguments {
  readonly positionals: readonly string[];
  readonly flags: ReadonlyMap<string, readonly string[]>;
}

function parseArguments(
  argv: readonly string[],
  allowed: readonly string[],
): ParsedArguments {
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  const known = new Set(allowed);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const equals = arg.indexOf("=");
    const name = equals < 0 ? arg : arg.slice(0, equals);
    if (!known.has(name)) {
      throw new DevError(name, "unknown option");
    }
    let value = equals < 0 ? undefined : arg.slice(equals + 1);
    if (value === undefined) {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new DevError(name, "needs a value");
      }
      value = next;
      index += 1;
    }
    const values = flags.get(name) ?? [];
    values.push(value);
    flags.set(name, values);
  }
  return { positionals, flags };
}

function many(parsed: ParsedArguments, flag: string): readonly string[] {
  return parsed.flags.get(flag) ?? [];
}

function one(parsed: ParsedArguments, flag: string): string | undefined {
  const values = many(parsed, flag);
  if (values.length === 0) return undefined;
  if (values.length > 1) throw new DevError(flag, "given more than once");
  return values[0];
}

function required(parsed: ParsedArguments, flag: string, at: string): string {
  const value = one(parsed, flag);
  if (value === undefined) {
    throw new DevError(flag, `${at} needs ${flag} <value>`);
  }
  return value;
}

function subcommand(
  parsed: ParsedArguments,
  allowed: readonly string[],
  at: string,
): { readonly name: string; readonly rest: readonly string[] } {
  const name = parsed.positionals[0];
  if (name === undefined) {
    throw new DevError("command", `${at} needs one of: ${allowed.join(", ")}`);
  }
  if (!allowed.includes(name)) {
    throw new DevError("command", `${at}: unknown subcommand "${name}"`);
  }
  return { name, rest: parsed.positionals.slice(1) };
}

function objectByPlan(
  parsed: ParsedArguments,
  store: CommandContext["store"],
  cwd: string,
): Promise<RepositoryData> {
  return resolveRepository(store, {
    name: one(parsed, "--repo"),
    cwd,
  });
}

async function objectById(
  parsed: ParsedArguments,
  ctx: CommandContext,
  kind: "plan" | "task",
  id: string,
): Promise<{ readonly repository: RepositoryData; readonly id: string }> {
  return resolveObjectRepository(ctx.store, kind, id, {
    name: one(parsed, "--repo"),
    cwd: ctx.cwd,
  });
}

async function runRepo(
  ctx: CommandContext,
  argv: readonly string[],
): Promise<string> {
  const parsed = parseArguments(argv, ["--name"]);
  const call = subcommand(parsed, ["add", "list", "remove"], "repo");
  if (call.name === "add") {
    const path = call.rest[0];
    if (path === undefined) throw new DevError("path", "repo add needs a path");
    if (call.rest.length > 1) {
      throw new DevError("path", "repo add takes one path");
    }
    const repository = await addRepository(ctx.store, {
      path,
      name: one(parsed, "--name"),
      cwd: ctx.cwd,
    });
    return `added ${repository.name} (${repository.path})`;
  }
  if (call.name === "list") {
    if (call.rest.length > 0) throw new DevError("command", "repo list takes no arguments");
    if (many(parsed, "--name").length > 0) {
      throw new DevError("--name", "repo list takes no flags");
    }
    const repositories = await listRepositories(ctx.store);
    if (repositories.length === 0) return "no repositories";
    return repositories
      .map((repository) => `${repository.name}  ${repository.path}`)
      .join("\n");
  }
  const name = call.rest[0];
  if (name === undefined) throw new DevError("name", "repo remove needs a name");
  if (call.rest.length > 1) {
    throw new DevError("name", "repo remove takes one name");
  }
  const repository = await removeRepository(ctx.store, name);
  return `removed ${repository.name}`;
}

function concurrencyFlag(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  return validatePlanConcurrency(raw.trim() === "" ? Number.NaN : Number(raw));
}

function flowFlag(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const name = raw.trim();
  if (name.length === 0) throw new DevError("--flow", "must be a flow name");
  return name;
}

async function assertFlow(repository: RepositoryData, flow: string): Promise<void> {
  const settings = await readDevSettings(repository.path);
  const project = await loadProjectFlows(repository.path, repository.name, settings);
  const refused = project.refused.get(flow);
  if (refused !== undefined) throw new DevError("--flow", refused);
  if (flow === "default") return;
  if (settings.flows[flow] === undefined && !project.flows.has(flow)) {
    throw new DevError(
      "--flow",
      `no flow "${flow}" in repository "${repository.name}"`,
    );
  }
}

async function runPlan(
  ctx: CommandContext,
  argv: readonly string[],
): Promise<string> {
  const parsed = parseArguments(argv, ["--repo", "--slug", "--title", "--concurrency", "--flow"]);
  const call = subcommand(parsed, ["add"], "plan");
  if (call.rest.length > 0) {
    throw new DevError("command", `plan ${call.name} takes flags, not ${call.rest[0]}`);
  }
  const repository = await objectByPlan(parsed, ctx.store, ctx.cwd);
  const flow = flowFlag(one(parsed, "--flow"));
  if (flow !== undefined) await assertFlow(repository, flow);
  const plan = await addPlan(ctx.store, {
    repository,
    slug: required(parsed, "--slug", "plan add"),
    title: required(parsed, "--title", "plan add"),
    request: await readStdinText(ctx.input),
    concurrency: concurrencyFlag(one(parsed, "--concurrency")),
    auto: (await readDevSettings(repository.path)).autoDefault,
    ...(flow === undefined ? {} : { flow }),
  });
  return bareId(plan.id);
}

function editable(task: StoredObject): void {
  const phase = taskData(task.data).phase;
  if (phase !== "proposed" && phase !== "ready") {
    throw new DevError(
      "phase",
      `task is ${phase}; only proposed or ready tasks can change`,
    );
  }
}

/** How long `task edit` waits for a piped brief before it uses the editor. */
const STDIN_WAIT_MS = 1_000;

/** Test-only: what a bounded standard-input read injects. */
export const commandTestHooks: {
  stdin?: StdinReadOptions | undefined;
} = {};

/**
 * The new brief for `task edit`: the text on stdin when stdin is not a
 * terminal and carries some, else what the person saves in `$EDITOR`. A caller
 * that passes its input (the MCP `command` tool) never gets an editor: its
 * stdio is not a terminal.
 *
 * A non-terminal stdin can be a pipe nobody closes. The wait is bounded, and
 * a read that times out falls back to the editor; without an editor it fails
 * and says what it waited for instead of hanging silently.
 */
async function newBrief(ctx: CommandContext, body: string): Promise<string> {
  if (ctx.input !== undefined) {
    const piped = await readStdinText(ctx.input);
    if (piped.trim().length > 0) return piped;
    throw new DevError("brief", "task edit needs the new brief as input");
  }
  if (process.stdin.isTTY === true) {
    return editText(body, { root: ctx.store.root });
  }
  const read = await readStdinWithin(undefined, {
    timeoutMs: STDIN_WAIT_MS,
    ...commandTestHooks.stdin,
  });
  if (read.text.trim().length > 0) return read.text;
  if (read.timedOut && editorCommand() === undefined) {
    throw new DevError(
      "brief",
      `task edit waited ${STDIN_WAIT_MS / 1_000}s for the brief on standard input; nothing arrived, and no editor is set; pipe the brief or set $EDITOR`,
    );
  }
  return editText(body, { root: ctx.store.root });
}

async function runTask(
  ctx: CommandContext,
  argv: readonly string[],
): Promise<string> {  const parsed = parseArguments(argv, [
    "--repo",
    "--plan",
    "--slug",
    "--title",
    "--after",
    "--area",
    "--flow",
    "--chat",
  ]);
  const call = subcommand(parsed, ["add", "edit", "update"], "task");

  if (call.name === "add") {
    if (call.rest.length > 0) {
      throw new DevError("command", `task add takes flags, not ${call.rest[0]}`);
    }
    const repository = await objectByPlan(parsed, ctx.store, ctx.cwd);
    const plan = required(parsed, "--plan", "task add");
    const planKey = storeKey(repository.name, plan);
    const planObject = await ctx.store.get("plan", planKey);
    if (planObject === undefined) {
      throw new DevError("plan", `no plan "${plan}"`);
    }
    if (
      (planObject.data as { repository?: unknown }).repository !==
      repository.name
    ) {
      throw new DevError(
        "plan",
        `plan "${plan}" is not in repository "${repository.name}"`,
      );
    }
    const flow = flowFlag(one(parsed, "--flow"));
    if (flow !== undefined) await assertFlow(repository, flow);
    const chat = one(parsed, "--chat");
    const worktree =
      chat === undefined ? undefined : await chatWorktreeOf(ctx.store, repository, chat);
    const task = await addTask(ctx.store, {
      plan: planKey,
      slug: required(parsed, "--slug", "task add"),
      title: required(parsed, "--title", "task add"),
      brief: await readStdinText(ctx.input),
      after: many(parsed, "--after"),
      area: one(parsed, "--area"),
      ...(flow === undefined ? {} : { flow }),
      ...(worktree === undefined ? {} : { worktree }),
    });
    return bareId(task.id);
  }

  const id = call.rest[0];
  if (id === undefined) {
    throw new DevError("id", `task ${call.name} needs a task id`);
  }
  if (call.rest.length > 1) {
    throw new DevError("id", `task ${call.name} takes one task id`);
  }
  const target = await objectById(parsed, ctx, "task", id);
  const key = storeKey(target.repository.name, target.id);
  const task = await getTask(ctx.store, key);

  if (call.name === "edit") {
    editable(task);
    const body = briefBody(taskData(task.data).brief);
    const edited = await newBrief(ctx, body);
    await editTaskBrief(ctx.store, key, edited);
    return target.id;
  }

  const title = one(parsed, "--title");
  // `--after ""` clears the dependencies, as `--area ""` clears the area.
  const afterGiven = many(parsed, "--after");
  const after = afterGiven.filter((id) => id !== "");
  const area = one(parsed, "--area");
  const flow = flowFlag(one(parsed, "--flow"));
  if (flow !== undefined) await assertFlow(target.repository, flow);
  return bareId(
    (
      await updateTask(ctx.store, key, {
        ...(title === undefined ? {} : { title }),
        ...(afterGiven.length === 0 ? {} : { after }),
        ...(area === undefined ? {} : { area }),
        ...(flow === undefined ? {} : { flow }),
        runs: ctx.runs,
      })
    ).id,
  );
}

async function runStart(
  ctx: CommandContext,
  argv: readonly string[],
): Promise<string> {
  const parsed = parseArguments(argv, ["--repo"]);
  const id = parsed.positionals[0];
  if (id === undefined) throw new DevError("id", "start needs a task id");
  if (parsed.positionals.length > 1) {
    throw new DevError("id", "start takes one task id");
  }
  const target = await objectById(parsed, ctx, "task", id);
  await requestTaskStart(ctx.store, storeKey(target.repository.name, target.id));
  return `start requested for ${target.id}`;
}

async function runReruns(
  ctx: CommandContext,
  argv: readonly string[],
): Promise<string> {
  if (argv.length > 0) throw new DevError("reruns", "takes no arguments");
  const counts = await listRerunCounts(ctx.store);
  if (counts.length === 0) return "no test has passed on a rerun yet";
  const tasks = await flakyTasksByName(ctx.store);
  return counts
    .map((entry) => {
      const task = tasks.get(entry.name);
      return `${entry.count}\t${entry.name}${task === undefined ? "" : `\t${task}`}`;
    })
    .join("\n");
}

export const commands: readonly CommandDefinition[] = [
  {
    name: "repo",
    args: "add <path> [--name <name>] | list | remove <name>",
    run: runRepo,
  },
  {
    name: "plan",
    args: "add --slug <slug> --title <title> [--concurrency <n>] [--flow <name>] [--repo <name>]",
    run: runPlan,
  },
  {
    name: "task",
    args:
      "add --plan <plan> --slug <slug> --title <title> [--after <task>]... [--area <area>] [--flow <name>] [--repo <name>] [--chat <id>] | edit <id> [--repo <name>] (the new brief on stdin, or $EDITOR) | update <id> [--title <title>] [--after <task>]... [--area <area>] [--flow <name>] [--repo <name>]",
    run: runTask,
  },
  {
    name: "reruns",
    args: "",
    run: runReruns,
  },
  {
    name: "start",
    args: "<task> [--repo <name>]",
    run: runStart,
  },
];
