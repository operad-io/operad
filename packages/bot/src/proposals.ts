/**
 * Changes a bot proposes to itself: a new or changed skill, or a change to its
 * settings. A proposal is a stored object, shown as one pending item on its
 * bot. Nothing on disk changes until a person confirms it; rejecting it leaves
 * every file and setting as it was.
 */

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  configPath,
  isRecord,
  messageOf,
  prepareSettings,
  writeFileAtomic,
  type ActionTypeDefinition,
  type CommandContext,
  type JsonValue,
  type ObjectRow,
  type ObjectStore,
  type ObjectViews,
  type SectionContent,
  type StoredObject,
} from "@operad-io/engine";
import { withLockFile } from "@operad-io/engine/platform";
import {
  BOT_SETTINGS,
  BOT_TYPE,
  BotError,
  readBots,
  resolveBot,
  type BotSettings,
} from "./bot.ts";

/** The object type of a proposal. It is internal: a person sees its pending item. */
export const PROPOSAL_TYPE = "bot-proposal";

/** A proposal waiting for a person, or what became of it. */
export type ProposalState = "pending" | "applied" | "rejected";

/** One file in a skill directory. */
export interface SkillFile {
  /** The path inside the skill directory, with `/` separators. */
  readonly path: string;
  readonly content: string;
  /** A script, listed apart from the other files. */
  readonly script: boolean;
  readonly executable: boolean;
}

/** A skill directory as it was or as it is proposed. */
export interface SkillSnapshot {
  /** The absolute directory of the skill. */
  readonly path: string;
  readonly files: readonly SkillFile[];
}

/** One bot's settings before and after a proposed change. */
export interface SettingsChange {
  readonly before: Readonly<Record<string, JsonValue>>;
  readonly after: Readonly<Record<string, JsonValue>>;
}

/** What a proposal stores. */
export interface ProposalData {
  readonly [key: string]: unknown;
  readonly bot: string;
  readonly kind: "skill" | "settings";
  readonly title: string;
  readonly state: ProposalState;
  readonly createdAt: number;
  readonly skill?: {
    readonly name: string;
    readonly before: SkillSnapshot | null;
    readonly after: SkillSnapshot;
  } | undefined;
  readonly settings?: SettingsChange | undefined;
}

const NAME = /^[a-z0-9][a-z0-9_-]*$/;

function dataOf(object: StoredObject): ProposalData {
  const data = object.data;
  if (
    typeof data.bot !== "string" ||
    (data.kind !== "skill" && data.kind !== "settings") ||
    typeof data.title !== "string" ||
    (data.state !== "pending" && data.state !== "applied" && data.state !== "rejected") ||
    typeof data.createdAt !== "number"
  ) {
    throw new Error(`proposal ${object.id} has an unusable shape`);
  }
  return data as ProposalData;
}

function isScript(path: string, mode: number): boolean {
  return path === "scripts" || path.startsWith("scripts/") || (mode & 0o111) !== 0;
}

/** The files of a skill directory now, sorted by path; missing means none. */
export function readSkillDirectory(path: string): SkillFile[] {
  if (!existsSync(path)) return [];
  const found: SkillFile[] = [];
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const full = join(directory, entry.name);
      const inner = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      const info = lstatSync(full);
      if (info.isDirectory()) {
        walk(full, inner);
        continue;
      }
      if (!info.isFile()) continue;
      found.push({
        path: inner,
        content: readFileSync(full, "utf8"),
        script: isScript(inner, info.mode),
        executable: (info.mode & 0o111) !== 0,
      });
    }
  };
  walk(path, "");
  return found.sort((left, right) => left.path.localeCompare(right.path));
}

function fileOf(files: readonly SkillFile[], path: string): SkillFile | undefined {
  return files.find((file) => file.path === path);
}

function expandPath(path: string, base: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return isAbsolute(path) ? resolve(path) : resolve(base, path);
}

/** The skill directory a bot already mounts under this name, if any. */
function existingSkillPath(
  home: string,
  bot: string,
  name: string,
): string | undefined {
  const written = readBots(home)[bot];
  if (written === undefined) return undefined;
  const cwd = resolveBotFromSettings(home, bot, written).cwd;
  for (const skill of written.skills ?? []) {
    const path = expandPath(skill, cwd);
    const expected = basename(path);
    const marker = existsSync(join(path, "SKILL.md"))
      ? /^name:\s*(\S+)/m.exec(readFileSync(join(path, "SKILL.md"), "utf8"))?.[1]
      : undefined;
    if (expected === name || marker === name) return path;
  }
  return undefined;
}

function resolveBotFromSettings(
  home: string,
  bot: string,
  settings: BotSettings,
): { readonly cwd: string } {
  try {
    return resolveBot(home, bot, settings);
  } catch (error) {
    if (error instanceof BotError) throw error;
    throw error;
  }
}

/** The directory a new skill of this bot goes into. */
export function newSkillPath(home: string, bot: string): string {
  const written = readBots(home)[bot];
  if (written === undefined) throw new BotError(`there is no bot "${bot}"`);
  const cwd = resolveBotFromSettings(home, bot, written).cwd;
  return join(cwd, "skills");
}

function pathInside(path: string, directory: string): boolean {
  const inside = relative(directory, path);
  return inside === "" || (!inside.startsWith("..") && !isAbsolute(inside));
}

function skillTarget(home: string, bot: string, name: string): string {
  const existing = existingSkillPath(home, bot, name);
  return existing ?? join(newSkillPath(home, bot), name);
}

function validateName(name: string, what: string): void {
  if (!NAME.test(name)) {
    throw new BotError(
      `${what} "${name}": a name is lowercase letters, digits, "-" and "_", and starts with a letter or digit`,
    );
  }
}

function jsonObject(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) throw new BotError(`${what} must be a JSON object`);
  return value;
}

function inputText(ctx: CommandContext): string {
  return (ctx.input ?? "").trim();
}

interface SkillInput {
  readonly skillMd: string | undefined;
  readonly files: Readonly<Record<string, string>>;
}

function parseSkillInput(ctx: CommandContext): SkillInput {
  const text = inputText(ctx);
  if (text.length === 0) return { skillMd: undefined, files: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new BotError(`the skill input is not JSON: ${messageOf(error)}`);
  }
  const input = jsonObject(parsed, "the skill input");
  const skillMd = input.skill_md;
  if (skillMd !== undefined && typeof skillMd !== "string") {
    throw new BotError("the skill input's skill_md must be text");
  }
  const files: Record<string, string> = {};
  if (input.files !== undefined) {
    for (const [path, content] of Object.entries(jsonObject(input.files, "the skill input's files"))) {
      if (typeof content !== "string") {
        throw new BotError(`the skill input's file "${path}" must be text`);
      }
      files[path] = content;
    }
  }
  return { skillMd, files };
}

function snapshotFrom(input: SkillInput, path: string): SkillSnapshot {
  const files = new Map<string, SkillFile>();
  if (input.skillMd !== undefined) {
    files.set("SKILL.md", {
      path: "SKILL.md",
      content: input.skillMd,
      script: false,
      executable: false,
    });
  }
  for (const [written, content] of Object.entries(input.files)) {
    const path = written.replaceAll("\\", "/").replace(/^\/+/, "");
    if (path.length === 0 || path.split("/").includes("..")) {
      throw new BotError(`the skill input's file "${written}" must stay inside the skill`);
    }
    files.set(path, {
      path,
      content,
      script: isScript(path, 0),
      executable: false,
    });
  }
  if (!files.has("SKILL.md")) {
    throw new BotError("a skill needs a SKILL.md");
  }
  return { path, files: [...files.values()].sort((left, right) => left.path.localeCompare(right.path)) };
}

function fromDirectory(path: string): SkillSnapshot {
  const files = readSkillDirectory(path);
  if (fileOf(files, "SKILL.md") === undefined) {
    throw new BotError(`skill "${path}": there is no SKILL.md in ${path}`);
  }
  return { path, files };
}

function snapshotOf(value: unknown): SkillSnapshot | undefined {
  if (!isRecord(value) || typeof value.path !== "string" || !Array.isArray(value.files)) {
    return undefined;
  }
  const files: SkillFile[] = [];
  for (const item of value.files) {
    if (
      !isRecord(item) ||
      typeof item.path !== "string" ||
      typeof item.content !== "string" ||
      typeof item.script !== "boolean" ||
      typeof item.executable !== "boolean"
    ) {
      return undefined;
    }
    files.push({
      path: item.path,
      content: item.content,
      script: item.script,
      executable: item.executable,
    });
  }
  return { path: value.path, files };
}

function settingsChangeOf(value: unknown): SettingsChange | undefined {
  if (
    !isRecord(value) ||
    !isRecord(value.before) ||
    !isRecord(value.after)
  ) {
    return undefined;
  }
  return {
    before: value.before as Record<string, JsonValue>,
    after: value.after as Record<string, JsonValue>,
  };
}

function proposalContent(object: StoredObject): {
  readonly skill: ProposalData["skill"];
  readonly settings: SettingsChange | undefined;
} {
  const data = dataOf(object);
  return {
    skill:
      data.skill === undefined
        ? undefined
        : {
            name: data.skill.name,
            before: snapshotOf(data.skill.before) ?? null,
            after: snapshotOf(data.skill.after) ?? { path: "", files: [] },
          },
    settings: settingsChangeOf(data.settings),
  };
}

function lines(text: string): string[] {
  const split = text.replaceAll("\r\n", "\n").split("\n");
  if (split.at(-1) === "") split.pop();
  return split;
}

/** A line diff of two texts, enough to review a skill change. */
export function diffLines(beforeText: string, afterText: string): string[] {
  const before = lines(beforeText);
  const after = lines(afterText);
  const table: number[][] = Array.from({ length: before.length + 1 }, () =>
    Array<number>(after.length + 1).fill(0),
  );
  for (let i = before.length - 1; i >= 0; i -= 1) {
    const row = table[i];
    const next = table[i + 1];
    if (row === undefined || next === undefined) continue;
    for (let j = after.length - 1; j >= 0; j -= 1) {
      row[j] =
        before[i] === after[j]
          ? (next[j + 1] ?? 0) + 1
          : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) {
      out.push(` ${before[i]}`);
      i += 1;
      j += 1;
      continue;
    }
    if (j < after.length && (i === before.length || (table[i]?.[j + 1] ?? 0) >= (table[i + 1]?.[j] ?? 0))) {
      out.push(`+${after[j]}`);
      j += 1;
      continue;
    }
    out.push(`-${before[i]}`);
    i += 1;
  }
  return out;
}

function changedSkillMarkdown(
  name: string,
  before: SkillSnapshot,
  after: SkillSnapshot,
): string[] {
  const out: string[] = [];
  const paths = [...new Set([...before.files, ...after.files].map((file) => file.path))].sort();
  for (const path of paths) {
    const old = fileOf(before.files, path);
    const current = fileOf(after.files, path);
    if (old?.content === current?.content) continue;
    out.push(`### ${path}`, "");
    if (old === undefined) {
      out.push("New file.", "", "```", ...lines(current?.content ?? "").map((line) => `+${line}`), "```");
    } else if (current === undefined) {
      out.push("Removed file.", "", "```", ...lines(old.content).map((line) => `-${line}`), "```");
    } else {
      out.push("```diff", ...diffLines(old.content, current.content), "```");
    }
    out.push("");
  }
  return out;
}

/** The review a person reads for a proposal. */
export function proposalReview(object: StoredObject): string {
  const data = dataOf(object);
  const content = proposalContent(object);
  if (data.kind === "settings") {
    const change = content.settings;
    if (change === undefined) return "No settings are recorded for this proposal.";
    return [
      `## Settings for bot ${data.bot}`,
      "",
      "### Before",
      "",
      "```json",
      JSON.stringify(change.before, null, 2),
      "```",
      "",
      "### After",
      "",
      "```json",
      JSON.stringify(change.after, null, 2),
      "```",
    ].join("\n");
  }

  const skill = content.skill;
  if (skill === undefined) return "No skill is recorded for this proposal.";
  const skillMd = fileOf(skill.after.files, "SKILL.md")?.content ?? "";
  const scripts = skill.after.files.filter((file) => file.script && file.path !== "SKILL.md");
  const others = skill.after.files.filter((file) => !file.script && file.path !== "SKILL.md");
  const out = [`## Skill ${skill.name} for bot ${data.bot}`, "", `Directory: ${skill.after.path}`, ""];
  if (skill.before === null) {
    out.push("### SKILL.md", "", skillMd.trimEnd(), "");
  } else {
    out.push("### Diff", "");
    out.push(...changedSkillMarkdown(skill.name, skill.before, skill.after));
  }
  out.push("### Files", "");
  out.push(...(others.length === 0 ? ["No other files."] : others.map((file) => `- ${file.path}`)));
  out.push("", "### Scripts", "");
  out.push(
    ...(scripts.length === 0
      ? ["No scripts."]
      : scripts.map((file) => `- ${file.path}${file.executable ? " (executable)" : ""}`)),
  );
  if (skill.before !== null) {
    out.push("", "### SKILL.md", "", skillMd.trimEnd(), "");
  }
  return out.join("\n");
}

async function readBotsFile(home: string): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath(home), "utf8"));
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return {};
    throw new BotError(`${configPath(home)}: cannot read the bot settings: ${messageOf(error)}`);
  }
  const plugins = isRecord(parsed) ? parsed.plugins : undefined;
  const entry = isRecord(plugins) ? plugins.bot : undefined;
  const settings = isRecord(entry) ? entry.settings : undefined;
  const bots = isRecord(settings) ? settings.bots : undefined;
  return isRecord(bots) ? { ...bots } : {};
}

/** Writes the whole `bots` map, keeping the rest of config.json. */
async function writeBotsFile(
  home: string,
  bots: Readonly<Record<string, unknown>>,
): Promise<void> {
  const file = configPath(home);
  await withLockFile(`${file}.lock`, async () => {
    let parsed: Record<string, unknown> = {};
    try {
      const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (!isRecord(raw)) throw new BotError(`${file}: must be a JSON object`);
      parsed = { ...raw };
    } catch (error) {
      if (!(isRecord(error) && error.code === "ENOENT")) {
        if (error instanceof BotError) throw error;
        throw new BotError(`${file}: cannot read the bot settings: ${messageOf(error)}`);
      }
    }
    const plugins = isRecord(parsed.plugins) ? { ...parsed.plugins } : {};
    const current = plugins.bot;
    const entry: Record<string, unknown> =
      typeof current === "string"
        ? { module: current, enabled: true }
        : isRecord(current)
          ? { ...current }
          : {};
    const settings = isRecord(entry.settings) ? entry.settings : {};
    plugins.bot = { ...entry, settings: { ...settings, bots } };
    parsed.plugins = plugins;
    await writeFileAtomic(file, `${JSON.stringify(parsed, null, 2)}\n`);
  });
}

function validateBots(bots: Readonly<Record<string, unknown>>): void {
  prepareSettings(BOT_SETTINGS, { bots }, "bot");
  for (const name of Object.keys(bots)) validateName(name, "bot");
}

/** Proposes a new or changed skill. Nothing is written to the skill directory. */
export async function proposeSkill(
  store: ObjectStore,
  home: string,
  bot: string,
  name: string,
  options: { readonly from?: string | undefined; readonly input?: SkillInput | undefined } = {},
): Promise<string> {
  validateName(name, "skill");
  if (readBots(home)[bot] === undefined) throw new BotError(`there is no bot "${bot}"`);
  const target = skillTarget(home, bot, name);
  const before = existsSync(target) ? readSkillDirectory(target) : [];
  const after =
    options.from === undefined
      ? snapshotFrom(options.input ?? { skillMd: undefined, files: {} }, target)
      : { path: target, files: fromDirectory(options.from).files };
  if (fileOf(after.files, "SKILL.md") === undefined) {
    throw new BotError("a skill needs a SKILL.md");
  }
  const data: ProposalData = {
    bot,
    kind: "skill",
    title: `Skill ${name}`,
    state: "pending",
    createdAt: Date.now(),
    skill: {
      name,
      before: before.length === 0 ? null : { path: target, files: before },
      after,
    },
  };
  const id = `p-${randomUUID()}`;
  await store.put(PROPOSAL_TYPE, id, data as unknown as Record<string, JsonValue>, "command:bot/skill");
  return `proposed skill "${name}" for bot ${bot}; review it in pending`;
}

/** Proposes a change to one bot's settings. Nothing is written. */
export async function proposeSettings(
  store: ObjectStore,
  home: string,
  bot: string,
  patch: unknown,
): Promise<string> {
  validateName(bot, "bot");
  const written = readBots(home)[bot];
  if (written === undefined) throw new BotError(`there is no bot "${bot}"`);
  const change = jsonObject(patch, "the settings change");
  const before: Record<string, JsonValue> = { ...written } as Record<string, JsonValue>;
  const after: Record<string, JsonValue> = { ...before };
  for (const [key, value] of Object.entries(change)) {
    if (key === "access" && isRecord(value) && isRecord(before.access)) {
      after.access = { ...before.access, ...value } as Record<string, JsonValue>;
    } else {
      after[key] = value as JsonValue;
    }
  }
  validateBots({ [bot]: after });
  const data: ProposalData = {
    bot,
    kind: "settings",
    title: `Settings for ${bot}`,
    state: "pending",
    createdAt: Date.now(),
    settings: { before, after },
  };
  const id = `p-${randomUUID()}`;
  await store.put(PROPOSAL_TYPE, id, data as unknown as Record<string, JsonValue>, "command:bot/setting");
  return `proposed settings for bot ${bot}; review it in pending`;
}

function skillData(value: unknown): ProposalData["skill"] | undefined {
  if (!isRecord(value) || typeof value.name !== "string") return undefined;
  const before = value.before === null ? null : snapshotOf(value.before) ?? null;
  const after = snapshotOf(value.after);
  if (after === undefined) return undefined;
  return { name: value.name, before, after };
}

function applySkill(skill: NonNullable<ProposalData["skill"]>): void {
  const { after } = skill;
  if (after.path.length === 0) throw new BotError("the proposal has no skill directory");
  mkdirSync(after.path, { recursive: true });
  for (const file of after.files) {
    const target = resolve(after.path, file.path);
    if (!pathInside(target, after.path)) {
      throw new BotError(`skill file "${file.path}" leaves ${after.path}`);
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content);
    chmodSync(target, file.executable || file.script ? 0o755 : 0o644);
  }
  for (const old of skill.before?.files ?? []) {
    if (fileOf(after.files, old.path) !== undefined) continue;
    const target = resolve(after.path, old.path);
    if (pathInside(target, after.path)) rmSync(target, { force: true });
  }
}

async function applySettings(home: string, bot: string, after: Readonly<Record<string, JsonValue>>): Promise<void> {
  const bots = { ...(await readBotsFile(home)), [bot]: after };
  validateBots(bots);
  await writeBotsFile(home, bots);
}

async function ensureSkillListed(home: string, bot: string, path: string): Promise<void> {
  const written = readBots(home)[bot];
  if (written === undefined) throw new BotError(`there is no bot "${bot}"`);
  if (resolveBot(home, bot, written).skills.some((item) => resolve(item) === resolve(path))) {
    return;
  }
  const bots = await readBotsFile(home);
  const raw = isRecord(bots[bot]) ? bots[bot] : (written as unknown as Record<string, unknown>);
  const skills = Array.isArray(raw.skills)
    ? raw.skills.filter((item): item is string => typeof item === "string")
    : [];
  bots[bot] = { ...raw, skills: [...skills, path] };
  validateBots(bots);
  await writeBotsFile(home, bots);
}

/** Applies a pending proposal. A proposal already decided is left as it is. */
export async function applyProposal(
  store: ObjectStore,
  home: string,
  id: string,
): Promise<string> {
  const object = await store.get(PROPOSAL_TYPE, id);
  if (object === undefined) throw new BotError(`there is no proposal "${id}"`);
  const data = dataOf(object);
  if (data.state !== "pending") {
    return `proposal ${id} is already ${data.state}; nothing to apply`;
  }
  const skill = skillData(data.skill);
  if (data.kind === "skill") {
    if (skill === undefined) throw new BotError(`proposal ${id} has no skill to apply`);
    applySkill(skill);
    await ensureSkillListed(home, data.bot, skill.after.path);
  } else {
    const change = settingsChangeOf(data.settings);
    if (change === undefined) throw new BotError(`proposal ${id} has no settings to apply`);
    await applySettings(home, data.bot, change.after);
  }
  await store.put(
    PROPOSAL_TYPE,
    id,
    { ...data, state: "applied", appliedAt: Date.now() } as unknown as Record<string, JsonValue>,
    "action:bot/confirm",
  );
  return `applied proposal ${id}`;
}

/** Rejects a pending proposal, changing no file or setting. */
export async function rejectProposal(store: ObjectStore, id: string): Promise<string> {
  const object = await store.get(PROPOSAL_TYPE, id);
  if (object === undefined) throw new BotError(`there is no proposal "${id}"`);
  const data = dataOf(object);
  if (data.state !== "pending") {
    return `proposal ${id} is already ${data.state}; nothing to reject`;
  }
  await store.put(
    PROPOSAL_TYPE,
    id,
    { ...data, state: "rejected", rejectedAt: Date.now() } as unknown as Record<string, JsonValue>,
    "action:bot/reject",
  );
  return `rejected proposal ${id}`;
}

/** Every proposal waiting for a person, oldest first. */
export async function pendingProposals(
  store: ObjectStore,
): Promise<readonly StoredObject[]> {
  const found: StoredObject[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.list(PROPOSAL_TYPE, {
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const object of page.objects) {
      if (object.data.state === "pending") found.push(object);
    }
    cursor = page.next;
  } while (cursor !== undefined);
  return found.sort((left, right) => {
    const a = typeof left.data.createdAt === "number" ? left.data.createdAt : 0;
    const b = typeof right.data.createdAt === "number" ? right.data.createdAt : 0;
    return a - b || left.id.localeCompare(right.id);
  });
}

/** The pending items a bot's proposals make. */
export async function proposalItems(
  store: ObjectStore,
): Promise<readonly {
  readonly id: string;
  readonly prompt: string;
  readonly object: { readonly type: string; readonly id: string };
}[]> {
  return (await pendingProposals(store)).map((object) => {
    const data = dataOf(object);
    return {
      id: object.id,
      prompt: `${data.title} for bot ${data.bot} is waiting for your review`,
      object: { type: PROPOSAL_TYPE, id: object.id },
    };
  });
}

/** Parses `<bot> <name> [--from <dir>]` for the `bot skill` command. */
export async function runSkillCommand(ctx: CommandContext, argv: readonly string[]): Promise<string> {
  const words: string[] = [];
  let from: string | undefined;
  for (let at = 0; at < argv.length; at += 1) {
    const word = argv[at];
    if (word === "--from") {
      at += 1;
      const value = argv[at];
      if (value === undefined) throw new BotError("bot skill: --from needs a directory");
      from = value;
      continue;
    }
    if (word !== undefined) words.push(word);
  }
  const bot = words[0];
  const name = words[1];
  if (bot === undefined || name === undefined || words.length > 2) {
    throw new BotError("usage: operad bot skill <bot> <name> [--from <dir>]");
  }
  if (from !== undefined) {
    return proposeSkill(ctx.store, ctx.home, bot, name, {
      from: isAbsolute(from) ? from : resolve(ctx.cwd, from),
    });
  }
  return proposeSkill(ctx.store, ctx.home, bot, name, { input: parseSkillInput(ctx) });
}

/** Parses `<bot>` and a JSON patch from stdin for the `bot setting` command. */
export async function runSettingCommand(ctx: CommandContext, argv: readonly string[]): Promise<string> {
  const bot = argv[0];
  if (bot === undefined || argv.length > 1) {
    throw new BotError("usage: operad bot setting <bot> < changes.json");
  }
  const text = inputText(ctx);
  if (text.length === 0) throw new BotError("bot setting: the settings change is empty");
  let patch: unknown;
  try {
    patch = JSON.parse(text);
  } catch (error) {
    throw new BotError(`the settings change is not JSON: ${messageOf(error)}`);
  }
  return proposeSettings(ctx.store, ctx.home, bot, patch);
}

/** The actions on a proposal. */
export const proposalActions: readonly ActionTypeDefinition[] = [
  {
    name: "review",
    on: PROPOSAL_TYPE,
    when: (state) => state.state === "pending",
    async run(ctx) {
      const object = await ctx.store.get(PROPOSAL_TYPE, ctx.object.id);
      if (object === undefined) throw new BotError(`there is no proposal "${ctx.object.id}"`);
      return proposalReview(object);
    },
  },
  {
    name: "confirm",
    on: PROPOSAL_TYPE,
    when: (state) => state.state === "pending",
    async run(ctx) {
      return applyProposal(ctx.store, ctx.home, ctx.object.id);
    },
  },
  {
    name: "reject",
    on: PROPOSAL_TYPE,
    when: (state) => state.state === "pending",
    async run(ctx) {
      return rejectProposal(ctx.store, ctx.object.id);
    },
  },
];

function row(object: StoredObject): ObjectRow {
  const data = dataOf(object);
  return {
    id: object.id,
    title: data.title,
    state: data.state,
    parent: `${BOT_TYPE}:${data.bot}`,
    ...(data.state === "pending" ? { mark: "proposed" as const } : {}),
  };
}

function sections(): readonly { readonly id: string; readonly title: string }[] {
  return [{ id: "review", title: "Review" }];
}

function load(_ctx: unknown, object: StoredObject): SectionContent {
  return { markdown: proposalReview(object) };
}

/** How a proposal shows in a list and on its page. */
export const proposalViews: ObjectViews = {
  row,
  sections,
  load,
};

export { dataOf as proposalData };
