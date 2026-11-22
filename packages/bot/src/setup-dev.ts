/**
 * Setup Dev (ADR 0030 D15): turns on `dev` for one repository through a
 * proposal. The prepared prompt has a bot's agent read the repository and
 * propose a `.operad/dev.json`; approving the proposal turns the plugins on,
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
import { writeFileAtomic } from "@operad-io/engine/platform";
import { BotError, readBots } from "./bot.ts";

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

/** The prepared prompt. `docs/user/setup-prompt.md` shows the same text. */
export function setupDevPrompt(bot: string, repo: string): string {
  return `Set up operad's dev for the repository at ${repo}. dev is operad's way of running coding
agents through verified flows (plan, work, verify, review, merge). Your job is to write a
correct \`.operad/dev.json\` for this repo and propose it. Do not change source code, do not
write the file yourself, do not commit, push or start anything. Reply in the language I write
to you in.

Reference, if you need a key's details: https://operad.io/docs/dev/ (the full key table)
and https://operad.io/llms.txt.

1. Look at the repository. Run \`git remote -v\` and find the main branch name in ${repo}.
   The repository needs a git remote; if it has none, say so and stop. Check which agents
   are on PATH: \`claude\`, \`pi\`, \`radian\`. When none is, operad's own pi is the agent.

2. Find this repo's checks. Read CI config (.github/workflows, .gitlab-ci.yml, ...), the
   Makefile, package.json scripts, pyproject, Cargo.toml or whatever applies. Choose the
   commands that CI runs to judge whether a change is good: tests, typecheck, lint, build.
   Each must exit non-zero on failure. Order them fast to slow. Run each once on the
   current checkout; if one already fails on main, tell me instead of hiding it. If the
   repo has no checks, say so and leave \`gate.commands\` empty.

3. Find what a fresh checkout needs. Each task runs in its own git worktree, so dependencies
   are not there. Put the install step in \`prepare\` (for example
   \`bun install --frozen-lockfile\` or \`npm ci\`), only if the repo needs one.

4. Write the \`.operad/dev.json\` text. Use only keys that matter; keep it small. Use the
   \`workers\` form, never the old \`worker\` form:

   {
     "name": "<repo name>",
     "remote": "<remote>",
     "mainBranch": "<main branch>",
     "workers": { "<agent>": { "use": "<agent>/agent", "args": [] } },
     "prepare": [ ... ],
     "gate": { "commands": [ ... ], "commandTimeoutSecs": 1800 },
     "reviewer": { "use": "<agent>/agent", "args": [] },
     "autoDefault": "off"
   }

   - Workers and reviewer: use agents that are actually installed. If two or more are
     installed, use a different one for the reviewer than for the worker. \`use\` is
     \`<plugin>/<step>\`, such as \`claude/agent\`, \`pi/agent\`, \`radian/agent\`.
   - Leave \`autoDefault\` at "off": nothing merges without me.
   - Do not invent model names or flags. Leave \`args\` empty unless I give you some.

5. Propose it. Call the operad \`command\` tool with plugin \`bot\`, verb \`setup-dev\`,
   arguments \`${bot}\` and \`${repo}\`, and the \`.operad/dev.json\` text as its input. It makes
   a pending item; nothing is turned on or written until I approve it in Pending. If it
   refuses, fix what it names and call it again.

6. Report. Show me the \`.operad/dev.json\` you proposed, say in one line why you chose each
   check command, worker and reviewer, and list anything you were unsure about. Tell me
   to commit \`.operad/dev.json\` after I approve it (operad reads it from the main clone).`;
}

/** The line a bot chat starts with, so a sentence is enough to start Setup Dev. */
export const SETUP_DEV_INSTRUCTION =
  "To set up dev for a repository (Setup Dev), call the operad `command` tool with plugin `bot`, verb `setup-dev`, my bot and the repository's directory and no input: it answers with the steps. Nothing is turned on until I approve the proposal in Pending.";

function git(directory: string, args: readonly string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", directory, ...args], {
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
  if ((git(real, ["remote"]) ?? "").length === 0) {
    throw new BotError(`setup-dev: "${path}" has no git remote; add one first`);
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

/** `bot setup-dev <bot> <directory>`: with `dev.json` on stdin it proposes, without it answers the steps. */
export async function runSetupDevCommand(
  ctx: CommandContext,
  argv: readonly string[],
  propose: (bot: string, change: DevChange) => Promise<string>,
): Promise<string> {
  const bot = argv[0];
  const repo = argv[1];
  if (bot === undefined || repo === undefined || argv.length > 2) throw new BotError(USAGE);
  if (readBots(ctx.home)[bot] === undefined) throw new BotError(`there is no bot "${bot}"`);
  const text = (ctx.input ?? "").trim();
  const resolved = isAbsolute(repo) ? repo : resolve(ctx.cwd, repo);
  if (text.length === 0) return setupDevPrompt(bot, resolved);
  return proposeDev(ctx.store, ctx.home, bot, repo, text, ctx.cwd, (change) => propose(bot, change));
}
