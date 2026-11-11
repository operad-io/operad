/**
 * The assistant plugin: a profile is a working directory, a default harness,
 * skills and an access profile; `assistant:chat` opens a chat on one. The
 * chat's own plugin is `chat`; this one only says where and under what rules
 * it runs, and says it again at every reply.
 *
 * Hook for Telegram: a chat bound from a channel is made with
 * {@link openChat} on {@link DEFAULT_PROFILE}; a rule that names another
 * profile is not built yet, and this is the one place it goes.
 */

import { mkdirSync } from "node:fs";
import { CHAT_TYPE, chatData, createChat } from "@operad-io/chat";
import {
  definePlugin,
  type ActionTypeDefinition,
  type JsonValue,
  type ObjectRow,
  type ObjectStore,
  type ObjectViews,
  type SectionContent,
  type StoredObject,
  type PluginStepResult,
  type StepContext,
} from "@operad-io/engine";
import {
  ASSISTANT_SETTINGS,
  DEFAULT_PROFILE,
  PROFILE_TYPE,
  ProfileError,
  readProfiles,
  repositoryPaths,
  resolveProfile,
  type ResolvedProfile,
} from "./profile.ts";

/** The step a chat calls at every reply to read its profile. */
export const PROFILE_STEP = "assistant/profile";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The profile as the row of a list shows it. */
function rowOf(profile: ResolvedProfile): Record<string, JsonValue> {
  return {
    name: profile.name,
    cwd: profile.cwd,
    harness: profile.harness,
    skills: [...profile.skills],
    access: profile.access,
  };
}

/**
 * Makes the profile objects match the settings: one per profile, the default
 * always, and a profile taken out of the settings is marked removed (its chats
 * stop answering). A profile that cannot be used is stored with its problem.
 */
export async function syncProfiles(
  store: ObjectStore,
  home: string,
  fallback: Readonly<Record<string, JsonValue>>,
): Promise<void> {
  const written = readProfiles(home, fallback);
  const repositories = await repositoryPaths(store);
  for (const [name, settings] of Object.entries(written)) {
    let data: Record<string, JsonValue>;
    try {
      data = { ...rowOf(resolveProfile(home, name, settings, repositories)), removed: false };
    } catch (error) {
      if (!(error instanceof ProfileError)) throw error;
      data = { name, removed: false, problem: error.message };
    }
    const current = await store.get(PROFILE_TYPE, name);
    if (current === undefined || JSON.stringify(current.data) !== JSON.stringify(data)) {
      await store.put(PROFILE_TYPE, name, data, "assistant");
    }
  }
  let cursor: string | undefined;
  do {
    const page = await store.list(PROFILE_TYPE, { ...(cursor === undefined ? {} : { cursor }) });
    for (const object of page.objects) {
      if (written[object.id] === undefined && object.data.removed !== true) {
        await store.put(PROFILE_TYPE, object.id, { ...object.data, removed: true }, "assistant");
      }
    }
    cursor = page.next;
  } while (cursor !== undefined);
}

/** What opening a chat needs from the host. */
export interface OpenChat {
  readonly store: ObjectStore;
  readonly home: string;
  readonly settings: Readonly<Record<string, JsonValue>>;
  readonly harnesses: readonly string[];
  readonly profile: string;
  readonly harness?: string | undefined;
  readonly title?: string | undefined;
  readonly cause: string;
}

/** Opens a chat on a profile and returns its id. Refuses with a plain message. */
export async function openChat(input: OpenChat): Promise<string> {
  const written = readProfiles(input.home, input.settings)[input.profile];
  if (written === undefined) throw new ProfileError(`there is no profile "${input.profile}"`);
  const profile = resolveProfile(input.home, input.profile, written, await repositoryPaths(input.store));
  const harness = input.harness ?? profile.harness ?? input.harnesses[0];
  if (harness === undefined) {
    throw new ProfileError("no harness is loaded; load one to chat with the assistant");
  }
  if (!input.harnesses.includes(harness)) {
    throw new ProfileError(
      `harness "${harness}" is not loaded; the loaded ones are: ${input.harnesses.join(", ") || "none"}`,
    );
  }
  mkdirSync(profile.cwd, { recursive: true });
  return createChat(
    input.store,
    {
      parent: `${PROFILE_TYPE}:${profile.name}`,
      harness,
      cwd: profile.cwd,
      access: profile.access,
      skills: profile.skills,
      title: input.title ?? `Assistant (${profile.name})`,
      refresh: PROFILE_STEP,
    },
    input.cause,
  );
}

const chatAction: ActionTypeDefinition = {
  name: "chat",
  on: PROFILE_TYPE,
  args: {
    type: "object",
    description: "Opens a chat with the assistant on this profile.",
    properties: {
      harness: {
        type: "string",
        minLength: 1,
        description:
          "One of the loaded harness plugins; the profile's default harness when left out. It cannot change later.",
      },
      title: { type: "string", minLength: 1, maxLength: 120, description: "What the chat is called." },
    },
    additionalProperties: false,
  },
  when: (state) => state.removed !== true && typeof state.problem !== "string",
  async why(object) {
    if (object.data.removed === true) return `profile ${object.id} is no longer in the settings`;
    if (typeof object.data.problem === "string") return `profile ${object.id}: ${object.data.problem}`;
    return undefined;
  },
  async run(ctx, args) {
    const input = args as { readonly harness?: string; readonly title?: string };
    const id = await openChat({
      store: ctx.store,
      home: ctx.home,
      settings: ctx.settings,
      harnesses: ctx.harnesses,
      profile: ctx.object.id,
      harness: input.harness,
      title: input.title,
      cause: "action:assistant/chat",
    });
    return `opened chat ${id}`;
  },
};

/**
 * Step `assistant/profile`: the working directory, access profile and skills
 * of a chat's profile as they are now. The `chat` reply calls it every time,
 * so tightening access or adding a skill needs no new chat. A profile that is
 * gone or cannot be used fails the reply; it is never answered from an older copy.
 */
export async function runProfile(ctx: StepContext, params: unknown): Promise<PluginStepResult> {
  const chatId = isRecord(params) && typeof params.chat === "string" ? params.chat : undefined;
  const stored = chatId === undefined ? undefined : await ctx.store.get(CHAT_TYPE, chatId);
  if (stored === undefined) return { result: "failed", data: { message: "there is no such chat" } };
  const parent = chatData(stored.data).parent ?? "";
  if (!parent.startsWith(`${PROFILE_TYPE}:`)) {
    return { result: "failed", data: { message: `chat ${chatId} is not a chat of a profile` } };
  }
  const name = parent.slice(PROFILE_TYPE.length + 1);
  try {
    const written = readProfiles(ctx.home, ctx.settings)[name];
    if (written === undefined) {
      return { result: "failed", data: { message: `profile "${name}" is no longer in the settings` } };
    }
    const profile = resolveProfile(ctx.home, name, written, await repositoryPaths(ctx.store));
    mkdirSync(profile.cwd, { recursive: true });
    return {
      result: "done",
      data: { cwd: profile.cwd, access: profile.access, skills: [...profile.skills] },
    };
  } catch (error) {
    return { result: "failed", data: { message: error instanceof Error ? error.message : String(error) } };
  }
}

function profileMarkdown(object: StoredObject): string {
  const data = object.data;
  const lines = [`**${object.id}**`];
  if (typeof data.problem === "string") lines.push(`Cannot be used: ${data.problem}`);
  if (typeof data.cwd === "string") lines.push(`Working directory: ${data.cwd}`);
  if (typeof data.harness === "string") lines.push(`Default harness: ${data.harness}`);
  const skills = Array.isArray(data.skills) ? data.skills : [];
  lines.push(skills.length === 0 ? "No skills." : `Skills: ${skills.join(", ")}`);
  return lines.join("\n\n");
}

/** How a profile shows in a list and on its page. */
export const profileViews: ObjectViews = {
  row: (object): ObjectRow => ({
    id: object.id,
    title: object.id,
    state: object.data.removed === true ? "removed" : "open",
  }),
  sections: () => [{ id: "profile", title: "Profile" }],
  load: (_ctx, object): SectionContent => ({ markdown: profileMarkdown(object) }),
};

/** Builds the assistant plugin. */
export function createAssistantPlugin() {
  return definePlugin({
    name: "assistant",
    kind: "domain",
    version: "0.0.0",
    requires: { plugins: { chat: "^0.0.0" } },
    settings: ASSISTANT_SETTINGS,
    objects: [
      {
        name: PROFILE_TYPE,
        filters: [
          { name: "open", states: ["open"], default: true },
          { name: "removed", states: ["removed"] },
        ],
        // Every list and get sees the profiles the settings name.
        prepare: ({ store, home, settings }) => syncProfiles(store, home, settings),
      },
    ],
    steps: [{ name: "profile", results: ["done", "failed"], run: runProfile }],
    actions: [chatAction],
    views: { [PROFILE_TYPE]: profileViews },
  });
}

export default createAssistantPlugin();

export * from "./profile.ts";
