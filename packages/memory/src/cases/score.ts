/**
 * Runs the memory regression set against the memory as it is now and records a
 * score. A case is scored by exact phrases, not by a model judge:
 *
 * - The score then moves only when the memory, the compaction window or the
 *   answerer moves. A judge model adds its own drift to a number whose job is
 *   to show the memory's drift, and a fixed rubric does not remove it.
 * - It costs nothing to run, so it can run after every change to the memory.
 * - The phrases are short phrases the person approved when the case was made
 *   (a name, a date, a number), which is the kind of answer a memory misses.
 *
 * The default answerer needs no model. It builds what the bot would have in
 * front of it for the question (the messages a compaction would keep, the
 * memory index cut at its limit, and what a memory search of the question
 * returns) and scores that: a phrase the bot is never shown cannot be answered.
 * A program may stand in for the answerer to score a real bot's answer.
 */

import { cpSync, existsSync, appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isRecord, type JsonValue } from "@operad-io/engine";
import { MEMORY_INDEX_MAX } from "../memory.ts";
import { MemorySearch } from "../search/service.ts";
import { chatDocument } from "../search/sources.ts";
import { loadCases, CaseError, type CaseMessage, type MemoryCase } from "./format.ts";

/** The messages a compaction keeps whole, when `--window` is not given. */
export const DEFAULT_WINDOW = 6;

/** The file the scores are appended to, in the operad home. */
export const SCORES_FILE = "memory-scores.jsonl";

/** What the answerer is given for one case. */
export interface AnswerInput {
  readonly question: string;
  /** The messages still in the context after compaction. */
  readonly context: readonly CaseMessage[];
  /** The memory index and what a search of the question found. */
  readonly memory: string;
}

/** Turns what the bot has into an answer. */
export type Answerer = (input: AnswerInput) => Promise<string>;

/** The answerer that needs no model: everything the bot is shown is its answer. */
export const recallAnswerer: Answerer = async (input) =>
  [...input.context.map((message) => message.text), input.memory].join("\n");

/** An answerer that runs a program: the input is JSON on stdin, the answer is its stdout. */
export function programAnswerer(command: readonly string[], timeoutMs = 120_000): Answerer {
  return async (input) => {
    const child = Bun.spawn({
      cmd: [...command],
      stdin: new Blob([JSON.stringify(input)]),
      stdout: "pipe",
      stderr: "ignore",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
    const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    if (code !== 0) throw new CaseError(`the answer program ended with code ${code}`);
    return out;
  };
}

/** Text as phrases are compared: lowercase, with spaces and punctuation removed. */
export function normalised(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** How one answer fared against one case. */
export interface CaseScore {
  readonly id: string;
  readonly passed: boolean;
  /** Facts the answer did not state. */
  readonly missing: readonly string[];
  /** Wrong phrases the answer stated. */
  readonly repeated: readonly string[];
}

/** A case passes when every fact is stated and no wrong phrase is. */
export function scoreAnswer(answer: string, found: MemoryCase): CaseScore {
  const text = normalised(answer);
  const states = (phrase: string): boolean => {
    const wanted = normalised(phrase);
    return wanted.length > 0 && text.includes(wanted);
  };
  const missing = found.answer.include.filter((phrase) => !states(phrase));
  const repeated = found.answer.avoid.filter((phrase) => states(phrase));
  return { id: found.id, passed: missing.length === 0 && repeated.length === 0, missing, repeated };
}

/** The settings a score was taken under, so a change of score can be read against them. */
export interface ScoreSettings {
  readonly bot: string;
  readonly window: number;
  readonly memoryIndexMax: number;
  /** `recall`, or the program that answered. */
  readonly answerer: string;
  /** A memory directory used in place of the bot's own, when one was given. */
  readonly memory?: string | undefined;
}

/** One line of the score history. It holds ids and counts, never case text. */
export interface ScoreRecord {
  readonly at: number;
  readonly set: string;
  readonly total: number;
  readonly passed: number;
  readonly score: number;
  readonly settings: ScoreSettings;
  readonly cases: readonly { readonly id: string; readonly passed: boolean }[];
}

/** What one run needs. */
export interface ScoreOptions {
  readonly home: string;
  readonly casesDir: string;
  readonly settings?: Readonly<Record<string, JsonValue>> | undefined;
  readonly bot?: string | undefined;
  /** Use this directory as the bot's memory instead of the home's. */
  readonly memory?: string | undefined;
  readonly window?: number | undefined;
  readonly answerer?: Answerer | undefined;
  /** Names the answerer in the record. */
  readonly answererName?: string | undefined;
  /** Milliseconds since the epoch; injected so a test needs no real time. */
  readonly now: () => number;
  /** Append the score to the history. */
  readonly record: boolean;
}

/** The result of a run: this score, and the one it follows. */
export interface ScoreRun {
  readonly record: ScoreRecord;
  readonly scores: readonly CaseScore[];
  readonly previous?: ScoreRecord | undefined;
}

/** The history in the home, oldest first; a line that is not a score is ignored. */
export function readScores(home: string): readonly ScoreRecord[] {
  const file = join(home, SCORES_FILE);
  if (!existsSync(file)) return [];
  const found: ScoreRecord[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed) && typeof parsed["at"] === "number" && typeof parsed["score"] === "number" && typeof parsed["set"] === "string") {
        found.push(parsed as unknown as ScoreRecord);
      }
    } catch {
      continue;
    }
  }
  return found;
}

/** Runs every case of the set once and, when asked, records the score. */
export async function runScore(options: ScoreOptions): Promise<ScoreRun> {
  const cases = loadCases(options.casesDir);
  if (cases.length === 0) throw new CaseError(`there are no cases in ${options.casesDir}`);
  const bot = options.bot ?? "default";
  const window = options.window ?? DEFAULT_WINDOW;
  if (!Number.isInteger(window) || window < 0) throw new CaseError("the window is a whole number of messages, 0 or more");
  const answerer = options.answerer ?? recallAnswerer;

  const scratch = mkdtempSync(join(tmpdir(), "memory-score-"));
  try {
    let home = options.home;
    if (options.memory !== undefined) {
      // A given memory directory stands in for the bot's own, in a home of its own.
      home = join(scratch, "home");
      mkdirSync(join(home, "bot", bot), { recursive: true });
      cpSync(resolve(options.memory), join(home, "bot", bot, "memory"), { recursive: true });
    }
    const botDir = join(home, "bot", bot);
    const search = new MemorySearch(home, options.settings ?? {}, { file: join(scratch, "search.sqlite") });
    const scores: CaseScore[] = [];
    try {
      await search.refresh();
      const indexFile = join(botDir, "memory", "index.md");
      const index = existsSync(indexFile) ? readFileSync(indexFile, "utf8").slice(0, MEMORY_INDEX_MAX) : "";
      for (const found of cases) {
        const kept = window === 0 ? [] : found.context.slice(-window);
        const older = found.context.slice(0, found.context.length - kept.length);
        const material = recalled(search, botDir, found, older, index);
        const answer = await answerer({ question: found.question, context: kept, memory: material });
        scores.push(scoreAnswer(answer, found));
      }
    } finally {
      search.close();
    }
    const passed = scores.filter((score) => score.passed).length;
    const history = readScores(options.home);
    const set = resolve(options.casesDir);
    const previous = [...history].reverse().find((entry) => entry.set === set);
    const record: ScoreRecord = {
      at: options.now(),
      set,
      total: scores.length,
      passed,
      score: passed / scores.length,
      settings: {
        bot,
        window,
        memoryIndexMax: MEMORY_INDEX_MAX,
        answerer: options.answererName ?? "recall",
        ...(options.memory === undefined ? {} : { memory: resolve(options.memory) }),
      },
      cases: scores.map((score) => ({ id: score.id, passed: score.passed })),
    };
    if (options.record) {
      mkdirSync(options.home, { recursive: true });
      appendFileSync(join(options.home, SCORES_FILE), `${JSON.stringify(record)}\n`);
    }
    return { record, scores, ...(previous === undefined ? {} : { previous }) };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The memory index and the search hits for the question, over memory, wiki and the compacted-away messages. */
function recalled(
  search: MemorySearch,
  botDir: string,
  found: MemoryCase,
  older: readonly CaseMessage[],
  index: string,
): string {
  const id = `chat:case-${found.id}`;
  if (older.length > 0) {
    const text = chatDocument(`case-${found.id}`, found.id, older.map((message, at) => ({ id: String(at), role: message.role, text: message.text })));
    search.backend.put({
      id,
      scope: "chats",
      owner: resolve(botDir),
      directory: "",
      name: "",
      title: found.id,
      text,
      fields: {},
      lineCount: text.split("\n").length,
      digest: id,
    });
  }
  const parts = [index];
  try {
    const result = search.search({ text: found.question, cwd: botDir, limit: 5 });
    for (const hit of result.hits) {
      try {
        parts.push(search.read({ id: hit.id, from: hit.lineStart, to: hit.lineEnd }).text);
      } catch {
        parts.push(hit.snippet);
      }
    }
  } catch {
    // A question the index cannot parse finds nothing; the index above still counts.
  } finally {
    if (older.length > 0) search.backend.remove(id);
  }
  return parts.join("\n");
}

/** A run as the command prints it. */
export function scoreText(run: ScoreRun): string {
  const { record, scores, previous } = run;
  const percent = (value: number): string => `${Math.round(value * 100)}%`;
  const lines = [`memory score: ${record.passed}/${record.total} (${percent(record.score)})`];
  if (previous !== undefined) {
    const change = record.passed - previous.passed;
    const same = JSON.stringify(previous.settings) === JSON.stringify(record.settings);
    lines.push(
      `before: ${previous.passed}/${previous.total} (${percent(previous.score)}), ${change === 0 ? "no change" : `${change > 0 ? "+" : ""}${change} passed`}${same ? "" : "; the settings differ"}`,
    );
    const was = new Map(previous.cases.map((entry) => [entry.id, entry.passed]));
    for (const entry of record.cases) {
      const before = was.get(entry.id);
      if (before === true && !entry.passed) lines.push(`now fails: ${entry.id}`);
      if (before === false && entry.passed) lines.push(`now passes: ${entry.id}`);
    }
  }
  for (const score of scores) {
    if (score.passed) continue;
    const why = [
      ...score.missing.map((fact) => `missing "${fact}"`),
      ...score.repeated.map((phrase) => `states "${phrase}"`),
    ];
    lines.push(`fails: ${score.id}: ${why.join("; ")}`);
  }
  return `${lines.join("\n")}\n`;
}
