/**
 * The login of a bot's agent (ADR 0030 D14). A bot whose agent can log in and
 * is not signed in gets one standing pending item; the `login` action starts a
 * short flow whose one step calls the harness's own login step and writes the
 * model the person chose into the bot's existing `model` setting.
 */

import { randomUUID } from "node:crypto";
import {
  defineFlow,
  isRecord,
  messageOf,
  type ActionTypeDefinition,
  type JsonValue,
  type PluginStepResult,
  type StandingContext,
  type StandingItem,
  type StepContext,
} from "@operad-io/engine";
import { BOT_TYPE, BotError, readBots } from "./bot.ts";
import { updateBotsFile, validateBots } from "./proposals.ts";

/** The step that runs the agent's login and writes the chosen model. */
export const LOGIN_STEP = "bot/login";

/** The event an action sends to start the login flow. */
export const LOGIN_EVENT = "login";

/** The source of that event; the bot plugin owns the login, not a client. */
export const LOGIN_SOURCE = "bot";

/**
 * The harness whose login a bot uses: the agent it names when that agent
 * offers a login step, else the one loaded harness that offers one. Undefined
 * when the bot names none and none or several harnesses can log in.
 */
export function loginHarness(
  named: unknown,
  loaded: readonly string[],
  canLogin: ((harness: string) => boolean) | undefined,
): string | undefined {
  if (typeof named === "string" && named.length > 0) {
    if (!loaded.includes(named)) return undefined;
    return canLogin === undefined || canLogin(named) ? named : undefined;
  }
  const able = loaded.filter((name) => canLogin?.(name) ?? false);
  return able.length === 1 ? able[0] : undefined;
}

/** True when a loaded plugin declares the login step of `harness`. */
function stepCanLogin(
  stepLoaded: ((use: string) => boolean) | undefined,
): ((harness: string) => boolean) | undefined {
  return stepLoaded === undefined ? undefined : (harness) => stepLoaded(`${harness}/login`);
}

/** The one line a failed login gives. */
function failed(message: string): PluginStepResult {
  return { result: "failed", data: { message } };
}

/** Runs `<agent>/login`, then writes the model it returns into the bot's settings. */
export async function runLogin(ctx: StepContext, _params: unknown): Promise<PluginStepResult> {
  const object = ctx.object;
  if (object === undefined || object.type !== BOT_TYPE) {
    return failed("the login needs a bot");
  }
  const harness = loginHarness(object.data.harness, ctx.harnesses, stepCanLogin(ctx.stepLoaded));
  if (harness === undefined) {
    return failed(
      "no agent of this bot has a login here; set the bot's agent, or log in with the agent yourself",
    );
  }
  if (ctx.runStep === undefined) {
    return failed("this host cannot run a login");
  }
  let login: PluginStepResult;
  try {
    login = await ctx.runStep(`${harness}/login`, { bot: object.id }, {
      runId: ctx.runId,
      object: ctx.object,
      cwd: ctx.cwd,
      signal: ctx.signal,
      access: ctx.access,
      flow: ctx.flow,
      trigger: ctx.trigger,
    });
  } catch (error) {
    return failed(messageOf(error));
  }
  if (login.result !== "done") {
    const message = login.data?.message;
    return failed(
      typeof message === "string" && message.length > 0 ? message : `the ${harness} login did not finish`,
    );
  }
  const model = login.data?.model;
  if (typeof model !== "string" || model.length === 0) {
    return failed(`the ${harness} login returned no model`);
  }
  try {
    await updateBotsFile(ctx.home, (bots) => {
      const current = bots[object.id];
      const raw: Record<string, unknown> = isRecord(current) ? current : {};
      // A bot that names no agent now uses the one that logged in; otherwise
      // the model would belong to an agent its chats do not use.
      const named = typeof raw.harness === "string" && raw.harness.length > 0;
      const next = {
        ...bots,
        [object.id]: { ...raw, model, ...(named ? {} : { harness }) } as JsonValue,
      };
      validateBots(next);
      return next;
    });
  } catch (error) {
    return failed(messageOf(error));
  }
  return { result: "done", data: { agent: harness, model } };
}

/** The flow a person's login starts: the step, then the matching end. */
export const loginFlow = defineFlow({
  name: "bot:login",
  entry: "login",
  steps: [
    {
      id: "login",
      kind: "plugin",
      params: { use: LOGIN_STEP, params: {} },
      replay: "unsafe",
      next: { done: "done", failed: "failed", interrupted: "failed" },
    },
    { id: "done", kind: "end", params: { status: "done" }, replay: "safe" },
    { id: "failed", kind: "end", params: { status: "failed" }, replay: "safe" },
  ],
});

/**
 * The action on a bot that starts the login flow. It sends one event; the
 * plugin's rule starts `bot:login` on the bot the event names.
 */
export const loginAction: ActionTypeDefinition = {
  name: "login",
  on: BOT_TYPE,
  // A bot with no model has nothing to do before logging in; after a login,
  // chatting is what a person most likely wants.
  rank: (state) => (state.model === null || state.model === undefined ? -1 : 0),
  when: (state, env) =>
    state.removed !== true &&
    loginHarness(
      state.harness,
      env.harnesses ?? [],
      env.stepLoaded === undefined ? undefined : (harness) => env.stepLoaded?.(`${harness}/login`) === true,
    ) !== undefined,
  async why(object, env) {
    if (object.data.removed === true) return `bot ${object.id} is no longer in the settings`;
    if ((env.harnesses ?? []).length === 0) return `bot ${object.id}: no agent is loaded to log in with`;
    return undefined;
  },
  async run(ctx) {
    if (ctx.emit === undefined) {
      throw new BotError("this host cannot start a login");
    }
    const active = await ctx.runLookup?.active(`${BOT_TYPE}:${ctx.object.id}`);
    if (active?.some((run) => run.flow === "bot:login") === true) {
      return "a login is already waiting";
    }
    const harness =
      loginHarness(
        ctx.object.data.harness,
        ctx.harnesses,
        ctx.stepLoaded === undefined
          ? undefined
          : (name) => ctx.stepLoaded?.(`${name}/login`) === true,
      ) ?? (ctx.harnesses.length === 1 ? ctx.harnesses[0] : undefined);
    if (harness === undefined) {
      throw new BotError("this bot names no agent to log in with");
    }
    await ctx.emit({
      source: LOGIN_SOURCE,
      type: LOGIN_EVENT,
      key: randomUUID(),
      object: `${BOT_TYPE}:${ctx.object.id}`,
      summary: `login ${harness}`,
    });
    return "logging in";
  },
};

/** The bots whose agent can log in and is not signed in. */
export async function loginItems(ctx: StandingContext): Promise<readonly StandingItem[]> {
  const loaded = ctx.harnesses ?? ctx.loaded;
  const canLogin = stepCanLogin(ctx.stepLoaded);
  const items: StandingItem[] = [];
  for (const [name, settings] of Object.entries(readBots(ctx.home, ctx.settings))) {
    const harness = loginHarness(settings.harness, loaded, canLogin);
    if (harness === undefined) continue;
    const active = await ctx.runLookup?.active(`${BOT_TYPE}:${name}`);
    if (active?.some((run) => run.flow === "bot:login") === true) continue;
    if ((await ctx.signedIn?.(harness)) !== false) continue;
    items.push({
      id: `login:${name}`,
      prompt: `bot "${name}" is not logged in to a model`,
      object: { type: BOT_TYPE, id: name },
    });
  }
  return items;
}
