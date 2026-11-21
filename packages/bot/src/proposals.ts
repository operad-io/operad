/**
 * Changes a bot proposes to itself: a new or changed skill, or a change to its
 * settings. A proposal is a stored object, shown as one pending item on its
 * bot. Nothing on disk changes until a person approves it; rejecting it leaves
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
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  configPath,
  isMissingFile,
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
  listedSkills,
  readBots,
  workingDirectory,
  type BotSettings,
  type McpServerSettings,
} from "./bot.ts";
import { commandLine, compareTools, differenceLines, secretName, storedTools } from "./mcp.ts";
import {
  applyScheduleChange,
  checkPromptName,
  checkSchedule,
  scheduleChangeOf,
  scheduledPrompts,
  type ScheduleChange,
  type ScheduledPrompt,
} from "./schedule.ts";

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
  readonly kind: "skill" | "settings" | "mcp" | "schedule";
  readonly title: string;
  readonly state: ProposalState;
  readonly createdAt: number;
  readonly skill?: {
    readonly name: string;
    readonly before: SkillSnapshot | null;
    readonly after: SkillSnapshot;
  } | undefined;
  readonly settings?: SettingsChange | undefined;
  readonly mcp?: McpChange | undefined;
  readonly schedule?: ScheduleChange | undefined;
}

/** A local MCP server a proposal registers, upgrades or lets through after a change of its tools. */
export interface McpChange {
  readonly server: string;
  /** `new`: registered for the first time; `upgrade`: registered again with another command or version; `changed`: the server's own tools changed. */
  readonly reason: "new" | "upgrade" | "changed";
  readonly before: McpServerSettings | null;
  readonly after: McpServerSettings;
}

const NAME = /^[a-z0-9][a-z0-9_-]*$/;

function dataOf(object: StoredObject): ProposalData {
  const data = object.data;
  if (
    typeof data.bot !== "string" ||
    (data.kind !== "skill" &&
      data.kind !== "settings" &&
      data.kind !== "mcp" &&
      data.kind !== "schedule") ||
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

/** The skill directory a bot already mounts under this name, if any. */
function existingSkillPath(
  home: string,
  bot: string,
  name: string,
): string | undefined {
  const written = readBots(home)[bot];
  if (written === undefined) return undefined;
  for (const path of mountedSkills(home, bot, written)) {
    const expected = basename(path);
    let marker: string | undefined;
    try {
      marker = /^name:\s*(\S+)/m.exec(readFileSync(join(path, "SKILL.md"), "utf8"))?.[1];
    } catch {
      // A listed skill that vanished is skipped, like one that was never there.
      continue;
    }
    if (expected === name || marker === name) return path;
  }
  return undefined;
}

/** The skills a bot's written paths mount now; a path with nothing to mount is skipped. */
function mountedSkills(home: string, bot: string, settings: BotSettings): string[] {
  const cwd = workingDirectory(home, bot, settings);
  const found: string[] = [];
  for (const listed of settings.skills ?? []) {
    for (const path of listedSkills(listed, cwd).directories) {
      if (!found.includes(resolve(path))) found.push(resolve(path));
    }
  }
  return found;
}

/** The directory a new skill of this bot goes into. */
export function newSkillPath(home: string, bot: string): string {
  const written = readBots(home)[bot];
  if (written === undefined) throw new BotError(`there is no bot "${bot}"`);
  return join(workingDirectory(home, bot, written), "skills");
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

function mcpChangeOf(value: unknown): McpChange | undefined {
  if (!isRecord(value) || typeof value.server !== "string" || !isRecord(value.after)) return undefined;
  if (value.reason !== "new" && value.reason !== "upgrade" && value.reason !== "changed") return undefined;
  return {
    server: value.server,
    reason: value.reason,
    before: isRecord(value.before) ? (value.before as unknown as McpServerSettings) : null,
    after: value.after as unknown as McpServerSettings,
  };
}

/** What a person reads before a local MCP server is registered, upgraded or let through. */
function mcpReview(bot: string, change: McpChange): string {
  const { after, before } = change;
  const heading =
    change.reason === "new"
      ? `## MCP server ${change.server} for bot ${bot}`
      : change.reason === "upgrade"
        ? `## Upgrade of MCP server ${change.server} for bot ${bot}`
        : `## MCP server ${change.server} of bot ${bot} changed its tools`;
  const out = [heading, ""];
  out.push(
    change.reason === "changed"
      ? `Its tools are no longer the ones that were approved, so the server is switched off in this bot's chats. Approve to accept the new tools and switch it on again; reject to keep it off.`
      : `**Approving trusts this package.** The server is a program that runs on this machine as you, starts with every chat of this bot and stays up while it talks. Nothing contains it yet (there is no shell around it), so the access profile does not limit what the program itself does; only calls to its tools are asked about.`,
    "",
  );
  out.push(`Command: \`${commandLine(after.command, after.args ?? [])}\``, "");
  if (after.package !== undefined) {
    out.push(
      `Package: ${after.package}`,
      `Version: ${after.version ?? "?"}${before?.version !== undefined && before.version !== after.version ? ` (was ${before.version})` : ""}`,
      "",
    );
  } else {
    out.push("This command is not a package from a registry; it runs a program as written.", "");
  }
  out.push("### Secrets", "");
  const variables = after.secrets ?? [];
  if (variables.length === 0) out.push("It needs no secrets.");
  else {
    for (const variable of variables) {
      out.push(`- ${variable}: store it with \`operad secret set bot ${secretName(change.server, variable)}\``);
    }
    out.push("", "They are given to the server only when it starts, never to the agent or the transcript.");
  }
  const tools = storedTools(after);
  out.push("", `### Tools (${tools.length})`, "");
  if (tools.length === 0) out.push("It offers no tools.");
  else {
    out.push("A tool not on the bot's `mcpAllow` list asks before every call. What the tools return is read as material, not as instructions.", "", "```");
    for (const tool of tools) out.push(`${tool.name}: ${tool.description}`);
    out.push("```");
  }
  if (before !== null) {
    out.push("", "### What changed", "");
    if (before.command !== after.command || (before.args ?? []).join("\0") !== (after.args ?? []).join("\0")) {
      out.push(`Command was: \`${commandLine(before.command, before.args ?? [])}\``, "");
    }
    out.push("```diff", ...differenceLines(compareTools(storedTools(before), tools)), "```");
  }
  return out.join("\n");
}

function scheduleLines(entry: ScheduledPrompt, words: string | undefined): string[] {
  const spoken = words === undefined || words.trim().length === 0 ? undefined : words.trim();
  return [
    `- Name: ${entry.name}`,
    `- Schedule: ${spoken === undefined ? `\`${entry.schedule}\`` : `${spoken} (\`${entry.schedule}\`)`}`,
    `- Model: ${entry.model ?? "the bot's model"}`,
    `- Effort: ${entry.effort ?? "the bot's effort"}`,
    ...(entry.paused ? ["- Paused: yes"] : []),
  ];
}

function schedulePromptLines(entry: ScheduledPrompt): string[] {
  return [
    "",
    "### Prompt",
    "",
    "```",
    ...entry.prompt.replaceAll("\r\n", "\n").split("\n"),
    "```",
  ];
}

/** What a person reads before a scheduled prompt is added, changed or removed. */
function scheduleReview(bot: string, change: ScheduleChange): string {
  const name = (change.after ?? change.before)?.name ?? "?";
  const action =
    change.action === "add" ? "adds" : change.action === "edit" ? "changes" : "removes";
  const out = [
    `## Scheduled prompt ${name} for bot ${bot}`,
    "",
    `This proposal ${action} a scheduled prompt on bot ${bot}. Approve applies it; reject leaves the bot as it is.`,
  ];
  if (change.before !== null) {
    out.push(
      "",
      "### Before",
      "",
      ...scheduleLines(change.before, change.action === "remove" ? change.words : undefined),
      ...schedulePromptLines(change.before),
    );
  }
  if (change.after !== null) {
    out.push("", "### After", "", ...scheduleLines(change.after, change.words), ...schedulePromptLines(change.after));
  }
  return out.join("\n");
}

/** The review a person reads for a proposal. */
export function proposalReview(object: StoredObject): string {
  const data = dataOf(object);
  if (data.kind === "schedule") {
    const change = scheduleChangeOf(data.schedule);
    return change === undefined
      ? "No scheduled prompt is recorded for this proposal."
      : scheduleReview(data.bot, change);
  }
  if (data.kind === "mcp") {
    const change = mcpChangeOf(data.mcp);
    return change === undefined ? "No MCP server is recorded for this proposal." : mcpReview(data.bot, change);
  }
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

/** Reads, changes and writes the `bots` map under one lock, keeping the rest of config.json. */
async function changeBotsFile(
  home: string,
  change: (bots: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  const file = configPath(home);
  await withLockFile(`${file}.lock`, async () => {
    let parsed: Record<string, unknown> = {};
    try {
      const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (!isRecord(raw)) throw new BotError(`${file}: must be a JSON object`);
      parsed = { ...raw };
    } catch (error) {
      if (!isMissingFile(error)) {
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
    const bots = isRecord(settings.bots) ? { ...settings.bots } : {};
    plugins.bot = { ...entry, settings: { ...settings, bots: change(bots) } };
    parsed.plugins = plugins;
    await writeFileAtomic(file, `${JSON.stringify(parsed, null, 2)}\n`);
  });
}

/** Changes the `bots` map under the config lock, so two writers do not drop each other's change. */
export async function updateBotsFile(
  home: string,
  change: (bots: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  await changeBotsFile(home, change);
}

export function validateBots(bots: Readonly<Record<string, unknown>>): void {
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
  if (change.mcpServers !== undefined) {
    throw new BotError("MCP servers are registered with `operad bot mcp`, which shows what the server offers; a settings change cannot add or edit one");
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

/** What the chat's `bot schedule` command is asked to propose. */
export interface ScheduleProposalInput {
  readonly action: "add" | "edit" | "remove";
  readonly name: string;
  readonly words?: string | undefined;
  readonly schedule?: string | undefined;
  readonly prompt?: string | undefined;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
}

function optionalText(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value : undefined;
}

/**
 * Proposes adding, changing or removing one of a bot's scheduled prompts. The
 * owner's direct actions apply at once; this path is the one a chat's agent
 * uses, so nothing fires until a person approves the proposal.
 */
export async function proposeSchedule(
  store: ObjectStore,
  home: string,
  bot: string,
  input: ScheduleProposalInput,
): Promise<string> {
  if (readBots(home)[bot] === undefined) throw new BotError(`there is no bot "${bot}"`);
  const object = await store.get(BOT_TYPE, bot);
  if (object === undefined) throw new BotError(`there is no bot "${bot}"`);
  const name = checkPromptName(input.name);
  const current = scheduledPrompts(object.data).find((entry) => entry.name === name);
  if (input.action === "add" && current !== undefined) {
    throw new BotError(`bot ${bot} already has a scheduled prompt "${name}"`);
  }
  if (input.action !== "add" && current === undefined) {
    throw new BotError(`bot ${bot} has no scheduled prompt "${name}"`);
  }
  if (
    input.action === "remove" &&
    (input.schedule !== undefined ||
      input.prompt !== undefined ||
      input.model !== undefined ||
      input.effort !== undefined)
  ) {
    throw new BotError(
      "removing a scheduled prompt takes only its name and, optionally, the schedule in words",
    );
  }
  const words = optionalText(input.words);
  if (words === undefined) {
    throw new BotError(
      "give the schedule in words with --words, so the review shows both it and the cron expression",
    );
  }
  let after: ScheduledPrompt | null = null;
  if (input.action === "add") {
    if (input.schedule === undefined) {
      throw new BotError("adding a scheduled prompt needs --schedule, a five-field cron expression");
    }
    const prompt = input.prompt === undefined ? "" : input.prompt.trim();
    if (prompt.length === 0) throw new BotError("a scheduled prompt needs a prompt");
    const model = optionalText(input.model);
    const effort = optionalText(input.effort);
    after = {
      name,
      schedule: checkSchedule(input.schedule),
      prompt,
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
      paused: false,
    };
  } else if (input.action === "edit" && current !== undefined) {
    if (
      input.schedule === undefined &&
      input.prompt === undefined &&
      input.model === undefined &&
      input.effort === undefined
    ) {
      throw new BotError(
        "editing a scheduled prompt needs a field to change: --schedule, --prompt, --model or --effort",
      );
    }
    const schedule = input.schedule === undefined ? current.schedule : checkSchedule(input.schedule);
    const prompt = input.prompt === undefined ? current.prompt : input.prompt.trim();
    if (prompt.length === 0) throw new BotError("a scheduled prompt needs a prompt");
    const model = input.model === undefined ? current.model : optionalText(input.model);
    const effort = input.effort === undefined ? current.effort : optionalText(input.effort);
    after = {
      name,
      schedule,
      prompt,
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
      paused: current.paused,
      ...(schedule === current.schedule
        ? current.last === undefined
          ? {}
          : { last: current.last }
        : {}),
    };
  }
  const change: ScheduleChange = {
    action: input.action,
    words: words.trim(),
    before: current ?? null,
    after,
  };
  const data: ProposalData = {
    bot,
    kind: "schedule",
    title: `Scheduled prompt ${name}`,
    state: "pending",
    createdAt: Date.now(),
    schedule: change,
  };
  const id = `p-${randomUUID()}`;
  await store.put(PROPOSAL_TYPE, id, data as unknown as Record<string, JsonValue>, "command:bot/schedule");
  return `proposed scheduled prompt "${name}" for bot ${bot}; review it in pending`;
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
  await updateBotsFile(home, (bots) => {
    const next = { ...bots, [bot]: after };
    validateBots(next);
    return next;
  });
}

async function applyMcp(home: string, bot: string, change: McpChange): Promise<void> {
  await updateBotsFile(home, (bots) => {
    const raw = isRecord(bots[bot]) ? bots[bot] : {};
    const servers = isRecord(raw.mcpServers) ? raw.mcpServers : {};
    const next = {
      ...bots,
      [bot]: { ...raw, mcpServers: { ...servers, [change.server]: change.after } },
    };
    validateBots(next);
    return next;
  });
}

async function ensureSkillListed(home: string, bot: string, path: string): Promise<void> {
  const written = readBots(home)[bot];
  if (written === undefined) throw new BotError(`there is no bot "${bot}"`);
  if (mountedSkills(home, bot, written).some((item) => resolve(item) === resolve(path))) {
    return;
  }
  await updateBotsFile(home, (bots) => {
    const raw = isRecord(bots[bot]) ? bots[bot] : {};
    const skills = Array.isArray(raw.skills)
      ? raw.skills.filter((item): item is string => typeof item === "string")
      : [];
    if (skills.some((item) => resolve(item) === resolve(path))) return bots;
    const next = { ...bots, [bot]: { ...raw, skills: [...skills, path] } };
    validateBots(next);
    return next;
  });
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
  if (data.kind === "schedule") {
    const change = scheduleChangeOf(data.schedule);
    if (change === undefined) throw new BotError(`proposal ${id} has no scheduled prompt to apply`);
    await applyScheduleChange(store, data.bot, change);
  } else if (data.kind === "mcp") {
    const change = mcpChangeOf(data.mcp);
    if (change === undefined) throw new BotError(`proposal ${id} has no MCP server to apply`);
    await applyMcp(home, data.bot, change);
  } else if (data.kind === "skill") {
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
    "action:bot/approve",
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

/** The usage line shared by the parser's refusals. */
const SCHEDULE_USAGE =
  "usage: operad bot schedule <bot> add|edit|remove <name> [--words <text>] [--schedule <cron>] [--prompt <text>] [--model <model>] [--effort <effort>]";

/** Parses the `bot schedule` command: what the chat's agent calls to propose an entry. */
export async function runScheduleCommand(
  ctx: CommandContext,
  argv: readonly string[],
): Promise<string> {
  const positional: string[] = [];
  let words: string | undefined;
  let schedule: string | undefined;
  let prompt: string | undefined;
  let model: string | undefined;
  let effort: string | undefined;
  for (let at = 0; at < argv.length; at += 1) {
    const word = argv[at];
    if (word === undefined) continue;
    if (
      word === "--words" ||
      word === "--schedule" ||
      word === "--prompt" ||
      word === "--model" ||
      word === "--effort"
    ) {
      const value = argv[at + 1];
      if (value === undefined) throw new BotError(`bot schedule: ${word} needs a value`);
      if (word === "--words") words = value;
      else if (word === "--schedule") schedule = value;
      else if (word === "--prompt") prompt = value;
      else if (word === "--model") model = value;
      else effort = value;
      at += 1;
      continue;
    }
    if (word.startsWith("--")) {
      throw new BotError(`bot schedule: there is no option ${word}; ${SCHEDULE_USAGE}`);
    }
    positional.push(word);
  }
  const bot = positional[0];
  const action = positional[1];
  const name = positional[2];
  if (
    bot === undefined ||
    name === undefined ||
    positional.length > 3 ||
    (action !== "add" && action !== "edit" && action !== "remove")
  ) {
    throw new BotError(SCHEDULE_USAGE);
  }
  return proposeSchedule(ctx.store, ctx.home, bot, {
    action,
    name,
    words,
    schedule,
    prompt,
    model,
    effort,
  });
}

/**
 * The actions on a proposal. Approve comes first, so it is the main button of a
 * client; review is last because a proposal's Review section already shows what
 * it returns, and it stays for the command line and MCP.
 */
export const proposalActions: readonly ActionTypeDefinition[] = [
  {
    name: "approve",
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

export { dataOf as proposalData, mcpChangeOf };
