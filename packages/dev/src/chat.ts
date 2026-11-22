/**
 * Chats on a repository: `dev:chat` opens one in the main clone, read-only, and
 * `dev:chat-worktree` (the step a "yes" to the worktree question starts) gives
 * it a worktree of its own to change code in. Nothing here merges: the worktree's
 * changes reach main only through a task, through integrate.
 */

import { messageOf } from "@operad-io/engine";
import {
  ACCESS_ACTION_REQUEST,
  CHAT_TYPE,
  ACCESS_FACT,
  ENTRY_FACT,
  WORKTREE_EVENT,
  WORKTREE_NOTE,
  WORKTREE_REPLY_EVENT,
  agentConditionals,
  added,
  type AccessChangedData,
  type AgentChoices,
  chatData,
  chatRef,
  createChat,
  hasSkill,
  isDirectory,
  sendMessage,
  skillsInside,
  startingEffort,
  startingModel,
  titleFromMessage,
} from "@operad-io/chat";
import { defaultAccess } from "@operad-io/access-match";
import {
  isRecord,
  modelIds,
  stringList,
  type ActionArgsSchema,
  type ActionContext,
  type ActionTypeDefinition,
  type HarnessModelInfo,
  type JsonValue,
  type ObjectStore,
  type PluginBaseContext,
  type PluginStepResult,
  type StepContext,
} from "@operad-io/engine";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { DevError, DevRefusal, repositoryData, type RepositoryData } from "./model.ts";
import {
  assertInsideRepository,
  readDevSettings,
  type DevSettings,
} from "./settings.ts";
import { git } from "./git.ts";
import { cloneHolder } from "./service.ts";
import { isRegistered, prepareWorktree, workBranch, worktreePath } from "./steps.ts";

/**
 * The harnesses a repository chat offers, in order: the ones that can stop a
 * tool call before it starts, so the main clone stays read-only
 * (ADR 0028 D2, D3). radian is not one.
 */
export const CHAT_HARNESSES = ["claude", "pi"] as const;

/** Why radian is not offered; said up front in the action's description. */
export const RADIAN_NOTE =
  "radian is not offered as an agent here: it cannot stop a tool call before it starts and cannot continue a session in another directory, so it cannot keep the main clone read-only or move to a worktree; use it for a bot chat.";

/**
 * What a repository chat adds to the built-in default: read-only in the main
 * clone, and no operad command. The default already holds the credential paths
 * and the dangerous commands, so the chat keeps them at every level.
 */
export const CHAT_ACCESS: Readonly<Record<string, JsonValue>> = {
  readOnly: true,
  denyPaths: ["~/.ssh", "~/.gnupg", "~/.aws", "~/.config/gh"],
  // The agent reaches operad through its tools, never through a shell.
  denyCommands: ["operad"],
};

/** The step a repository chat calls at every reply to read its skills and access. */
export const CHAT_SETTINGS_STEP = "dev/chat_settings";

/** The action a repository chat runs before it changes its access level. */
export const CHAT_ACCESS_ACTION = "dev/chat_access";

/** The most bytes of the repository's instruction file a chat starts with. */
export const CHAT_CONTEXT_FILE_MAX_BYTES = 32 * 1024;

/** The most other agent file paths a chat starts with. */
export const CHAT_CONTEXT_PATH_MAX = 50;

/** What a repository chat's first session starts with: its place, and the same words alone. */
export interface RepositoryChatContext {
  readonly [key: string]: unknown;
  /** The place, the instructions and the other agent files. */
  readonly text: string;
  /** The place alone, for a chat that moved to its worktree after the text was built. */
  readonly where: string;
}

function realPathOrUndefined(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function insideRoot(root: string, path: string): boolean {
  const real = realPathOrUndefined(path);
  return real !== undefined && (real === root || real.startsWith(`${root}${sep}`));
}

/** The instruction file at the root: `AGENTS.md`, else `CLAUDE.md`, never one outside through a link. */
function instructionFile(base: string, root: string): { readonly path: string; readonly text: string } | undefined {
  for (const name of ["AGENTS.md", "CLAUDE.md"] as const) {
    const path = join(base, name);
    const real = realPathOrUndefined(path);
    if (real === undefined || (real !== root && !real.startsWith(`${root}${sep}`))) continue;
    let isFile = false;
    try {
      isFile = statSync(real).isFile();
    } catch {
      continue;
    }
    if (!isFile) continue;
    const bytes = readFileSync(real);
    if (bytes.length <= CHAT_CONTEXT_FILE_MAX_BYTES) return { path, text: bytes.toString("utf8") };
    // Cut at a character boundary and then at the last line end before the limit.
    let end = CHAT_CONTEXT_FILE_MAX_BYTES;
    while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
    let text = bytes.subarray(0, end).toString("utf8");
    const lineEnd = text.lastIndexOf("\n");
    if (lineEnd >= 0) text = text.slice(0, lineEnd);
    const note = `The file was cut at 32 KB; the whole file is at ${path}.`;
    return { path, text: text.length === 0 ? note : `${text}\n\n${note}` };
  }
  return undefined;
}

/** Every tracked `AGENTS.md` below the root, never the root's own and never one outside through a link. */
function trackedAgentFiles(base: string, root: string): string[] {
  const listed = git(base, ["ls-files", "-z"], { raw: true });
  if (!listed.ok) return [];
  const found: string[] = [];
  for (const path of listed.out.split("\0")) {
    if (path.length === 0 || path === "AGENTS.md" || basename(path) !== "AGENTS.md") continue;
    const absolute = join(base, path);
    if (!insideRoot(root, absolute)) continue;
    const real = realPathOrUndefined(absolute);
    if (real === undefined) continue;
    try {
      if (!statSync(real).isFile()) continue;
    } catch {
      continue;
    }
    found.push(absolute);
  }
  return found;
}

function insideSkill(path: string, skills: readonly string[]): boolean {
  const real = realPathOrUndefined(path);
  if (real === undefined) return false;
  return skills.some((skill) => {
    const base = realPathOrUndefined(skill);
    return base !== undefined && (real === base || real.startsWith(`${base}${sep}`));
  });
}

/** Every file under the root `.agents`, except those inside a skill directory the chat loads. */
function agentFiles(base: string, root: string, skills: readonly string[]): string[] {
  const start = join(base, ".agents");
  if (!insideRoot(root, start)) return [];
  const found: string[] = [];
  const seen = new Set<string>();
  const walk = (path: string): void => {
    const real = realPathOrUndefined(path);
    if (real === undefined || (real !== root && !real.startsWith(`${root}${sep}`))) return;
    let isDirectory = false;
    try {
      isDirectory = statSync(real).isDirectory();
    } catch {
      return;
    }
    if (isDirectory) {
      if (seen.has(real)) return;
      seen.add(real);
      let entries;
      try {
        entries = readdirSync(path, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) walk(join(path, entry.name));
      return;
    }
    let isFile = false;
    try {
      isFile = statSync(real).isFile();
    } catch {
      return;
    }
    if (isFile && !insideSkill(path, skills)) found.push(path);
  };
  walk(start);
  return found;
}

/** The other agent files a chat reads by path, relative to its working directory, with no duplicates. */
function otherAgentFiles(base: string, root: string, skills: readonly string[]): string[] {
  const absolute = new Set([...trackedAgentFiles(base, root), ...agentFiles(base, root, skills)]);
  return [...absolute]
    .map((path) => relative(base, path))
    .sort((left, right) => left.localeCompare(right));
}

/**
 * The text a repository chat's first session starts with: where it is, the
 * repository's instruction file, and the paths of its other agent files. Built
 * from the working directory the reply uses, so a worktree chat names its branch.
 */
export function repositoryChatContext(input: {
  readonly repository: string;
  readonly cwd: string;
  readonly readOnly: boolean;
  /** The chat works in the main clone on the current branch, at its access level (workIn branch). */
  readonly inPlace?: boolean;
  /** The task that holds the main clone on its own branch; the reply is read-only meanwhile. */
  readonly heldBy?: string | undefined;
  readonly branch?: string | undefined;
  readonly skills: readonly string[];
  readonly denyCommands: readonly string[];
}): RepositoryChatContext {
  const root = realPathOrUndefined(input.cwd) ?? resolve(input.cwd);
  const where = [
    `You are answering in an operad chat about the repository ${input.repository}, in ${input.cwd}.`,
    input.heldBy !== undefined
      ? `This chat is read-only in the main clone for now: the task ${input.heldBy} holds the clone on its own branch and is the only one that changes files there. Read and answer, but do not change files or run commands that change anything; when the person wants a change, tell them to wait until ${input.heldBy} is merged, cancelled or rejected, and then ask again.`
      : input.inPlace === true
      ? "This chat works in the main clone, on the branch that is checked out, at its access level. Changes made here are changes to the repository itself; no worktree is opened."
      : input.readOnly
      ? "This chat is read-only in the main clone. Commands that only read run at once; a call that changes a file asks the person first."
      : `This chat works in its own worktree on the branch ${input.branch ?? "unknown"}. Changes reach main through a task, not by merging here.`,
    ...(input.denyCommands.length === 0
      ? []
      : [`These commands are refused here: ${input.denyCommands.join(", ")}.`]),
    ...(input.denyCommands.includes("operad")
      ? ["Use the operad tools you were given to read plans, tasks and pending items."]
      : []),
  ].join("\n");
  const parts = [where];
  const instructions = instructionFile(input.cwd, root);
  if (instructions !== undefined) {
    parts.push(`The repository's instructions follow. Follow them.\n\n${instructions.text}`);
  }
  const files = otherAgentFiles(input.cwd, root, input.skills);
  if (files.length > 0) {
    const shown = files.slice(0, CHAT_CONTEXT_PATH_MAX);
    const lines = [
      "Other agent files in this repository; read the ones that apply to what you work on:",
      ...shown,
      ...(files.length > CHAT_CONTEXT_PATH_MAX
        ? [`[${files.length - CHAT_CONTEXT_PATH_MAX} more files were left out.]`]
        : []),
    ];
    parts.push(lines.join("\n"));
  }
  return { where, text: parts.join("\n\n") };
}

/** The event dev sends after a live worktree yes, so the chat answers the same message there. */
export const CHAT_REPLY_EVENT = WORKTREE_REPLY_EVENT;

/** The directory name and branch suffix of a chat's worktree. */
export function chatWorktreeName(chatId: string): string {
  return `chat-${chatId}`;
}

interface ChatSkillList {
  /** The skill directories given to the agent. */
  readonly directories: string[];
  /** The directories a listed path names, denied for writing. */
  readonly roots: string[];
}

/**
 * The skills a repository gives its chats at `base` (the main clone or the
 * chat's worktree), read now. A path may be a skill itself, a directory of
 * skills (such as `.agents/skills`), or a `.agents` directory, whose `skills`
 * directory is read the same way. Every skill directly inside is included, so
 * one added later is read at the next reply.
 */
export function repositoryChatSkills(settings: DevSettings, base: string): ChatSkillList {
  const directories: string[] = [];
  const roots: string[] = [];
  settings.skills.forEach((written, index) => {
    const path = resolve(base, written);
    assertInsideRepository(base, path, `skills[${index}]`);
    if (hasSkill(path)) {
      added(roots, path);
      added(directories, path);
      return;
    }
    const agents = isDirectory(path) && basename(path) === ".agents";
    const parent = agents ? join(path, "skills") : path;
    if (isDirectory(path)) added(roots, parent);
    for (const skill of skillsInside(parent)) added(directories, skill);
  });
  return { directories, roots };
}

/**
 * The access profile of a repository chat. In the main clone its skills may be
 * read but not changed; in its own worktree they are repository files the chat
 * changes like any other, and the change reaches main through a task.
 */
export function chatAccess(skillPaths: readonly string[], readOnly: boolean): Record<string, JsonValue> {
  const base = defaultAccess();
  const denyPaths = [...(base.denyPaths ?? [])];
  for (const path of stringList(CHAT_ACCESS.denyPaths)) if (!denyPaths.includes(path)) denyPaths.push(path);
  const denyCommands = [...(base.denyCommands ?? [])];
  for (const command of stringList(CHAT_ACCESS.denyCommands)) {
    if (!denyCommands.includes(command)) denyCommands.push(command);
  }
  const protectedPaths = readOnly ? skillPaths : [];
  for (const path of protectedPaths) if (!denyPaths.includes(path)) denyPaths.push(path);
  return {
    denyPaths,
    denyCommands,
    askCommands: [...(base.askCommands ?? [])],
    askPaths: [...(base.askPaths ?? [])],
    readOnly,
    ...(protectedPaths.length === 0 ? {} : { readPaths: [...protectedPaths] }),
  };
}

/**
 * The worktree name a task opened from chat `chatId` works in. The chat must be
 * about this repository and must already have been given its worktree.
 */
export async function chatWorktreeOf(
  store: ObjectStore,
  repository: RepositoryData,
  chatId: string,
): Promise<string> {
  const stored = await store.get(CHAT_TYPE, chatId);
  if (stored === undefined) throw new DevError("chat", `there is no chat ${chatId}`);
  if (stored.data.parent !== `repo:${repository.name}`) {
    throw new DevError("chat", `chat ${chatId} is not a chat about repository "${repository.name}"`);
  }
  if (typeof stored.data.worktree !== "object" || stored.data.worktree === null) {
    throw new DevError("chat", `chat ${chatId} has no worktree yet`);
  }
  const recorded = (stored.data.worktree as { readonly path?: unknown }).path;
  if (typeof recorded !== "string" || !existsSync(recorded) || !isRegistered(repository.path, recorded)) {
    throw new DevError("chat", `the worktree of chat ${chatId} is gone`);
  }
  return chatWorktreeName(chatId);
}

/** The `dev:chat` arguments; `models` and `efforts` are the ones the offered agents list. */
function chatArgs(
  models: readonly string[],
  efforts: readonly string[],
  agents: readonly AgentChoices[] = [],
  info?: Readonly<Record<string, HarnessModelInfo>> | undefined,
): ActionArgsSchema {
  return {
    type: "object",
    description: `Opens a chat about this repository. ${RADIAN_NOTE}`,
    properties: {
      agent: {
        type: "string",
        enum: [...CHAT_HARNESSES],
        description: "Which agent answers in this chat; the first loaded one when left out. It cannot change later.",
      },
      model: {
        type: "string",
        ...(models.length === 0 ? {} : { enum: [...models] }),
        ...(info === undefined ? {} : { info }),
        description: "The model the agent uses; one from that agent's list. The agent's default when left out. It can be changed later.",
      },
      effort: {
        type: "string",
        ...(efforts.length === 0 ? {} : { enum: [...efforts] }),
        description: "The effort the agent uses; one from that agent's list. The agent's default when left out. It can be changed later.",
      },
      title: {
        type: "string",
        minLength: 1,
        maxLength: 120,
        description: "What the chat is called.",
      },
      message: {
        type: "string",
        role: "note",
        minLength: 1,
        description:
          "The first message; the chat is created and the message sent in one step. The title is taken from its start when none is given.",
      },
    },
    ...(agents.length === 0 ? {} : { allOf: agentConditionals(agents) }),
    additionalProperties: false,
  };
}

const chatAction: ActionTypeDefinition = {
  name: "chat",
  on: "repo",
  creates: "chat",
  args: chatArgs([], []),
  argsFor: (_object, env) => {
    const offered = CHAT_HARNESSES.filter((name) => (env.harnesses ?? []).includes(name));
    const info: Record<string, HarnessModelInfo> = {};
    for (const name of offered) {
      for (const [id, model] of Object.entries(env.models?.[name]?.info ?? {})) info[id] = model;
    }
    return chatArgs(
      [...new Set(offered.flatMap((name) => modelIds(env.models?.[name])))],
      [...new Set(offered.flatMap((name) => env.efforts?.[name]?.list ?? []))],
      offered.map((name) => ({ name, models: env.models?.[name], efforts: env.efforts?.[name] })),
      Object.keys(info).length === 0 ? undefined : info,
    );
  },
  when: (state) => repositoryData(state).removed !== true,
  async run(ctx, args) {
    const input = args as {
      readonly agent?: string;
      readonly model?: string;
      readonly effort?: string;
      readonly title?: string;
      readonly message?: string;
    };
    const repository = repositoryData(ctx.object.data);
    const offered = CHAT_HARNESSES.filter((name) => ctx.harnesses.includes(name));
    const harness = input.agent ?? offered[0];
    if (harness === undefined) {
      throw new DevRefusal(`no agent for a repository chat is loaded; load one of ${CHAT_HARNESSES.join(", ")}`);
    }
    if (harness === "radian") throw new DevRefusal(RADIAN_NOTE);
    if (!offered.includes(harness as (typeof CHAT_HARNESSES)[number])) {
      throw new DevRefusal(
        `agent "${harness}" is not offered for a repository chat; the loaded ones that are: ${offered.join(", ") || "none"}`,
      );
    }
    let model: string | undefined;
    let effort: string | undefined;
    try {
      model = startingModel(harness, ctx.models[harness], input.model);
      effort = startingEffort(harness, ctx.efforts[harness], input.effort);
    } catch (error) {
      throw new DevRefusal(messageOf(error));
    }
    const effortDefault = ctx.efforts[harness]?.default ?? undefined;
    const settings = await readDevSettings(repository.path);
    let skills: ChatSkillList;
    try {
      skills = repositoryChatSkills(settings, repository.path);
    } catch (error) {
      throw new DevRefusal(messageOf(error));
    }
    const id = await createChat(
      ctx.store,
      {
        parent: `repo:${ctx.object.id}`,
        harness,
        ...(model === undefined ? {} : { model }),
        ...(effort === undefined ? {} : { effort }),
        ...(effort === undefined || effortDefault === undefined ? {} : { effortDefault }),
        cwd: repository.path,
        access: chatAccess(skills.roots, settings.workIn !== "branch"),
        accessLevel: "plan",
        accessDefault: "plan",
        skills: skills.directories,
        refresh: CHAT_SETTINGS_STEP,
        accessAction: CHAT_ACCESS_ACTION,
        title:
          input.title ??
          (input.message === undefined ? undefined : titleFromMessage(input.message)) ??
          `Chat about ${repository.name}`,
      },
      "action:dev/chat",
    );
    const sent = input.message === undefined ? undefined : await sendMessage(ctx, id, input.message);
    return { text: `opened chat ${id}${sent === undefined ? "" : `; ${sent}`}`, opens: `chat:${id}` };
  },
};

function failed(message: string): PluginStepResult {
  return { result: "failed", data: { message } };
}

/**
 * Step `dev/chat_settings`: the skills and access of a repository chat as they
 * are now. The reply calls it every time, so a skill added, changed or removed
 * is read at the next reply, from the main clone while the chat is read-only
 * and from its worktree once it has one.
 */
export async function runChatSettings(ctx: StepContext, params: unknown): Promise<PluginStepResult> {
  const chatId = isRecord(params) && typeof params.chat === "string" ? params.chat : undefined;
  const stored = chatId === undefined ? undefined : await ctx.store.get(CHAT_TYPE, chatId);
  if (stored === undefined || chatId === undefined) return failed("there is no such chat");
  const chat = chatData(stored.data);
  const parent = typeof chat.parent === "string" ? chat.parent : "";
  const name = parent.startsWith("repo:") ? parent.slice("repo:".length) : undefined;
  if (name === undefined) {
    return failed(`chat ${chatId} is not a chat about a repository`);
  }
  const repoObject = await ctx.store.get("repo", name);
  if (repoObject === undefined) return failed(`there is no repository "${name}"`);
  const repository = repositoryData(repoObject.data);
  let settings;
  try {
    settings = await readDevSettings(repository.path);
  } catch (error) {
    return failed(messageOf(error));
  }
  const cwd = chat.cwd.length > 0 ? chat.cwd : repository.path;
  const hasWorktree = isRecord(stored.data.worktree);
  let skills: ChatSkillList;
  try {
    skills = repositoryChatSkills(settings, cwd);
  } catch (error) {
    return failed(messageOf(error));
  }
  const inPlace = !hasWorktree && settings.workIn === "branch";
  // A task that holds the clone on its own branch is the only writer there: the
  // reply reads and says why (ADR 0028 D3, ADR 0039 D3).
  const holder = inPlace ? await cloneHolder(ctx.store, name) : undefined;
  const access = chatAccess(skills.roots, (!hasWorktree && !inPlace) || holder !== undefined);
  const worktree = isRecord(stored.data.worktree) ? stored.data.worktree : {};
  const branch =
    hasWorktree
      ? typeof worktree.branch === "string"
        ? worktree.branch
        : workBranch(chatWorktreeName(chatId))
      : undefined;
  const denyCommands = Array.isArray(access.denyCommands)
    ? access.denyCommands.filter((command): command is string => typeof command === "string")
    : [];
  const context = repositoryChatContext({
    repository: name,
    cwd,
    readOnly: !hasWorktree && !inPlace,
    inPlace,
    ...(holder === undefined ? {} : { heldBy: holder }),
    ...(branch === undefined ? {} : { branch }),
    skills: skills.directories,
    denyCommands,
  });
  return {
    result: "done",
    data: {
      cwd,
      access,
      skills: [...skills.directories],
      context,
      // Nothing to offer when the chat works in the main clone itself.
      ...(inPlace ? { worktreeOffer: false } : {}),
    },
  };
}

/**
 * The action a repository chat runs before its access level changes: a chat
 * still in the main clone that is raised to `edits` or `full` first gets its
 * worktree, exactly as the worktree answer gives it. A chat already in its
 * worktree, a bot chat and a level below `edits` need nothing. A worktree that
 * cannot be opened refuses the change, so the level stays as it was. It is
 * hidden from clients: the chat marks its in-memory object only while it calls
 * this action.
 */
export async function runChatAccess(ctx: ActionContext, args: unknown): Promise<unknown> {
  const level = isRecord(args) && typeof args.level === "string" ? args.level : undefined;
  if (level === undefined) throw new Error("the chat's new access level is needed");
  const stored = await ctx.store.get(CHAT_TYPE, ctx.object.id);
  if (stored === undefined) throw new Error(`there is no chat ${ctx.object.id}`);
  if (level !== "edits" && level !== "full") return "no worktree is needed";
  if (isRecord(stored.data.worktree)) {
    return "the chat already has its worktree";
  }
  const chat = chatData(stored.data);
  const parent = typeof chat.parent === "string" ? chat.parent : "";
  if (!parent.startsWith("repo:")) return "a bot chat works in its own directory";
  const repoObject = await ctx.store.get("repo", parent.slice("repo:".length));
  if (repoObject !== undefined) {
    const settings = await readDevSettings(repositoryData(repoObject.data).path);
    if (settings.workIn === "branch") return "no worktree is needed: the chat works in the main clone";
  }
  const result = await openChatWorktree(
    ctx,
    ctx.object.id,
    ctx.runId ?? `action:dev/chat_access:${ctx.object.id}`,
    "action:dev/chat_access",
  );
  const data = isRecord(result.data) ? result.data : {};
  if (result.result !== "done") {
    throw new Error(
      typeof data.message === "string" && data.message.length > 0
        ? data.message
        : `chat ${ctx.object.id} could not open its worktree`,
    );
  }
  return "the chat now has its worktree";
}

const chatAccessAction: ActionTypeDefinition = {
  name: "chat_access",
  on: CHAT_TYPE,
  args: {
    type: "object",
    properties: { level: { type: "string" } },
    required: ["level"],
    additionalProperties: false,
  },
  when: (state) => state[ACCESS_ACTION_REQUEST] === true,
  run: runChatAccess,
};

/** The actions of the chat part of dev. */
export const chatActions: readonly ActionTypeDefinition[] = [chatAction, chatAccessAction];

/** Opens a chat's worktree and records where it moved; shared by the step and the access action. */
async function openChatWorktree(
  ctx: Pick<PluginBaseContext, "store" | "facts">,
  chatId: string,
  runId: string,
  cause: string,
  raiseLevel = false,
): Promise<PluginStepResult> {
  const stored = await ctx.store.get(CHAT_TYPE, chatId);
  if (stored === undefined) return failed(`there is no chat ${chatId}`);
  if (isRecord(stored.data.worktree)) {
    return { result: "done", data: { moved: false } };
  }
  const chat = chatData(stored.data);
  const parent = typeof chat.parent === "string" ? chat.parent : "";
  const name = parent.startsWith("repo:") ? parent.slice("repo:".length) : undefined;
  const repoObject = name === undefined ? undefined : await ctx.store.get("repo", name);
  if (repoObject === undefined) return failed(`chat ${chatId} is not a chat about a repository`);
  const repository = repositoryData(repoObject.data);

  let settings;
  try {
    settings = await readDevSettings(repository.path);
  } catch (error) {
    return failed(error instanceof DevError ? error.message : String(error));
  }
  const worktreeName = chatWorktreeName(chatId);
  const prepared = prepareWorktree(repository, settings, worktreeName);
  if (prepared.kind !== "ready") {
    return failed(prepared.message ?? `cannot open a worktree for chat ${chatId}`);
  }
  const path = worktreePath(repository.path, settings, worktreeName);
  const branch = workBranch(worktreeName);

  // Read again: the reply step may have moved the session while git ran.
  const fresh = await ctx.store.get(CHAT_TYPE, chatId);
  if (fresh === undefined) return failed(`there is no chat ${chatId}`);
  if (isRecord(fresh.data.worktree)) {
    return { result: "done", data: { moved: false } };
  }
  let skills: ChatSkillList;
  try {
    skills = repositoryChatSkills(settings, path);
  } catch (error) {
    return failed(messageOf(error));
  }
  const clean: Record<string, unknown> = { ...fresh.data };
  // Only chat:access marks this in memory, to call its hidden action; it is never stored.
  delete clean[ACCESS_ACTION_REQUEST];
  // A chat that asked for the worktree is read-only only by its level `plan`;
  // the worktree is where it writes, so the level moves to `edits` with it. A
  // level the person set above `plan` stays as it is.
  const freshChat = chatData(fresh.data);
  const level = freshChat.accessLevel ?? (isRecord(fresh.data.access) && fresh.data.access.readOnly === true ? "plan" : "ask");
  const raised = raiseLevel && level === "plan";
  await ctx.store.put(
    CHAT_TYPE,
    chatId,
    {
      ...clean,
      ...(raised ? { accessLevel: "edits" } : {}),
      cwd: path,
      access: chatAccess(skills.roots, false),
      skills: [...skills.directories],
      worktree: { path, branch },
    },
    cause,
  );
  // The transcript says where the chat moved, once. It is an entry of the
  // worktree run, not of a reply, so it does not become the agent's words.
  await ctx.facts.append({
    type: ENTRY_FACT,
    object: chatRef(chatId),
    data: { runId, kind: "worktree", text: WORKTREE_NOTE },
  });
  if (raised) {
    const changed: AccessChangedData = { by: { via: "dev", id: "worktree" }, from: "plan", to: "edits" };
    await ctx.facts.append({ type: ACCESS_FACT, object: chatRef(chatId), data: changed });
  }
  return { result: "done", data: { moved: true, path, branch } };
}

/**
 * Step `dev/chat_worktree`: opens `work/chat-<id>` for a chat of a repository
 * and moves the chat's working directory there, once. The chat is writable in
 * the worktree; a chat that already has one is left as it is.
 */
export async function runChatWorktree(ctx: StepContext): Promise<PluginStepResult> {
  const object = ctx.object;
  if (object === undefined || object.type !== CHAT_TYPE) return failed("this runs on a chat");
  const result = await openChatWorktree(ctx, object.id, ctx.runId, "step:dev/chat_worktree", true);
  // A live yes ended the reply that asked; answer the same message again now
  // that the chat is writable. A reply that ended because the chat moved to
  // its worktree meanwhile (its level was raised) is answered again the same
  // way. A yes that came after the reply ended only opens the worktree, so it
  // starts no reply.
  if (result.result === "done" && ctx.trigger?.type === WORKTREE_EVENT && !lateWorktree(ctx)) {
    await ctx.emit({
      type: CHAT_REPLY_EVENT,
      key: `worktree:${object.id}`,
      object: `${CHAT_TYPE}:${object.id}`,
    });
  }
  return result;
}

/** Whether the event says its yes arrived after the asking reply had ended. */
function lateWorktree(ctx: StepContext): boolean {
  const path = ctx.trigger?.data;
  if (path !== undefined) {
    try {
      const value: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (isRecord(value) && value.late === true) return true;
    } catch {
      // A missing or broken file is not the late marker; fall back to the key.
    }
  }
  // The kernel scopes an emitted key as `<runId>:<key>`, so the reply's "late"
  // arrives as `<runId>:late`. The data file is the primary marker; the key
  // covers an event that carries no data.
  return ctx.trigger?.key.endsWith(":late") === true;
}
