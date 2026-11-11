/**
 * Chats on a repository: `dev:chat` opens one in the main clone, read-only, and
 * `dev:chat-worktree` (the step a "yes" to the worktree question starts) gives
 * it a worktree of its own to change code in. Nothing here merges: the worktree's
 * changes reach main only through a task, through integrate.
 */

import { CHAT_TYPE, chatData, createChat } from "@operad-io/chat";
import type {
  ActionTypeDefinition,
  JsonValue,
  PluginStepResult,
  StepContext,
} from "@operad-io/engine";
import { DevError, DevRefusal, repositoryData } from "./model.ts";
import { readDevSettings } from "./settings.ts";
import { prepareWorktree, workBranch, worktreePath } from "./steps.ts";

/**
 * The harnesses a repository chat offers, in order: the ones that can stop a
 * tool call before it starts, so the main clone stays read-only
 * (`operad-conversation.md` decisions 13 and 14). harness-radian is not one.
 */
export const CHAT_HARNESSES = ["harness-claude", "harness-pi"] as const;

/** Why radian is not offered; said up front in the action's description. */
export const RADIAN_NOTE =
  "harness-radian is not offered here: it cannot stop a tool call before it starts and cannot continue a session in another directory, so it cannot keep the main clone read-only or move to a worktree; use it for an assistant chat.";

/** The access profile of a chat in the main clone: read-only, and no secrets. */
export const CHAT_ACCESS: Readonly<Record<string, JsonValue>> = {
  readOnly: true,
  denyPaths: ["~/.ssh", "~/.gnupg", "~/.aws", "~/.config/gh"],
  // The agent reaches operad through its tools, never through a shell.
  denyCommands: ["operad"],
};

/** The directory name and branch suffix of a chat's worktree. */
export function chatWorktreeName(chatId: string): string {
  return `chat-${chatId}`;
}

const chatAction: ActionTypeDefinition = {
  name: "chat",
  on: "repo",
  args: {
    type: "object",
    description: `Opens a chat about this repository. ${RADIAN_NOTE}`,
    properties: {
      harness: {
        type: "string",
        minLength: 1,
        description: `One of the loaded harnesses ${CHAT_HARNESSES.join(", ")}; the first loaded one when left out. It cannot change later.`,
      },
      title: {
        type: "string",
        minLength: 1,
        maxLength: 120,
        description: "What the chat is called.",
      },
    },
    additionalProperties: false,
  },
  when: (state) => repositoryData(state).removed !== true,
  async run(ctx, args) {
    const input = args as { readonly harness?: string; readonly title?: string };
    const repository = repositoryData(ctx.object.data);
    const offered = CHAT_HARNESSES.filter((name) => ctx.harnesses.includes(name));
    const harness = input.harness ?? offered[0];
    if (harness === undefined) {
      throw new DevRefusal(`no harness for a repository chat is loaded; load one of ${CHAT_HARNESSES.join(", ")}`);
    }
    if (harness === "harness-radian") throw new DevRefusal(RADIAN_NOTE);
    if (!offered.includes(harness as (typeof CHAT_HARNESSES)[number])) {
      throw new DevRefusal(
        `harness "${harness}" is not offered for a repository chat; the loaded ones that are: ${offered.join(", ") || "none"}`,
      );
    }
    const id = await createChat(
      ctx.store,
      {
        parent: `repo:${ctx.object.id}`,
        harness,
        cwd: repository.path,
        access: CHAT_ACCESS,
        title: input.title ?? `Chat about ${repository.name}`,
      },
      "action:dev/chat",
    );
    return `opened chat ${id}`;
  },
};

/** The actions of the chat part of dev. */
export const chatActions: readonly ActionTypeDefinition[] = [chatAction];

function failed(message: string): PluginStepResult {
  return { result: "failed", data: { message } };
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
  const access = chatData(fresh.data).access;
  await ctx.store.put(
    CHAT_TYPE,
    object.id,
    { ...fresh.data, cwd: path, access: { ...access, readOnly: false }, worktree: { path, branch } },
    "step:dev/chat_worktree",
  );
  return { result: "done", data: { moved: true, path, branch } };
}
