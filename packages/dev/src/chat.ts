/**
 * Chats on a repository: `dev:chat` opens one in the main clone, read-only, and
 * `dev:chat-worktree` (the step a "yes" to the worktree question starts) gives
 * it a worktree of its own to change code in. Nothing here merges: the worktree's
 * changes reach main only through a task, through integrate.
 */

import { CHAT_TYPE, agentConditionals, type AgentChoices, chatData, createChat, sendMessage, startingEffort, startingModel, titleFromMessage } from "@operad-io/chat";
import {
  isRecord,
  type ActionArgsSchema,
  type ActionTypeDefinition,
  type JsonValue,
  type ObjectStore,
  type PluginStepResult,
  type StepContext,
} from "@operad-io/engine";
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { DevError, DevRefusal, repositoryData, type RepositoryData } from "./model.ts";
import {
  assertInsideRepository,
  readDevSettings,
  type DevSettings,
} from "./settings.ts";
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

/** The access profile of a chat in the main clone: read-only, and no secrets. */
export const CHAT_ACCESS: Readonly<Record<string, JsonValue>> = {
  readOnly: true,
  denyPaths: ["~/.ssh", "~/.gnupg", "~/.aws", "~/.config/gh"],
  // The agent reaches operad through its tools, never through a shell.
  denyCommands: ["operad"],
};

/** The step a repository chat calls at every reply to read its skills and access. */
export const CHAT_SETTINGS_STEP = "dev/chat_settings";

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

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function hasSkill(path: string): boolean {
  try {
    return statSync(join(path, "SKILL.md")).isFile();
  } catch {
    return false;
  }
}

function added(list: string[], path: string): void {
  const normal = resolve(path);
  if (!list.includes(normal)) list.push(normal);
}

/** The skills directly inside a directory: each child that holds a SKILL.md. */
function skillsInside(parent: string): string[] {
  if (!isDirectory(parent)) return [];
  return readdirSync(parent, { withFileTypes: true })
    .map((entry) => join(parent, entry.name))
    .filter((path) => hasSkill(path))
    .sort((left, right) => left.localeCompare(right));
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

/** The access profile of a repository chat: its skills may be read, never changed. */
export function chatAccess(skillPaths: readonly string[], readOnly: boolean): Record<string, JsonValue> {
  const denyPaths = Array.isArray(CHAT_ACCESS.denyPaths) ? [...CHAT_ACCESS.denyPaths] : [];
  for (const path of skillPaths) if (!denyPaths.includes(path)) denyPaths.push(path);
  return {
    ...CHAT_ACCESS,
    readOnly,
    denyPaths,
    ...(skillPaths.length === 0 ? {} : { readPaths: [...skillPaths] }),
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
    return chatArgs(
      [...new Set(offered.flatMap((name) => env.models?.[name]?.list ?? []))],
      [...new Set(offered.flatMap((name) => env.efforts?.[name]?.list ?? []))],
      offered.map((name) => ({ name, models: env.models?.[name], efforts: env.efforts?.[name] })),
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
      throw new DevRefusal(error instanceof Error ? error.message : String(error));
    }
    const effortDefault = ctx.efforts[harness]?.default ?? undefined;
    const settings = await readDevSettings(repository.path);
    let skills: ChatSkillList;
    try {
      skills = repositoryChatSkills(settings, repository.path);
    } catch (error) {
      throw new DevRefusal(error instanceof Error ? error.message : String(error));
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
        access: chatAccess(skills.roots, true),
        skills: skills.directories,
        refresh: CHAT_SETTINGS_STEP,
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

/** The actions of the chat part of dev. */
export const chatActions: readonly ActionTypeDefinition[] = [chatAction];

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
  if (stored === undefined) return failed("there is no such chat");
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
    return failed(error instanceof Error ? error.message : String(error));
  }
  const cwd = chat.cwd.length > 0 ? chat.cwd : repository.path;
  const hasWorktree = typeof stored.data.worktree === "object" && stored.data.worktree !== null;
  let skills: ChatSkillList;
  try {
    skills = repositoryChatSkills(settings, cwd);
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  }
  return {
    result: "done",
    data: {
      cwd,
      access: chatAccess(skills.roots, !hasWorktree),
      skills: [...skills.directories],
    },
  };
}

/**
 * Step `dev/chat_worktree`: opens `work/chat-<id>` for a chat of a repository
 * and moves the chat's working directory there, once. The chat is writable in
 * the worktree; a chat that already has one is left as it is.
 */
export async function runChatWorktree(ctx: StepContext): Promise<PluginStepResult> {
  const object = ctx.object;
  if (object === undefined || object.type !== CHAT_TYPE) return failed("this runs on a chat");
  const stored = await ctx.store.get(CHAT_TYPE, object.id);
  if (stored === undefined) return failed(`there is no chat ${object.id}`);
  if (typeof stored.data.worktree === "object" && stored.data.worktree !== null) {
    return { result: "done", data: { moved: false } };
  }
  const chat = chatData(stored.data);
  const parent = typeof chat.parent === "string" ? chat.parent : "";
  const name = parent.startsWith("repo:") ? parent.slice("repo:".length) : undefined;
  const repoObject = name === undefined ? undefined : await ctx.store.get("repo", name);
  if (repoObject === undefined) return failed(`chat ${object.id} is not a chat about a repository`);
  const repository = repositoryData(repoObject.data);

  let settings;
  try {
    settings = await readDevSettings(repository.path);
  } catch (error) {
    return failed(error instanceof DevError ? error.message : String(error));
  }
  const worktreeName = chatWorktreeName(object.id);
  const prepared = prepareWorktree(repository, settings, worktreeName);
  if (prepared.kind !== "ready") {
    return failed(prepared.message ?? `cannot open a worktree for chat ${object.id}`);
  }
  const path = worktreePath(repository.path, settings, worktreeName);
  const branch = workBranch(worktreeName);

  // Read again: the reply step may have moved the session while git ran.
  const fresh = await ctx.store.get(CHAT_TYPE, object.id);
  if (fresh === undefined) return failed(`there is no chat ${object.id}`);
  if (typeof fresh.data.worktree === "object" && fresh.data.worktree !== null) {
    return { result: "done", data: { moved: false } };
  }
  let skills: ChatSkillList;
  try {
    skills = repositoryChatSkills(settings, path);
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  }
  await ctx.store.put(
    CHAT_TYPE,
    object.id,
    {
      ...fresh.data,
      cwd: path,
      access: chatAccess(skills.roots, false),
      skills: [...skills.directories],
      worktree: { path, branch },
    },
    "step:dev/chat_worktree",
  );
  return { result: "done", data: { moved: true, path, branch } };
}
