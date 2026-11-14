#!/usr/bin/env bun
/**
 * Turns `operad history <id> --json` output into a TLA+ module (`TraceData`)
 * that tla/pool/ and tla/integrate/ check as a behaviour of their model.
 *
 *   operad history operad-ios/T-0076-chat-bottom-followups --json > a.json
 *   operad history operad-ios/T-0077-state-colors-followups --json > b.json
 *   bun scripts/tla-trace.ts --out /tmp/trace \
 *     operad-ios/T-0076-chat-bottom-followups=a.json operad-ios/T-0077-state-colors-followups=b.json
 *   TLA_MAIN=TraceMC TLA_LIB=/tmp/trace bash scripts/tla.sh pool -workers 1 -deadlock
 *
 * Arguments: `<id>=<file>` (the id is what you gave `operad history`; the part
 * before `/` is the repository), or with no file, one history on stdin and
 * `--id <id>`. `--out <dir>` writes `<dir>/TraceData.tla`; without it the module
 * goes to stdout. The script only reads the JSON it is given: it never opens the
 * store.
 *
 * `bun scripts/tla-trace.ts verdict <file>` (or `-` for stdin) reads what TLC
 * printed for a trace check and says whether the model allowed the whole
 * history or at which event it stopped.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** One line of `operad history --json`. */
export interface HistoryLine {
  readonly time: string;
  readonly step: string | null;
  readonly what: string;
  readonly why: string;
}

/** One history, with the task it belongs to. */
export interface TaskHistory {
  readonly id: string;
  readonly lines: readonly HistoryLine[];
}

/** One step of the trace: a task and what its history says happened. */
export interface TraceEvent {
  readonly task: string;
  readonly event: string;
}

export interface Trace {
  readonly tasks: readonly string[];
  readonly repoOf: Readonly<Record<string, string>>;
  readonly events: readonly TraceEvent[];
  /** `what` lines that mean nothing to the models (kept so a reader can see what was dropped). */
  readonly ignored: readonly string[];
}

const NOISE = [/^running /, /^moving to /, /^waiting for you/, /^event /, /^continuing on updated code/];

/**
 * The event a history line stands for, or undefined when the line only
 * narrates. Events are `run:start`, `run:done`, `run:cancelled`, `run:failed`,
 * `run:crashed` (a step re-run after a crash; neither is in a model, so a trace
 * holding one is rejected there rather than accepted without it),
 * `start:<step>`, `result:<step>:<result>` and `choose:<action>`.
 */
export function eventOf(line: HistoryLine): string | undefined {
  const what = line.what;
  if (what === "run started") return "run:start";
  if (what === "run done") return "run:done";
  if (what === "run failed") return "run:failed";
  if (/^re-running .* after a crash$/.test(what)) return "run:crashed";
  if (line.step === null && /cancel/i.test(what)) return "run:cancelled";
  if (NOISE.some((pattern) => pattern.test(what))) return undefined;
  const started = /^started (\S+)$/.exec(what);
  if (started !== null) return `start:${started[1]}`;
  const chose = /^you chose (\S+)$/.exec(what);
  if (chose !== null) return `choose:${chose[1]}`;
  const result = /^(\S+) (\S+)$/.exec(what);
  if (result !== null && line.step === result[1]) return `result:${result[1]}:${result[2]}`;
  return undefined;
}

function isLine(value: unknown): value is HistoryLine {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.time === "string" &&
    (typeof record.step === "string" || record.step === null) &&
    typeof record.what === "string"
  );
}

/** Parses the text of `operad history <id> --json`. */
export function parseHistory(text: string): HistoryLine[] {
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value)) throw new Error("a history is a JSON array");
  return value.map((item, index) => {
    if (!isLine(item)) throw new Error(`history line ${index + 1} has no time, step and what`);
    return { time: item.time, step: item.step, what: item.what, why: typeof (item as { why?: unknown }).why === "string" ? (item as { why: string }).why : "" };
  });
}

/** Merges the histories of several tasks into one sequence ordered by time (ties keep the input order). */
export function buildTrace(histories: readonly TaskHistory[]): Trace {
  const ids = new Set<string>();
  for (const history of histories) {
    if (ids.has(history.id)) throw new Error(`task ${history.id} is given twice`);
    ids.add(history.id);
  }
  const ignored: string[] = [];
  const keyed: { time: number; order: number; event: TraceEvent }[] = [];
  let order = 0;
  for (const history of histories) {
    for (const line of history.lines) {
      const event = eventOf(line);
      if (event === undefined) {
        if (!NOISE.some((pattern) => pattern.test(line.what)) && !ignored.includes(line.what)) {
          ignored.push(line.what);
        }
        continue;
      }
      const time = Date.parse(line.time);
      if (Number.isNaN(time)) throw new Error(`${history.id}: "${line.time}" is not a time`);
      keyed.push({ time, order: order++, event: { task: history.id, event } });
    }
  }
  keyed.sort((a, b) => a.time - b.time || a.order - b.order);
  const repoOf: Record<string, string> = {};
  for (const history of histories) {
    const slash = history.id.indexOf("/");
    repoOf[history.id] = slash > 0 ? history.id.slice(0, slash) : "repo";
  }
  return {
    tasks: histories.map((history) => history.id),
    repoOf,
    events: keyed.map((entry) => entry.event),
    ignored,
  };
}

function quote(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function count(trace: Trace, task: string, event: string): number {
  return trace.events.filter((e) => e.task === task && e.event === event).length;
}

/** The module the model-specific specs read. */
export function renderModule(trace: Trace): string {
  const tasks = trace.tasks.map(quote).join(", ");
  const repo = (trace.tasks.length === 0
    ? ["\"none\""]
    : trace.tasks.map((task, index) =>
        `${index === 0 ? "IF" : "ELSE IF"} t = ${quote(task)} THEN ${quote(trace.repoOf[task] ?? "repo")}`,
      )
  ).join("\n    ");
  const repoExpr =
    trace.tasks.length === 0 ? '"none"' : `${repo}\n    ELSE ${quote("repo")}`;
  const steps = trace.events.map((e) => `<<${quote(e.task)}, ${quote(e.event)}>>`).join(",\n  ");
  const most = (event: string): number =>
    Math.max(0, ...trace.tasks.map((task) => count(trace, task, event)));
  const failures = (task: string): number =>
    trace.events.filter(
      (e) => e.task === task && /^result:integrate:(fail|conflict)$/.test(e.event),
    ).length;
  return `---- MODULE TraceData ----
\\* Generated by scripts/tla-trace.ts from operad history output; do not edit.
\\* ${trace.events.length} events of ${trace.tasks.length} task(s).
EXTENDS Naturals

TraceTasks == {${tasks}}

TraceRepoOf == [t \\in TraceTasks |->
    ${repoExpr}]

\\* The events, oldest first: <<task, event>>.
TraceEvents == <<${steps === "" ? "" : `\n  ${steps}\n`}>>

\\* The most work starts one task has (the attempts the model must allow).
TraceMaxStarts == ${most("start:work")}

\\* The most integration failures that sent one task back for rework.
TraceMaxFails == ${Math.max(0, ...trace.tasks.map(failures))}
====
`;
}

export interface Verdict {
  readonly accepted: boolean;
  /** Events the model allowed. */
  readonly matched: number;
  readonly total: number;
  /** The first event the model did not allow (when rejected). */
  readonly rejected?: { readonly task: string; readonly event: string };
}

/** Reads TLC's output of PoolTrace or IntegrateTrace (run with `-workers 1 -deadlock`). */
export function verdictOf(tlcOutput: string): Verdict {
  const progress = [
    ...tlcOutput.matchAll(
      /<<\s*"TRACE",\s*(\d+),\s*(\d+),\s*"((?:[^"\\]|\\.)*)",\s*"((?:[^"\\]|\\.)*)"\s*>>/g,
    ),
  ];
  if (progress.length === 0) throw new Error("no TRACE line in the TLC output: was it run with PoolTrace or IntegrateTrace?");
  let matched = 0;
  let total = 0;
  let task = "";
  let event = "";
  for (const line of progress) {
    const k = Number(line[1]);
    if (k >= matched) {
      matched = k;
      total = Number(line[2]);
      task = line[3] ?? "";
      event = line[4] ?? "";
    }
  }
  if (/Invariant NotAllMatched is violated/.test(tlcOutput) || matched === total) {
    return { accepted: true, matched: total, total };
  }
  // No error in the whole run is the only way the model rejects: anything else
  // (another invariant, a deadlock, a parse error) stopped TLC for another reason.
  if (!/Model checking completed\. No error has been found/.test(tlcOutput)) {
    const why = /Error: ([^\n]*)/.exec(tlcOutput)?.[1] ?? "it did not finish";
    throw new Error(`TLC stopped for another reason than the model refusing an event (${why}); run with -workers 1 -deadlock`);
  }
  return { accepted: false, matched, total, rejected: { task, event } };
}

function parseArguments(args: readonly string[]): { out?: string; id?: string; files: { id: string; file: string }[] } {
  const files: { id: string; file: string }[] = [];
  let out: string | undefined;
  let id: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--out") out = args[++i];
    else if (arg === "--id") id = args[++i];
    else {
      const eq = arg.lastIndexOf("=");
      if (eq <= 0) throw new Error(`"${arg}" is not <id>=<file>`);
      files.push({ id: arg.slice(0, eq), file: arg.slice(eq + 1) });
    }
  }
  return { ...(out === undefined ? {} : { out }), ...(id === undefined ? {} : { id }), files };
}

if (import.meta.main) {
  try {
    if (process.argv[2] === "verdict") {
      const source = process.argv[3];
      if (source === undefined) throw new Error("verdict needs a file of TLC output, or -");
      const verdict = verdictOf(readFileSync(source === "-" ? 0 : source, "utf8"));
      process.stdout.write(
        verdict.accepted
          ? `accepted: the model allows all ${verdict.total} events\n`
          : `rejected: the model allows ${verdict.matched} of ${verdict.total} events and not the next, ${verdict.rejected?.event} of ${verdict.rejected?.task}\n`,
      );
      process.exit(verdict.accepted ? 0 : 3);
    }
    const parsed = parseArguments(process.argv.slice(2));
    const histories: TaskHistory[] = parsed.files.map(({ id, file }) => ({
      id,
      lines: parseHistory(readFileSync(file, "utf8")),
    }));
    if (histories.length === 0) {
      if (parsed.id === undefined) throw new Error("give <id>=<file> arguments, or --id <id> with a history on stdin");
      histories.push({ id: parsed.id, lines: parseHistory(readFileSync(0, "utf8")) });
    }
    const trace = buildTrace(histories);
    const text = renderModule(trace);
    if (parsed.out === undefined) process.stdout.write(text);
    else {
      mkdirSync(parsed.out, { recursive: true });
      writeFileSync(join(parsed.out, "TraceData.tla"), text);
      process.stderr.write(`tla-trace: ${trace.events.length} events of ${trace.tasks.length} task(s) written to ${join(parsed.out, "TraceData.tla")}\n`);
    }
    if (trace.ignored.length > 0) process.stderr.write(`tla-trace: not an event of any model: ${trace.ignored.join("; ")}\n`);
  } catch (error) {
    process.stderr.write(`tla-trace: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
