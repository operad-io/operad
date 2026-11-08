/**
 * The gate: verify a task's commit with the repository's commands, review its
 * diff with a harness step, and turn a failure into another rework pass. Both
 * steps run git here; the kernel never runs a command or a harness itself.
 */

import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { checkPlaces } from "./places.ts";
import { runCheckCommands } from "./rerun.ts";
import { recordRerunPasses } from "./reruns.ts";
import {
  ReviewGradingError,
  readReviewGrading,
  type Grading,
} from "@operad-io/review-grading";
import {
  messageOf,
  type PluginStepResult,
  type StepContext,
  type StepRunOptions,
} from "@operad-io/engine";
import {
  appendRework,
  DevError,
  isRecord,
  type PendingReviewRun,
  type ReviewFinding,
  type ReviewRecord,
  type ReviewResult,
  type ReviewRunRecord,
  type ReviewRunReason,
  type ReviewRunRole,
  type ReworkRecord,
  type TaskAttempt,
  type TaskData,
  type VerifyRecord,
  type VerifyResult,
} from "./model.ts";
import {
  assertInsideRepository,
  type DevSettings,
  type FixLevel,
  type ReviewerFallback,
  type ReviewerSettings,
} from "./settings.ts";
import { appendChange } from "./model.ts";
import {
  briefText,
  cancelledStep,
  claimAllows,
  git,
  headOf,
  isRegistered,
  saveTaskGuarded,
  taskContext,
  workBranch,
  type TaskContext,
} from "./steps.ts";
import {
  MAX_REVIEW_WAITS,
  REVIEW_WAIT_CHUNK_MS,
  STEP_TIMEOUT_SECS,
} from "./timeouts.ts";

/** The gate worktree of a task: `<worktreeRoot>/<task id>-gate`. */
export function gateWorktreePath(
  repositoryPath: string,
  settings: DevSettings,
  taskId: string,
): string {
  const path = resolve(repositoryPath, settings.worktreeRoot, `${taskId}-gate`);
  assertInsideRepository(repositoryPath, path, "worktreeRoot");
  return path;
}

interface GitZ {
  readonly ok: boolean;
  readonly out: string;
  readonly err: string;
}

function gitZ(
  cwd: string,
  args: readonly string[],
  input?: string,
): GitZ {
  const result = Bun.spawnSync({
    cmd: ["git", "-C", cwd, ...args],
    stdin: input === undefined ? "ignore" : new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    ok: result.exitCode === 0,
    out: result.stdout.toString(),
    err: result.stderr.toString().trim(),
  };
}

/** The commit a task's branch points at, local first and then the remote. */
export function branchHead(
  repositoryPath: string,
  settings: DevSettings,
  taskId: string,
): string | undefined {
  const branch = workBranch(taskId);
  const local = git(repositoryPath, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${branch}^{commit}`,
  ]);
  if (local.ok && local.out.length > 0) return local.out;
  const remote = git(repositoryPath, [
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/remotes/${settings.remote}/${branch}^{commit}`,
  ]);
  return remote.ok && remote.out.length > 0 ? remote.out : undefined;
}

/** The commit the task branched from: the merge base of main and the commit. */
function mergeBase(
  repositoryPath: string,
  settings: DevSettings,
  sha: string,
): string | undefined {
  const main = `${settings.remote}/${settings.mainBranch}`;
  const result = git(repositoryPath, ["merge-base", main, sha]);
  return result.ok && result.out.length > 0 ? result.out : undefined;
}

/** Removes whatever is at the gate path and checks a commit out detached. */
export function recreateGateWorktree(
  repositoryPath: string,
  path: string,
  sha: string,
): string | undefined {
  if (existsSync(path)) {
    if (isRegistered(repositoryPath, path)) {
      const removed = git(repositoryPath, [
        "worktree",
        "remove",
        "--force",
        path,
      ]);
      if (!removed.ok) {
        rmSync(path, { recursive: true, force: true });
        git(repositoryPath, ["worktree", "prune"]);
      }
    } else {
      rmSync(path, { recursive: true, force: true });
    }
  }
  git(repositoryPath, ["worktree", "prune"]);
  mkdirSync(dirname(path), { recursive: true });
  const add = git(repositoryPath, [
    "worktree",
    "add",
    "--detach",
    path,
    sha,
  ]);
  if (add.ok) return undefined;
  return `cannot check out ${sha} at ${path}: ${add.err || add.out}`;
}

function stepOptions(
  ctx: StepContext,
  cwd: string,
): StepRunOptions {
  return {
    runId: ctx.runId,
    cwd,
    ...(ctx.object === undefined ? {} : { object: ctx.object }),
    params: ctx.params,
    access: ctx.access,
    ...(ctx.trigger === undefined ? {} : { trigger: ctx.trigger }),
    signal: ctx.signal,
  };
}

function attemptOf(ctx: StepContext, task: TaskData): TaskAttempt {
  return (
    task.attempt ?? {
      number: Math.max(task.attempts, 0) + 1,
      run: ctx.runId,
    }
  );
}

function verifyData(record: VerifyRecord, extra: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return { ...record, ...extra };
}

function recordVerify(
  attempt: TaskAttempt,
  record: VerifyRecord,
): TaskAttempt {
  return { ...attempt, verify: record };
}

/** Step `dev/verify`: run the gate commands on the task's branch head. */
export async function runVerify(
  ctx: StepContext,
): Promise<PluginStepResult> {
  const context = await taskContext(ctx);
  if (!claimAllows(ctx, context.task)) return cancelledStep();
  const task = context.task;
  const attempt = attemptOf(ctx, task);
  const previous = attempt.verify;
  // A replay of the same run reads the result it already recorded; the branch
  // may have moved since, and the verified sha must be the one review sees.
  if (
    previous !== undefined &&
    previous !== null &&
    previous.run === ctx.runId
  ) {
    return {
      result: previous.result,
      data: verifyData(previous, {
        attempt: attempt.number,
        verified: attempt.verified ?? null,
        replayed: true,
      }),
    };
  }

  git(context.repository.path, [
    "fetch",
    "--prune",
    context.settings.remote,
  ]);
  const sha = branchHead(
    context.repository.path,
    context.settings,
    context.taskId,
  );
  const path = gateWorktreePath(
    context.repository.path,
    context.settings,
    context.taskId,
  );

  const failed = async (
    message: string,
    extra: Readonly<Record<string, unknown>> = {},
  ): Promise<PluginStepResult> => {
    const record: VerifyRecord = {
      result: "fail",
      run: ctx.runId,
      message,
    };
    const written = await saveTaskGuarded(
      ctx,
      context.taskKey,
      {
        ...task,
        phase: "review",
        run: ctx.runId,
        attempts: Math.max(task.attempts, attempt.number),
        attempt: recordVerify(
          { ...attempt, run: ctx.runId, verified: sha ?? null },
          record,
        ),
      },
      "dev:verify",
    );
    if (!written) return cancelledStep();
    return {
      result: "fail",
      data: verifyData(record, {
        attempt: attempt.number,
        verified: sha ?? null,
        worktree: path,
        ...extra,
      }),
    };
  };

  if (sha === undefined) {
    return failed(
      `no branch "${workBranch(context.taskId)}" or "${context.settings.remote}/${workBranch(context.taskId)}" to verify`,
    );
  }
  const prepared = recreateGateWorktree(context.repository.path, path, sha);
  if (prepared !== undefined) return failed(prepared, { sha, verified: sha });

  const commands = context.settings.gate.commands;
  const runStep = ctx.runStep;
  if (runStep === undefined) {
    return failed(
      "the kernel did not offer a way to run the gate commands",
      { sha, verified: sha },
    );
  }

  const checked = await runCheckCommands(
    runStep,
    { cwd: path, timeoutSecs: context.settings.gate.commandTimeoutSecs },
    commands,
    stepOptions(ctx, path),
    context.settings.check.rerun,
    checkPlaces(ctx),
  );
  await recordRerunPasses(ctx.store, checked.passedOnRerun);
  const { outcome, hostError, note } = checked;

  const outcomeData =
    outcome !== undefined && isRecord(outcome.data) ? outcome.data : {};
  const result: VerifyResult =
    hostError === undefined && outcome?.result === "pass" ? "pass" : "fail";
  const command =
    typeof outcomeData.line === "string" ? outcomeData.line : undefined;
  const log = typeof outcomeData.log === "string" ? outcomeData.log : undefined;
  const message =
    hostError ??
    (typeof outcomeData.message === "string" ? outcomeData.message : undefined) ??
    (result === "fail"
      ? `the gate commands failed (${outcome?.result ?? "unknown"})`
      : undefined);
  const lineNumber =
    typeof outcomeData.lineNumber === "number"
      ? outcomeData.lineNumber
      : undefined;

  const record: VerifyRecord = {
    result,
    run: ctx.runId,
    ...(command === undefined ? {} : { command }),
    ...(log === undefined ? {} : { log }),
    ...(message === undefined ? {} : { message }),
    ...(lineNumber === undefined ? {} : { lineNumber }),
  };
  const nextAttempt: TaskAttempt = {
    ...recordVerify(attempt, record),
    run: ctx.runId,
    verified: sha,
  };
  const written = await saveTaskGuarded(
    ctx,
    context.taskKey,
    {
      ...task,
      phase: "review",
      run: ctx.runId,
      attempts: Math.max(task.attempts, attempt.number),
      attempt: nextAttempt,
      ...(note === undefined
        ? {}
        : { brief: appendChange(task.brief, note) }),
    },
    "dev:verify",
  );
  if (!written) return cancelledStep();
  return {
    result,
    data: verifyData(record, {
      ...(note === undefined ? {} : { note }),
      ...(checked.rerun ? { rerun: true } : {}),
      attempt: attempt.number,
      verified: sha,
      worktree: path,
      ...(outcomeData.tail === undefined ? {} : { tail: outcomeData.tail }),
    }),
  };
}

interface FileDiff {
  readonly path: string;
  readonly added: number;
  readonly removed: number;
  /** The patch as text, used for its size and its content when included. */
  readonly patch: string;
  readonly bytes: number;
  /** Why the file is left out of the prompt, or undefined when it is in it. */
  readonly leftOut: string | undefined;
  readonly binary: boolean;
}

interface Attributes {
  readonly vendored: boolean;
  readonly generated: boolean;
  readonly diffable: boolean;
  readonly binary: boolean;
}

const NO_ATTRIBUTES: Attributes = {
  vendored: false,
  generated: false,
  diffable: true,
  binary: false,
};

/** Reads the attributes that decide whether a file belongs in a review diff. */
function attributesOf(
  repositoryPath: string,
  paths: readonly string[],
): ReadonlyMap<string, Attributes> {
  const map = new Map<string, Attributes>();
  if (paths.length === 0) return map;
  const result = gitZ(
    repositoryPath,
    [
      "check-attr",
      "--stdin",
      "-z",
      "linguist-vendored",
      "linguist-generated",
      "diff",
      "binary",
    ],
    `${paths.join("\0")}\0`,
  );
  if (!result.ok) return map;
  const parts = result.out.split("\0");
  for (let index = 0; index + 2 < parts.length; index += 3) {
    const path = parts[index] ?? "";
    const attribute = parts[index + 1] ?? "";
    const value = parts[index + 2] ?? "";
    const current = map.get(path) ?? NO_ATTRIBUTES;
    const set = value !== "unspecified" && value !== "unset";
    if (attribute === "linguist-vendored") {
      map.set(path, { ...current, vendored: set });
    } else if (attribute === "linguist-generated") {
      map.set(path, { ...current, generated: set });
    } else if (attribute === "diff") {
      map.set(path, {
        ...current,
        diffable: value !== "unset" && value !== "binary",
      });
    } else if (attribute === "binary") {
      map.set(path, { ...current, binary: set });
    }
  }
  return map;
}

/** How a file changed, from `git diff --name-status`. */
interface Change {
  readonly status: "added" | "deleted" | "renamed" | "other";
  /** The old path of a renamed file. */
  readonly from: string | undefined;
}

/** The status of every changed file, keyed by its new path. */
function changesOf(
  repositoryPath: string,
  base: string,
  sha: string,
): ReadonlyMap<string, Change> {
  const map = new Map<string, Change>();
  const result = gitZ(repositoryPath, [
    "diff",
    "--name-status",
    "-M",
    "-z",
    base,
    sha,
  ]);
  if (!result.ok) return map;
  const parts = result.out.split("\0");
  for (let index = 0; index < parts.length; ) {
    const status = parts[index] ?? "";
    if (status.length === 0) {
      index += 1;
      continue;
    }
    if (status.startsWith("R") || status.startsWith("C")) {
      const from = parts[index + 1] ?? "";
      const to = parts[index + 2] ?? "";
      map.set(to, {
        status: status.startsWith("R") ? "renamed" : "other",
        from,
      });
      index += 3;
      continue;
    }
    const path = parts[index + 1] ?? "";
    map.set(path, {
      status: status === "D" ? "deleted" : status === "A" ? "added" : "other",
      from: undefined,
    });
    index += 2;
  }
  return map;
}

/**
 * The changed files with line counts and what the prompt carries for each. A
 * renamed file carries only its edits (one line when it has none); a deleted
 * file carries one line, not its removed lines. The reviewer reads a deleted
 * file with `git show <base>:<path>`.
 */
function diffsOf(
  repositoryPath: string,
  base: string,
  sha: string,
): readonly FileDiff[] {
  const numstat = gitZ(repositoryPath, [
    "diff",
    "--numstat",
    "-M",
    "-z",
    base,
    sha,
  ]);
  if (!numstat.ok) return [];
  const changes = changesOf(repositoryPath, base, sha);
  const files: FileDiff[] = [];
  const parts = numstat.out.split("\0");
  for (let index = 0; index < parts.length; index += 1) {
    const record = parts[index] ?? "";
    if (record.length === 0) continue;
    const first = record.indexOf("\t");
    const second = record.indexOf("\t", first + 1);
    if (first < 0 || second < 0) continue;
    const addedText = record.slice(0, first);
    const removedText = record.slice(first + 1, second);
    let path = record.slice(second + 1);
    let from: string | undefined;
    if (path.length === 0) {
      // A rename: the two paths follow as records of their own.
      from = parts[index + 1] ?? "";
      path = parts[index + 2] ?? "";
      index += 2;
    }
    if (path.length === 0) continue;
    const binary = addedText === "-" || removedText === "-";
    const added = binary ? 0 : Number(addedText) || 0;
    const removed = binary ? 0 : Number(removedText) || 0;
    const change = changes.get(path);
    let patch = "";
    if (binary) {
      patch = "";
    } else if (from !== undefined && added === 0 && removed === 0) {
      patch = `renamed ${from} → ${path}, unchanged\n`;
    } else if (change?.status === "deleted") {
      patch = `${path}: deleted, ${removed} lines (read it with \`git show ${base}:${path}\`)\n`;
    } else {
      patch = git(repositoryPath, [
        "diff",
        "--no-color",
        "--no-ext-diff",
        "-M",
        base,
        sha,
        "--",
        ...(from === undefined ? [path] : [from, path]),
      ]).out;
    }
    files.push({
      path,
      added,
      removed,
      patch,
      bytes: Buffer.byteLength(patch, "utf8"),
      leftOut: undefined,
      binary,
    });
  }
  return files;
}

interface PreparedDiff {
  readonly files: readonly FileDiff[];
  /** The files that go into the prompt, in path order. */
  readonly included: readonly FileDiff[];
  /** The files left out, with the reason, in path order. */
  readonly leftOut: readonly FileDiff[];
  /** The bytes of every diff the review could carry, not only the included ones. */
  readonly bytes: number;
  /** The bytes of the diff text that goes into the prompt. */
  readonly includedBytes: number;
}

function reasonFor(
  attributes: Attributes,
  diff: FileDiff,
  maxFileDiffBytes: number,
): string | undefined {
  if (attributes.vendored) return "vendored";
  if (attributes.generated) return "generated";
  if (attributes.binary || diff.binary) return "binary";
  if (!attributes.diffable) return "not diffable";
  if (diff.bytes > maxFileDiffBytes) return "too large";
  return undefined;
}

/** True when a file is left out because of an attribute, not its size. */
function excludedByAttribute(
  attributes: Attributes,
  diff: FileDiff,
): boolean {
  return (
    attributes.vendored ||
    attributes.generated ||
    attributes.binary ||
    diff.binary ||
    !attributes.diffable
  );
}

/**
 * Prepares the diff for a review prompt. Vendored and non-diffable files never
 * enter the prompt, and neither does a file whose own diff is over the limit;
 * every one of them is listed so the reviewer knows it exists.
 */
export function normalizePath(path: string): string {
  return path.startsWith("./") ? path.slice(2) : path;
}

function prepareDiff(
  repositoryPath: string,
  base: string,
  sha: string,
  reviewer: ReviewerSettings,
  attributesCwd: string = repositoryPath,
): PreparedDiff {
  const diffs = diffsOf(repositoryPath, base, sha);
  const attributes = attributesOf(
    attributesCwd,
    diffs.map((diff) => diff.path),
  );
  const files = diffs.map((diff) => {
    const reason = reasonFor(
      attributes.get(diff.path) ?? NO_ATTRIBUTES,
      diff,
      reviewer.maxFileDiffBytes,
    );
    return { ...diff, leftOut: reason };
  });
  // The size check counts every file that is not vendored or not diffable:
  // leaving a huge real-code file out of the prompt must not hide it.
  const bytes = files
    .filter(
      (file) =>
        !excludedByAttribute(
          attributes.get(file.path) ?? NO_ATTRIBUTES,
          file,
        ),
    )
    .reduce((sum, file) => sum + file.bytes, 0);
  const included = files.filter((file) => file.leftOut === undefined);
  const leftOut = files.filter((file) => file.leftOut !== undefined);
  return {
    files,
    included,
    leftOut,
    bytes,
    includedBytes: included.reduce((sum, file) => sum + file.bytes, 0),
  };
}

/** The line that tells the reviewer a file was left out and why. */
export function leftOutLine(file: FileDiff): string {
  return `- ${file.path} (+${file.added}/-${file.removed}) — ${file.leftOut ?? "left out"}`;
}

function severityRank(severity: string): number {
  if (severity === "critical") return 3;
  if (severity === "major") return 2;
  if (severity === "minor") return 1;
  return 0;
}

function levelRank(level: FixLevel): number {
  return severityRank(level);
}

function atOrAbove(severity: string, level: FixLevel): boolean {
  return severityRank(severity) >= levelRank(level);
}

interface FindingShape {
  readonly file: string;
  readonly line: number;
  readonly severity: string;
  readonly summary: string;
  readonly trigger: string;
}

function parseFinding(value: unknown): FindingShape | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.file !== "string" || value.file.length === 0) return undefined;
  const severity = value.severity;
  if (
    severity !== "critical" &&
    severity !== "major" &&
    severity !== "minor"
  ) {
    return undefined;
  }
  // Every field the prompt asks for is required: a finding without them is a
  // malformed report, and the step retries instead of recording a blank one.
  const line = value.line;
  if (typeof line !== "number" || !Number.isFinite(line)) return undefined;
  if (typeof value.summary !== "string") return undefined;
  if (typeof value.trigger !== "string") return undefined;
  return {
    file: value.file,
    line,
    severity,
    summary: value.summary,
    trigger: value.trigger,
  };
}

interface Report {
  readonly findings: readonly FindingShape[];
  readonly verified: readonly string[];
}

function parseReport(text: string): Report | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if (!Array.isArray(value.findings)) return undefined;
  if (!Array.isArray(value.verified)) return undefined;
  if (!value.verified.every((item) => typeof item === "string")) return undefined;
  const findings: FindingShape[] = [];
  for (const item of value.findings) {
    const finding = parseFinding(item);
    if (finding === undefined) return undefined;
    findings.push(finding);
  }
  return {
    findings,
    verified: value.verified as readonly string[],
  };
}

/** The flow whose grading the review reads; the dev plugin has one. */
const REVIEW_FLOW = "dev";

/**
 * The repository's grading for this flow. An invalid review.json fails the
 * step the way an invalid dev.json does.
 */
function gradingOf(context: TaskContext): Grading {
  try {
    return readReviewGrading(context.repository.path, REVIEW_FLOW);
  } catch (error) {
    if (error instanceof ReviewGradingError) {
      throw new DevError(
        "review.json",
        error.message.slice("review.json: ".length),
      );
    }
    throw error;
  }
}

/** The context with review.json's fixLevel, when set, over dev.json's. */
function gradedContext(context: TaskContext): {
  readonly context: TaskContext;
  readonly grading: Grading;
} {
  const grading = gradingOf(context);
  if (grading.fixLevel === undefined) return { context, grading };
  return {
    grading,
    context: {
      ...context,
      settings: {
        ...context.settings,
        reviewer: { ...context.settings.reviewer, fixLevel: grading.fixLevel },
      },
    },
  };
}

/** The "## Grading" section's lines: the levels and rules, verbatim. */
function gradingLines(grading: Grading): string[] {
  const lines: string[] = [];
  for (const level of ["critical", "major", "minor"] as const) {
    const text = grading.levels?.[level];
    if (text !== undefined) lines.push(`- ${level}: ${text}`);
  }
  for (const rule of grading.rules ?? []) lines.push(`- ${rule}`);
  return lines;
}

function reviewPrompt(
  task: TaskData,
  sha: string,
  base: string,
  prepared: PreparedDiff,
  resultPath: string,
  grading: Grading,
): string {
  const pieces: string[] = [
    `Review the changes of task ${task.title}.`,
    "## Brief",
    briefText(task).trim(),
  ];
  const graded = gradingLines(grading);
  if (graded.length > 0) pieces.push("## Grading", graded.join("\n"));
  if (prepared.included.length === 0) {
    pieces.push("## Diff", "The change has no diff to review.");
  } else {
    pieces.push(
      "## Diff",
      `The diff from the merge base ${base} to the verified commit ${sha}:`,
      prepared.included.map((file) => file.patch).join(""),
    );
  }
  if (prepared.leftOut.length > 0) {
    pieces.push(
      "## Files left out of the diff",
      "These files changed but their content is not in the diff:",
      prepared.leftOut.map(leftOutLine).join("\n"),
    );
  }
  pieces.push(
    "## What to write",
    [
      `Write a JSON object to ${resultPath} (inside the worktree you are in). The file must contain exactly:`,
      '{ "findings": [{ "file": "<path>", "line": <number>, "severity": "critical|major|minor", "summary": "<one line>", "trigger": "<what causes it>" }], "verified": ["<what you checked>"] }',
      "A finding on a file the change did not touch is pre-existing; say so in its summary.",
      "Write only the JSON file. Do not change anything else in the worktree.",
    ].join("\n"),
  );
  return pieces.join("\n\n");
}

/** What one call to a reviewer harness step produced. */
interface ReviewerCall {
  readonly outcome:
    | "report"
    | "invalid"
    | "no_report"
    | "unavailable"
    | "timed_out"
    | "failed";
  readonly report?: Report | undefined;
  readonly message: string;
}

/** The largest review report the gate reads; anything bigger is not a report. */
const MAX_REPORT_BYTES = 1_000_000;

interface ReportRead {
  readonly text?: string;
  readonly message?: string;
}

/**
 * Reads a reviewer report without trusting the path. The reviewer owns the
 * gate worktree and can leave a FIFO or a link at the report path; the file is
 * opened non-blocking without following a link, and the descriptor must still
 * be a bounded regular file before anything is read.
 */
function readReport(
  resultPath: string,
  guard?: () => string | undefined,
): ReportRead {
  const before = guard?.();
  if (guard !== undefined && before === undefined) {
    return { message: `the review folders of ${resultPath} are not plain directories` };
  }
  let details;
  try {
    details = lstatSync(resultPath);
  } catch {
    return { message: `the reviewer wrote no report at ${resultPath}` };
  }
  if (!details.isFile()) {
    return {
      message: `the review report at ${resultPath} is not a regular file`,
    };
  }
  if (details.size > MAX_REPORT_BYTES) {
    return {
      message: `the review report at ${resultPath} is over ${MAX_REPORT_BYTES} bytes`,
    };
  }
  let fd: number;
  try {
    fd = openSync(
      resultPath,
      fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW,
    );
  } catch (error) {
    return { message: `cannot read ${resultPath}: ${String(error)}` };
  }
  try {
    // The path may have changed between `lstat` and `open`; the descriptor is
    // what is read, so a swap to a FIFO is caught here and cannot block.
    const opened = fstatSync(fd);
    if (!opened.isFile()) {
      return {
        message: `the review report at ${resultPath} is not a regular file`,
      };
    }
    if (opened.size > MAX_REPORT_BYTES) {
      return {
        message: `the review report at ${resultPath} is over ${MAX_REPORT_BYTES} bytes`,
      };
    }
    const buffer = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < buffer.length) {
      let count: number;
      try {
        count = readSync(fd, buffer, offset, buffer.length - offset, offset);
      } catch (error) {
        return { message: `cannot read ${resultPath}: ${String(error)}` };
      }
      if (count === 0) break;
      offset += count;
    }
    if (guard !== undefined) {
      reviewTestHooks.afterOpen?.();
      // The folders above the file may have been swapped for a link while it
      // was open: they must still be plain directories and the path must
      // still lead to the very file that was read.
      // The folders are looked at before and after the path is, and all
      // three looks must agree on the same plain directories.
      const mid = guard();
      reviewTestHooks.betweenChecks?.("before-stat");
      const after = lstatOrUndefined(resultPath);
      reviewTestHooks.betweenChecks?.("after-stat");
      const end = guard();
      if (
        mid === undefined ||
        mid !== before ||
        end !== before ||
        after === undefined ||
        !after.isFile() ||
        after.ino !== opened.ino ||
        after.dev !== opened.dev
      ) {
        return {
          message: `the review report at ${resultPath} changed while it was read`,
        };
      }
    }
    return { text: buffer.subarray(0, offset).toString("utf8") };
  } finally {
    closeSync(fd);
  }
}

/** The model a harness step names, or its step name when it names none. */
function modelOf(use: string, args: readonly string[]): string {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--model") {
      const value = args[index + 1];
      return typeof value === "string" && value.length > 0 ? value : use;
    }
    if (arg.startsWith("--model=")) {
      const value = arg.slice("--model=".length);
      return value.length > 0 ? value : use;
    }
  }
  return use;
}

/** The `kind` of the `modelError` a harness reports, when it reports one. */
function modelErrorKind(data: Record<string, unknown>): string | undefined {
  const value = data.modelError;
  if (isRecord(value) && typeof value.kind === "string") return value.kind;
  return undefined;
}

/** What a provider prints when it refuses a request for rate or load. */
const UNAVAILABLE_STDERR =
  /\b(?:HTTP|status(?: code)?)[ :=]+429\b|\btoo many requests\b/i;

/** True when the tail of the harness's own error output names a 429. */
function stderrSaysUnavailable(data: Record<string, unknown>): boolean {
  const tail = data.stderr;
  if (!Array.isArray(tail)) return false;
  return tail.some(
    (line) => typeof line === "string" && UNAVAILABLE_STDERR.test(line),
  );
}

/**
 * Why a reviewer run failed: unavailable, timed out, or anything else. Only
 * the harness's `modelError` (and, when a harness reports none, an anchored
 * phrase in the tail of its error output) says unavailable; a number or a
 * word elsewhere in the data never does.
 */
function failureOutcome(
  data: Record<string, unknown>,
  _message: string,
): "unavailable" | "timed_out" | "failed" {
  const kind = modelErrorKind(data);
  if (kind === "unavailable" || kind === "usage_limit") return "unavailable";
  const reason = typeof data.reason === "string" ? data.reason : undefined;
  if (reason === "wall" || reason === "stall" || reason === "timeout") {
    return "timed_out";
  }
  if (stderrSaysUnavailable(data)) return "unavailable";
  return "failed";
}

/** Where one reviewer call leaves its outcome beside the report it wrote. */
function reviewOutcomePath(resultPath: string): string {
  return resultPath.endsWith(".json")
    ? `${resultPath.slice(0, -".json".length)}.run.json`
    : `${resultPath}.run.json`;
}

function writeReviewOutcome(path: string, call: ReviewerCall): void {
  try {
    writeFileSync(
      path,
      JSON.stringify({
        outcome: call.outcome,
        message: call.message,
        ...(call.report === undefined ? {} : { report: call.report }),
      }),
    );
  } catch {
    // A sidecar that cannot be written only costs one repeated run after a
    // crash; the review itself still continues.
  }
}

const REVIEW_OUTCOMES: readonly ReviewerCall["outcome"][] = [
  "report",
  "invalid",
  "no_report",
  "unavailable",
  "timed_out",
  "failed",
];

/** The call a crashed review recorded, or undefined when it never answered. */
function readReviewOutcome(resultPath: string): ReviewerCall | undefined {
  const read = readReport(reviewOutcomePath(resultPath));
  if (read.text === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(read.text);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const outcome = value.outcome;
  if (
    typeof outcome !== "string" ||
    !REVIEW_OUTCOMES.includes(outcome as ReviewerCall["outcome"])
  ) {
    return undefined;
  }
  const message = typeof value.message === "string" ? value.message : "";
  if (outcome !== "report") {
    return { outcome: outcome as ReviewerCall["outcome"], message };
  }
  const report = parseReport(JSON.stringify(value.report));
  if (report === undefined) return undefined;
  return { outcome: "report", report, message };
}

/** The report path of one reviewer call, relative to the gate worktree. */
function workspaceReportPath(
  gatePath: string,
  runId: string,
  attempt: number,
  round: number,
  tryNo: number,
): string {
  return join(
    gatePath,
    ".operad",
    "review",
    `${runId}-attempt-${attempt}-review-${round}-try-${tryNo}.json`,
  );
}

/**
 * Makes sure `.operad/review` exists in the gate worktree as plain
 * directories, looking at every component with `lstat` and never following a
 * link. Returns the reason when it cannot, so no report is written there. It
 * creates folders and removes nothing.
 */
function prepareReportFolder(
  gatePath: string,
  create = true,
): string | undefined {
  let folder = gatePath;
  for (const name of [".operad", "review"]) {
    folder = join(folder, name);
    let details = lstatOrUndefined(folder);
    if (details === undefined && create) {
      try {
        mkdirSync(folder);
      } catch {
        // Another process may have made it; look again below.
      }
      details = lstatOrUndefined(folder);
    }
    // Checking only: a folder that is not there holds no report to follow.
    if (details === undefined) return create ? `cannot create ${folder}` : undefined;
    if (!details.isDirectory()) {
      return `${folder} is not a plain directory (a link or a file), so the review report cannot be written under it`;
    }
  }
  return undefined;
}

/**
 * The identity of `.operad` and `.operad/review` when both exist as plain
 * directories, otherwise undefined. Two equal identities mean the same
 * directories were there both times.
 */
function folderIdentity(gatePath: string): string | undefined {
  const parts: string[] = [];
  let folder = gatePath;
  for (const name of [".operad", "review"]) {
    folder = join(folder, name);
    const details = lstatOrUndefined(folder);
    if (details === undefined || !details.isDirectory()) return undefined;
    parts.push(`${details.dev}:${details.ino}`);
  }
  return parts.join("/");
}

function lstatOrUndefined(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

/** The valid report at a path with its text, otherwise undefined. */
function readValidReportText(
  path: string,
  gatePath: string,
): { readonly report: Report; readonly text: string } | undefined {
  const read = readReport(
    path,
    () => folderIdentity(gatePath),
  );
  if (read.text === undefined) return undefined;
  const report = parseReport(read.text);
  return report === undefined ? undefined : { report, text: read.text };
}

/** Copies a valid report to the store record. Returns the failure, if any. */
function copyToStore(storePath: string, text: string): string | undefined {
  try {
    reviewTestHooks.beforeCopy?.();
    writeFileSync(storePath, text);
    return undefined;
  } catch (error) {
    return `cannot write the review record at ${storePath}: ${messageOf(error)} (the report is still in the review workspace)`;
  }
}

/**
 * One call to the reviewer, with its outcome written to disk before it
 * returns. A crash after the model answered therefore reads the outcome back
 * instead of asking the same model again.
 */
async function callReviewer(
  ctx: StepContext,
  context: TaskContext,
  gatePath: string,
  prompt: string,
  reportPath: string,
  storePath: string,
  reviewer: { readonly use: string; readonly args: readonly string[] },
  resuming: boolean,
): Promise<ReviewerCall> {
  const call = await callReviewerOnce(
    ctx,
    context,
    gatePath,
    prompt,
    reportPath,
    storePath,
    reviewer,
    resuming,
  );
  writeReviewOutcome(reviewOutcomePath(storePath), call);
  return call;
}

/** The reviewer's last words, from what its harness step reported. */
function lastMessageOf(outcome: PluginStepResult): string {
  const data = isRecord(outcome.data) ? outcome.data : {};
  if (typeof data.finalMessage === "string") return data.finalMessage;
  if (typeof data.message === "string") return data.message;
  return "";
}

async function callReviewerOnce(
  ctx: StepContext,
  context: TaskContext,
  gatePath: string,
  prompt: string,
  reportPath: string,
  storePath: string,
  reviewer: { readonly use: string; readonly args: readonly string[] },
  resuming: boolean,
): Promise<ReviewerCall> {
  const runStep = ctx.runStep;
  if (runStep === undefined) {
    return {
      outcome: "failed",
      message: "the kernel did not offer a way to run the reviewer",
    };
  }
  const settings = context.settings.reviewer;
  if (resuming && prepareReportFolder(gatePath, false) === undefined) {
    // A valid report already on disk is the answer: a crash between the
    // report and its recorded outcome must not ask the model again. The
    // workspace path comes first; a run whose older prompt named the store
    // path left its report there.
    const inWorkspace = readValidReportText(reportPath, gatePath);
    if (inWorkspace !== undefined) {
      const failure = copyToStore(storePath, inWorkspace.text);
      if (failure !== undefined) return { outcome: "failed", message: failure };
      return { outcome: "report", report: inWorkspace.report, message: "" };
    }
    if (lstatOrUndefined(reportPath) === undefined) {
      const inStore = readValidReport(storePath);
      if (inStore !== undefined) {
        return { outcome: "report", report: inStore, message: "" };
      }
    }
  }
  // The store copy and its sidecar belong to dev; the review workspace is
  // never cleaned.
  for (const stale of [storePath, reviewOutcomePath(storePath)]) {
    try {
      rmSync(stale, { force: true });
    } catch {
      // A record that cannot be removed is overwritten when a report is copied.
    }
  }
  const folderFailure = prepareReportFolder(gatePath);
  if (folderFailure !== undefined) {
    return { outcome: "failed", message: folderFailure };
  }
  if (lstatOrUndefined(reportPath) !== undefined) {
    return {
      outcome: "failed",
      message: `a file already exists at the report path ${reportPath}; it is left as it is and no report is written there`,
    };
  }
  let outcome: PluginStepResult | undefined;
  let thrown: string | undefined;
  try {
    outcome = await runStep(
      reviewer.use,
      {
        prompt,
        cwd: gatePath,
        args: reviewer.args,
        wallTimeSecs: settings.timeoutSecs,
        ...(settings.stallSecs === undefined
          ? {}
          : { stallSecs: settings.stallSecs }),
        resultPath: reportPath,
      },
      stepOptions(ctx, gatePath),
    );
  } catch (error) {
    thrown = messageOf(error);
  }
  // The reviewer owned the worktree during the call and may have swapped a
  // folder for a link: look at the folders again before reading through them.
  const swapped = prepareReportFolder(gatePath, false);
  if (swapped !== undefined) return { outcome: "failed", message: swapped };
  // The report is read before the outcome is judged: a reviewer that wrote a
  // valid report and then stalled, timed out or exited non-zero still reviewed.
  const written = readValidReportText(reportPath, gatePath);
  if (written !== undefined) {
    const failure = copyToStore(storePath, written.text);
    if (failure !== undefined) return { outcome: "failed", message: failure };
    return { outcome: "report", report: written.report, message: "" };
  }
  if (outcome === undefined) {
    const message = thrown ?? "the reviewer did not run";
    return { outcome: failureOutcome({}, message), message };
  }
  if (outcome.result !== "done") {
    const data = isRecord(outcome.data) ? outcome.data : {};
    const message =
      typeof data.message === "string"
        ? data.message
        : `the reviewer ended "${outcome.result}"`;
    // No file at the path: a failed run is "could not write the report".
    const missing = lstatOrUndefined(reportPath) === undefined;
    const last = lastMessageOf(outcome);
    const kind = failureOutcome(data, message);
    // A timeout keeps its own retry rule; its history still says the report
    // could not be written, with the reviewer's last words.
    const full =
      missing && kind === "timed_out"
        ? `could not write the report${last.length === 0 ? "" : ` (last message: ${last})`}`
        : missing && last.length > 0
          ? last
          : message;
    return {
      outcome: missing && kind === "failed" ? "no_report" : kind,
      message: full,
    };
  }
  if (lstatOrUndefined(reportPath) === undefined) {
    return { outcome: "no_report", message: lastMessageOf(outcome) };
  }
  const read = readReport(reportPath);
  if (read.text === undefined) {
    return {
      outcome: "invalid",
      message: read.message ?? `cannot read ${reportPath}`,
    };
  }
  return {
    outcome: "invalid",
    message: `the review report at ${reportPath} is not the expected JSON`,
  };
}

/** The report at a path when it reads and parses, otherwise undefined. */
function readValidReport(resultPath: string): Report | undefined {
  const read = readReport(resultPath);
  if (read.text === undefined) return undefined;
  return parseReport(read.text);
}

function reviewData(
  result: string,
  sha: string,
  extra: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return { result, sha, ...extra };
}

/** The step result a finished review record stands for. */
function stepResultOf(record: ReviewRecord): string {
  if (record.reason === "exhausted") return "exhausted";
  if (record.reason === "out_of_time") return "out_of_time";
  if (record.decision === "passed") return "pass";
  if (record.decision === "findings") return "fail";
  if (record.decision === "unavailable") return "unavailable";
  if (record.decision === "timed_out") return "timed_out";
  if (record.result === "pass" || record.result === "passed") return "pass";
  if (record.result === "fail" || record.result === "findings") return "fail";
  return "failed";
}

/** A review step that runs again after a crash reads the round it recorded. */
function replayReview(
  record: ReviewRecord,
  attempt: TaskAttempt,
): PluginStepResult {
  const stepResult = stepResultOf(record);
  return {
    result: stepResult,
    data: reviewData(stepResult, record.sha ?? "", {
      attempt: attempt.number,
      ...(record.decision === undefined || record.decision === null
        ? {}
        : { decision: record.decision }),
      ...(record.round === undefined || record.round === null
        ? {}
        : { round: record.round }),
      ...(record.model === undefined || record.model === null
        ? {}
        : { model: record.model }),
      ...(record.retryAt === undefined || record.retryAt === null
        ? {}
        : { retryAt: record.retryAt }),
      ...(record.runs === undefined ? {} : { runs: record.runs }),
      ...(record.findings === undefined ? {} : { findings: record.findings }),
      ...(record.verified === undefined ? {} : { verified: record.verified }),
      ...(record.message === undefined || record.message === null
        ? {}
        : { message: record.message }),
      replayed: true,
    }),
  };
}

interface ReviewAction {
  readonly role: ReviewRunRole;
  readonly reason: ReviewRunReason;
}

type ReviewNext =
  | ReviewAction
  | "done"
  | "wait-unavailable"
  | "wait-timed-out"
  | "wait-exhausted"
  | "out-of-time"
  | "failed";

/**
 * What the next run of a review round is. A report ends the round; an
 * unavailable primary goes to the fallback once; a timeout is retried once on
 * the same model; an invalid report is retried once. Every other state ends
 * the round for a person or for a wait.
 */
function nextReviewAction(
  runs: readonly ReviewRunRecord[],
  fallback: ReviewerFallback | undefined,
): ReviewNext {
  const last = runs[runs.length - 1];
  if (last === undefined) return { role: "primary", reason: "initial" };
  switch (last.outcome) {
    case "report":
      return "done";
    case "unavailable":
      // A round uses its fallback exactly once, even when it runs again after
      // `retryAt`: a later primary failure waits instead of trying it again.
      if (
        last.role === "primary" &&
        fallback !== undefined &&
        !runs.some((run) => run.role === "fallback")
      ) {
        return { role: "fallback", reason: "fallback" };
      }
      return "wait-unavailable";
    case "timed_out": {
      const before = runs[runs.length - 2];
      if (
        before !== undefined &&
        before.outcome === "timed_out" &&
        before.role === last.role
      ) {
        return "wait-timed-out";
      }
      return { role: last.role, reason: "retry" };
    }
    case "invalid":
    case "no_report": {
      const before = runs[runs.length - 2];
      if (
        before !== undefined &&
        (before.outcome === "invalid" || before.outcome === "no_report") &&
        before.role === last.role
      ) {
        return "failed";
      }
      return { role: last.role, reason: "retry" };
    }
    case "failed":
      return "failed";
  }
}

/** One run in words a person can read. */
function runPhrase(run: ReviewRunRecord): string {
  const who = run.role === "fallback" ? `fallback ${run.model}` : run.model;
  switch (run.outcome) {
    case "report":
      return `${who} reviewed`;
    case "unavailable":
      return `${who} was unavailable${run.message === undefined || run.message === null ? "" : ` (${run.message})`}`;
    case "timed_out":
      return `${who} timed out${run.message === undefined || run.message === null || run.message.length === 0 ? "" : ` (${run.message})`}`;
    case "invalid":
      return `${who} wrote an invalid report`;
    case "no_report":
      return `${who} could not write the report${run.message === undefined || run.message === null || run.message.length === 0 ? "" : ` (last message: ${run.message})`}`;
    case "failed":
      return `${who} failed${run.message === undefined || run.message === null ? "" : ` (${run.message})`}`;
  }
}

/** Why a round ended the way it did, as the history line shows it. */
function reviewMessage(
  decision: "passed" | "findings" | "unavailable" | "timed_out",
  runs: readonly ReviewRunRecord[],
  retryAt?: number,
): string {
  if (decision === "timed_out") {
    // The reviewer's last words show when the file was never written.
    const note = runs[runs.length - 1]?.message ?? "";
    return note.length === 0
      ? "review timed out twice"
      : `review timed out twice (${note})`;
  }
  const parts = runs.map(runPhrase);
  if (decision === "unavailable" && retryAt !== undefined) {
    parts.push(`it runs again at ${new Date(retryAt).toISOString()}`);
  }
  return parts.join("; ");
}

/** Test-only hooks: a child process crashes at a named point in a review. */
export const reviewTestHooks: {
  now?: (() => number) | undefined;
  /** Waits instead of the real timer, so a test can move the clock. */
  wait?:
    | ((ms: number, signal: AbortSignal | undefined) => Promise<boolean>)
    | undefined;
  beforeRun?:
    | ((run: { readonly role: ReviewRunRole; readonly reason: ReviewRunReason }) => void)
    | undefined;
  /** Runs after the reviewer answered and before its run is written. */
  afterCall?:
    | ((run: { readonly role: ReviewRunRole; readonly reason: ReviewRunReason }) => void)
    | undefined;
  afterRunSaved?: ((run: ReviewRunRecord) => void) | undefined;
  /** Runs after the reviewer wrote a valid report, before the store copy. */
  beforeCopy?: (() => void) | undefined;
  /** Runs while a workspace report is open, before the folders are checked again. */
  afterOpen?: (() => void) | undefined;
  /** Runs between the folder looks that follow a workspace report read. */
  betweenChecks?: ((step: "before-stat" | "after-stat") => void) | undefined;
} = {};

/** Step `dev/review`: have the reviewer read the verified commit's diff. */
export async function runReview(
  ctx: StepContext,
): Promise<PluginStepResult> {
  const { context, grading } = gradedContext(await taskContext(ctx));
  if (!claimAllows(ctx, context.task)) return cancelledStep();
  const task = context.task;
  const attempt = attemptOf(ctx, task);
  const reviews =
    typeof attempt.reviews === "number" ? attempt.reviews : 0;
  const round = reviews + 1;
  const now = reviewTestHooks.now?.() ?? Date.now();
  const previous = attempt.review;

  // A record without a decision came from before review rounds existed; a
  // record with one is read back when the same round already ended.
  if (
    previous !== undefined &&
    previous !== null &&
    previous.decision === undefined &&
    previous.run === ctx.runId
  ) {
    return replayReview(previous, attempt);
  }
  if (previous !== undefined && previous !== null) {
    const finished =
      previous.decision === "passed" ||
      previous.decision === "findings" ||
      previous.decision === "timed_out" ||
      previous.reason === "exhausted" ||
      previous.reason === "out_of_time";
    if (finished && (previous.round === round || previous.run === ctx.runId)) {
      return replayReview(previous, attempt);
    }
    if (previous.round === round && previous.decision === "unavailable") {
      const retryAt =
        typeof previous.retryAt === "number" ? previous.retryAt : 0;
      // Wait until the recorded time; a recovered step asks no model again.
      if (now < retryAt) return replayReview(previous, attempt);
    }
  }

  const sha = attempt.verified;
  let current: TaskAttempt = attempt;
  const finish = async (
    record: ReviewRecord,
    stepResult: string,
    extra: Readonly<Record<string, unknown>> = {},
  ): Promise<PluginStepResult> => {
    const written = await saveTaskGuarded(
      ctx,
      context.taskKey,
      {
        ...task,
        // A findings review continues to the rework step; every other ending
        // is a wait, either for a person or for the next review time.
        phase:
          record.decision === "findings" || record.result === "fail"
            ? "review"
            : "waiting",
        run: ctx.runId,
        attempts: Math.max(task.attempts, attempt.number),
        attempt: {
          ...current,
          run: ctx.runId,
          review: record,
          // An unavailable round is not finished: the same round runs again.
          reviews:
            record.decision === "unavailable" &&
            record.reason !== "exhausted" &&
            record.reason !== "out_of_time"
              ? round - 1
              : round,
        },
        ...(record.decision === "passed" ? { reworkStreak: 0 } : {}),
        retryAt:
          record.decision === "unavailable" && typeof record.retryAt === "number"
            ? record.retryAt
            : null,
      },
      "dev:review",
    );
    if (!written) return cancelledStep();
    return {
      result: stepResult,
      data: reviewData(stepResult, typeof sha === "string" ? sha : "", {
        attempt: attempt.number,
        round,
        ...(record.decision === undefined || record.decision === null
          ? {}
          : { decision: record.decision }),
        ...(record.model === undefined || record.model === null
          ? {}
          : { model: record.model }),
        ...(record.retryAt === undefined || record.retryAt === null
          ? {}
          : { retryAt: record.retryAt }),
        ...(record.runs === undefined ? {} : { runs: record.runs }),
        ...(record.findings === undefined ? {} : { findings: record.findings }),
        ...(record.verified === undefined ? {} : { verified: record.verified }),
        ...(record.message === undefined || record.message === null
          ? {}
          : { message: record.message }),
        ...extra,
      }),
    };
  };

  if (typeof sha !== "string" || sha.length === 0) {
    const record: ReviewRecord = {
      result: "failed",
      run: ctx.runId,
      round,
      reason: "no_verified_commit",
      message: "the verify step recorded no commit to review",
    };
    return finish(record, "failed", {
      reason: "no_verified_commit",
      message: record.message,
    });
  }

  git(context.repository.path, [
    "fetch",
    "--prune",
    context.settings.remote,
  ]);
  const base = mergeBase(context.repository.path, context.settings, sha);
  if (base === undefined) {
    const record: ReviewRecord = {
      result: "failed",
      run: ctx.runId,
      sha,
      round,
      reason: "no_merge_base",
      message: `cannot find the merge base of ${context.settings.remote}/${context.settings.mainBranch} and ${sha}`,
    };
    return finish(record, "failed", {
      reason: "no_merge_base",
      message: record.message,
    });
  }

  const path = gateWorktreePath(
    context.repository.path,
    context.settings,
    context.taskId,
  );
  // A crash after the reviewer wrote its report and before the store copy
  // left the report in the old gate worktree, which is about to be replaced:
  // copy it first, so the resumed round reads it instead of asking again.
  const pendingReport = attempt.reviewPending;
  if (
    pendingReport !== undefined &&
    pendingReport !== null &&
    pendingReport.round === round &&
    typeof pendingReport.report === "string" &&
    pendingReport.report.startsWith(path) &&
    prepareReportFolder(path, false) === undefined
  ) {
    const old = readValidReportText(pendingReport.report, path);
    if (old !== undefined) {
      const savedDir = join(ctx.store.root, "dev", "reviews", ctx.runId);
      mkdirSync(savedDir, { recursive: true });
      const failure = copyToStore(
        join(
          savedDir,
          `${context.taskId}-attempt-${attempt.number}-review-${round}.json`,
        ),
        old.text,
      );
      if (failure !== undefined) {
        return finish(
          {
            result: "failed",
            run: ctx.runId,
            sha,
            round,
            reason: "review_failed",
            message: failure,
          },
          "failed",
          { reason: "review_failed", message: failure },
        );
      }
    }
  }
  const preparedWorktree = recreateGateWorktree(
    context.repository.path,
    path,
    sha,
  );
  if (preparedWorktree !== undefined) {
    const record: ReviewRecord = {
      result: "failed",
      run: ctx.runId,
      sha,
      round,
      reason: "worktree",
      message: preparedWorktree,
    };
    return finish(record, "failed", {
      reason: "worktree",
      message: preparedWorktree,
    });
  }

  // The gate worktree is at the verified commit, so its `.gitattributes` are
  // the ones that decide which changed files belong in the review diff.
  const prepared = prepareDiff(
    context.repository.path,
    base,
    sha,
    context.settings.reviewer,
    path,
  );

  if (prepared.bytes > context.settings.reviewer.maxDiffBytes) {
    const largest = [...prepared.files]
      .sort((left, right) => right.bytes - left.bytes)
      .slice(0, 5)
      .map((file) => ({
        path: file.path,
        bytes: file.bytes,
        added: file.added,
        removed: file.removed,
      }));
    const message = `the diff is ${prepared.bytes} bytes, over the ${context.settings.reviewer.maxDiffBytes}-byte review limit`;
    await ctx.facts.append({
      type: "dev/review_too_large",
      ...(ctx.object === undefined
        ? {}
        : { object: { type: ctx.object.type, id: ctx.object.id } }),
      cause: "dev:review",
      data: {
        bytes: prepared.bytes,
        limit: context.settings.reviewer.maxDiffBytes,
        largest,
      },
    });
    const record: ReviewRecord = {
      result: "failed",
      run: ctx.runId,
      sha,
      round,
      reason: "diff_size",
      message,
    };
    return finish(record, "failed", {
      reason: "diff_size",
      message,
      bytes: prepared.bytes,
      limit: context.settings.reviewer.maxDiffBytes,
      largest,
    });
  }

  // Nothing changed between the base and the verified commit: there is no
  // review to ask a model for. A change made only of left-out files still runs
  // the reviewer: the list is what tells it those files exist.
  if (prepared.files.length === 0) {
    const record: ReviewRecord = {
      result: "passed",
      decision: "passed",
      run: ctx.runId,
      sha,
      round,
      runs: [],
      findings: [],
      verified: [],
      reason: "empty",
    };
    return finish(record, "pass", {
      reason: "empty",
      leftOut: prepared.leftOut.map(leftOutLine),
    });
  }

  const reviewDir = join(ctx.store.root, "dev", "reviews", ctx.runId);
  mkdirSync(reviewDir, { recursive: true });
  const resultPath = join(
    reviewDir,
    `${context.taskId}-attempt-${attempt.number}-review-${round}.json`,
  );
  const promptPath = join(
    reviewDir,
    `${context.taskId}-attempt-${attempt.number}-review-${round}.prompt.md`,
  );

  const settings = context.settings.reviewer;
  // The retry is the same review round, so it keeps the round's arguments:
  // the first review of an attempt still gets `firstArgs` on its retry.
  const useFirst = reviews === 0 && settings.firstArgs !== undefined;
  const roundArgs = useFirst ? settings.firstArgs ?? [] : settings.args;
  const changed = new Set(prepared.files.map((file) => file.path));
  // The runs of this round survive a crash; a fresh round starts with none.
  const runs: ReviewRunRecord[] = (attempt.reviewRuns ?? []).filter(
    (run) =>
      run.round === round &&
      (run.attempt === undefined ||
        run.attempt === null ||
        run.attempt === attempt.number),
  );
  // The recorded unavailable round holds the runs it had when it waited. Once
  // the time has passed, a primary run starts the round again; a run saved
  // after that point is resumed instead of started twice.
  const recordedRuns = (previous?.runs ?? []).filter(
    (run) =>
      run.round === round &&
      (run.attempt === undefined ||
        run.attempt === null ||
        run.attempt === attempt.number),
  );
  const retryAfterWait =
    previous !== undefined &&
    previous !== null &&
    previous.round === round &&
    previous.decision === "unavailable" &&
    now >= (typeof previous.retryAt === "number" ? previous.retryAt : 0) &&
    runs.length <= recordedRuns.length;
  let next: ReviewNext = retryAfterWait
    ? { role: "primary", reason: "retry" }
    : nextReviewAction(runs, settings.fallback);

  // A run that crashed after its model answered left this pending record and
  // its outcome beside the report path. Resuming reads that outcome instead of
  // asking the same model a second time.
  let pendingReview: PendingReviewRun | undefined =
    attempt.reviewPending !== undefined &&
    attempt.reviewPending !== null &&
    attempt.reviewPending.round === round &&
    (attempt.reviewPending.attempt === undefined ||
      attempt.reviewPending.attempt === null ||
      attempt.reviewPending.attempt === attempt.number)
      ? attempt.reviewPending
      : undefined;

  // Every run of this step must end before the step's own timeout: a run that
  // cannot fit in what is left is skipped and the round waits for a person.
  const clock = (): number => reviewTestHooks.now?.() ?? Date.now();
  const deadline = clock() + (STEP_TIMEOUT_SECS - 60) * 1000;
  let ranHere = 0;

  while (typeof next === "object") {
    const action = next;
    const resume =
      pendingReview !== undefined &&
      pendingReview.role === action.role &&
      pendingReview.reason === action.reason
        ? pendingReview
        : undefined;
    pendingReview = undefined;
    const use =
      resume?.use ??
      (action.role === "fallback"
        ? settings.fallback?.use ?? settings.use
        : settings.use);
    const args =
      resume?.args ??
      (action.role === "fallback" ? settings.fallback?.args ?? [] : roundArgs);
    const model = resume?.model ?? modelOf(use, args);
    // One path per call: the calls before it in this round are the try number,
    // so a stale report of an earlier call is never read and never removed.
    const reportPath = workspaceReportPath(
      path,
      ctx.runId,
      attempt.number,
      round,
      runs.length,
    );
    const prompt = reviewPrompt(
      task,
      sha,
      base,
      prepared,
      reportPath,
      grading,
    );
    let call =
      resume === undefined ? undefined : readReviewOutcome(resultPath);
    if (
      call === undefined &&
      ranHere > 0 &&
      clock() + settings.timeoutSecs * 1000 > deadline
    ) {
      next = "out-of-time";
      break;
    }
    if (call === undefined) {
      ranHere += 1;
      // Keep the prompt for a person to read without putting its bytes in a fact.
      try {
        writeFileSync(promptPath, prompt);
      } catch {
        // A prompt file is a convenience; the reviewer still gets the text.
      }
      // Record the run before the model is asked: a crash after it answers
      // finds the run and its outcome on disk instead of repeating the call.
      current = {
        ...current,
        run: ctx.runId,
        reviewPending: {
          attempt: attempt.number,
          round,
          role: action.role,
          use,
          args,
          model,
          reason: action.reason,
          run: ctx.runId,
          report: reportPath,
        },
      };
      const pendingWritten = await saveTaskGuarded(
        ctx,
        context.taskKey,
        {
          ...task,
          run: ctx.runId,
          attempts: Math.max(task.attempts, attempt.number),
          attempt: current,
        },
        "dev:review",
      );
      if (!pendingWritten) return cancelledStep();
      reviewTestHooks.beforeRun?.({ role: action.role, reason: action.reason });
      call = await callReviewer(
        ctx,
        context,
        path,
        prompt,
        reportPath,
        resultPath,
        { use, args },
        resume !== undefined,
      );
    }
    reviewTestHooks.afterCall?.({ role: action.role, reason: action.reason });
    let runRecord: ReviewRunRecord;
    if (call.outcome === "report" && call.report !== undefined) {
      const findings: ReviewFinding[] = call.report.findings.map((finding) => {
        const preExisting = !changed.has(normalizePath(finding.file));
        return {
          ...finding,
          ...(preExisting ? { preExisting: true, pre_existing: true } : {}),
        };
      });
      const counted = findings.filter(
        (finding) =>
          finding.preExisting !== true &&
          finding.pre_existing !== true &&
          atOrAbove(finding.severity, settings.fixLevel),
      ).length;
      runRecord = {
        attempt: attempt.number,
        round,
        role: action.role,
        use,
        args,
        model,
        reason: action.reason,
        outcome: "report",
        run: ctx.runId,
        findings,
        verified: call.report.verified,
        counted,
      };
    } else {
      runRecord = {
        attempt: attempt.number,
        round,
        role: action.role,
        use,
        args,
        model,
        reason: action.reason,
        outcome: call.outcome,
        run: ctx.runId,
        ...(call.message.length === 0 ? {} : { message: call.message }),
      };
    }
    runs.push(runRecord);
    current = {
      ...current,
      run: ctx.runId,
      reviewPending: null,
      reviewRuns: [...(current.reviewRuns ?? []), runRecord],
    };
    const written = await saveTaskGuarded(
      ctx,
      context.taskKey,
      {
        ...task,
        run: ctx.runId,
        attempts: Math.max(task.attempts, attempt.number),
        attempt: current,
      },
      "dev:review",
    );
    if (!written) return cancelledStep();
    reviewTestHooks.afterRunSaved?.(runRecord);
    next = nextReviewAction(runs, settings.fallback);
  }

  const last = runs[runs.length - 1];
  if (next === "done" && last !== undefined) {
    const counted = last.counted ?? 0;
    const decision = counted === 0 ? "passed" : "findings";
    const stepResult = decision === "passed" ? "pass" : "fail";
    const result: ReviewResult = decision;
    const findings = last.findings ?? [];
    const countedFindings = findings.filter(
      (finding) =>
        finding.preExisting !== true &&
        finding.pre_existing !== true &&
        atOrAbove(finding.severity, settings.fixLevel),
    );
    const preExistingCount = findings.filter(
      (finding) =>
        finding.preExisting === true || finding.pre_existing === true,
    ).length;
    const findingsMessage = countedFindings
      .map(
        (finding) =>
          `${finding.file}:${finding.line} ${finding.severity}: ${finding.summary}`,
      )
      .join("; ");
    const message = [reviewMessage(decision, runs), findingsMessage]
      .filter((piece) => piece.length > 0)
      .join("; ");
    const record: ReviewRecord = {
      result,
      decision,
      run: ctx.runId,
      sha,
      round,
      model: last.model,
      runs,
      findings,
      verified: last.verified ?? [],
      log: resultPath,
      message,
      ...(decision === "findings" ? { reason: "findings" } : {}),
    };
    return finish(record, stepResult, {
      counted,
      preExisting: preExistingCount,
      pre_existing: preExistingCount,
      leftOut: prepared.leftOut.map(leftOutLine),
      log: resultPath,
      prompt: promptPath,
    });
  }

  if (
    next === "wait-unavailable" &&
    runs.filter((run) => run.role === "primary" && run.outcome === "unavailable")
      .length > MAX_REVIEW_WAITS
  ) {
    next = "wait-exhausted";
  }

  if (next === "wait-exhausted" || next === "out-of-time") {
    const exhausted = next === "wait-exhausted";
    const reason = exhausted ? "exhausted" : "out_of_time";
    const why = exhausted
      ? "review did not finish (model unavailable)"
      : "review did not finish (out of time)";
    const message = [reviewMessage("passed", runs), why]
      .filter((piece) => piece.length > 0)
      .join("; ");
    const timedOut = !exhausted && last?.outcome === "timed_out";
    const record: ReviewRecord = {
      result: timedOut ? "timed_out" : "unavailable",
      decision: timedOut ? "timed_out" : "unavailable",
      run: ctx.runId,
      sha,
      round,
      ...(last === undefined ? {} : { model: last.model }),
      runs,
      message,
      reason,
      log: resultPath,
    };
    return finish(record, reason, {
      reason,
      message,
      log: resultPath,
      prompt: promptPath,
    });
  }

  if (next === "wait-unavailable") {
    const retryAt =
      (reviewTestHooks.now?.() ?? Date.now()) + settings.retrySecs * 1000;
    const message = reviewMessage("unavailable", runs, retryAt);
    const record: ReviewRecord = {
      result: "unavailable",
      decision: "unavailable",
      run: ctx.runId,
      sha,
      round,
      ...(last === undefined ? {} : { model: last.model }),
      runs,
      retryAt,
      message,
      reason: "unavailable",
      log: resultPath,
    };
    return finish(record, "unavailable", {
      reason: "unavailable",
      message,
      retryAt,
      log: resultPath,
      prompt: promptPath,
    });
  }

  if (next === "wait-timed-out") {
    const message = reviewMessage("timed_out", runs);
    const record: ReviewRecord = {
      result: "timed_out",
      decision: "timed_out",
      run: ctx.runId,
      sha,
      round,
      ...(last === undefined ? {} : { model: last.model }),
      runs,
      message,
      reason: "timed_out",
      log: resultPath,
    };
    return finish(record, "timed_out", {
      reason: "timed_out",
      message,
      log: resultPath,
      prompt: promptPath,
    });
  }

  const message =
    last?.message === undefined || last.message === null
      ? reviewMessage("passed", runs)
      : [reviewMessage("passed", runs), last.message]
          .filter((piece) => piece.length > 0)
          .join("; ");
  const record: ReviewRecord = {
    result: "failed",
    run: ctx.runId,
    sha,
    round,
    ...(last === undefined ? {} : { model: last.model }),
    runs,
    message,
    reason: last?.outcome === "invalid" ? "invalid_json" : "review_failed",
    log: resultPath,
  };
  return finish(record, "failed", {
    reason: record.reason,
    message,
    log: resultPath,
    prompt: promptPath,
  });
}

/** Waits for a timer, or returns false when the run is cancelled. */
function waitFor(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve(false);
      return;
    }
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(true);
    }, ms);
    const onAbort = (): void => {
      cleanup();
      resolve(false);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Step `dev/review_due`: the wait a review enters when its model was
 * unavailable. It holds until the recorded `retryAt`, then lets the flow run
 * the same review round again without polling. A wait longer than one step run
 * is split into pieces below the step timeout.
 */
export async function runReviewDue(
  ctx: StepContext,
): Promise<PluginStepResult> {
  const context = await taskContext(ctx);
  if (!claimAllows(ctx, context.task)) {
    return { result: "interrupted", data: { reason: "cancelled" } };
  }
  const review = context.task.attempt?.review;
  const retryAt =
    typeof context.task.retryAt === "number"
      ? context.task.retryAt
      : review !== undefined &&
          review !== null &&
          review.decision === "unavailable" &&
          typeof review.retryAt === "number"
        ? review.retryAt
        : undefined;
  return holdUntil(ctx, retryAt);
}

/**
 * Step `dev/work_due`: the work step found its model unavailable. It holds
 * until the recorded `workRetryAt`, then lets the flow run the work again.
 */
export async function runWorkDue(ctx: StepContext): Promise<PluginStepResult> {
  const context = await taskContext(ctx);
  if (!claimAllows(ctx, context.task)) {
    return { result: "interrupted", data: { reason: "cancelled" } };
  }
  const retryAt = context.task.attempt?.workRetryAt;
  return holdUntil(ctx, typeof retryAt === "number" ? retryAt : undefined);
}

/** Waits (in pieces below the step timeout) until `retryAt`, or until cancelled. */
async function holdUntil(
  ctx: StepContext,
  retryAt: number | undefined,
): Promise<PluginStepResult> {
  const now = reviewTestHooks.now?.() ?? Date.now();
  if (retryAt === undefined || retryAt <= now) {
    return { result: "ready", data: { at: now } };
  }
  const waitMs = Math.min(retryAt - now, REVIEW_WAIT_CHUNK_MS);
  const wait = reviewTestHooks.wait ?? waitFor;
  const waited = await wait(waitMs, ctx.signal);
  if (!waited) return { result: "interrupted", data: { reason: "cancelled" } };
  const after = reviewTestHooks.now?.() ?? Date.now();
  if (after < retryAt) {
    // The piece ended early: the review step replays its unavailable round and
    // the flow enters this wait again for the next piece.
    return { result: "ready", data: { at: after, retryAt, waitedMs: waitMs } };
  }
  return {
    result: "ready",
    data: { at: retryAt, waitedMs: retryAt - now },
  };
}

function gateSource(task: TaskData): "verify" | "review" {
  const review = task.attempt?.review;
  if (review !== undefined && review !== null) {
    if (review.decision === "findings") return "review";
    if (
      review.result === "fail" ||
      review.result === "findings" ||
      review.result === "failed"
    ) {
      return "review";
    }
  }
  return "verify";
}

function findingText(finding: ReviewFinding): string {
  const place = `${finding.file}:${finding.line}`;
  const trigger =
    finding.trigger.length === 0 ? "" : ` — ${finding.trigger}`;
  return `- \`${place}\` ${finding.severity}: ${finding.summary}${trigger}`;
}

/** The instruction every rework section ends with. */
export const REWORK_INSTRUCTION =
  "Fix them and nothing else, append commits to the branch, and do not rebase.";

/** Step `dev/rework`: add the gate failure to the brief and decide who fixes it. */
export async function runRework(
  ctx: StepContext,
): Promise<PluginStepResult> {
  const context = await taskContext(ctx);
  if (!claimAllows(ctx, context.task)) return cancelledStep();
  const task = context.task;
  const attempt = attemptOf(ctx, task);
  // A rework that saved its task but lost its step result is replayed by the
  // runner; the section and the streak are already recorded, so reuse them.
  const previous = attempt.rework;
  if (
    previous !== undefined &&
    previous !== null &&
    previous.run === ctx.runId
  ) {
    return {
      result: previous.result,
      data: {
        attempt: attempt.number,
        source: previous.source,
        rework: previous.streak,
        streak: previous.streak,
        maxAutoRework: context.settings.maxAutoRework,
        brief: task.brief,
        replayed: true,
      },
    };
  }
  const source = gateSource(task);
  const pieces: string[] = [];
  let reason: string | undefined;

  if (source === "review") {
    const review = attempt?.review;
    const level = gradedContext(context).context.settings.reviewer.fixLevel;
    const findings = (review?.findings ?? []).filter(
      (finding) =>
        finding.preExisting !== true &&
        finding.pre_existing !== true &&
        atOrAbove(finding.severity, level),
    );
    const first = findings[0];
    if (first !== undefined) {
      reason = findingText(first).replace(/^- /, "").replaceAll("`", "");
      pieces.push(
        "The review failed with these findings:",
        findings.map(findingText).join("\n"),
      );
    } else {
      reason = `the review failed: ${review?.message ?? "no review report was produced"}`;
      pieces.push(
        `The review failed: ${review?.message ?? "no review report was produced"}`,
      );
    }
  } else {
    const verify = attempt?.verify;
    if (
      typeof verify?.command === "string" &&
      verify.command.length > 0
    ) {
      reason = `the verify command failed: ${verify.command}`;
      pieces.push(
        `The verify command failed: \`${verify.command}\``,
        ...(typeof verify.log === "string" && verify.log.length > 0
          ? [`Log: \`${verify.log}\``]
          : []),
      );
    } else {
      reason = `the gate failed: ${verify?.message ?? "verify recorded no reason"}`;
      pieces.push(
        `The gate failed: ${verify?.message ?? "verify recorded no reason"}`,
      );
    }
  }
  pieces.push(REWORK_INSTRUCTION);

  const withRework = appendRework(
    task,
    source,
    pieces.join("\n\n"),
    reason,
  );
  const streak = (task.reworkStreak ?? 0) + 1;
  const again = streak <= context.settings.maxAutoRework;
  const record: ReworkRecord = {
    run: ctx.runId,
    source,
    streak,
    limit: context.settings.maxAutoRework,
    result: again ? "again" : "ask",
  };
  const next: TaskData = {
    ...withRework,
    phase: again ? "review" : "waiting",
    run: ctx.runId,
    attempts: Math.max(task.attempts, attempt.number),
    reworkStreak: streak,
    attempt: { ...attempt, run: ctx.runId, rework: record },
  };
  if (!(await saveTaskGuarded(ctx, context.taskKey, next, "dev:rework"))) {
    return cancelledStep();
  }
  return {
    result: again ? "again" : "ask",
    data: {
      attempt: attempt.number,
      source,
      rework: streak,
      streak,
      maxAutoRework: context.settings.maxAutoRework,
      brief: next.brief,
    },
  };
}

/** The recorded verified commit of a task, for a caller that wants to look. */
export function verifiedCommitOf(task: TaskData): string | undefined {
  const sha = task.attempt?.verified;
  return typeof sha === "string" && sha.length > 0 ? sha : undefined;
}

/** The branch head a task's worktree is on, for tests and views. */
export function taskHead(path: string): string | undefined {
  return headOf(path);
}

/** The worktree path the gate uses, for tests and views. */
export function taskGatePath(context: TaskContext): string {
  return gateWorktreePath(
    context.repository.path,
    context.settings,
    context.taskId,
  );
}
