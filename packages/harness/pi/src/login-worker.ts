/**
 * The pi login child (ADR 0023 D11). It is the only place a login imports the
 * pi library; the hub starts it with one JSON argument and speaks the line
 * protocol of `login-protocol.ts` on stdin and stdout. The credential goes to
 * pi's own auth file, and nothing of it is written to stdout.
 */

import { createInterface } from "node:readline";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { messageOf } from "@operad-io/engine";
import { findPi, loadPi } from "./pi-install.ts";
import {
  type LoginCommand,
  type LoginLine,
  type LoginNotice,
  type LoginPrompt,
  type LoginProvider,
  type LoginStart,
} from "./login-protocol.ts";

/** How long the whole login may take; a started login aborts after this. */
export const LOGIN_TIMEOUT_MS = 300_000;

type AuthInteraction = Parameters<ModelRuntime["login"]>[2];
type AuthPrompt = Parameters<AuthInteraction["prompt"]>[0];
type AuthEvent = Parameters<AuthInteraction["notify"]>[0];
type Provider = ReturnType<ModelRuntime["getProviders"]>[number];

function write(line: LoginLine): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

function toPrompt(prompt: AuthPrompt): LoginPrompt {
  switch (prompt.type) {
    case "select":
      return {
        type: "select",
        message: prompt.message,
        options: prompt.options.map((option) => ({
          id: option.id,
          label: option.label,
          ...(option.description === undefined ? {} : { description: option.description }),
        })),
      };
    case "manual_code":
      return {
        type: "manual_code",
        message: prompt.message,
        ...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }),
      };
    case "secret":
    case "text":
      return {
        type: prompt.type,
        message: prompt.message,
        ...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }),
      };
    default:
      throw new Error(`unknown login prompt`);
  }
}

function toNotice(event: AuthEvent): LoginNotice {
  switch (event.type) {
    case "info":
      return {
        type: "info",
        message: event.message,
        ...(event.links === undefined
          ? {}
          : {
              links: event.links.map((link) => ({
                url: link.url,
                ...(link.label === undefined ? {} : { label: link.label }),
              })),
            }),
      };
    case "auth_url":
      return {
        type: "auth_url",
        url: event.url,
        ...(event.instructions === undefined ? {} : { instructions: event.instructions }),
      };
    case "device_code":
      return {
        type: "device_code",
        userCode: event.userCode,
        verificationUri: event.verificationUri,
        ...(event.openBrowserOnConfirm === undefined
          ? {}
          : { openBrowserOnConfirm: event.openBrowserOnConfirm }),
        ...(event.copyCodeOnConfirm === undefined
          ? {}
          : { copyCodeOnConfirm: event.copyCodeOnConfirm }),
        ...(event.intervalSeconds === undefined ? {} : { intervalSeconds: event.intervalSeconds }),
        ...(event.expiresInSeconds === undefined ? {} : { expiresInSeconds: event.expiresInSeconds }),
      };
    case "progress":
      return { type: "progress", message: event.message };
    default:
      throw new Error(`unknown login notice`);
  }
}

function providersOf(runtime: ModelRuntime): readonly LoginProvider[] {
  const providers: LoginProvider[] = [];
  for (const provider of runtime.getProviders() as readonly Provider[]) {
    const oauth = provider.auth.oauth;
    const apiKey = provider.auth.apiKey;
    const apiKeyLogin = apiKey?.login !== undefined;
    if (oauth === undefined && !apiKeyLogin) continue;
    providers.push({
      id: provider.id,
      name: provider.name,
      ...(oauth === undefined
        ? {}
        : {
            oauth: {
              name: oauth.name,
              ...(oauth.loginLabel === undefined ? {} : { label: oauth.loginLabel }),
            },
          }),
      ...(apiKeyLogin && apiKey !== undefined ? { apiKey: { name: apiKey.name } } : {}),
    });
  }
  return providers;
}

async function main(): Promise<void> {
  const text = process.argv[2];
  if (text === undefined) {
    write({ type: "failed", message: "the login child was started without its input" });
    return;
  }
  const start = JSON.parse(text) as LoginStart;
  const install = findPi(start.command, { home: start.home, cwd: start.cwd });
  const pi = await loadPi(install);
  const runtime = await pi.ModelRuntime.create({
    authPath: start.authPath,
    ...(start.modelsPath === null ? {} : { modelsPath: start.modelsPath }),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  write({ type: "providers", providers: providersOf(runtime) });

  const queued: LoginCommand[] = [];
  let wake: (() => void) | undefined;
  const terminal = createInterface({ input: process.stdin });
  terminal.on("line", (line) => {
    let command: LoginCommand;
    try {
      command = JSON.parse(line) as LoginCommand;
    } catch {
      return;
    }
    queued.push(command);
    wake?.();
  });
  const nextCommand = async (): Promise<LoginCommand> => {
    while (queued.length === 0) {
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
    wake = undefined;
    const found = queued.shift();
    if (found === undefined) throw new Error("the login child lost its command queue");
    return found;
  };

  const first = await nextCommand();
  if (first.type !== "login") {
    write({ type: "failed", message: "the login child expected a login command" });
    terminal.close();
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error("the login timed out"));
  }, LOGIN_TIMEOUT_MS);
  let nextId = 0;
  const waiting = new Map<number, (value: string) => void>();
  const interaction: AuthInteraction = {
    signal: controller.signal,
    prompt: async (prompt: AuthPrompt) => {
      nextId += 1;
      const id = nextId;
      write({ type: "prompt", id, prompt: toPrompt(prompt) });
      return await new Promise<string>((resolve, reject) => {
        waiting.set(id, resolve);
        prompt.signal?.addEventListener(
          "abort",
          () => {
            waiting.delete(id);
            reject(new Error("the prompt was closed"));
          },
          { once: true },
        );
      });
    },
    notify: (event: AuthEvent) => {
      write({ type: "notice", event: toNotice(event) });
    },
  };

  // Commands arrive while the login waits for a person or the callback.
  const commands = (async () => {
    for (;;) {
      const command = await nextCommand();
      if (command.type === "answer") {
        const resolve = waiting.get(command.id);
        waiting.delete(command.id);
        resolve?.(command.value);
      } else if (command.type === "cancel") {
        controller.abort(new Error("the login was cancelled"));
      }
    }
  })();
  commands.catch(() => undefined);

  try {
    await runtime.login(first.provider, first.auth, interaction);
    await runtime.settleCredentialWrites();
    write({ type: "done", provider: first.provider, auth: first.auth });
  } catch (error) {
    write({ type: "failed", message: messageOf(error) });
  } finally {
    clearTimeout(timer);
    terminal.close();
    process.exit(0);
  }
}

try {
  await main();
} catch (error) {
  write({ type: "failed", message: messageOf(error) });
  process.exit(1);
}
