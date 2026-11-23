/**
 * Setup Dev (ADR 0030 D15): turns on `dev` for one repository through a
 * proposal. The prepared prompt has a bot's agent read the repository and
 * propose a `.operad/dev.json` (the prompt is the `dev` plugin's guide, read
 * through `./setup.ts`); approving the proposal turns the plugins on,
 * writes the file and asks `dev` to register the repository.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  isMissingFile,
  isRecord,
  messageOf,
  readConfig,
  setPluginEnabled,
  type CommandContext,
  type ObjectStore,
} from "@operad-io/engine";
import { findGit, writeFileAtomic } from "@operad-io/engine/platform";
import { BotError, readBots } from "./bot.ts";
import { setupDevPrompt } from "./setup.ts";

/** The plugins `dev` needs, with the package each is enabled from. */
export const SETUP_DEV_PLUGINS: Readonly<Record<string, string>> = {
  dev: "@operad-io/dev",
  shell: "@operad-io/shell",
  pool: "@operad-io/pool",
};

/** The directory under the home where a request to register a repository is left for `dev`. */
export const DEV_REGISTER_DIRECTORY = "dev-register";

/** What a `dev` proposal stores. */
export interface DevChange {
  /** The repository's directory, resolved. */
  readonly repo: string;
  /** The `dev.json` text to write. */
  readonly json: string;
  /** The file's present text; null when there is none. */
  readonly before: string | null;
  /** The plugins that are off now and would be turned on. */
  readonly plugins: readonly string[];
}

const USAGE = "usage: operad bot setup-dev <bot> <repository directory> [< dev.json]";

/** The line a bot chat starts with, so a sentence is enough to start Setup Dev. */
export const SETUP_DEV_INSTRUCTION =
  "To set up dev for a repository (Setup Dev), call the operad `command` tool with plugin `bot`, verb `setup-dev`, my bot and the repository's directory and no input: it answers with the steps. Nothing is turned on until I approve the proposal in Pending.";

function git(directory: string, args: readonly string[]): string | undefined {
  const program = findGit();
  if (program === undefined) return undefined;
  try {
    return execFileSync(program, ["-C", directory, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

function rootOf(path: string): string {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new BotError(`setup-dev: there is no directory "${path}"`);
  }
  const real = realpathSync(path);
  const top = git(real, ["rev-parse", "--show-toplevel"]);
  if (top === undefined || top.length === 0 || realpathSync(top) !== real) {
    throw new BotError(`setup-dev: "${path}" is not the root of a git work tree`);
  }
  return real;
}

async function registeredPaths(store: ObjectStore): Promise<string[]> {
  const found: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.list("repo", { ...(cursor === undefined ? {} : { cursor }) });
    for (const object of page.objects) {
      if (typeof object.data.path === "string" && object.data.removed !== true) found.push(object.data.path);
    }
    cursor = page.next;
  } while (cursor !== undefined);
  return found;
}

async function pluginsOff(home: string): Promise<string[]> {
  const enabled: string[] = [];
  try {
    for (const entry of (await readConfig(home)).plugins) {
      if (entry.enabled && entry.name !== undefined) enabled.push(entry.name);
    }
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  return Object.keys(SETUP_DEV_PLUGINS).filter((name) => !enabled.includes(name));
}

/** Proposes Setup Dev for a repository; nothing is turned on or written. */
export async function proposeDev(
  store: ObjectStore,
  home: string,
  bot: string,
  repoPath: string,
  jsonText: string,
  cwd: string,
  makeProposal: (change: DevChange) => Promise<string>,
): Promise<string> {
  if (readBots(home)[bot] === undefined) throw new BotError(`there is no bot "${bot}"`);
  const repo = rootOf(isAbsolute(repoPath) ? repoPath : resolve(cwd, repoPath));
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    throw new BotError(`setup-dev: the dev.json text is not JSON: ${messageOf(error)}`);
  }
  if (!isRecord(parsed)) throw new BotError("setup-dev: the dev.json text must be a JSON object");
  // A repository with no remote works on its local main branch: the file names none.
  if ((git(repo, ["remote"]) ?? "").length === 0) delete parsed.remote;
  if ((await registeredPaths(store)).some((path) => resolve(path) === repo)) {
    throw new BotError(`setup-dev: "${repo}" is already registered`);
  }
  const file = join(repo, ".operad", "dev.json");
  let before: string | null = null;
  try {
    before = readFileSync(file, "utf8");
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  return makeProposal({
    repo,
    json: `${JSON.stringify(parsed, null, 2)}\n`,
    before,
    plugins: await pluginsOff(home),
  });
}

/** Turns the plugins on, writes `dev.json` and leaves the request `dev` registers the repository from. */
export async function applyDev(home: string, change: DevChange): Promise<void> {
  const directory = join(change.repo, ".operad");
  mkdirSync(directory, { recursive: true });
  await writeFileAtomic(join(directory, "dev.json"), change.json);
  const requests = join(home, DEV_REGISTER_DIRECTORY);
  mkdirSync(requests, { recursive: true });
  writeFileSync(join(requests, `${randomUUID()}.json`), `${JSON.stringify({ path: change.repo })}\n`);
  // Last, because a change of config.json reloads serve and dev then finds the request.
  for (const name of await pluginsOff(home)) {
    await setPluginEnabled(home, name, true, { optional: SETUP_DEV_PLUGINS });
  }
}

/** The review of a `dev` proposal. */
export function devReview(bot: string, change: DevChange): string {
  const out = [
    `## Setup Dev for ${change.repo}`,
    "",
    `Proposed by bot ${bot}. Approve turns on ${
      change.plugins.length === 0 ? "nothing (dev is already on)" : change.plugins.join(", ")
    }, writes \`.operad/dev.json\` and registers the repository. Reject changes nothing.`,
  ];
  if (change.before !== null) {
    out.push("", "### dev.json now", "", "```json", change.before.trimEnd(), "```");
  }
  out.push("", change.before === null ? "### dev.json" : "### dev.json after", "", "```json", change.json.trimEnd(), "```");
  return out.join("\n");
}

/** Reads a stored change; undefined when it is not one. */
export function devChangeOf(value: unknown): DevChange | undefined {
  if (
    !isRecord(value) ||
    typeof value.repo !== "string" ||
    typeof value.json !== "string" ||
    !(value.before === null || typeof value.before === "string") ||
    !Array.isArray(value.plugins)
  ) {
    return undefined;
  }
  return {
    repo: value.repo,
    json: value.json,
    before: value.before,
    plugins: value.plugins.filter((item): item is string => typeof item === "string"),
  };
}

/** The stream a command reads, and what a test may stand in for. */
export interface PipedInput {
  /** Defaults to the process's standard input. */
  readonly stream?: (AsyncIterable<Uint8Array | string> & { readonly destroy?: () => void }) | undefined;
  /** Settles when a stream that has delivered nothing is given up on; defaults to a timer. */
  readonly giveUp?: Promise<void> | undefined;
}

const FIRST_BYTES_MS = 2000;

/**
 * The text piped to a command that was given none. A terminal, and a pipe that
 * delivers nothing before the deadline, are no input; once data starts the
 * read goes on to the end.
 */
export async function readPiped(input: string | undefined, options: PipedInput = {}): Promise<string> {
  if (input !== undefined) return input;
  const stream = options.stream ?? process.stdin;
  if (options.stream === undefined && process.stdin.isTTY === true) return "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const giveUp =
    options.giveUp ??
    new Promise<void>((done) => {
      timer = setTimeout(done, FIRST_BYTES_MS);
    });
  const iterator = stream[Symbol.asyncIterator]();
  try {
    const first = await Promise.race([iterator.next(), giveUp.then(() => undefined)]);
    if (first === undefined) {
      try {
        stream.destroy?.();
      } catch {
        // The stream already ended.
      }
      return "";
    }
    const chunks: Buffer[] = [];
    let step = first;
    while (!step.done) {
      chunks.push(typeof step.value === "string" ? Buffer.from(step.value, "utf8") : Buffer.from(step.value));
      step = await iterator.next();
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** `bot setup-dev <bot> <directory>`: with `dev.json` on stdin it proposes, without it answers the steps. */
export async function runSetupDevCommand(
  ctx: CommandContext,
  argv: readonly string[],
  propose: (bot: string, change: DevChange) => Promise<string>,
  piped: PipedInput = {},
): Promise<string> {
  const bot = argv[0];
  const repo = argv[1];
  if (bot === undefined || repo === undefined || argv.length > 2) throw new BotError(USAGE);
  if (readBots(ctx.home)[bot] === undefined) throw new BotError(`there is no bot "${bot}"`);
  const text = (await readPiped(ctx.input, piped)).trim();
  const resolved = isAbsolute(repo) ? repo : resolve(ctx.cwd, repo);
  if (text.length === 0) return setupDevPrompt(ctx.setup, bot, resolved);
  return proposeDev(ctx.store, ctx.home, bot, repo, text, ctx.cwd, (change) => propose(bot, change));
}
