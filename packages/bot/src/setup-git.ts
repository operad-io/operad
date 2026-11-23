/**
 * "Set up git here" (ADR 0039 D8): the bot's side. A task needs git, and a
 * folder may have none; at the first task the bot's agent calls the agent-only
 * verb `setup-git` and a pending item titled "Set up git here" (在这里设置 git)
 * shows the `.gitignore`, the files the first commit would hold and the name and
 * email the commit is made with. Nothing is written into the folder, and git is
 * not run in it, until the person approves; approval leaves a request that
 * `dev` carries out (`dev/src/setup-git.ts`).
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  DEFAULT_GITIGNORE,
  DEV_GIT_GUIDE,
  existingGitignore,
  firstCommitList,
  gitStateOf,
  type FirstCommitList,
} from "@operad-io/dev";
import { isRecord, messageOf, type CommandContext } from "@operad-io/engine";
import type { GitFinderHost } from "@operad-io/engine/platform";
import { BotError, readBots } from "./bot.ts";
import { readPiped, type PipedInput } from "./setup-dev.ts";
import { renderGuide } from "./setup.ts";

/** The directory under the home where requests for `dev` are left (the one Setup Dev uses). */
const REQUESTS_DIRECTORY = "dev-register";

/** The title of the pending item, in English and in Chinese. */
export const SETUP_GIT_TITLE = "Set up git here";
export const SETUP_GIT_TITLE_ZH = "在这里设置 git";

/** The paths a review lists before it says how many more there are. */
const REVIEW_PATHS = 200;

/** The name and email a commit is made with. */
export interface GitIdentityFields {
  readonly name: string;
  readonly email: string;
}

/** What a "Set up git here" proposal stores. */
export interface GitChange {
  /** The folder, resolved. */
  readonly repo: string;
  /** The `.gitignore` text that is written and committed. */
  readonly gitignore: string;
  /** The folder's own `.gitignore` text now; null when it has none. */
  readonly before: string | null;
  /** The files the first commit holds, exactly; approval commits these and nothing else. */
  readonly files: readonly string[];
  /** Folders that are repositories of their own; they are not committed. */
  readonly nested: readonly string[];
  /** The sentence that asks to check the `.gitignore` first, when the folder is large. */
  readonly note: string | null;
  /** The name and email to store in the repository; null when git already has an identity. */
  readonly identity: GitIdentityFields | null;
  /** True when the folder has no repository yet; false when it has one without a commit. */
  readonly init: boolean;
  /** The language of the pending item's title. */
  readonly language: "en" | "zh";
}

const USAGE =
  'usage: operad bot setup-git <bot> <folder> [< {"gitignore": "...", "identity": {"name": "...", "email": "..."}}]';

/** The line a bot chat starts with: when the agent proposes the git setup, and that git is never asked about before. */
export const SETUP_GIT_INSTRUCTION =
  "When I want a task in a folder and operad answers that git is not installed or not set up there, call the operad `command` tool with plugin `bot`, verb `setup-git`, my bot and the folder, with no input: it answers with the steps. Never ask me about git before that; chatting and changing files need none. Nothing is installed or written until I approve it in Pending.";

/** The language of the title: Chinese when the computer's locale is. */
export function titleLanguage(env: NodeJS.ProcessEnv = process.env): "en" | "zh" {
  const locale = env.LC_ALL ?? env.LC_MESSAGES ?? env.LANG ?? "";
  return /^zh/i.test(locale) ? "zh" : "en";
}

/** The title of the pending item. */
export function gitTitle(language: "en" | "zh"): string {
  return language === "zh" ? SETUP_GIT_TITLE_ZH : SETUP_GIT_TITLE;
}

/** What the computer account says about the person, to prefill the commit's name and email. */
export interface AccountHost {
  readonly username: () => string;
  readonly hostname: () => string;
}

const realAccount: AccountHost = { username: () => userInfo().username, hostname: () => hostname() };

/** The name and email prefilled from the computer account; the person confirms them in the chat. */
export function accountIdentity(host: AccountHost = realAccount): GitIdentityFields {
  const name = host.username();
  return { name, email: `${name}@${host.hostname()}` };
}

function parseInput(text: string): { gitignore: string | undefined; identity: GitIdentityFields | undefined } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new BotError(`setup-git: the input is not JSON: ${messageOf(error)}`);
  }
  if (!isRecord(parsed)) throw new BotError("setup-git: the input must be a JSON object");
  const gitignore = parsed.gitignore;
  if (gitignore !== undefined && typeof gitignore !== "string") {
    throw new BotError("setup-git: gitignore must be text");
  }
  let identity: GitIdentityFields | undefined;
  if (parsed.identity !== undefined) {
    const given = parsed.identity;
    if (!isRecord(given) || typeof given.name !== "string" || typeof given.email !== "string") {
      throw new BotError("setup-git: identity must have a name and an email, both text");
    }
    const name = given.name.trim();
    const email = given.email.trim();
    if (name === "" || !/^[^\s@]+@[^\s@]+$/.test(email)) {
      throw new BotError("setup-git: identity needs a name and an email address such as name@example.com");
    }
    identity = { name, email };
  }
  return { gitignore, identity };
}

// The folder's own text with the default lines it does not have yet added after it.
function withDefaults(existing: string): string {
  const have = new Set(existing.split("\n").map((line) => line.trim()));
  const added = DEFAULT_GITIGNORE.split("\n").filter(
    (line) => line.trim() !== "" && !line.startsWith("#") && !have.has(line.trim()),
  );
  if (added.length === 0) return existing;
  return `${existing.endsWith("\n") || existing === "" ? existing : `${existing}\n`}${added.join("\n")}\n`;
}

function folderOf(path: string): string {
  if (statSync(path, { throwIfNoEntry: false })?.isDirectory() !== true) {
    throw new BotError(`setup-git: there is no directory "${path}"`);
  }
  return realpathSync(path);
}

/** What a test may stand in for. */
export interface ProposeGitOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly account?: AccountHost;
  /** The home folder that is refused; the default is the computer account's. */
  readonly homeFolder?: string;
  /** The machine the git program is looked up on; a test injects one without git. */
  readonly finder?: GitFinderHost;
}

/** Makes the proposal for a folder; nothing is written into it. */
export function proposeGit(
  home: string,
  bot: string,
  folderPath: string,
  inputText: string,
  cwd: string,
  options: ProposeGitOptions = {},
): GitChange {
  if (readBots(home)[bot] === undefined) throw new BotError(`there is no bot "${bot}"`);
  const folder = folderOf(isAbsolute(folderPath) ? folderPath : resolve(cwd, folderPath));
  const input = parseInput(inputText);
  const state = gitStateOf(folder, {
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.finder === undefined ? {} : { finder: options.finder }),
  });
  switch (state.state) {
    case "no program":
      throw new BotError(
        "setup-git: git is not installed on this machine. Follow the steps for installing git (each command is a pending item the person approves), then call setup-git again.",
      );
    case "subfolder":
      throw new BotError(
        `setup-git: "${folder}" is inside the git repository at "${state.root}"; set up nothing here and use "${state.root}" instead`,
      );
    case "ready":
      throw new BotError(`setup-git: "${folder}" already has git and a first commit; there is nothing to set up`);
    default:
      break;
  }
  const own = existingGitignore(folder);
  const text = input.gitignore ?? (own === undefined ? DEFAULT_GITIGNORE : withDefaults(own));
  let list: FirstCommitList;
  try {
    list = firstCommitList(folder, text, {
      ...(options.homeFolder === undefined ? {} : { home: options.homeFolder }),
      ...(options.env === undefined ? {} : { env: options.env }),
    });
  } catch (error) {
    throw new BotError(`setup-git: ${messageOf(error)}`);
  }
  return {
    repo: folder,
    gitignore: text,
    before: list.existingGitignore ?? null,
    files: list.files,
    nested: list.nested,
    note: list.note ?? null,
    identity: state.identity.set ? null : (input.identity ?? accountIdentity(options.account)),
    init: state.state === "no repository",
    language: titleLanguage(options.env),
  };
}

/** The review of a "Set up git here" proposal. */
export function gitReview(bot: string, change: GitChange): string {
  const out = [
    `## ${gitTitle(change.language)}: ${change.repo}`,
    "",
    `Proposed by bot ${bot}. Approve ${
      change.init ? "starts git in this folder and " : ""
    }makes the first commit of the files below; the folder then works in a branch with no remote. Nothing is pushed. Reject changes nothing.`,
  ];
  if (change.note !== null) out.push("", `**${change.note}**`);
  out.push(
    "",
    change.before === null ? "### .gitignore (new)" : "### .gitignore (yours, with additions)",
    "",
    "```",
    change.gitignore.trimEnd(),
    "```",
    "",
    `### Files in the first commit (${change.files.length})`,
    "",
    "```",
    ...change.files.slice(0, REVIEW_PATHS),
  );
  if (change.files.length > REVIEW_PATHS) out.push(`... and ${change.files.length - REVIEW_PATHS} more`);
  out.push("```");
  if (change.nested.length > 0) {
    out.push("", "### Folders that are repositories of their own (not committed)", "", ...change.nested.map((path) => `- ${path}`));
  }
  if (change.identity === null) {
    out.push("", "### Name and email", "", "Git already has them on this computer; they are used.");
  } else {
    out.push(
      "",
      "### Name and email for the commit",
      "",
      `- name: ${change.identity.name}`,
      `- email: ${change.identity.email}`,
      "",
      "Stored in this folder's git settings only. Prefilled from the computer account; the bot asks you to confirm or change them.",
    );
  }
  return out.join("\n");
}

/** The pending item's prompt. */
export function gitPrompt(bot: string, change: GitChange | undefined): string {
  if (change === undefined) return `${SETUP_GIT_TITLE} (proposed by bot ${bot}) is waiting for your review`;
  return `${gitTitle(change.language)}: ${change.repo} (proposed by bot ${bot}) is waiting for your review`;
}

/** Approval: leaves the request `dev` sets git up from. */
export function applyGit(home: string, change: GitChange): void {
  const requests = join(home, REQUESTS_DIRECTORY);
  mkdirSync(requests, { recursive: true });
  const body = {
    kind: "setup-git",
    path: change.repo,
    gitignore: change.gitignore,
    paths: change.files,
    ...(change.identity === null ? {} : { identity: change.identity }),
  };
  writeFileSync(join(requests, `${randomUUID()}.json`), `${JSON.stringify(body)}\n`);
}

/** Reads a stored change; undefined when it is not one. */
export function gitChangeOf(value: unknown): GitChange | undefined {
  if (
    !isRecord(value) ||
    typeof value.repo !== "string" ||
    typeof value.gitignore !== "string" ||
    !(value.before === null || typeof value.before === "string") ||
    !Array.isArray(value.files) ||
    !Array.isArray(value.nested) ||
    !(value.note === null || typeof value.note === "string") ||
    typeof value.init !== "boolean"
  ) {
    return undefined;
  }
  const identity =
    isRecord(value.identity) && typeof value.identity.name === "string" && typeof value.identity.email === "string"
      ? { name: value.identity.name, email: value.identity.email }
      : null;
  const strings = (items: readonly unknown[]): string[] => items.filter((item): item is string => typeof item === "string");
  return {
    repo: value.repo,
    gitignore: value.gitignore,
    before: value.before,
    files: strings(value.files),
    nested: strings(value.nested),
    note: value.note,
    identity,
    init: value.init,
    language: value.language === "zh" ? "zh" : "en",
  };
}

/** The steps the agent follows for a folder: the guide with the bot and the folder filled in. */
export function setupGitSteps(bot: string, folder: string): string {
  return renderGuide(readFileSync(DEV_GIT_GUIDE, "utf8"), bot, folder);
}

/** `bot setup-git <bot> <folder>`: with no input the steps, with the `.gitignore` and identity on stdin the proposal. */
export async function runSetupGitCommand(
  ctx: CommandContext,
  argv: readonly string[],
  propose: (bot: string, change: GitChange) => Promise<string>,
  piped: PipedInput = {},
): Promise<string> {
  const bot = argv[0];
  const folder = argv[1];
  if (bot === undefined || folder === undefined || argv.length > 2) throw new BotError(USAGE);
  if (readBots(ctx.home)[bot] === undefined) throw new BotError(`there is no bot "${bot}"`);
  const text = (await readPiped(ctx.input, piped)).trim();
  if (text.length === 0) return setupGitSteps(bot, isAbsolute(folder) ? folder : resolve(ctx.cwd, folder));
  return propose(bot, proposeGit(ctx.home, bot, folder, text, ctx.cwd));
}
