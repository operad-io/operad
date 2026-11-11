/** How a plan and a task appear in a list and a detail page. */

import type {
  ObjectRow,
  ObjectViews,
  StoredObject,
  ViewContext,
  ViewSection,
} from "@operad-io/engine";
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readSync,
} from "node:fs";
import { join } from "node:path";
import {
  bareId,
  hasRework,
  listAll,
  PLAN_FINAL_STATES,
  TASK_FINAL_STATES,
  dependencyKey,
  dependencyLabel,
  planData,
  planNote,
  planState,
  renderChanges,
  repositoryData,
  splitBrief,
  storeKey,
  taskData,
  type ReviewRecord,
  type TaskAttempt,
  type TaskData,
} from "./model.ts";
import { placeWaitNote } from "./place-wait.ts";
import { planMark, repositoryMark, taskBadge, taskMark } from "./marks.ts";
import { git, workBranch } from "./steps.ts";
import { repositoryMetrics } from "./throughput.ts";
import { findRepository, listRepositories } from "./service.ts";
import { DEV_SETTINGS_FILE, readDevSettings, settingsProblem } from "./settings.ts";

function costNote(cost: unknown, quality?: unknown): string | undefined {
  if (typeof cost === "number" && Number.isFinite(cost)) {
    // `~` marks an estimated cost, `≥` an incomplete one; an exact one is bare.
    const symbol = quality === "estimated" ? "~" : quality === "incomplete" ? "≥" : "";
    return `${symbol}$${cost.toFixed(2)}`;
  }
  if (typeof cost === "string" && cost.trim().length > 0) return cost.trim();
  return undefined;
}

/**
 * The short note a waiting task shows. A refused push leaves the integration
 * message that names the remote, the branch and git's own words; the person
 * sees it next to the task before deciding what to do.
 */
function waitNote(task: TaskData): string | undefined {
  const place = TASK_FINAL_STATES.includes(task.phase) ? undefined : placeWaitNote(task);
  if (place !== undefined) return place;
  const turn = task.attempt?.integrationWait;
  // A task that ended (cancelled while it waited) is not waiting any more.
  if (
    typeof turn === "string" &&
    turn.length > 0 &&
    !TASK_FINAL_STATES.includes(task.phase)
  ) {
    return `waiting to integrate: ${turn}`;
  }
  const workerWait = task.attempt?.workerWait;
  if (task.phase === "running" && typeof workerWait === "string" && workerWait.length > 0) {
    return workerWait;
  }
  if (
    task.phase === "ready" &&
    task.dependencyHeld === true &&
    (task.dependencyHeldFor ?? []).length > 0
  ) {
    return `waiting for ${(task.dependencyHeldFor ?? []).join(", ")}`;
  }
  if (
    (task.phase === "ready" || (task.phase === "waiting" && task.run === null)) &&
    task.flowHeld !== undefined
  ) {
    return task.flowHeld;
  }
  if (task.phase !== "waiting") return undefined;
  const integration = task.attempt?.integration;
  if (integration === undefined || integration === null) return undefined;
  if (integration.result !== "failed") return undefined;
  const message = integration.message;
  return typeof message === "string" && message.trim().length > 0
    ? message.trim()
    : undefined;
}

/** The longest worker name a list row shows; the full name is in Metrics. */
export const ROW_WORKER_CHARS = 16;

/** The last attempt's worker for a row: the name only, cut when it is long. */
function workerNote(task: TaskData): string | undefined {
  const worker = task.attempt?.worker;
  if (typeof worker !== "string") return undefined;
  const flat = worker.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return undefined;
  return flat.length <= ROW_WORKER_CHARS
    ? flat
    : `${flat.slice(0, ROW_WORKER_CHARS - 1)}…`;
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** A list names each row's repository once more than one is registered. */
async function showRepository(ctx: ViewContext): Promise<boolean> {
  return (await listRepositories(ctx.store)).length > 1;
}

/** A repository: its row reads the stored counts; Overview reads dev.json. */
export const repoViews: ObjectViews = {
  row(object: StoredObject): ObjectRow {
    const repository = repositoryData(object.data);
    const state = repository.removed ? "removed" : "active";
    return {
      id: repository.name,
      title: repository.name,
      state,
      note: `plans: ${repository.openPlans ?? 0} · tasks: ${repository.openTasks ?? 0}`,
      final: repository.removed,
      mark: repositoryMark(repository),
    };
  },

  sections(): readonly ViewSection[] {
    return [
      { id: "overview", title: "Overview" },
      { id: "metrics", title: "Metrics" },
    ];
  },

  async load(ctx, object, sectionId) {
    if (sectionId === "metrics") return { markdown: await repositoryMetrics(ctx, object) };
    if (sectionId !== "overview") return { markdown: "" };
    const repository = repositoryData(object.data);
    const lines = [`- Path: \`${repository.path}\``];
    try {
      const settings = await readDevSettings(repository.path);
      const problem = settingsProblem(repository.path);
      const file = join(repository.path, DEV_SETTINGS_FILE);
      lines.push(
        `- Default branch: \`${settings.mainBranch}\` on \`${settings.remote}\``,
        `- ${DEV_SETTINGS_FILE}: ${
          problem !== undefined
            ? `invalid, the last valid settings stay in force (${problem})`
            : existsSync(file)
              ? "in force"
              : "not written, the defaults are in force"
        }`,
        `- Worker: \`${settings.worker.use}\``,
        `- Reviewer: \`${settings.reviewer.use}\``,
      );
    } catch (error) {
      lines.push(
        `- ${DEV_SETTINGS_FILE}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (repository.removed) lines.push("- Removed from the registered repositories.");
    return { markdown: lines.join("\n") };
  },
};

export const planViews: ObjectViews = {
  row(object: StoredObject): ObjectRow {
    const plan = planData(object.data);
    return {
      id: bareId(object.id),
      title: plan.title,
      state: planState(plan),
      note: planNote(plan),
      scope: plan.repository,
      final: PLAN_FINAL_STATES.includes(planState(plan)),
      mark: planMark(plan),
      // The level dev:auto is asked for: a client marks the current one from it.
      badge: plan.auto,
      parent: `repo:${plan.repository}`,
    };
  },

  showScope: showRepository,

  sections(): readonly ViewSection[] {
    return [
      { id: "request", title: "Request" },
    ];
  },

  async load(ctx, object, sectionId) {
    const plan = planData(object.data);
    if (sectionId === "request") {
      return { markdown: plan.request };
    }
    return { markdown: "" };
  },
};

export const taskViews: ObjectViews = {
  row(object: StoredObject): ObjectRow {
    const task = taskData(object.data);
    const areaNote =
      task.phase === "ready" && task.areaHeldBy !== undefined
        ? `waiting for area ${task.area ?? ""} (${task.areaHeldBy})${
            (task.areaAhead ?? 0) > 0 ? `, ${task.areaAhead} ahead` : ""
          }`
        : task.area === undefined
          ? undefined
          : `area: ${task.area}`;
    // The cost is always first, so the app's split at the first ` · ` keeps it.
    const note = [
      costNote(task.cost, task.costQuality) ?? "$0.00",
      workerNote(task),
      areaNote,
      task.flowShown === undefined ? undefined : `flow: ${task.flowShown}`,
      waitNote(task),
    ]
      .filter((part): part is string => part !== undefined)
      .join(" · ");
    return {
      id: bareId(object.id),
      title: task.title,
      state: task.phase,
      note,
      scope: task.repository,
      final: TASK_FINAL_STATES.includes(task.phase),
      mark: taskMark(task),
      // A proposed task has no run but waits for the owner, as pending says.
      ...(task.phase === "proposed" ? { waiting: true } : {}),
      badge: taskBadge(task),
      parent: `plan:${storeKey(task.repository, task.plan)}`,
      ...(task.after.length === 0 ? {} : {
            after: task.after.map((entry) =>
              dependencyLabel(task.repository, dependencyKey(task.repository, entry)),
            ),
          }),
    };
  },

  showScope: showRepository,

  sections(object: StoredObject): readonly ViewSection[] {
    const task = taskData(object.data);
    const sections: ViewSection[] = [{ id: "brief", title: "Brief" }];
    if (hasRework(task.brief)) {
      sections.push({ id: "rework", title: "Rework" });
    }
    sections.push({ id: "changes", title: "Changes" });
    sections.push({ id: "log", title: "Log", live: true });
    sections.push({ id: "diff", title: "Diff" });
    sections.push({ id: "metrics", title: "Metrics" });
    return sections;
  },

  async load(ctx, object, sectionId, options) {
    const task = taskData(object.data);
    const parts = splitBrief(task.brief);
    if (sectionId === "brief") {
      const header = [
        ...(task.area === undefined ? [] : [`Area: ${task.area}`]),
        ...(task.flowShown === undefined ? [] : [`Flow: ${task.flowShown}`]),
      ];
      return {
        markdown: header.length === 0 ? parts.body : `${header.join("\n\n")}\n\n${parts.body}`,
      };
    }
    if (sectionId === "rework") return { markdown: parts.reworks };
    if (sectionId === "changes") return { markdown: renderChanges(parts.changes) };
    if (sectionId === "log") return { markdown: await workerLog(ctx, task) };
    if (sectionId === "diff") return diffSection(ctx, object, options.cursor);
    if (sectionId === "metrics") return { markdown: await metrics(ctx, object) };
    return { markdown: "" };
  },
};

/* ---------------------------------------------------------------------------
 * Log: the tail of the current attempt's worker log, as readable lines.
 * ------------------------------------------------------------------------- */

const LOG_TAIL_BYTES = 256 * 1024;
const LOG_TAIL_LINES = 80;
const LOG_EARLIER_LINES = 20;
const LOG_LINE_CHARS = 240;

/** An agent message as one paragraph of at most 300 characters. */
function agentText(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= 300 ? flat : `${flat.slice(0, 299)}…`;
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= LOG_LINE_CHARS
    ? flat
    : `${flat.slice(0, LOG_LINE_CHARS - 1)}…`;
}

function stringField(
  record: Record<string, unknown>,
  names: readonly string[],
): string | undefined {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

/** How a tool call that has an end line finished. */
interface ToolEnd {
  readonly durationMs: number | undefined;
  readonly error: string | undefined;
}

function numberField(record: Record<string, unknown>, name: string): number | undefined {
  const value = record[name];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clockTime(at: number): string {
  return `${new Date(at).toISOString().slice(11, 19)}Z`;
}

function tokenText(usage: unknown): string | undefined {
  if (typeof usage !== "object" || usage === null) return undefined;
  const record = usage as Record<string, unknown>;
  const input = numberField(record, "input");
  const output = numberField(record, "output");
  if (input === undefined && output === undefined) return undefined;
  return `${input ?? 0} in / ${output ?? 0} out tokens`;
}

/** The cost a log line carries, as dollars: pi's `total`, or `micros`. */
function costText(cost: unknown): string | undefined {
  if (typeof cost !== "object" || cost === null) return undefined;
  const record = cost as Record<string, unknown>;
  const micros = numberField(record, "micros");
  const dollars = micros !== undefined ? micros / 1e6 : numberField(record, "total");
  return dollars === undefined ? undefined : `$${dollars.toFixed(4)}`;
}

/** A command's characters shown in a log line before it is cut. */
const COMMAND_SHOWN_CHARS = 160;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A command as the log shows it: the `cd` into the task's worktree dropped,
 * the worktree path relative, then the first line only (with the count of the
 * lines left) and at most 160 characters.
 */
function shownCommand(command: string, worktree: string | undefined): string {
  let text = command;
  if (worktree !== undefined && worktree.length > 0) {
    const root = worktree.replace(/\/+$/, "");
    const path = escapeRegExp(root);
    text = text.replace(new RegExp(`^[ \\t]*cd[ \\t]+(?:"${path}"|'${path}'|${path})/?[ \\t]*(?:;|&&)[ \\t]*`), "");
    text = text.replace(new RegExp(`${path}/`, "g"), "");
    text = text.replace(new RegExp(`${path}(?![\\w./-])`, "g"), ".");
  }
  // Every line counts, blank ones too, and the first line is the command's first.
  const lines = text.split("\n");
  const first = (lines[0] ?? "").trim();
  const head = first.length <= COMMAND_SHOWN_CHARS ? first : `${first.slice(0, COMMAND_SHOWN_CHARS - 1)}…`;
  return lines.length > 1 ? `${head} … (+${lines.length - 1} lines)` : head;
}

/** Text as Markdown inline code; the fence is longer than any backtick run inside. */
function inlineCode(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  return longest > 0 ? `${fence} ${text} ${fence}` : `${fence}${text}${fence}`;
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Worker log lines as readable lines, in order. A tool call is one line: what
 * ran and how long it took, or since when it has been running when no end line
 * follows. The agent's own text is marked as the agent's; a turn's end gives
 * its stop reason, tokens and cost; a tool's output is never shown, only the
 * first line of an error. A command is shown as inline code after its label.
 * A turn's end is shown only after the agent's own text in that turn.
 */
export function readableLog(lines: readonly string[], options: { readonly worktree?: string | undefined } = {}): string[] {
  const ends = new Map<string, ToolEnd>();
  const starts = new Set<string>();
  let finished = false;
  for (const line of lines) {
    const record = parseObject(line.trim());
    if (record === undefined) continue;
    if (record.type === "result" || record.type === "Result") finished = true;
    const id = stringField(record, ["toolCallId"]);
    if (id === undefined) continue;
    if (record.type === "tool_execution_start") starts.add(id);
    if (record.type !== "tool_execution_end") continue;
    ends.set(id, {
      durationMs: numberField(record, "durationMs"),
      error: record.isError === true ? stringField(record, ["error"]) : undefined,
    });
  }
  const out: string[] = [];
  // Whether the agent has said something since the last turn ended.
  let said = false;
  for (const line of lines) {
    const record = parseObject(line.trim());
    const kind = record === undefined ? undefined : stringField(record, ["type"]);
    if (record !== undefined && kind === "tool_execution_start") {
      const id = stringField(record, ["toolCallId"]);
      const name = stringField(record, ["toolName"]) ?? "tool";
      const end = id === undefined ? undefined : ends.get(id);
      const at = numberField(record, "at");
      const input = stringField(record, ["input"]);
      const when =
        end !== undefined
          ? end.durationMs === undefined
            ? ""
            : ` ${seconds(end.durationMs)}`
          : finished
            ? ` no end logged${at === undefined ? "" : ` (started ${clockTime(at)})`}`
            : ` running${at === undefined ? "" : ` since ${clockTime(at)}`}`;
      const command = input === undefined ? "" : shownCommand(input, options.worktree);
      out.push(`tool ${name}${when}${command.length === 0 ? "" : ` ${inlineCode(command)}`}`);
      if (end?.error !== undefined) out.push(`tool ${name} failed: ${end.error.replace(/\s+/g, " ")}`);
      continue;
    }
    if (record !== undefined && kind === "tool_execution_end") {
      // An end whose start is not in the tail still tells of its error.
      const error = stringField(record, ["error"]);
      const id = stringField(record, ["toolCallId"]);
      const hasStart = id !== undefined && starts.has(id);
      if (error !== undefined && !hasStart) {
        out.push(oneLine(`tool ${stringField(record, ["toolName"]) ?? "tool"} failed: ${error}`));
      }
      continue;
    }
    if (record !== undefined && kind === "message_end") {
      const text = stringField(record, ["text"]);
      if (text !== undefined) {
        out.push(`**agent:** ${agentText(text)}`);
        said = true;
      }
      const stop = stringField(record, ["stopReason"]);
      const parts = [stop, tokenText(record.usage), costText(record.cost)].filter(
        (part): part is string => part !== undefined,
      );
      if (parts.length > 0 && said && stop !== "tool_use") out.push(`turn ended: ${parts.join(" · ")}`);
      said = false;
      continue;
    }
    if (record !== undefined && kind === "blocked") {
      const reason = stringField(record, ["reason"]);
      out.push(
        oneLine(`blocked ${stringField(record, ["toolName"]) ?? "tool"}${reason === undefined ? "" : `: ${reason}`}`),
      );
      continue;
    }
    if (record !== undefined && (kind === "result" || kind === "Result")) {
      if (kind === "Result") {
        const text = stringField(record, ["text"]);
        if (text !== undefined) out.push(`**agent:** ${agentText(text)}`);
      }
      const parts = [
        stringField(record, kind === "Result" ? ["stop_reason"] : ["result"]),
        tokenText(record.usage),
        costText(record.cost),
      ].filter((part): part is string => part !== undefined);
      if (parts.length > 0 || kind !== "Result") out.push(`result: ${parts.join(" · ")}`);
      continue;
    }
    if (record !== undefined && (kind === "journal" || kind === undefined) && typeof record.event === "string") {
      const data = isObject(record.data) ? record.data : {};
      if (record.event === "MessageAppended") {
        const message = isObject(data.message) ? data.message : {};
        const assistant = isObject(message.assistant) ? message.assistant : undefined;
        const blocks: unknown[] = Array.isArray(assistant?.content) ? assistant.content : [];
        const text = blocks
          .map((block) => (isObject(block) && isObject(block.text) ? stringField(block.text, ["text"]) : undefined))
          .filter((part): part is string => part !== undefined)
          .join(" ");
        if (text.trim().length > 0) {
          out.push(`**agent:** ${agentText(text)}`);
          said = true;
        }
        continue;
      }
      if (record.event === "ModelUsageRecorded") {
        const parts = [stringField(data, ["stop_reason"]), tokenText(data.usage), costText(data.fee)].filter(
          (part): part is string => part !== undefined,
        );
        if (parts.length > 0 && said && stringField(data, ["stop_reason"]) !== "tool_use") {
          out.push(`turn ended: ${parts.join(" · ")}`);
        }
        said = false;
        continue;
      }
    }
    if (record !== undefined && ["session", "rate_limit", "agent_settled", "grant_use"].includes(kind ?? "")) {
      continue;
    }
    const readable = readableLogLine(line);
    if (readable !== undefined) out.push(readable);
  }
  return out;
}

/** One worker log line as a sentence, or undefined for bookkeeping. */
export function readableLogLine(line: string): string | undefined {
  const text = line.trim();
  if (text.length === 0) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return oneLine(text);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return oneLine(text);
  }
  const record = value as Record<string, unknown>;
  const kind = stringField(record, ["type"]) ?? "";
  const tool = stringField(record, ["tool", "tool_name", "toolName", "name"]);
  const event = stringField(record, ["event"]) ?? "";
  if (tool !== undefined) {
    const input = record.input ?? record.args ?? record.arguments;
    const shown =
      input === undefined
        ? ""
        : ` ${oneLine(typeof input === "string" ? input : JSON.stringify(input))}`;
    return oneLine(`tool ${tool}${shown}`);
  }
  if (kind === "journal") {
    return /tool/i.test(event) ? oneLine(`tool: ${event}`) : undefined;
  }
  const said = stringField(record, ["text", "message", "content"]);
  if (said !== undefined) {
    return oneLine(`${kind === "Result" ? "result" : "assistant"}: ${said}`);
  }
  return undefined;
}

function segment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned.length === 0 || cleaned === "." || cleaned === ".."
    ? "_"
    : cleaned;
}

async function workerLogPath(
  ctx: ViewContext,
  task: TaskData,
): Promise<string | undefined> {
  const attempt = task.attempt;
  if (attempt === undefined) return undefined;
  if (typeof attempt.workLog === "string" && attempt.workLog.length > 0) {
    return attempt.workLog;
  }
  // While the worker runs its log is not recorded yet; it is where the
  // harness's logger puts it for this run.
  if (typeof attempt.run !== "string" || attempt.run.length === 0) {
    return undefined;
  }
  const found = await findRepository(ctx.store, task.repository);
  if (found === undefined) return undefined;
  const settings = await readDevSettings(repositoryData(found.data).path);
  const ran = settings.workers.workers.find((worker) => worker.name === attempt.worker);
  const [plugin, step] = (ran?.use ?? settings.worker.use).split("/");
  if (plugin === undefined || step === undefined) return undefined;
  return join(
    ctx.store.root,
    "logs",
    segment(plugin),
    "runs",
    segment(attempt.run),
    `${segment(step)}.log`,
  );
}

function logPathFor(ctx: ViewContext, use: string, run: string): string | undefined {
  const [plugin, step] = use.split("/");
  if (plugin === undefined || step === undefined) return undefined;
  return join(ctx.store.root, "logs", segment(plugin), "runs", segment(run), `${segment(step)}.log`);
}

/** The last `limit` bytes of a file, never the bytes before them. */
function readTail(path: string, limit: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - limit);
    const buffer = Buffer.allocUnsafe(size - start);
    let read = 0;
    while (read < buffer.length) {
      const count = readSync(fd, buffer, read, buffer.length - read, start + read);
      if (count === 0) break;
      read += count;
    }
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/** The readable lines of one log file, or undefined when there is no file. */
function readLogLines(path: string | undefined, worktree: string | undefined): string[] | undefined {
  if (path === undefined || !existsSync(path)) return undefined;
  const tail = readTail(path, LOG_TAIL_BYTES);
  return readableLog(tail.toString("utf8").split("\n"), { worktree });
}

/**
 * The log of the current attempt. The worker's lines come first; once the
 * attempt is under review, each reviewer round's lines follow. A section that
 * holds more than one agent says which agent each block is from.
 */
async function workerLog(ctx: ViewContext, task: TaskData): Promise<string> {
  const attempt = task.attempt;
  const blocks: Array<{ readonly label: string; readonly lines: string[] }> = [];
  const worktree = typeof attempt?.worktree === "string" ? attempt.worktree : undefined;
  const worker = readLogLines(await workerLogPath(ctx, task), worktree);
  if (worker !== undefined && worker.length > 0) {
    blocks.push({ label: `Worker, attempt ${attempt?.number ?? 1}`, lines: worker });
  }
  const seen = new Set<string>();
  const reviews = [
    ...(attempt?.reviewRuns ?? []),
    ...(attempt?.reviewPending === undefined || attempt.reviewPending === null
      ? []
      : [attempt.reviewPending]),
  ];
  let reviewing = false;
  for (const review of reviews) {
    if (typeof review.run !== "string" || review.run.length === 0) continue;
    const path = logPathFor(ctx, review.use, review.run);
    if (path === undefined || seen.has(path)) continue;
    seen.add(path);
    reviewing = true;
    const lines = readLogLines(path, worktree);
    if (lines === undefined || lines.length === 0) continue;
    blocks.push({ label: `Reviewer, round ${review.round} (${review.model})`, lines });
  }
  if (blocks.length === 0) {
    return worker === undefined && !reviewing
      ? "_No worker log yet._"
      : "_The worker has written nothing readable yet._";
  }
  if (blocks.length === 1) {
    return (blocks[0]?.lines ?? []).slice(-LOG_TAIL_LINES).join("\n\n");
  }
  // The newest block gets the whole tail; the earlier ones a short one.
  return blocks
    .map((block, index) => {
      const keep = index === blocks.length - 1 ? LOG_TAIL_LINES : LOG_EARLIER_LINES;
      return [`**${block.label}**`, ...block.lines.slice(-keep)].join("\n\n");
    })
    .join("\n\n---\n\n");
}

/* ---------------------------------------------------------------------------
 * Diff: the task branch against main, one page per file when it is long.
 * ------------------------------------------------------------------------- */

/** A diff longer than this many characters is paged by file. */
export const DIFF_PAGE_CHARS = 60_000;

function fence(diff: string): string {
  return `\`\`\`\`diff\n${diff.trimEnd()}\n\`\`\`\``;
}

async function diffSection(
  ctx: ViewContext,
  object: StoredObject,
  cursor: string | undefined,
): Promise<{
  readonly markdown: string;
  readonly next?: string;
  readonly pages?: readonly { readonly label: string; readonly cursor?: string }[];
}> {
  const task = taskData(object.data);
  const found = await findRepository(ctx.store, task.repository);
  if (found === undefined) return { markdown: "_The repository is not registered._" };
  const repository = repositoryData(found.data);
  const settings = await readDevSettings(repository.path);
  const branch = task.attempt?.branch ?? workBranch(bareId(object.id));
  const main = `${settings.remote}/${settings.mainBranch}`;
  const range = `${main}...${branch}`;
  const stat = git(repository.path, ["diff", "--stat", range], true);
  if (!stat.ok) {
    return { markdown: `_No diff: ${stat.err || `cannot compare ${branch} with ${main}`}._` };
  }
  if (stat.out.length === 0) {
    return { markdown: `_${branch} has no changes against ${main}._` };
  }
  const whole = git(repository.path, ["diff", range]);
  if (whole.out.length <= DIFF_PAGE_CHARS && cursor === undefined) {
    return { markdown: `${fence(stat.out)}\n\n${fence(whole.out)}` };
  }
  const names = git(repository.path, ["diff", "--name-only", range]).out
    .split("\n")
    .filter((name) => name.length > 0);
  const pages = [
    { label: "overview" },
    ...names.map((name, at) => ({ label: name, cursor: String(at + 1) })),
  ];
  const index = cursor === undefined ? 0 : Number(cursor);
  if (!Number.isInteger(index) || index < 0 || index > names.length) {
    return { markdown: "_That page of the diff does not exist._" };
  }
  if (index === 0) {
    return {
      markdown: `${fence(stat.out)}\n\nThe diff is long: one page per file.\n\n${names
        .map((name, at) => `${at + 1}. \`${name}\``)
        .join("\n")}`,
      next: "1",
      pages,
    };
  }
  const name = names[index - 1];
  if (name === undefined) return { markdown: "" };
  const file = git(repository.path, ["diff", range, "--", name]);
  return {
    markdown: `### ${name}\n\n${fence(file.out)}`,
    pages,
    ...(index < names.length ? { next: String(index + 1) } : {}),
  };
}

/* ---------------------------------------------------------------------------
 * Metrics: a narrow summary table and one line per attempt.
 * ------------------------------------------------------------------------- */

const METRIC_STEPS = ["worktree", "work", "reverify", "verify", "review", "integrate"] as const;

function seconds(ms: number): string {
  if (ms < 1000) return "<1s";
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  return minutes === 0 ? `${total}s` : `${minutes}m${String(total % 60).padStart(2, "0")}s`;
}

interface AttemptMetrics {
  readonly number: number;
  /** The runs that ran it, in the order the task first named them. */
  readonly runs: string[];
  last: TaskAttempt | undefined;
  /** The latest step recorded for it. */
  lastStep: string;
  /** False when no run of it could be read, so it has no times. */
  timed: boolean;
  /** Its time: from its run's start to its run's end, without the waits for a person. */
  ms: number;
  /** Each step's time, in the order the run took them. */
  readonly steps: Map<string, number>;
  /** The step its run is in now, when the run is active and not waiting for a person. */
  running: string | undefined;
}

type RunTimes = NonNullable<Awaited<ReturnType<NonNullable<ViewContext["runTimes"]>>>>;

/**
 * A run's stretches cut into one group per attempt. A new attempt begins when
 * the worktree step is entered again after the worker has run: a worktree
 * retry before any work is the same attempt, a rework or reject is the next.
 */
function attemptCycles(segments: RunTimes["segments"]): RunTimes["segments"][number][][] {
  const cycles: RunTimes["segments"][number][][] = [[]];
  let worked = false;
  for (const segment of segments) {
    if (!segment.person && segment.step === "worktree" && worked) {
      cycles.push([]);
      worked = false;
    }
    if (!segment.person && segment.step === "work") worked = true;
    cycles[cycles.length - 1]?.push(segment);
  }
  return cycles;
}

/** A token count: whole below 10k, then in k with one decimal. */
export function tokenCount(count: number): string {
  return count < 10_000 ? String(count) : `${(count / 1000).toFixed(1)}k`;
}

/** A wall time for the narrow table: seconds, minutes, or hours and minutes. */
function wallTime(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.round(total / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

function findingsText(review: ReviewRecord): string {
  const count = review.findings?.length;
  if (count === undefined) return "review: findings";
  return `review: ${count} ${count === 1 ? "finding" : "findings"}`;
}

/**
 * How the attempt's latest step ended it, when it did. Only the record that
 * step wrote counts: an older review or verify record of the same attempt
 * (a reverify keeps them) says nothing about it.
 */
function endedBy(entry: AttemptMetrics): string | undefined {
  const last = entry.last;
  if (entry.lastStep === "verify") {
    return last?.verify?.result === "fail" ? "verify failed" : undefined;
  }
  if (entry.lastStep === "review") {
    const review = last?.review;
    if (review === undefined || review === null) return undefined;
    if (review.result === "findings" || review.result === "fail") return findingsText(review);
    if (review.result === "pass" || review.result === "passed") return undefined;
    return `review ${review.result.replace("_", " ")}`;
  }
  if (entry.lastStep === "integrate") {
    const integration = last?.integration?.result;
    if (integration === "merged") return "merged";
    if (integration === "conflict") return "conflict";
    if (integration === "fail" || integration === "failed") return "integrate failed";
  }
  const result = last?.result;
  if (
    (entry.lastStep === "worktree" || entry.lastStep === "reverify" || entry.lastStep === "work") &&
    (result === "failed" || result === "blocked" || result === "nothing")
  ) {
    return `${entry.lastStep} ${result}`;
  }
  return undefined;
}

/** How an attempt that is not running ended, from its recorded results only. */
function attemptResult(
  entry: AttemptMetrics,
  latest: boolean,
  phase: TaskData["phase"],
  current: string | undefined,
): string {
  if (latest && phase === "cancelled") return "cancelled";
  if (current !== undefined) return `running ${current.replaceAll("_", " ")}`;
  const ended = endedBy(entry);
  if (ended !== undefined) return ended;
  if (entry.lastStep === "review") return "review passed";
  if (latest && phase === "merged") return "merged";
  return latest && phase === "waiting" ? "waiting" : "–";
}

/**
 * The task's attempts: a narrow summary table (number, time, cost, result;
 * one row per attempt and a total), then one short line per attempt, newest
 * first, with its per-step times and tokens. Every time comes from the run's
 * own facts: an attempt runs from its run's start to its run's end, a step
 * from its entry to its result or the run's end, and the time spent waiting
 * for a person is a line of its own, inside neither. `now` closes what a
 * run that is still active has open.
 */
export async function metrics(
  ctx: ViewContext,
  object: StoredObject,
  now: number = Date.now(),
): Promise<string> {
  const byAttempt = new Map<number, AttemptMetrics>();
  let cursor: string | undefined;
  for (;;) {
    const page = await ctx.store.facts(
      { type: object.type, id: object.id },
      cursor === undefined ? {} : { cursor },
    );
    for (const fact of page.facts) {
      if (fact.type !== "task") continue;
      const attempt = taskData(fact.data).attempt;
      if (attempt === undefined) continue;
      let entry = byAttempt.get(attempt.number);
      if (entry === undefined) {
        entry = {
          number: attempt.number,
          runs: [],
          last: undefined,
          lastStep: "",
          timed: false,
          ms: 0,
          steps: new Map(),
          running: undefined,
        };
        byAttempt.set(attempt.number, entry);
      }
      const step = /^dev:(\w+)$/.exec(fact.cause)?.[1];
      if (step !== undefined && (METRIC_STEPS as readonly string[]).includes(step)) {
        entry.lastStep = step;
      }
      entry.last = attempt;
      if (typeof attempt.run === "string" && !entry.runs.includes(attempt.run)) {
        entry.runs.push(attempt.run);
      }
    }
    if (page.next === undefined) break;
    cursor = page.next;
  }
  // Only an attempt that ran a step is one: the others are facts about a task.
  for (const [number, entry] of byAttempt) if (entry.lastStep === "") byAttempt.delete(number);
  if (byAttempt.size === 0) return "_No attempts yet._";
  const entries = [...byAttempt.values()].sort(
    (left, right) => left.number - right.number,
  );
  const task = taskData(object.data);
  const phase = task.phase;

  // The attempts of each run, in order, take that run's groups of stretches in order.
  const runIds = [...new Set(entries.flatMap((entry) => entry.runs))];
  let waitedMs = 0;
  let waiting = false;
  for (const runId of runIds) {
    const times = ctx.runTimes === undefined ? undefined : await ctx.runTimes(runId);
    if (times === undefined) continue;
    const cycles = attemptCycles(times.segments);
    const owners = entries.filter((entry) => entry.runs.includes(runId));
    // A group the run has begun whose attempt the task has not recorded yet
    // (the worktree of a rework is being prepared): the next attempt, already
    // running or cancelled in it.
    while (owners.length < cycles.length) {
      const pending: AttemptMetrics = {
        number: (entries[entries.length - 1]?.number ?? 0) + 1,
        runs: [runId],
        last: undefined,
        lastStep: "worktree",
        timed: false,
        ms: 0,
        steps: new Map(),
        running: undefined,
      };
      entries.push(pending);
      owners.push(pending);
    }
    for (const segment of times.segments) {
      if (segment.person) {
        waitedMs += Math.max(0, (segment.to ?? now) - segment.from);
        if (segment.to === null) waiting = true;
      }
    }
    owners.forEach((entry, index) => {
      const cycle = cycles[index];
      if (cycle === undefined) return;
      const first = cycle[0];
      const nextFrom = cycles[index + 1]?.[0]?.from;
      const from = index === 0 ? times.startedAt : (first?.from ?? times.startedAt);
      const to = nextFrom ?? times.endedAt ?? now;
      let waited = 0;
      for (const segment of cycle) {
        const spent = Math.max(0, (segment.to ?? now) - segment.from);
        if (segment.person) {
          waited += spent;
          continue;
        }
        entry.steps.set(segment.step, (entry.steps.get(segment.step) ?? 0) + spent);
      }
      entry.timed = true;
      entry.ms += Math.max(0, to - from - waited);
      const open = cycle[cycle.length - 1];
      if (index === cycles.length - 1 && open !== undefined && open.to === null && !open.person) {
        entry.running = open.step;
      }
    });
  }

  const newest = entries[entries.length - 1]?.number;
  const lines = ["| # | time | cost | result |", "| --- | --- | --- | --- |"];
  let totalMs = 0;
  let totalCost = 0;
  let costed = false;
  let quality = "";
  for (const entry of entries) {
    const last = entry.last;
    totalMs += entry.ms;
    if (typeof last?.cost === "number" && Number.isFinite(last.cost)) {
      totalCost += last.cost;
      costed = true;
      if (last.costQuality === "incomplete") quality = "incomplete";
      else if (last.costQuality === "estimated" && quality === "") quality = "estimated";
    }
    const time = entry.timed ? `${wallTime(entry.ms)}${entry.running === undefined ? "" : " …"}` : "–";
    lines.push(
      `| ${entry.number} | ${time} | ${costNote(last?.cost, last?.costQuality) ?? "–"} | ${attemptResult(entry, entry.number === newest, phase, entry.running)} |`,
    );
  }
  lines.push(
    `| total | ${wallTime(totalMs)} | ${costed ? costNote(totalCost, quality) : "–"} | |`,
  );
  const perAttempt = [...entries].reverse().map((entry) => {
    const mark = " (running)";
    const parts: string[] = [];
    // The steps dev names come first, in its order; any other step that took
    // time (a retry wait, a rework) follows, and the one running always shows.
    for (const name of METRIC_STEPS) {
      const spent = entry.steps.get(name);
      if (spent !== undefined) parts.push(`${name} ${seconds(spent)}${entry.running === name ? mark : ""}`);
    }
    for (const [name, spent] of entry.steps) {
      if ((METRIC_STEPS as readonly string[]).includes(name)) continue;
      if (spent < 1000 && entry.running !== name) continue;
      parts.push(`${name.replaceAll("_", " ")} ${seconds(spent)}${entry.running === name ? mark : ""}`);
    }
    const tokens = entry.last?.tokens;
    if (tokens !== undefined && tokens !== null) {
      parts.push(`${tokenCount(tokens.input)} in / ${tokenCount(tokens.output)} out tokens`);
    }
    return `**#${entry.number}** ${parts.join(" · ")}`;
  });
  const waitLine =
    waitedMs > 0 || waiting
      ? [`**Waiting for a person** ${seconds(waitedMs)}${waiting ? " (waiting)" : ""}`]
      : [];
  const summary = [lines.join("\n"), perAttempt.join("\n\n"), ...waitLine].join("\n\n");
  const perWorker = workerTable(entries);
  return perWorker === undefined ? summary : `${summary}\n\n${perWorker}`;
}

/**
 * Cost, time and first-pass result per worker, summed over the attempts. An
 * attempt from before pools has no worker and is left out; no table when none
 * has one. First pass: the attempt's first review round passed.
 */
function workerTable(entries: readonly AttemptMetrics[]): string | undefined {
  const rows = new Map<
    string,
    { attempts: number; cost: number; costed: boolean; ms: number; reviewed: number; first: number }
  >();
  for (const entry of entries) {
    const worker = entry.last?.worker;
    if (typeof worker !== "string" || worker.length === 0) continue;
    const row = rows.get(worker) ?? {
      attempts: 0, cost: 0, costed: false, ms: 0, reviewed: 0, first: 0,
    };
    row.attempts += 1;
    const cost = entry.last?.cost;
    if (typeof cost === "number" && Number.isFinite(cost)) {
      row.cost += cost;
      row.costed = true;
    }
    row.ms += entry.ms;
    const review = entry.last?.review;
    if (review !== undefined && review !== null) {
      row.reviewed += 1;
      if ((review.result === "passed" || review.result === "pass") && (review.round ?? 1) <= 1) row.first += 1;
    }
    rows.set(worker, row);
  }
  if (rows.size === 0) return undefined;
  const lines = [
    "| worker | attempts | cost | time | first pass |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const [worker, row] of [...rows].sort(([a], [b]) => a.localeCompare(b))) {
    const cost = row.costed ? `$${row.cost.toFixed(2)}` : "-";
    const first = row.reviewed === 0 ? "-" : `${row.first}/${row.reviewed}`;
    lines.push(
      `| ${cell(worker)} | ${row.attempts} | ${cost} | ${seconds(row.ms)} | ${first} |`,
    );
  }
  return lines.join("\n");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
